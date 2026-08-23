import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_SCENARIO_FILES = 100;
const MAX_SCENARIO_BYTES = 5 * 1024 * 1024;
const MAX_RUN_SCRIPT_BYTES = 64 * 1024;
const VISIBLE_KINDS = new Set(["message", "edit", "edit-meta", "delete"]);
const VISIBLE_ACTORS = new Set(["user", "bot"]);
const ROOT_ENTRIES = new Set(["run.sh", "config.json", "assertions.json", "assets"]);
const FORBIDDEN_SCENARIO_PATTERNS = [
  [/\bMANTIS_LANE\b/u, "lane identity"],
  [/\bbaseline\b/iu, "baseline-specific branching"],
  [/\bcandidate\b/iu, "candidate-specific branching"],
  [/openclaw-telegram-mantis-lane/iu, "the private lane driver"],
  [/MANTIS_TELEGRAM_BRIDGE/u, "the private bridge"],
  [/OPENCLAW_MANTIS_CREDENTIAL_FILE/u, "the credential file"],
  [/TELEGRAM_(?:BOT_TOKEN|E2E_SUT_BOT_TOKEN)/u, "Telegram credentials"],
  [/OPENAI_API_KEY/u, "provider credentials"],
  [/GITHUB_TOKEN/u, "GitHub credentials"],
  [/providerRequests|botApiRequests/iu, "hidden transport facts"],
  [/--until-provider-requests/iu, "provider-request conditions"],
  [/\bproof_call\b/iu, "the unscoped bridge dispatcher"],
  [/\brequests\b/iu, "provider-request inspection"],
  [/\b(?:proof_)?botapi(?:_|\b)/iu, "Bot API assertions"],
  [/\bproof_requests\b/iu, "provider-request assertions"],
];

export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function fail(message) {
  throw new Error(message);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains unsupported key '${key}'.`);
    }
  }
}

function requireString(value, label, maximum = 1_000) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail(`${label} must contain 1 to ${maximum} characters.`);
  }
  return value;
}

function requireFiniteInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}.`);
  }
  return value;
}

function validateTextMatcher(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  assertOnlyKeys(value, new Set(["contains", "equals", "regex"]), label);
  const variants = ["contains", "equals", "regex"].filter((key) => value[key] !== undefined);
  if (variants.length !== 1) {
    fail(`${label} needs exactly one of contains, equals, or regex.`);
  }
  const key = variants[0];
  requireString(value[key], `${label}.${key}`, 500);
  if (key === "regex") {
    try {
      new RegExp(value.regex, "u");
    } catch (error) {
      fail(`${label}.regex is invalid: ${error.message}`);
    }
  }
  return value;
}

function validateEventMatch(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  assertOnlyKeys(
    value,
    new Set(["kind", "actor", "contentType", "text", "buttonText"]),
    label,
  );
  if (Object.keys(value).length === 0) {
    fail(`${label} must match at least one visible field.`);
  }
  if (value.kind !== undefined && !VISIBLE_KINDS.has(value.kind)) {
    fail(`${label}.kind must be message, edit, edit-meta, or delete.`);
  }
  if (value.actor !== undefined && !VISIBLE_ACTORS.has(value.actor)) {
    fail(`${label}.actor must be user or bot.`);
  }
  if (value.contentType !== undefined) {
    requireString(value.contentType, `${label}.contentType`, 200);
  }
  if (value.text !== undefined) {
    validateTextMatcher(value.text, `${label}.text`);
  }
  if (value.buttonText !== undefined) {
    validateTextMatcher(value.buttonText, `${label}.buttonText`);
  }
  return value;
}

