#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { isRecord } from "./lib/record-shared.mjs";
import { verifyNpmBundleProducer } from "./npm-prepared-bundle.mjs";
import {
  runReleaseToolingGh,
  validateReleaseToolingIdentity,
} from "./release-tooling-identity.mjs";

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

export function validateNpmPreflightProducer({
  manifest,
  repository,
  workflowFullRef,
  workflowSha,
  runId,
  runAttempt,
  workflowPath = ".github/workflows/openclaw-npm-release.yml",
}) {
  if (workflowPath === ".github/workflows/full-release-validation.yml" && manifest?.version !== 3) {
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
    ![
      ".github/workflows/openclaw-npm-release.yml",
      ".github/workflows/full-release-validation.yml",
    ].includes(workflowPath) ||
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
  return { originalWorkflowRef: expected.workflowRef, provenance: "immutable-manifest" };
}

export function verifyNpmPreflightProducer({ runGh = runReleaseToolingGh, ...options }) {
  const identity = validateNpmPreflightProducer(options);
  if (options.manifest.version !== 3) {
    return identity;
  }
  const producer = options.manifest.producer;
  if (options.workflowPath === ".github/workflows/full-release-validation.yml") {
    const qualified = validateFullReleaseNpmPreflight({
      manifest: options.fullReleaseManifest,
      runId: options.runId,
      runAttempt: options.runAttempt,
      sourceSha: options.manifest.releaseSha,
      toolingSha: options.workflowSha,
    });
    if (
      !isDeepStrictEqual(qualified.producer, producer) ||
      qualified.manifestSha256 !== options.manifestSha256
    ) {
      throw new Error("npm preflight differs from the exact full release qualification.");
    }
    const artifact = parseJson(
      runGh(["api", `repos/${options.repository}/actions/artifacts/${qualified.artifact.id}`]),
      "qualified npm preflight artifact",
    );
    if (
      String(artifact.id) !== qualified.artifact.id ||
      artifact.name !== qualified.artifact.name ||
      artifact.digest !== `sha256:${qualified.artifact.digest}` ||
      artifact.expired !== false ||
      String(artifact.workflow_run?.id) !== qualified.artifact.runId ||
      artifact.workflow_run?.head_sha !== options.workflowSha
    ) {
      throw new Error("Qualified npm preflight artifact identity changed.");
    }
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

export function validateFullReleaseNpmPreflight({
  manifest,
  runId,
  runAttempt,
  sourceSha,
  toolingSha,
}) {
  const qualified = manifest?.publicationArtifacts?.npmPreflight;
  if (
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
    typeof qualified.artifact?.name !== "string" ||
    !qualified.artifact.name.startsWith("openclaw-npm-preflight-") ||
    qualified.artifact.runId !== String(runId) ||
    qualified.artifact.runAttempt !== String(runAttempt) ||
    qualified.producer?.runId !== String(runId) ||
    qualified.producer?.runAttempt !== String(runAttempt) ||
    qualified.producer?.workflowSha !== toolingSha
  ) {
    throw new Error(
      "Full Release Validation does not bind a qualified npm preflight for this exact release and attempt; supply its historical separate preflight run when recovering an older release.",
    );
  }
  return qualified;
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
    const identity = values.manifest
      ? verifyNpmPreflightProducer({
          ...options,
          manifest: parseJson(readFileSync(values.manifest, "utf8"), "npm preflight manifest"),
          manifestSha256: createHash("sha256").update(readFileSync(values.manifest)).digest("hex"),
          fullReleaseManifest: values["full-release-manifest"]
            ? parseJson(
                readFileSync(values["full-release-manifest"], "utf8"),
                "full release manifest",
              )
            : undefined,
          runId: values["run-id"],
          runAttempt: values["run-attempt"],
        })
      : verifyReleasePreflightToolingIdentity(options);
    process.stdout.write(`${JSON.stringify(identity)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
