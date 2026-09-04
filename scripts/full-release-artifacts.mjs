#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  candidateRequestSha256,
  validateFullReleaseCandidateBinding,
  validateFullReleaseCandidateRequest,
} from "./full-release-candidate-contract.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZip,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { parseReleaseVersion } from "./lib/release-version.mjs";
import {
  QUALIFIED_NPM_PREFLIGHT_SCHEMA,
  validatePreparedNpmBundleDescriptor,
  verifyNpmBundleProducer,
} from "./npm-prepared-bundle.mjs";
import { runReleaseToolingGh } from "./release-tooling-identity.mjs";

const WORKFLOW = ".github/workflows/full-release-artifacts.yml";
const SCHEMA = "openclaw.full-release-artifact-receipt/v1";
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const WAIT_MINUTES = 350;
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^[1-9][0-9]*$/u;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function api(repository, path) {
  return JSON.parse(runReleaseToolingGh(["api", `repos/${repository}/${path}`]));
}

function artifactRequest(env) {
  const stage = env.ARTIFACT_STAGE;
  const dispatchId = env.ARTIFACT_DISPATCH_ID;
  requireValue(["npm", "candidate", "docker"].includes(stage), "Invalid artifact stage.");
  requireValue(
    new RegExp(`^full-release-validation-[1-9][0-9]*-[1-9][0-9]*-artifacts-${stage}$`, "u").test(
      dispatchId,
    ),
    "Artifact producer requires an exact FRV dispatch identity.",
  );
  requireValue(SHA.test(env.TARGET_SHA), "Invalid artifact source SHA.");
  requireValue(SHA.test(env.PARENT_WORKFLOW_SHA), "Invalid artifact tooling SHA.");
  requireValue(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY),
    "Invalid artifact repository.",
  );
  requireValue(
    typeof env.RELEASE_TAG === "string" &&
      env.RELEASE_TAG.startsWith("v") &&
      parseReleaseVersion(env.RELEASE_TAG.slice(1))?.version === env.RELEASE_TAG.slice(1),
    "Invalid artifact release tag.",
  );
  requireValue(
    ["all", "prepare"].includes(env.PREFLIGHT_PHASE),
    "Invalid artifact npm preparation phase.",
  );
  requireValue(
    typeof env.CHILD_WORKFLOW_REF === "string" &&
      /^\S+$/u.test(env.CHILD_WORKFLOW_REF) &&
      [...env.CHILD_WORKFLOW_REF].every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
    "Invalid artifact workflow ref.",
  );
  return {
    stage,
    dispatchId,
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.TARGET_SHA,
    toolingSha: env.PARENT_WORKFLOW_SHA,
    workflowRef: env.CHILD_WORKFLOW_REF,
    releaseTag: env.RELEASE_TAG,
    preflightPhase: env.PREFLIGHT_PHASE,
  };
}

function validateArtifactParent(request, parent, env) {
  const [, runId, attempt] = request.dispatchId.match(
    /^full-release-validation-([0-9]+)-([0-9]+)-artifacts-/u,
  );
  requireValue(
    String(parent.id) === runId &&
      String(parent.run_attempt) === attempt &&
      parent.event === "workflow_dispatch" &&
      String(parent.path).split("@", 1)[0] === ".github/workflows/full-release-validation.yml" &&
      parent.repository?.full_name === request.repository &&
      parent.head_repository?.full_name === request.repository &&
      parent.head_sha === request.toolingSha &&
      parent.head_branch === request.workflowRef &&
      // GitHub reports a parent as "queued" whenever any of its jobs is still
      // waiting for a runner, even while this producer runs from it; both mean
      // the parent is live and unfinished. A completed parent stays rejected.
      (parent.status === "in_progress" || parent.status === "queued") &&
      parent.conclusion === null &&
      env.GITHUB_SHA === request.toolingSha &&
      env.GITHUB_REF_NAME === request.workflowRef,
    "Artifact preparation requires its exact active FRV parent and frozen tooling.",
  );
}

function readArtifactRun(request, runId, runAttempt) {
  requireValue(
    DECIMAL.test(String(runId)) && DECIMAL.test(String(runAttempt)),
    "Invalid artifact producer tuple.",
  );
  const run = api(request.repository, `actions/runs/${runId}`);
  requireValue(
    String(run.id) === String(runId) &&
      String(run.run_attempt) === String(runAttempt) &&
      run.event === "workflow_dispatch" &&
      String(run.path).split("@", 1)[0] === WORKFLOW &&
      run.repository?.full_name === request.repository &&
      run.head_repository?.full_name === request.repository &&
      run.head_sha === request.toolingSha &&
      run.head_branch === request.workflowRef &&
      run.display_title === `Full Release Artifacts ${request.dispatchId}`,
    "Artifact producer run identity changed.",
  );
  requireValue(
    run.status !== "completed" || run.conclusion === "success",
    `Artifact ${request.stage} producer failed: ${run.html_url}`,
  );
  return run;
}

