#!/usr/bin/env node
/**
 * Release CI summary helper that prints parent and child workflow status for a
 * full release run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { plainGhEnv, resolvePlainGhBin } from "./lib/plain-gh.mjs";

const DEFAULT_REPO = process.env.OPENCLAW_RELEASE_REPO || "openclaw/openclaw";
const RELEASE_EVIDENCE_SCHEMA = "openclaw.release-validation-evidence/v3";
const SHA_PINNED_BRANCH_PATTERN = /^release-ci\/[a-f0-9]{12}-[1-9][0-9]*$/u;
const RELEASE_EVIDENCE_SCRIPT = "scripts/release-ci-summary.mjs";
const RELEASE_EVIDENCE_FILE = fileURLToPath(import.meta.url);
const RELEASE_EVIDENCE_REPO_ROOT = resolve(dirname(RELEASE_EVIDENCE_FILE), "..");
const MANIFEST_ARTIFACT_ENTRY = "full-release-validation-manifest.json";
const MAX_MANIFEST_ARTIFACT_ZIP_BYTES = 256 * 1024;
const MAX_MANIFEST_JSON_BYTES = 128 * 1024;
const MAX_MANIFEST_ENTRY_LIST_BYTES = 8 * 1024;

const CHILD_DISPATCHES = [
  {
    manifestKey: "normalCi",
    name: "CI",
    parentJobName: "Run normal full CI",
    suffix: "-ci",
    trustedRef: "parent",
    workflow: "ci.yml",
  },
  {
    manifestKey: "releaseChecks",
    name: "OpenClaw Release Checks",
    parentJobName: "Run release/live/Docker/QA validation",
    suffix: "-release-checks",
    trustedRef: "parent",
    workflow: "openclaw-release-checks.yml",
  },
  {
    manifestKey: "pluginPrerelease",
    name: "Plugin Prerelease",
    parentJobName: "Run plugin prerelease validation",
    suffix: "-plugin-prerelease",
    trustedRef: "parent",
    workflow: "plugin-prerelease.yml",
  },
  {
    manifestKey: "npmTelegram",
    name: "NPM Telegram Beta E2E",
    parentJobName: "Run package Telegram E2E",
    suffix: "-npm-telegram",
    trustedRef: "parent",
    workflow: "npm-telegram-beta-e2e.yml",
  },
  {
    manifestKey: "productPerformance",
    name: "OpenClaw Performance",
    parentJobName: "Run product performance evidence",
    suffix: "",
    trustedRef: "parent",
    workflow: "openclaw-performance.yml",
  },
];

const EXACT_TARGET_EVIDENCE_REUSE_POLICY = "exact-target-full-validation-v1";
const CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY = "changelog-only-release-v1";
const EVIDENCE_REUSE_POLICIES = new Set([
  EXACT_TARGET_EVIDENCE_REUSE_POLICY,
  CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY,
]);

const RERUN_GROUP_CHILD_KEYS = new Map([
  ["all", ["normalCi", "releaseChecks", "pluginPrerelease", "productPerformance"]],
  ["ci", ["normalCi"]],
  ["plugin-prerelease", ["pluginPrerelease"]],
  ["release-checks", ["releaseChecks"]],
  ["install-smoke", ["releaseChecks"]],
  ["cross-os", ["releaseChecks"]],
  ["live-e2e", ["releaseChecks"]],
  ["package", ["releaseChecks"]],
  ["qa", ["releaseChecks"]],
  ["qa-parity", ["releaseChecks"]],
  ["qa-live", ["releaseChecks"]],
  ["npm-telegram", ["npmTelegram"]],
  ["performance", ["productPerformance"]],
]);

function gh(args) {
  return execFileSync(resolvePlainGhBin(), args, {
    encoding: "utf8",
    env: plainGhEnv(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function jsonGh(args) {
  return JSON.parse(gh(args));
}

function githubRestJson(pathSuffix, repository = DEFAULT_REPO) {
  const result = execFileSync(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        'token="$("$OPENCLAW_PLAIN_GH_BIN" auth token)"',
        'curl -fsS -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "${OPENCLAW_GITHUB_REST_URL}"',
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env: {
        ...plainGhEnv(),
        OPENCLAW_PLAIN_GH_BIN: resolvePlainGhBin(),
        OPENCLAW_GITHUB_REST_URL: `https://api.github.com/repos/${repository}/${pathSuffix}`,
      },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(result);
}

function downloadArtifactZip(artifactId, destination, repository = DEFAULT_REPO) {
  execFileSync(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        'token="$("$OPENCLAW_PLAIN_GH_BIN" auth token)"',
        'curl -fsSL -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" --output "$OPENCLAW_GITHUB_ARTIFACT_DESTINATION" "$OPENCLAW_GITHUB_ARTIFACT_URL"',
      ].join("\n"),
    ],
    {
      env: {
        ...plainGhEnv(),
        OPENCLAW_GITHUB_ARTIFACT_DESTINATION: destination,
        OPENCLAW_GITHUB_ARTIFACT_URL: `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
        OPENCLAW_PLAIN_GH_BIN: resolvePlainGhBin(),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

function rate() {
  try {
    return jsonGh(["api", "rate_limit"]).resources.core;
  } catch {
    return undefined;
  }
}

export function validateParentRunBinding(parentView, parentRest, expectedRunId) {
  const boundWorkflowPath = String(parentRest.path ?? "").split("@", 1)[0];
  if (
    String(parentRest.id) !== String(expectedRunId) ||
    parentRest.event !== "workflow_dispatch" ||
    boundWorkflowPath !== ".github/workflows/full-release-validation.yml" ||
    Number(parentRest.run_attempt) !== Number(parentView.attempt) ||
    parentRest.head_branch !== parentView.headBranch ||
    parentRest.head_sha !== parentView.headSha
  ) {
    throw new Error(`full release parent run binding mismatch: ${expectedRunId}`);
  }
  return parentRest;
}

export function expectedChildDispatches(parentRunId, parentRunAttempt, parentWorkflowRef) {
  if (!/^[1-9][0-9]*$/u.test(String(parentRunId))) {
    throw new Error("parent run ID must be a positive decimal");
  }
  if (!Number.isSafeInteger(parentRunAttempt) || parentRunAttempt < 1) {
    throw new Error("parent run attempt must be a positive integer");
  }
  if (typeof parentWorkflowRef !== "string" || parentWorkflowRef.length === 0) {
    throw new Error("parent workflow ref is required");
  }
  const dispatchPrefix = `full-release-validation-${parentRunId}-${parentRunAttempt}`;
  return CHILD_DISPATCHES.map((child) => ({
    ...child,
    displayTitle: `${child.name} ${dispatchPrefix}${child.suffix}`,
    headBranch: child.trustedRef === "main" ? "main" : parentWorkflowRef,
  }));
}

export function requiredChildKeysForRerunGroup(rerunGroup) {
  const childKeys = RERUN_GROUP_CHILD_KEYS.get(rerunGroup);
  if (!childKeys) {
    throw new Error(`release validation manifest rerun group is invalid: ${rerunGroup}`);
  }
  return new Set(childKeys);
}

export function expectedSelectedChildDispatches(
  parentRunId,
  parentRunAttempt,
  parentWorkflowRef,
  selectedKeys,
) {
  return expectedChildDispatches(parentRunId, parentRunAttempt, parentWorkflowRef).filter((child) =>
    selectedKeys.has(child.manifestKey),
  );
}

export function selectExactChildRun(runs, expectedDisplayTitle, expectedHeadBranch) {
  const matches = runs.filter(
    (run) =>
      run.event === "workflow_dispatch" &&
      run.display_title === expectedDisplayTitle &&
      run.head_branch === expectedHeadBranch,
  );
  if (matches.length > 1) {
    throw new Error(
      `multiple child runs have exact dispatch title and branch: ${expectedDisplayTitle} (${expectedHeadBranch})`,
    );
  }
  return matches[0];
}

export function selectExactChildRunFromPages(runPages, expectedDisplayTitle, expectedHeadBranch) {
  let exactMatch;
  for (const runs of runPages) {
    const match = selectExactChildRun(runs, expectedDisplayTitle, expectedHeadBranch);
    if (match) {
      if (exactMatch) {
        throw new Error(
          `multiple child runs have exact dispatch title and branch: ${expectedDisplayTitle} (${expectedHeadBranch})`,
        );
      }
      exactMatch = match;
    }
    if (runs.length < 100) {
      break;
    }
  }
  return exactMatch;
}

function findExactChildRun(child, repository = DEFAULT_REPO) {
  const runPages = [];
  for (let page = 1; page <= 10; page += 1) {
    const query = new URLSearchParams({
      event: "workflow_dispatch",
      branch: child.headBranch,
      page: String(page),
      per_page: "100",
    });
    const runs =
      githubRestJson(`actions/workflows/${child.workflow}/runs?${query.toString()}`, repository)
        .workflow_runs ?? [];
    runPages.push(runs);
    if (runs.length < 100) {
      break;
    }
  }
  return selectExactChildRunFromPages(runPages, child.displayTitle, child.headBranch);
}

function findParentJobsAll(parentRunId, repository = DEFAULT_REPO) {
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const query = new URLSearchParams({
      filter: "all",
      page: String(page),
      per_page: "100",
    });
    const pageJobs =
      githubRestJson(`actions/runs/${parentRunId}/jobs?${query.toString()}`, repository).jobs ?? [];
    jobs.push(...pageJobs);
    if (pageJobs.length < 100) {
      break;
    }
  }
  return jobs;
}

function parentJobLog(jobId, repository = DEFAULT_REPO) {
  return gh(["api", `repos/${repository}/actions/jobs/${jobId}/logs`]);
}

function normalizeOptionalRunId(value, label) {
  if (value === "") {
    return "";
  }
  if (!/^[1-9][0-9]*$/u.test(String(value))) {
    throw new Error(`${label} must be empty or a positive decimal run ID`);
  }
  return String(value);
}

function normalizeRequiredRunId(value, label) {
  const runId = normalizeOptionalRunId(value, label);
  if (!runId) {
    throw new Error(`${label} is required`);
  }
  return runId;
}

function normalizeRepository(value) {
  const repository = String(value ?? "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("repository must use the owner/name form");
  }
  return repository;
}

function normalizeWorkflowRef(value, label) {
  const workflowRef = String(value ?? "");
  const hasForbiddenCharacter = Array.from(workflowRef).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      character.trim() === "" ||
      "~^:?*[\\".includes(character)
    );
  });
  if (workflowRef.length === 0 || workflowRef.length > 255 || hasForbiddenCharacter) {
    throw new Error(`${label} is invalid`);
  }
  return workflowRef;
}

function normalizeSha(value, label) {
  const sha = String(value ?? "");
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error(`${label} is invalid`);
  }
  return sha;
}

function normalizePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function normalizeJsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function manifestEvidenceIdentity(manifest) {
  return canonicalJson({
    childRunIds: manifest.childRunIds,
    controls: manifest.controls,
    releaseProfile: manifest.releaseProfile,
    rerunGroup: manifest.rerunGroup,
    runReleaseSoak: manifest.runReleaseSoak,
    validationInputs: manifest.validationInputs,
  });
}

export function validateParentManifest(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release validation manifest must be an object");
  }
  if (![2, 3].includes(value.version) || value.workflowName !== "Full Release Validation") {
    throw new Error("release validation manifest schema is unsupported");
  }
  if (String(value.runId) !== String(expected.runId)) {
    throw new Error("release validation manifest run ID mismatch");
  }
  if (
    !/^[1-9][0-9]*$/u.test(String(value.runAttempt)) ||
    (expected.runAttempt !== undefined && Number(value.runAttempt) !== Number(expected.runAttempt))
  ) {
    throw new Error("release validation manifest run attempt mismatch");
  }
  const targetSha = normalizeSha(value.targetSha, "release validation manifest target SHA");
  if (typeof value.workflowRef !== "string" || value.workflowRef.length === 0) {
    throw new Error("release validation manifest workflow ref is invalid");
  }
  if (expected.workflowRef !== undefined && value.workflowRef !== expected.workflowRef) {
    throw new Error("release validation manifest workflow ref mismatch");
  }
  let workflowSha;
  let workflowFullRef;
  let workflowRefType;
  if (value.version === 3) {
    workflowSha = normalizeSha(value.workflowSha, "release validation manifest workflow SHA");
    if (expected.workflowSha !== undefined && workflowSha !== expected.workflowSha) {
      throw new Error("release validation manifest workflow SHA mismatch");
    }
    workflowFullRef = String(value.workflowFullRef ?? "");
    workflowRefType = String(value.workflowRefType ?? "");
    if (
      !["branch", "tag"].includes(workflowRefType) ||
      workflowFullRef !==
        `refs/${workflowRefType === "branch" ? "heads" : "tags"}/${value.workflowRef}`
    ) {
      throw new Error("release validation manifest workflow full ref is invalid");
    }
  } else if (expected.workflowSha !== undefined) {
    workflowSha = normalizeSha(expected.workflowSha, "release validation workflow SHA");
  }
  const rerunGroup = String(value.rerunGroup ?? "");
  requiredChildKeysForRerunGroup(rerunGroup);
  const releaseProfile = String(value.releaseProfile ?? "");
  if (!["beta", "stable", "full"].includes(releaseProfile)) {
    throw new Error("release validation manifest release profile is invalid");
  }
  const runReleaseSoak = String(value.runReleaseSoak ?? "");
  if (!["true", "false"].includes(runReleaseSoak)) {
    throw new Error("release validation manifest release soak value is invalid");
  }
  const controls = normalizeJsonObject(value.controls, "release validation manifest controls");
  if (value.version === 3 && controls.performanceReportPublication !== "artifact-only") {
    throw new Error("release validation manifest performance report publication mode is invalid");
  }
  const validationInputs =
    value.validationInputs === undefined
      ? undefined
      : normalizeJsonObject(
          value.validationInputs,
          "release validation manifest validation inputs",
        );
  const childRuns = value.childRuns;
  if (!childRuns || typeof childRuns !== "object" || Array.isArray(childRuns)) {
    throw new Error("release validation manifest childRuns is invalid");
  }
  const childRunIds = {
    normalCi: normalizeOptionalRunId(childRuns.normalCi, "normal CI run ID"),
    npmTelegram: normalizeOptionalRunId(childRuns.npmTelegram, "npm Telegram run ID"),
    pluginPrerelease: normalizeOptionalRunId(
      childRuns.pluginPrerelease,
      "plugin prerelease run ID",
    ),
    productPerformance: normalizeOptionalRunId(
      childRuns.productPerformance?.runId ?? "",
      "performance run ID",
    ),
    releaseChecks: normalizeOptionalRunId(childRuns.releaseChecks, "release checks run ID"),
  };
  let evidenceReuse;
  if (value.evidenceReuse !== undefined) {
    const reuse = normalizeJsonObject(
      value.evidenceReuse,
      "release validation manifest evidence reuse",
    );
    if (!EVIDENCE_REUSE_POLICIES.has(reuse.policy)) {
      throw new Error("release validation manifest evidence reuse policy is invalid");
    }
    if (!/^[a-f0-9]{40}$/u.test(String(reuse.evidenceSha))) {
      throw new Error("release validation manifest evidence SHA is invalid");
    }
    if (
      !Array.isArray(reuse.changedPaths) ||
      reuse.changedPaths.some(
        (changedPath) => typeof changedPath !== "string" || changedPath.length === 0,
      ) ||
      new Set(reuse.changedPaths).size !== reuse.changedPaths.length
    ) {
      throw new Error("release validation manifest evidence changed paths are invalid");
    }
    evidenceReuse = {
      changedPaths: reuse.changedPaths,
      evidenceSha: String(reuse.evidenceSha),
      policy: reuse.policy,
      runId: normalizeRequiredRunId(reuse.runId, "evidence reuse root run ID"),
      selectedRunId: normalizeRequiredRunId(reuse.selectedRunId, "evidence reuse selected run ID"),
    };
  }
  return {
    childRunIds,
    controls,
    evidenceReuse,
    releaseProfile,
    rerunGroup,
    runAttempt: Number(value.runAttempt),
    runId: String(value.runId),
    runReleaseSoak,
    targetRef: String(value.targetRef ?? ""),
    targetSha,
    validationInputs,
    version: value.version,
    workflowFullRef,
    workflowSha,
    workflowRef: value.workflowRef,
    workflowRefType,
  };
}

export function validateEvidenceReuseChain(
  currentManifest,
  selectedManifest,
  rootManifest,
  compareCommits,
) {
  const reuse = currentManifest.evidenceReuse;
  if (!reuse) {
    throw new Error("release validation manifest does not authorize evidence reuse");
  }
  if (rootManifest.evidenceReuse || selectedManifest.evidenceReuse) {
    throw new Error("evidence reuse must select a root execution manifest");
  }
  if (
    !currentManifest.validationInputs ||
    !selectedManifest.validationInputs ||
    !rootManifest.validationInputs
  ) {
    throw new Error("evidence reuse manifests must record validation inputs");
  }
  if (rootManifest.runId !== reuse.runId) {
    throw new Error("evidence reuse root manifest run ID mismatch");
  }
  if (selectedManifest.runId !== reuse.selectedRunId) {
    throw new Error("evidence reuse selected manifest run ID mismatch");
  }
  if (selectedManifest.targetSha !== reuse.evidenceSha) {
    throw new Error("evidence reuse selected manifest SHA mismatch");
  }
  if (rootManifest.targetSha !== reuse.evidenceSha) {
    throw new Error("full release evidence reuse root SHA mismatch");
  }
  if (selectedManifest.runId !== rootManifest.runId) {
    throw new Error("evidence reuse selected manifest is not the chain root");
  }
  if (reuse.policy === EXACT_TARGET_EVIDENCE_REUSE_POLICY) {
    if (reuse.changedPaths.length !== 0 || currentManifest.targetSha !== reuse.evidenceSha) {
      throw new Error("exact-target release evidence reuse requires no changed paths");
    }
  } else if (reuse.policy === CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY) {
    if (
      reuse.changedPaths.length !== 1 ||
      reuse.changedPaths[0] !== "CHANGELOG.md" ||
      currentManifest.targetSha === reuse.evidenceSha
    ) {
      throw new Error("changelog-only release evidence reuse has an invalid target delta");
    }
    if (typeof compareCommits !== "function") {
      throw new Error("changelog-only release evidence reuse requires commit comparison");
    }
    const comparison = compareCommits(reuse.evidenceSha, currentManifest.targetSha);
    const changedFiles = Array.isArray(comparison?.files) ? comparison.files : [];
    const changelog = changedFiles[0];
    if (
      comparison?.status !== "ahead" ||
      comparison?.merge_base_commit?.sha !== reuse.evidenceSha ||
      changedFiles.length !== 1 ||
      changelog?.filename !== "CHANGELOG.md" ||
      changelog?.status !== "modified" ||
      changelog?.previous_filename
    ) {
      throw new Error("changelog-only release evidence reuse failed commit comparison");
    }
  } else {
    throw new Error("release validation manifest evidence reuse policy is invalid");
  }

  const rootIdentity = JSON.stringify(manifestEvidenceIdentity(rootManifest));
  for (const [label, manifest] of [
    ["selected", selectedManifest],
    ["current", currentManifest],
  ]) {
    if (JSON.stringify(manifestEvidenceIdentity(manifest)) !== rootIdentity) {
      throw new Error(`evidence reuse ${label} manifest policy differs from the chain root`);
    }
  }
  return rootManifest.targetSha;
}

export function selectedChildKeys(parentJobs) {
  return new Set(
    CHILD_DISPATCHES.filter((child) => {
      const parentJob = parentJobs.find((job) => job.name === child.parentJobName);
      return parentJob && parentJob.conclusion !== "skipped";
    }).map((child) => child.manifestKey),
  );
}

export function manifestChildEntries(manifest, children, selectedKeys) {
  return children.flatMap((child) => {
    const runId = manifest.childRunIds[child.manifestKey];
    if (!runId) {
      if (selectedKeys.has(child.manifestKey)) {
        throw new Error(`selected child is missing from manifest: ${child.name}`);
      }
      return [];
    }
    return [{ child, runId }];
  });
}

function childDispatchAttempt(displayTitle, child, parentRunId, parentRunAttempt) {
  const prefix = `${child.name} full-release-validation-${parentRunId}-`;
  if (!displayTitle.startsWith(prefix) || !displayTitle.endsWith(child.suffix)) {
    return undefined;
  }
  const attemptEnd = child.suffix ? -child.suffix.length : undefined;
  const attemptText = displayTitle.slice(prefix.length, attemptEnd);
  if (!/^[1-9][0-9]*$/u.test(attemptText)) {
    return undefined;
  }
  const attempt = Number(attemptText);
  if (!Number.isSafeInteger(attempt) || attempt > parentRunAttempt) {
    return undefined;
  }
  return attempt;
}

function parentJobExecutionFingerprint(job) {
  return canonicalJson({
    completedAt: job.completed_at,
    conclusion: job.conclusion,
    name: job.name,
    startedAt: job.started_at,
    status: job.status,
    steps: (job.steps ?? []).map((step) => ({
      completedAt: step.completed_at,
      conclusion: step.conclusion,
      name: step.name,
      number: step.number,
      startedAt: step.started_at,
      status: step.status,
    })),
  });
}

function selectedAttemptParentJob(parentJobs, child, parentManifest) {
  const slotJobs = parentJobs.filter((job) => job.name === child.parentJobName);
  if (slotJobs.length === 0) {
    throw new Error(`manifest parent job is missing: ${child.name}`);
  }
  const latestAttempt = Math.max(...slotJobs.map((job) => Number(job.run_attempt)));
  if (latestAttempt !== parentManifest.runAttempt) {
    throw new Error(`manifest parent job latest attempt mismatch: ${child.name}`);
  }
  const currentJobs = slotJobs.filter(
    (job) => Number(job.run_attempt) === parentManifest.runAttempt,
  );
  if (currentJobs.length !== 1) {
    throw new Error(`manifest parent job is not unique at the selected attempt: ${child.name}`);
  }
  const currentJob = currentJobs[0];
  if (currentJob.status !== "completed" || currentJob.conclusion !== "success") {
    throw new Error(`manifest parent job is not completed/success: ${child.name}`);
  }
  return { currentJob, slotJobs };
}

export function resolveManifestChildOriginAttempt(run, child, parentManifest, parentJobs) {
  const correlatedAttempt = childDispatchAttempt(
    String(run.display_title ?? ""),
    child,
    parentManifest.runId,
    parentManifest.runAttempt,
  );
  if (correlatedAttempt !== undefined) {
    return correlatedAttempt;
  }
  if (run.display_title !== child.name) {
    return undefined;
  }

  const { currentJob, slotJobs } = selectedAttemptParentJob(parentJobs, child, parentManifest);
  const currentFingerprint = JSON.stringify(parentJobExecutionFingerprint(currentJob));
  const carriedOriginAttempts = slotJobs
    .filter(
      (job) =>
        Number(job.run_attempt) < parentManifest.runAttempt &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        JSON.stringify(parentJobExecutionFingerprint(job)) === currentFingerprint,
    )
    .map((job) => Number(job.run_attempt));
  return carriedOriginAttempts.length > 0
    ? Math.min(...carriedOriginAttempts)
    : parentManifest.runAttempt;
}

export function selectManifestParentJob(parentJobs, child, parentManifest, originAttempt) {
  const { currentJob, slotJobs } = selectedAttemptParentJob(parentJobs, child, parentManifest);
  if (originAttempt === parentManifest.runAttempt) {
    return currentJob;
  }

  const originJobs = slotJobs.filter((job) => Number(job.run_attempt) === originAttempt);
  if (originJobs.length !== 1) {
    throw new Error(`manifest parent job origin is not unique: ${child.name}`);
  }
  const originJob = originJobs[0];
  if (originJob.status !== "completed" || originJob.conclusion !== "success") {
    throw new Error(`manifest parent job origin is not completed/success: ${child.name}`);
  }
  if (
    JSON.stringify(parentJobExecutionFingerprint(currentJob)) !==
    JSON.stringify(parentJobExecutionFingerprint(originJob))
  ) {
    throw new Error(`manifest parent job carry-forward fingerprint mismatch: ${child.name}`);
  }
  return currentJob;
}

function childRunIdsFromParentLog(log, repository = DEFAULT_REPO) {
  const escapedRepo = repository.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `https://github\\.com/${escapedRepo}/actions/runs/([1-9][0-9]*)`,
    "gu",
  );
  return new Set(Array.from(log.matchAll(pattern), (match) => match[1]));
}

export function validateManifestChildRun(
  run,
  child,
  runId,
  parentManifest,
  parentJobs,
  selectedParentJobLog,
  repository = DEFAULT_REPO,
) {
  if (String(run.id) !== String(runId)) {
    throw new Error(`manifest child run ID mismatch: ${child.name}`);
  }
  const originAttempt = resolveManifestChildOriginAttempt(run, child, parentManifest, parentJobs);
  if (
    run.event !== "workflow_dispatch" ||
    run.head_branch !== child.headBranch ||
    (child.trustedRef === "parent" && run.head_sha !== parentManifest.workflowSha) ||
    !/^[a-f0-9]{40}$/u.test(String(run.head_sha)) ||
    run.actor?.login !== "github-actions[bot]" ||
    run.triggering_actor?.login !== "github-actions[bot]" ||
    !Number.isSafeInteger(Number(run.run_attempt)) ||
    Number(run.run_attempt) < 1 ||
    originAttempt === undefined
  ) {
    throw new Error(`manifest child dispatch tuple mismatch: ${child.name}`);
  }
  const childWorkflowPath = String(run.path ?? "").split("@", 1)[0];
  if (childWorkflowPath !== `.github/workflows/${child.workflow}`) {
    throw new Error(`manifest child workflow mismatch: ${child.name}`);
  }
  selectManifestParentJob(parentJobs, child, parentManifest, originAttempt);
  const emittedChildRunIds = childRunIdsFromParentLog(selectedParentJobLog, repository);
  if (emittedChildRunIds.size !== 1 || !emittedChildRunIds.has(String(runId))) {
    throw new Error(`manifest child run is not uniquely emitted by its parent job: ${child.name}`);
  }
  if (
    child.manifestKey !== "npmTelegram" &&
    !selectedParentJobLog.includes(`TARGET_SHA: ${parentManifest.targetSha}`)
  ) {
    throw new Error(`manifest parent job target SHA mismatch: ${child.name}`);
  }
  if (
    child.manifestKey === "productPerformance" &&
    !selectedParentJobLog.includes("-f publish_reports=false")
  ) {
    throw new Error("manifest performance child is not dispatched in artifact-only mode");
  }
  return run;
}

export function validatePerformanceArtifactOnlyJobs(jobs, runAttempt) {
  const normalizedRunAttempt = normalizePositiveInteger(runAttempt, "performance run attempt");
  const currentJobs = jobs.filter((job) => Number(job.run_attempt) === normalizedRunAttempt);
  const guards = currentJobs.filter((job) => job.name === "Verify artifact-only report mode");
  if (
    guards.length !== 1 ||
    guards[0].status !== "completed" ||
    guards[0].conclusion !== "success"
  ) {
    throw new Error("performance artifact-only guard is missing or unsuccessful");
  }
  const unsafePublisher = currentJobs.find(
    (job) =>
      String(job.name ?? "").startsWith("Publish ") &&
      String(job.name ?? "").endsWith(" report") &&
      job.conclusion !== "skipped",
  );
  if (unsafePublisher) {
    throw new Error(`performance report publisher was not skipped: ${unsafePublisher.name}`);
  }
  return guards[0];
}

function manifestArtifactName(runId, runAttempt) {
  const normalizedRunId = normalizeRequiredRunId(runId, "full release run ID");
  const normalizedRunAttempt = normalizePositiveInteger(runAttempt, "full release run attempt");
  return `full-release-validation-${normalizedRunId}-${normalizedRunAttempt}`;
}

function legacyManifestArtifactName(runId) {
  return `full-release-validation-${normalizeRequiredRunId(runId, "full release run ID")}`;
}

export function validateManifestArtifactIdentity(
  artifact,
  { artifactDigest, artifactId, runAttempt, runId },
) {
  const normalizedArtifactId = normalizeRequiredRunId(artifactId, "manifest artifact ID");
  const normalizedRunId = normalizeRequiredRunId(runId, "full release run ID");
  const normalizedRunAttempt = normalizePositiveInteger(runAttempt, "full release run attempt");
  const normalizedDigest = String(artifactDigest ?? "");
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalizedDigest)) {
    throw new Error(`release validation manifest artifact digest is invalid: ${normalizedRunId}`);
  }
  const canonicalName = manifestArtifactName(normalizedRunId, normalizedRunAttempt);
  const legacyName = legacyManifestArtifactName(normalizedRunId);
  const validName =
    artifact.name === canonicalName || (normalizedRunAttempt === 1 && artifact.name === legacyName);
  if (
    String(artifact.id) !== normalizedArtifactId ||
    !validName ||
    artifact.digest !== normalizedDigest ||
    artifact.expired !== false ||
    String(artifact.workflow_run?.id) !== normalizedRunId ||
    !Number.isSafeInteger(Number(artifact.size_in_bytes)) ||
    Number(artifact.size_in_bytes) < 1
  ) {
    throw new Error(`release validation manifest artifact identity mismatch: ${normalizedRunId}`);
  }
  return artifact;
}

export function selectManifestArtifact(artifacts, runId, runAttempt) {
  const expectedName = manifestArtifactName(runId, runAttempt);
  const canonicalMatches = artifacts.filter(
    (artifact) =>
      artifact.name === expectedName &&
      artifact.expired === false &&
      String(artifact.workflow_run?.id) === String(runId),
  );
  if (canonicalMatches.length > 1) {
    throw new Error(`multiple release validation manifest artifacts found: ${runId}`);
  }
  const canonicalArtifact = canonicalMatches[0];
  if (canonicalArtifact) {
    return validateManifestArtifactIdentity(canonicalArtifact, {
      artifactDigest: canonicalArtifact.digest,
      artifactId: canonicalArtifact.id,
      runAttempt,
      runId,
    });
  }

  const legacyName = legacyManifestArtifactName(runId);
  const legacyMatches = artifacts.filter(
    (artifact) =>
      artifact.name === legacyName &&
      artifact.expired === false &&
      String(artifact.workflow_run?.id) === String(runId),
  );
  if (legacyMatches.length > 1) {
    throw new Error(`multiple legacy release validation manifest artifacts found: ${runId}`);
  }
  const legacyArtifact = legacyMatches[0];
  if (!legacyArtifact) {
    return undefined;
  }
  if (Number(runAttempt) !== 1) {
    throw new Error(`legacy release validation manifest requires run attempt 1: ${runId}`);
  }
  return validateManifestArtifactIdentity(legacyArtifact, {
    artifactDigest: legacyArtifact.digest,
    artifactId: legacyArtifact.id,
    runAttempt,
    runId,
  });
}

export function validateManifestArtifactCompatibility(artifact, manifest, runId, runAttempt) {
  if (artifact.name === manifestArtifactName(runId, runAttempt)) {
    return artifact;
  }
  if (
    Number(runAttempt) === 1 &&
    artifact.name === legacyManifestArtifactName(runId) &&
    manifest?.version === 2
  ) {
    return artifact;
  }
  throw new Error(`legacy release validation manifest artifact is not compatible: ${runId}`);
}

export function readManifestArtifactArchive(archivePath, expectedDigest) {
  const archiveSize = statSync(archivePath).size;
  if (
    !Number.isSafeInteger(archiveSize) ||
    archiveSize < 1 ||
    archiveSize > MAX_MANIFEST_ARTIFACT_ZIP_BYTES
  ) {
    throw new Error("release validation manifest artifact compressed size is invalid");
  }
  const archiveBytes = readFileSync(archivePath);
  if (archiveBytes.byteLength !== archiveSize) {
    throw new Error("release validation manifest artifact changed while being verified");
  }
  const actualDigest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
  if (actualDigest !== expectedDigest) {
    throw new Error("release validation manifest artifact digest mismatch");
  }

  let entryList;
  try {
    entryList = execFileSync("unzip", ["-Z", "-1", archivePath], {
      encoding: "utf8",
      maxBuffer: MAX_MANIFEST_ENTRY_LIST_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("release validation manifest artifact entry list is invalid");
  }
  const entries = entryList.split(/\r?\n/u).filter((entry) => entry.length > 0);
  if (entries.length !== 1 || entries[0] !== MANIFEST_ARTIFACT_ENTRY) {
    throw new Error(
      `release validation manifest artifact must contain only ${MANIFEST_ARTIFACT_ENTRY}`,
    );
  }

  let manifestBytes;
  try {
    manifestBytes = execFileSync("unzip", ["-p", archivePath, MANIFEST_ARTIFACT_ENTRY], {
      maxBuffer: MAX_MANIFEST_JSON_BYTES + 1,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("release validation manifest artifact entry could not be read safely");
  }
  if (manifestBytes.byteLength < 1 || manifestBytes.byteLength > MAX_MANIFEST_JSON_BYTES) {
    throw new Error("release validation manifest artifact entry size is invalid");
  }
  return JSON.parse(manifestBytes.toString("utf8"));
}

function downloadParentManifestEvidence(runId, runAttempt, repository, manifestPath) {
  const targetRepository = repository ?? DEFAULT_REPO;
  const artifacts = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageArtifacts =
      githubRestJson(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`, targetRepository)
        .artifacts ?? [];
    artifacts.push(...pageArtifacts);
    if (pageArtifacts.length < 100) {
      break;
    }
  }
  const listedArtifact = selectManifestArtifact(artifacts, runId, runAttempt);
  if (!listedArtifact) {
    return undefined;
  }
  const artifact = validateManifestArtifactIdentity(
    githubRestJson(`actions/artifacts/${listedArtifact.id}`, targetRepository),
    {
      artifactDigest: listedArtifact.digest,
      artifactId: listedArtifact.id,
      runAttempt,
      runId,
    },
  );
  const downloadDir = mkdtempSync(join(tmpdir(), "openclaw-release-ci-summary-"));
  try {
    const archivePath = join(downloadDir, "manifest.zip");
    downloadArtifactZip(String(artifact.id), archivePath, targetRepository);
    const manifest = readManifestArtifactArchive(archivePath, artifact.digest);
    validateManifestArtifactCompatibility(artifact, manifest, runId, runAttempt);
    if (manifestPath) {
      const providedManifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
      if (
        JSON.stringify(canonicalJson(providedManifest)) !== JSON.stringify(canonicalJson(manifest))
      ) {
        throw new Error("provided release validation manifest differs from the run artifact");
      }
    }
    return { artifact, manifest };
  } finally {
    rmSync(downloadDir, { force: true, recursive: true });
  }
}

function tryDownloadParentManifest(runId, runAttempt, repository = DEFAULT_REPO) {
  return downloadParentManifestEvidence(runId, runAttempt, repository)?.manifest;
}

function workflowPath(run) {
  return String(run.path ?? "").split("@", 1)[0];
}

function normalizedManifestArtifact(artifact, runAttempt) {
  return {
    digest: artifact.digest,
    id: String(artifact.id),
    name: artifact.name,
    runAttempt,
    sizeInBytes: Number(artifact.size_in_bytes),
  };
}

function validateManifestArtifactBinding(artifact, manifest, parentRun, runId) {
  validateManifestArtifactCompatibility(artifact, manifest, runId, parentRun.run_attempt);
  if (
    String(artifact.workflow_run?.id) !== String(runId) ||
    artifact.workflow_run?.head_branch !== parentRun.head_branch ||
    artifact.workflow_run?.head_sha !== parentRun.head_sha
  ) {
    throw new Error(`release validation manifest artifact binding mismatch: ${runId}`);
  }
}

function validateCompletedParentRun(parentView, parentRest, repository, runId) {
  validateParentRunBinding(parentView, parentRest, runId);
  if (
    parentView.status !== "completed" ||
    parentView.conclusion !== "success" ||
    parentRest.status !== "completed" ||
    parentRest.conclusion !== "success" ||
    parentRest.repository?.full_name !== repository
  ) {
    throw new Error(`full release parent run is not completed/success: ${runId}`);
  }
}

export function createReleaseEvidenceClient(repository = DEFAULT_REPO) {
  const normalizedRepository = normalizeRepository(repository);
  return {
    compareCommits(base, head) {
      return githubRestJson(`compare/${base}...${head}`, normalizedRepository);
    },
    getJobLog(jobId) {
      return parentJobLog(jobId, normalizedRepository);
    },
    getParentJobs(runId) {
      return findParentJobsAll(runId, normalizedRepository);
    },
    getRun(runId) {
      return githubRestJson(`actions/runs/${runId}`, normalizedRepository);
    },
    getRunView(runId) {
      return jsonGh([
        "run",
        "view",
        String(runId),
        "--repo",
        normalizedRepository,
        "--json",
        "status,conclusion,attempt,headBranch,headSha,url,jobs",
      ]);
    },
    loadManifest(runId, runAttempt, manifestPath) {
      return downloadParentManifestEvidence(runId, runAttempt, normalizedRepository, manifestPath);
    },
  };
}

function loadValidatedParentEvidence({ client, manifestPath, repository, runId }) {
  const parentView = client.getRunView(runId);
  const parentRun = client.getRun(runId);
  validateCompletedParentRun(parentView, parentRun, repository, runId);

  const manifestEvidence = client.loadManifest(runId, parentRun.run_attempt, manifestPath);
  if (!manifestEvidence) {
    throw new Error(`successful parent run is missing its release validation manifest: ${runId}`);
  }
  const manifest = validateParentManifest(manifestEvidence.manifest, {
    runAttempt: parentRun.run_attempt,
    runId,
    workflowRef: parentRun.head_branch,
    workflowSha: parentRun.head_sha,
  });
  validateManifestArtifactBinding(manifestEvidence.artifact, manifest, parentRun, runId);

  return {
    artifact: manifestEvidence.artifact,
    manifest,
    manifestJson: canonicalJson(manifestEvidence.manifest),
    parentRun,
    parentView,
  };
}

function trustedWorkflowFullRef(workflowRef) {
  return `refs/heads/${workflowRef}`;
}

function normalizeWorkflowPathRef(ref) {
  if (!ref || ref.startsWith("refs/")) {
    return ref;
  }
  return `refs/heads/${ref}`;
}

export function validateTrustedProducerIdentity(evidence, client, verifier, trustedWorkflowRef) {
  const { manifest, parentRun } = evidence;
  // Keep this predicate local: verifier source identity covers this file only.
  const shaPinned = SHA_PINNED_BRANCH_PATTERN.test(manifest.workflowRef ?? "");
  if (manifest.workflowRef !== trustedWorkflowRef && !shaPinned) {
    throw new Error(
      `release evidence producer must run from trusted workflow ref: ${trustedWorkflowRef}`,
    );
  }
  if (shaPinned) {
    if (manifest.version !== 3) {
      throw new Error("SHA-pinned release evidence requires a v3 manifest");
    }
    if (!manifest.workflowRef.startsWith(`release-ci/${manifest.workflowSha.slice(0, 12)}-`)) {
      throw new Error("SHA-pinned release evidence branch does not match its workflow SHA");
    }
    if (manifest.targetRef !== manifest.targetSha) {
      throw new Error("SHA-pinned release evidence target ref must equal its target SHA");
    }
  }
  const expectedFullRef = trustedWorkflowFullRef(manifest.workflowRef);
  const runPath = String(parentRun.path ?? "");
  const [runWorkflowPath, runWorkflowFullRef] = runPath.split("@", 2);
  if (runWorkflowPath !== ".github/workflows/full-release-validation.yml") {
    throw new Error("release evidence producer workflow path is not trusted");
  }
  if (runWorkflowFullRef && normalizeWorkflowPathRef(runWorkflowFullRef) !== expectedFullRef) {
    throw new Error("release evidence producer workflow full ref is not trusted");
  }

  let workflowRefProof = "legacy-v2-main-ancestry";
  if (manifest.version === 3) {
    if (manifest.workflowRefType !== "branch" || manifest.workflowFullRef !== expectedFullRef) {
      throw new Error("release evidence producer workflow full ref is not trusted");
    }
    workflowRefProof = shaPinned ? "manifest-v3-sha-pinned-main-ancestry" : "manifest-v3-branch";
  }

  const comparison = client.compareCommits(manifest.workflowSha, verifier.sourceSha);
  if (
    !["ahead", "identical"].includes(String(comparison.status)) ||
    comparison.merge_base_commit?.sha !== manifest.workflowSha
  ) {
    throw new Error("release evidence producer is not on the trusted main verifier lineage");
  }

  return {
    producerOnTrustedMainLineage: true,
    workflowFullRef: expectedFullRef,
    workflowQualifiedPath: `${runWorkflowPath}@${expectedFullRef}`,
    workflowRefProof,
    workflowRefType: "branch",
    workflowRunPath: runPath,
  };
}

function normalizedParentTuple(evidence, identity) {
  const { manifest, parentRun } = evidence;
  return {
    artifact: normalizedManifestArtifact(evidence.artifact, manifest.runAttempt),
    conclusion: parentRun.conclusion,
    manifest: evidence.manifestJson,
    manifestVersion: manifest.version,
    runAttempt: manifest.runAttempt,
    runId: manifest.runId,
    status: parentRun.status,
    targetSha: manifest.targetSha,
    url: parentRun.html_url ?? evidence.parentView.url,
    ...identity,
    workflowPath: workflowPath(parentRun),
    workflowRef: manifest.workflowRef,
    workflowSha: manifest.workflowSha,
  };
}

export function resolveVerifierIdentity(
  sourceSha,
  verifierSourceContent,
  repositoryRoot = RELEASE_EVIDENCE_REPO_ROOT,
) {
  let normalizedSourceSha = sourceSha ?? process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/u.test(String(normalizedSourceSha ?? ""))) {
    try {
      normalizedSourceSha = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      normalizedSourceSha = null;
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(String(normalizedSourceSha ?? ""))) {
    throw new Error("release evidence verifier source SHA is unavailable");
  }
  const script = readFileSync(RELEASE_EVIDENCE_FILE);
  const scriptSha256 = createHash("sha256").update(script).digest("hex");
  let sourceScript;
  if (verifierSourceContent !== undefined) {
    sourceScript = Buffer.from(verifierSourceContent);
  } else {
    try {
      sourceScript = execFileSync(
        "git",
        ["-C", repositoryRoot, "show", `${normalizedSourceSha}:${RELEASE_EVIDENCE_SCRIPT}`],
        {
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Error("release evidence verifier source blob is unavailable");
    }
  }
  const sourceScriptSha256 = createHash("sha256").update(sourceScript).digest("hex");
  if (scriptSha256 !== sourceScriptSha256) {
    throw new Error("release evidence verifier script differs from its source SHA");
  }
  return {
    schemaVersion: 3,
    script: RELEASE_EVIDENCE_SCRIPT,
    scriptSha256,
    sourceSha: normalizedSourceSha,
  };
}

function validateStrictChildRun({ child, client, parentEvidence, parentJobs, repository, runId }) {
  const run = client.getRun(runId);
  const originAttempt = resolveManifestChildOriginAttempt(
    run,
    child,
    parentEvidence.manifest,
    parentJobs,
  );
  if (originAttempt === undefined) {
    throw new Error(`manifest child dispatch tuple mismatch: ${child.name}`);
  }
  const parentJob = selectManifestParentJob(
    parentJobs,
    child,
    parentEvidence.manifest,
    originAttempt,
  );
  validateManifestChildRun(
    run,
    child,
    runId,
    parentEvidence.manifest,
    parentJobs,
    client.getJobLog(parentJob.id),
    repository,
  );
  if (
    run.repository?.full_name !== repository ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_sha !== parentEvidence.manifest.workflowSha
  ) {
    throw new Error(`manifest child run is not exact completed/success evidence: ${child.name}`);
  }
  if (child.manifestKey === "productPerformance") {
    validatePerformanceArtifactOnlyJobs(client.getParentJobs(runId), run.run_attempt);
  }

  return {
    conclusion: run.conclusion,
    dispatchNonce: `full-release-validation-${parentEvidence.manifest.runId}-${originAttempt}${child.suffix}`,
    displayTitle: run.display_title,
    event: run.event,
    headBranch: run.head_branch,
    parentJobId: String(parentJob.id),
    path: workflowPath(run),
    role: child.manifestKey,
    runAttempt: normalizePositiveInteger(run.run_attempt, `${child.name} run attempt`),
    runId: String(run.id),
    sourceParentAttempt: originAttempt,
    sourceParentRunId: parentEvidence.manifest.runId,
    status: run.status,
    url: run.html_url,
    workflowSha: run.head_sha,
    ...(child.manifestKey === "productPerformance" ? { reportPublication: "artifact-only" } : {}),
  };
}

export function validateReleaseRunEvidence(
  {
    manifestPath,
    repository = DEFAULT_REPO,
    runId,
    trustedWorkflowRef = "main",
    verifierSourceContent,
    verifierSourceSha,
  },
  client,
) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedRunId = normalizeRequiredRunId(runId, "full release run ID");
  const normalizedTrustedWorkflowRef = normalizeWorkflowRef(
    trustedWorkflowRef,
    "trusted workflow ref",
  );
  const evidenceClient = client ?? createReleaseEvidenceClient(normalizedRepository);
  const verifier = resolveVerifierIdentity(verifierSourceSha, verifierSourceContent);
  const currentEvidence = loadValidatedParentEvidence({
    client: evidenceClient,
    manifestPath,
    repository: normalizedRepository,
    runId: normalizedRunId,
  });
  const producerIdentities = new Map([
    [
      currentEvidence.manifest.runId,
      validateTrustedProducerIdentity(
        currentEvidence,
        evidenceClient,
        verifier,
        normalizedTrustedWorkflowRef,
      ),
    ],
  ]);

  let rootEvidence = currentEvidence;
  let selectedEvidence = currentEvidence;
  const reuse = currentEvidence.manifest.evidenceReuse;
  if (reuse) {
    rootEvidence = loadValidatedParentEvidence({
      client: evidenceClient,
      repository: normalizedRepository,
      runId: reuse.runId,
    });
    selectedEvidence =
      reuse.selectedRunId === reuse.runId
        ? rootEvidence
        : loadValidatedParentEvidence({
            client: evidenceClient,
            repository: normalizedRepository,
            runId: reuse.selectedRunId,
          });
    validateEvidenceReuseChain(
      currentEvidence.manifest,
      selectedEvidence.manifest,
      rootEvidence.manifest,
      (base, head) => evidenceClient.compareCommits(base, head),
    );
  }

  for (const evidence of [currentEvidence, selectedEvidence, rootEvidence]) {
    if (!producerIdentities.has(evidence.manifest.runId)) {
      producerIdentities.set(
        evidence.manifest.runId,
        validateTrustedProducerIdentity(
          evidence,
          evidenceClient,
          verifier,
          normalizedTrustedWorkflowRef,
        ),
      );
    }
  }
  const selectedKeys = requiredChildKeysForRerunGroup(rootEvidence.manifest.rerunGroup);
  const expectedChildren = expectedSelectedChildDispatches(
    rootEvidence.manifest.runId,
    rootEvidence.manifest.runAttempt,
    rootEvidence.manifest.workflowRef,
    selectedKeys,
  );
  const parentJobs = evidenceClient.getParentJobs(rootEvidence.manifest.runId);
  const children = manifestChildEntries(rootEvidence.manifest, expectedChildren, selectedKeys).map(
    ({ child, runId: childRunId }) =>
      validateStrictChildRun({
        child,
        client: evidenceClient,
        parentEvidence: rootEvidence,
        parentJobs,
        repository: normalizedRepository,
        runId: childRunId,
      }),
  );

  const current = normalizedParentTuple(
    currentEvidence,
    producerIdentities.get(currentEvidence.manifest.runId),
  );
  const root = normalizedParentTuple(
    rootEvidence,
    producerIdentities.get(rootEvidence.manifest.runId),
  );
  const childConclusions = Object.fromEntries(
    children.map((child) => [child.role, child.conclusion]),
  );
  return canonicalJson({
    children,
    conclusions: {
      allRequiredSucceeded: children.every((child) => child.conclusion === "success"),
      children: childConclusions,
      current: current.conclusion,
      root: root.conclusion,
    },
    controls: rootEvidence.manifest.controls,
    current,
    directRoot: !reuse,
    evidenceReuse: reuse
      ? {
          changedPaths: reuse.changedPaths,
          evidenceSha: reuse.evidenceSha,
          policy: reuse.policy,
          rootRunId: reuse.runId,
          selectedRunId: reuse.selectedRunId,
        }
      : null,
    manifest: rootEvidence.manifestJson,
    releaseProfile: rootEvidence.manifest.releaseProfile,
    repository: normalizedRepository,
    rerunGroup: rootEvidence.manifest.rerunGroup,
    root,
    runReleaseSoak: rootEvidence.manifest.runReleaseSoak === "true",
    schema: RELEASE_EVIDENCE_SCHEMA,
    producerOnTrustedMainLineage: true,
    trustedWorkflowFullRef: trustedWorkflowFullRef(normalizedTrustedWorkflowRef),
    trustedWorkflowRef: normalizedTrustedWorkflowRef,
    valid: true,
    validationInputs: rootEvidence.manifest.validationInputs ?? null,
    verifier,
  });
}

export function parseReleaseCiSummaryArgs(argv) {
  const options = {
    intervalMs: 30_000,
    json: false,
    manifestPath: undefined,
    repository: DEFAULT_REPO,
    runId: undefined,
    trustedWorkflowRef: "main",
    validate: false,
    verifierSourceFile: undefined,
    verifierSourceSha: undefined,
    watch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--validate-run") {
      options.validate = true;
      options.runId = argv[++index];
    } else if (argument === "--repo") {
      options.repository = argv[++index];
    } else if (argument === "--manifest") {
      options.manifestPath = argv[++index];
    } else if (argument === "--trusted-workflow-ref") {
      options.trustedWorkflowRef = argv[++index];
    } else if (argument === "--verifier-source-sha") {
      options.verifierSourceSha = argv[++index];
    } else if (argument === "--verifier-source-file") {
      options.verifierSourceFile = argv[++index];
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--watch") {
      options.watch = true;
    } else if (argument === "--interval") {
      const seconds = argv[++index];
      if (!/^[1-9][0-9]*$/u.test(seconds ?? "")) {
        throw new Error("--interval requires a positive number of seconds");
      }
      options.intervalMs = Number(seconds) * 1000;
    } else if (!argument.startsWith("-") && !options.runId && !options.validate) {
      options.runId = argument;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.validate && options.manifestPath) {
    throw new Error("--manifest requires --validate-run");
  }
  if (options.validate && options.watch) {
    throw new Error("--watch cannot be combined with --validate-run");
  }
  if (options.verifierSourceFile && !options.verifierSourceSha) {
    throw new Error("--verifier-source-file requires --verifier-source-sha");
  }
  if (!options.runId) {
    throw new Error("full release run ID is required");
  }
  return options;
}

function printUsage() {
  console.error(
    [
      "usage: release-ci-summary.mjs <full-release-run-id>",
      "       release-ci-summary.mjs <full-release-run-id> --watch [--interval seconds]",
      "       release-ci-summary.mjs --validate-run <id> [--repo owner/name] [--trusted-workflow-ref main] [--manifest path] [--verifier-source-sha sha --verifier-source-file path] --json",
    ].join("\n"),
  );
}

export function releaseCiWatchFingerprint(parent) {
  return JSON.stringify({
    attempt: parent.attempt,
    conclusion: parent.conclusion ?? "",
    jobs: (parent.jobs ?? [])
      .map((job) => ({
        conclusion: job.conclusion ?? "",
        name: job.name,
        status: job.status,
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    status: parent.status,
  });
}

function summarizeReleaseCiRun(options) {
  execFileSync(
    process.execPath,
    [
      RELEASE_EVIDENCE_FILE,
      options.runId,
      "--repo",
      options.repository,
      "--trusted-workflow-ref",
      options.trustedWorkflowRef,
    ],
    { stdio: "inherit" },
  );
}

export async function watchReleaseCiRun(options, overrides = {}) {
  const fetchParent =
    overrides.fetchParent ??
    (() =>
      jsonGh([
        "run",
        "view",
        options.runId,
        "--repo",
        options.repository,
        "--json",
        "status,conclusion,attempt,jobs",
      ]));
  const summarize = overrides.summarize ?? (() => summarizeReleaseCiRun(options));
  const sleep =
    overrides.sleep ??
    ((milliseconds) =>
      new Promise((complete) => {
        setTimeout(complete, milliseconds);
      }));
  let previousFingerprint;
  while (true) {
    const parent = fetchParent();
    const fingerprint = releaseCiWatchFingerprint(parent);
    if (fingerprint !== previousFingerprint) {
      summarize();
      previousFingerprint = fingerprint;
    }
    if (parent.status === "completed") {
      if (parent.conclusion !== "success") {
        throw new Error(
          `full release run ${options.runId} completed with ${parent.conclusion || "no conclusion"}`,
        );
      }
      return;
    }
    await sleep(options.intervalMs);
  }
}

async function main() {
  let options;
  try {
    options = parseReleaseCiSummaryArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const { repository, runId } = options;

  if (options.validate) {
    try {
      const evidence = validateReleaseRunEvidence({
        manifestPath: options.manifestPath,
        repository,
        runId,
        trustedWorkflowRef: options.trustedWorkflowRef,
        verifierSourceContent: options.verifierSourceFile
          ? readFileSync(options.verifierSourceFile)
          : undefined,
        verifierSourceSha: options.verifierSourceSha,
      });
      console.log(JSON.stringify(evidence, null, options.json ? 2 : 0));
    } catch (error) {
      const failure = {
        error: error instanceof Error ? error.message : String(error),
        schema: RELEASE_EVIDENCE_SCHEMA,
        valid: false,
      };
      if (options.json) {
        console.log(JSON.stringify(failure, null, 2));
      } else {
        console.error(failure.error);
      }
      process.exit(1);
    }
    return;
  }
  if (options.watch) {
    await watchReleaseCiRun(options);
    return;
  }

  const core = rate();
  if (core) {
    const reset = new Date(core.reset * 1000).toISOString();
    console.log(`rate: remaining=${core.remaining}/${core.limit} reset=${reset}`);
    if (core.remaining < 20) {
      console.error("rate too low for CI summary; wait for reset before polling");
      process.exit(3);
    }
  }

  const parent = jsonGh([
    "run",
    "view",
    runId,
    "--repo",
    repository,
    "--json",
    "status,conclusion,attempt,headBranch,headSha,url,jobs",
  ]);
  validateParentRunBinding(parent, githubRestJson(`actions/runs/${runId}`, repository), runId);

  console.log(`parent: ${runId} ${parent.status}/${parent.conclusion || "none"}`);
  console.log(`workflow-ref: ${parent.headBranch}`);
  console.log(`workflow-sha: ${parent.headSha}`);
  console.log(`url: ${parent.url}`);

  for (const job of parent.jobs ?? []) {
    const marker = job.conclusion || job.status;
    console.log(`parent-job: ${marker} ${job.name}`);
  }

  const currentManifestRaw = tryDownloadParentManifest(runId, parent.attempt, repository);
  let children;
  if (currentManifestRaw) {
    const currentManifest = validateParentManifest(currentManifestRaw, {
      runAttempt: parent.attempt,
      runId,
      workflowRef: parent.headBranch,
      workflowSha: parent.headSha,
    });
    console.log(`candidate-sha: ${currentManifest.targetSha}`);
    console.log(`manifest-run: ${currentManifest.runId}/${currentManifest.runAttempt}`);

    let sourceManifest = currentManifest;
    let sourceParent = parent;
    if (currentManifest.evidenceReuse) {
      const rootRunId = currentManifest.evidenceReuse.runId;
      const rootParent = jsonGh([
        "run",
        "view",
        rootRunId,
        "--repo",
        repository,
        "--json",
        "status,conclusion,attempt,headBranch,headSha,url,jobs",
      ]);
      validateParentRunBinding(
        rootParent,
        githubRestJson(`actions/runs/${rootRunId}`, repository),
        rootRunId,
      );
      if (rootParent.status !== "completed" || rootParent.conclusion !== "success") {
        throw new Error(`evidence root run is not completed/success: ${rootRunId}`);
      }
      const rootManifestRaw = tryDownloadParentManifest(rootRunId, rootParent.attempt, repository);
      if (!rootManifestRaw) {
        throw new Error(`evidence root manifest is unavailable: ${rootRunId}`);
      }
      const rootManifest = validateParentManifest(rootManifestRaw, {
        runAttempt: rootParent.attempt,
        runId: rootRunId,
        workflowRef: rootParent.headBranch,
        workflowSha: rootParent.headSha,
      });

      const selectedRunId = currentManifest.evidenceReuse.selectedRunId;
      let selectedManifest = rootManifest;
      if (selectedRunId !== rootRunId) {
        const selectedParent = jsonGh([
          "run",
          "view",
          selectedRunId,
          "--repo",
          repository,
          "--json",
          "status,conclusion,attempt,headBranch,headSha,url,jobs",
        ]);
        validateParentRunBinding(
          selectedParent,
          githubRestJson(`actions/runs/${selectedRunId}`, repository),
          selectedRunId,
        );
        if (selectedParent.status !== "completed" || selectedParent.conclusion !== "success") {
          throw new Error(`selected evidence run is not completed/success: ${selectedRunId}`);
        }
        const selectedManifestRaw = tryDownloadParentManifest(
          selectedRunId,
          selectedParent.attempt,
          repository,
        );
        if (!selectedManifestRaw) {
          throw new Error(`selected evidence manifest is unavailable: ${selectedRunId}`);
        }
        selectedManifest = validateParentManifest(selectedManifestRaw, {
          runAttempt: selectedParent.attempt,
          runId: selectedRunId,
          workflowRef: selectedParent.headBranch,
          workflowSha: selectedParent.headSha,
        });
      }

      const evidenceSha = validateEvidenceReuseChain(
        currentManifest,
        selectedManifest,
        rootManifest,
        (base, head) => githubRestJson(`compare/${base}...${head}`, repository),
      );
      sourceManifest = rootManifest;
      sourceParent = rootParent;
      console.log(`evidence-selected-run: ${selectedRunId}`);
      console.log(`evidence-root-run: ${rootRunId}`);
      console.log(`evidence-sha: ${evidenceSha}`);
      console.log(`evidence-policy: ${currentManifest.evidenceReuse.policy}`);
      console.log(
        `evidence-changed-paths: ${JSON.stringify(currentManifest.evidenceReuse.changedPaths)}`,
      );
    }

    const expectedChildren = expectedSelectedChildDispatches(
      sourceManifest.runId,
      sourceManifest.runAttempt,
      sourceManifest.workflowRef,
      requiredChildKeysForRerunGroup(sourceManifest.rerunGroup),
    );
    const sourceParentJobs = findParentJobsAll(sourceManifest.runId, repository);
    children = manifestChildEntries(
      sourceManifest,
      expectedChildren,
      requiredChildKeysForRerunGroup(sourceManifest.rerunGroup),
    ).map(({ child, runId: childRunId }) => {
      const run = githubRestJson(`actions/runs/${childRunId}`, repository);
      const originAttempt = resolveManifestChildOriginAttempt(
        run,
        child,
        sourceManifest,
        sourceParentJobs,
      );
      if (originAttempt === undefined) {
        throw new Error(`manifest child dispatch tuple mismatch: ${child.name}`);
      }
      const parentJob = selectManifestParentJob(
        sourceParentJobs,
        child,
        sourceManifest,
        originAttempt,
      );
      const validatedRun = validateManifestChildRun(
        run,
        child,
        childRunId,
        { ...sourceManifest, workflowSha: sourceParent.headSha },
        sourceParentJobs,
        parentJobLog(parentJob.id, repository),
        repository,
      );
      if (child.manifestKey === "productPerformance") {
        validatePerformanceArtifactOnlyJobs(
          findParentJobsAll(childRunId, repository),
          run.run_attempt,
        );
      }
      return { child, run: validatedRun };
    });
  } else {
    console.log("candidate-sha: unavailable (release validation manifest not uploaded)");
    if (parent.status === "completed" && parent.conclusion === "success") {
      throw new Error("successful parent run is missing its release validation manifest");
    }
    const selectedKeys = selectedChildKeys(parent.jobs ?? []);
    children = expectedSelectedChildDispatches(
      runId,
      parent.attempt,
      parent.headBranch,
      selectedKeys,
    )
      .map((child) => {
        const run = findExactChildRun(child, repository);
        if (!run) {
          console.log(
            `child-missing: ${child.name} title=${child.displayTitle} branch=${child.headBranch}`,
          );
        }
        return { child, run };
      })
      .filter((entry) => entry.run);
  }
  if (children.length === 0) {
    console.log("children: none found yet");
    return;
  }

  console.log("children:");
  for (const { child, run } of children) {
    console.log(
      `child: ${run.id} ${child.name} ${run.status}/${run.conclusion || "none"} branch=${run.head_branch} workflow_sha=${run.head_sha}`,
    );
    console.log(`child-url: ${run.html_url}`);
  }
}

if (process.argv[1]?.endsWith("release-ci-summary.mjs")) {
  await main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
