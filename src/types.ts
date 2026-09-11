import type { BaselineReason, ModelTier, XLobstack } from "./receipt.js";

/* ── Request ──────────────────────────────────────────────────────────────── */

export type Role = "system" | "user" | "assistant" | "tool";

/** An OpenAI content part. Passed through to the provider untouched. */
export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  /** A string, or an OpenAI content-part array. */
  content: string | ContentPart[] | null;
  /** On an assistant turn that called tools. */
  tool_calls?: ToolCall[];
  /** On a tool result, echoing the id you were given. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * The request body.
 *
 * The Gateway reads exactly these fields. `top_p`, `tool_choice`, `n`, `stop`,
 * `response_format`, `seed`, `logprobs` and `stream_options` are accepted by
 * the HTTP endpoint and dropped silently — nothing errors, the parameter simply
 * has no effect. They are absent from this type for that reason: a field you
 * cannot influence does not belong on a request object.
 */
export interface ChatRequest {
  messages: Message[];
  /**
   * A Lobstack model key, or `"auto"`. Omit and the Gateway uses the calling
   * credential's configured model, falling back to `auto`.
   *
   * A named model is a ceiling, not a command: a simple request sent to a
   * flagship model still routes down, and `x-lobstack-model` on the response
   * says what actually served it.
   */
  model?: string;
  max_tokens?: number;
  /**
   * Forwarded only when you set it, and only to models that accept it. When the
   * Gateway drops it, `x-lobstack-dropped-params` says so — except on OpenAI's
   * GPT-5 and o-series, where it is dropped silently.
   */
  temperature?: number;
  tools?: ToolDefinition[];
  /** Free-form grouping key, recorded on the ledger row. Not sent to the provider. */
  session_id?: string;
}

/* ── Response ─────────────────────────────────────────────────────────────── */

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Choice {
  index: number;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

export interface ChatCompletion {
  /** `chatcmpl-` followed by the request id, so the answer and its trace row share one. */
  id: string;
  object: "chat.completion";
  created: number;
  /** The Lobstack key that actually served the request. Read it; do not assume. */
  model: string;
  /** There is always exactly one choice. */
  choices: Choice[];
  usage: Usage;
}

export interface ChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: {
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason: string | null;
}

/**
 * One SSE chunk.
 *
 * The final chunk has an EMPTY `choices` array and carries `usage` plus
 * `x_lobstack`. It arrives AFTER the chunk with `finish_reason` — a reader that
 * stops on `finish_reason` throws away the receipt.
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: Usage;
  x_lobstack?: XLobstack;
}

/** The error body, identical on every failure. */
export interface GatewayErrorBody {
  error: {
    message: string;
    type: string;
    code: number;
    request_id?: string;
  };
}

/* ── Models ───────────────────────────────────────────────────────────────── */

export interface GatewayModel {
  /** The Lobstack model key — what you send as `model`. */
  id: string;
  object: "model";
  /** The provider that serves it. */
  owned_by: string;
  label: string;
  tier: ModelTier | string;
  context_window: number;
  /**
   * USD per million tokens, as provider list prices — for comparison, not the
   * figure on an invoice.
   *
   * Declared optional on each side although the current catalogue always sends
   * both: a client that has to reach for `?? 0` to compile is a client that will
   * render a missing price as free.
   */
  price_per_mtok: { input?: number; output?: number };
  /** Whether the model can run on Lobstack-held provider keys. */
  managed: boolean;
}

export interface ModelList {
  object: "list";
  data: GatewayModel[];
}

/* ── Route preview ────────────────────────────────────────────────────────── */

export interface RoutePreviewRequest {
  prompt: string;
  requested_model?: string;
  plan_tier?: string;
  conversation_length?: number;
  expected_output_tokens?: number;
}

export interface RoutePreview {
  object: "routing_preview";
  requested_model: string;
  plan_tier: string;
  complexity: number;
  tier: ModelTier | string;
  routed: boolean;
  reason: string;
  model: {
    key: string;
    label: string;
    provider: string | null;
    context_window: number | null;
    price_per_mtok: { input: number; output: number } | null;
    managed_key_configured: boolean;
  };
  token_estimate: {
    input: number;
    output: number;
    method: string;
    /** Always true. These are estimates, and the response says so. */
    estimated: boolean;
  };
  /** Null for a model the registry cannot price. Never zero. */
  cost_usd: number | null;
  /** Null unless you named a model and the router moved away from it. */
  baseline: {
    model: string;
    label: string;
    cost_usd: number;
    saving_usd: number;
  } | null;
  note: string;
}

/* ── Usage ────────────────────────────────────────────────────────────────── */

export type UsageRange = "7d" | "14d" | "30d" | "90d";
export type UsageGroupBy = "day" | "model" | "key" | "agent";

export interface UsageSummary {
  requests: number;
  errors: number;
  error_rate: number;
  errors_by_class: Record<string, number>;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * Summed cost. Rows the meter could not price sum as zero, which is the only
   * arithmetic available and not the only truth — read `unpriced_requests`
   * before quoting this as exact.
   */
  cost_usd: number;
  unpriced_requests?: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  p99_latency_ms: number | null;
  streamed: number;
}

export interface UsageGroup {
  key: string;
  requests: number;
  errors: number;
  total_tokens: number;
  cost_usd: number;
  unpriced_requests?: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
}

export interface UsageEnabled {
  enabled: true;
  org_id: string;
  authenticated_via: "session" | "api_key";
  range: UsageRange;
  group_by: UsageGroupBy | string;
  summary: UsageSummary;
  groups: UsageGroup[];
  /** True when the row cap bound: the sums are a floor, not a total. */
  truncated: boolean;
}

/** Request tracing is not enabled on that deployment yet. Not an outage. */
export interface UsageDisabled {
  enabled: false;
  reason: string;
  message: string;
  org_id: string;
  range: UsageRange;
  group_by: UsageGroupBy | string;
  summary: null;
  groups: [];
  truncated: false;
}

export type UsageReport = UsageEnabled | UsageDisabled;

/* ── Streaming ────────────────────────────────────────────────────────────── */

export type StreamEvent =
  | { type: "text"; delta: string; chunk: ChatCompletionChunk }
  | {
      type: "tool_call";
      index: number;
      id: string | null;
      name: string | null;
      argumentsDelta: string | null;
      chunk: ChatCompletionChunk;
    }
  /**
   * The model stopped generating. NOT the end of the stream: the receipt has
   * not arrived yet. Keep reading.
   */
  | { type: "finish"; finishReason: string; chunk: ChatCompletionChunk }
  /** The final data frame: token counts, and the money under `x_lobstack`. */
  | { type: "usage"; usage: Usage | null; receipt: XLobstack | null; chunk: ChatCompletionChunk }
  /** `data: [DONE]`, or the connection ending. */
  | { type: "done" };

export interface StreamCollected {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  /** `x_lobstack` off the final frame. Null when the response carried none. */
  receiptFrame: XLobstack | null;
  /** The served model, as the chunks reported it. */
  model: string | null;
}

export type { BaselineReason, XLobstack };
