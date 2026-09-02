#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { verifyNpmBundleProducer } from "./npm-prepared-bundle.mjs";
import {
  runReleaseToolingGh,
  validateReleaseToolingIdentity,
} from "./release-tooling-identity.mjs";

const FULL_RELEASE_WORKFLOW = ".github/workflows/full-release-validation.yml";
const ARTIFACT_WORKFLOW = ".github/workflows/full-release-artifacts.yml";
const QUALIFIED_WORKFLOWS = new Set([FULL_RELEASE_WORKFLOW, ARTIFACT_WORKFLOW]);

/**
 * @typedef {object} NpmPreflightProducerOptions
 * @property {unknown} manifest
 * @property {string} repository
 * @property {string} workflowFullRef
 * @property {string} workflowSha
 * @property {string | number} runId
 * @property {string | number} runAttempt
 * @property {string} [workflowPath]
 * @property {unknown} [fullReleaseManifest]
 * @property {string | number} [fullReleaseRunId]
 * @property {string | number} [fullReleaseRunAttempt]
 */

/**
 * @typedef {object} FullReleaseNpmPreflightOptions
 * @property {unknown} manifest
 * @property {string} [repository]
 * @property {string | number} runId
 * @property {string | number} runAttempt
 * @property {string} sourceSha
 * @property {string} toolingSha
 */

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

/** @param {NpmPreflightProducerOptions} options */
export function validateNpmPreflightProducer({
  manifest,
  repository,
  workflowFullRef,
  workflowSha,
  runId,
  runAttempt,
  workflowPath = ".github/workflows/openclaw-npm-release.yml",
  fullReleaseManifest,
  fullReleaseRunId,
  fullReleaseRunAttempt,
}) {
  if (QUALIFIED_WORKFLOWS.has(workflowPath) && manifest?.version !== 3) {
    throw new Error("FRV npm preflight requires qualified version 3 producer evidence.");
  }
  // Published v1 preflights did not record the original ref qualifier. Keep
  // their existing recovery contract without inferring historical provenance.
  if (manifest?.version === 1 && !Object.hasOwn(manifest, "producer")) {
    return { originalWorkflowRef: null, provenance: "legacy-unrecorded" };
  }
  if (![2, 3].includes(manifest?.version) || !isRecord(manifest.producer)) {
    throw new Error("npm preflight producer metadata is missing or unsupported.");
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
    !/^refs\/(?:heads|tags)\/.+$/u.test(workflowFullRef ?? "") ||
    !/^[a-f0-9]{40}$/u.test(workflowSha ?? "") ||
    !/^[1-9][0-9]*$/u.test(String(runId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(runAttempt ?? "")) ||
    ![".github/workflows/openclaw-npm-release.yml", ...QUALIFIED_WORKFLOWS].includes(
      workflowPath,
    ) ||
    (manifest.version === 2 && workflowPath !== ".github/workflows/openclaw-npm-release.yml")
  ) {
    throw new Error("npm preflight expected producer identity is invalid.");
  }
  const expected = {
    repository,
    workflowRef: `${repository}/${workflowPath}@${workflowFullRef}`,
    workflowSha,
    runId: String(runId),
    runAttempt: String(runAttempt),
    ...(manifest.version === 3
      ? {
          producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
          jobId: manifest.producer.jobId,
          jobName: manifest.producer.jobName,
        }
      : {}),
  };
  if (
    manifest.version === 3 &&
    (!/^[1-9][0-9]*$/u.test(manifest.producer.jobId ?? "") ||
      typeof manifest.producer.jobName !== "string" ||
      !/(?:^| \/ )Qualify prepared npm package$/u.test(manifest.producer.jobName) ||
      manifest.preparedBundle?.schema !== "openclaw.prepared-npm-bundle/v1" ||
      manifest.preparedBundle.source?.sha !== manifest.releaseSha ||
      manifest.preparedBundle.package?.sha256 !== manifest.tarballSha256 ||
      manifest.preparedBundle.producer?.repository !== repository ||
      manifest.preparedBundle.producer?.workflowSha !== workflowSha)
  ) {
    throw new Error("npm preflight qualification does not bind the prepared package producer.");
  }
  if (
    Object.keys(manifest.producer).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => manifest.producer[key] !== value)
  ) {
    throw new Error("npm preflight immutable producer identity mismatch.");
  }
  if (workflowPath === ARTIFACT_WORKFLOW) {
    const qualified = validateFullReleaseNpmPreflight({
      manifest: fullReleaseManifest,
      repository,
      runId: fullReleaseRunId,
      runAttempt: fullReleaseRunAttempt,
      sourceSha: manifest.releaseSha,
      toolingSha: workflowSha,
    });
    if (!isDeepStrictEqual(qualified.producer, manifest.producer)) {
      throw new Error("npm artifact producer is not the selected full release qualification.");
    }
  }
  return { originalWorkflowRef: expected.workflowRef, provenance: "immutable-manifest" };
}