function validateArtifactReceipt(receipt, request, runId, runAttempt) {
  const { outputs, ...identity } = receipt;
  requireValue(
    isDeepStrictEqual(identity, {
      schema: SCHEMA,
      ...request,
      runId: String(runId),
      runAttempt: String(runAttempt),
    }) && isRecord(outputs),
    "Artifact receipt does not match its exact request and producer attempt.",
  );
  if (request.stage === "npm") {
    const raw = JSON.parse(outputs.prepared_bundle_json);
    validatePreparedNpmBundleDescriptor({
      descriptor: raw,
      repository: request.repository,
      sourceSha: request.sourceSha,
      toolingSha: request.toolingSha,
    });
    requireValue(
      raw.producer.runId === String(runId) && raw.producer.runAttempt === String(runAttempt),
      "Raw npm bundle came from another artifact producer.",
    );
    if (request.preflightPhase === "all") {
      const qualified = JSON.parse(outputs.qualified_preflight_bundle_json);
      requireValue(
        qualified.schema === QUALIFIED_NPM_PREFLIGHT_SCHEMA &&
          qualified.source.sha === request.sourceSha &&
          qualified.producer.runId === String(runId) &&
          qualified.producer.runAttempt === String(runAttempt) &&
          qualified.producer.workflowSha === request.toolingSha,
        "Qualified npm bundle came from another artifact producer.",
      );
    }
  } else if (request.stage === "candidate") {
    const binding = validateFullReleaseCandidateBinding(JSON.parse(outputs.binding_json));
    requireValue(
      outputs.state === "ready" &&
        binding.request.targetSha === request.sourceSha &&
        binding.request.toolingSha === request.toolingSha &&
        binding.request.repository === request.repository,
      "Candidate receipt does not match the source and tooling.",
    );
  } else {
    requireValue(
      outputs.prepared_run_id === String(runId) &&
        outputs.prepared_run_attempt === String(runAttempt) &&
        SHA256.test(outputs.prepared_manifest_sha256) &&
        typeof outputs.prepared_artifact_name === "string" &&
        outputs.prepared_artifact_name,
      "Docker receipt does not match its artifact producer.",
    );
  }
  return outputs;
}

