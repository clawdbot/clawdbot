#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import {
  canonicalizeGatewayNodeCompatEvidence,
  validateGatewayNodeCompatEvidence,
} from "./gateway-node-compat-evidence.mjs";
import {
  describeActionsArtifactFiles,
  readPublicationArtifactArchive,
} from "./lib/actions-artifact-archive.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { plainGhEnv, resolvePlainGhBin } from "./lib/plain-gh.mjs";

export const GATEWAY_NODE_COMPAT_RELEASE_SCHEMA =
  "openclaw.gateway-node-compat-release-evidence/v1";
export const GATEWAY_NODE_COMPAT_BASELINE_VERSION = "2026.5.7";
export const GATEWAY_NODE_COMPAT_BASELINE_TAG = "v2026.5.7";
export const GATEWAY_NODE_COMPAT_BASELINE_SOURCE_SHA = "eeef4864494f859838fec1586bedbab1f8fa5702";
export const GATEWAY_NODE_COMPAT_BASELINE_SHA256 =
  "1fe195d8e3928062cfaf7f9ef616670cde25b35ea9631fcae5f8aaf8be2986fd";
export const GATEWAY_NODE_COMPAT_BASELINE_NPM_INTEGRITY =
  "sha512-hjvpgconK20YltQPrzDY6cehjM8ijQyZnLKhqLBTngiFEPum9gmXwCDsrisPEXVRFtzuMhap+w6zSEmSQ1047Q==";
export const GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW =
  ".github/workflows/openclaw-release-checks.yml";
export const GATEWAY_NODE_COMPAT_EVIDENCE_WORKFLOW =
  ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
export const GATEWAY_NODE_COMPAT_PRODUCER_JOB =
  "cross_os_release_checks / Gateway/node packaged compatibility / Linux / x64";

const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const MAX_ARCHIVE_BYTES = 512 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const DEFAULT_COLLECTION_RETRY_DELAY_MS = 5_000;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIONS_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const COLLECTION_MODES = new Set(["advisory", "not-selected", "required"]);
const TRANSIENT_COLLECTION_ERROR_PATTERN =
  /(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|HTTP 5[0-9][0-9]|rate limit|secondary rate limit|timed? out|timeout|no eligible successful producer|inventory (?:is incomplete|changed during pagination))/iu;
