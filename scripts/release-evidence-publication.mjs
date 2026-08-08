#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const REPOSITORY = "openclaw/openclaw";
const RELEASES_REPOSITORY = "openclaw/releases";
const WORKFLOW_NAME = "Full Release Validation";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PACKAGE_SPEC_PATTERN =
  /^openclaw@([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:(?:-(?:alpha|beta)\.[1-9][0-9]*)|(?:-[1-9][0-9]*))?)$/u;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireTrimmedString(value, label) {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new Error(`${label} must be a trimmed string`);
  }
  return value;
}

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}

function workflowPath(value) {
  return requireTrimmedString(value, "workflow path").split("@", 1)[0];
}

function releaseIdFor(publication) {
  const packageMatch = publication.packageSpec.match(PACKAGE_SPEC_PATTERN);
  const raw =
    packageMatch?.[1] ?? publication.releaseRef.replace(/^refs\/tags\//u, "").replace(/^v/u, "");
  if (!RELEASE_ID_PATTERN.test(raw)) {
    throw new Error("release evidence publication cannot derive a safe release ID");
  }
  return raw;
}

function validatePublicationSource(proof) {
  const directRoot = proof.directRoot;
  const evidenceReuse = proof.evidenceReuse;
  if (
    proof.rerunGroup !== "all" ||
    !(
      (directRoot === true && evidenceReuse === null) ||
      (directRoot === false &&
        evidenceReuse !== null &&
        typeof evidenceReuse === "object" &&
        !Array.isArray(evidenceReuse))
    )
  ) {
    throw new Error(
      "release evidence publication requires a complete direct validation or verified evidence reuse root",
    );
  }
}

function validateRunTuple(run, expected) {
  const value = requireObject(run, "workflow run");
  if (
    requirePositiveInteger(value.id, "workflow run ID") !== expected.runId ||
    requirePositiveInteger(value.run_attempt, "workflow run attempt") !== expected.runAttempt ||
    value.name !== WORKFLOW_NAME ||
    value.event !== "workflow_dispatch" ||
    value.status !== "completed" ||
    value.conclusion !== "success" ||
    value.head_sha !== expected.headSha ||
    workflowPath(value.path) !== WORKFLOW_PATH ||
    value.repository?.full_name !== REPOSITORY ||
    value.head_repository?.full_name !== REPOSITORY
  ) {
    throw new Error("workflow run does not match the exact completed/success publication tuple");
  }
  return value;
}

export function assessReleaseEvidencePublication({ event, evidence }) {
  const workflowRun = requireObject(requireObject(event, "event").workflow_run, "workflow_run");
  const runId = requirePositiveInteger(workflowRun.id, "workflow_run.id");
  const runAttempt = requirePositiveInteger(workflowRun.run_attempt, "workflow_run.run_attempt");
  const headSha = requireTrimmedString(workflowRun.head_sha, "workflow_run.head_sha");
  const updatedAt = requireTrimmedString(workflowRun.updated_at, "workflow_run.updated_at");
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("workflow_run.updated_at must be an ISO timestamp");
  }
  validateRunTuple(workflowRun, { headSha, runAttempt, runId });

  const proof = requireObject(evidence, "release evidence");
  if (proof.valid !== true) {
    throw new Error("release evidence verifier did not return valid evidence");
  }
  const current = requireObject(proof.current, "release evidence current run");
  if (
    Number(current.runId) !== runId ||
    Number(current.runAttempt) !== runAttempt ||
    current.workflowSha !== headSha ||
    current.status !== "completed" ||
    current.conclusion !== "success"
  ) {
    throw new Error("release evidence verifier does not match the workflow_run event");
  }
  const publicationIntent = proof.releaseEvidencePublication;
  if (publicationIntent == null) {
    return { reason: "not-requested", shouldDispatch: false };
  }
  const publication = requireObject(publicationIntent, "release evidence publication intent");
  if (
    typeof publication.requested !== "boolean" ||
    typeof publication.releaseRef !== "string" ||
    typeof publication.packageSpec !== "string" ||
    publication.releaseRef.trim() !== publication.releaseRef ||
    publication.packageSpec.trim() !== publication.packageSpec ||
    hasControlCharacter(publication.releaseRef) ||
    hasControlCharacter(publication.packageSpec)
  ) {
    throw new Error("release evidence publication intent is invalid");
  }
  if (!publication.requested) {
    return { reason: "not-requested", shouldDispatch: false };
  }

  validatePublicationSource(proof);
  const releaseId = releaseIdFor(publication);
  return {
    fullValidationRunId: String(runId),
    headSha,
    notes: `Automatically requested after Full Release Validation ${runId}/${runAttempt} completed successfully.`,
    packageSpec: publication.packageSpec,
    publicationKey: `${runId}:${runAttempt}:${headSha}`,
    reason: "requested",
    releaseId,
    releaseRef: publication.releaseRef,
    runAttempt,
    shouldDispatch: true,
    updatedAt,
  };
}