/** @param {NpmPreflightProducerOptions & {manifestSha256?: string, runGh?: typeof runReleaseToolingGh}} options */
export function verifyNpmPreflightProducer({ runGh = runReleaseToolingGh, ...options }) {
  const identity = validateNpmPreflightProducer(options);
  if (options.manifest.version !== 3) {
    return identity;
  }
  const producer = options.manifest.producer;
  if (QUALIFIED_WORKFLOWS.has(options.workflowPath)) {
    const { descriptor: qualified } = resolveFullReleaseNpmPreflight({
      manifest: options.fullReleaseManifest,
      repository: options.repository,
      runId: options.fullReleaseRunId ?? options.runId,
      runAttempt: options.fullReleaseRunAttempt ?? options.runAttempt,
      sourceSha: options.manifest.releaseSha,
      toolingSha: options.workflowSha,
      runGh,
    });
    if (
      !isDeepStrictEqual(qualified.producer, producer) ||
      qualified.manifestSha256 !== options.manifestSha256
    ) {
      throw new Error("npm preflight differs from the exact full release qualification.");
    }
    return identity;
  }
  verifyNpmBundleProducer({
    producer,
    repository: options.repository,
    toolingSha: options.workflowSha,
    qualified: true,
    requireCompletedParent: true,
    runGh,
  });
  return identity;
}