const REQUIRED_ROWS = [
  ["baseline-gateway-baseline-node", "passed"],
  ["baseline-gateway-candidate-node", "passed"],
  ["baseline-gateway-disjoint-node", "protocol-mismatch"],
  ["candidate-gateway-baseline-node", "passed"],
  ["candidate-gateway-candidate-node", "passed"],
  ["candidate-gateway-disjoint-node", "protocol-mismatch"],
];

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, label, keys) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function requireString(value, label, pattern, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} is too long`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireCollectionMode(value) {
  const mode = requireString(value, "Gateway/node compatibility collection mode", undefined, 32);
  if (!COLLECTION_MODES.has(mode)) {
    throw new Error("Gateway/node compatibility collection mode is invalid");
  }
  return mode;
}

function workflowPath(value) {
  return requireString(value, "workflow path").split("@", 1)[0];
}

function evidencePath(direction) {
  return `linux-x64-${direction}.json`;
}

function artifactName(runId, runAttempt) {
  return `openclaw-gateway-node-linux-compat-x64-${runId}-${runAttempt}`;
}

function directionRoles(direction) {
  return {
    gateway: direction.startsWith("candidate-") ? "candidate" : "baseline",
    node: direction.includes("-baseline-node") ? "baseline" : "candidate",
  };
}

function canonicalIdentity(value) {
  return JSON.stringify(value);
}

function validateRuntimeRole(binding, role, targetSha) {
  const packaged = binding.packagedArtifact;
  const installed = binding.installedRuntime;
  if (role === "candidate") {
    if (packaged.sourceSha !== targetSha || installed.sourceSha !== targetSha) {
      throw new Error("candidate runtime source SHA does not match the Full Release target SHA");
    }
    return;
  }
  if (
    packaged.version !== GATEWAY_NODE_COMPAT_BASELINE_VERSION ||
    installed.version !== GATEWAY_NODE_COMPAT_BASELINE_VERSION ||
    packaged.sourceSha !== GATEWAY_NODE_COMPAT_BASELINE_SOURCE_SHA ||
    installed.sourceSha !== GATEWAY_NODE_COMPAT_BASELINE_SOURCE_SHA ||
    packaged.sha256 !== GATEWAY_NODE_COMPAT_BASELINE_SHA256 ||
    installed.packageSha256 !== GATEWAY_NODE_COMPAT_BASELINE_SHA256
  ) {
    throw new Error("baseline runtime provenance is not canonical");
  }
}

function validateSharedIdentity(current, expected, label) {
  const identity = canonicalIdentity(current);
  if (expected.value === undefined) {
    expected.value = identity;
  } else if (identity !== expected.value) {
    throw new Error(`${label} must be identical across all six evidence rows`);
  }
}

export function validateGatewayNodeCompatEvidenceSet(files, expected) {
  if (!(files instanceof Map)) {
    throw new Error("Gateway/node compatibility artifact files must be a Map");
  }
  const repository = requireString(
    expected.repository,
    "expected repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  );
  const targetSha = requireString(expected.targetSha, "expected target SHA", SHA_PATTERN);
  const artifactIdentities = {
    baselinePackageSha256: GATEWAY_NODE_COMPAT_BASELINE_SHA256,
    candidatePackageSha256: requireString(
      expected.candidatePackageSha256,
      "expected candidate package SHA-256",
      SHA256_PATTERN,
    ),
  };
  const workflowSha = requireString(expected.workflowSha, "expected workflow SHA", SHA_PATTERN);
  const runId = requireString(String(expected.runId), "expected run ID", POSITIVE_DECIMAL_PATTERN);
  const runAttempt = requirePositiveInteger(expected.runAttempt, "expected run attempt");
  const descriptors = describeActionsArtifactFiles(files);
  const expectedPaths = REQUIRED_ROWS.map(([direction]) => evidencePath(direction));
  if (
    descriptors.length !== expectedPaths.length ||
    descriptors.some((descriptor, index) => descriptor.path !== expectedPaths[index])
  ) {
    throw new Error("Gateway/node compatibility artifact must contain the exact six-row inventory");
  }

  const producerIdentity = {};
  const candidateIdentity = {};
  const baselineIdentity = {};
  const summaries = [];
  for (const [direction, outcome] of REQUIRED_ROWS) {
    const filePath = evidencePath(direction);
    const bytes = files.get(filePath);
    if (!bytes) {
      throw new Error(`Gateway/node compatibility evidence is missing ${filePath}`);
    }
    const text = Buffer.from(bytes).toString("utf8");
    let evidence;
    try {
      evidence = JSON.parse(text);
    } catch (error) {
      throw new Error(`${filePath} is not valid JSON`, { cause: error });
    }
    validateGatewayNodeCompatEvidence(evidence, artifactIdentities);
    if (canonicalizeGatewayNodeCompatEvidence(evidence, artifactIdentities) !== text) {
      throw new Error(`${filePath} is not canonical Gateway/node compatibility evidence`);
    }
    if (
      evidence.caseId !== filePath.slice(0, -".json".length) ||
      evidence.direction !== direction ||
      evidence.result.outcome !== outcome ||
      evidence.node.kind !== "linux" ||
      evidence.node.architecture !== "x64"
    ) {
      throw new Error(`${filePath} does not match its required Linux/x64 matrix row`);
    }
    const producer = evidence.producer;
    if (
      producer.repository !== repository ||
      producer.workflowPath !== GATEWAY_NODE_COMPAT_EVIDENCE_WORKFLOW ||
      producer.workflowSha !== workflowSha ||
      producer.runId !== runId ||
      producer.runAttempt !== runAttempt ||
      producer.job !== "gateway_node_linux_compat"
    ) {
      throw new Error(`${filePath} producer tuple does not match the selected artifact`);
    }
    validateSharedIdentity(producer, producerIdentity, "producer tuple");

    const roles = directionRoles(direction);
    for (const [role, binding] of [
      [roles.gateway, evidence.gateway],
      [roles.node, evidence.node],
    ]) {
      const runtimeBinding = {
        installedRuntime: binding.installedRuntime,
        packagedArtifact: binding.packagedArtifact,
      };
      validateRuntimeRole(runtimeBinding, role, targetSha);
      validateSharedIdentity(
        runtimeBinding,
        role === "candidate" ? candidateIdentity : baselineIdentity,
        `${role} runtime binding`,
      );
    }

    const descriptor = descriptors.find((entry) => entry.path === filePath);
    if (!descriptor) {
      throw new Error(`Gateway/node compatibility evidence summary is missing ${filePath}`);
    }
    summaries.push({
      caseId: evidence.caseId,
      direction,
      outcome,
      gatewayVersion: evidence.gateway.installedRuntime.version,
      nodeVersion: evidence.node.installedRuntime.version,
      gatewayProtocolVersion: evidence.protocol.gatewayProtocolVersion,
      gatewayAcceptedNodeMin: evidence.protocol.gatewayAcceptedNodeMin,
      protocolClientAdvertisedMin: evidence.protocol.protocolClientAdvertisedMin,
      protocolClientAdvertisedMax: evidence.protocol.protocolClientAdvertisedMax,
      helloProtocol: evidence.protocol.helloProtocol,
      path: descriptor.path,
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
    });
  }
  return {
    baseline: {
      npmIntegrity: GATEWAY_NODE_COMPAT_BASELINE_NPM_INTEGRITY,
      sha256: GATEWAY_NODE_COMPAT_BASELINE_SHA256,
      sourceSha: GATEWAY_NODE_COMPAT_BASELINE_SOURCE_SHA,
      tag: GATEWAY_NODE_COMPAT_BASELINE_TAG,
      version: GATEWAY_NODE_COMPAT_BASELINE_VERSION,
    },
    baselineVersion: GATEWAY_NODE_COMPAT_BASELINE_VERSION,
    files: summaries,
    producer: JSON.parse(producerIdentity.value),
    targetSha,
  };
}

function validateRun(run, expected, requireSuccessfulRun) {
  const value = requireObject(run, "release-check run");
  if (
    String(value.id) !== String(expected.runId) ||
    value.event !== "workflow_dispatch" ||
    value.status !== "completed" ||
    (requireSuccessfulRun
      ? value.conclusion !== "success"
      : typeof value.conclusion !== "string" || value.conclusion.length === 0) ||
    value.head_sha !== expected.workflowSha ||
    workflowPath(value.path) !== GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW ||
    value.repository?.full_name !== expected.repository ||
    value.head_repository?.full_name !== expected.repository
  ) {
    throw new Error("release-check run does not match the immutable compatibility tuple");
  }
  requirePositiveInteger(value.run_attempt, "release-check run attempt");
  requireString(value.head_branch, "release-check head branch");
  return value;
}

export function selectGatewayNodeCompatArtifact({ artifacts, jobs, required, run }) {
  if (!Array.isArray(artifacts) || !Array.isArray(jobs)) {
    throw new Error("Gateway/node compatibility Actions inventories must be arrays");
  }
  const currentAttempt = requirePositiveInteger(run.run_attempt, "release-check run attempt");
  const runId = String(run.id);
  const producerJobs = jobs.filter(
    (job) =>
      job?.name === GATEWAY_NODE_COMPAT_PRODUCER_JOB &&
      String(job.run_id) === runId &&
      Number.isSafeInteger(job.run_attempt) &&
      job.run_attempt <= currentAttempt,
  );
  const namedArtifacts = artifacts.filter(
    (artifact) =>
      typeof artifact?.name === "string" &&
      artifact.name.startsWith(`openclaw-gateway-node-linux-compat-x64-${runId}-`),
  );
  const attempts = [...new Set(producerJobs.map((job) => job.run_attempt))].toSorted(
    (left, right) => right - left,
  );
  for (const attempt of attempts) {
    const matchingJobs = producerJobs.filter((job) => job.run_attempt === attempt);
    if (matchingJobs.length !== 1) {
      throw new Error(
        `Gateway/node compatibility producer job is not unique for attempt ${attempt}`,
      );
    }
    const matchingArtifacts = namedArtifacts.filter(
      (artifact) => artifact.name === artifactName(runId, attempt),
    );
    if (matchingArtifacts.length > 1) {
      throw new Error(`Gateway/node compatibility artifact is not unique for attempt ${attempt}`);
    }
    const [job] = matchingJobs;
    const [artifact] = matchingArtifacts;
    if (
      job.status === "completed" &&
      job.conclusion === "success" &&
      artifact &&
      artifact.expired === false
    ) {
      return { artifact, job, runAttempt: attempt };
    }
  }
  if (required || producerJobs.length > 0 || namedArtifacts.length > 0) {
    throw new Error("Gateway/node compatibility evidence has no eligible successful producer");
  }
  return undefined;
}

function validateArtifactMetadata(artifact, run, runAttempt) {
  const value = requireObject(artifact, "Gateway/node compatibility artifact");
  const runId = String(run.id);
  if (
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    value.name !== artifactName(runId, runAttempt) ||
    !ACTIONS_DIGEST_PATTERN.test(String(value.digest ?? "")) ||
    !Number.isSafeInteger(value.size_in_bytes) ||
    value.size_in_bytes < 1 ||
    value.expired !== false ||
    String(value.workflow_run?.id) !== runId ||
    value.workflow_run?.head_sha !== run.head_sha
  ) {
    throw new Error("Gateway/node compatibility artifact metadata is invalid");
  }
  return value;
}

function buildArtifactBinding(artifact, run, runAttempt, repository) {
  return {
    artifactDigest: artifact.digest,
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactSizeBytes: artifact.size_in_bytes,
    producerJobName: GATEWAY_NODE_COMPAT_PRODUCER_JOB,
    repository,
    runAttempt,
    runId: Number(run.id),
    runStatePolicy: "completed-producer-success",
    workflowEvent: run.event,
    workflowHeadBranch: run.head_branch,
    workflowPath: GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW,
    workflowSha: run.head_sha,
  };
}

export async function collectGatewayNodeCompatReleaseEvidence(params, client) {
  const mode = requireCollectionMode(params.mode);
  if (mode === "not-selected") {
    return null;
  }
  const onWarning = typeof params.onWarning === "function" ? params.onWarning : () => {};
  const retryDeadlineMs =
    params.retryDeadlineMs === undefined
      ? undefined
      : requirePositiveInteger(params.retryDeadlineMs, "collection retry deadline");
  const retryDelayMs =
    params.retryDelayMs === undefined
      ? DEFAULT_COLLECTION_RETRY_DELAY_MS
      : requirePositiveInteger(params.retryDelayMs, "collection retry delay");
  const now = typeof params.now === "function" ? params.now : Date.now;
  const sleep =
    typeof params.sleep === "function"
      ? params.sleep
      : (delayMs) =>
          new Promise((resolvePromise) => {
            setTimeout(resolvePromise, delayMs);
          });
  const deadlineAt = retryDeadlineMs === undefined ? undefined : now() + retryDeadlineMs;
  const evidenceClient =
    client ?? createGatewayNodeCompatReleaseEvidenceClient(params.token, { deadlineAt, now });
  let lastError;
  for (;;) {
    if (deadlineAt !== undefined && lastError !== undefined && now() >= deadlineAt) {
      break;
    }
    try {
      return await collectSelectedGatewayNodeCompatReleaseEvidence(
        params,
        evidenceClient,
        mode === "required",
      );
    } catch (error) {
      lastError = error;
      const remainingMs = deadlineAt === undefined ? 0 : deadlineAt - now();
      if (
        deadlineAt === undefined ||
        remainingMs <= 0 ||
        !TRANSIENT_COLLECTION_ERROR_PATTERN.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        break;
      }
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
  const finalError =
    deadlineAt !== undefined && deadlineAt - now() <= 0
      ? new Error("Gateway/node compatibility evidence collection retry deadline was exhausted", {
          cause: lastError,
        })
      : lastError;
  if (mode === "required") {
    throw finalError;
  }
  onWarning(finalError instanceof Error ? finalError.message : String(finalError));
  return null;
}

async function collectSelectedGatewayNodeCompatReleaseEvidence(params, client, required) {
  const expected = {
    candidatePackageSha256: requireString(
      params.candidatePackageSha256,
      "candidate package SHA-256",
      SHA256_PATTERN,
    ),
    repository: requireString(
      params.repository,
      "repository",
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    ),
    runId: requireString(String(params.runId), "release-check run ID", POSITIVE_DECIMAL_PATTERN),
    targetSha: requireString(params.targetSha, "target SHA", SHA_PATTERN),
    workflowSha: requireString(params.workflowSha, "workflow SHA", SHA_PATTERN),
  };
  const evidenceClient = client ?? createGatewayNodeCompatReleaseEvidenceClient(params.token);
  const run = validateRun(
    await evidenceClient.getRun(expected.runId, expected.repository),
    expected,
    required,
  );
  const [artifacts, jobs] = await Promise.all([
    evidenceClient.getArtifacts(expected.runId, expected.repository),
    evidenceClient.getJobs(expected.runId, expected.repository),
  ]);
  const selected = selectGatewayNodeCompatArtifact({
    artifacts,
    jobs,
    required,
    run,
  });
  if (!selected) {
    throw new Error("Gateway/node compatibility evidence has no eligible successful producer");
  }
  const artifact = validateArtifactMetadata(selected.artifact, run, selected.runAttempt);
  const binding = buildArtifactBinding(artifact, run, selected.runAttempt, expected.repository);
  const archive = await evidenceClient.readArtifact(binding);
  const set = validateGatewayNodeCompatEvidenceSet(archive.files, {
    candidatePackageSha256: expected.candidatePackageSha256,
    repository: expected.repository,
    runAttempt: selected.runAttempt,
    runId: expected.runId,
    targetSha: expected.targetSha,
    workflowSha: expected.workflowSha,
  });
  return validateGatewayNodeCompatManifestEvidence({
    architecture: "x64",
    artifact: {
      digest: artifact.digest,
      id: artifact.id,
      name: artifact.name,
      producerJob: GATEWAY_NODE_COMPAT_PRODUCER_JOB,
      repository: expected.repository,
      runAttempt: selected.runAttempt,
      runId: expected.runId,
      sizeBytes: artifact.size_in_bytes,
      workflowPath: GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW,
      workflowSha: expected.workflowSha,
    },
    baseline: set.baseline,
    baselineVersion: set.baselineVersion,
    files: set.files,
    platform: "linux",
    producer: set.producer,
    schema: GATEWAY_NODE_COMPAT_RELEASE_SCHEMA,
    targetSha: set.targetSha,
  });
}

function remainingCollectionDeadlineMs(options) {
  if (options.deadlineAt === undefined) {
    return 60_000;
  }
  const remainingMs = Math.floor(options.deadlineAt - options.now());
  if (remainingMs <= 0) {
    throw new Error("Gateway/node compatibility evidence collection retry deadline was exhausted");
  }
  return Math.min(60_000, remainingMs);
}

function createDeadlineFetch(options) {
  if (options.deadlineAt === undefined) {
    return undefined;
  }
  return async (input, init = {}) => {
    const deadlineSignal = AbortSignal.timeout(remainingCollectionDeadlineMs(options));
    const signal = init.signal ? AbortSignal.any([init.signal, deadlineSignal]) : deadlineSignal;
    return await fetch(input, { ...init, signal });
  };
}

function runGhJson(args, options) {
  return JSON.parse(
    execFileSync(resolvePlainGhBin(), args, {
      encoding: "utf8",
      env: plainGhEnv(),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: remainingCollectionDeadlineMs(options),
    }),
  );
}

function readPaginatedCollection(repository, path, field, options) {
  const items = [];
  const ids = new Set();
  let totalCount;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = runGhJson(
      ["api", `repos/${repository}/${path}${separator}per_page=${PAGE_SIZE}&page=${page}`],
      options,
    );
    const pageItems = response[field];
    if (!Array.isArray(pageItems) || !Number.isSafeInteger(response.total_count)) {
      throw new Error(`GitHub ${field} inventory is invalid`);
    }
    if (totalCount === undefined) {
      totalCount = response.total_count;
    } else if (response.total_count !== totalCount) {
      throw new Error(`GitHub ${field} inventory changed during pagination`);
    }
    for (const item of pageItems) {
      if (!Number.isSafeInteger(item?.id) || ids.has(item.id)) {
        throw new Error(`GitHub ${field} inventory contains duplicate or invalid IDs`);
      }
      ids.add(item.id);
      items.push(item);
    }
    if (pageItems.length < PAGE_SIZE) {
      break;
    }
  }
  if (items.length !== totalCount) {
    throw new Error(`GitHub ${field} inventory is incomplete`);
  }
  return items;
}

export function createGatewayNodeCompatReleaseEvidenceClient(
  token = process.env.GH_TOKEN,
  options = {},
) {
  const githubToken = requireString(token, "GitHub token");
  const deadlineOptions = {
    deadlineAt: options.deadlineAt,
    now: typeof options.now === "function" ? options.now : Date.now,
  };
  return {
    async getArtifacts(runId, repository) {
      return readPaginatedCollection(
        repository,
        `actions/runs/${runId}/artifacts`,
        "artifacts",
        deadlineOptions,
      );
    },
    async getJobs(runId, repository) {
      return readPaginatedCollection(
        repository,
        `actions/runs/${runId}/jobs?filter=all`,
        "jobs",
        deadlineOptions,
      );
    },
    async getRun(runId, repository) {
      return runGhJson(["api", `repos/${repository}/actions/runs/${runId}`], deadlineOptions);
    },
    async readArtifact(expected) {
      return readPublicationArtifactArchive({
        archivePolicy: {
          expectedEntries: REQUIRED_ROWS.map(([direction]) => evidencePath(direction)),
          maxArchiveBytes: MAX_ARCHIVE_BYTES,
          maxEntryBytes: () => MAX_EVIDENCE_BYTES,
          maxExpandedBytes: REQUIRED_ROWS.length * MAX_EVIDENCE_BYTES,
        },
        expected,
        fetchImpl: createDeadlineFetch(deadlineOptions),
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        timeoutMs: remainingCollectionDeadlineMs(deadlineOptions),
        token: githubToken,
      });
    },
  };
}

export function validateGatewayNodeCompatManifestEvidence(value) {
  const evidence = requireObject(value, "Gateway/node compatibility manifest evidence");
  requireExactKeys(evidence, "Gateway/node compatibility manifest evidence", [
    "architecture",
    "artifact",
    "baseline",
    "baselineVersion",
    "files",
    "platform",
    "producer",
    "schema",
    "targetSha",
  ]);
  if (
    evidence.schema !== GATEWAY_NODE_COMPAT_RELEASE_SCHEMA ||
    evidence.platform !== "linux" ||
    evidence.architecture !== "x64" ||
    evidence.baselineVersion !== GATEWAY_NODE_COMPAT_BASELINE_VERSION
  ) {
    throw new Error("Gateway/node compatibility manifest evidence is unsupported");
  }
  const baseline = requireObject(evidence.baseline, "Gateway/node compatibility baseline");
  requireExactKeys(baseline, "Gateway/node compatibility baseline", [
    "npmIntegrity",
    "sha256",
    "sourceSha",
    "tag",
    "version",
  ]);
  if (
    baseline.version !== GATEWAY_NODE_COMPAT_BASELINE_VERSION ||
    baseline.tag !== GATEWAY_NODE_COMPAT_BASELINE_TAG ||
    baseline.sourceSha !== GATEWAY_NODE_COMPAT_BASELINE_SOURCE_SHA ||
    baseline.sha256 !== GATEWAY_NODE_COMPAT_BASELINE_SHA256 ||
    baseline.npmIntegrity !== GATEWAY_NODE_COMPAT_BASELINE_NPM_INTEGRITY
  ) {
    throw new Error("Gateway/node compatibility baseline provenance is unsupported");
  }
  requireString(evidence.targetSha, "Gateway/node compatibility target SHA", SHA_PATTERN);
  const artifact = requireObject(evidence.artifact, "Gateway/node compatibility artifact binding");
  requireExactKeys(artifact, "Gateway/node compatibility artifact binding", [
    "digest",
    "id",
    "name",
    "producerJob",
    "repository",
    "runAttempt",
    "runId",
    "sizeBytes",
    "workflowPath",
    "workflowSha",
  ]);
  requirePositiveInteger(artifact.id, "Gateway/node compatibility artifact ID");
  requireString(
    artifact.digest,
    "Gateway/node compatibility artifact digest",
    ACTIONS_DIGEST_PATTERN,
  );
  requirePositiveInteger(artifact.sizeBytes, "Gateway/node compatibility artifact size");
  requireString(
    artifact.runId,
    "Gateway/node compatibility artifact run ID",
    POSITIVE_DECIMAL_PATTERN,
  );
  requirePositiveInteger(artifact.runAttempt, "Gateway/node compatibility artifact run attempt");
  if (
    artifact.name !== artifactName(artifact.runId, artifact.runAttempt) ||
    artifact.producerJob !== GATEWAY_NODE_COMPAT_PRODUCER_JOB ||
    artifact.workflowPath !== GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW
  ) {
    throw new Error("Gateway/node compatibility artifact binding is invalid");
  }
  requireString(
    artifact.repository,
    "Gateway/node compatibility artifact repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  );
  requireString(
    artifact.workflowSha,
    "Gateway/node compatibility artifact workflow SHA",
    SHA_PATTERN,
  );
  const producer = requireObject(evidence.producer, "Gateway/node compatibility producer");
  requireExactKeys(producer, "Gateway/node compatibility producer", [
    "job",
    "repository",
    "runAttempt",
    "runId",
    "workflowPath",
    "workflowSha",
  ]);
  if (
    producer.repository !== artifact.repository ||
    producer.runId !== artifact.runId ||
    producer.runAttempt !== artifact.runAttempt ||
    producer.workflowPath !== GATEWAY_NODE_COMPAT_EVIDENCE_WORKFLOW ||
    producer.workflowSha !== artifact.workflowSha ||
    producer.job !== "gateway_node_linux_compat"
  ) {
    throw new Error("Gateway/node compatibility producer does not match its artifact binding");
  }
  if (!Array.isArray(evidence.files) || evidence.files.length !== REQUIRED_ROWS.length) {
    throw new Error("Gateway/node compatibility manifest must summarize six evidence files");
  }
  for (const [index, [direction, outcome]] of REQUIRED_ROWS.entries()) {
    const file = requireObject(
      evidence.files[index],
      `Gateway/node compatibility file summary ${index}`,
    );
    requireExactKeys(file, `Gateway/node compatibility file summary ${index}`, [
      "caseId",
      "direction",
      "outcome",
      "gatewayVersion",
      "nodeVersion",
      "gatewayProtocolVersion",
      "gatewayAcceptedNodeMin",
      "protocolClientAdvertisedMin",
      "protocolClientAdvertisedMax",
      "helloProtocol",
      "path",
      "sha256",
      "sizeBytes",
    ]);
    if (
      file.caseId !== file.path.slice(0, -".json".length) ||
      file.direction !== direction ||
      file.outcome !== outcome ||
      file.path !== evidencePath(direction)
    ) {
      throw new Error("Gateway/node compatibility file summaries are not canonical");
    }
    requireString(file.caseId, "Gateway/node compatibility file case ID", CASE_ID_PATTERN, 128);
    requireString(
      file.gatewayVersion,
      "Gateway/node compatibility Gateway version",
      undefined,
      128,
    );
    requireString(file.nodeVersion, "Gateway/node compatibility node version", undefined, 128);
    const gatewayProtocolVersion = requirePositiveInteger(
      file.gatewayProtocolVersion,
      "Gateway/node compatibility Gateway protocol version",
    );
    const gatewayAcceptedNodeMin = requirePositiveInteger(
      file.gatewayAcceptedNodeMin,
      "Gateway/node compatibility Gateway accepted node minimum",
    );
    const protocolClientAdvertisedMin = requirePositiveInteger(
      file.protocolClientAdvertisedMin,
      "Gateway/node compatibility client advertised minimum",
    );
    const protocolClientAdvertisedMax = requirePositiveInteger(
      file.protocolClientAdvertisedMax,
      "Gateway/node compatibility client advertised maximum",
    );
    if (
      gatewayAcceptedNodeMin > gatewayProtocolVersion ||
      protocolClientAdvertisedMin > protocolClientAdvertisedMax
    ) {
      throw new Error("Gateway/node compatibility protocol summary is invalid");
    }
    if (outcome === "passed") {
      if (file.helloProtocol !== gatewayProtocolVersion) {
        throw new Error("Gateway/node compatibility passed summary has an invalid hello protocol");
      }
    } else if (
      file.helloProtocol !== null ||
      !(
        gatewayAcceptedNodeMin > protocolClientAdvertisedMax ||
        protocolClientAdvertisedMin > gatewayProtocolVersion
      )
    ) {
      throw new Error("Gateway/node compatibility mismatch summary is not disjoint");
    }
    requireString(file.sha256, "Gateway/node compatibility file SHA-256", SHA256_PATTERN);
    requirePositiveInteger(file.sizeBytes, "Gateway/node compatibility file size");
  }
  return evidence;
}

export function renderGatewayNodeCompatSummary(value) {
  const evidence = validateGatewayNodeCompatManifestEvidence(value);
  return [
    "### Gateway/node compatibility",
    "",
    `- Artifact: \`${evidence.artifact.name}\` (\`${evidence.artifact.digest}\`)`,
    `- Producer attempt: \`${evidence.artifact.runId}/${evidence.artifact.runAttempt}\``,
    `- Target SHA: \`${evidence.targetSha}\``,
    `- Baseline: \`${evidence.baseline.tag}\` @ \`${evidence.baseline.sourceSha}\``,
    `- Baseline tarball: \`${evidence.baseline.sha256}\``,
    "",
    "| Direction | Gateway | Node | Gateway protocol | Accepted min | Client range | Hello | Outcome | SHA-256 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...evidence.files.map(
      (file) =>
        `| \`${file.direction}\` | \`${file.gatewayVersion}\` | \`${file.nodeVersion}\` | \`${file.gatewayProtocolVersion}\` | \`${file.gatewayAcceptedNodeMin}\` | \`${file.protocolClientAdvertisedMin}-${file.protocolClientAdvertisedMax}\` | \`${file.helloProtocol ?? "none"}\` | \`${file.outcome}\` | \`${file.sha256}\` |`,
    ),
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (command !== "collect") {
    throw new Error(
      "usage: gateway-node-compat-release-evidence.mjs collect [--candidate-package-sha256 sha256] --repository owner/repo --run-id id --workflow-sha sha --target-sha sha --mode required|advisory|not-selected --retry-deadline-ms milliseconds --output file",
    );
  }
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      [
        "--output",
        "--candidate-package-sha256",
        "--repository",
        "--mode",
        "--retry-deadline-ms",
        "--run-id",
        "--target-sha",
        "--workflow-sha",
      ].includes(argument)
    ) {
      options[argument.slice(2).replaceAll("-", "_")] = args[++index];
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  requireCollectionMode(options.mode);
  if (options.retry_deadline_ms !== undefined) {
    options.retry_deadline_ms = requirePositiveInteger(
      Number(options.retry_deadline_ms),
      "collection retry deadline",
    );
  }
  for (const key of ["mode", "output", "repository", "run_id", "target_sha", "workflow_sha"]) {
    if (!options[key]) {
      throw new Error(`--${key.replaceAll("_", "-")} is required`);
    }
  }
  if (options.mode !== "not-selected" && !options.candidate_package_sha256) {
    throw new Error("--candidate-package-sha256 is required for selected evidence");
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const evidence = await collectGatewayNodeCompatReleaseEvidence({
    candidatePackageSha256: options.candidate_package_sha256,
    mode: options.mode,
    onWarning(message) {
      const escaped = message
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      console.error(`::warning title=Gateway/node compatibility evidence::${escaped}`);
    },
    repository: options.repository,
    retryDeadlineMs: options.retry_deadline_ms,
    runId: options.run_id,
    targetSha: options.target_sha,
    workflowSha: options.workflow_sha,
  });
  writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (evidence && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${renderGatewayNodeCompatSummary(evidence)}\n`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
