import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { isRecord } from "./lib/record-shared.mjs";
import { validateReleasePlanLock } from "./release-plan-contract.mjs";

const RELEASE_PUBLICATION_ELIGIBILITY_SCHEMA = "openclaw.release-publication-eligibility.v1";
export const RELEASE_PUBLICATION_ELIGIBILITY_CANONICALIZATION =
  "ascii-sorted-compact-json-trailing-newline-v1";
export const RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS = 5 * 60_000;
const RELEASE_PUBLICATION_ELIGIBILITY_MAX_BYTES = 512 * 1024;
export const RELEASE_PUBLICATION_ELIGIBILITY_EVIDENCE_SCOPE = "validation-start-only";
export const RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH =
  ".github/workflows/release-publication-eligibility.yml";
export const RELEASE_PUBLICATION_NPM_REGISTRY = "https://registry.npmjs.org";
export const RELEASE_PUBLICATION_CLAWHUB_REGISTRY = "https://clawhub.ai";

const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const PLAN_STATUSES = new Set(["vacant", "already-published"]);
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

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be sha256:<64 lowercase hex characters>`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function decimalId(value, label) {
  if (typeof value !== "string" || !DECIMAL_ID_PATTERN.test(value)) {
    fail(`${label} must be a canonical positive decimal string`);
  }
  return value;
}

function sha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    fail(`${label} must be a canonical UTC ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical UTC ISO timestamp`);
  }
  return { milliseconds: parsed, value };
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

function validateSortedUniquePackages(value, label, validateEntry) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  const packages = value.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(`${label}[${index}] must be an object`);
    }
    return validateEntry(entry, `${label}[${index}]`);
  });
  const identities = packages.map((entry) => `${entry.name}\0${entry.version}`);
  if (
    new Set(identities).size !== identities.length ||
    identities.some((entry, index) => index > 0 && compareAscii(identities[index - 1], entry) >= 0)
  ) {
    fail(`${label} must contain unique packages in ascending ASCII order`);
  }
  return packages;
}

function validateLatestDependencies(value) {
  const label = "publication eligibility observations.latest_dependencies";
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  const dependencies = value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isRecord(entry)) {
      fail(`${entryLabel} must be an object`);
    }
    exactKeys(entry, ["name", "required_version", "observed_version"], entryLabel);
    return {
      name: asciiString(entry.name, `${entryLabel}.name`),
      required_version: asciiString(entry.required_version, `${entryLabel}.required_version`),
      observed_version: asciiString(entry.observed_version, `${entryLabel}.observed_version`),
    };
  });
  const names = dependencies.map((entry) => entry.name);
  if (
    new Set(names).size !== names.length ||
    names.some((entry, index) => index > 0 && compareAscii(names[index - 1], entry) >= 0)
  ) {
    fail(`${label} must contain unique names in ascending ASCII order`);
  }
  return dependencies;
}

function validateNpmObservations(value) {
  return validateSortedUniquePackages(
    value,
    "publication eligibility observations.npm",
    (entry, label) => {
      exactKeys(entry, ["name", "version", "published"], label);
      return {
        name: asciiString(entry.name, `${label}.name`),
        version: asciiString(entry.version, `${label}.version`),
        published: boolean(entry.published, `${label}.published`),
      };
    },
  );
}

function validateClawHubObservations(value) {
  const observations = validateSortedUniquePackages(
    value,
    "publication eligibility observations.clawhub",
    (entry, label) => {
      exactKeys(
        entry,
        ["name", "version", "package_exists", "trusted_publisher", "published"],
        label,
      );
      return {
        name: asciiString(entry.name, `${label}.name`),
        version: asciiString(entry.version, `${label}.version`),
        package_exists: boolean(entry.package_exists, `${label}.package_exists`),
        trusted_publisher: boolean(entry.trusted_publisher, `${label}.trusted_publisher`),
        published: boolean(entry.published, `${label}.published`),
      };
    },
  );
  for (const observation of observations) {
    if (!observation.package_exists) {
      fail(`ClawHub package is not bootstrapped: ${observation.name}@${observation.version}`);
    }
    if (!observation.trusted_publisher) {
      fail(`ClawHub trusted publisher is missing: ${observation.name}@${observation.version}`);
    }
  }
  return observations;
}

function validatePlan(value, label) {
  return validateSortedUniquePackages(value, label, (entry, entryLabel) => {
    exactKeys(entry, ["name", "version", "status"], entryLabel);
    const status = asciiString(entry.status, `${entryLabel}.status`);
    if (!PLAN_STATUSES.has(status)) {
      fail(`${entryLabel}.status must be vacant or already-published`);
    }
    return {
      name: asciiString(entry.name, `${entryLabel}.name`),
      version: asciiString(entry.version, `${entryLabel}.version`),
      status,
    };
  });
}

function packageIdentity(value) {
  return value.map(({ name, version }) => ({ name, version }));
}

function assertSamePackages(actual, expected, label) {
  if (canonicalAsciiJson(actual) !== canonicalAsciiJson(expected)) {
    fail(`${label} does not match its authoritative inventory`);
  }
}

function validateProvenance(value) {
  if (!isRecord(value)) {
    fail("publication eligibility provenance must be an object");
  }
  exactKeys(
    value,
    [
      "repository",
      "workflow_path",
      "workflow_ref",
      "workflow_sha",
      "run_id",
      "run_attempt",
      "job",
      "artifact_id",
      "artifact_digest",
    ],
    "publication eligibility provenance",
  );
  const workflowRef = asciiString(
    value.workflow_ref,
    "publication eligibility provenance.workflow_ref",
  );
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(workflowRef)) {
    fail("publication eligibility provenance.workflow_ref must be a qualified branch or tag ref");
  }
  return {
    repository: asciiString(value.repository, "publication eligibility provenance.repository"),
    workflow_path: asciiString(
      value.workflow_path,
      "publication eligibility provenance.workflow_path",
    ),
    workflow_ref: workflowRef,
    workflow_sha: sha(value.workflow_sha, "publication eligibility provenance.workflow_sha"),
    run_id: decimalId(value.run_id, "publication eligibility provenance.run_id"),
    run_attempt: positiveInteger(
      value.run_attempt,
      "publication eligibility provenance.run_attempt",
    ),
    job: asciiString(value.job, "publication eligibility provenance.job"),
    artifact_id: decimalId(value.artifact_id, "publication eligibility provenance.artifact_id"),
    artifact_digest: digest(
      value.artifact_digest,
      "publication eligibility provenance.artifact_digest",
    ),
  };
}

function validateReceiptBody(value) {
  if (!isRecord(value)) {
    fail("publication eligibility receipt body must be an object");
  }
  exactKeys(
    value,
    [
      "schema",
      "evidence_scope",
      "publication_authorized",
      "release_plan_digest",
      "started_at",
      "completed_at",
      "expires_at",
      "registries",
      "provenance",
      "observations",
      "plans",
    ],
    "publication eligibility receipt body",
  );
  if (value.schema !== RELEASE_PUBLICATION_ELIGIBILITY_SCHEMA) {
    fail(`publication eligibility schema must be ${RELEASE_PUBLICATION_ELIGIBILITY_SCHEMA}`);
  }
  if (value.evidence_scope !== RELEASE_PUBLICATION_ELIGIBILITY_EVIDENCE_SCOPE) {
    fail(
      `publication eligibility evidence_scope must be ${RELEASE_PUBLICATION_ELIGIBILITY_EVIDENCE_SCOPE}`,
    );
  }
  if (value.publication_authorized !== false) {
    fail("publication eligibility receipts never authorize publication");
  }
  const startedAt = timestamp(value.started_at, "publication eligibility started_at");
  const completedAt = timestamp(value.completed_at, "publication eligibility completed_at");
  const expiresAt = timestamp(value.expires_at, "publication eligibility expires_at");
  if (
    completedAt.milliseconds < startedAt.milliseconds ||
    completedAt.milliseconds > expiresAt.milliseconds
  ) {
    fail(
      "publication eligibility timestamps must satisfy started_at <= completed_at <= expires_at",
    );
  }
  if (
    expiresAt.milliseconds - startedAt.milliseconds !==
    RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS
  ) {
    fail("publication eligibility expiry must be exactly five minutes after start");
  }
  if (!isRecord(value.registries)) {
    fail("publication eligibility registries must be an object");
  }
  exactKeys(value.registries, ["clawhub", "npm"], "publication eligibility registries");
  if (value.registries.npm !== RELEASE_PUBLICATION_NPM_REGISTRY) {
    fail(`publication eligibility npm registry must be ${RELEASE_PUBLICATION_NPM_REGISTRY}`);
  }
  if (value.registries.clawhub !== RELEASE_PUBLICATION_CLAWHUB_REGISTRY) {
    fail(
      `publication eligibility ClawHub registry must be ${RELEASE_PUBLICATION_CLAWHUB_REGISTRY}`,
    );
  }
  if (!isRecord(value.observations)) {
    fail("publication eligibility observations must be an object");
  }
  exactKeys(
    value.observations,
    ["latest_dependencies", "npm", "clawhub"],
    "publication eligibility observations",
  );
  const observations = {
    latest_dependencies: validateLatestDependencies(value.observations.latest_dependencies),
    npm: validateNpmObservations(value.observations.npm),
    clawhub: validateClawHubObservations(value.observations.clawhub),
  };
  if (!isRecord(value.plans)) {
    fail("publication eligibility plans must be an object");
  }
  exactKeys(value.plans, ["clawhub", "npm"], "publication eligibility plans");
  const plans = {
    npm: validatePlan(value.plans.npm, "publication eligibility plans.npm"),
    clawhub: validatePlan(value.plans.clawhub, "publication eligibility plans.clawhub"),
  };
  assertSamePackages(
    packageIdentity(plans.npm),
    packageIdentity(observations.npm),
    "npm publication plan",
  );
  assertSamePackages(
    packageIdentity(plans.clawhub),
    packageIdentity(observations.clawhub),
    "ClawHub publication plan",
  );
  for (const [index, plan] of plans.npm.entries()) {
    const expectedStatus = observations.npm[index].published ? "already-published" : "vacant";
    if (plan.status !== expectedStatus) {
      fail(`npm publication status drifted for ${plan.name}@${plan.version}`);
    }
  }
  for (const [index, plan] of plans.clawhub.entries()) {
    const expectedStatus = observations.clawhub[index].published ? "already-published" : "vacant";
    if (plan.status !== expectedStatus) {
      fail(`ClawHub publication status drifted for ${plan.name}@${plan.version}`);
    }
  }
  return {
    schema: RELEASE_PUBLICATION_ELIGIBILITY_SCHEMA,
    evidence_scope: RELEASE_PUBLICATION_ELIGIBILITY_EVIDENCE_SCOPE,
    publication_authorized: false,
    release_plan_digest: digest(
      value.release_plan_digest,
      "publication eligibility release_plan_digest",
    ),
    started_at: startedAt.value,
    completed_at: completedAt.value,
    expires_at: expiresAt.value,
    registries: {
      clawhub: RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
      npm: RELEASE_PUBLICATION_NPM_REGISTRY,
    },
    provenance: validateProvenance(value.provenance),
    observations,
    plans,
  };
}

function receiptBodyDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalAsciiJson(value), "ascii").digest("hex")}`;
}

