# @lobstack/gateway

A typed client for the Lobstack Gateway, and the published contract it speaks.

The Gateway is an OpenAI-compatible chat completions endpoint in front of many
model providers. What makes it worth a client library is not the routing — it is
the **receipt**: every request comes back with what served it, what it cost, and
what any reported saving was measured against.

A receipt nobody can validate is a quirk. A receipt with a published schema is a
contract, so this repository ships both halves:

| | |
| --- | --- |
| `src/` | the SDK — what you install to call the Gateway and read the receipt |
| `spec/openapi.yaml` | the endpoints, their headers and their error classes (OpenAPI 3.1) |
| `spec/x_lobstack.schema.json` | the receipt itself (JSON Schema 2020-12) |

## What this repo is not

It is **not the Gateway**. The serving stack — the router, the complexity
scorer, tier selection, the metering ledger — is not here and is not described
here. The spec describes what the Gateway *promises a caller*, which is a
different and smaller thing than how it keeps the promise. A client MUST treat
the served model as an output, never as something it can predict.

There are no benchmarks, latency figures, uptime numbers or savings percentages
anywhere in this repository. The metering is new and has not priced production
traffic yet, so any number of that kind would be made up.

## 60-second quickstart

```bash
npm install @lobstack/gateway
export LOBSTACK_API_KEY=lsk_live_…   # mint one in the Console; needs the `inference` scope
```

```ts
import { LobstackGateway, describeSavings, formatCostUsd } from "@lobstack/gateway";

const lobstack = new LobstackGateway(); // base URL and key have sane defaults

const { text, usage, receipt } = await lobstack.streamChat(
  { model: "auto", messages: [{ role: "user", content: "Why did the deploy roll back?" }] },
  { onText: (delta) => process.stdout.write(delta) },
);

console.log(`\nserved ${receipt.servedModel} · ${usage?.total_tokens} tokens`);

// null means UNPRICED, not free. formatCostUsd prints "unpriced".
console.log(`cost ${formatCostUsd(receipt.costUsd)}`);

// A saving is only ever shown with what it was measured against.
const saving = describeSavings(receipt);
if (saving) console.log(`${saving.label} ${formatCostUsd(saving.amountUsd)} — ${saving.comparedTo}`);
```

Buffered instead of streamed:

```ts
const { completion, receipt } = await lobstack.chat({
  model: "claude-sonnet-5",
  max_tokens: 512,
  messages: [{ role: "user", content: "Summarise this changelog in one line." }],
});
```

Also on the client: `models()`, `routePreview()` (public, unauthenticated, costs
nothing), `usage()`, and `stream()` for the raw typed event stream.

Runnable versions of both, plus the same thing implemented in forty lines of
plain `fetch`, are in [`examples/`](examples).

## The four things that are easy to get wrong

Each of these is normative in the spec, enforced by the SDK, and covered by a
test. Each has cost somebody real money.

### 1. `www`, never the apex

The base URL is `https://www.lobstack.ai/api/gateway/v1`.

`https://lobstack.ai` answers with a `307` to the `www` host, and RFC 9110 §15.4
requires a client to drop `Authorization` when a redirect changes host. The
Gateway then sees a request with no credential at all, cannot tell it apart from
one that never had a credential, and answers a perfectly valid key with
`401 missing credentials` — an error that names the wrong thing and sends you to
look at a key that is fine.

This SDK sends `redirect: "manual"` on every request and throws
`CrossHostRedirectError` rather than following one, and it rewrites the apex to
`www` out loud through `onWarning` instead of silently, because a silent fix
teaches you nothing about why your own code will fail the same way tomorrow.

### 2. The receipt arrives *after* `finish_reason`

On a streamed response the order is: role chunk, content deltas, a chunk with
`finish_reason`, then a chunk with an **empty `choices` array** carrying `usage`
and `x_lobstack`, then `data: [DONE]`.

That last data frame is the only place a streamed response reports a price,
because the response headers were flushed before the provider had counted a
token. A reader that breaks on `finish_reason` — the obvious thing to write —
silently discards it. `streamChat()` reads to the end; `stream()` will hand you
a `{ type: "usage" }` event if you iterate that far.

You do not need `stream_options.include_usage`. The Gateway does not read it and
sends the frame regardless.

