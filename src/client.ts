import { isCrossOrigin, joinUrl, normalizeBaseUrl, platformBaseUrlFrom } from "./base-url.js";
import { DEFAULT_CLIENT_ID, isApiKeyShape } from "./constants.js";
import {
  CrossHostRedirectError,
  LobstackConfigError,
  LobstackError,
  QuotaExhaustedError,
  type GatewayErrorClass,
} from "./errors.js";
import {
  mergeStreamReceipt,
  parseQuota,
  receiptFromHeaders,
  type Receipt,
} from "./receipt.js";
import { collectStream, streamEvents } from "./stream.js";
import type {
  ChatCompletion,
  ChatRequest,
  GatewayErrorBody,
  GatewayModel,
  ModelList,
  RoutePreview,
  RoutePreviewRequest,
  StreamEvent,
  ToolCall,
  Usage,
  UsageGroupBy,
  UsageRange,
  UsageReport,
} from "./types.js";

/** Anything fetch-shaped. Supplied so tests and proxies can substitute one. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Something worth saying out loud that is not worth throwing over. */
export interface Warning {
  code: "base_url_corrected" | "credential_shape" | "no_receipt";
  message: string;
}

export interface LobstackGatewayOptions {
  /** An API key (`lsk_live_…`). Defaults to `process.env.LOBSTACK_API_KEY`. */
  apiKey?: string | null;
  /**
   * The Gateway base URL. Defaults to `process.env.LOBSTACK_BASE_URL`, then to
   * `https://www.lobstack.ai/api/gateway/v1` — with the `www`. The apex 307s
   * and a redirect across hosts strips `Authorization`.
   */
  baseUrl?: string;
  /**
   * Where the platform API lives, for `usage()`. Derived from `baseUrl` unless
   * you set it: the usage endpoint is NOT under the Gateway base.
   */
  platformBaseUrl?: string;
  fetch?: FetchLike;
  /** Sent as `x-lobstack-client` and recorded on the trace row. */
  client?: string;
  defaultHeaders?: Record<string, string>;
  /** Abort a request after this many milliseconds. Off by default. */
  timeoutMs?: number | null;
  /** Called for anything corrected or missing. Defaults to `console.warn`. */
  onWarning?: (warning: Warning) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number | null;
}

export interface ChatResult {
  completion: ChatCompletion;
  /** Everything the response said about routing, cost and allowance. */
  receipt: Receipt;
  /** The raw response, headers intact, for anything this SDK did not model. */
  response: Response;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  /**
   * The receipt, merged from the response headers (routing, quota) and the
   * final SSE frame (the money). `pricedFrom === "none"` means no frame
   * arrived: costUsd is null because nothing was reported, not because the call
   * was free.
   */
  receipt: Receipt;
  model: string | null;
  response: Response;
}

export interface StreamOptions extends RequestOptions {
  onText?: (delta: string) => void;
  onEvent?: (event: StreamEvent) => void;
}

export interface UsageQuery {
  range?: UsageRange;
  groupBy?: UsageGroupBy;
  agentId?: string;
  keyId?: string;
}

/**
 * A typed client for the Lobstack Gateway.
 *
 * Three things it does that a plain `fetch` will not:
 *
 *   1. It refuses to follow a redirect. A cross-host redirect strips
 *      `Authorization` (RFC 9110 §15.4) and the Gateway then answers a good key
 *      with "missing credentials" — an error that names the wrong thing.
 *   2. It reads the receipt off the final SSE frame, which arrives AFTER the
 *      chunk carrying `finish_reason`.
 *   3. It keeps every money field nullable, so an unpriced call cannot be
 *      rendered as `$0.00` by accident.
 */
export class LobstackGateway {
  readonly baseUrl: string;
  readonly platformBaseUrl: string;
  readonly clientId: string;

  readonly #apiKey: string | null;
  readonly #fetch: FetchLike;
  readonly #defaultHeaders: Record<string, string>;
  readonly #timeoutMs: number | null;
  readonly #onWarning: (warning: Warning) => void;

  constructor(options: LobstackGatewayOptions = {}) {
    const env = typeof process !== "undefined" ? (process.env ?? {}) : {};

    this.#apiKey = options.apiKey ?? env["LOBSTACK_API_KEY"] ?? null;
    this.#onWarning =
      options.onWarning ??
      ((warning) => {
        // Silence would be worse: both warnings describe something the caller's
        // own code will get wrong somewhere else.
        console.warn(`[lobstack] ${warning.message}`);
      });

    const normalized = normalizeBaseUrl(options.baseUrl ?? env["LOBSTACK_BASE_URL"] ?? null);
    this.baseUrl = normalized.baseUrl;
    if (normalized.corrected && normalized.note) {
      this.#onWarning({ code: "base_url_corrected", message: normalized.note });
    }

    this.platformBaseUrl = options.platformBaseUrl ?? platformBaseUrlFrom(this.baseUrl);
    this.clientId = options.client ?? DEFAULT_CLIENT_ID;
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.#timeoutMs = options.timeoutMs ?? null;

    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new LobstackConfigError(
        "no fetch implementation is available",
        "Use Node 20 or newer, or pass one as `fetch`.",
      );
    }
    this.#fetch = fetchImpl;