export function createReleasePublicationEligibilityReceipt(value) {
  const body = validateReceiptBody(value);
  return { ...body, digest: receiptBodyDigest(body) };
}

function validateReleasePublicationEligibilityReceipt(value) {
  if (!isRecord(value)) {
    fail("publication eligibility receipt must be an object");
  }
  exactKeys(
    value,
    [
      "schema",
      "evidence_scope",
      "publication_authorized",
      "release_plan_digest",
      "started_at",
      "completed_at",
      "expires_at",
      "registries",
      "provenance",
      "observations",
      "plans",
      "digest",
    ],
    "publication eligibility receipt",
  );
  const { digest: receiptDigest, ...rawBody } = value;
  const body = validateReceiptBody(rawBody);
  const normalizedDigest = digest(receiptDigest, "publication eligibility receipt digest");
  if (normalizedDigest !== receiptBodyDigest(body)) {
    fail("publication eligibility receipt digest does not match its canonical body");
  }
  return { ...body, digest: normalizedDigest };
}

export function canonicalReleasePublicationEligibilityReceiptJson(value) {
  const receipt = validateReleasePublicationEligibilityReceipt(value);
  const json = canonicalAsciiJson(receipt);
  if (Buffer.byteLength(json, "ascii") > RELEASE_PUBLICATION_ELIGIBILITY_MAX_BYTES) {
    fail(
      `publication eligibility receipt exceeds ${RELEASE_PUBLICATION_ELIGIBILITY_MAX_BYTES} bytes`,
    );
  }
  return json;
}

