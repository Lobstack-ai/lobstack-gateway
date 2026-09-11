/**
 * Validate the receipt JSON Schema, and validate fixtures against it.
 *
 * Two things are checked, because a schema that compiles is not the same as a
 * schema that says what it means:
 *
 *   1. the schema itself is a valid JSON Schema 2020-12 document (Ajv compiles
 *      it in strict mode, which rejects unknown keywords and ignored formats);
 *   2. every fixture under test/fixtures/receipts/ validates or fails to
 *      validate as its filename says — `*.valid.json` must pass and
 *      `*.invalid.json` must fail, with the failure reported.
 *
 * The invalid fixtures are the important half. A schema that accepts
 * `{"priced": false, "cost_usd": 0}` has not encoded the rule that matters.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "spec", "x_lobstack.schema.json");
const fixturesDir = join(root, "test", "fixtures", "receipts");

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);

// Vendor extensions carry the header spelling for each member. They are data for
// implementers, not JSON Schema keywords, so Ajv is told about them explicitly
// rather than being run in a laxer mode that would hide a real typo.
ajv.addKeyword({ keyword: "x-header", schemaType: "string", valid: true });

const schema = read(schemaPath);
let validate;
try {
  validate = ajv.compile(schema);
} catch (e) {
  console.error(`FAIL  spec/x_lobstack.schema.json does not compile\n      ${e.message}`);
  process.exit(1);
}

console.log(`ok    spec/x_lobstack.schema.json compiles as JSON Schema 2020-12 (ajv ${ajvVersion()}, strict mode)`);

// The schema's own `examples` are part of the published contract too.
let failures = 0;
for (const [i, example] of (schema.examples ?? []).entries()) {
  if (validate(example)) {
    console.log(`ok    schema example #${i + 1} validates`);
  } else {
    failures++;
    console.error(`FAIL  schema example #${i + 1} does not validate\n${format(validate.errors)}`);
  }
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("FAIL  no receipt fixtures found");
  process.exit(1);
}

for (const file of files) {
  const expectValid = file.endsWith(".valid.json");
  if (!expectValid && !file.endsWith(".invalid.json")) {
    console.error(`FAIL  ${file}: name it *.valid.json or *.invalid.json so the expectation is explicit`);
    failures++;
    continue;
  }

  const fixture = read(join(fixturesDir, file));
  const ok = validate(fixture);

  if (ok === expectValid) {
    const why = expectValid ? "validates" : `is rejected: ${first(validate.errors)}`;
    console.log(`ok    ${file} ${why}`);
  } else {
    failures++;
    console.error(
      expectValid
        ? `FAIL  ${file} should validate but does not\n${format(validate.errors)}`
        : `FAIL  ${file} should be rejected but validates — the schema is not encoding the rule this fixture violates`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nJSON Schema OK: ${files.length} fixture(s), ${(schema.examples ?? []).length} inline example(s).`);

function format(errors) {
  return (errors ?? []).map((e) => `      ${e.instancePath || "/"} ${e.message}`).join("\n");
}

function first(errors) {
  const e = (errors ?? [])[0];
  return e ? `${e.instancePath || "/"} ${e.message}` : "(no detail)";
}

function ajvVersion() {
  try {
    return read(join(root, "node_modules", "ajv", "package.json")).version;
  } catch {
    return "unknown";
  }
}
