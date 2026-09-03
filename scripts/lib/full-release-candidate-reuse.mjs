import {
  buildFullReleaseCandidateBinding,
  candidateRequestSha256,
  fullReleaseCandidateArtifactName,
  validateFullReleaseCandidateBinding,
  validateFullReleaseCandidateRequest,
} from "../full-release-candidate-contract.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZip,
} from "./actions-artifact-archive.mjs";
import { isRecord } from "./record-shared.mjs";

const CANDIDATE_MANIFEST_FILE = "full-release-candidate.json";
const CANDIDATE_PRODUCER_WORKFLOW_PATH =
  ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const FULL_RELEASE_WORKFLOW_PATHS = new Set([
  ".github/workflows/full-release-validation.yml",
  ".github/workflows/full-release-artifacts.yml",
]);
const MAX_CANDIDATE_ARCHIVE_BYTES = 1024 * 1024;
const MAX_CANDIDATES_TO_EVALUATE = 5;
const MAX_CANDIDATE_MANIFEST_BYTES = 32 * 1024;
const MIN_CANDIDATE_REMAINING_MS = 14 * 60 * 60 * 1000;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

export class CandidateConstituentUnavailableError extends Error {}
export class CandidateDiscoveryBudgetError extends Error {}
export class CandidateEvaluationLimitError extends Error {}