### 3. `cost_usd: null` means unpriced, not free

Null means the Gateway could not price the request — the served model is not in
the registry, or the request was never metered. It does not mean zero.

Every money field in this SDK is `number | null` and nothing defaults it. There
is no `costUsd ?? 0` anywhere, `formatCostUsd(null)` returns `"unpriced"`, and
`requirePriced(receipt)` throws with the reason if you genuinely need a number.
On the buffered path the Gateway transports the same fact as an **empty header
value**, and `Number("")` is `0` — so the SDK's header parser tests for the
empty string first. A real charge rendered as `$0.00` is the most expensive way
to be wrong here, and it happened for three months.

Do not price the tokens yourself against a local copy of the rate card either. A
local copy drifts, and a model it has never heard of prices at zero.

### 4. A plan-ceiling comparison is not a like-for-like saving

`savings_usd` is a subtraction, and `baseline_reason` says which of two very
different claims is being made:

- **`named`** — you asked for `baseline_model` and something cheaper served it.
  Like-for-like, against your own request. A measurement.
- **`plan_ceiling`** — you sent `auto`. `baseline_model` is the priciest model
  your plan allows: what you would have paid had you asked for the best one.
  A real subtraction, the most flattering one available to us, and one you never
  asked for.
- **`null`** — no honest comparison, so nothing is reported.

`describeSavings()` returns a label, the sentence naming what the figure was
measured against, and a `caveat` that is non-null only for `plan_ceiling`. It
will not give the two cases the same words. Render the reason next to the
figure, or do not render the figure.

## Using the spec without the SDK

```bash
# validate both documents
npm run spec

# a single self-contained OpenAPI file, if your tooling cannot follow an external $ref
npx redocly bundle spec/openapi.yaml -o openapi.bundled.json
```

`spec/openapi.yaml` references `spec/x_lobstack.schema.json` rather than copying
it, so there is exactly one definition of the receipt. Every member of that
schema carries an `x-header` extension naming the response header that carries
the same fact on the buffered path — that mapping is checked against the OpenAPI
document by a test, so the two files cannot drift apart quietly.

Validators, and what they say:

- **`redocly lint`** (recommended ruleset) on `spec/openapi.yaml` — clean, no
  warnings. Two rules are disabled in `redocly.yaml`, each with its reason
  written there.
- **`@seriousme/openapi-schema-validator`** on the bundled document — valid
  OpenAPI 3.1 against the official meta-schema.
- **`ajv`** in strict mode on `spec/x_lobstack.schema.json` — compiles as JSON
  Schema 2020-12, and validates twelve fixtures in
  `test/fixtures/receipts/`: six that must pass and six that must **fail**. The
  failing half is the point — a schema that accepts
  `{"priced": false, "cost_usd": 0}` has not encoded the rule that matters.

## Zero runtime dependencies

`package.json` has no `dependencies`, only `devDependencies`. `fetch`,
`ReadableStream` and `TextDecoder` are all in the runtime, and the SSE reader is
about forty lines. The sibling CLI is zero-dependency on the stated principle
that there should be no supply chain between a user's key and us; a package
whose whole job is to hold an `lsk_live_` credential and read a number does not
get to pull a dependency tree to do it.

Node 20 or newer. ESM only, with types.

## Development

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck
npm run spec        # validate the OpenAPI and the JSON Schema
npm test            # build, then node --test against a fake gateway over real HTTP
npm run verify      # all of the above, and what CI runs
```

The tests run against `test/fake-gateway.mjs`, a real `node:http` server. It
writes each stream in two pieces with the cut landing **inside** a JSON frame,
because a fixture that always writes whole frames never exercises the buffer
that keeps a client from dropping tokens or the receipt. It sends an unpriced
cost as a genuinely empty header, and it serves the 402 with the quota headers
of whichever meter is being exercised.

## Related

- Published Gateway documentation: <https://www.lobstack.ai/docs/gateway>
- The Gateway is OpenAI-compatible, so the official OpenAI SDKs work against it
  by changing the base URL and the key. That path is supported and documented;
  what it will not give you is the receipt as a typed value, because a wrapper
  that returns only the parsed body drops the headers.
- `lobstack`, the CLI, is published separately.

## License

MIT
