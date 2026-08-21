import { createHash } from "node:crypto";
import { isRecord } from "./lib/record-shared.mjs";
import { parseReleaseVersion } from "./lib/release-version.mjs";
import {
  releaseValidationIntentForPurpose,
  resolveReleaseValidationIntent,
} from "./release-validation-intent.mjs";

export const RELEASE_PLAN_SCHEMA = "openclaw.release-plan.v1";
export const RELEASE_PLAN_LOCK_SCHEMA = "openclaw.release-plan-lock.v1";
export const RELEASE_PLAN_CANONICALIZATION = "ascii-sorted-compact-json-trailing-newline-v1";
export const RELEASE_PLAN_MAX_BYTES = 32 * 1024;

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
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

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be sha256:<64 lowercase hex characters>`);
  }
  return value;
}

function sortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  const result = value.map((entry, index) => asciiString(entry, `${label}[${index}]`));
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => index > 0 && compareAscii(result[index - 1], entry) >= 0)
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

function canonicalPath(parent, key) {
  return `${parent}[${JSON.stringify(key)}]`;
}

function canonicalize(value, path = "$", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`canonical JSON number at ${path} must be finite`);
    }
    if (Object.is(value, -0)) {
      fail(`canonical JSON number at ${path} must not be negative zero`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail(`canonical JSON contains unsupported ${typeof value} at ${path}`);
  }
  if (ancestors.has(value)) {
    fail(`canonical JSON must not contain cycles at ${path}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some((key, index) => typeof key !== "string" || key !== String(index))
      ) {
        fail(`canonical JSON array at ${path} must be dense and contain no extra properties`);
      }
      return keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          fail(`canonical JSON array at ${path} must contain enumerable data properties only`);
        }
        return canonicalize(descriptor.value, canonicalPath(path, key), ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`canonical JSON object at ${path} must be plain`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail(`canonical JSON object at ${path} must use string keys only`);
    }
    return Object.fromEntries(
      keys.toSorted(compareAscii).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          fail(`canonical JSON object at ${path} must contain enumerable data properties only`);
        }
        return [key, canonicalize(descriptor.value, canonicalPath(path, key), ancestors)];
      }),
    );
  } finally {
    ancestors.delete(value);
  }
}

function canonicalAsciiJson(value) {
  const json = `${JSON.stringify(canonicalize(value))}\n`;
  if (!/^[\x20-\x7e]+\n$/u.test(json)) {
    fail("canonical JSON must be printable ASCII with exactly one trailing newline");
  }
  return json;
}

function assertNoDuplicateJsonKeys(text) {
  const tokenPattern =
    /"(?:\\(?:["\\/bfnrt]|u[a-fA-F0-9]{4})|[^"\\\u0000-\u001f])*"|[{}\[\],:]|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|\s+/guy;
  const stack = [];
  for (let index = 0; index < text.length;) {
    tokenPattern.lastIndex = index;
    const match = tokenPattern.exec(text);
    if (!match) {
      fail("release plan lock JSON is invalid JSON");
    }
    index = tokenPattern.lastIndex;
    const token = match[0];
    if (/^\s+$/u.test(token)) {
      continue;
    }
    const current = stack.at(-1);
    if (token === "{") {
      stack.push({ keys: new Set(), expectingKey: true });
    } else if (token === "[") {
      stack.push(null);
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token === "," && current !== null && current !== undefined) {
      current.expectingKey = true;
    } else if (token === ":" && current !== null && current !== undefined) {
      current.expectingKey = false;
    } else if (token.startsWith('"') && current?.expectingKey) {
      const key = JSON.parse(token);
      if (current.keys.has(key)) {
        fail("release plan JSON contains a duplicate key");
      }
      current.keys.add(key);
      current.expectingKey = false;
    }
  }
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
    names.some((entry, index) => index > 0 && compareAscii(names[index - 1], entry) >= 0)
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
    ids.some((entry, index) => index > 0 && compareAscii(ids[index - 1], entry) >= 0)
  ) {
    fail("release plan platforms must have unique ids in ascending ASCII order");
  }
  return platforms;
}