function validateAssertion(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  if (value.type === "count") {
    assertOnlyKeys(value, new Set(["type", "match", "equals", "min", "max"]), label);
    validateEventMatch(value.match, `${label}.match`);
    const bounds = ["equals", "min", "max"].filter((key) => value[key] !== undefined);
    if (bounds.length === 0 || (value.equals !== undefined && bounds.length !== 1)) {
      fail(`${label} needs equals, or one/both of min and max.`);
    }
    for (const key of bounds) {
      requireFiniteInteger(value[key], `${label}.${key}`);
    }
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      fail(`${label}.min cannot exceed max.`);
    }
    return value;
  }
  if (value.type === "sequence") {
    assertOnlyKeys(value, new Set(["type", "steps"]), label);
    if (!Array.isArray(value.steps) || value.steps.length < 2 || value.steps.length > 20) {
      fail(`${label}.steps must contain 2 to 20 visible matches.`);
    }
    value.steps.forEach((step, index) => validateEventMatch(step, `${label}.steps[${index}]`));
    return value;
  }
  if (value.type === "gap") {
    assertOnlyKeys(value, new Set(["type", "from", "to", "minMs", "maxMs"]), label);
    validateEventMatch(value.from, `${label}.from`);
    validateEventMatch(value.to, `${label}.to`);
    if (value.minMs === undefined && value.maxMs === undefined) {
      fail(`${label} needs minMs or maxMs.`);
    }
    if (value.minMs !== undefined) {
      requireFiniteInteger(value.minMs, `${label}.minMs`);
    }
    if (value.maxMs !== undefined) {
      requireFiniteInteger(value.maxMs, `${label}.maxMs`);
    }
    if (value.minMs !== undefined && value.maxMs !== undefined && value.minMs > value.maxMs) {
      fail(`${label}.minMs cannot exceed maxMs.`);
    }
    return value;
  }
  fail(`${label}.type must be count, sequence, or gap.`);
}

function validateLaneContract(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  assertOnlyKeys(value, new Set(["description", "expect"]), label);
  requireString(value.description, `${label}.description`, 500);
  if (!Array.isArray(value.expect) || value.expect.length < 1 || value.expect.length > 20) {
    fail(`${label}.expect must contain 1 to 20 assertions.`);
  }
  value.expect.forEach((assertion, index) => validateAssertion(assertion, `${label}.expect[${index}]`));
  return value;
}

export function validateAssertions(value) {
  if (!isRecord(value)) {
    fail("assertions.json must be an object.");
  }
  assertOnlyKeys(value, new Set(["schemaVersion", "name", "baseline", "candidate"]), "assertions.json");
  if (value.schemaVersion !== 1) {
    fail("assertions.json schemaVersion must be 1.");
  }
  requireString(value.name, "assertions.json.name", 200);
  validateLaneContract(value.baseline, "assertions.json.baseline");
  validateLaneContract(value.candidate, "assertions.json.candidate");
  if (stableStringify(value.baseline.expect) === stableStringify(value.candidate.expect)) {
    fail("Baseline and candidate visible expectations must differ.");
  }
  return value;
}

function validateConfig(value) {
  if (!isRecord(value)) {
    fail("config.json must be an object.");
  }
  assertOnlyKeys(value, new Set(["configPatch", "mockResponse", "mockResponseChunkDelayMs"]), "config.json");
  requireString(value.mockResponse, "config.json.mockResponse", 100_000);
  if (value.configPatch !== undefined && !isRecord(value.configPatch)) {
    fail("config.json.configPatch must be an object.");
  }
  if (value.mockResponseChunkDelayMs !== undefined) {
    requireFiniteInteger(value.mockResponseChunkDelayMs, "config.json.mockResponseChunkDelayMs", 1);
    if (value.mockResponseChunkDelayMs > 15 * 60_000) {
      fail("config.json.mockResponseChunkDelayMs exceeds 15 minutes.");
    }
  }
  return value;
}

function walkScenarioFiles(root) {
  const files = [];
  let totalBytes = 0;
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (relative.length > 240) {
        fail(`Scenario path is too long: ${relative}`);
      }
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        fail(`Scenario cannot contain symlinks: ${relative}`);
      }
      if (stat.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        fail(`Scenario entries must be single-link regular files: ${relative}`);
      }
      totalBytes += stat.size;
      files.push({ absolute, relative, size: stat.size });
      if (files.length > MAX_SCENARIO_FILES) {
        fail(`Scenario exceeds ${MAX_SCENARIO_FILES} files.`);
      }
      if (totalBytes > MAX_SCENARIO_BYTES) {
        fail(`Scenario exceeds ${MAX_SCENARIO_BYTES} bytes.`);
      }
    }
  };
  visit(root);
  return files.toSorted((left, right) => left.relative.localeCompare(right.relative));
}