    if (this.#apiKey !== null && !isApiKeyShape(this.#apiKey)) {
      this.#onWarning({
        code: "credential_shape",
        message:
          "the credential does not look like an API key (lsk_live_ or lsk_test_, then 56 hex characters). " +
          "A legacy agent gateway token is also accepted by the Gateway, so this is not necessarily wrong — " +
          "but a typo in a key produces a 401 that reads like a server problem.",
      });
    }
  }

  /* ── Chat ───────────────────────────────────────────────────────────────── */

  /** One buffered completion, and the receipt off its headers. */
  async chat(request: ChatRequest, options: RequestOptions = {}): Promise<ChatResult> {
    const response = await this.#request("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: false }),
      options,
      authenticated: true,
    });

    const completion = (await response.json()) as ChatCompletion;
    const receipt = receiptFromHeaders(response.headers);
    // The Gateway does not echo the requested model in a header; the caller's
    // own request is the only place it exists on this path.
    const requested = request.model ?? null;

    return {
      completion,
      receipt: { ...receipt, requestedModel: requested, servedModel: receipt.servedModel ?? completion.model ?? null },
      response,
    };
  }

  /**
   * One streamed completion, read to the end.
   *
   * It reads past `finish_reason` on purpose: the price is on the frame after
   * it. Stop early and you keep the answer and lose the receipt.
   */
  async streamChat(request: ChatRequest, options: StreamOptions = {}): Promise<StreamResult> {
    const response = await this.#request("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
      options,
      authenticated: true,
    });

    const body = response.body;
    if (!body) {
      throw new LobstackError("the Gateway returned no response body for a streamed request", {
        status: response.status,
        requestId: response.headers.get("x-lobstack-request-id"),
      });
    }

    const collectHandlers: { onText?: (d: string) => void; onEvent?: (e: StreamEvent) => void } = {};
    if (options.onText) collectHandlers.onText = options.onText;
    if (options.onEvent) collectHandlers.onEvent = options.onEvent;

    const collected = await collectStream(body, collectHandlers);

    const headerReceipt = receiptFromHeaders(response.headers);
    const receipt = mergeStreamReceipt(
      { ...headerReceipt, requestedModel: request.model ?? headerReceipt.requestedModel },
      collected.receiptFrame,
    );

    if (receipt.pricedFrom === "none") {
      this.#onWarning({
        code: "no_receipt",
        message:
          "this streamed response carried no x_lobstack frame, so there is no price to report. " +
          "That is an older Gateway or a base URL that is not a Lobstack Gateway — do not fall back to pricing the token counts yourself.",
      });
    }

    return {
      text: collected.text,
      toolCalls: collected.toolCalls,
      finishReason: collected.finishReason,
      usage: collected.usage,
      receipt,
      model: collected.model ?? receipt.servedModel,
      response,
    };
  }

  /**
   * The raw event stream, for callers that want to drive it themselves.
   *
   * The request is made on the first iteration. Iterate to `{ type: "done" }`
   * or you will not see the `{ type: "usage" }` event that carries the receipt.
   */
  async *stream(
    request: ChatRequest,
    options: RequestOptions = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const response = await this.#request("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
      options,
      authenticated: true,
    });

    const body = response.body;
    if (!body) {
      throw new LobstackError("the Gateway returned no response body for a streamed request", {
        status: response.status,
        requestId: response.headers.get("x-lobstack-request-id"),
      });
    }

    yield* streamEvents(body);
  }

  /* ── Catalogue and preview ──────────────────────────────────────────────── */

  /** Everything the Gateway serves, with tier, context window and list prices. */
  async models(options: RequestOptions = {}): Promise<GatewayModel[]> {
    const response = await this.#request("/models", {
      method: "GET",
      options,
      authenticated: true,
    });
    const list = (await response.json()) as ModelList;
    return list.data ?? [];
  }

  /**
   * What the router would do with a prompt, without spending a token.
   *
   * Public and unauthenticated: it runs no inference and reads no per-user
   * state, so this SDK sends no credential to it.
   */
  async routePreview(
    request: RoutePreviewRequest,
    options: RequestOptions = {},
  ): Promise<RoutePreview> {
    const response = await this.#request("/route-preview", {
      method: "POST",
      body: JSON.stringify(request),
      options,
      authenticated: false,
    });
    return (await response.json()) as RoutePreview;
  }

  /* ── Usage ──────────────────────────────────────────────────────────────── */

  /**
   * Org-scoped usage, traces and latency.
   *
   * Needs a key with the `usage:read` scope, and lives at `/api/v1/usage` —
   * NOT under the Gateway base URL.
   */
  async usage(query: UsageQuery = {}, options: RequestOptions = {}): Promise<UsageReport> {
    const params = new URLSearchParams();
    params.set("range", query.range ?? "7d");
    params.set("group_by", query.groupBy ?? "day");
    if (query.agentId) params.set("agent_id", query.agentId);
    if (query.keyId) params.set("key_id", query.keyId);

    const response = await this.#requestUrl(
      `${joinUrl(this.platformBaseUrl, "usage")}?${params.toString()}`,
      { method: "GET", options, authenticated: true },
    );
    return (await response.json()) as UsageReport;
  }

  /* ── Plumbing ───────────────────────────────────────────────────────────── */

  #request(
    path: string,
    init: {
      method: string;
      body?: string;
      options: RequestOptions;
      authenticated: boolean;
    },
  ): Promise<Response> {
    return this.#requestUrl(joinUrl(this.baseUrl, path), init);
  }

  async #requestUrl(
    url: string,
    init: {
      method: string;
      body?: string;
      options: RequestOptions;
      authenticated: boolean;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: init.method === "GET" ? "application/json" : "application/json, text/event-stream",
      "x-lobstack-client": this.clientId,
      ...this.#defaultHeaders,
      ...(init.options.headers ?? {}),
    };

    if (init.body !== undefined) headers["content-type"] = "application/json";

    if (init.authenticated) {
      if (!this.#apiKey) {
        throw new LobstackConfigError(
          "no API key: pass `apiKey`, or set LOBSTACK_API_KEY",
          "Mint one in the Console. Keys look like lsk_live_ followed by 56 hex characters and need the `inference` scope.",
        );
      }
      headers["authorization"] = `Bearer ${this.#apiKey}`;
    }

    const signal = this.#signal(init.options);

    const requestInit: RequestInit = {
      method: init.method,
      headers,
      // Never `follow`. See CrossHostRedirectError.
      redirect: "manual",
    };
    if (init.body !== undefined) requestInit.body = init.body;
    if (signal) requestInit.signal = signal;

    let response: Response;
    try {
      response = await this.#fetch(url, requestInit);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const aborted = /abort/i.test(message);
      throw new LobstackError(
        aborted ? `the request to ${url} was aborted` : `the request to ${url} failed: ${message}`,
        {
          status: aborted ? 504 : null,
          errorClass: aborted ? "timeout" : null,
          cause,
        },
      );
    }

    // `redirect: "manual"` surfaces a redirect as a normal response with an
    // opaque status in some runtimes, so both shapes are checked.
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      const location = response.headers.get("location");
      throw new CrossHostRedirectError({
        from: url,
        location,
        crossHost: location === null ? true : isCrossOrigin(url, location),
        status: response.status || 307,
        requestId: response.headers.get("x-lobstack-request-id"),
      });
    }

    if (!response.ok) throw await toGatewayError(response, url);

    return response;
  }

  #signal(options: RequestOptions): AbortSignal | undefined {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;

    if (timeout && options.signal) return AbortSignal.any([timeout, options.signal]);
    return timeout ?? options.signal;
  }
}

