#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "./lib/record-shared.mjs";
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
}) {
  // Published v1 preflights did not record the original ref qualifier. Keep
  // their existing recovery contract without inferring historical provenance.
  if (manifest?.version === 1 && !Object.hasOwn(manifest, "producer")) {
    return { originalWorkflowRef: null, provenance: "legacy-unrecorded" };
  }
  if (manifest?.version !== 2 || !isRecord(manifest.producer)) {
    throw new Error("npm preflight producer metadata is missing or unsupported.");
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
    !/^refs\/(?:heads|tags)\/.+$/u.test(workflowFullRef ?? "") ||
    !/^[a-f0-9]{40}$/u.test(workflowSha ?? "") ||
    !/^[1-9][0-9]*$/u.test(String(runId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(runAttempt ?? ""))
  ) {
    throw new Error("npm preflight expected producer identity is invalid.");
  }
  const expected = {
    repository,
    workflowRef: `${repository}/.github/workflows/openclaw-npm-release.yml@${workflowFullRef}`,
    workflowSha,
    runId: String(runId),
    runAttempt: String(runAttempt),
  };
  if (
    Object.keys(manifest.producer).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => manifest.producer[key] !== value)
  ) {
    throw new Error("npm preflight immutable producer identity mismatch.");
  }
  return { originalWorkflowRef: expected.workflowRef, provenance: "immutable-manifest" };
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
      },
    });
    const options = {
      repository: values.repository,
      workflowRef: values["workflow-ref"],
      workflowFullRef: values["workflow-full-ref"],
      workflowSha: values["workflow-sha"],
      publisherSha: values["publisher-sha"],
    };
    const identity = values.manifest
      ? validateNpmPreflightProducer({
          ...options,
          manifest: parseJson(readFileSync(values.manifest, "utf8"), "npm preflight manifest"),
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