function validatePurposeMatrix({ candidateSha, purpose, tag, targetContextRef, version }) {
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null || parsedVersion.version !== version) {
    fail("release plan version must use a supported release version");
  }
  if (purpose === "beta-publish" && parsedVersion.channel === "stable") {
    fail("beta-publish release plan version must be alpha or beta");
  }
  if (purpose === "stable-publish" && parsedVersion.channel !== "stable") {
    fail("stable-publish release plan version must be stable");
  }
  if (purpose === "diagnostic" || purpose === "main-qualification") {
    if (tag !== null || targetContextRef !== candidateSha) {
      fail(`${purpose} release plans require a null tag and candidate SHA context`);
    }
    return;
  }
  const expectedTag = `v${version}`;
  if (tag !== expectedTag || targetContextRef !== `refs/tags/${expectedTag}`) {
    fail(`${purpose} release plans require the exact version tag context`);
  }
}

function validateToolingRoute(purpose, ref, toolingSha) {
  const protectedMatch = /^refs\/tags\/release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u.exec(ref);
  const protectedRoute = protectedMatch?.[1] === toolingSha.slice(0, 12);
  if (purpose === "diagnostic" || purpose === "main-qualification") {
    if (ref !== "refs/heads/main" && !protectedRoute) {
      fail(`${purpose} tooling must use trusted main or a protected release-publish tag`);
    }
    return;
  }
  if (!protectedRoute) {
    fail(`${purpose} tooling must use a protected release-publish tag bound to its SHA`);
  }
}

export function validateReleasePlan(value) {
  canonicalize(value);
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
  const version = asciiString(value.version, "release plan version");
  const releaseId = asciiString(value.release_id, "release plan release_id");
  if (releaseId !== version) {
    fail("release plan release_id must equal version");
  }
  const tag = value.tag === null ? null : asciiString(value.tag, "release plan tag");
  const candidateSha = sha(value.candidate_sha, "release plan candidate SHA");
  const targetContextRef = asciiString(value.target_context_ref, "release plan target_context_ref");
  validatePurposeMatrix({ candidateSha, purpose, tag, targetContextRef, version });

  if (!isRecord(value.tooling)) {
    fail("release plan tooling must be an object");
  }
  exactKeys(value.tooling, ["repository", "workflow_path", "ref", "sha"], "release plan tooling");
  const toolingRef = asciiString(value.tooling.ref, "release plan tooling ref");
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(toolingRef)) {
    fail("release plan tooling ref must be a qualified branch or tag ref");
  }
  if (!isRecord(value.validation)) {
    fail("release plan validation must be an object");
  }
  exactKeys(
    value.validation,
    ["intent", "profile", "soak", "allowed_groups"],
    "release plan validation",
  );
  const intent = asciiString(value.validation.intent, "release plan validation intent");
  releaseValidationIntentForPurpose(purpose, intent);
  const profile = asciiString(value.validation.profile, "release plan validation profile");
  if (typeof value.validation.soak !== "boolean") {
    fail("release plan validation soak must be boolean");
  }
  const validationPolicy = resolveReleaseValidationIntent(intent, {
    profile,
    soak: value.validation.soak,
  });
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
      intent: validationPolicy.intent,
      profile: validationPolicy.profile,
      soak: validationPolicy.soak,
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
  validateToolingRoute(plan.purpose, plan.tooling.ref, plan.tooling.sha);
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

export function validateReleasePlanLock(value) {
  canonicalize(value);
  if (!isRecord(value)) {
    fail("release plan lock must be an object");
  }
  exactKeys(value, ["schema", "digest", "plan"], "release plan lock");
  if (value.schema !== RELEASE_PLAN_LOCK_SCHEMA) {
    fail(`release plan lock schema must be ${RELEASE_PLAN_LOCK_SCHEMA}`);
  }
  const plan = validateReleasePlan(value.plan);
  const planDigest = digest(value.digest, "release plan lock digest");
  if (planDigest !== releasePlanDigest(plan)) {
    fail("release plan lock digest does not match its canonical plan");
  }
  return { schema: RELEASE_PLAN_LOCK_SCHEMA, digest: planDigest, plan };
}

export function canonicalReleasePlanLockJson(value) {
  return canonicalAsciiJson(validateReleasePlanLock(value));
}

export function parseReleasePlanLockJson(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > RELEASE_PLAN_MAX_BYTES + 4096) {
    fail("release plan lock JSON is missing or too large");
  }
  if (!/^[\x20-\x7e]+\n$/u.test(text)) {
    fail("release plan lock JSON must be compact printable ASCII with exactly one trailing LF");
  }
  assertNoDuplicateJsonKeys(text);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("release plan lock JSON is invalid JSON", { cause: error });
  }
  const lock = validateReleasePlanLock(value);
  if (text !== canonicalReleasePlanLockJson(lock)) {
    fail("release plan lock JSON does not use canonical bytes");
  }
  return lock;
}