/** @param {FullReleaseNpmPreflightOptions} options */
export function validateFullReleaseNpmPreflight({
  manifest,
  repository,
  runId,
  runAttempt,
  sourceSha,
  toolingSha,
}) {
  const qualified = manifest?.publicationArtifacts?.npmPreflight;
  const producer = qualified?.producer;
  const producerRepository = repository ?? producer?.repository;
  const independentProducer =
    producer?.workflowRef ===
    `${producerRepository}/${ARTIFACT_WORKFLOW}@${manifest?.workflowFullRef}`;
  if (
    !/^[1-9][0-9]*$/u.test(String(runId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(runAttempt ?? "")) ||
    manifest?.workflowName !== "Full Release Validation" ||
    String(manifest.runId) !== String(runId) ||
    String(manifest.runAttempt) !== String(runAttempt) ||
    manifest.targetSha !== sourceSha ||
    manifest.workflowSha !== toolingSha ||
    qualified?.schema !== "openclaw.qualified-npm-preflight/v1" ||
    qualified.source?.sha !== sourceSha ||
    !/^[a-f0-9]{64}$/u.test(qualified.manifestSha256 ?? "") ||
    !/^[1-9][0-9]*$/u.test(qualified.artifact?.id ?? "") ||
    !/^[a-f0-9]{64}$/u.test(qualified.artifact?.digest ?? "") ||
    !/^openclaw-npm-preflight-[A-Za-z0-9_.-]+$/u.test(qualified.artifact?.name ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(producerRepository ?? "") ||
    producer?.repository !== producerRepository ||
    !/^[1-9][0-9]*$/u.test(producer?.runId ?? "") ||
    !/^[1-9][0-9]*$/u.test(producer?.runAttempt ?? "") ||
    qualified.artifact.runId !== producer?.runId ||
    qualified.artifact.runAttempt !== producer?.runAttempt ||
    producer?.workflowSha !== toolingSha ||
    (independentProducer
      ? !/^refs\/(?:heads|tags)\/.+$/u.test(manifest.workflowFullRef ?? "")
      : producer?.runId !== String(runId) ||
        producer?.runAttempt !== String(runAttempt) ||
        !producer?.workflowRef?.startsWith(`${producerRepository}/${FULL_RELEASE_WORKFLOW}@refs/`))
  ) {
    throw new Error(
      "Full Release Validation does not bind a qualified npm preflight for this exact release and attempt; supply its historical separate preflight run when recovering an older release.",
    );
  }
  return qualified;
}

// The FRV run authorizes publication; its descriptor identifies the independent
// producer whose immutable archive survives a rerun of that authorization.
/** @param {FullReleaseNpmPreflightOptions & {repository: string, runGh?: typeof runReleaseToolingGh}} options */
export function resolveFullReleaseNpmPreflight({ runGh = runReleaseToolingGh, ...options }) {
  const descriptor = validateFullReleaseNpmPreflight(options);
  const producer = descriptor.producer;
  const { run } = verifyNpmBundleProducer({
    producer,
    repository: options.repository,
    toolingSha: options.toolingSha,
    qualified: true,
    requireCompletedParent: true,
    runGh,
  });
  const artifact = parseJson(
    runGh(["api", `repos/${options.repository}/actions/artifacts/${descriptor.artifact.id}`]),
    "qualified npm preflight artifact",
  );
  if (
    String(artifact.id) !== descriptor.artifact.id ||
    artifact.name !== descriptor.artifact.name ||
    artifact.digest !== `sha256:${descriptor.artifact.digest}` ||
    artifact.expired !== false ||
    String(artifact.workflow_run?.id) !== producer.runId ||
    artifact.workflow_run?.head_sha !== options.toolingSha
  ) {
    throw new Error("Qualified npm preflight artifact identity changed.");
  }
  return { descriptor, producer, run, artifact };
}

/** @param {Parameters<typeof resolveFullReleaseNpmPreflight>[0] & {outputDir: string, token: string, fetchImpl?: typeof fetch, archivePath?: string, deadlineMs?: number}} options */
export async function downloadFullReleaseNpmPreflight({
  outputDir,
  token,
  fetchImpl,
  archivePath,
  deadlineMs,
  ...options
}) {
  const resolved = resolveFullReleaseNpmPreflight(options);
  const { descriptor, producer, artifact } = resolved;
  const { archiveBytes } = await downloadExactActionsArtifactArchive({
    token,
    fetchImpl,
    archivePath,
    deadlineMs,
    expected: {
      repository: options.repository,
      artifactId: Number(descriptor.artifact.id),
      artifactName: descriptor.artifact.name,
      artifactDigest: `sha256:${descriptor.artifact.digest}`,
      artifactSizeBytes: artifact.size_in_bytes,
      artifactExpiresAt: artifact.expires_at,
      runId: Number(producer.runId),
      workflowSha: options.toolingSha,
    },
  });
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    minEntries: 1,
    maxEntries: 1024,
    allowPath: (name) =>
      /^[A-Za-z0-9_.-]+\.(?:tgz|json|txt)$|^core-packages-SHA256SUMS$|^dependency-evidence\/[A-Za-z0-9_.-]+\.(?:json|md)$/u.test(
        name,
      ),
    maxEntryBytes: (name) => (name.endsWith(".tgz") ? 192 : 17) * 1024 * 1024,
  });
  const manifestBytes = files.get("preflight-manifest.json");
  if (
    !manifestBytes ||
    createHash("sha256").update(manifestBytes).digest("hex") !== descriptor.manifestSha256
  ) {
    throw new Error("Downloaded npm preflight manifest differs from its qualified descriptor.");
  }
  mkdirSync(outputDir, { recursive: true });
  if (readdirSync(outputDir).length !== 0) {
    throw new Error("Qualified npm preflight destination must be empty.");
  }
  for (const [name, bytes] of files) {
    const path = join(outputDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: "wx" });
  }
  return resolved;
}

// Actions exposes a short head branch for tags too; a matching branch makes
// producer provenance ambiguous even if both refs currently point at one SHA.
export function validateReleasePreflightTagIdentity({ branches, ...identity }) {
  if (
    !Array.isArray(branches) ||
    branches.some(
      (branch) =>
        !isRecord(branch) ||
        typeof branch.ref !== "string" ||
        branch.ref === `refs/heads/${identity.workflowRef}`,
    )
  ) {
    throw new Error("npm preflight has ambiguous protected tag provenance.");
  }
  const validated = validateReleaseToolingIdentity(identity);
  if (validated.route !== "protected-tag") {
    throw new Error("npm preflight producer must use a protected tag.");
  }
  return validated;
}