/** Turn a failed response into the most specific error this SDK has. */
async function toGatewayError(response: Response, url: string): Promise<LobstackError> {
  const requestId = response.headers.get("x-lobstack-request-id");
  const quota = parseQuota(response.headers);

  let message = `${response.status} from ${url}`;
  let errorClass: GatewayErrorClass | string | null = null;

  try {
    const body = (await response.json()) as Partial<GatewayErrorBody>;
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.type) errorClass = body.error.type;
  } catch {
    // Not JSON. A proxy or an unrelated host answered; the status is all we have.
  }

  const hint = hintFor(response.status, message);

  if (response.status === 402 && quota) {
    return new QuotaExhaustedError(message, {
      status: 402,
      errorClass: errorClass ?? "quota",
      requestId,
      quota,
      hint,
    });
  }

  return new LobstackError(message, {
    status: response.status,
    errorClass,
    requestId,
    quota,
    hint,
  });
}

function hintFor(status: number, message: string): string | null {
  if (status === 401 && /missing credentials/i.test(message)) {
    return (
      "The Gateway saw no Authorization header at all. The usual cause is the apex: " +
      "https://lobstack.ai 307s to https://www.lobstack.ai, and a client must drop the header " +
      "across a host change (RFC 9110). Call https://www.lobstack.ai/api/gateway/v1 directly."
    );
  }
  if (status === 401) {
    return "Check the key. An API key looks like lsk_live_ followed by 56 hex characters. Revoked and expired keys are reported distinctly in the message.";
  }
  if (status === 403 && /scope/i.test(message)) {
    return "Mint a key with the scope named above in Console → API keys. Scopes are not editable after minting.";
  }
  if (status === 402) {
    return "The allowance for the period is gone. Top up or upgrade; retry-after is computed from the period reset, so it is days rather than seconds.";
  }
  if (status === 429) return "Back off exponentially with jitter.";
  if (status === 503 && /not configured|no provider API key/i.test(message)) {
    return "This is a deployment configuration problem and will not clear on retry: a managed provider key is missing.";
  }
  if (status >= 500) {
    return "Retry with backoff. The Gateway accepts no idempotency key, so a request that timed out may already have completed and been metered.";
  }
  return null;
}