function validateRootEntries(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ROOT_ENTRIES.has(entry.name)) {
      fail(`Unsupported scenario root entry: ${entry.name}`);
    }
    if (entry.name === "assets" && !entry.isDirectory()) {
      fail("Scenario assets must be a directory.");
    }
  }
}

function validateRunScript(source, file) {
  if (Buffer.byteLength(source) > MAX_RUN_SCRIPT_BYTES) {
    fail(`run.sh exceeds ${MAX_RUN_SCRIPT_BYTES} bytes.`);
  }
  if (!source.startsWith("#!/usr/bin/env bash\n")) {
    fail("run.sh must start with '#!/usr/bin/env bash'.");
  }
  for (const [pattern, label] of FORBIDDEN_SCENARIO_PATTERNS) {
    if (pattern.test(source)) {
      fail(`run.sh may not access ${label}.`);
    }
  }
  if (!/set\s+-[^\n]*e[^\n]*u[^\n]*o\s+pipefail/u.test(source)) {
    fail("run.sh must enable errexit, nounset, and pipefail.");
  }
  if (!/source\s+"?\$\{?MANTIS_SCENARIO_HELPER\}?"?/u.test(source)) {
    fail("run.sh must source MANTIS_SCENARIO_HELPER.");
  }
  if (!/trap\s+proof_abort\s+EXIT/u.test(source)) {
    fail("run.sh must install 'trap proof_abort EXIT'.");
  }
  if (!/\bproof_finish\b/u.test(source)) {
    fail("run.sh must call proof_finish.");
  }
  if (!/trap\s+-\s+EXIT/u.test(source)) {
    fail("run.sh must clear its abort trap after proof_finish.");
  }
  const syntax = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  if (syntax.status !== 0) {
    fail(`run.sh failed bash -n: ${(syntax.stderr || syntax.stdout).trim()}`);
  }
}

export function scenarioDigest(root, files = walkScenarioFiles(root)) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateScenarioDirectory(root) {
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory()) {
    fail("Scenario draft must be a directory.");
  }
  validateRootEntries(resolved);
  const runFile = path.join(resolved, "run.sh");
  const configFile = path.join(resolved, "config.json");
  const assertionsFile = path.join(resolved, "assertions.json");
  for (const required of [runFile, configFile, assertionsFile]) {
    if (!fs.existsSync(required) || !fs.lstatSync(required).isFile()) {
      fail(`Missing required scenario file: ${path.basename(required)}`);
    }
  }
  const files = walkScenarioFiles(resolved);
  validateRunScript(fs.readFileSync(runFile, "utf8"), runFile);
  validateConfig(readJson(configFile));
  const assertions = validateAssertions(readJson(assertionsFile));
  return {
    assertions,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    fileCount: files.length,
    files,
    hash: scenarioDigest(resolved, files),
    root: resolved,
  };
}

function chmodTree(root) {
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o555);
      for (const entry of fs.readdirSync(current)) {
        visit(path.join(current, entry));
      }
    } else {
      fs.chmodSync(current, path.basename(current) === "run.sh" ? 0o555 : 0o444);
    }
  };
  visit(root);
}

export function freezeScenario({ draftDir, frozenDir }) {
  const validated = validateScenarioDirectory(draftDir);
  if (fs.existsSync(frozenDir)) {
    fail(`Frozen scenario path already exists: ${frozenDir}`);
  }
  fs.mkdirSync(path.dirname(frozenDir), { recursive: true });
  fs.cpSync(validated.root, frozenDir, { recursive: true, errorOnExist: true });
  chmodTree(frozenDir);
  const frozen = validateScenarioDirectory(frozenDir);
  if (frozen.hash !== validated.hash) {
    fail("Frozen scenario bytes changed during the copy.");
  }
  return {
    bytes: frozen.bytes,
    fileCount: frozen.fileCount,
    hash: frozen.hash,
    name: frozen.assertions.name,
    path: path.resolve(frozenDir),
    schemaVersion: 1,
  };
}

export function commentText(value, maximum = 1_000) {
  const escaped = String(value ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;");
  return escaped.length > maximum ? `${escaped.slice(0, maximum - 1)}…` : escaped;
}
