#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalAsciiJson } from "./lib/canonical-json.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import {
  normalizeUpgradeSurvivorBaselineSpec,
  parseUpgradeSurvivorBaselineSpecs,
  parseUpgradeSurvivorScenarios,
} from "./lib/upgrade-survivor-policy.mjs";

const FULL_RELEASE_CANDIDATE_REQUEST_SCHEMA = "openclaw.full-release-candidate-request/v1";
const FULL_RELEASE_CANDIDATE_MANIFEST_SCHEMA = "openclaw.full-release-candidate/v1";
const FULL_RELEASE_CANDIDATE_BINDING_SCHEMA = "openclaw.full-release-candidate-binding/v1";
const FULL_RELEASE_CANDIDATE_ARTIFACT_PREFIX = "full-release-candidate-v1-";

const MANIFEST_MAX_BYTES = 32 * 1024;
const BINDING_MAX_BYTES = 40 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const ISO_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const RELEASE_PROFILES = new Set(["minimum", "beta", "stable", "full"]);
const SHARED_IMAGE_POLICIES = new Set(["existing-only", "no-push-artifact"]);
const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted(compareAscii);
  const expected = [...keys].toSorted(compareAscii);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

function ascii(value, label) {
  if (typeof value !== "string" || !ASCII_PATTERN.test(value)) {
    fail(`${label} must be a non-empty printable ASCII string`);
  }
  return value;
}

