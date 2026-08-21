import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { isRecord } from "./lib/record-shared.mjs";

export const RELEASE_PLAN_SCHEMA = "openclaw.release-plan.v1";
export const RELEASE_PLAN_LOCK_SCHEMA = "openclaw.release-plan-lock.v1";
export const RELEASE_PLAN_CANONICALIZATION = "ascii-sorted-compact-json-trailing-newline-v1";
export const RELEASE_PLAN_MAX_BYTES = 32 * 1024;

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const PURPOSES = new Set([
  "beta-publish",
  "stable-publish",
  "postpublish-confidence",
  "main-qualification",
]);
const PROFILES = new Set(["beta", "stable", "full"]);
const PACKAGE_TARGETS = new Set(["clawhub", "npm"]);
const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).toSorted(compareAscii);
  const expected = [...keys].toSorted(compareAscii);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

function asciiString(value, label) {
  if (typeof value !== "string" || !ASCII_PATTERN.test(value)) {
    fail(`${label} must be a non-empty printable ASCII string`);
  }
  return value;
}

function sha(value, label) {
  const normalized = asciiString(value, label);
  if (!SHA_PATTERN.test(normalized)) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return normalized;
}

function sortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  const result = value.map((entry, index) => asciiString(entry, `${label}[${index}]`));
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => index > 0 && result[index - 1] >= entry)
  ) {
    fail(`${label} must contain unique strings in ascending ASCII order`);
  }
  return result;
}

function sortedUniqueEnumStrings(value, allowed, label) {
  const result = sortedUniqueStrings(value, label);
  const unsupported = result.find((entry) => !allowed.has(entry));
  if (unsupported) {
    fail(`${label} contains unsupported value: ${unsupported}`);
  }
  return result;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted(compareAscii)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalAsciiJson(value) {
  const json = `${JSON.stringify(canonicalize(value))}\n`;
  if (!/^[\x20-\x7e]+\n$/u.test(json)) {
    fail("canonical JSON must be printable ASCII with exactly one trailing newline");
  }
  return json;
}

function validatePackages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("release plan packages must be a non-empty array");
  }
  const packages = value.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(`release plan packages[${index}] must be an object`);
    }
    exactKeys(entry, ["name", "version", "targets"], `release plan packages[${index}]`);
    return {
      name: asciiString(entry.name, `release plan packages[${index}].name`),
      version: asciiString(entry.version, `release plan packages[${index}].version`),
      targets: sortedUniqueEnumStrings(
        entry.targets,
        PACKAGE_TARGETS,
        `release plan packages[${index}].targets`,
      ),
    };
  });
  const names = packages.map((entry) => entry.name);
  if (
    new Set(names).size !== names.length ||
    names.some((entry, index) => index > 0 && names[index - 1] >= entry)
  ) {
    fail("release plan packages must have unique names in ascending ASCII order");
  }
  return packages;
}

function validatePlatforms(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("release plan platforms must be a non-empty array");
  }
  const platforms = value.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(`release plan platforms[${index}] must be an object`);
    }
    exactKeys(entry, ["id", "source"], `release plan platforms[${index}]`);
    return {
      id: asciiString(entry.id, `release plan platforms[${index}].id`),
      source: asciiString(entry.source, `release plan platforms[${index}].source`),
    };
  });
  const ids = platforms.map((entry) => entry.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((entry, index) => index > 0 && ids[index - 1] >= entry)
  ) {
    fail("release plan platforms must have unique ids in ascending ASCII order");
  }
  return platforms;
}

