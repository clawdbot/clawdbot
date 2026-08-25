#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";

type JsonRecord = Record<string, unknown>;
export type AuthorizedBetaFocusedPolicy = {
  schema: string;
  mode: string;
  releaseTag: string;
  releaseVersion: string;
  baseCandidateSha: string;
  candidateSha: string;
  reviewedHeadSha: string;
  candidateTreeSha: string;
  baseTreeSha: string;
  packageProjectionSha256: string;
  eligibilityPlanDigest: string;
  historicalToolingSha: string;
  historicalToolingRef: string;
  historicalFrv: {
    runId: string;
    runAttempt: number;
    workflowPath: string;
    workflowRef: string;
    targetSha: string;
    ciRunId: string;
    ciFailedJobId: string;
    ciAggregateJobId: string;
    pluginRunId: string;
    pluginFailedJobId: string;
    pluginAggregateJobId: string;
    releaseChecksRunId: string;
    releaseChecksVerifierJobId: string;
    performanceRunId: string;
    performanceFailedJobId: string;
  };
  focusedProof: {
    ciRunId: string;
    ciTargetLogJobId: string;
    ciSuccessJobId: string;
    pluginRunId: string;
    pluginTargetLogJobId: string;
    pluginSuccessJobId: string;
  };
  changedPaths: Array<{
    path: string;
    status: string;
    added: number;
    deleted: number;
  }>;
  inventory: {
    npmCount: number;
    npmNamesSha256: string;
    clawHubCount: number;
    clawHubNamesSha256: string;
    trustedPublisherCount: number;
    trustedPublisherNamesSha256: string;
    bootstrapCount: number;
    bootstrapNamesSha256: string;
    missingTrustedPublisherCount: number;
  };
};

export type AuthorizedBetaFocusedProducerIdentity = {
  repository: string;
  runId: string;
  runAttempt: number;
  workflowPath: string;
  workflowFullRef: string;
  workflowRef: string;
  workflowSha: string;
};

export type AuthorizedBetaFocusedEvidence = {
  schema: "openclaw.authorized-beta-focused-evidence.v1";
  mode: "authorized-beta-focused-v1";
  policySha256: string;
  releaseTag: string;
  candidate: {
    sha: string;
    parentSha: string;
    treeSha: string;
    packageProjectionSha256: string;
    changedPaths: AuthorizedBetaFocusedPolicy["changedPaths"];
  };
  producer: AuthorizedBetaFocusedProducerIdentity;
  historical: {
    frvRunId: string;
    frvRunAttempt: number;
    releaseChecksRunId: string;
    performanceRunId: string;
  };
  focused: {
    ciRunId: string;
    ciJobId: string;
    pluginRunId: string;
    pluginJobId: string;
    reviewedHeadSha: string;
  };
  inventory: {
    eligibilityPlanDigest: string;
    npmCount: number;
    npmNamesSha256: string;
    clawHubCount: number;
    clawHubNamesSha256: string;
    trustedPublisherCount: number;
    trustedPublisherNamesSha256: string;
    bootstrapCount: number;
    bootstrapNamesSha256: string;
    missingTrustedPublisherCount: number;
  };
};

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = resolve(SCRIPT_ROOT, "authorized-beta-focused-policy.json");
const REPOSITORY = "openclaw/openclaw";
const PRODUCER_WORKFLOW = ".github/workflows/authorized-beta-focused-validation.yml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const PROTECTED_TAG_PATTERN = /^refs\/tags\/release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;

