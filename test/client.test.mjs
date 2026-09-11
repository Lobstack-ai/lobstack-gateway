/**
 * The buffered path, the failures, and the two configuration mistakes that cost
 * the most: the apex, and a redirect followed with a credential attached.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import {
  CrossHostRedirectError,
  DEFAULT_BASE_URL,
  LobstackConfigError,
  LobstackError,
  LobstackGateway,
  QuotaExhaustedError,
  formatCostUsd,
  formatQuota,
  isApiKeyShape,
  normalizeBaseUrl,
  platformBaseUrlFrom,
  requirePriced,
} from "../dist/index.js";
import { startFakeGateway } from "./fake-gateway.mjs";

const KEY = `lsk_test_${"a".repeat(8)}${"b".repeat(48)}`;

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

test("a buffered completion carries its receipt in the headers", async () => {
  const gateway = await startFakeGateway({ receipt: "named" });
  try {
    const { client } = clientFor(gateway);
    const { completion, receipt } = await client.chat({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(completion.choices[0].message.content, "Hello there, from a fake gateway.");
    assert.equal(receipt.pricedFrom, "headers");
    assert.equal(receipt.costUsd, 0.0011);
    assert.equal(receipt.savingsUsd, 0.0044);
    assert.equal(receipt.baselineReason, "named");
    assert.equal(receipt.baselineModel, "claude-opus-5");
    assert.equal(receipt.priced, true);
    assert.equal(receipt.metered, true);
    assert.equal(receipt.requestedModel, "claude-opus-5");
    assert.equal(receipt.servedModel, "claude-haiku-4-5");
    assert.equal(requirePriced(receipt), 0.0011);
  } finally {
    await gateway.close();
  }
});

test("an empty cost header parses to null, not to zero", async () => {
  // `x-lobstack-cost-usd:` with an empty value is how the Gateway says
  // "unpriced" on the buffered path, and `Number("")` is 0. This is the exact
  // byte sequence that rendered a real charge as $0.00 for three months.
  const gateway = await startFakeGateway({ receipt: "unpriced" });
  try {
    const { client } = clientFor(gateway);
    const { receipt, response } = await client.chat({ messages: [{ role: "user", content: "hi" }] });

    assert.equal(response.headers.get("x-lobstack-cost-usd"), "", "the fixture must send an empty header");
    assert.equal(receipt.costUsd, null);
    assert.equal(receipt.savingsUsd, null);
    assert.equal(receipt.priced, false);
    assert.equal(formatCostUsd(receipt.costUsd), "unpriced");
    assert.throws(() => requirePriced(receipt), /unpriced/);
  } finally {
    await gateway.close();
  }
});

test("a cross-host redirect is refused, and the refusal names the credential loss", async () => {
  // A redirect that changes host makes every conforming client drop
  // Authorization, and the Gateway then answers a perfectly good key with
  // "missing credentials". Failing loudly beats reporting an auth error about a
  // credential that was never sent.
  const gateway = await startFakeGateway({ redirectTo: "https://www.example.com/elsewhere" });
  try {
    const { client } = clientFor(gateway);
    await assert.rejects(
      () => client.chat({ messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        assert.ok(error instanceof CrossHostRedirectError);
        assert.equal(error.crossHost, true);
        assert.equal(error.location, "https://www.example.com/elsewhere");
        assert.match(error.message, /will not follow it/);
        assert.match(error.message, /strips the Authorization header/);
        assert.match(error.hint, /www/);
        return true;
      },
    );
  } finally {
    await gateway.close();
  }
});

test("a streamed request refuses the same redirect", async () => {
  const gateway = await startFakeGateway({ redirectTo: "https://www.example.com/elsewhere" });
  try {
    const { client } = clientFor(gateway);
    await assert.rejects(
      () => client.streamChat({ messages: [{ role: "user", content: "hi" }] }),
      CrossHostRedirectError,
    );
  } finally {
    await gateway.close();
  }
});

test("a same-host redirect is refused too, and says something different", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(308, { location: "/api/gateway/v2/chat/completions" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/gateway/v1`;
  try {
    const client = new LobstackGateway({ apiKey: KEY, baseUrl: base, onWarning: () => {} });
    await assert.rejects(
      () => client.models(),
      (error) => {
        assert.ok(error instanceof CrossHostRedirectError);
        assert.equal(error.crossHost, false, "same origin: the credential would survive");
        assert.doesNotMatch(error.message, /strips the Authorization header/);
        return true;
      },
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("a 402 surfaces the meter it was measured on — dollars", async () => {
  const gateway = await startFakeGateway({ exhausted: true, quota: "spend" });
  try {
    const { client } = clientFor(gateway);
    await assert.rejects(
      () => client.chat({ messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        assert.ok(error instanceof QuotaExhaustedError);
        assert.equal(error.status, 402);
        assert.equal(error.errorClass, "quota");
        assert.equal(error.retryable, false);
        assert.equal(error.quota.meter, "spend");
        assert.equal(error.quota.allowanceUsd, 10);
        assert.equal(error.quota.spentUsd, 10.00412);
        assert.equal(error.quota.remainingUsd, 0);
        assert.equal(error.retryAfterSeconds, 1976400);
        assert.equal(error.requestId, "req_test_0001");
        assert.match(formatQuota(error.quota), /\$10\.00/);
        // A spend meter has no request counters at all, and the type says so.
        assert.equal("limit" in error.quota, false);
        return true;
      },
    );
  } finally {
    await gateway.close();
  }
});

test("a 402 surfaces the meter it was measured on — requests", async () => {
  const gateway = await startFakeGateway({ exhausted: true, quota: "requests" });
  try {
    const { client } = clientFor(gateway);
    await assert.rejects(
      () => client.chat({ messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        assert.equal(error.quota.meter, "requests");
        assert.equal(error.quota.limit, 100000);
        assert.equal(error.quota.used, 100000);
        assert.equal(error.quota.remaining, 0);
        assert.equal(error.quota.credits, 0);
        // No dollar figure is quoted to somebody who did not buy dollars.
        assert.equal("allowanceUsd" in error.quota, false);
        assert.match(formatQuota(error.quota), /100000 requests/);
        return true;
      },
    );
  } finally {
    await gateway.close();
  }
});

test("a 401 that says 'missing credentials' points at the apex", async () => {
  const gateway = await startFakeGateway();
  try {
    const client = new LobstackGateway({
      apiKey: "lsk_test_deadbeef" + "0".repeat(48),
      baseUrl: gateway.baseUrl,
      onWarning: () => {},
      fetch: (url, init) => {
        // Strip the header, exactly as a redirect across hosts would.
        const headers = { ...init.headers };
        delete headers.authorization;
        return fetch(url, { ...init, headers });
      },
    });
    await assert.rejects(
      () => client.chat({ messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        assert.ok(error instanceof LobstackError);
        assert.equal(error.status, 401);
        assert.match(error.hint, /apex/);
        assert.match(error.hint, /www\.lobstack\.ai/);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    await gateway.close();
  }
});

test("the model listing survives a model with no price", async () => {
  const gateway = await startFakeGateway();
  try {
    const { client } = clientFor(gateway);
    const models = await client.models();
    assert.equal(models.length, 3);
    const unpriced = models.find((m) => m.id === "llama-4-scout-local");
    assert.equal(unpriced.price_per_mtok.input, undefined, "absent, not zero");
  } finally {
    await gateway.close();
  }
});

test("route-preview is public, so no credential is sent to it", async () => {
  // The fake gateway answers 400 if a credential arrives on this endpoint.
  const gateway = await startFakeGateway();
  try {
    const { client } = clientFor(gateway);
    const preview = await client.routePreview({ prompt: "hello", requested_model: "claude-opus-5" });
    assert.equal(preview.object, "routing_preview");
    assert.equal(preview.token_estimate.estimated, true);
    assert.equal(preview.model.key, "claude-haiku-4-5");
  } finally {
    await gateway.close();
  }
});

test("usage is read from the platform root, not from under the Gateway base", async () => {
  const gateway = await startFakeGateway();
  try {
    const { client } = clientFor(gateway);
    assert.equal(client.platformBaseUrl, `${gateway.url}/api/v1`);

    const report = await client.usage({ range: "30d", groupBy: "model" });
    assert.equal(report.enabled, true);
    assert.equal(report.range, "30d");
    assert.equal(report.group_by, "model");
    // The sum is a floor while any row is unpriced, and the field that says so
    // travels with it.
    assert.equal(report.summary.unpriced_requests, 1);
  } finally {
    await gateway.close();
  }
});

test("the apex is corrected out loud rather than silently followed", () => {
  const apex = normalizeBaseUrl("https://lobstack.ai/api/gateway/v1");
  assert.equal(apex.baseUrl, "https://www.lobstack.ai/api/gateway/v1");
  assert.equal(apex.corrected, true);
  assert.match(apex.note, /RFC 9110/);

  const already = normalizeBaseUrl(DEFAULT_BASE_URL);
  assert.equal(already.corrected, false, "nothing to announce when it is already right");

  // Somebody else's host is left exactly as given: this is a correction for one
  // known redirect, not a policy about other people's domains.
  const other = normalizeBaseUrl("http://127.0.0.1:9999/api/gateway/v1");
  assert.equal(other.baseUrl, "http://127.0.0.1:9999/api/gateway/v1");
  assert.equal(other.corrected, false);

  assert.equal(normalizeBaseUrl().baseUrl, DEFAULT_BASE_URL);
  assert.throws(() => normalizeBaseUrl("not-a-url"), LobstackConfigError);
});

test("the client announces the correction when it makes it", () => {
  const warnings = [];
  const client = new LobstackGateway({
    apiKey: KEY,
    baseUrl: "https://lobstack.ai/api/gateway/v1",
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(client.baseUrl, "https://www.lobstack.ai/api/gateway/v1");
  assert.equal(warnings[0].code, "base_url_corrected");
});

test("the platform URL is derived from whatever base is in use", () => {
  assert.equal(platformBaseUrlFrom(DEFAULT_BASE_URL), "https://www.lobstack.ai/api/v1");
  assert.equal(platformBaseUrlFrom("http://localhost:3000/api/gateway/v1"), "http://localhost:3000/api/v1");
});

test("a credential that is not shaped like a key is flagged, not rejected", () => {
  // An agent gateway token is a legitimate credential with a different shape,
  // so this is a warning rather than a refusal.
  const warnings = [];
  new LobstackGateway({ apiKey: "gw_token_from_an_agent", onWarning: (w) => warnings.push(w) });
  assert.equal(warnings[0].code, "credential_shape");

  assert.equal(isApiKeyShape(KEY), true);
  assert.equal(isApiKeyShape("lsk_live_zzzz"), false);
  assert.equal(isApiKeyShape(null), false);
});

test("calling an authenticated endpoint with no key fails before any request", async () => {
  const client = new LobstackGateway({ apiKey: null, onWarning: () => {} });
  await assert.rejects(() => client.chat({ messages: [] }), LobstackConfigError);
});