export function parseReleasePublicationEligibilityReceiptJson(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > RELEASE_PUBLICATION_ELIGIBILITY_MAX_BYTES
  ) {
    fail("publication eligibility receipt JSON is missing or too large");
  }
  if (!/^[\x20-\x7e]+\n$/u.test(text)) {
    fail(
      "publication eligibility receipt JSON must be compact printable ASCII with exactly one trailing LF",
    );
  }
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    const duplicate = document.errors.find((error) =>
      error.message.includes("keys must be unique"),
    );
    fail(
      duplicate
        ? "publication eligibility receipt JSON contains a duplicate key"
        : `publication eligibility receipt JSON is invalid: ${document.errors[0].message}`,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("publication eligibility receipt JSON is invalid JSON", { cause: error });
  }
  const receipt = validateReleasePublicationEligibilityReceipt(value);
  if (text !== canonicalReleasePublicationEligibilityReceiptJson(receipt)) {
    fail("publication eligibility receipt JSON does not use canonical bytes");
  }
  return receipt;
}

export function verifyReleasePublicationEligibilityReceipt(
  value,
  releasePlanLock,
  expectedProvenance,
  nowMs = Date.now(),
) {
  if (!Number.isFinite(nowMs) || !Number.isInteger(nowMs)) {
    fail("publication eligibility verification time must be a finite integer");
  }
  const receipt = validateReleasePublicationEligibilityReceipt(value);
  const lock = validateReleasePlanLock(releasePlanLock);
  if (receipt.release_plan_digest !== lock.digest) {
    fail("publication eligibility receipt is bound to a different ReleasePlan digest");
  }
  const provenance = validateProvenance(expectedProvenance);
  if (canonicalAsciiJson(receipt.provenance) !== canonicalAsciiJson(provenance)) {
    fail("publication eligibility receipt provenance does not match the expected GitHub run");
  }
  if (
    provenance.repository !== lock.plan.tooling.repository ||
    provenance.workflow_path !== RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH ||
    provenance.workflow_ref !== lock.plan.tooling.ref ||
    provenance.workflow_sha !== lock.plan.tooling.sha
  ) {
    fail("publication eligibility provenance does not match its producer and ReleasePlan tooling");
  }
  const expectedNpm = lock.plan.inventory.packages
    .filter((entry) => entry.targets.includes("npm"))
    .map(({ name, version }) => ({ name, version }));
  const expectedClawHub = lock.plan.inventory.packages
    .filter((entry) => entry.targets.includes("clawhub"))
    .map(({ name, version }) => ({ name, version }));
  assertSamePackages(packageIdentity(receipt.plans.npm), expectedNpm, "npm publication plan");
  assertSamePackages(
    packageIdentity(receipt.plans.clawhub),
    expectedClawHub,
    "ClawHub publication plan",
  );
  const completedAt = Date.parse(receipt.completed_at);
  const expiresAt = Date.parse(receipt.expires_at);
  if (nowMs < completedAt) {
    fail("publication eligibility receipt is not yet valid");
  }
  if (nowMs > expiresAt) {
    fail("publication eligibility receipt expired; recollect publication eligibility");
  }
  return receipt;
}