function requireDiscoveryBudget(deadlineMs) {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new CandidateDiscoveryBudgetError("candidate discovery exceeded its time budget");
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function timestamp(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? { milliseconds, value } : undefined;
}

function exactRequest(left, right) {
  return (
    JSON.stringify(validateFullReleaseCandidateRequest(left)) ===
    JSON.stringify(validateFullReleaseCandidateRequest(right))
  );
}

function bindingFromArchive(archiveBytes, artifactMetadata) {
  if (!(archiveBytes instanceof Uint8Array)) {
    fail("full release candidate archive omitted its manifest");
  }
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(archiveBytes).toString("utf8"));
  } catch (error) {
    fail(
      `manifest input is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return buildFullReleaseCandidateBinding({
    manifest,
    artifact: {
      name: artifactMetadata.name,
      id: artifactMetadata.id,
      digest: String(artifactMetadata.digest).replace(/^sha256:/u, ""),
      expiresAt: artifactMetadata.expires_at,
      runId: artifactMetadata.workflow_run?.id,
      runAttempt: manifest.publisher?.runAttempt,
    },
  });
}

function artifactIdentityFromMetadata(metadata, runAttempt) {
  return {
    digest: String(metadata.digest ?? "").replace(/^sha256:/u, ""),
    expiresAt: String(metadata.expires_at ?? ""),
    id: String(metadata.id ?? ""),
    name: String(metadata.name ?? ""),
    runAttempt: String(runAttempt),
    runId: String(metadata.workflow_run?.id ?? ""),
  };
}

function candidateArtifactMetadata(value, expectedName, toolingSha, now) {
  if (!isRecord(value) || value.name !== expectedName || value.expired !== false) {
    return undefined;
  }
  const digest = typeof value.digest === "string" ? value.digest : "";
  const id = positiveInteger(value.id);
  const sizeInBytes = positiveInteger(value.size_in_bytes);
  const createdAt = timestamp(value.created_at);
  const expiresAt = timestamp(value.expires_at);
  const workflowRun = value.workflow_run;
  const runId = positiveInteger(workflowRun?.id);
  const repositoryId = positiveInteger(workflowRun?.repository_id);
  const headRepositoryId = positiveInteger(workflowRun?.head_repository_id);
  if (
    id === undefined ||
    sizeInBytes === undefined ||
    sizeInBytes > MAX_CANDIDATE_ARCHIVE_BYTES ||
    !createdAt ||
    !expiresAt ||
    expiresAt.milliseconds <= now + MIN_CANDIDATE_REMAINING_MS ||
    !SHA256_DIGEST_PATTERN.test(digest) ||
    !isRecord(workflowRun) ||
    runId === undefined ||
    repositoryId === undefined ||
    headRepositoryId !== repositoryId ||
    workflowRun.head_sha !== toolingSha
  ) {
    return undefined;
  }
  return { artifact: value, createdAt: createdAt.milliseconds, id, runId };
}

function workflowPath(value) {
  return typeof value === "string" ? value.split("@", 1)[0] : "";
}

function trustedWorkflowRun(value, candidate, request) {
  // A failed parent can still contribute a valid candidate when its producer
  // job succeeded; the exact producer job is verified after artifact selection.
  const active = ["in_progress", "waiting"].includes(value?.status) && value?.conclusion === null;
  const terminal =
    value?.status === "completed" &&
    typeof value?.conclusion === "string" &&
    value.conclusion.length > 0;
  if (
    !isRecord(value) ||
    value.id !== candidate.runId ||
    positiveInteger(value.run_attempt) === undefined ||
    value.head_sha !== request.toolingSha ||
    value.event !== "workflow_dispatch" ||
    !FULL_RELEASE_WORKFLOW_PATHS.has(workflowPath(value.path)) ||
    (!active && !terminal) ||
    value.repository?.full_name !== request.repository ||
    value.head_repository?.full_name !== request.repository ||
    value.repository?.id !== candidate.artifact.workflow_run.repository_id ||
    value.head_repository?.id !== candidate.artifact.workflow_run.head_repository_id ||
    typeof value.head_branch !== "string" ||
    value.head_branch.length === 0
  ) {
    return undefined;
  }
  return { artifact: candidate.artifact };
}

function newestCandidateFirst(left, right) {
  return left.createdAt !== right.createdAt ? right.createdAt - left.createdAt : right.id - left.id;
}

function isMissingMetadataError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP (?:404|410)\b/u.test(message);
}

export async function selectTrustedFullReleaseCandidate({
  artifacts,
  deadlineMs,
  now = Date.now(),
  readWorkflowRun,
  readWorkflowJobs,
  request,
}) {
  const validatedRequest = validateFullReleaseCandidateRequest(request);
  if (
    !Array.isArray(artifacts) ||
    typeof readWorkflowRun !== "function" ||
    typeof readWorkflowJobs !== "function"
  ) {
    fail("full release candidate artifact inventory is invalid");
  }
  requireDiscoveryBudget(deadlineMs);
  const requestSha256 = candidateRequestSha256(validatedRequest);
  const expectedName = fullReleaseCandidateArtifactName(requestSha256);
  const candidates = artifacts
    .map((artifact) =>
      candidateArtifactMetadata(artifact, expectedName, validatedRequest.toolingSha, now),
    )
    .filter(Boolean)
    .toSorted(newestCandidateFirst);
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_TO_EVALUATE)) {
    requireDiscoveryBudget(deadlineMs);
    let run;
    try {
      run = await readWorkflowRun(candidate.runId);
    } catch (error) {
      if (isMissingMetadataError(error)) {
        continue;
      }
      throw error;
    }
    const selected = trustedWorkflowRun(run, candidate, validatedRequest);
    if (!selected) {
      continue;
    }
    // Artifact names are unique across all attempts in one run. A successful
    // non-overwriting trusted upload proves selected-target code did not reserve it.
    let workflowJobs;
    requireDiscoveryBudget(deadlineMs);
    try {
      workflowJobs = await readWorkflowJobs(candidate.runId);
    } catch (error) {
      if (isMissingMetadataError(error)) {
        continue;
      }
      throw error;
    }
    if (hasTrustedCandidatePublisher(workflowJobs, candidate, validatedRequest)) {
      return selected;
    }
  }
  if (candidates.length > MAX_CANDIDATES_TO_EVALUATE) {
    throw new CandidateEvaluationLimitError("candidate evaluation exceeded the bounded scan");
  }
  return null;
}

function artifactExpiryIsFuture(binding, now, minimumRemainingMs) {
  return [
    binding.evidenceArtifact,
    binding.package.artifact,
    binding.prepublishPluginRegistry.artifact,
    binding.sharedImage.artifact,
  ].every((artifact) => {
    const expiresAt = timestamp(artifact.expiresAt);
    return expiresAt && expiresAt.milliseconds > now + minimumRemainingMs;
  });
}

function candidateConstituentArtifacts(binding) {
  return [
    ["package", binding.package.artifact],
    ["prepublish plugin registry", binding.prepublishPluginRegistry.artifact],
    ["shared image", binding.sharedImage.artifact],
  ];
}

async function validateCandidateConstituentArtifacts({
  binding,
  minimumRemainingMs,
  now,
  readArtifact,
  unavailableAsMiss,
}) {
  for (const [label, artifact] of candidateConstituentArtifacts(binding)) {
    let metadata;
    try {
      metadata = await readArtifact(artifact.id);
    } catch (error) {
      if (unavailableAsMiss && isMissingMetadataError(error)) {
        throw new CandidateConstituentUnavailableError(
          `full release candidate ${label} artifact is unavailable`,
          { cause: error },
        );
      }
      throw error;
    }
    if (
      !isRecord(metadata) ||
      JSON.stringify(artifactIdentityFromMetadata(metadata, artifact.runAttempt)) !==
        JSON.stringify(artifact) ||
      metadata.workflow_run?.head_sha !== binding.producer.workflowSha
    ) {
      fail(`full release candidate ${label} artifact identity changed`);
    }
    const expiresAt = timestamp(metadata.expires_at);
    if (
      metadata.expired !== false ||
      !expiresAt ||
      expiresAt.milliseconds <= now + minimumRemainingMs
    ) {
      if (unavailableAsMiss) {
        throw new CandidateConstituentUnavailableError(
          `full release candidate ${label} artifact is expired or near expiry`,
        );
      }
      fail(`full release candidate ${label} artifact is expired or near expiry`);
    }
  }
}

export function validateCandidateBinding(
  value,
  { minimumRemainingMs = 0, now = Date.now(), request } = {},
) {
  const binding = validateFullReleaseCandidateBinding(value);
  if (request !== undefined && !exactRequest(binding.request, request)) {
    fail("full release candidate binding request does not match the current request");
  }
  if (!artifactExpiryIsFuture(binding, now, minimumRemainingMs)) {
    fail("full release candidate binding contains expired or near-expiry artifact evidence");
  }
  return binding;
}

export function candidateArtifactJsonFromBinding(value) {
  const binding = validateFullReleaseCandidateBinding(value);
  return JSON.stringify({
    packageArtifactName: binding.package.artifact.name,
    packageArtifactId: binding.package.artifact.id,
    packageArtifactDigest: binding.package.artifact.digest,
    packageArtifactRunId: binding.package.artifact.runId,
    packageArtifactRunAttempt: binding.package.artifact.runAttempt,
    packageFileName: binding.package.fileName,
    packageSourceSha: binding.package.sourceSha,
    packageSha256: binding.package.packageSha256,
    packageVersion: binding.package.version,
    imageArtifactName: binding.sharedImage.artifact.name,
    imageArtifactId: binding.sharedImage.artifact.id,
    imageArtifactDigest: binding.sharedImage.artifact.digest,
    imageArtifactRunId: binding.sharedImage.artifact.runId,
    imageArtifactRunAttempt: binding.sharedImage.artifact.runAttempt,
    imageArchiveSha256: binding.sharedImage.archiveSha256,
    prepublishPluginRegistryArtifactName: binding.prepublishPluginRegistry.artifact.name,
    prepublishPluginRegistryArtifactId: binding.prepublishPluginRegistry.artifact.id,
    prepublishPluginRegistryArtifactDigest: binding.prepublishPluginRegistry.artifact.digest,
    prepublishPluginRegistryArtifactRunId: binding.prepublishPluginRegistry.artifact.runId,
    prepublishPluginRegistryArtifactRunAttempt:
      binding.prepublishPluginRegistry.artifact.runAttempt,
    prepublishPluginRegistryManifestSha256: binding.prepublishPluginRegistry.manifestSha256,
  });
}

function exactArchiveExpected(metadata, request) {
  return {
    artifactDigest: metadata.digest,
    artifactExpiresAt: metadata.expires_at,
    artifactId: positiveInteger(metadata.id),
    artifactName: metadata.name,
    artifactSizeBytes: positiveInteger(metadata.size_in_bytes),
    repository: request.repository,
    runId: positiveInteger(metadata.workflow_run?.id),
    workflowSha: request.toolingSha,
  };
}

function sealedArchiveExpected(binding, metadata) {
  return {
    artifactDigest: `sha256:${binding.evidenceArtifact.digest}`,
    artifactExpiresAt: binding.evidenceArtifact.expiresAt,
    artifactId: positiveInteger(binding.evidenceArtifact.id),
    artifactName: binding.evidenceArtifact.name,
    artifactSizeBytes: positiveInteger(metadata.size_in_bytes),
    repository: binding.request.repository,
    runId: positiveInteger(binding.evidenceArtifact.runId),
    workflowSha: binding.publisher.workflowSha,
  };
}

function manifestFiles(archiveBytes) {
  return inspectActionsArtifactZip(archiveBytes, [CANDIDATE_MANIFEST_FILE], {
    maxArchiveBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
    maxCompressedEntryBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
    maxEntryBytes: MAX_CANDIDATE_MANIFEST_BYTES,
    maxExpandedBytes: MAX_CANDIDATE_MANIFEST_BYTES,
  });
}

function validateCandidateWorkflowRun(run, binding, options = {}) {
  const runId = positiveInteger(binding.producer.runId);
  const runAttempt = positiveInteger(binding.producer.runAttempt);
  if (
    !isRecord(run) ||
    run.id !== runId ||
    run.run_attempt !== runAttempt ||
    run.head_sha !== binding.producer.workflowSha ||
    run.event !== "workflow_dispatch" ||
    binding.producer.workflowPath !== CANDIDATE_PRODUCER_WORKFLOW_PATH ||
    binding.publisher.workflowPath !== CANDIDATE_PRODUCER_WORKFLOW_PATH ||
    !FULL_RELEASE_WORKFLOW_PATHS.has(workflowPath(run.path)) ||
    run.repository?.full_name !== binding.producer.repository ||
    run.head_repository?.full_name !== binding.producer.repository ||
    binding.publisher.runId !== binding.producer.runId ||
    binding.publisher.runAttempt !== binding.producer.runAttempt ||
    binding.publisher.repository !== binding.producer.repository ||
    binding.publisher.workflowSha !== binding.producer.workflowSha
  ) {
    fail("full release candidate producer or publisher workflow attempt is invalid");
  }
  const active = ["in_progress", "waiting"].includes(run.status) && run.conclusion === null;
  const terminal =
    run.status === "completed" && typeof run.conclusion === "string" && run.conclusion.length > 0;
  if (!active && !terminal) {
    const current =
      runId === positiveInteger(options.consumerRunId) &&
      runAttempt === positiveInteger(options.consumerRunAttempt);
    fail(
      current
        ? "current full release candidate producer workflow attempt is not active"
        : "prior full release candidate producer workflow attempt is not active or terminal",
    );
  }
}

function validatedWorkflowJobs(workflowJobs) {
  if (
    !isRecord(workflowJobs) ||
    !Number.isSafeInteger(workflowJobs.total_count) ||
    workflowJobs.total_count < 0 ||
    !Array.isArray(workflowJobs.jobs) ||
    workflowJobs.total_count !== workflowJobs.jobs.length
  ) {
    fail("full release candidate workflow job inventory is incomplete");
  }
  return workflowJobs.jobs;
}

function hasTrustedCandidatePublisher(workflowJobs, candidate, request) {
  // This is a readiness prefilter only. The downloaded v2 manifest supplies
  // the immutable publisher identity that is checked before reuse.
  return validatedWorkflowJobs(workflowJobs).some(
    (job) =>
      isRecord(job) &&
      job.run_id === candidate.runId &&
      positiveInteger(job.run_attempt) !== undefined &&
      job.head_sha === request.toolingSha &&
      typeof job.name === "string" &&
      job.name.endsWith(" / Bind full release candidate evidence") &&
      job.status === "completed" &&
      job.conclusion === "success",
  );
}

function validateCandidateWorkflowJobs(workflowJobs, binding) {
  const jobs = validatedWorkflowJobs(workflowJobs);
  const expectedRunId = positiveInteger(binding.producer.runId);
  const expectedRunAttempt = positiveInteger(binding.producer.runAttempt);
  const matchesExpectedAttempt = (job) =>
    isRecord(job) &&
    job.run_id === expectedRunId &&
    job.run_attempt === expectedRunAttempt &&
    job.head_sha === binding.producer.workflowSha &&
    job.status === "completed" &&
    job.conclusion === "success";
  const producerJobs = jobs.filter(
    (job) =>
      matchesExpectedAttempt(job) &&
      String(job.id) === binding.producer.jobId &&
      job.name === binding.producer.jobName,
  );
  if (producerJobs.length !== 1) {
    fail("full release candidate producer job did not complete successfully");
  }
  const publisherJobs = jobs.filter(
    (job) =>
      matchesExpectedAttempt(job) &&
      String(job.id) === binding.publisher.jobId &&
      job.name === binding.publisher.jobName,
  );
  if (publisherJobs.length !== 1) {
    fail("full release candidate publisher job did not complete successfully");
  }
}

export async function loadSelectedFullReleaseCandidate({
  deadlineMs,
  downloadArchive = downloadExactActionsArtifactArchive,
  fetchImpl,
  now = Date.now(),
  readArtifact,
  readRunAttempt,
  readWorkflowJobs,
  request,
  selected,
  token,
}) {
  const validatedRequest = validateFullReleaseCandidateRequest(request);
  if (
    !isRecord(selected?.artifact) ||
    typeof readArtifact !== "function" ||
    typeof readRunAttempt !== "function" ||
    typeof readWorkflowJobs !== "function"
  ) {
    fail("selected full release candidate metadata is invalid");
  }
  requireDiscoveryBudget(deadlineMs);
  let downloaded;
  try {
    downloaded = await downloadArchive({
      deadlineMs,
      expected: exactArchiveExpected(selected.artifact, validatedRequest),
      fetchImpl,
      maxArchiveBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
      token,
    });
  } catch (error) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new CandidateDiscoveryBudgetError("candidate discovery exceeded its time budget", {
        cause: error,
      });
    }
    throw error;
  }
  const manifestBytes = manifestFiles(downloaded.archiveBytes).get(CANDIDATE_MANIFEST_FILE);
  const binding = validateCandidateBinding(
    bindingFromArchive(manifestBytes, downloaded.artifactMetadata),
    {
      minimumRemainingMs: MIN_CANDIDATE_REMAINING_MS,
      now,
      request: validatedRequest,
    },
  );
  requireDiscoveryBudget(deadlineMs);
  await validateCandidateConstituentArtifacts({
    binding,
    minimumRemainingMs: MIN_CANDIDATE_REMAINING_MS,
    now,
    readArtifact,
    unavailableAsMiss: true,
  });
  requireDiscoveryBudget(deadlineMs);
  const run = await readRunAttempt(binding.producer.runId, binding.producer.runAttempt);
  validateCandidateWorkflowRun(run, binding);
  requireDiscoveryBudget(deadlineMs);
  validateCandidateWorkflowJobs(
    await readWorkflowJobs(binding.producer.runId, binding.producer.runAttempt),
    binding,
  );
  return binding;
}

export function resolveCandidateBinding({
  freshBinding,
  now = Date.now(),
  request,
  required,
  reusedBinding,
}) {
  const hasFresh = freshBinding !== null && freshBinding !== undefined;
  const hasReused = reusedBinding !== null && reusedBinding !== undefined;
  if (!required) {
    if (hasFresh || hasReused) {
      fail("full release candidate binding exists when candidate preparation is not required");
    }
    return null;
  }
  if (!request) {
    fail("full release candidate request is required");
  }
  if (hasFresh === hasReused) {
    fail("exactly one fresh or reused full release candidate binding is required");
  }
  return validateCandidateBinding(hasReused ? reusedBinding : freshBinding, {
    minimumRemainingMs: MIN_CANDIDATE_REMAINING_MS,
    now,
    request,
  });
}

export async function verifySealedFullReleaseCandidate({
  binding: bindingInput,
  consumerRunAttempt,
  consumerRunId,
  downloadArchive = downloadExactActionsArtifactArchive,
  fetchImpl,
  now = Date.now(),
  readArtifact,
  readRunAttempt,
  readWorkflowJobs,
  token,
}) {
  const binding = validateCandidateBinding(bindingInput, { now });
  const artifactMetadata = await readArtifact(binding.evidenceArtifact.id);
  await validateCandidateConstituentArtifacts({
    binding,
    minimumRemainingMs: 0,
    now,
    readArtifact,
    unavailableAsMiss: false,
  });
  const run = await readRunAttempt(binding.producer.runId, binding.producer.runAttempt);
  validateCandidateWorkflowRun(run, binding, { consumerRunAttempt, consumerRunId });
  validateCandidateWorkflowJobs(
    await readWorkflowJobs(binding.producer.runId, binding.producer.runAttempt),
    binding,
  );
  const downloaded = await downloadArchive({
    expected: sealedArchiveExpected(binding, artifactMetadata),
    fetchImpl,
    maxArchiveBytes: MAX_CANDIDATE_ARCHIVE_BYTES,
    token,
  });
  const actualIdentity = artifactIdentityFromMetadata(
    downloaded.artifactMetadata,
    binding.producer.runAttempt,
  );
  if (JSON.stringify(actualIdentity) !== JSON.stringify(binding.evidenceArtifact)) {
    fail("sealed full release candidate artifact identity changed");
  }
  const manifestBytes = manifestFiles(downloaded.archiveBytes).get(CANDIDATE_MANIFEST_FILE);
  const verified = validateCandidateBinding(
    bindingFromArchive(manifestBytes, downloaded.artifactMetadata),
    { now, request: binding.request },
  );
  if (JSON.stringify(verified) !== JSON.stringify(binding)) {
    fail("sealed full release candidate binding differs from its manifest");
  }
  return verified;
}