async function readArtifact(request, runId, name, fileName) {
  const scope = runId ? `actions/runs/${runId}` : "actions";
  const response = api(
    request.repository,
    `${scope}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
  );
  requireValue(
    Array.isArray(response.artifacts) &&
      Number.isSafeInteger(response.total_count) &&
      response.total_count <= 100 &&
      response.artifacts.length === response.total_count,
    "Artifact descriptor inventory is incomplete.",
  );
  const matches = response.artifacts.filter((artifact) => artifact.name === name);
  requireValue(matches.length <= 1, "Artifact descriptor is ambiguous.");
  if (!matches.length) {
    return undefined;
  }
  const metadata = matches[0];
  const { archiveBytes } = await downloadExactActionsArtifactArchive({
    expected: {
      repository: request.repository,
      artifactId: metadata.id,
      artifactName: name,
      artifactDigest: metadata.digest,
      artifactSizeBytes: metadata.size_in_bytes,
      artifactExpiresAt: metadata.expires_at,
      runId: Number(runId ?? metadata.workflow_run?.id),
      workflowSha: request.toolingSha,
    },
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    token: process.env.GH_TOKEN,
  });
  const files = inspectActionsArtifactZip(archiveBytes, [fileName], {
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxCompressedEntryBytes: MAX_ARCHIVE_BYTES,
    maxEntryBytes: MAX_RECEIPT_BYTES,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
  });
  return {
    runId: String(metadata.workflow_run.id),
    value: JSON.parse(files.get(fileName).toString("utf8")),
  };
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    requireValue(
      /^[a-z][a-z0-9_]*$/u.test(key) && typeof value === "string" && !/[\r\n]/u.test(value),
      "Artifact outputs must be single-line strings.",
    );
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function resolveProducer(request, env) {
  let record;
  if (env.GITHUB_RUN_ATTEMPT === "1") {
    record = { request, runId: env.ARTIFACT_RUN_ID, runAttempt: env.ARTIFACT_RUN_ATTEMPT };
  } else {
    const artifact = await readArtifact(
      request,
      undefined,
      `${request.dispatchId}-dispatch`,
      "dispatch.json",
    );
    record = artifact?.value;
    requireValue(
      record && artifact.runId === record.runId && isDeepStrictEqual(record.request, request),
      "Original artifact dispatch is unavailable or changed; start a fresh FRV run.",
    );
  }
  readArtifactRun(request, record.runId, record.runAttempt);
  output({ run_id: record.runId, run_attempt: record.runAttempt, dispatch_id: request.dispatchId });
}

async function waitForArtifact(request, env) {
  const runId = env.ARTIFACT_RUN_ID;
  const runAttempt = env.ARTIFACT_RUN_ATTEMPT;
  requireValue(["raw", "receipt"].includes(env.ARTIFACT_OUTPUT), "Invalid artifact output.");
  const raw = env.ARTIFACT_OUTPUT === "raw";
  requireValue(!raw || request.stage === "npm", "Only npm exposes early raw artifacts.");
  const name = raw
    ? `openclaw-npm-package-descriptor-${runId}-${runAttempt}`
    : `full-release-artifact-receipt-${runId}-${runAttempt}`;
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  let receipt;
  while (Date.now() < deadline) {
    const run = readArtifactRun(request, runId, runAttempt);
    if (raw || run.status === "completed") {
      let values;
      receipt ??= (
        await readArtifact(
          request,
          runId,
          name,
          raw ? "prepared-npm-bundle.json" : "artifact-receipt.json",
        )
      )?.value;
      if (receipt && raw) {
        validatePreparedNpmBundleDescriptor({
          descriptor: receipt,
          repository: request.repository,
          sourceSha: request.sourceSha,
          toolingSha: request.toolingSha,
        });
        requireValue(
          receipt.producer.runId === String(runId) &&
            receipt.producer.runAttempt === String(runAttempt),
          "Raw npm producer identity changed.",
        );
        const job = api(request.repository, `actions/jobs/${receipt.producer.jobId}`);
        if (job.status === "completed") {
          verifyNpmBundleProducer({
            producer: receipt.producer,
            repository: request.repository,
            toolingSha: request.toolingSha,
          });
          values = { prepared_bundle_json: JSON.stringify(receipt) };
        }
      } else if (receipt) {
        values = validateArtifactReceipt(receipt, request, runId, runAttempt);
        if (request.stage === "npm" && request.preflightPhase === "all") {
          const qualified = JSON.parse(values.qualified_preflight_bundle_json);
          verifyNpmBundleProducer({
            producer: qualified.producer,
            repository: request.repository,
            toolingSha: request.toolingSha,
            qualified: true,
            requireCompletedParent: true,
          });
        }
        if (request.stage === "candidate") {
          const binding = JSON.parse(values.binding_json);
          requireValue(
            binding.requestSha256 ===
              candidateRequestSha256(JSON.parse(env.CANDIDATE_REQUEST_JSON)),
            "Candidate request changed during acquisition.",
          );
        }
      }
      if (values) {
        // Downloads can outlive a producer rerun; historical job success does
        // not authorize handing off evidence from a replaced attempt.
        readArtifactRun(request, runId, runAttempt);
        output(values);
        return;
      }
    }
    console.error(
      `Waiting for ${request.stage} ${raw ? "package" : "qualification"}: ${run.html_url}`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 15_000);
    });
  }
  throw new Error(`Artifact producer did not complete within ${WAIT_MINUTES} minutes: ${runId}`);
}

async function main() {
  const env = process.env;
  const request = artifactRequest(env);
  const command = process.argv[2];
  if (command === "admit") {
    const parentId = request.dispatchId.match(/^full-release-validation-([0-9]+)-/u)[1];
    validateArtifactParent(request, api(request.repository, `actions/runs/${parentId}`), env);
    if (request.stage === "candidate") {
      const candidate = validateFullReleaseCandidateRequest(JSON.parse(env.CANDIDATE_REQUEST_JSON));
      requireValue(
        candidate.repository === request.repository &&
          candidate.targetSha === request.sourceSha &&
          candidate.toolingSha === request.toolingSha,
        "Candidate request source or tooling changed.",
      );
      output({ request_sha256: candidateRequestSha256(candidate) });
    }
    // The producer owns its discovery record too: a parent rerun must not need
    // a cache or an artifact attached to the attempt it is replacing.
    const directory = join(env.RUNNER_TEMP, "full-release-artifact-dispatch");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "dispatch.json"),
      `${JSON.stringify({
        request,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
      })}\n`,
    );
    output({ directory, dispatch_name: `${request.dispatchId}-dispatch` });
  } else if (command === "receipt") {
    const directory = join(env.RUNNER_TEMP, "full-release-artifact-receipt");
    const receipt = {
      schema: SCHEMA,
      ...request,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      outputs: JSON.parse(env.ARTIFACT_OUTPUTS_JSON),
    };
    validateArtifactReceipt(receipt, request, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
    const json = JSON.stringify(receipt);
    requireValue(
      Buffer.byteLength(json) <= MAX_RECEIPT_BYTES,
      "Artifact receipt exceeds its byte limit.",
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "artifact-receipt.json"), `${json}\n`);
    output({ directory });
  } else if (command === "wait") {
    await waitForArtifact(request, env);
  } else if (command === "resolve") {
    await resolveProducer(request, env);
  } else {
    throw new Error("Usage: full-release-artifacts.mjs <admit|resolve|receipt|wait>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
