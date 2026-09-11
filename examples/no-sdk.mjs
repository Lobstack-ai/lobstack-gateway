/**
 * The same thing without this SDK — the contract is implementable in forty
 * lines, in any language, from `spec/`.
 *
 *   LOBSTACK_API_KEY=lsk_live_… node examples/no-sdk.mjs
 *
 * Four rules are doing all the work here, and each of them is in the spec:
 *
 *   1. `www`, and `redirect: "manual"`. A redirect across hosts strips
 *      `Authorization` (RFC 9110 §15.4) and the Gateway then reports "missing
 *      credentials" for a key that is fine.
 *   2. Buffer across reads. A JSON frame can be cut by the network.
 *   3. Do not stop at `finish_reason`. The receipt is the frame after it.
 *   4. `cost_usd: null` is unpriced. Not zero.
 */
const BASE = "https://www.lobstack.ai/api/gateway/v1";
const KEY = process.env.LOBSTACK_API_KEY;

if (!KEY) {
  console.error("set LOBSTACK_API_KEY");
  process.exit(1);
}

const response = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  redirect: "manual", // rule 1
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "auto",
    stream: true,
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  }),
});

if (response.status >= 300 && response.status < 400) {
  throw new Error(
    `refusing to follow a redirect to ${response.headers.get("location")}: it would strip the key`,
  );
}
if (!response.ok) throw new Error(`${response.status}: ${(await response.json()).error?.message}`);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let receipt = null;
let usage = null;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true }); // rule 2

  let cut;
  while ((cut = buffer.indexOf("\n\n")) !== -1) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 2);
    if (!line.startsWith("data:")) continue;

    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;

    const frame = JSON.parse(payload);
    if (frame.error) throw new Error(frame.error.message);

    const delta = frame.choices?.[0]?.delta?.content;
    if (delta) process.stdout.write(delta);

    // rule 3: keep reading past finish_reason — this is where the money is
    if (frame.usage) usage = frame.usage;
    if (frame.x_lobstack) receipt = frame.x_lobstack;
  }
}

process.stdout.write("\n\n");

// rule 4
const cost = receipt?.cost_usd == null ? "unpriced" : `$${receipt.cost_usd.toFixed(6)}`;
console.log(`served ${receipt?.served_model ?? "unknown"}  tokens ${usage?.total_tokens ?? "?"}  cost ${cost}`);

if (typeof receipt?.savings_usd === "number" && receipt.savings_usd > 0) {
  const label =
    receipt.baseline_reason === "named"
      ? `saved $${receipt.savings_usd.toFixed(6)} against ${receipt.baseline_model}, the model you asked for`
      : `$${receipt.savings_usd.toFixed(6)} cheaper than ${receipt.baseline_model}, the priciest model your plan allows — which you did not ask for`;
  console.log(label);
}