function sha(value, label) {
  const normalized = ascii(value, label);
  if (!SHA_PATTERN.test(normalized)) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return normalized;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function repository(value, label) {
  const normalized = ascii(value, label);
  if (!REPOSITORY_PATTERN.test(normalized)) {
    fail(`${label} must be an owner/repository slug`);
  }
  return normalized;
}

function workflowPath(value, label) {
  const normalized = ascii(value, label);
  if (!WORKFLOW_PATH_PATTERN.test(normalized)) {
    fail(`${label} must be a .github/workflows YAML path`);
  }
  return normalized;
}

function positiveDecimal(value, label) {
  const normalized = String(value ?? "");
  if (!POSITIVE_DECIMAL_PATTERN.test(normalized)) {
    fail(`${label} must be a positive decimal string`);
  }
  return normalized;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean`);
  }
  return value;
}

function sortedUniquePackages(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  const result = value.map((entry, index) => {
    const packageName = ascii(entry, `${label}[${index}]`);
    if (!PACKAGE_NAME_PATTERN.test(packageName)) {
      fail(`${label}[${index}] must be a package name`);
    }
    return packageName;
  });
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => index > 0 && compareAscii(result[index - 1], entry) >= 0)
  ) {
    fail(`${label} must contain unique package names in ascending ASCII order`);
  }
  return result;
}

function stringArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value.map((entry, index) => ascii(entry, `${label}[${index}]`));
}

export function buildFullReleaseCandidateRequest(input) {
  if (!isRecord(input)) {
    fail("full release candidate request input must be an object");
  }
  const explicitBaselines = parseUpgradeSurvivorBaselineSpecs(
    typeof input.upgradeSurvivorBaselines === "string" ? input.upgradeSurvivorBaselines : undefined,
  );
  const defaultBaseline = normalizeUpgradeSurvivorBaselineSpec(
    typeof input.upgradeSurvivorBaseline === "string" ? input.upgradeSurvivorBaseline : undefined,
  );
  const effectiveBaselines =
    explicitBaselines.length > 0 ? explicitBaselines : defaultBaseline ? [defaultBaseline] : [];
  const effectiveScenarios = parseUpgradeSurvivorScenarios(
    typeof input.upgradeSurvivorScenarios === "string" ? input.upgradeSurvivorScenarios : undefined,
  );
  return validateFullReleaseCandidateRequest({
    schema: FULL_RELEASE_CANDIDATE_REQUEST_SCHEMA,
    repository: input.repository,
    targetSha: input.targetSha,
    toolingSha: input.toolingSha,
    releaseProfile: input.releaseProfile,
    releaseSoak: input.releaseSoak,
    upgradeSurvivorBaselines: effectiveBaselines.toSorted(compareAscii),
    upgradeSurvivorScenarios: effectiveScenarios.toSorted(compareAscii),
    allowFrozenTargetScenarioOmissions: input.allowFrozenTargetScenarioOmissions,
    allowUnreleasedChangelog: input.allowUnreleasedChangelog,
    sharedImagePolicy: input.sharedImagePolicy,
    contractVersions: {
      package: 1,
      prepublishPluginRegistry: 1,
      sharedImage: 1,
    },
  });
}

export function validateFullReleaseCandidateRequest(value) {
  exactKeys(
    value,
    [
      "allowFrozenTargetScenarioOmissions",
      "allowUnreleasedChangelog",
      "contractVersions",
      "releaseProfile",
      "releaseSoak",
      "repository",
      "schema",
      "sharedImagePolicy",
      "targetSha",
      "toolingSha",
      "upgradeSurvivorBaselines",
      "upgradeSurvivorScenarios",
    ],
    "full release candidate request",
  );
  exactKeys(
    value.contractVersions,
    ["package", "prepublishPluginRegistry", "sharedImage"],
    "full release candidate request contractVersions",
  );
  if (
    value.contractVersions.package !== 1 ||
    value.contractVersions.prepublishPluginRegistry !== 1 ||
    value.contractVersions.sharedImage !== 1
  ) {
    fail("full release candidate request contract versions are invalid");
  }
  const releaseProfile = ascii(
    value.releaseProfile,
    "full release candidate request releaseProfile",
  );
  if (!RELEASE_PROFILES.has(releaseProfile)) {
    fail("full release candidate request releaseProfile is invalid");
  }
  const sharedImagePolicy = ascii(
    value.sharedImagePolicy,
    "full release candidate request sharedImagePolicy",
  );
  if (!SHARED_IMAGE_POLICIES.has(sharedImagePolicy)) {
    fail("full release candidate request sharedImagePolicy is invalid");
  }
  const baselines = stringArray(
    value.upgradeSurvivorBaselines,
    "full release candidate request upgradeSurvivorBaselines",
  );
  if (new Set(baselines).size !== baselines.length) {
    fail("full release candidate request upgradeSurvivorBaselines must be unique");
  }
  if (
    baselines.some((entry, index) => index > 0 && compareAscii(baselines[index - 1], entry) >= 0)
  ) {
    fail(
      "full release candidate request upgradeSurvivorBaselines must be in ascending ASCII order",
    );
  }
  for (const baseline of baselines) {
    if (normalizeUpgradeSurvivorBaselineSpec(baseline) !== baseline) {
      fail("full release candidate request upgradeSurvivorBaselines are not normalized");
    }
  }
  const scenarios = stringArray(
    value.upgradeSurvivorScenarios,
    "full release candidate request upgradeSurvivorScenarios",
  );
  if (
    new Set(scenarios).size !== scenarios.length ||
    scenarios.some((entry, index) => index > 0 && compareAscii(scenarios[index - 1], entry) >= 0) ||
    JSON.stringify(parseUpgradeSurvivorScenarios(scenarios.join(" "))) !== JSON.stringify(scenarios)
  ) {
    fail("full release candidate request upgradeSurvivorScenarios are not normalized");
  }
  if (value.schema !== FULL_RELEASE_CANDIDATE_REQUEST_SCHEMA) {
    fail("full release candidate request schema is invalid");
  }
  return {
    schema: value.schema,
    repository: repository(value.repository, "full release candidate request repository"),
    targetSha: sha(value.targetSha, "full release candidate request targetSha"),
    toolingSha: sha(value.toolingSha, "full release candidate request toolingSha"),
    releaseProfile,
    releaseSoak: boolean(value.releaseSoak, "full release candidate request releaseSoak"),
    upgradeSurvivorBaselines: baselines,
    upgradeSurvivorScenarios: scenarios,
    allowFrozenTargetScenarioOmissions: boolean(
      value.allowFrozenTargetScenarioOmissions,
      "full release candidate request allowFrozenTargetScenarioOmissions",
    ),
    allowUnreleasedChangelog: boolean(
      value.allowUnreleasedChangelog,
      "full release candidate request allowUnreleasedChangelog",
    ),
    sharedImagePolicy,
    contractVersions: {
      package: 1,
      prepublishPluginRegistry: 1,
      sharedImage: 1,
    },
  };
}

export function canonicalFullReleaseCandidateRequestJson(value) {
  return canonicalAsciiJson(validateFullReleaseCandidateRequest(value));
}

export function candidateRequestSha256(value) {
  return createHash("sha256").update(canonicalFullReleaseCandidateRequestJson(value)).digest("hex");
}

export function fullReleaseCandidateArtifactName(requestSha256) {
  return `${FULL_RELEASE_CANDIDATE_ARTIFACT_PREFIX}${sha256(
    requestSha256,
    "full release candidate requestSha256",
  )}`;
}

function artifactIdentity(value, label) {
  exactKeys(value, ["digest", "expiresAt", "id", "name", "runAttempt", "runId"], label);
  const expiresAt = ascii(value.expiresAt, `${label} expiresAt`);
  if (!ISO_TIMESTAMP_PATTERN.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
    fail(`${label} expiresAt must be an ISO-8601 UTC timestamp`);
  }
  return {
    digest: sha256(value.digest, `${label} digest`),
    expiresAt,
    id: positiveDecimal(value.id, `${label} id`),
    name: ascii(value.name, `${label} name`),
    runAttempt: positiveDecimal(value.runAttempt, `${label} runAttempt`),
    runId: positiveDecimal(value.runId, `${label} runId`),
  };
}

function validatePackage(value, request) {
  exactKeys(
    value,
    ["artifact", "fileName", "packageSha256", "sourceSha", "version"],
    "full release candidate package",
  );
  const sourceSha = sha(value.sourceSha, "full release candidate package sourceSha");
  if (sourceSha !== request.targetSha) {
    fail("full release candidate package sourceSha does not match the request targetSha");
  }
  return {
    artifact: artifactIdentity(value.artifact, "full release candidate package artifact"),
    fileName: ascii(value.fileName, "full release candidate package fileName"),
    packageSha256: sha256(value.packageSha256, "full release candidate package packageSha256"),
    sourceSha,
    version: ascii(value.version, "full release candidate package version"),
  };
}

function validateRegistry(value, request, requiredPackages) {
  exactKeys(
    value,
    ["artifact", "manifestSha256", "sourceSha"],
    "full release candidate prepublishPluginRegistry",
  );
  const sourceSha = sha(
    value.sourceSha,
    "full release candidate prepublishPluginRegistry sourceSha",
  );
  if (sourceSha !== request.targetSha || requiredPackages.length === 0) {
    fail("full release candidate prerelease registry does not match the request");
  }
  return {
    artifact: artifactIdentity(
      value.artifact,
      "full release candidate prepublishPluginRegistry artifact",
    ),
    manifestSha256: sha256(
      value.manifestSha256,
      "full release candidate prepublishPluginRegistry manifestSha256",
    ),
    sourceSha,
  };
}

function validateSharedImage(value, packageSha256) {
  exactKeys(
    value,
    ["archiveSha256", "artifact", "packageSha256"],
    "full release candidate sharedImage",
  );
  const imagePackageSha256 = sha256(
    value.packageSha256,
    "full release candidate sharedImage packageSha256",
  );
  if (imagePackageSha256 !== packageSha256) {
    fail("full release candidate shared image packageSha256 does not match the package");
  }
  return {
    archiveSha256: sha256(value.archiveSha256, "full release candidate sharedImage archiveSha256"),
    artifact: artifactIdentity(value.artifact, "full release candidate sharedImage artifact"),
    packageSha256: imagePackageSha256,
  };
}

function assertProducedInSameAttempt(manifest) {
  const expectedRunId = manifest.producer.runId;
  const expectedRunAttempt = manifest.producer.runAttempt;
  for (const [label, artifact] of [
    ["package", manifest.package.artifact],
    ["prepublish plugin registry", manifest.prepublishPluginRegistry.artifact],
    ["shared image", manifest.sharedImage.artifact],
  ]) {
    if (artifact.runId !== expectedRunId || artifact.runAttempt !== expectedRunAttempt) {
      fail(`full release candidate ${label} artifact was not produced by the declared attempt`);
    }
  }
}

function validateFullReleaseCandidateManifest(value) {
  exactKeys(
    value,
    [
      "package",
      "preparation",
      "prepublishPluginRegistry",
      "producer",
      "request",
      "requestSha256",
      "schema",
      "sharedImage",
    ],
    "full release candidate manifest",
  );
  if (value.schema !== FULL_RELEASE_CANDIDATE_MANIFEST_SCHEMA) {
    fail("full release candidate manifest schema is invalid");
  }
  const request = validateFullReleaseCandidateRequest(value.request);
  const requestSha256 = sha256(value.requestSha256, "full release candidate requestSha256");
  if (requestSha256 !== candidateRequestSha256(request)) {
    fail("full release candidate requestSha256 does not match the request");
  }
  exactKeys(
    value.producer,
    ["jobId", "jobName", "repository", "runAttempt", "runId", "workflowPath", "workflowSha"],
    "full release candidate producer",
  );
  const producer = {
    jobId: positiveDecimal(value.producer.jobId, "full release candidate producer jobId"),
    jobName: ascii(value.producer.jobName, "full release candidate producer jobName"),
    repository: repository(value.producer.repository, "full release candidate producer repository"),
    runAttempt: positiveDecimal(
      value.producer.runAttempt,
      "full release candidate producer runAttempt",
    ),
    runId: positiveDecimal(value.producer.runId, "full release candidate producer runId"),
    workflowPath: workflowPath(
      value.producer.workflowPath,
      "full release candidate producer workflowPath",
    ),
    workflowSha: sha(value.producer.workflowSha, "full release candidate producer workflowSha"),
  };
  if (producer.repository !== request.repository || producer.workflowSha !== request.toolingSha) {
    fail("full release candidate producer does not match the request");
  }
  exactKeys(
    value.preparation,
    ["planSha256", "requiredPrepublishPluginPackages"],
    "full release candidate preparation",
  );
  const preparation = {
    planSha256: sha256(
      value.preparation.planSha256,
      "full release candidate preparation planSha256",
    ),
    requiredPrepublishPluginPackages: sortedUniquePackages(
      value.preparation.requiredPrepublishPluginPackages,
      "full release candidate preparation requiredPrepublishPluginPackages",
    ),
  };
  const packageValue = validatePackage(value.package, request);
  const manifest = {
    schema: value.schema,
    request,
    requestSha256,
    producer,
    preparation,
    package: packageValue,
    prepublishPluginRegistry: validateRegistry(
      value.prepublishPluginRegistry,
      request,
      preparation.requiredPrepublishPluginPackages,
    ),
    sharedImage: validateSharedImage(value.sharedImage, packageValue.packageSha256),
  };
  assertProducedInSameAttempt(manifest);
  return manifest;
}

function buildFullReleaseCandidateManifest(input) {
  if (!isRecord(input)) {
    fail("full release candidate manifest input must be an object");
  }
  return validateFullReleaseCandidateManifest({
    schema: FULL_RELEASE_CANDIDATE_MANIFEST_SCHEMA,
    ...input,
  });
}

function canonicalFullReleaseCandidateManifestJson(value) {
  const json = canonicalAsciiJson(validateFullReleaseCandidateManifest(value));
  if (Buffer.byteLength(json) > MANIFEST_MAX_BYTES) {
    fail(`full release candidate manifest exceeds ${MANIFEST_MAX_BYTES} bytes`);
  }
  return json;
}

function fullReleaseCandidateManifestSha256(value) {
  return createHash("sha256")
    .update(canonicalFullReleaseCandidateManifestJson(value))
    .digest("hex");
}

export function buildFullReleaseCandidateBinding({ artifact, manifest }) {
  const validatedManifest = validateFullReleaseCandidateManifest(manifest);
  const evidenceArtifact = artifactIdentity(artifact, "full release candidate evidence artifact");
  const expectedName = fullReleaseCandidateArtifactName(validatedManifest.requestSha256);
  if (
    evidenceArtifact.name !== expectedName ||
    evidenceArtifact.runId !== validatedManifest.producer.runId ||
    evidenceArtifact.runAttempt !== validatedManifest.producer.runAttempt
  ) {
    fail("full release candidate evidence artifact does not match its manifest");
  }
  return validateFullReleaseCandidateBinding({
    schema: FULL_RELEASE_CANDIDATE_BINDING_SCHEMA,
    request: validatedManifest.request,
    requestSha256: validatedManifest.requestSha256,
    producer: validatedManifest.producer,
    evidenceArtifact,
    manifestSha256: fullReleaseCandidateManifestSha256(validatedManifest),
    preparation: validatedManifest.preparation,
    package: validatedManifest.package,
    prepublishPluginRegistry: validatedManifest.prepublishPluginRegistry,
    sharedImage: validatedManifest.sharedImage,
  });
}

export function validateFullReleaseCandidateBinding(value) {
  exactKeys(
    value,
    [
      "evidenceArtifact",
      "manifestSha256",
      "package",
      "preparation",
      "prepublishPluginRegistry",
      "producer",
      "request",
      "requestSha256",
      "schema",
      "sharedImage",
    ],
    "full release candidate binding",
  );
  if (value.schema !== FULL_RELEASE_CANDIDATE_BINDING_SCHEMA) {
    fail("full release candidate binding schema is invalid");
  }
  const request = validateFullReleaseCandidateRequest(value.request);
  const requestSha256 = sha256(value.requestSha256, "full release candidate binding requestSha256");
  if (requestSha256 !== candidateRequestSha256(request)) {
    fail("full release candidate binding requestSha256 does not match the request");
  }
  exactKeys(
    value.producer,
    ["jobId", "jobName", "repository", "runAttempt", "runId", "workflowPath", "workflowSha"],
    "full release candidate binding producer",
  );
  const producer = {
    jobId: positiveDecimal(value.producer.jobId, "full release candidate binding producer jobId"),
    jobName: ascii(value.producer.jobName, "full release candidate binding producer jobName"),
    repository: repository(
      value.producer.repository,
      "full release candidate binding producer repository",
    ),
    runAttempt: positiveDecimal(
      value.producer.runAttempt,
      "full release candidate binding producer runAttempt",
    ),
    runId: positiveDecimal(value.producer.runId, "full release candidate binding producer runId"),
    workflowPath: workflowPath(
      value.producer.workflowPath,
      "full release candidate binding producer workflowPath",
    ),
    workflowSha: sha(
      value.producer.workflowSha,
      "full release candidate binding producer workflowSha",
    ),
  };
  if (producer.repository !== request.repository || producer.workflowSha !== request.toolingSha) {
    fail("full release candidate binding producer does not match the request");
  }
  const evidenceArtifact = artifactIdentity(
    value.evidenceArtifact,
    "full release candidate binding evidenceArtifact",
  );
  if (
    evidenceArtifact.name !== fullReleaseCandidateArtifactName(requestSha256) ||
    evidenceArtifact.runId !== producer.runId ||
    evidenceArtifact.runAttempt !== producer.runAttempt
  ) {
    fail("full release candidate binding evidence artifact is invalid");
  }
  exactKeys(
    value.preparation,
    ["planSha256", "requiredPrepublishPluginPackages"],
    "full release candidate binding preparation",
  );
  const preparation = {
    planSha256: sha256(
      value.preparation.planSha256,
      "full release candidate binding preparation planSha256",
    ),
    requiredPrepublishPluginPackages: sortedUniquePackages(
      value.preparation.requiredPrepublishPluginPackages,
      "full release candidate binding preparation requiredPrepublishPluginPackages",
    ),
  };
  const packageValue = validatePackage(value.package, request);
  const prepublishPluginRegistry = validateRegistry(
    value.prepublishPluginRegistry,
    request,
    preparation.requiredPrepublishPluginPackages,
  );
  const sharedImage = validateSharedImage(value.sharedImage, packageValue.packageSha256);
  const manifestSha256 = sha256(
    value.manifestSha256,
    "full release candidate binding manifestSha256",
  );
  const reconstructedManifest = {
    schema: FULL_RELEASE_CANDIDATE_MANIFEST_SCHEMA,
    request,
    requestSha256,
    producer,
    preparation,
    package: packageValue,
    prepublishPluginRegistry,
    sharedImage,
  };
  if (manifestSha256 !== fullReleaseCandidateManifestSha256(reconstructedManifest)) {
    fail("full release candidate binding manifestSha256 does not match its manifest fields");
  }
  const binding = {
    schema: value.schema,
    request,
    requestSha256,
    producer,
    evidenceArtifact,
    manifestSha256,
    preparation,
    package: packageValue,
    prepublishPluginRegistry,
    sharedImage,
  };
  assertProducedInSameAttempt(binding);
  if (Buffer.byteLength(canonicalAsciiJson(binding)) > BINDING_MAX_BYTES) {
    fail(`full release candidate binding exceeds ${BINDING_MAX_BYTES} bytes`);
  }
  return binding;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    fail(`missing ${name}`);
  }
  return args[index + 1];
}

function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value;
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "request") {
    const request = buildFullReleaseCandidateRequest(
      readJson(option(args, "--input"), "request input"),
    );
    const requestJson = canonicalFullReleaseCandidateRequestJson(request);
    writeFileSync(option(args, "--output"), requestJson);
    process.stdout.write(
      `${JSON.stringify({
        requestJson: requestJson.slice(0, -1),
        requestSha256: candidateRequestSha256(request),
      })}\n`,
    );
    return;
  }
  if (command === "manifest") {
    const manifest = buildFullReleaseCandidateManifest(
      readJson(option(args, "--input"), "manifest input"),
    );
    writeFileSync(option(args, "--output"), canonicalFullReleaseCandidateManifestJson(manifest));
    process.stdout.write(
      `${JSON.stringify({
        manifestSha256: fullReleaseCandidateManifestSha256(manifest),
        requestSha256: manifest.requestSha256,
      })}\n`,
    );
    return;
  }
  if (command === "binding") {
    const manifest = readJson(option(args, "--manifest"), "candidate manifest");
    const binding = buildFullReleaseCandidateBinding({
      manifest,
      artifact: {
        name: option(args, "--artifact-name"),
        id: option(args, "--artifact-id"),
        digest: option(args, "--artifact-digest"),
        expiresAt: option(args, "--artifact-expires-at"),
        runId: option(args, "--artifact-run-id"),
        runAttempt: option(args, "--artifact-run-attempt"),
      },
    });
    process.stdout.write(`${JSON.stringify(binding)}\n`);
    return;
  }
  fail("usage: full-release-candidate-contract.mjs <request|manifest|binding> ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
