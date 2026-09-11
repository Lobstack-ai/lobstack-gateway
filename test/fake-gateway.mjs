/**
 * A stand-in Gateway, so the SDK can be tested against real bytes over real
 * HTTP rather than against a mocked `fetch`.
 *
 * It speaks the shapes that matter and nothing else: the buffered completion
 * with its `x-lobstack-*` headers, the streamed completion whose final frame
 * carries `x_lobstack`, the model listing, the usage summary, and the 402 that
 * names its meter.
 *
 * Two details are deliberate and load-bearing:
 *
 *   • The stream is written in two pieces and the cut lands INSIDE a frame. A
 *     fixture that always writes whole frames never exercises the buffer that
 *     the SDK's SSE reader exists to provide, and a reader without it drops
 *     tokens — or the receipt.
 *   • An unpriced buffered response sends `x-lobstack-cost-usd:` with an EMPTY
 *     value, exactly as the Gateway does. `Number("")` is `0`, so this is the
 *     byte-level shape of the bug the receipt is nullable to prevent.
 *
 * It also runs standalone, for poking at by hand:
 *
 *   node test/fake-gateway.mjs --port 8799 --receipt plan_ceiling
 */
import { createServer } from "node:http";

const BASE_RECEIPT = {
  request_id: "req_test_0001",
  served_model: "claude-haiku-4-5",
  requested_model: "claude-opus-5",
  routed: true,
  cost_usd: 0.0011,
  savings_usd: 0.0044,
  priced: true,
  baseline_model: "claude-opus-5",
  baseline_reason: "named",
  baseline_cost_usd: 0.0055,
};

/** The receipt in each of the four states a client has to survive. */
export function receiptFor(kind) {
  switch (kind) {
    case "plan_ceiling":
      // Nobody asked for the baseline model here. The receipt has to say so.
      return {
        ...BASE_RECEIPT,
        requested_model: "auto",
        baseline_model: "claude-fable-5-1",
        baseline_reason: "plan_ceiling",
      };
    case "unpriced":
      return {
        ...BASE_RECEIPT,
        requested_model: "auto",
        cost_usd: null,
        savings_usd: null,
        priced: false,
        baseline_model: null,
        baseline_reason: null,
        baseline_cost_usd: null,
      };
    case "none":
      return null;
    case "named":
    default:
      return BASE_RECEIPT;
  }
}

const MODELS = {
  object: "list",
  data: [
    {
      id: "claude-haiku-4-5",
      object: "model",
      owned_by: "anthropic",
      label: "Claude Haiku 4.5",
      tier: "small",
      context_window: 200000,
      price_per_mtok: { input: 1, output: 5 },
      managed: true,
    },
    {
      id: "claude-opus-5",
      object: "model",
      owned_by: "anthropic",
      label: "Claude Opus 5",
      tier: "flagship",
      context_window: 1000000,
      price_per_mtok: { input: 5, output: 25 },
      managed: true,
    },
    {
      // No price at all. The live catalogue always sends both sides today, so
      // this entry is deliberately harsher than the Gateway: a client that
      // renders it as $0.00 would render a real unpriced request the same way.
      id: "llama-4-scout-local",
      object: "model",
      owned_by: "groq",
      label: "Llama 4 Scout",
      tier: "small",
      context_window: 128000,
      price_per_mtok: {},
      managed: false,
    },
  ],
};

const TEXT_DELTAS = ["Hello", " there", ", from a fake gateway."];

/**
 * @param {object} [options]
 * @param {"named"|"plan_ceiling"|"unpriced"|"none"} [options.receipt]
 * @param {"spend"|"requests"|null} [options.quota]  which meter to report
 * @param {boolean} [options.exhausted]              answer 402 instead of serving
 * @param {string}  [options.redirectTo]             answer 307 to this location
 * @param {number}  [options.cut]                    fraction of the stream in the first write
 * @param {number}  [options.delayMs]                pause between the two writes
 * @param {number}  [options.port]
 */