function fail(message: string): never {
  throw new Error(message);
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function exactPositiveInteger(value: unknown, label: string): number {
  const normalized = typeof value === "number" ? String(value) : exactString(value, label);
  if (!POSITIVE_INTEGER_PATTERN.test(normalized)) {
    fail(`${label} must be a positive integer`);
  }
  return Number(normalized);
}

function exactJsonId(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return exactString(value, label);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestAuthorizedBetaFocusedPolicy(policy: AuthorizedBetaFocusedPolicy): string {
  return sha256(stableJson(policy));
}

export async function assertAuthorizedEligibilityPlanDigest(
  plan: unknown,
  expectedDigest: string,
): Promise<string> {
  const { createReleasePlanLock } = await import("./release-plan-contract.mjs");
  const digest = createReleasePlanLock(plan).digest;
  if (digest !== expectedDigest) {
    fail(`authorized eligibility plan digest mismatch: expected ${expectedDigest}, got ${digest}`);
  }
  return digest;
}

export function readAuthorizedBetaFocusedPolicy(): AuthorizedBetaFocusedPolicy {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8")) as AuthorizedBetaFocusedPolicy;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function ghJson(endpoint: string): JsonRecord {
  const value: unknown = JSON.parse(gh(["api", endpoint]));
  if (!isRecord(value)) {
    fail(`${endpoint} must be an object`);
  }
  return value;
}

function normalizeRun(run: JsonRecord) {
  return {
    id: exactJsonId(run.id, "run id"),
    attempt: exactPositiveInteger(run.run_attempt, "run attempt"),
    name: exactString(run.name, "run name"),
    path: exactString(run.path, "run path").split("@", 1)[0] ?? "",
    event: exactString(run.event, "run event"),
    status: exactString(run.status, "run status"),
    conclusion:
      run.conclusion === null || run.conclusion === undefined
        ? ""
        : exactString(run.conclusion, "run conclusion"),
    headBranch: exactString(run.head_branch, "run head branch"),
    headSha: exactString(run.head_sha, "run head SHA"),
  };
}

function normalizeJob(job: JsonRecord) {
  return {
    id: exactJsonId(job.id, "job id"),
    runId: exactJsonId(job.run_id, "job run id"),
    name: exactString(job.name, "job name"),
    status: exactString(job.status, "job status"),
    conclusion:
      job.conclusion === null || job.conclusion === undefined
        ? ""
        : exactString(job.conclusion, "job conclusion"),
    headSha: exactString(job.head_sha, "job head SHA"),
  };
}

function requireRun(params: {
  runId: string;
  attempt: number;
  name: string;
  path: string;
  headBranch: string;
  headSha: string;
  conclusion?: string;
  allowInProgress?: boolean;
}) {
  const run = normalizeRun(ghJson(`repos/${REPOSITORY}/actions/runs/${params.runId}`));
  const checks: Array<[string, string | number, string | number]> = [
    ["id", run.id, params.runId],
    ["attempt", run.attempt, params.attempt],
    ["name", run.name, params.name],
    ["path", run.path, params.path],
    ["event", run.event, "workflow_dispatch"],
    ["headBranch", run.headBranch, params.headBranch],
    ["headSha", run.headSha, params.headSha],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      fail(`run ${params.runId} ${label} mismatch: expected ${expected}, got ${actual}`);
    }
  }
  if (params.allowInProgress) {
    if (!["in_progress", "queued", "completed"].includes(run.status)) {
      fail(`run ${params.runId} has unsupported producer status ${run.status}`);
    }
  } else if (run.status !== "completed" || run.conclusion !== (params.conclusion ?? "success")) {
    fail(
      `run ${params.runId} must be completed/${params.conclusion ?? "success"}, got ${run.status}/${run.conclusion}`,
    );
  }
  return run;
}

function requireJob(params: {
  jobId: string;
  runId: string;
  name: string;
  conclusion: string;
  headSha: string;
}) {
  const job = normalizeJob(ghJson(`repos/${REPOSITORY}/actions/jobs/${params.jobId}`));
  const checks: Array<[string, string, string]> = [
    ["id", job.id, params.jobId],
    ["runId", job.runId, params.runId],
    ["name", job.name, params.name],
    ["status", job.status, "completed"],
    ["conclusion", job.conclusion, params.conclusion],
    ["headSha", job.headSha, params.headSha],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      fail(`job ${params.jobId} ${label} mismatch: expected ${expected}, got ${actual}`);
    }
  }
}

function jobLogArgs(jobId: string, allowEscapeSequences = true) {
  const args = ["api", `repos/${REPOSITORY}/actions/jobs/${jobId}/logs`];
  if (allowEscapeSequences) {
    args.push("--allow-escape-sequences");
  }
  return args;
}

function isUnknownAllowEscapeSequencesFlag(error: unknown) {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return false;
  }
  const stderr = error.stderr;
  return (
    typeof stderr === "string" &&
    stderr.replace(/\r\n?/gu, "\n").split("\n").includes("unknown flag: --allow-escape-sequences")
  );
}

