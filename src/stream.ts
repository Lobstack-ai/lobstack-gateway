import { StreamError } from "./errors.js";
import { parseReceiptFrame } from "./receipt.js";
import type {
  ChatCompletionChunk,
  StreamCollected,
  StreamEvent,
  ToolCall,
  Usage,
} from "./types.js";

/**
 * Split an SSE byte stream into `data:` payloads.
 *
 * The buffer is carried across reads, and that is the load-bearing part. A
 * chunk boundary can land in the middle of a JSON object, and a `split("\n\n")`
 * per read drops it — which shows up as answers that end mid-sentence and that
 * nobody can reproduce. Providers differ on `\n\n` versus `\r\n\r\n`, so both
 * separate events here.
 */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload) yield payload;
        }
      }
    }

    // A server that closes without a trailing blank line still owes us its last
    // event, and on this API that last event is the receipt.
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    // Cancel rather than merely release: a consumer that stops early (a `break`
    // out of `for await`) would otherwise leave the body undrained and the
    // socket held open.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Turn an SSE body into typed events.
 *
 * THE RECEIPT ARRIVES AFTER `finish_reason`. The order is: role chunk, content
 * deltas, a chunk carrying `finish_reason`, then a chunk with an empty
 * `choices` array holding `usage` and `x_lobstack`, then `data: [DONE]`. A
 * reader that breaks on `finish_reason` — which is the obvious thing to write —
 * silently throws away the only place a streamed response reports what it cost.
 * This generator keeps reading until `[DONE]` or the end of the body.
 */
export async function* streamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, undefined> {
  for await (const payload of sseFrames(body)) {
    if (payload === "[DONE]") {
      yield { type: "done" };
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A frame we cannot parse is not worth ending a turn over.
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) continue;

    // A mid-stream failure cannot change the status code, which is already 200,
    // so the Gateway reports it inside the stream instead.
    const err = (parsed as { error?: { message?: string; code?: number; request_id?: string } })
      .error;
    if (err) {
      throw new StreamError(err.message ?? "the Gateway reported an error mid-stream", {
        status: typeof err.code === "number" ? err.code : null,
        errorClass: "provider",
        requestId: err.request_id ?? null,
        hint: "The response status was 200 and its headers are long gone; the trace row records the real status. Look the request id up through GET /api/v1/usage.",
      });
    }

    const chunk = parsed as ChatCompletionChunk;
    const choice = chunk.choices?.[0];

    if (choice) {
      const content = choice.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        yield { type: "text", delta: content, chunk };
      }

      for (const tc of choice.delta?.tool_calls ?? []) {
        yield {
          type: "tool_call",
          index: tc.index ?? 0,
          id: tc.id ?? null,
          name: tc.function?.name ?? null,
          argumentsDelta: tc.function?.arguments ?? null,
          chunk,
        };
      }

      if (choice.finish_reason) {
        // Not the end. The receipt is still in flight.
        yield { type: "finish", finishReason: choice.finish_reason, chunk };
      }
    }

    if (chunk.usage || chunk.x_lobstack) {
      yield {
        type: "usage",
        usage: chunk.usage ?? null,
        receipt: parseReceiptFrame(chunk),
        chunk,
      };
    }
  }

  yield { type: "done" };
}

export interface CollectHandlers {
  onText?: (delta: string) => void;
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Read a stream to the end and hand back the answer with its receipt.
 *
 * Tool-call deltas are assembled BY INDEX, not by arrival order: the `id` and
 * `function.name` appear on the first delta for an index and the arguments
 * accumulate across the rest.
 */
export async function collectStream(
  body: ReadableStream<Uint8Array>,
  handlers: CollectHandlers = {},
): Promise<StreamCollected> {
  let text = "";
  let usage: Usage | null = null;
  let receiptFrame: StreamCollected["receiptFrame"] = null;
  let finishReason: string | null = null;
  let model: string | null = null;
  const calls = new Map<number, ToolCall>();

  for await (const event of streamEvents(body)) {
    handlers.onEvent?.(event);

    switch (event.type) {
      case "text":
        text += event.delta;
        model = event.chunk.model ?? model;
        handlers.onText?.(event.delta);
        break;

      case "tool_call": {
        const existing = calls.get(event.index) ?? {
          id: event.id ?? `call_${event.index}`,
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (event.id) existing.id = event.id;
        if (event.name) existing.function.name = event.name;
        if (event.argumentsDelta) existing.function.arguments += event.argumentsDelta;
        calls.set(event.index, existing);
        break;
      }

      case "finish":
        finishReason = event.finishReason;
        model = event.chunk.model ?? model;
        // Deliberately no `break` out of the loop: the receipt comes next.
        break;

      case "usage":
        usage = event.usage;
        receiptFrame = event.receipt;
        model = event.chunk.model ?? model;
        break;

      case "done":
        break;
    }
  }

  return {
    text,
    toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
    finishReason,
    usage,
    receiptFrame,
    model,
  };
}
