/**
 * Validate the OpenAPI document, three ways and for three reasons.
 *
 *   1. `redocly lint` — the Redocly recommended ruleset: the things a
 *      meta-schema cannot catch, such as an example that does not match its
 *      schema, an unused component, or an operation with no description.
 *   2. `redocly bundle` — resolve `./x_lobstack.schema.json` into a single
 *      self-contained document. This is also the artefact a consumer wants when
 *      their tooling cannot follow an external `$ref`.
 *   3. @seriousme/openapi-schema-validator on that bundle — is it a well-formed
 *      OpenAPI 3.1 document according to the official meta-schema.
 *
 * The receipt schema is NOT duplicated into the OpenAPI: `spec/openapi.yaml`
 * points at `spec/x_lobstack.schema.json`, which stays the single definition of
 * the receipt. A spec that does not parse is worse than no spec, so this runs in
 * `npm run verify` and in CI.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@seriousme/openapi-schema-validator";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = "spec/openapi.yaml";
const work = mkdtempSync(join(tmpdir(), "lobstack-spec-"));
const bundlePath = join(work, "openapi.bundled.json");

try {
  run(["redocly", "lint", spec, "--format", "stylish"], "redocly lint reported problems");
  console.log("ok    redocly lint passed (recommended ruleset)");

  run(
    ["redocly", "bundle", spec, "--output", bundlePath, "--ext", "json"],
    "redocly bundle failed — an external $ref does not resolve",
    { quiet: true },
  );
  console.log("ok    bundles to a single self-contained document (./x_lobstack.schema.json resolved)");

  const validator = new Validator();
  const result = await validator.validate(bundlePath);
  if (!result.valid) {
    console.error("FAIL  the bundled document is not valid OpenAPI");
    console.error(JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  console.log(
    `ok    valid OpenAPI ${validator.version} against the official meta-schema ` +
      "(@seriousme/openapi-schema-validator)",
  );

  const doc = await validator.resolveRefs();
  const paths = Object.keys(doc.paths ?? {});
  const operations = paths.flatMap((p) =>
    Object.keys(doc.paths[p]).filter((k) => ["get", "post", "put", "patch", "delete"].includes(k)),
  );
  console.log(`      ${paths.length} paths, ${operations.length} operations: ${paths.join(", ")}`);
  console.log("\nOpenAPI OK.");
} finally {
  rmSync(work, { recursive: true, force: true });
}

function run(args, failureMessage, { quiet = false } = {}) {
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--no-install", ...args], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.error) {
    console.error(`FAIL  could not run ${args[0]}: ${result.error.message}`);
    console.error("      Run `npm install` first — the validators are devDependencies.");
    process.exit(1);
  }

  if (!quiet || result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }

  if (result.status !== 0) {
    console.error(`FAIL  ${failureMessage}`);
    process.exit(1);
  }
}
