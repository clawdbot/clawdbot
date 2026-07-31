#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  constants,
  createFixtureDecisionRecord,
  skillRoot,
  validateDecisionRecord,
} from "./charrette-lib.mjs";
import {
  generatedSchemaValidatorMetadata,
  loadGeneratedSchemaValidators,
} from "./generated-schema-validators.mjs";
import {
  canonicalJson,
  decodeUtf8Strict,
  digestJson,
  parseJsonStrict,
  readJsonStrict,
  sha256,
} from "./json-utils.mjs";
import { inventoryTree } from "./tree-integrity.mjs";

function parseArguments(argv) {
  let root = skillRoot;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root" || index + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
    if (root !== skillRoot) {
      throw new Error("Duplicate --root");
    }
    root = argv[++index];
  }
  return resolve(root);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readTextStrict(path) {
  return decodeUtf8Strict(await readFile(path), path);
}

function assertSchemaValid(validator, instance, label) {
  if (!validator(instance)) {
    throw new Error(
      `${label} violates its Draft 2020-12 schema: ${JSON.stringify(validator.errors)}`,
    );
  }
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert(match, "SKILL.md requires YAML frontmatter");
  const result = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    assert(separator > 0, `Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    assert(!Object.hasOwn(result, key), `Duplicate frontmatter key: ${key}`);
    result[key] = value;
  }
  assert(
    canonicalJson(Object.keys(result).sort()) === canonicalJson(["description", "name"]),
    "SKILL.md frontmatter must contain only name and description",
  );
  return result;
}

async function jsonFiles(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        output.push(path);
      }
    }
  }
  await walk(root);
  return output.sort();
}

function checksumText(inventory) {
  return `${inventory.entries
    .filter((entry) => entry.type === "file" && entry.path !== "SHA256SUMS.sha256")
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join("\n")}\n`;
}

const root = parseArguments(process.argv.slice(2));
assert(
  basename(root) === "cyborgclaw-groupthink-charrette",
  "Skill root basename is not canonical",
);
const inventory = await inventoryTree(root);
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "manifest.json",
  "references/GLEN_PROXY_CHARTER.md",
  "references/CHARRETTE_PROTOCOL.md",
  "references/CONTRACT_CONSTANTS.json",
  "references/SESSION_SCHEMA.json",
  "references/FINDINGS_SCHEMA.json",
  "references/DECISION_RECORD_SCHEMA.json",
  "references/FIXTURE_INPUT_DIGESTS.json",
  "references/INSTALLATION.md",
  "references/PROVENANCE.json",
  "scripts/charrette.mjs",
  "scripts/charrette-lib.mjs",
  "scripts/json-utils.mjs",
  "scripts/tree-integrity.mjs",
  "scripts/build-checksums.mjs",
  "scripts/build-schema-validators.mjs",
  "scripts/generated-schema-validators.mjs",
  "scripts/install.mjs",
  "tests/contracts.test.mjs",
  "tests/decisions.test.mjs",
  "tests/adversarial.test.mjs",
  "tests/routing.test.mjs",
  "tests/install.test.mjs",
  "tests/cli.test.mjs",
  "tests/render.test.mjs",
  "tests/schema-validation.test.mjs",
  "assets/fixtures/charrette-cases.json",
  "assets/templates/decision-record.md",
  "SHA256SUMS.sha256",
];
const paths = new Set(inventory.entries.map((entry) => entry.path));
for (const path of required) {
  assert(paths.has(path), `Missing required payload: ${path}`);
}
assert(!paths.has("README.md"), "README.md is not part of the skill contract");

const skillMarkdown = await readTextStrict(join(root, "SKILL.md"));
const frontmatter = parseFrontmatter(skillMarkdown);
assert(frontmatter.name === "cyborgclaw-groupthink-charrette", "Frontmatter name mismatch");
for (const phrase of ["Run a governed", "Use when", "Do not use", "ESCALATE_TO_GLEN"]) {
  assert(frontmatter.description.includes(phrase), `Frontmatter description is missing ${phrase}`);
}
assert(
  skillMarkdown.split("\n").length <= 500,
  "SKILL.md exceeds the progressive-disclosure line budget",
);

const openaiYaml = await readTextStrict(join(root, "agents", "openai.yaml"));
assert(openaiYaml.includes("display_name:"), "agents/openai.yaml lacks display_name");
assert(
  openaiYaml.includes("$cyborgclaw-groupthink-charrette"),
  "Default prompt must invoke the skill by name",
);

for (const path of await jsonFiles(root)) {
  parseJsonStrict(await readTextStrict(path), path);
}
const manifest = await readJsonStrict(join(root, "manifest.json"));
assert(manifest.name === frontmatter.name, "Manifest name mismatch");
assert(manifest.version === constants.skill_version, "Manifest version mismatch");
assert(manifest.status === "production", "Manifest status must be production before deployment");
assert(
  Array.isArray(manifest.runtime_dependencies) && manifest.runtime_dependencies.length === 0,
  "Runtime dependencies must remain empty",
);
assert(
  manifest.execution_model?.kind === "decision_only" &&
    manifest.execution_model?.action_executor === "external_enforcing_mission_runtime_required" &&
    manifest.execution_model?.router_outputs_are_capabilities === false &&
    manifest.execution_model?.recheck_outputs_are_capabilities === false,
  "Manifest must preserve the non-capability execution boundary",
);
assert(
  manifest.fixture_input_contract === "references/FIXTURE_INPUT_DIGESTS.json",
  "Manifest fixture-input contract metadata is missing",
);
assert(
  manifest.schema_validation?.draft === "2020-12" &&
    manifest.schema_validation?.engine === "ajv-8-standalone" &&
    manifest.schema_validation?.artifact === "scripts/generated-schema-validators.mjs" &&
    manifest.schema_validation?.build_command === "node scripts/build-schema-validators.mjs",
  "Manifest standalone schema-validation metadata is incomplete",
);
const schemas = [
  ["session", "SESSION_SCHEMA.json", constants.session_schema_uri],
  ["findings", "FINDINGS_SCHEMA.json", constants.findings_schema_uri],
  ["decision_record", "DECISION_RECORD_SCHEMA.json", constants.decision_record_schema_uri],
];
for (const [key, name, id] of schemas) {
  const path = join(root, "references", name);
  const bytes = await readFile(path);
  const schema = parseJsonStrict(decodeUtf8Strict(bytes, path), path);
  assert(schema.$id === id, `${name} has the wrong $id`);
  assert(schema.additionalProperties === false, `${name} must reject unknown top-level properties`);
  const generatedContract = generatedSchemaValidatorMetadata.schemas[key];
  assert(generatedContract.path === `references/${name}`, `${name} validator path drifted`);
  assert(generatedContract.id === id, `${name} validator $id drifted`);
  assert(generatedContract.sha256 === sha256(bytes), `${name} validator is stale`);
}
assert(
  generatedSchemaValidatorMetadata.draft === "https://json-schema.org/draft/2020-12/schema",
  "Generated validator is not bound to Draft 2020-12",
);
assert(
  generatedSchemaValidatorMetadata.generator.package === "ajv" &&
    /^8\./.test(generatedSchemaValidatorMetadata.generator.version) &&
    generatedSchemaValidatorMetadata.generator.mode === "standalone-esm",
  "Generated validator is not bound to Ajv 8 standalone ESM",
);
const schemaValidators = await loadGeneratedSchemaValidators(root);

const fixture = await readJsonStrict(join(root, "assets", "fixtures", "charrette-cases.json"));
assert(fixture.cases.length === 5, "Fixture bundle must contain exactly five terminal cases");
assertSchemaValid(schemaValidators.session, fixture.draft, "fixture draft session");
assertSchemaValid(schemaValidators.session, fixture.frozen, "fixture frozen session");
const fixtureInputContract = await readJsonStrict(
  join(root, "references", "FIXTURE_INPUT_DIGESTS.json"),
);
assert(
  canonicalJson(Object.keys(fixtureInputContract).sort()) ===
    canonicalJson(["digests", "schema_version"]),
  "Fixture-input digest contract has unexpected fields",
);
assert(
  fixtureInputContract.schema_version === "cyborgclaw.groupthink-charrette.fixture-inputs.v1",
  "Fixture-input digest contract version mismatch",
);
const fixtureInputDigests = fixture.cases.map((item) =>
  digestJson({
    session: item.session,
    findings: item.findings,
    evaluated_at: item.evaluated_at,
  }),
);
assert(
  canonicalJson(fixtureInputContract.digests) === canonicalJson(fixtureInputDigests),
  "Fixture-input digest contract drifted from the shipped cases",
);
assert(
  new Set(fixtureInputContract.digests).size === fixture.cases.length &&
    fixtureInputContract.digests.every((digest) => /^[a-f0-9]{64}$/.test(digest)),
  "Fixture-input digest contract must contain one unique SHA-256 per case",
);
const outcomes = new Set();
for (const item of fixture.cases) {
  assertSchemaValid(schemaValidators.session, item.session, `${item.id} session`);
  assertSchemaValid(schemaValidators.findings, item.findings, `${item.id} findings`);
  const record = createFixtureDecisionRecord(item.session, item.findings, item.evaluated_at);
  assert(
    record.terminal_decision === item.expected,
    `${item.id} does not reproduce ${item.expected}`,
  );
  validateDecisionRecord(record);
  assertSchemaValid(schemaValidators.decision_record, record, `${item.id} decision record`);
  const example = await readJsonStrict(join(root, "assets", "examples", `${item.id}.json`));
  assertSchemaValid(
    schemaValidators.decision_record,
    example,
    `${item.id} decision-record example`,
  );
  assert(
    canonicalJson(record) === canonicalJson(example),
    `${item.id} example drifted from the executable fixture`,
  );
  outcomes.add(record.terminal_decision);
}
assert(
  canonicalJson([...outcomes].sort()) === canonicalJson([...constants.terminal_decisions].sort()),
  "Examples do not cover every terminal decision",
);

for (const entry of inventory.entries.filter(
  (candidate) => candidate.type === "file" && candidate.path.endsWith(".mjs"),
)) {
  const check = spawnSync(process.execPath, ["--check", join(root, ...entry.path.split("/"))], {
    encoding: "utf8",
  });
  assert(check.status === 0, `${entry.path} failed node --check: ${check.stderr}`);
  const source = await readTextStrict(join(root, ...entry.path.split("/")));
  for (const specifier of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)) {
    const buildDependency =
      entry.path === "scripts/build-schema-validators.mjs" &&
      ["ajv/dist/2020.js", "ajv/dist/standalone/index.js"].includes(specifier[1]);
    assert(
      specifier[1].startsWith("node:") || specifier[1].startsWith(".") || buildDependency,
      `${entry.path} imports non-bundled runtime dependency ${specifier[1]}`,
    );
  }
  for (const specifier of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const buildDependency =
      entry.path === "scripts/build-schema-validators.mjs" && specifier[1] === "ajv/package.json";
    assert(buildDependency, `${entry.path} requires runtime dependency ${specifier[1]}`);
  }
}

for (const entry of inventory.entries.filter((candidate) => candidate.type === "file")) {
  const bytes = await readFile(join(root, ...entry.path.split("/")));
  const source = decodeUtf8Strict(bytes, entry.path);
  assert(!/\/home\/[^/\s"']+\/\.codex\//.test(source), `${entry.path} embeds a local Codex path`);
  assert(
    !/(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/.test(
      source,
    ),
    `${entry.path} contains a credential-like value`,
  );
}

const checksums = await readTextStrict(join(root, "SHA256SUMS.sha256"));
assert(checksums === checksumText(inventory), "SHA256SUMS.sha256 is stale");

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      skill: manifest.name,
      version: manifest.version,
      inventory_digest: inventory.digest,
      entries: inventory.entry_count,
      examples: fixture.cases.length,
    },
    null,
    2,
  )}\n`,
);