export function validateReleasePlan(value) {
  if (!isRecord(value)) {
    fail("release plan must be an object");
  }
  exactKeys(
    value,
    [
      "schema",
      "release_id",
      "version",
      "tag",
      "candidate_sha",
      "target_context_ref",
      "purpose",
      "tooling",
      "validation",
      "inventory",
    ],
    "release plan",
  );
  if (value.schema !== RELEASE_PLAN_SCHEMA) {
    fail(`release plan schema must be ${RELEASE_PLAN_SCHEMA}`);
  }
  const purpose = asciiString(value.purpose, "release plan purpose");
  if (!PURPOSES.has(purpose)) {
    fail(`unsupported release plan purpose: ${purpose}`);
  }
  const version = asciiString(value.version, "release plan version");
  const releaseId = asciiString(value.release_id, "release plan release_id");
  if (releaseId !== version) {
    fail("release plan release_id must equal version");
  }
  const tag = value.tag === null ? null : asciiString(value.tag, "release plan tag");
  if (
    (purpose === "beta-publish" ||
      purpose === "stable-publish" ||
      purpose === "postpublish-confidence") &&
    tag !== `v${version}`
  ) {
    fail(`${purpose} release plan tag must equal v<version>`);
  }
  if (purpose === "main-qualification" && tag !== null) {
    fail("main-qualification release plans must not carry a tag");
  }
  const candidateSha = sha(value.candidate_sha, "release plan candidate SHA");
  const targetContextRef = asciiString(value.target_context_ref, "release plan target_context_ref");
  if (targetContextRef !== candidateSha && targetContextRef !== `refs/tags/${tag}`) {
    fail("release plan target_context_ref must bind the candidate SHA or release tag");
  }
  const expectedPolicy = {
    "beta-publish": { profile: "beta", soak: false },
    "stable-publish": { profile: "stable", soak: true },
    "postpublish-confidence": { profile: "full", soak: true },
    "main-qualification": { profile: "full", soak: true },
  }[purpose];
  if (!isRecord(value.tooling)) {
    fail("release plan tooling must be an object");
  }
  exactKeys(value.tooling, ["repository", "workflow_path", "ref", "sha"], "release plan tooling");
  const toolingRef = asciiString(value.tooling.ref, "release plan tooling ref");
  if (!/^refs\/(?:heads|tags)\/.+/u.test(toolingRef)) {
    fail("release plan tooling ref must be a qualified branch or tag ref");
  }
  if (!isRecord(value.validation)) {
    fail("release plan validation must be an object");
  }
  exactKeys(value.validation, ["profile", "soak", "allowed_groups"], "release plan validation");
  const profile = asciiString(value.validation.profile, "release plan validation profile");
  if (!PROFILES.has(profile)) {
    fail(`unsupported release plan validation profile: ${profile}`);
  }
  if (typeof value.validation.soak !== "boolean") {
    fail("release plan validation soak must be boolean");
  }
  if (profile !== expectedPolicy.profile || value.validation.soak !== expectedPolicy.soak) {
    fail(`release plan ${purpose} validation policy is invalid`);
  }
  if (!isRecord(value.inventory)) {
    fail("release plan inventory must be an object");
  }
  exactKeys(value.inventory, ["packages", "platforms"], "release plan inventory");
  const plan = {
    schema: RELEASE_PLAN_SCHEMA,
    release_id: releaseId,
    version,
    tag,
    candidate_sha: candidateSha,
    target_context_ref: targetContextRef,
    purpose,
    tooling: {
      repository: asciiString(value.tooling.repository, "release plan tooling repository"),
      workflow_path: asciiString(value.tooling.workflow_path, "release plan tooling workflow_path"),
      ref: toolingRef,
      sha: sha(value.tooling.sha, "release plan tooling SHA"),
    },
    validation: {
      profile,
      soak: value.validation.soak,
      allowed_groups: sortedUniqueStrings(
        value.validation.allowed_groups,
        "release plan validation allowed_groups",
      ),
    },
    inventory: {
      packages: validatePackages(value.inventory.packages),
      platforms: validatePlatforms(value.inventory.platforms),
    },
  };
  if (plan.tooling.repository !== REPOSITORY) {
    fail(`release plan tooling repository must be ${REPOSITORY}`);
  }
  if (plan.tooling.workflow_path !== WORKFLOW_PATH) {
    fail(`release plan tooling workflow_path must be ${WORKFLOW_PATH}`);
  }
  if (Buffer.byteLength(canonicalAsciiJson(plan), "ascii") > RELEASE_PLAN_MAX_BYTES) {
    fail(`release plan exceeds ${RELEASE_PLAN_MAX_BYTES} bytes`);
  }
  return plan;
}

export function canonicalReleasePlanJson(value) {
  return canonicalAsciiJson(validateReleasePlan(value));
}

export function releasePlanDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalReleasePlanJson(value), "ascii").digest("hex")}`;
}

export function createReleasePlanLock(value) {
  const plan = validateReleasePlan(value);
  return {
    schema: RELEASE_PLAN_LOCK_SCHEMA,
    digest: releasePlanDigest(plan),
    plan,
  };
}

export function validateReleasePlanDigest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("release plan digest must be sha256:<64 lowercase hex characters>");
  }
  return value;
}

export function validateReleasePlanLock(value) {
  if (!isRecord(value)) {
    fail("release plan lock must be an object");
  }
  exactKeys(value, ["schema", "digest", "plan"], "release plan lock");
  if (value.schema !== RELEASE_PLAN_LOCK_SCHEMA) {
    fail(`release plan lock schema must be ${RELEASE_PLAN_LOCK_SCHEMA}`);
  }
  const plan = validateReleasePlan(value.plan);
  const digest = validateReleasePlanDigest(value.digest);
  if (digest !== releasePlanDigest(plan)) {
    fail("release plan lock digest does not match its canonical plan");
  }
  return { schema: RELEASE_PLAN_LOCK_SCHEMA, digest, plan };
}

export function canonicalReleasePlanLockJson(value) {
  return canonicalAsciiJson(validateReleasePlanLock(value));
}

export function parseReleasePlanLockJson(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > RELEASE_PLAN_MAX_BYTES + 4096) {
    fail("release plan lock JSON is missing or too large");
  }
  const hasNonAscii = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126);
  });
  if (hasNonAscii) {
    fail("release plan lock JSON must contain only ASCII");
  }
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    const duplicate = document.errors.find((error) =>
      error.message.includes("keys must be unique"),
    );
    fail(
      duplicate
        ? "release plan JSON contains a duplicate key"
        : `release plan lock JSON is invalid: ${document.errors[0].message}`,
    );
  }
  return validateReleasePlanLock(JSON.parse(text));
}
