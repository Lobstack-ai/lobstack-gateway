/**
 * Stream a completion and print what it cost.
 *
 *   LOBSTACK_API_KEY=lsk_live_… node examples/quickstart.mjs "why did the deploy roll back?"
 *
 * In your own project the import is `@lobstack/gateway`; inside this repo it is
 * the built output, so `npm run build` first.
 */
import { LobstackGateway, describeSavings, formatCostUsd } from "../dist/index.js";

const prompt = process.argv.slice(2).join(" ") || "Say hello in one short sentence.";

const lobstack = new LobstackGateway(); // apiKey from LOBSTACK_API_KEY

const result = await lobstack.streamChat(
  { model: "auto", messages: [{ role: "user", content: prompt }] },
  { onText: (delta) => process.stdout.write(delta) },
);

const { receipt, usage } = result;

process.stdout.write("\n\n");
console.log(`model   ${receipt.servedModel}  (tier ${receipt.tier ?? "unknown"})`);
console.log(`tokens  ${usage?.prompt_tokens ?? "?"} in / ${usage?.completion_tokens ?? "?"} out`);

// formatCostUsd prints "unpriced" for null. Never print `costUsd ?? 0`: null
// means the Gateway could not price the call, not that it was free.
console.log(`cost    ${formatCostUsd(receipt.costUsd)}`);

// A saving is only reported with the reason it was measured against, and the
// two reasons are different claims.
const saving = describeSavings(receipt);
if (saving) {
  console.log(`${saving.label.padEnd(7)} ${formatCostUsd(saving.amountUsd)} — ${saving.comparedTo}`);
  if (saving.caveat) console.log(`        ${saving.caveat}`);
}

console.log(`request ${receipt.requestId}`);