function requireJobLogTarget(jobId: string, targetSha: string) {
  let log: string;
  try {
    log = gh(jobLogArgs(jobId));
  } catch (error) {
    if (!isUnknownAllowEscapeSequencesFlag(error)) {
      throw error;
    }
    log = gh(jobLogArgs(jobId, false));
  }
  if (!log.includes(targetSha)) {
    fail(`job ${jobId} log does not bind target ${targetSha}`);
  }
}

function requireHistoricalExecutionPlan(policy: AuthorizedBetaFocusedPolicy) {
  const historical = policy.historicalFrv;
  const directory = mkdtempSync(join(tmpdir(), "authorized-beta-focused-plan-"));
  try {
    gh([
      "run",
      "download",
      historical.runId,
      "--repo",
      REPOSITORY,
      "--name",
      `full-release-execution-plan-${historical.runId}`,
      "--dir",
      directory,
    ]);
    const planValue: unknown = JSON.parse(
      readFileSync(join(directory, "full-release-execution-plan.json"), "utf8"),
    );
    if (!isRecord(planValue)) {
      fail("historical full release execution plan must be an object");
    }
    const plan = planValue;
    const checks: Array<[string, unknown, string | number]> = [
      ["parentRunId", plan.parentRunId, historical.runId],
      ["parentRunAttempt", plan.parentRunAttempt, historical.runAttempt],
      ["workflowRef", plan.workflowRef, historical.workflowRef],
      ["workflowSha", plan.workflowSha, policy.historicalToolingSha],
      ["targetSha", plan.targetSha, historical.targetSha],
      ["releaseProfile", plan.releaseProfile, "beta"],
      ["rerunGroup", plan.rerunGroup, "all"],
    ];
    for (const [label, actual, expected] of checks) {
      if (actual !== expected) {
        fail(
          `historical execution plan ${label} mismatch: expected ${expected}, got ${JSON.stringify(actual)}`,
        );
      }
    }
    if (!Array.isArray(plan.children)) {
      fail("historical execution plan children must be an array");
    }
    const childRuns = new Map(
      plan.children.flatMap((entry: unknown) => {
        if (!isRecord(entry)) {
          fail("historical execution plan child must be an object");
        }
        if (entry.selected !== true) {
          return [];
        }
        return [
          [
            exactString(entry.key, "historical execution plan child key"),
            exactJsonId(entry.runId, "historical execution plan child run id"),
          ],
        ];
      }),
    );
    const expectedChildren = new Map([
      ["normalCi", historical.ciRunId],
      ["pluginPrerelease", historical.pluginRunId],
      ["releaseChecks", historical.releaseChecksRunId],
      ["productPerformance", historical.performanceRunId],
    ]);
    for (const [key, expectedRunId] of expectedChildren) {
      if (childRuns.get(key) !== expectedRunId) {
        fail(`historical execution plan child ${key} must be run ${expectedRunId}`);
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function digestAuthorizedPackageNames(names: string[]): string {
  const sorted = [...names].toSorted();
  if (new Set(sorted).size !== sorted.length) {
    fail("package inventory contains duplicate names");
  }
  return sha256(`${sorted.join("\n")}\n`);
}

export function assertAuthorizedBetaFocusedCandidate(
  policy: AuthorizedBetaFocusedPolicy,
  candidateRoot: string,
) {
  const actualHead = git(candidateRoot, ["rev-parse", "HEAD"]);
  if (actualHead !== policy.candidateSha) {
    fail(`candidate checkout must be ${policy.candidateSha}, got ${actualHead}`);
  }
  const parents = git(candidateRoot, ["rev-list", "--parents", "-n1", policy.candidateSha]).split(
    " ",
  );
  if (parents.length !== 2 || parents[1] !== policy.baseCandidateSha) {
    fail("candidate must be the direct child of the frozen base candidate");
  }
  const candidateTree = git(candidateRoot, ["rev-parse", `${policy.candidateSha}^{tree}`]);
  const baseTree = git(candidateRoot, ["rev-parse", `${policy.baseCandidateSha}^{tree}`]);
  try {
    git(candidateRoot, ["cat-file", "-e", `${policy.reviewedHeadSha}^{commit}`]);
  } catch {
    git(candidateRoot, ["fetch", "--no-tags", "origin", policy.reviewedHeadSha]);
  }
  const reviewedTree = git(candidateRoot, ["rev-parse", `${policy.reviewedHeadSha}^{tree}`]);
  if (
    candidateTree !== policy.candidateTreeSha ||
    baseTree !== policy.baseTreeSha ||
    reviewedTree !== candidateTree
  ) {
    fail("candidate/base/reviewed tree identity does not match the authorized policy");
  }

  const statuses = new Map(
    git(candidateRoot, [
      "diff",
      "--name-status",
      "--no-renames",
      policy.baseCandidateSha,
      policy.candidateSha,
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split("\t");
        return [path, status];
      }),
  );
  const numstat = new Map(
    git(candidateRoot, ["diff", "--numstat", policy.baseCandidateSha, policy.candidateSha])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, deleted, path] = line.split("\t");
        return [path, { added: Number(added), deleted: Number(deleted) }];
      }),
  );
  if (statuses.size !== policy.changedPaths.length || numstat.size !== policy.changedPaths.length) {
    fail("candidate changed-path count does not match the authorized policy");
  }
  for (const expected of policy.changedPaths) {
    const actualNumstat = numstat.get(expected.path);
    if (
      statuses.get(expected.path) !== expected.status ||
      actualNumstat?.added !== expected.added ||
      actualNumstat.deleted !== expected.deleted
    ) {
      fail(`candidate diff does not match authorized path ${expected.path}`);
    }
  }

  const excluded = new Set(policy.changedPaths.map((entry) => entry.path));
  const projection = git(candidateRoot, ["ls-tree", "-r", policy.candidateSha])
    .split("\n")
    .filter((line) => line && !excluded.has(line.slice(line.indexOf("\t") + 1)))
    .join("\n");
  const projectionDigest = sha256(`${projection}\n`);
  if (projectionDigest !== policy.packageProjectionSha256) {
    fail("candidate published-byte projection digest does not match the authorized policy");
  }
}

function assertHistoricalAndFocusedEvidence(policy: AuthorizedBetaFocusedPolicy) {
  const historical = policy.historicalFrv;
  requireHistoricalExecutionPlan(policy);
  requireRun({
    runId: historical.runId,
    attempt: historical.runAttempt,
    name: "Full Release Validation",
    path: historical.workflowPath,
    headBranch: historical.workflowRef,
    headSha: policy.historicalToolingSha,
    conclusion: "failure",
  });
  requireRun({
    runId: historical.ciRunId,
    attempt: 1,
    name: `CI full-release-validation-${historical.runId}-${historical.runAttempt}-ci`,
    path: ".github/workflows/ci.yml",
    headBranch: historical.workflowRef,
    headSha: policy.historicalToolingSha,
    conclusion: "failure",
  });
  requireJob({
    jobId: historical.ciFailedJobId,
    runId: historical.ciRunId,
    name: "check-lint",
    conclusion: "failure",
    headSha: policy.historicalToolingSha,
  });
  requireJob({
    jobId: historical.ciAggregateJobId,
    runId: historical.ciRunId,
    name: "openclaw/ci-gate",
    conclusion: "failure",
    headSha: policy.historicalToolingSha,
  });
  requireRun({
    runId: historical.pluginRunId,
    attempt: 1,
    name: `Plugin Prerelease full-release-validation-${historical.runId}-${historical.runAttempt}-plugin-prerelease`,
    path: ".github/workflows/plugin-prerelease.yml",
    headBranch: historical.workflowRef,
    headSha: policy.historicalToolingSha,
    conclusion: "failure",
  });
  requireJob({
    jobId: historical.pluginFailedJobId,
    runId: historical.pluginRunId,
    name: "checks-node-extensions-shard-7",
    conclusion: "failure",
    headSha: policy.historicalToolingSha,
  });
  requireJob({
    jobId: historical.pluginAggregateJobId,
    runId: historical.pluginRunId,
    name: "plugin-prerelease-suite",
    conclusion: "failure",
    headSha: policy.historicalToolingSha,
  });
  requireRun({
    runId: historical.releaseChecksRunId,
    attempt: 1,
    name: `OpenClaw Release Checks full-release-validation-${historical.runId}-${historical.runAttempt}-release-checks`,
    path: ".github/workflows/openclaw-release-checks.yml",
    headBranch: historical.workflowRef,
    headSha: policy.historicalToolingSha,
  });
  requireJob({
    jobId: historical.releaseChecksVerifierJobId,
    runId: historical.releaseChecksRunId,
    name: "Verify release checks",
    conclusion: "success",
    headSha: policy.historicalToolingSha,
  });
  requireRun({
    runId: historical.performanceRunId,
    attempt: 1,
    name: `OpenClaw Performance full-release-validation-${historical.runId}-${historical.runAttempt}`,
    path: ".github/workflows/openclaw-performance.yml",
    headBranch: historical.workflowRef,
    headSha: policy.historicalToolingSha,
    conclusion: "failure",
  });
  requireJob({
    jobId: historical.performanceFailedJobId,
    runId: historical.performanceRunId,
    name: "OpenClaw source performance probes",
    conclusion: "failure",
    headSha: policy.historicalToolingSha,
  });

  const focused = policy.focusedProof;
  requireRun({
    runId: focused.ciRunId,
    attempt: 1,
    name: "CI beta3-slack-proof-e347223a",
    path: ".github/workflows/ci.yml",
    headBranch: policy.historicalToolingRef.replace("refs/tags/", ""),
    headSha: policy.historicalToolingSha,
    allowInProgress: true,
  });
  requireJob({
    jobId: focused.ciSuccessJobId,
    runId: focused.ciRunId,
    name: "check-lint",
    conclusion: "success",
    headSha: policy.historicalToolingSha,
  });
  requireJob({
    jobId: focused.ciTargetLogJobId,
    runId: focused.ciRunId,
    name: "preflight",
    conclusion: "success",
    headSha: policy.historicalToolingSha,
  });
  requireJobLogTarget(focused.ciTargetLogJobId, policy.reviewedHeadSha);
  requireRun({
    runId: focused.pluginRunId,
    attempt: 1,
    name: "Plugin Prerelease beta3-slack-proof-e347223a",
    path: ".github/workflows/plugin-prerelease.yml",
    headBranch: policy.historicalToolingRef.replace("refs/tags/", ""),
    headSha: policy.historicalToolingSha,
    conclusion: "failure",
  });
  requireJob({
    jobId: focused.pluginSuccessJobId,
    runId: focused.pluginRunId,
    name: "checks-node-extensions-shard-7",
    conclusion: "success",
    headSha: policy.historicalToolingSha,
  });
  requireJob({
    jobId: focused.pluginTargetLogJobId,
    runId: focused.pluginRunId,
    name: "Build plugin prerelease plan",
    conclusion: "success",
    headSha: policy.historicalToolingSha,
  });
  requireJobLogTarget(focused.pluginTargetLogJobId, policy.reviewedHeadSha);
}

function producerIdentity(args: ParsedArgs): AuthorizedBetaFocusedProducerIdentity {
  const workflowFullRef = exactString(args["producer-workflow-full-ref"], "producer workflow ref");
  const workflowSha = exactString(args["producer-workflow-sha"], "producer workflow SHA");
  const protectedTag = PROTECTED_TAG_PATTERN.exec(workflowFullRef);
  if (
    !SHA_PATTERN.test(workflowSha) ||
    !protectedTag ||
    protectedTag[1] !== workflowSha.slice(0, 12)
  ) {
    fail("focused evidence producer must use a SHA-bound protected release-publish tag");
  }
  return {
    repository: REPOSITORY,
    runId: exactString(args["producer-run-id"], "producer run id"),
    runAttempt: exactPositiveInteger(args["producer-run-attempt"], "producer run attempt"),
    workflowPath: PRODUCER_WORKFLOW,
    workflowFullRef,
    workflowRef: workflowFullRef.replace("refs/tags/", ""),
    workflowSha,
  };
}

function assertProducer(identity: AuthorizedBetaFocusedProducerIdentity, allowInProgress: boolean) {
  requireRun({
    runId: identity.runId,
    attempt: identity.runAttempt,
    name: "Authorized Beta Focused Validation",
    path: identity.workflowPath,
    headBranch: identity.workflowRef,
    headSha: identity.workflowSha,
    allowInProgress,
  });
  const ref = ghJson(`repos/${REPOSITORY}/git/ref/tags/${identity.workflowRef}`);
  if (!isRecord(ref.object)) {
    fail("protected tooling tag object must be an object");
  }
  const object = ref.object;
  if (object.type !== "commit" || object.sha !== identity.workflowSha) {
    fail("protected focused-evidence tooling tag does not resolve to the producer SHA");
  }
}

async function produceAuthorizedEligibilityPlan(
  policy: AuthorizedBetaFocusedPolicy,
  candidateRoot: string,
) {
  const directory = mkdtempSync(join(tmpdir(), "authorized-beta-focused-tooling-"));
  const toolingRoot = join(directory, "tooling");
  try {
    // The producer binds its execution checkout to toolingSha. Run the frozen
    // producer itself so this evidence cannot substitute the current workflow.
    git(candidateRoot, [
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      candidateRoot,
      toolingRoot,
    ]);
    git(toolingRoot, ["checkout", "--quiet", "--detach", policy.historicalToolingSha]);
    symlinkSync(
      resolve(SCRIPT_ROOT, "..", "node_modules"),
      join(toolingRoot, "node_modules"),
      "dir",
    );
    const lockJson = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/release-plan-producer.mts",
        "--intent",
        "publish",
        "--candidate-sha",
        policy.candidateSha,
        "--candidate-ref",
        `refs/tags/${policy.releaseTag}`,
        "--tooling-sha",
        policy.historicalToolingSha,
        "--tooling-full-ref",
        policy.historicalToolingRef,
      ],
      {
        cwd: toolingRoot,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const { parseReleasePlanLockJson } = await import("./release-plan-contract.mjs");
    return parseReleasePlanLockJson(lockJson).plan;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function collectInventory(
  policy: AuthorizedBetaFocusedPolicy,
  candidateRoot: string,
  includeTrust: boolean,
) {
  const plan = await produceAuthorizedEligibilityPlan(policy, candidateRoot);
  const eligibilityPlanDigest = await assertAuthorizedEligibilityPlanDigest(
    plan,
    policy.eligibilityPlanDigest,
  );
  const npmNames = plan.inventory.packages
    .filter((entry) => entry.targets.includes("npm"))
    .map((entry) => entry.name);
  const clawHubNames = plan.inventory.packages
    .filter((entry) => entry.targets.includes("clawhub"))
    .map((entry) => entry.name);
  const inventory = {
    eligibilityPlanDigest,
    npmCount: npmNames.length,
    npmNamesSha256: digestAuthorizedPackageNames(npmNames),
    clawHubCount: clawHubNames.length,
    clawHubNamesSha256: digestAuthorizedPackageNames(clawHubNames),
    trustedPublisherCount: policy.inventory.trustedPublisherCount,
    trustedPublisherNamesSha256: policy.inventory.trustedPublisherNamesSha256,
    bootstrapCount: policy.inventory.bootstrapCount,
    bootstrapNamesSha256: policy.inventory.bootstrapNamesSha256,
    missingTrustedPublisherCount: policy.inventory.missingTrustedPublisherCount,
  };
  if (includeTrust) {
    const { collectPluginClawHubReleasePlan } = await import("./lib/plugin-clawhub-release.ts");
    const trustPlan = await collectPluginClawHubReleasePlan({
      rootDir: candidateRoot,
      selectionMode: "all-publishable",
    });
    const trusted = trustPlan.candidates.map((entry) => entry.packageName);
    const bootstrap = [...trustPlan.bootstrapCandidates, ...trustPlan.missingTrustedPublisher].map(
      (entry) => entry.packageName,
    );
    inventory.trustedPublisherCount = trusted.length;
    inventory.trustedPublisherNamesSha256 = digestAuthorizedPackageNames(trusted);
    inventory.bootstrapCount = bootstrap.length;
    inventory.bootstrapNamesSha256 = digestAuthorizedPackageNames(bootstrap);
    inventory.missingTrustedPublisherCount = trustPlan.missingTrustedPublisher.length;
  }
  for (const [key, expected] of Object.entries(policy.inventory)) {
    if (inventory[key as keyof typeof inventory] !== expected) {
      fail(
        `authorized inventory ${key} mismatch: expected ${expected}, got ${inventory[key as keyof typeof inventory]}`,
      );
    }
  }
  return inventory;
}

export function validateAuthorizedBetaFocusedArtifactShape(
  evidence: AuthorizedBetaFocusedEvidence,
  policy: AuthorizedBetaFocusedPolicy,
  producer: AuthorizedBetaFocusedProducerIdentity,
  expectedInventory: AuthorizedBetaFocusedEvidence["inventory"],
) {
  if (
    evidence.schema !== "openclaw.authorized-beta-focused-evidence.v1" ||
    evidence.mode !== policy.mode ||
    evidence.policySha256 !== digestAuthorizedBetaFocusedPolicy(policy) ||
    evidence.releaseTag !== policy.releaseTag ||
    stableJson(evidence.producer) !== stableJson(producer)
  ) {
    fail("focused evidence artifact identity does not match the fixed policy");
  }
  if (
    evidence.candidate.sha !== policy.candidateSha ||
    evidence.candidate.parentSha !== policy.baseCandidateSha ||
    evidence.candidate.treeSha !== policy.candidateTreeSha ||
    evidence.candidate.packageProjectionSha256 !== policy.packageProjectionSha256 ||
    stableJson(evidence.candidate.changedPaths) !== stableJson(policy.changedPaths)
  ) {
    fail("focused evidence candidate projection does not match the fixed policy");
  }
  if (stableJson(evidence.inventory) !== stableJson(expectedInventory)) {
    fail("focused evidence inventory does not match the repository-derived release plan");
  }
}

type ParsedArgs = Record<string, string>;

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== "create" && command !== "verify") {
    fail("usage: validate-authorized-beta-focused-evidence.mts <create|verify> [options]");
  }
  const args: ParsedArgs = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`invalid argument near ${key ?? "<missing>"}`);
    }
    args[key.slice(2)] = value;
  }
  return { command, args } as const;
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  const policy = readAuthorizedBetaFocusedPolicy();
  const candidateRoot = resolve(exactString(args["candidate-root"], "candidate root"));
  const artifactPath = resolve(exactString(args.artifact ?? args.output, "artifact path"));
  const producer = producerIdentity(args);
  assertAuthorizedBetaFocusedCandidate(policy, candidateRoot);
  assertProducer(producer, command === "create");
  assertHistoricalAndFocusedEvidence(policy);

  if (command === "create") {
    const inventory = await collectInventory(policy, candidateRoot, true);
    const evidence: AuthorizedBetaFocusedEvidence = {
      schema: "openclaw.authorized-beta-focused-evidence.v1",
      mode: "authorized-beta-focused-v1",
      policySha256: digestAuthorizedBetaFocusedPolicy(policy),
      releaseTag: policy.releaseTag,
      candidate: {
        sha: policy.candidateSha,
        parentSha: policy.baseCandidateSha,
        treeSha: policy.candidateTreeSha,
        packageProjectionSha256: policy.packageProjectionSha256,
        changedPaths: policy.changedPaths,
      },
      producer,
      historical: {
        frvRunId: policy.historicalFrv.runId,
        frvRunAttempt: policy.historicalFrv.runAttempt,
        releaseChecksRunId: policy.historicalFrv.releaseChecksRunId,
        performanceRunId: policy.historicalFrv.performanceRunId,
      },
      focused: {
        ciRunId: policy.focusedProof.ciRunId,
        ciJobId: policy.focusedProof.ciSuccessJobId,
        pluginRunId: policy.focusedProof.pluginRunId,
        pluginJobId: policy.focusedProof.pluginSuccessJobId,
        reviewedHeadSha: policy.reviewedHeadSha,
      },
      inventory,
    };
    writeFileSync(artifactPath, `${stableJson(evidence)}\n`, { flag: "wx" });
    console.log(`authorized beta focused evidence written: ${artifactPath}`);
    return;
  }

  const evidence = JSON.parse(readFileSync(artifactPath, "utf8")) as AuthorizedBetaFocusedEvidence;
  const inventory = {
    eligibilityPlanDigest: policy.eligibilityPlanDigest,
    ...policy.inventory,
  };
  validateAuthorizedBetaFocusedArtifactShape(evidence, policy, producer, inventory);
  console.log(
    `authorized beta focused evidence verified for ${policy.releaseTag} at ${policy.candidateSha}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "unknown error");
    console.error("[authorized-beta-focused-evidence] FAILED (exit 1)");
    process.exitCode = 1;
  });
}
