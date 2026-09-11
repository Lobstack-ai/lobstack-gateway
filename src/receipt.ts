/**
 * The receipt: what a request cost, what served it, and what any saving was
 * measured against.
 *
 * Two transports carry the same facts, because the two response shapes have
 * different physics:
 *
 *   • Buffered (`stream: false`) — everything is in `x-lobstack-*` response
 *     headers, including the money.
 *   • Streamed (`stream: true`) — the routing and quota headers are there, but
 *     the money CANNOT be, because headers flush before the provider has
 *     counted a token. The price arrives on the final SSE frame under
 *     `x_lobstack`, after the chunk carrying `finish_reason`.
 *
 * `Receipt` is the normalised shape of both. Every money field is
 * `number | null` and never defaults to zero — see the note on `costUsd`.
 */

/** Why a saving has the baseline it has. Null when there is no baseline. */
export type BaselineReason = "named" | "plan_ceiling";

/** Which credential authenticated the call. */
export type Principal = "api_key" | "gateway_token" | "agent_secret";

/** Whose provider key paid for the tokens. */
export type Mode = "managed" | "byok";

/** The capability tier the router's score landed in. */
export type ModelTier = "nano" | "small" | "standard" | "premium" | "flagship";

/**
 * `x_lobstack`, exactly as it appears on the final SSE frame.
 *
 * Field names are the wire names on purpose: this is the type for code that
 * reads chunks itself, and it matches `spec/x_lobstack.schema.json` member for
 * member. Unknown members MUST be ignored rather than treated as an error —
 * the object is open for extension.
 */
export interface XLobstack {
  request_id: string;
  served_model: string;
  requested_model: string;
  routed: boolean;
  /** Null, never 0, when the call could not be priced. See `Receipt.costUsd`. */
  cost_usd: number | null;
  savings_usd: number | null;
  priced: boolean;
  baseline_model: string | null;
  baseline_reason: BaselineReason | null;
  baseline_cost_usd: number | null;
}

/** Where the money on a receipt came from. */
export type PricedFrom =
  /** `x-lobstack-cost-usd` and friends, on a buffered response. */
  | "headers"
  /** `x_lobstack` on the final SSE frame, on a streamed response. */
  | "stream_frame"
  /**
   * Nowhere. The response carried no receipt at all — an older Gateway, or a
   * base URL that is not a Lobstack Gateway. `costUsd` is null because nothing
   * was reported, NOT because the call was free. Say so in your UI.
   */
  | "none";

/** A spend meter: the allowance is dollars of model spend. */
export interface SpendQuota {
  meter: "spend";
  allowanceUsd: number | null;
  spentUsd: number | null;
  remainingUsd: number | null;
  resetsAt: string | null;
  /** Seconds until the allowance resets, from `retry-after` on a 402. */
  retryAfterSeconds: number | null;
}

/** A counted meter: the allowance is requests (BYOK) or messages (legacy). */
export interface CountedQuota {
  meter: "requests" | "legacy";
  limit: number | null;
  used: number | null;
  /** Limit minus used, plus credits. Never negative. */
  remaining: number | null;
  /** Purchased top-up remaining. Zero unless the Gateway sent a figure. */
  credits: number;
  resetsAt: string | null;
  retryAfterSeconds: number | null;
}

/** A meter this SDK does not know. Forward compatibility, not a failure. */
export interface UnknownQuota {
  meter: "unknown";
  /** The raw `x-lobstack-quota-*` headers, so nothing is lost. */
  raw: Record<string, string>;
  resetsAt: string | null;
  retryAfterSeconds: number | null;
}

/**
 * Where the caller stands against its allowance.
 *
 * A discriminated union on purpose. Three meters exist because three different
 * things are sold, and their counters are not interchangeable: a `0` in a
 * request limit shown to somebody on a spend meter reads as "no allowance", and
 * a dollar figure shown to a legacy subscriber who bought messages is a number
 * they never agreed to be measured in. Branch on `meter` before reading
 * anything else — the type will not let you do otherwise.
 */
export type QuotaSnapshot = SpendQuota | CountedQuota | UnknownQuota;

/** The normalised receipt for one request. */
export interface Receipt {
  /** The trace row id. Allocated before anything can fail, so a 401 has one. */
  requestId: string | null;
  /** What actually served the request. Not necessarily what you asked for. */
  servedModel: string | null;
  /** What you asked for: a model key, or `"auto"`. */
  requestedModel: string | null;
  /** True when you sent `auto`, or when the served model differs from yours. */
  routed: boolean;
  tier: ModelTier | string | null;
  /** The heuristic score for the last user message, 0–100. */
  complexity: number | null;
  mode: Mode | string | null;
  principal: Principal | string | null;

