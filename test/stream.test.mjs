/**
 * The streamed path, against a real HTTP server writing real bytes — including
 * a write boundary that lands inside a JSON frame.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LobstackGateway,
  describeSavings,
  formatCostUsd,
  formatReceipt,
} from "../dist/index.js";
import { startFakeGateway } from "./fake-gateway.mjs";

const KEY = `lsk_test_${"a".repeat(8)}${"b".repeat(48)}`;

/** A client that keeps its warnings instead of printing them. */
function clientFor(gateway, options = {}) {
  const warnings = [];
  const client = new LobstackGateway({
    apiKey: KEY,
    baseUrl: gateway.baseUrl,
    onWarning: (w) => warnings.push(w),
    ...options,
  });
  return { client, warnings };
}

test("the receipt arrives after finish_reason, and is not lost to a frame cut mid-chunk", async () => {
  const gateway = await startFakeGateway({ receipt: "named" });
  try {
    const { client } = clientFor(gateway);
    const events = [];
    const result = await client.streamChat(
      { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] },
      { onEvent: (e) => events.push(e.type) },
    );

    // The bytes survived a write boundary inside a JSON object.
    assert.equal(result.text, "Hello there, from a fake gateway.");

    // The order that matters: usage comes AFTER finish. A reader that stops on
    // finish_reason keeps the answer and throws away the price.
    const finishAt = events.indexOf("finish");
    const usageAt = events.indexOf("usage");
    assert.ok(finishAt !== -1, "a finish event should be emitted");
    assert.ok(usageAt > finishAt, "the receipt must arrive after finish_reason");
    assert.equal(events.at(-1), "done");

    assert.equal(result.receipt.pricedFrom, "stream_frame");
    assert.equal(result.receipt.costUsd, 0.0011);
    assert.equal(result.receipt.servedModel, "claude-haiku-4-5");
    assert.equal(result.usage.total_tokens, 540);
  } finally {
    await gateway.close();
  }
});

test("stopping at finish_reason is what losing the receipt looks like", async () => {
  // Not a test of the SDK so much as a demonstration of the failure it exists
  // to prevent: the same stream, read the naive way, yields no receipt at all.
  const gateway = await startFakeGateway();
  try {
    const { client } = clientFor(gateway);
    let receipt = null;
    for await (const event of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "usage") receipt = event.receipt;
      if (event.type === "finish") break; // the mistake
    }
    assert.equal(receipt, null, "breaking on finish_reason loses the receipt");
  } finally {
    await gateway.close();
  }
});

test("an unpriced call stays null and never renders as a currency amount", async () => {
  const gateway = await startFakeGateway({ receipt: "unpriced" });
  try {
    const { client } = clientFor(gateway);
    const result = await client.streamChat({ messages: [{ role: "user", content: "hi" }] });

    assert.equal(result.receipt.costUsd, null, "unpriced must be null, never 0");
    assert.equal(result.receipt.priced, false);
    assert.equal(result.receipt.savingsUsd, null);
    assert.equal(formatCostUsd(result.receipt.costUsd), "unpriced");

    const line = formatReceipt(result.receipt);
    assert.doesNotMatch(line, /\$0\.0+\b/, "a null cost must not be rendered as $0.00");
    assert.match(line, /could not price/);
  } finally {
    await gateway.close();
  }
});

test("a plan-ceiling comparison is never labelled as a like-for-like saving", async () => {
  const named = await startFakeGateway({ receipt: "named" });
  const ceiling = await startFakeGateway({ receipt: "plan_ceiling" });
  try {
    const a = await clientFor(named).client.streamChat({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    });
    const b = await clientFor(ceiling).client.streamChat({
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
    });

    const namedClaim = describeSavings(a.receipt);
    const ceilingClaim = describeSavings(b.receipt);

    assert.equal(namedClaim.kind, "named");
    assert.equal(namedClaim.named, true);
    assert.equal(namedClaim.label, "saved");
    assert.equal(namedClaim.caveat, null);

    assert.equal(ceilingClaim.kind, "plan_ceiling");
    assert.equal(ceilingClaim.named, false);
    assert.notEqual(
      ceilingClaim.label,
      namedClaim.label,
      "the two baselines are different claims and must not share a label",
    );
    assert.doesNotMatch(ceilingClaim.label, /saved/);
    assert.ok(ceilingClaim.caveat, "a plan-ceiling figure must carry its disclosure");
    assert.match(ceilingClaim.caveat, /auto/);

    // Both figures are the same number of dollars. Only the words differ, and
    // that is the entire point.
    assert.equal(namedClaim.amountUsd, ceilingClaim.amountUsd);
    assert.match(formatReceipt(b.receipt), /priciest model your plan allows/);
  } finally {
    await named.close();
    await ceiling.close();
  }
});

test("a response with no receipt says so rather than reporting zero", async () => {
  const gateway = await startFakeGateway({ receipt: "none" });
  try {
    const { client, warnings } = clientFor(gateway);
    const result = await client.streamChat({ messages: [{ role: "user", content: "hi" }] });

    assert.equal(result.receipt.pricedFrom, "none");
    assert.equal(result.receipt.costUsd, null);
    assert.equal(result.usage.total_tokens, 540, "usage still parses — only the receipt is absent");
    assert.match(formatReceipt(result.receipt), /no receipt on this response/);
    assert.equal(warnings.at(-1)?.code, "no_receipt");
  } finally {
    await gateway.close();
  }
});

test("the routing and quota headers are still read on a streamed response", async () => {
  const gateway = await startFakeGateway({ quota: "spend" });
  try {
    const { client } = clientFor(gateway);
    const { receipt } = await client.streamChat({ messages: [{ role: "user", content: "hi" }] });

    assert.equal(receipt.tier, "small");
    assert.equal(receipt.complexity, 18);
    assert.equal(receipt.mode, "managed");
    assert.equal(receipt.principal, "api_key");
    assert.equal(receipt.savingsPct, 80);
    assert.equal(receipt.quota.meter, "spend");
    assert.equal(receipt.quota.remainingUsd, 8.75);
  } finally {
    await gateway.close();
  }
});

test("a mid-stream cut cannot be papered over by an even split", async () => {
  // Cut in several places, including inside the receipt frame itself.
  for (const cut of [0.05, 0.37, 0.5, 0.93, 0.99]) {
    const gateway = await startFakeGateway({ cut });
    try {
      const { client } = clientFor(gateway);
      const result = await client.streamChat({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(result.text, "Hello there, from a fake gateway.", `text lost at cut ${cut}`);
      assert.equal(result.receipt.costUsd, 0.0011, `receipt lost at cut ${cut}`);
    } finally {
      await gateway.close();
    }
  }
});