export function startFakeGateway(options = {}) {
  const {
    receipt = "named",
    quota = "spend",
    exhausted = false,
    redirectTo = null,
    cut = 0.37,
    delayMs = 5,
    port = 0,
  } = options;

  /** Exactly the headers the real Gateway sends for this meter. */
  const quotaHeaders = () => {
    if (quota === "spend") {
      return {
        "x-lobstack-quota-meter": "spend",
        "x-lobstack-quota-allowance-usd": exhausted ? "10.000000" : "10.000000",
        "x-lobstack-quota-spent-usd": exhausted ? "10.004120" : "1.250000",
        "x-lobstack-quota-remaining-usd": exhausted ? "0.000000" : "8.750000",
        "x-lobstack-quota-resets": "2026-10-01T00:00:00.000Z",
      };
    }
    if (quota === "requests") {
      return {
        "x-lobstack-quota-meter": "requests",
        "x-lobstack-quota-limit": "100000",
        "x-lobstack-quota-used": exhausted ? "100000" : "12",
        "x-lobstack-quota-remaining": exhausted ? "0" : "99988",
        "x-lobstack-quota-resets": "2026-10-01T00:00:00.000Z",
      };
    }
    return {};
  };

  const routingHeaders = () => ({
    "x-lobstack-request-id": BASE_RECEIPT.request_id,
    "x-lobstack-model": BASE_RECEIPT.served_model,
    "x-lobstack-tier": "small",
    "x-lobstack-complexity": "18",
    "x-lobstack-savings-pct": "80",
    "x-lobstack-routed": "true",
    "x-lobstack-mode": "managed",
    "x-lobstack-principal": "api_key",
    ...quotaHeaders(),
  });

  /** The cost headers, which exist on the buffered path only. */
  const costHeaders = () => {
    const r = receiptFor(receipt);
    if (r === null) return {};
    return {
      // Empty string, not "0", when there is no honest number. This is the
      // byte-level shape a client has to parse correctly.
      "x-lobstack-cost-usd": r.cost_usd === null ? "" : r.cost_usd.toFixed(6),
      "x-lobstack-savings-usd": r.savings_usd === null ? "" : r.savings_usd.toFixed(6),
      "x-lobstack-priced": String(r.priced),
      "x-lobstack-metered": "true",
      ...(r.baseline_reason
        ? {
            "x-lobstack-baseline-reason": r.baseline_reason,
            "x-lobstack-baseline-model": r.baseline_model ?? "",
            "x-lobstack-baseline-usd":
              r.baseline_cost_usd === null ? "" : r.baseline_cost_usd.toFixed(6),
          }
        : {}),
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (redirectTo) {
      res.writeHead(307, { location: redirectTo });
      res.end();
      return;
    }

    // /models and /route-preview are public on the real Gateway too.
    const isPublic =
      url.pathname.endsWith("/models") || url.pathname.endsWith("/route-preview");

    const auth = req.headers.authorization;
    if (!isPublic && (!auth || !auth.startsWith("Bearer lsk_"))) {
      json(res, 401, {
        error: {
          message: auth
            ? "unrecognised credential: the Authorization header arrived but matched no API key or gateway token."
            : "missing credentials: no Authorization header reached the Gateway. Send an API key as a Bearer token. If you called https://lobstack.ai without the www, the redirect to www.lobstack.ai strips the header.",
          type: "auth",
          code: 401,
          request_id: BASE_RECEIPT.request_id,
        },
      }, { "x-lobstack-request-id": BASE_RECEIPT.request_id });
      return;
    }

    if (url.pathname.endsWith("/models")) {
      json(res, 200, MODELS);
      return;
    }

    if (url.pathname.endsWith("/route-preview")) {
      if (req.headers.authorization) {
        // Asserted by a test: this endpoint is public, and the SDK must not
        // hand a credential to something that does not need one.
        json(res, 400, { error: { message: "a credential was sent to a public endpoint", type: "validation", code: 400 } });
        return;
      }
      json(res, 200, {
        object: "routing_preview",
        requested_model: "claude-opus-5",
        plan_tier: "pro",
        complexity: 18,
        tier: "small",
        routed: true,
        reason: "a short factual question",
        model: {
          key: "claude-haiku-4-5",
          label: "Claude Haiku 4.5",
          provider: "anthropic",
          context_window: 200000,
          price_per_mtok: { input: 1, output: 5 },
          managed_key_configured: true,
        },
        token_estimate: { input: 12, output: 64, method: "~4 characters per token", estimated: true },
        cost_usd: 0.000332,
        baseline: { model: "claude-opus-5", label: "Claude Opus 5", cost_usd: 0.00166, saving_usd: 0.001328 },
        note: "Estimated from the same registry that serves /v1/chat/completions.",
      });
      return;
    }

    if (url.pathname.includes("/api/v1/usage")) {
      json(res, 200, {
        enabled: true,
        org_id: "org_test",
        authenticated_via: "api_key",
        range: url.searchParams.get("range") ?? "7d",
        group_by: url.searchParams.get("group_by") ?? "day",
        summary: {
          requests: 3,
          errors: 0,
          error_rate: 0,
          errors_by_class: {},
          prompt_tokens: 1200,
          completion_tokens: 420,
          total_tokens: 1620,
          cost_usd: 0.0033,
          unpriced_requests: 1,
          p50_latency_ms: 812,
          p95_latency_ms: 1400,
          p99_latency_ms: 1900,
          streamed: 2,
        },
        groups: [
          {
            key: "claude-haiku-4-5",
            requests: 3,
            errors: 0,
            total_tokens: 1620,
            cost_usd: 0.0033,
            unpriced_requests: 1,
            p50_latency_ms: 812,
            p95_latency_ms: 1400,
          },
        ],
        truncated: false,
      });
      return;
    }

    if (!url.pathname.endsWith("/chat/completions")) {
      json(res, 404, { error: { message: `no route for ${url.pathname}`, type: "validation", code: 404 } });
      return;
    }

    if (exhausted) {
      const meter = quota === "requests" ? "requests" : "spend";
      json(
        res,
        402,
        {
          error: {
            message:
              meter === "spend"
                ? "monthly allowance exhausted ($10.00 of $10.00 of model spend). Add a top-up or upgrade the plan, or wait for the period to reset."
                : "monthly allowance exhausted (100,000 of 100,000 requests). Upgrade the plan or wait for the period to reset.",
            type: "quota",
            code: 402,
            request_id: BASE_RECEIPT.request_id,
          },
        },
        {
          "x-lobstack-request-id": BASE_RECEIPT.request_id,
          "retry-after": "1976400",
          ...quotaHeaders(),
        },
      );
      return;
    }

    const body = await readJson(req);

    if (!body?.stream) {
      json(
        res,
        200,
        {
          id: `chatcmpl-${BASE_RECEIPT.request_id}`,
          object: "chat.completion",
          created: 1789000000,
          model: BASE_RECEIPT.served_model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: TEXT_DELTAS.join("") },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 400, completion_tokens: 140, total_tokens: 540 },
        },
        { ...routingHeaders(), ...costHeaders() },
      );
      return;
    }

    // ── The stream ──────────────────────────────────────────────────────────
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      ...TEXT_DELTAS.map((content) => ({
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })),
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        choices: [],
        usage: { prompt_tokens: 400, completion_tokens: 140, total_tokens: 540 },
        ...(receiptFor(receipt) === null ? {} : { x_lobstack: receiptFor(receipt) }),
      },
    ].map((frame) => ({
      id: `chatcmpl-${BASE_RECEIPT.request_id}`,
      object: "chat.completion.chunk",
      created: 1789000000,
      model: BASE_RECEIPT.served_model,
      ...frame,
    }));

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      // Routing and quota headers only. The cost headers CANNOT exist here: the
      // provider has not counted a token when these are flushed.
      ...routingHeaders(),
    });

    const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
    const at = Math.floor(text.length * cut);
    res.write(text.slice(0, at));
    await new Promise((r) => setTimeout(r, delayMs));
    res.write(text.slice(at));
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        baseUrl: `http://127.0.0.1:${address.port}/api/gateway/v1`,
        port: address.port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

// Standalone, for driving by hand.
if (process.argv[1] && process.argv[1].endsWith("fake-gateway.mjs")) {
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const gateway = await startFakeGateway({
    port: Number(flag("port", 0)),
    receipt: flag("receipt", "named"),
    quota: flag("quota", "spend"),
    exhausted: process.argv.includes("--exhausted"),
  });
  process.stdout.write(`${gateway.baseUrl}\n`);
}