  /**
   * What you owe for these tokens, in USD.
   *
   * `null` means UNPRICED — the Gateway could not price the served model, or
   * the request was never metered. It does not mean free and it does not mean
   * zero. Render it as unknown; rendering it as `$0.00` writes off a real
   * charge, which is exactly the bug this field is nullable to prevent.
   * `formatCostUsd` does the right thing, and `requirePriced` is the explicit
   * escape hatch when you genuinely need a number.
   */
  costUsd: number | null;

  /** Baseline cost minus `costUsd`. Null when there is no baseline. */
  savingsUsd: number | null;

  /**
   * The router's tier-multiplier estimate, 0–100. An estimate about tiers, not
   * a measurement about dollars. It is not a rounded `savingsUsd` and the two
   * must never be added together or presented as the same claim.
   */
  savingsPct: number | null;

  /** False when the served model is not in the registry, so cost is null. */
  priced: boolean;

  /** False when the ledger write failed: you got your answer, the row is missing. */
  metered: boolean | null;

  /** The model a saving was measured against. */
  baselineModel: string | null;

  /**
   * Why that model is the comparison, and therefore what the saving means.
   *
   *   `"named"`        — you asked for `baselineModel` and something else
   *                      served it. Like-for-like: a measurement against your
   *                      own request.
   *   `"plan_ceiling"` — you sent `auto`. `baselineModel` is the priciest model
   *                      your plan allows, which you never asked for. A real
   *                      subtraction and also the most flattering one available.
   *   `null`           — no baseline, no saving.
   *
   * Render this next to the figure, or do not render the figure.
   * `describeSavings` refuses to label the two cases identically.
   */
  baselineReason: BaselineReason | null;

  /** What the baseline model would have charged for these exact token counts. */
  baselineCostUsd: number | null;

  /** Sampling parameters the Gateway dropped rather than forwarding. */
  droppedParams: string[];

  /** Where the caller stands against its allowance, when there is one. */
  quota: QuotaSnapshot | null;

  /** Which transport carried the money. See `PricedFrom`. */
  pricedFrom: PricedFrom;
}

/* ── Header parsing ───────────────────────────────────────────────────────── */

/** Minimal Headers shape, so this works with anything fetch-like. */
export interface HeaderBag {
  get(name: string): string | null;
}

/**
 * Read a numeric header.
 *
 * The Gateway sends an EMPTY STRING, not `0`, where the honest answer is "no
 * number" — an unpriced model, or no baseline. `Number("")` is `0`, which is
 * how a careless parse turns "we could not price this" into "this was free".
 */
export function numericHeader(headers: HeaderBag, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function boolHeader(headers: HeaderBag, name: string): boolean | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  return raw.trim() === "true";
}

function stringHeader(headers: HeaderBag, name: string): string | null {
  const raw = headers.get(name);
  return raw === null || raw.trim() === "" ? null : raw.trim();
}

function baselineReasonOf(value: string | null): BaselineReason | null {
  return value === "named" || value === "plan_ceiling" ? value : null;
}

/** Read the quota headers. Null when the response carried none. */
export function parseQuota(headers: HeaderBag): QuotaSnapshot | null {
  const meter = stringHeader(headers, "x-lobstack-quota-meter");
  if (meter === null) return null;

  const resetsAt = stringHeader(headers, "x-lobstack-quota-resets");
  const retryAfterSeconds = numericHeader(headers, "retry-after");

  if (meter === "spend") {
    return {
      meter: "spend",
      allowanceUsd: numericHeader(headers, "x-lobstack-quota-allowance-usd"),
      spentUsd: numericHeader(headers, "x-lobstack-quota-spent-usd"),
      remainingUsd: numericHeader(headers, "x-lobstack-quota-remaining-usd"),
      resetsAt,
      retryAfterSeconds,
    };
  }

  if (meter === "requests" || meter === "legacy") {
    return {
      meter,
      limit: numericHeader(headers, "x-lobstack-quota-limit"),
      used: numericHeader(headers, "x-lobstack-quota-used"),
      remaining: numericHeader(headers, "x-lobstack-quota-remaining"),
      credits: numericHeader(headers, "x-lobstack-quota-credits") ?? 0,
      resetsAt,
      retryAfterSeconds,
    };
  }

  const raw: Record<string, string> = {};
  for (const name of [
    "x-lobstack-quota-meter",
    "x-lobstack-quota-allowance-usd",
    "x-lobstack-quota-spent-usd",
    "x-lobstack-quota-remaining-usd",
    "x-lobstack-quota-limit",
    "x-lobstack-quota-used",
    "x-lobstack-quota-remaining",
    "x-lobstack-quota-credits",
  ]) {
    const value = headers.get(name);
    if (value !== null && value !== "") raw[name] = value;
  }
  return { meter: "unknown", raw, resetsAt, retryAfterSeconds };
}

