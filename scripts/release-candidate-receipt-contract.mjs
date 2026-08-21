import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { isRecord } from "./lib/record-shared.mjs";

export const CANDIDATE_RECEIPT_SCHEMA = "openclaw.candidate-receipt.v1";
export const CANDIDATE_RECEIPT_LOCK_SCHEMA = "openclaw.candidate-receipt-lock.v1";
export const CANDIDATE_RECEIPT_CANONICALIZATION = "ascii-sorted-compact-json-trailing-newline-v1";
export const CANDIDATE_RECEIPT_MAX_BYTES = 16 * 1024;
export const CANDIDATE_RECEIPT_WORKFLOW_PATH = ".github/workflows/release-candidate-artifacts.yml";

const REPOSITORY = "openclaw/openclaw";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const ARTIFACT_KEYS = ["docker_image", "e2e_plugin_registry", "package", "root_image"];
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

function positiveDecimal(value, label) {
  const normalized = asciiString(value, label);
  if (!POSITIVE_DECIMAL_PATTERN.test(normalized)) {
    fail(`${label} must be a positive decimal integer string`);
  }
  return normalized;
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

function validateArtifact(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  exactKeys(value, ["artifact_digest", "artifact_id", "artifact_name", "content_digest"], label);
  return {
    artifact_digest: digest(value.artifact_digest, `${label} artifact_digest`),
    artifact_id: positiveDecimal(value.artifact_id, `${label} artifact_id`),
    artifact_name: asciiString(value.artifact_name, `${label} artifact_name`),
    content_digest: digest(value.content_digest, `${label} content_digest`),
  };
}

export function validateCandidateReceipt(value) {
  if (!isRecord(value)) {
    fail("candidate receipt must be an object");
  }
  exactKeys(value, ["artifacts", "producer", "release_plan_digest", "schema"], "candidate receipt");
  if (value.schema !== CANDIDATE_RECEIPT_SCHEMA) {
    fail(`candidate receipt schema must be ${CANDIDATE_RECEIPT_SCHEMA}`);
  }
  if (!isRecord(value.producer)) {
    fail("candidate receipt producer must be an object");
  }
  exactKeys(
    value.producer,
    ["repository", "run_attempt", "run_id", "workflow_id", "workflow_path", "workflow_sha"],
    "candidate receipt producer",
  );
  if (!isRecord(value.artifacts)) {
    fail("candidate receipt artifacts must be an object");
  }
  exactKeys(value.artifacts, ARTIFACT_KEYS, "candidate receipt artifacts");

  const receipt = {
    schema: CANDIDATE_RECEIPT_SCHEMA,
    release_plan_digest: digest(value.release_plan_digest, "candidate receipt release_plan_digest"),
    producer: {
      repository: asciiString(value.producer.repository, "candidate receipt producer repository"),
      workflow_path: asciiString(
        value.producer.workflow_path,
        "candidate receipt producer workflow_path",
      ),
      workflow_id: positiveDecimal(
        value.producer.workflow_id,
        "candidate receipt producer workflow_id",
      ),
      workflow_sha: sha(value.producer.workflow_sha, "candidate receipt producer workflow_sha"),
      run_id: positiveDecimal(value.producer.run_id, "candidate receipt producer run_id"),
      run_attempt: positiveDecimal(
        value.producer.run_attempt,
        "candidate receipt producer run_attempt",
      ),
    },
    artifacts: Object.fromEntries(
      ARTIFACT_KEYS.map((key) => [
        key,
        validateArtifact(value.artifacts[key], `candidate receipt artifacts.${key}`),
      ]),
    ),
  };
  if (receipt.producer.repository !== REPOSITORY) {
    fail(`candidate receipt producer repository must be ${REPOSITORY}`);
  }
  if (receipt.producer.workflow_path !== CANDIDATE_RECEIPT_WORKFLOW_PATH) {
    fail(`candidate receipt producer workflow_path must be ${CANDIDATE_RECEIPT_WORKFLOW_PATH}`);
  }
  const artifactIds = ARTIFACT_KEYS.map((key) => receipt.artifacts[key].artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    fail("candidate receipt artifact IDs must be unique");
  }
  const expectedNameSuffix = `-${receipt.producer.run_id}-${receipt.producer.run_attempt}`;
  for (const key of ARTIFACT_KEYS) {
    if (!receipt.artifacts[key].artifact_name.endsWith(expectedNameSuffix)) {
      fail(`candidate receipt artifacts.${key} name must bind the producer run attempt`);
    }
  }
  const exactArtifactNames = {
    e2e_plugin_registry: `docker-e2e-prepublish-plugin-registry${expectedNameSuffix}`,
    package: `docker-e2e-package${expectedNameSuffix}`,
    root_image: `release-candidate-root-image${expectedNameSuffix}`,
  };
  for (const [key, expectedName] of Object.entries(exactArtifactNames)) {
    if (receipt.artifacts[key].artifact_name !== expectedName) {
      fail(`candidate receipt artifacts.${key} name does not match its artifact kind`);
    }
  }
  if (
    !new RegExp(
      `^docker-e2e-shared-images-release-candidate-[a-f0-9]{12}${expectedNameSuffix}$`,
      "u",
    ).test(receipt.artifacts.docker_image.artifact_name)
  ) {
    fail("candidate receipt artifacts.docker_image name does not match its artifact kind");
  }
  if (Buffer.byteLength(canonicalAsciiJson(receipt), "ascii") > CANDIDATE_RECEIPT_MAX_BYTES) {
    fail(`candidate receipt exceeds ${CANDIDATE_RECEIPT_MAX_BYTES} bytes`);
  }
  return receipt;
}

export function canonicalCandidateReceiptJson(value) {
  return canonicalAsciiJson(validateCandidateReceipt(value));
}

export function candidateReceiptDigest(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalCandidateReceiptJson(value), "ascii")
    .digest("hex")}`;
}

export function createCandidateReceiptLock(value) {
  const receipt = validateCandidateReceipt(value);
  return {
    schema: CANDIDATE_RECEIPT_LOCK_SCHEMA,
    digest: candidateReceiptDigest(receipt),
    receipt,
  };
}

export function validateCandidateReceiptLock(value) {
  if (!isRecord(value)) {
    fail("candidate receipt lock must be an object");
  }
  exactKeys(value, ["digest", "receipt", "schema"], "candidate receipt lock");
  if (value.schema !== CANDIDATE_RECEIPT_LOCK_SCHEMA) {
    fail(`candidate receipt lock schema must be ${CANDIDATE_RECEIPT_LOCK_SCHEMA}`);
  }
  const receipt = validateCandidateReceipt(value.receipt);
  const receiptDigest = digest(value.digest, "candidate receipt lock digest");
  if (receiptDigest !== candidateReceiptDigest(receipt)) {
    fail("candidate receipt lock digest does not match its canonical receipt");
  }
  return { schema: CANDIDATE_RECEIPT_LOCK_SCHEMA, digest: receiptDigest, receipt };
}

export function canonicalCandidateReceiptLockJson(value) {
  return canonicalAsciiJson(validateCandidateReceiptLock(value));
}

export function parseCandidateReceiptLockJson(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > CANDIDATE_RECEIPT_MAX_BYTES + 4096
  ) {
    fail("candidate receipt lock JSON is missing or too large");
  }
  if (!/^[\x20-\x7e]+\n$/u.test(text)) {
    fail(
      "candidate receipt lock JSON must be compact printable ASCII with exactly one trailing LF",
    );
  }
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    const duplicate = document.errors.find((error) =>
      error.message.includes("keys must be unique"),
    );
    fail(
      duplicate
        ? "candidate receipt JSON contains a duplicate key"
        : `candidate receipt lock JSON is invalid: ${document.errors[0].message}`,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("candidate receipt lock JSON is invalid JSON", { cause: error });
  }
  const lock = validateCandidateReceiptLock(value);
  if (text !== canonicalCandidateReceiptLockJson(lock)) {
    fail("candidate receipt lock JSON does not use canonical bytes");
  }
  return lock;
}