export function verifyReleasePreflightToolingIdentity({
  repository,
  publisherSha,
  runGh = runReleaseToolingGh,
  workflowFullRef,
  workflowRef,
  workflowSha,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) {
    throw new Error("npm preflight repository must be owner/name.");
  }
  if (!/^[a-f0-9]{40}$/u.test(publisherSha ?? "")) {
    throw new Error("publisher workflow SHA must be a lowercase 40-character commit SHA.");
  }
  const normalizedRepository = repository;
  const targetSha = publisherSha;
  const identity = { workflowFullRef, workflowRef, workflowSha };
  const tagRef = parseJson(
    runGh(["api", `repos/${normalizedRepository}/git/ref/tags/${workflowRef}`, "--method", "GET"]),
    "npm preflight producer tag",
  );
  const branches = parseJson(
    runGh([
      "api",
      `repos/${normalizedRepository}/git/matching-refs/heads/${workflowRef}`,
      "--method",
      "GET",
    ]),
    "npm preflight producer branches",
  );
  const validated = validateReleasePreflightTagIdentity({ ...identity, tagRef, branches });
  // Producer evidence and current publication authority are distinct. Require
  // the producer on both trusted main and the current publisher's ancestry.
  for (const target of ["main", targetSha]) {
    const comparison = parseJson(
      runGh([
        "api",
        `repos/${normalizedRepository}/compare/${validated.sha}...${target}`,
        "--method",
        "GET",
        "--jq",
        "{status}",
      ]),
      "npm preflight producer ancestry",
    );
    if (comparison?.status !== "ahead" && comparison?.status !== "identical") {
      throw new Error(`npm preflight producer is not reachable from ${target}.`);
    }
  }
  return validated;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { values } = parseArgs({
      options: {
        repository: { type: "string" },
        "workflow-ref": { type: "string" },
        "workflow-full-ref": { type: "string" },
        "workflow-sha": { type: "string" },
        "publisher-sha": { type: "string" },
        manifest: { type: "string" },
        "run-id": { type: "string" },
        "run-attempt": { type: "string" },
        "workflow-path": { type: "string" },
        "full-release-manifest": { type: "string" },
        "full-release-run-id": { type: "string" },
        "full-release-run-attempt": { type: "string" },
        "resolve-full-release-manifest": { type: "string" },
        "source-sha": { type: "string" },
        "output-dir": { type: "string" },
      },
    });
    const options = {
      repository: values.repository,
      workflowRef: values["workflow-ref"],
      workflowFullRef: values["workflow-full-ref"],
      workflowSha: values["workflow-sha"],
      publisherSha: values["publisher-sha"],
      workflowPath: values["workflow-path"],
    };
    let identity;
    if (values["resolve-full-release-manifest"]) {
      const resolution = {
        manifest: parseJson(
          readFileSync(values["resolve-full-release-manifest"], "utf8"),
          "full release manifest",
        ),
        repository: values.repository,
        runId: values["run-id"],
        runAttempt: values["run-attempt"],
        sourceSha: values["source-sha"],
        toolingSha: values["workflow-sha"],
      };
      identity = values["output-dir"]
        ? await downloadFullReleaseNpmPreflight({
            ...resolution,
            outputDir: values["output-dir"],
            token: process.env.GH_TOKEN,
          })
        : resolveFullReleaseNpmPreflight(resolution);
    } else {
      identity = values.manifest
        ? verifyNpmPreflightProducer({
            ...options,
            manifest: parseJson(readFileSync(values.manifest, "utf8"), "npm preflight manifest"),
            manifestSha256: createHash("sha256")
              .update(readFileSync(values.manifest))
              .digest("hex"),
            fullReleaseManifest: values["full-release-manifest"]
              ? parseJson(
                  readFileSync(values["full-release-manifest"], "utf8"),
                  "full release manifest",
                )
              : undefined,
            runId: values["run-id"],
            runAttempt: values["run-attempt"],
            fullReleaseRunId: values["full-release-run-id"],
            fullReleaseRunAttempt: values["full-release-run-attempt"],
          })
        : verifyReleasePreflightToolingIdentity(options);
    }
    process.stdout.write(`${JSON.stringify(identity)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