/**
 * The receipt off a buffered response's headers.
 *
 * On a streamed response this still carries the routing and quota facts; the
 * money is absent by construction and `pricedFrom` says `"none"` until the
 * final frame is merged in. See `mergeStreamReceipt`.
 */
export function receiptFromHeaders(headers: HeaderBag): Receipt {
  const costUsd = numericHeader(headers, "x-lobstack-cost-usd");
  const priced = boolHeader(headers, "x-lobstack-priced");
  const dropped = stringHeader(headers, "x-lobstack-dropped-params");

  return {
    requestId: stringHeader(headers, "x-lobstack-request-id"),
    servedModel: stringHeader(headers, "x-lobstack-model"),
    requestedModel: null,
    routed: boolHeader(headers, "x-lobstack-routed") ?? false,
    tier: stringHeader(headers, "x-lobstack-tier"),
    complexity: numericHeader(headers, "x-lobstack-complexity"),
    mode: stringHeader(headers, "x-lobstack-mode"),
    principal: stringHeader(headers, "x-lobstack-principal"),
    costUsd,
    savingsUsd: numericHeader(headers, "x-lobstack-savings-usd"),
    savingsPct: numericHeader(headers, "x-lobstack-savings-pct"),
    priced: priced ?? false,
    metered: boolHeader(headers, "x-lobstack-metered"),
    baselineModel: stringHeader(headers, "x-lobstack-baseline-model"),
    baselineReason: baselineReasonOf(stringHeader(headers, "x-lobstack-baseline-reason")),
    baselineCostUsd: numericHeader(headers, "x-lobstack-baseline-usd"),
    droppedParams: dropped === null ? [] : dropped.split(",").map((s) => s.trim()).filter(Boolean),
    quota: parseQuota(headers),
    // The cost headers exist only on the buffered path. Their absence on a
    // stream is not "free", it is "not here yet".
    pricedFrom: priced === null && costUsd === null ? "none" : "headers",
  };
}

/* ── Frame parsing ────────────────────────────────────────────────────────── */

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Read `x_lobstack` off a parsed SSE chunk.
 *
 * Deliberately tolerant about members it does not know and deliberately strict
 * about the money: anything that is not a finite number becomes `null`, so a
 * malformed frame degrades to "unpriced" rather than to a wrong figure.
 */
export function parseReceiptFrame(chunk: unknown): XLobstack | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const raw = (chunk as { x_lobstack?: unknown }).x_lobstack;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  return {
    request_id: stringOrNull(r["request_id"]) ?? "",
    served_model: stringOrNull(r["served_model"]) ?? "",
    requested_model: stringOrNull(r["requested_model"]) ?? "",
    routed: r["routed"] === true,
    cost_usd: numberOrNull(r["cost_usd"]),
    savings_usd: numberOrNull(r["savings_usd"]),
    priced: r["priced"] === true,
    baseline_model: stringOrNull(r["baseline_model"]),
    baseline_reason: baselineReasonOf(stringOrNull(r["baseline_reason"])),
    baseline_cost_usd: numberOrNull(r["baseline_cost_usd"]),
  };
}

/**
 * Combine the routing and quota facts from a stream's headers with the money
 * from its final frame.
 *
 * When no frame arrived — an older Gateway, or a base URL that is not ours —
 * the money stays null and `pricedFrom` is `"none"`, which is a different
 * statement from `priced: false` and should read differently in a UI.
 */
export function mergeStreamReceipt(base: Receipt, frame: XLobstack | null): Receipt {
  if (frame === null) return { ...base, pricedFrom: "none" };
  return {
    ...base,
    requestId: frame.request_id || base.requestId,
    servedModel: frame.served_model || base.servedModel,
    requestedModel: frame.requested_model || base.requestedModel,
    routed: frame.routed || base.routed,
    costUsd: frame.cost_usd,
    savingsUsd: frame.savings_usd,
    priced: frame.priced,
    baselineModel: frame.baseline_model,
    baselineReason: frame.baseline_reason,
    baselineCostUsd: frame.baseline_cost_usd,
    pricedFrom: "stream_frame",
  };
}

/** True when the Gateway put a real price on this request. */
export function isPriced(receipt: Pick<Receipt, "costUsd">): receipt is Receipt & { costUsd: number } {
  return typeof receipt.costUsd === "number";
}

/**
 * The cost as a number, or a thrown error naming why there isn't one.
 *
 * The explicit escape hatch for code that must have a figure. It exists so that
 * `receipt.costUsd ?? 0` never looks like the reasonable option.
 */
export function requirePriced(receipt: Receipt): number {
  if (typeof receipt.costUsd === "number") return receipt.costUsd;
  throw new Error(
    receipt.pricedFrom === "none"
      ? "this response carried no Lobstack receipt, so there is no cost to read (an older Gateway, or a base URL that is not a Lobstack Gateway)"
      : "the Gateway could not price this request (cost_usd is null, which means unpriced — not free)",
  );
}
