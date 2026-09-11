import type { QuotaSnapshot } from "./receipt.js";

/**
 * The six error classes the Gateway returns. Each implies a different response,
 * which is the whole reason the taxonomy is small.
 */
export type GatewayErrorClass =
  | "auth"
  | "quota"
  | "validation"
  | "provider"
  | "timeout"
  | "internal";

export interface LobstackErrorInit {
  status?: number | null;
  errorClass?: GatewayErrorClass | string | null;
  requestId?: string | null;
  hint?: string | null;
  quota?: QuotaSnapshot | null;
  cause?: unknown;
}

/** Base class for everything this SDK throws. */
export class LobstackError extends Error {
  /** HTTP status, or null for a client-side failure that never left the process. */
  readonly status: number | null;
  /** The Gateway's `error.type`. Null when the failure was not the Gateway's. */
  readonly errorClass: GatewayErrorClass | string | null;
  /** `x-lobstack-request-id`. Quote it in a support thread and it becomes a lookup. */
  readonly requestId: string | null;
  /** What to do about it, when there is something specific to say. */
  readonly hint: string | null;
  /** The allowance state, when the response reported one. */
  readonly quota: QuotaSnapshot | null;

  constructor(message: string, init: LobstackErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status ?? null;
    this.errorClass = init.errorClass ?? null;
    this.requestId = init.requestId ?? null;
    this.hint = init.hint ?? null;
    this.quota = init.quota ?? null;
  }

  /**
   * Whether retrying this exact request could plausibly succeed.
   *
   * Note that the Gateway accepts no idempotency key: a timed-out request may
   * still have completed and been metered upstream, so an automatic retry can
   * produce a second answer and a second charge. Retryable means "the failure
   * is transient", not "retrying is free".
   */
  get retryable(): boolean {
    if (this.status === 429) return true;
    if (this.status === 408 || this.status === 504) return true;
    if (this.status === 500) return true;
    if (this.status !== null && this.status >= 502 && this.status <= 599) {
      // The one 5xx that will fail forever: no managed provider key configured.
      return !/not configured on this deployment|no provider API key is set/i.test(this.message);
    }
    return false;
  }

  /** One line, with the request id when there is one. */
  override toString(): string {
    const id = this.requestId ? ` (request ${this.requestId})` : "";
    return `${this.name}: ${this.message}${id}`;
  }
}

/** A misconfiguration, caught before any request was made. */
export class LobstackConfigError extends LobstackError {
  constructor(message: string, hint?: string) {
    super(message, { hint: hint ?? null });
  }
}

/**
 * The Gateway answered with a redirect, and this SDK did not follow it.
 *
 * RFC 9110 §15.4 requires a client to drop `Authorization` when a redirect
 * changes the host. Following one would strip the credential and turn a valid
 * key into "missing credentials" at the other end — an error that names the
 * wrong thing and costs hours. Refusing loudly is the only honest option.
 */
export class CrossHostRedirectError extends LobstackError {
  readonly from: string;
  readonly location: string | null;
  /** True when the redirect changes scheme, host or port. */
  readonly crossHost: boolean;

  constructor(args: {
    from: string;
    location: string | null;
    crossHost: boolean;
    status: number;
    requestId?: string | null;
  }) {
    super(
      args.crossHost
        ? `the Gateway redirected ${args.from} to ${args.location ?? "another host"} (${args.status}), and this SDK will not follow it: a redirect across hosts strips the Authorization header, so the credential would never arrive`
        : `the Gateway redirected ${args.from} to ${args.location ?? "elsewhere"} (${args.status}), and this SDK does not follow redirects`,
      {
        status: args.status,
        errorClass: "auth",
        requestId: args.requestId ?? null,
        hint: args.crossHost
          ? "Point baseUrl at the host that answers directly — https://www.lobstack.ai/api/gateway/v1, with the www. The apex 307s, and the Gateway then reports 'missing credentials' for a key that is perfectly good."
          : "Point baseUrl at the URL that answers directly.",
      },
    );
    this.from = args.from;
    this.location = args.location;
    this.crossHost = args.crossHost;
  }
}

/**
 * 402: the allowance for the period is gone.
 *
 * `quota` is non-null here and names which of the three meters applied, because
 * "5,000 of 5,000 requests" quoted to somebody who bought dollars is a support
 * ticket, and a dollar figure quoted to somebody who bought messages is a
 * broken promise.
 */
export class QuotaExhaustedError extends LobstackError {
  override readonly quota: QuotaSnapshot;

  constructor(message: string, init: LobstackErrorInit & { quota: QuotaSnapshot }) {
    super(message, init);
    this.quota = init.quota;
  }

  /** Seconds until the allowance resets. Usually days on a 402, not a backoff hint. */
  get retryAfterSeconds(): number | null {
    return this.quota.retryAfterSeconds;
  }

  override get retryable(): boolean {
    return false;
  }
}

/**
 * A failure reported inside a stream.
 *
 * The response status was already 200 and its headers are long gone, so the
 * only place left to report a mid-stream failure is the stream itself. The
 * trace row records the real status.
 */
export class StreamError extends LobstackError {}

/** True when `e` came from this SDK. */
export function isLobstackError(e: unknown): e is LobstackError {
  return e instanceof LobstackError;
}
