import type { BaselineReason, QuotaSnapshot, Receipt } from "./receipt.js";

/**
 * Format a cost.
 *
 * `null` is UNPRICED, and it prints as the word, never as a number. The Gateway
 * returns null rather than zero precisely so that a client cannot write a real
 * charge off as free; a formatter that renders it `$0.00` undoes that on the
 * last line of the pipeline.
 */
export function formatCostUsd(
  value: number | null,
  options: { unpricedLabel?: string } = {},
): string {
  const unpriced = options.unpricedLabel ?? "unpriced";
  if (typeof value !== "number" || !Number.isFinite(value)) return unpriced;
  // Sub-cent figures are the normal case on a routed call; four decimals would
  // round most of them to $0.0000 and land back where we started.
  return value >= 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(6)}`;
}

/** A saving, with the words that are honest for its baseline. */
export interface SavingsClaim {
  amountUsd: number;
  /**
   * A short label. `"saved"` ONLY for a named baseline; a plan-ceiling
   * comparison gets different words, because it is a different claim.
   */
  label: string;
  kind: BaselineReason;
  /** True only for a like-for-like comparison against a model you asked for. */
  named: boolean;
  baselineModel: string | null;
  /** A sentence naming what the figure was measured against. Always show it. */
  comparedTo: string;
  /**
   * Present only on a plan-ceiling comparison: the disclosure that has to
   * travel with the number. Null for a named baseline, which needs none.
   */
  caveat: string | null;
}

/**
 * Decide whether a saving may be called a saving, in one place.
 *
 * `baseline_reason` decides, and the two answers are not interchangeable:
 *
 *   `named`         you asked for a model and got a cheaper one. Like-for-like.
 *                   This is the only case that may be labelled "saved".
 *   `plan_ceiling`  you sent `auto` and the Gateway measured against the
 *                   priciest model your plan allows — a real comparison, and
 *                   also the most flattering one available to the seller, and
 *                   one you never asked for.
 *
 * Returns null when there is nothing to report: no baseline, or a figure that
 * is not strictly positive. A plan-ceiling saving of exactly 0.000000 is a real
 * zero rather than a null, and it is still not a saving to show.
 */
export function describeSavings(
  receipt: Pick<Receipt, "savingsUsd" | "baselineReason" | "baselineModel">,
): SavingsClaim | null {
  const amountUsd = receipt.savingsUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  if (receipt.baselineReason === null) return null;

  const model = receipt.baselineModel;

  if (receipt.baselineReason === "named") {
    return {
      amountUsd,
      label: "saved",
      kind: "named",
      named: true,
      baselineModel: model,
      comparedTo: model
        ? `against ${model}, the model you asked for`
        : "against the model you asked for",
      caveat: null,
    };
  }

  return {
    amountUsd,
    label: "vs plan ceiling",
    kind: "plan_ceiling",
    named: false,
    baselineModel: model,
    comparedTo: model
      ? `against ${model}, the priciest model your plan allows`
      : "against the priciest model your plan allows",
    caveat: `You sent "auto", not ${model ?? "that model"}. This is what you would have paid had you asked for the best one — not a saving against your own request.`,
  };
}

/** A one-line receipt for a log or a terminal. Never claims a price it was not given. */
export function formatReceipt(receipt: Receipt): string {
  const parts: string[] = [];

  parts.push(`model ${receipt.servedModel ?? "unknown"}`);
  if (receipt.requestedModel && receipt.routed) parts.push(`asked ${receipt.requestedModel}`);
  parts.push(`cost ${formatCostUsd(receipt.costUsd)}`);

  const saving = describeSavings(receipt);
  if (saving) parts.push(`${saving.label} ${formatCostUsd(saving.amountUsd)}`);

  let line = parts.join("  ·  ");

  if (saving?.caveat) line += `\n  ${saving.comparedTo} — you sent "auto", not that model`;
  if (receipt.pricedFrom === "none") {
    line += "\n  no receipt on this response — the endpoint did not send one";
  } else if (!receipt.priced) {
    line += "\n  the Gateway could not price this model, so no cost is claimed";
  }
  if (receipt.metered === false) {
    line += "\n  the ledger write failed — you have your answer, the row is missing";
  }
  if (receipt.droppedParams.length > 0) {
    line += `\n  dropped: ${receipt.droppedParams.join(", ")} (not forwarded to the provider)`;
  }

  return line;
}

/** Where the caller stands against its allowance, in the units that meter uses. */
export function formatQuota(quota: QuotaSnapshot | null): string {
  if (quota === null) return "no allowance reported";

  switch (quota.meter) {
    case "spend":
      return `spend: ${formatUsd2(quota.spentUsd)} of ${formatUsd2(quota.allowanceUsd)} used, ${formatUsd2(quota.remainingUsd)} left${resets(quota.resetsAt)}`;
    case "requests":
    case "legacy": {
      const unit = quota.meter === "legacy" ? "messages" : "requests";
      const credits = quota.credits > 0 ? ` (+${quota.credits} purchased)` : "";
      return `${quota.meter}: ${quota.used ?? "?"} of ${quota.limit ?? "?"} ${unit} used, ${quota.remaining ?? "?"} left${credits}${resets(quota.resetsAt)}`;
    }
    default:
      return `unrecognised meter "${quota.raw["x-lobstack-quota-meter"] ?? "unknown"}" — read the raw headers rather than guessing the units`;
  }
}

function formatUsd2(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "unknown";
}

function resets(at: string | null): string {
  return at ? `, resets ${at}` : "";
}