export function publishedReleaseEvidenceMatches(value, expected) {
  const evidence = requireObject(value, "published release evidence");
  const release = requireObject(evidence.release, "published release evidence release");
  if (
    release.id !== expected.releaseId ||
    release.ref !== expected.releaseRef ||
    release.packageSpec !== expected.packageSpec ||
    !Array.isArray(evidence.runs)
  ) {
    return false;
  }
  return evidence.runs.some(
    (run) =>
      run?.label === "full-release-validation" &&
      run.repo === REPOSITORY &&
      String(run.runId) === expected.fullValidationRunId &&
      Number(run.runAttempt) === expected.runAttempt &&
      run.headSha === expected.headSha &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.updatedAt === expected.updatedAt &&
      workflowPath(run.path) === WORKFLOW_PATH,
  );
}

function requireToken() {
  const token = process.env.RELEASES_DISPATCH_TOKEN?.trim();
  if (!token) {
    throw new Error("OPENCLAW_RELEASES_DISPATCH_TOKEN is required for release publication");
  }
  return token;
}

async function fetchPublishedReleaseEvidence(releaseId, token) {
  const url = new URL(
    `https://api.github.com/repos/${RELEASES_REPOSITORY}/contents/evidence/${encodeURIComponent(releaseId)}/release-evidence.json`,
  );
  url.searchParams.set("ref", "main");
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `release evidence lookup failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return JSON.parse(await response.text());
}

function writeOutputs(path, result) {
  const lines = [
    `should_dispatch=${result.shouldDispatch ? "true" : "false"}`,
    `reason=${result.reason}`,
  ];
  if (result.shouldDispatch) {
    lines.push(
      `full_validation_run_id=${result.fullValidationRunId}`,
      `head_sha=${result.headSha}`,
      `run_attempt=${result.runAttempt}`,
      `updated_at=${result.updatedAt}`,
      `release_id=${result.releaseId}`,
      `release_ref=${result.releaseRef}`,
      `package_spec=${result.packageSpec}`,
      `publication_key=${result.publicationKey}`,
      `notes=${result.notes}`,
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["confirm", "prepare"].includes(command)) {
    throw new Error("usage: release-evidence-publication.mjs <prepare|confirm> [options]");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (
      [
        "--event",
        "--evidence",
        "--github-output",
        "--head-sha",
        "--package-spec",
        "--release-id",
        "--release-ref",
        "--run-id",
        "--run-attempt",
        "--updated-at",
      ].includes(argument)
    ) {
      options[argument.slice(2).replaceAll("-", "_")] = rest[++index];
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  const required =
    command === "prepare"
      ? ["event", "evidence", "github_output"]
      : [
          "head_sha",
          "package_spec",
          "release_id",
          "release_ref",
          "run_attempt",
          "run_id",
          "updated_at",
        ];
  for (const key of required) {
    if (options[key] === undefined) {
      throw new Error(`--${key.replaceAll("_", "-")} is required`);
    }
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "confirm") {
    const token = requireToken();
    const expected = {
      fullValidationRunId: requirePositiveInteger(options.run_id, "run ID").toString(),
      headSha: requireTrimmedString(options.head_sha, "head SHA"),
      packageSpec: requireTrimmedString(options.package_spec, "package spec"),
      releaseId: requireTrimmedString(options.release_id, "release ID"),
      releaseRef: requireTrimmedString(options.release_ref, "release ref"),
      runAttempt: requirePositiveInteger(options.run_attempt, "run attempt"),
      updatedAt: requireTrimmedString(options.updated_at, "updated at"),
    };
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const published = await fetchPublishedReleaseEvidence(expected.releaseId, token);
      if (published && publishedReleaseEvidenceMatches(published, expected)) {
        return;
      }
      if (attempt < 30) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20_000);
        });
      }
    }
    throw new Error("durable release evidence publication was not observed within 10 minutes");
  }

  const event = JSON.parse(readFileSync(options.event, "utf8"));
  const evidence = JSON.parse(readFileSync(options.evidence, "utf8"));
  const result = assessReleaseEvidencePublication({ event, evidence });
  if (!result.shouldDispatch) {
    writeOutputs(options.github_output, result);
    return;
  }
  const published = await fetchPublishedReleaseEvidence(result.releaseId, requireToken());
  writeOutputs(
    options.github_output,
    published && publishedReleaseEvidenceMatches(published, result)
      ? { reason: "already-published", shouldDispatch: false }
      : result,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
