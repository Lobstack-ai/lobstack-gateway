/**
 * The spec checked against itself, and against the bytes.
 *
 * `npm run spec` proves both documents are well-formed. These tests prove
 * something the validators cannot: that the two documents agree with each
 * other, and that a receipt coming off the wire validates against the schema a
 * third party would implement from.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

import { LobstackGateway } from "../dist/index.js";
import { startFakeGateway } from "./fake-gateway.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "spec", "x_lobstack.schema.json"), "utf8"));
const openapi = parseYaml(readFileSync(join(root, "spec", "openapi.yaml"), "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addKeyword({ keyword: "x-header", schemaType: "string", valid: true });
const validateReceipt = ajv.compile(schema);

test("every header the schema names is declared in the OpenAPI response", () => {
  // The schema says which `x-lobstack-*` header carries each member on the
  // buffered path. If the two documents disagree, an implementer reading one
  // builds something the other does not describe.
  const declared = openapi.paths["/chat/completions"].post.responses["200"].headers;

  const named = Object.entries(schema.properties)
    .map(([member, spec]) => [member, spec["x-header"]])
    .filter(([, header]) => Boolean(header));

  assert.ok(named.length >= 7, "most receipt members should name their header equivalent");

  for (const [member, header] of named) {
    assert.ok(
      Object.hasOwn(declared, header),
      `${member} names ${header}, which the OpenAPI 200 response does not declare`,
    );
  }
});

test("the OpenAPI lists no baseline header the schema does not know", () => {
  const declared = Object.keys(openapi.paths["/chat/completions"].post.responses["200"].headers);
  const knownHeaders = new Set(
    Object.values(schema.properties)
      .map((spec) => spec["x-header"])
      .filter(Boolean),
  );

  for (const header of declared.filter((h) => h.startsWith("x-lobstack-baseline"))) {
    assert.ok(knownHeaders.has(header), `${header} is declared but no schema member claims it`);
  }
});

test("the SSE transcript in the OpenAPI carries a receipt that validates", () => {
  const description =
    openapi.paths["/chat/completions"].post.responses["200"].content["text/event-stream"].schema
      .description;

  const frames = [...description.matchAll(/^\s*data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]));
  assert.ok(frames.length >= 5, "the transcript should show the whole sequence");

  const finishAt = frames.findIndex((f) => f.choices?.[0]?.finish_reason);
  const receiptAt = frames.findIndex((f) => f.x_lobstack);
  assert.ok(finishAt !== -1 && receiptAt !== -1);
  assert.ok(
    receiptAt > finishAt,
    "the documented transcript must show the receipt arriving after finish_reason",
  );
  assert.equal(frames[receiptAt].choices.length, 0, "the receipt frame has an empty choices array");

  assert.ok(
    validateReceipt(frames[receiptAt].x_lobstack),
    `the documented receipt does not validate: ${ajv.errorsText(validateReceipt.errors)}`,
  );
});

test("the receipt the SDK reads off the wire validates against the published schema", async () => {
  for (const kind of ["named", "plan_ceiling", "unpriced"]) {
    const gateway = await startFakeGateway({ receipt: kind });
    try {
      const client = new LobstackGateway({
        apiKey: `lsk_test_${"a".repeat(8)}${"b".repeat(48)}`,
        baseUrl: gateway.baseUrl,
        onWarning: () => {},
      });

      let raw = null;
      await client.streamChat(
        { messages: [{ role: "user", content: "hi" }] },
        {
          onEvent: (event) => {
            if (event.type === "usage") raw = event.chunk.x_lobstack;
          },
        },
      );

      assert.ok(raw, `no receipt frame for ${kind}`);
      assert.ok(
        validateReceipt(raw),
        `the ${kind} receipt off the wire does not validate: ${ajv.errorsText(validateReceipt.errors)}`,
      );
    } finally {
      await gateway.close();
    }
  }
});

test("the spec's default server is the www host, never the apex", () => {
  const server = openapi.servers[0].url;
  assert.equal(server, "https://www.lobstack.ai/api/gateway/v1");
  assert.match(openapi.info.description, /RFC 9110/);
  assert.match(openapi.info.description, /MUST NOT follow a redirect/);
});

test("the usage path declares its own server, because it is not under the Gateway base", () => {
  const usageServers = openapi.paths["/usage"].servers;
  assert.ok(Array.isArray(usageServers) && usageServers.length === 1);
  assert.equal(usageServers[0].url, "https://www.lobstack.ai/api/v1");
});
