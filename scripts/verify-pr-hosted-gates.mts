#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { minimatch } from "minimatch";
import { parse } from "yaml";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { execGhApiRead, plainGhEnv } from "./lib/plain-gh.mjs";

const SCHEDULED_HOSTED_WORKFLOW_PATHS = new Map([
  ["Blacksmith Testbox", ".github/workflows/ci-check-testbox.yml"],
  ["Blacksmith ARM Testbox", ".github/workflows/ci-check-arm-testbox.yml"],
  ["Blacksmith Build Artifacts Testbox", ".github/workflows/ci-build-artifacts-testbox.yml"],
  ["Workflow Sanity", ".github/workflows/workflow-sanity.yml"],
]);
export const SCHEDULED_HOSTED_WORKFLOWS = [...SCHEDULED_HOSTED_WORKFLOW_PATHS.keys()];
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const BUILD_ARTIFACTS_WORKFLOW = "Blacksmith Build Artifacts Testbox";
const ARTIFACT_FALLBACK_REQUIRED_WORKFLOWS = [
  "Blacksmith Testbox",
  "Blacksmith ARM Testbox",
  "Workflow Sanity",
];
// Full workflow-run objects are large enough for a 100-row response to exceed
// the Octopool relay cap on busy SHAs. Keep each REST page bounded and retain
// the existing 1,000-result search window through pagination.
const WORKFLOW_RUNS_PAGE_SIZE = 30;
const MAX_WORKFLOW_RUN_SEARCH_RESULTS = 1_000;
export const HOSTED_GATE_MAX_AGE_HOURS = 24;
const HOSTED_GATE_MAX_AGE_MS = HOSTED_GATE_MAX_AGE_HOURS * 60 * 60 * 1_000;
const HOSTED_GATE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_CI_REUSE_CANDIDATES = 5;
const CI_REUSE_RUN_LIST_LIMIT = 50;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PATH_GLOB_OPTIONS = { dot: true, nocomment: true, nonegate: true };

type WorkflowRun = Partial<ReturnType<typeof toWorkflowRun>>;
type CiGateJob = ReturnType<typeof toCiGateJob>;

type ExecGit = (args: string[], options?: { input?: string }) => string;
type PullRequestPathFilter = { paths?: string[]; "paths-ignore"?: string[] };
type CollectHostedGateEvidenceParams = {
  sha: string;
  mainSha: string;
  pr?: number;
  recentSha?: string;
  pullRequestCommitShas?: string[];
  pullRequestHeadBranch?: string;
  pullRequestHeadRepository?: string;
  workflowRuns: WorkflowRun[];
  ciGateJobs?: CiGateJob[];
  loadCiReuseCandidates?: () => WorkflowRun[];
  execGit?: ExecGit;
  notApplicableScheduledWorkflows?: string[];
  changelogOnly?: boolean;
  nowMs?: number;
};

type HostedGateEvidence = {
  headSha: string;
  evidenceHeadSha?: string;
  reusedFromSha?: string;
  reusedRunId?: number;
  patchIdMatched?: true;
  workflows: Array<{
    id: number | undefined;
    name: string | undefined;
    event: string | undefined;
    headSha: string | undefined;
    headBranch: string | undefined;
    status: string | undefined;
    conclusion: string | null | undefined;
    createdAt: string | undefined;
    updatedAt: string | undefined;
    url: string | undefined;
  }>;
  fallbackCoveredWorkflows?: Array<{ name: string; coveredBy: string; reason: string }>;
  notApplicableWorkflows?: string[];
};

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function optionalNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  return value === null || typeof value === "string" ? value : undefined;
}

function toWorkflowRun(run: Record<string, unknown>) {
  const headRepository = isRecord(run.head_repository)
    ? { full_name: readStringField(run.head_repository, "full_name") }
    : undefined;
  const pullRequests = Array.isArray(run.pull_requests)
    ? run.pull_requests.filter(isRecord).map((pullRequest) => ({
        number: optionalNumber(pullRequest, "number"),
      }))
    : undefined;
  return {
    id: optionalNumber(run, "id"),
    run_number: optionalNumber(run, "run_number"),
    run_attempt: optionalNumber(run, "run_attempt"),
    name: readStringField(run, "name"),
    event: readStringField(run, "event"),
    head_sha: readStringField(run, "head_sha"),
    head_branch: readStringField(run, "head_branch"),
    head_repository: headRepository,
    path: readStringField(run, "path"),
    display_title: readStringField(run, "display_title"),
    status: readStringField(run, "status"),
    conclusion: optionalNullableString(run, "conclusion"),
    created_at: readStringField(run, "created_at"),
    updated_at: readStringField(run, "updated_at"),
    html_url: readStringField(run, "html_url"),
    pull_requests: pullRequests,
  };
}

function toCiGateJob(job: Record<string, unknown>) {
  return {
    name: readStringField(job, "name"),
    run_id: optionalNumber(job, "run_id"),
    run_attempt: optionalNumber(job, "run_attempt"),
    status: readStringField(job, "status"),
    conclusion: readStringField(job, "conclusion"),
    completed_at: readStringField(job, "completed_at"),
  };
}

export function parseArgs(argv: readonly string[]) {
  const args = {
    repo: "",
    sha: "",
    mainSha: "",
    pr: 0,
    recentSha: "",
    output: "",
    changelogOnly: false,
  };
  parseFlagArgs(
    argv,
    args,
    [
      ...(
        [
          ["--repo", "repo"],
          ["--sha", "sha"],
          ["--main-sha", "mainSha"],
          ["--recent-sha", "recentSha"],
          ["--output", "output"],
        ] as const
      ).map(([flag, key]) =>
        stringFlag(flag, key, {
          allowInline: false,
          missingValueMessage: `Expected ${flag} <value>.`,
          rejectShortOptions: true,
        }),
      ),
      stringFlag("--pr", "pr", {
        allowInline: false,
        missingValueMessage: "Expected --pr <value>.",
        rejectShortOptions: true,
        transform(value: string) {
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            throw new Error("Expected --pr <positive-integer>.");
          }
          return parsed;
        },
      }),
      booleanFlag("--changelog-only", "changelogOnly"),
    ],
    {
      duplicateOptionMessage: (flag: string) => `${flag} was provided more than once.`,
      ignoreDoubleDash: false,
      onUnhandledArg(arg: string) {
        throw new Error(`Unknown option: ${arg}`);
      },
    },
  );
  if (
    !args.repo ||
    !args.sha ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(args.mainSha) ||
    !args.pr ||
    !args.output
  ) {
    throw new Error(
      "Usage: node scripts/verify-pr-hosted-gates.mjs --repo <owner/repo> --sha <sha> --main-sha <sha> --pr <number> [--recent-sha <sha>] --output <path>",
    );
  }
  return args;
}

function matchesOrderedPathPatterns(changedPath: string, patterns: string[]) {
  let included = false;
  for (const declaredPattern of patterns ?? []) {
    const excluded = declaredPattern.startsWith("!");
    const pattern = excluded ? declaredPattern.slice(1) : declaredPattern;
    if (minimatch(changedPath, pattern, PATH_GLOB_OPTIONS)) {
      included = !excluded;
    }
  }
  return included;
}

function pullRequestPathFilterApplies(pullRequest: PullRequestPathFilter, changedPaths: string[]) {
  if (changedPaths.length === 0) {
    return false;
  }
  const includedPatterns = pullRequest.paths ?? [];
  if (includedPatterns.length > 0) {
    return changedPaths.some((changedPath) =>
      matchesOrderedPathPatterns(changedPath, includedPatterns),
    );
  }
  const ignoredPatterns = pullRequest["paths-ignore"] ?? [];
  if (ignoredPatterns.length > 0) {
    return changedPaths.some((changedPath: string) =>
      ignoredPatterns.every(
        (pattern: string) => !minimatch(changedPath, pattern, PATH_GLOB_OPTIONS),
      ),
    );
  }
  return true;
}

export function notApplicableScheduledHostedWorkflows(changedPaths: string[]) {
  return [...SCHEDULED_HOSTED_WORKFLOW_PATHS]
    .filter(([expectedName, workflowPath]) => {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      if (workflow?.name !== expectedName) {
        throw new Error(`${workflowPath} must declare workflow name ${expectedName}.`);
      }
      if (!Object.hasOwn(workflow?.on ?? {}, "pull_request")) {
        throw new Error(`${workflowPath} must declare a pull_request trigger.`);
      }
      const pullRequest = workflow.on.pull_request ?? {};
      if (Object.hasOwn(pullRequest, "branches") || Object.hasOwn(pullRequest, "branches-ignore")) {
        throw new Error(`${workflowPath} pull_request branch filters are not supported.`);
      }
      return !pullRequestPathFilterApplies(pullRequest, changedPaths);
    })
    .map(([workflowName]) => workflowName);
}

function formatObservedRuns(runs: WorkflowRun[]) {
  if (runs.length === 0) {
    return "none";
  }
  return runs
    .map(
      (run) => `${run.id ?? "unknown"}:${run.status ?? "unknown"}/${run.conclusion ?? "unknown"}`,
    )
    .join(", ");
}

function isReleaseGateCiRun(run: WorkflowRun, sha: string) {
  return (
    run?.event === "workflow_dispatch" &&
    run?.head_sha === sha &&
    (run.path ?? "").split("@", 1)[0] === CI_WORKFLOW_PATH &&
    run?.display_title === `CI release gate ${sha}`
  );
}

function matchingAuthoritativeRuns(
  runs: WorkflowRun[],
  workflowName: string,
  sha: string,
  allowManual = true,
) {
  return runs.filter((run) => {
    if (run?.head_sha !== sha) {
      return false;
    }
    if (run?.event === "pull_request") {
      return run?.name === workflowName;
    }
    return allowManual && workflowName === "CI" && isReleaseGateCiRun(run, sha);
  });
}

function latestRun(runs: WorkflowRun[]) {
  // GitHub run_number is creation order; updated_at moves as jobs finish.
  return runs.toSorted(
    (left, right) => (right.run_number ?? right.id ?? 0) - (left.run_number ?? left.id ?? 0),
  )[0];
}

function runUpdatedAtMs(run: Pick<WorkflowRun, "updated_at"> | undefined) {
  const value = Date.parse(run?.updated_at ?? "");
  return Number.isFinite(value) ? value : null;
}

function isRecentRun(run: WorkflowRun | undefined, nowMs: number) {
  const updatedAtMs = runUpdatedAtMs(run);
  return (
    updatedAtMs !== null &&
    updatedAtMs >= nowMs - HOSTED_GATE_MAX_AGE_MS &&
    updatedAtMs <= nowMs + HOSTED_GATE_CLOCK_SKEW_MS
  );
}

function isSuccessfulRecentRun(run: WorkflowRun | undefined, nowMs: number) {
  return run?.status === "completed" && run.conclusion === "success" && isRecentRun(run, nowMs);
}

function runGit(args: string[], { input }: { input?: string } = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    input,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

function parseSingleObjectId(raw: unknown, label: string) {
  const values = String(raw).trim().split(/\s+/u).filter(Boolean);
  const value = values[0];
  if (values.length !== 1 || !value || !/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error(`Expected one ${label} object id.`);
  }
  return value;
}

function computePatchId(sha: string, mainRef: string, execGit: ExecGit) {
  const mergeBase = parseSingleObjectId(
    execGit(["merge-base", mainRef, sha]),
    `merge base for ${sha}`,
  );
  const diff = execGit(["diff", mergeBase, sha]);
  const patchIdLines = execGit(["patch-id", "--stable"], { input: diff })
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  if (patchIdLines.length !== 1) {
    throw new Error(`Expected one patch id for ${sha}.`);
  }
  const patchIdLine = patchIdLines[0];
  if (!patchIdLine) {
    throw new Error(`Invalid patch-id output for ${sha}.`);
  }
  const [patchId, commitId, ...rest] = patchIdLine.trim().split(/\s+/u);
  if (
    rest.length > 0 ||
    !/^[0-9a-f]{40,64}$/u.test(patchId ?? "") ||
    !/^[0-9a-f]{40,64}$/u.test(commitId ?? "")
  ) {
    throw new Error(`Invalid patch-id output for ${sha}.`);
  }
  return patchId;
}

function ensureCommitAvailable(sha: string, execGit: ExecGit) {
  try {
    execGit(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    try {
      execGit(["fetch", "origin", sha]);
      execGit(["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
}

function isQualifyingCiReuseRun(run: WorkflowRun) {
  if (run?.event === "pull_request") {
    return run?.name === "CI";
  }
  return typeof run.head_sha === "string" && isReleaseGateCiRun(run, run.head_sha);
}

function findPatchIdenticalCiReuse({
  sha,
  candidateRuns,
  nowMs,
  mainSha,
  execGit = runGit,
}: {
  sha: string;
  candidateRuns: WorkflowRun[];
  nowMs: number;
  mainSha: string;
  execGit?: ExecGit;
}) {
  if (!Array.isArray(candidateRuns)) {
    return undefined;
  }
  const candidates = candidateRuns
    .filter(
      (run) =>
        run?.head_sha !== sha &&
        /^[0-9a-f]{40,64}$/u.test(run.head_sha ?? "") &&
        isQualifyingCiReuseRun(run) &&
        isSuccessfulRecentRun(run, nowMs),
    )
    .toSorted((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""))
    .slice(0, MAX_CI_REUSE_CANDIDATES);
  if (candidates.length === 0) {
    return undefined;
  }

  let currentPatchId;
  try {
    currentPatchId = computePatchId(sha, mainSha, execGit);
  } catch {
    return undefined;
  }
  for (const run of candidates) {
    if (!run.head_sha || !ensureCommitAvailable(run.head_sha, execGit)) {
      continue;
    }
    try {
      if (computePatchId(run.head_sha, mainSha, execGit) === currentPatchId) {
        return {
          run,
          reusedFromSha: run.head_sha,
          reusedRunId: run.id,
          patchIdMatched: true,
        };
      }
    } catch {
      // A candidate is reusable only when every local git proof step succeeds.
    }
  }
  return undefined;
}

type PatchIdenticalReuse = NonNullable<ReturnType<typeof findPatchIdenticalCiReuse>>;

const CI_GATE_CHECK_NAME = "openclaw/ci-gate";

/**
 * True when this run's own openclaw/ci-gate job already succeeded on the
 * run's CURRENT attempt. The gate job needs every selected lane and fails on
 * any non-success result, so a successful gate proves the merge-relevant
 * outcome minutes before post-gate stragglers (timing summaries, artifact
 * uploads) let the run itself reach completed. Check suites survive reruns,
 * so binding goes through the attempt-scoped jobs listing: the job must carry
 * the run's own run_attempt — a prior attempt's gate success can never vouch
 * for a rerun that has not reached its gate yet.
 */
function hasSuccessfulCiGateJob(run: WorkflowRun, ciGateJobs: CiGateJob[], nowMs: number) {
  if (!run?.id || !Array.isArray(ciGateJobs)) {
    return false;
  }
  const runAttempt = run.run_attempt ?? 1;
  return ciGateJobs.some((job) => {
    if (job?.name !== CI_GATE_CHECK_NAME) {
      return false;
    }
    // Workflow attempts share a run id and filter=latest keeps a not-yet-rerun
    // job's prior-attempt execution, so bind to the attempt explicitly: the
    // REST job payload exposes run_attempt, and jobs are fetched from the
    // attempt-specific endpoint. Both must agree with the run's attempt.
    if (job?.run_id !== run.id || (job?.run_attempt ?? runAttempt) !== runAttempt) {
      return false;
    }
    if (job?.status !== "completed" || job?.conclusion !== "success") {
      return false;
    }
    const completedAtMs = Date.parse(job?.completed_at ?? "");
    return (
      Number.isFinite(completedAtMs) &&
      completedAtMs >= nowMs - HOSTED_GATE_MAX_AGE_MS &&
      completedAtMs <= nowMs + HOSTED_GATE_CLOCK_SKEW_MS
    );
  });
}

function isGateProvenInProgressRun(
  run: WorkflowRun | undefined,
  ciGateJobs: CiGateJob[],
  nowMs: number,
) {
  return (
    (run?.status === "in_progress" || run?.status === "queued") &&
    isRecentRun(run, nowMs) &&
    hasSuccessfulCiGateJob(run, ciGateJobs, nowMs)
  );
}

function preferredCiRun(runs: WorkflowRun[], nowMs: number) {
  const scheduledRuns = runs.filter((run) => run.event === "pull_request");
  const latestScheduledRun = latestRun(scheduledRuns);
  const latestDecision = latestRun(
    scheduledRuns.filter(
      (run) =>
        run.status === "completed" &&
        typeof run.conclusion === "string" &&
        !["cancelled", "skipped"].includes(run.conclusion),
    ),
  );
  const latestManualRun = latestRun(runs.filter((run) => run.event === "workflow_dispatch"));

  // Manual proof may replace stale scheduled success or a pending run,
  // never an unresolved terminal non-success.
  if (latestDecision && latestDecision.conclusion !== "success") {
    return latestDecision;
  }
  if (latestScheduledRun && latestScheduledRun.status !== "completed") {
    return latestRun(
      [latestScheduledRun, latestManualRun].filter((run): run is WorkflowRun => run !== undefined),
    );
  }
  if (latestScheduledRun?.status === "completed" && isSuccessfulRecentRun(latestDecision, nowMs)) {
    return latestDecision;
  }
  return latestManualRun ?? latestScheduledRun;
}

function successfulRunOrThrow(
  runs: WorkflowRun[],
  workflowName: string,
  sha: string,
  {
    allowManual = true,
    nowMs = Date.now(),
    ciGateJobs = [],
  }: { allowManual?: boolean; nowMs?: number; ciGateJobs?: CiGateJob[] } = {},
) {
  const matchingRuns = matchingAuthoritativeRuns(runs, workflowName, sha, allowManual);
  const run = workflowName === "CI" ? preferredCiRun(matchingRuns, nowMs) : latestRun(matchingRuns);
  if (run && isSuccessfulRecentRun(run, nowMs)) {
    return run;
  }
  if (workflowName === "CI") {
    if (run && isGateProvenInProgressRun(run, ciGateJobs, nowMs)) {
      return run;
    }
    // A terminal non-success stays blocking unless a NEWER pending SCHEDULED
    // rerun on the same head has already passed its own gate — the gate needs
    // every selected lane, so that attempt is authoritative proof the failure
    // is re-resolved. The newer-than bound stops a stalled older run's gate
    // from masking a later failure, and manual runs can never mask one.
    if (run?.status === "completed" && run.conclusion !== "success") {
      const failedRunCreatedAtMs = Date.parse(run?.created_at ?? "");
      const gateProvenRerun = matchingRuns.find((candidate) => {
        if (candidate === run || candidate.event !== "pull_request") {
          return false;
        }
        const candidateCreatedAtMs = Date.parse(candidate?.created_at ?? "");
        if (
          !Number.isFinite(candidateCreatedAtMs) ||
          !Number.isFinite(failedRunCreatedAtMs) ||
          candidateCreatedAtMs <= failedRunCreatedAtMs
        ) {
          return false;
        }
        return isGateProvenInProgressRun(candidate, ciGateJobs, nowMs);
      });
      if (gateProvenRerun) {
        return gateProvenRerun;
      }
    }
  }
  throw new Error(
    `Missing successful recent ${workflowName} workflow for ${sha}. Observed: ${formatObservedRuns(matchingRuns)}`,
  );
}

function hasSuccessfulRecentReleaseGate(workflowRuns: WorkflowRun[], sha: string, nowMs: number) {
  const releaseGate = latestRun(workflowRuns.filter((run) => isReleaseGateCiRun(run, sha)));
  return isSuccessfulRecentRun(releaseGate, nowMs);
}

function runBelongsToPullRequest(
  run: WorkflowRun,
  pr: number,
  pullRequestCommitShas: Set<string>,
  pullRequestHeadBranch: string,
  pullRequestHeadRepository: string,
) {
  if (run.pull_requests?.some((pullRequest) => pullRequest.number === pr)) {
    return true;
  }
  if (Array.isArray(run?.pull_requests) && run.pull_requests.length > 0) {
    return false;
  }
  // Fork pull_request runs currently arrive with pull_requests: []. Require
  // the immutable commit plus its PR head identity; branch identity alone is
  // mutable, while ancestry alone can include commits from merged branches.
  return (
    typeof run.head_sha === "string" &&
    pullRequestCommitShas.has(run.head_sha) &&
    run?.head_branch === pullRequestHeadBranch &&
    run?.head_repository?.full_name?.toLowerCase() === pullRequestHeadRepository.toLowerCase()
  );
}

function canCoverQueuedBuildArtifacts(
  workflowRuns: WorkflowRun[],
  sha: string,
  nowMs: number,
  notApplicableScheduledWorkflowNames: Set<string> | undefined,
) {
  if (!hasSuccessfulRecentReleaseGate(workflowRuns, sha, nowMs)) {
    return false;
  }
  const supportingGatesPassed = ARTIFACT_FALLBACK_REQUIRED_WORKFLOWS.every((workflowName) => {
    const matchingRuns = matchingAuthoritativeRuns(workflowRuns, workflowName, sha, false);
    if (matchingRuns.length === 0 && notApplicableScheduledWorkflowNames?.has(workflowName)) {
      return true;
    }
    const run = latestRun(matchingRuns);
    return isSuccessfulRecentRun(run, nowMs);
  });
  if (!supportingGatesPassed) {
    return false;
  }
  const buildArtifactRuns = matchingAuthoritativeRuns(
    workflowRuns,
    BUILD_ARTIFACTS_WORKFLOW,
    sha,
    false,
  );
  const latestBuildArtifactRun = latestRun(buildArtifactRuns);
  return (
    latestBuildArtifactRun?.status === "queued" &&
    isRecentRun(latestBuildArtifactRun, nowMs) &&
    buildArtifactRuns.every(
      (run) =>
        run.status === "queued" || (run.status === "completed" && run.conclusion === "success"),
    )
  );
}

function stripAnsi(raw: string) {
  const escape = String.fromCharCode(27);
  return raw.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "");
}

export function parseWorkflowRunPage(raw: string) {
  const page = JSON.parse(stripAnsi(raw)) as unknown;
  if (!isRecord(page)) {
    throw new Error("Expected workflow run page to be an object.");
  }
  const totalCount = typeof page.total_count === "number" ? page.total_count : 0;
  const workflowRuns = Array.isArray(page.workflow_runs)
    ? page.workflow_runs.filter(isRecord).map(toWorkflowRun)
    : [];
  return {
    totalCount,
    workflowRuns,
  };
}

export function workflowRunPageCount(totalCount: number) {
  return Math.min(
    Math.ceil(totalCount / WORKFLOW_RUNS_PAGE_SIZE),
    Math.ceil(MAX_WORKFLOW_RUN_SEARCH_RESULTS / WORKFLOW_RUNS_PAGE_SIZE),
  );
}

export function collectHostedGateEvidence({
  sha,
  mainSha,
  pr = 0,
  recentSha = "",
  pullRequestCommitShas = [],
  pullRequestHeadBranch = "",
  pullRequestHeadRepository = "",
  workflowRuns,
  ciGateJobs = [],
  loadCiReuseCandidates = () => [],
  execGit = runGit,
  notApplicableScheduledWorkflows,
  changelogOnly = false,
  nowMs = Date.now(),
}: CollectHostedGateEvidenceParams): HostedGateEvidence {
  if (!Array.isArray(workflowRuns)) {
    throw new Error("workflowRuns must be an array.");
  }
  const notApplicableScheduledWorkflowNames =
    notApplicableScheduledWorkflows === undefined
      ? undefined
      : new Set(notApplicableScheduledWorkflows);
  const pullRequestCommitShaSet = new Set<string>(pullRequestCommitShas);

  const collectForSha = (
    evidenceSha: string,
    {
      allowManual,
      requiredScheduledWorkflows = new Set<string>(),
      ciRun,
    }: {
      allowManual: boolean;
      ciRun?: WorkflowRun;
      requiredScheduledWorkflows?: Set<string>;
    },
  ) => {
    const workflows: WorkflowRun[] = [];
    const fallbackCoveredWorkflows: Array<{ name: string; coveredBy: string; reason: string }> = [];
    if (!changelogOnly) {
      workflows.push(
        ciRun ??
          successfulRunOrThrow(workflowRuns, "CI", evidenceSha, {
            allowManual,
            nowMs,
            // Gate proof only vouches for the exact head under verification.
            ciGateJobs: evidenceSha === sha ? ciGateJobs : [],
          }),
      );
    }
    for (const workflowName of SCHEDULED_HOSTED_WORKFLOWS) {
      const matchingRuns = matchingAuthoritativeRuns(
        workflowRuns,
        workflowName,
        evidenceSha,
        allowManual,
      );
      if (
        matchingRuns.length === 0 &&
        !requiredScheduledWorkflows.has(workflowName) &&
        (notApplicableScheduledWorkflowNames === undefined ||
          notApplicableScheduledWorkflowNames.has(workflowName))
      ) {
        continue;
      }
      if (
        allowManual &&
        workflowName === BUILD_ARTIFACTS_WORKFLOW &&
        canCoverQueuedBuildArtifacts(
          workflowRuns,
          evidenceSha,
          nowMs,
          notApplicableScheduledWorkflowNames,
        )
      ) {
        fallbackCoveredWorkflows.push({
          name: workflowName,
          coveredBy: "CI release gate",
          reason: "scheduled workflow is queued",
        });
        continue;
      }
      workflows.push(
        successfulRunOrThrow(workflowRuns, workflowName, evidenceSha, {
          allowManual,
          nowMs,
        }),
      );
    }
    return { workflows, fallbackCoveredWorkflows };
  };

  let ciRun: WorkflowRun | undefined;
  let ciReuse: PatchIdenticalReuse | undefined;
  if (!changelogOnly) {
    try {
      ciRun = successfulRunOrThrow(workflowRuns, "CI", sha, {
        allowManual: true,
        nowMs,
        ciGateJobs,
      });
    } catch (exactCiError) {
      let candidateRuns: WorkflowRun[];
      try {
        candidateRuns = loadCiReuseCandidates();
      } catch {
        candidateRuns = [];
      }
      ciReuse = findPatchIdenticalCiReuse({
        sha,
        mainSha,
        candidateRuns,
        nowMs,
        execGit,
      });
      if (!ciReuse) {
        throw exactCiError;
      }
      ciRun = ciReuse.run;
    }
  }

  let evidenceSha = sha;
  let selected:
    | {
        workflows: WorkflowRun[];
        fallbackCoveredWorkflows: Array<{ name: string; coveredBy: string; reason: string }>;
      }
    | undefined;
  try {
    selected = collectForSha(sha, { allowManual: true, ciRun });
  } catch (exactError) {
    // Scheduled hosted workflows retain their existing recent-cohort fallback.
    // CI itself is either exact-head proof or the patch-identical run selected
    // above; never silently replace it with an unverified prior-head run.
    const targetScheduledWorkflows = new Set(
      SCHEDULED_HOSTED_WORKFLOWS.filter(
        (workflowName) =>
          (notApplicableScheduledWorkflowNames !== undefined &&
            !notApplicableScheduledWorkflowNames.has(workflowName)) ||
          matchingAuthoritativeRuns(workflowRuns, workflowName, sha, false).length > 0,
      ),
    );
    const fallbackShas = [
      ciReuse?.reusedFromSha,
      recentSha,
      ...workflowRuns
        .filter(
          (run) =>
            run?.event === "pull_request" &&
            run?.head_sha !== sha &&
            runBelongsToPullRequest(
              run,
              pr,
              pullRequestCommitShaSet,
              pullRequestHeadBranch,
              pullRequestHeadRepository,
            ) &&
            isRecentRun(run, nowMs),
        )
        .toSorted((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""))
        .map((run) => run.head_sha),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    let fallbackError;
    for (const fallbackSha of new Set(fallbackShas)) {
      try {
        selected = collectForSha(fallbackSha, {
          allowManual: false,
          requiredScheduledWorkflows: targetScheduledWorkflows,
          ciRun,
        });
        evidenceSha = fallbackSha;
        break;
      } catch (error) {
        fallbackError ??= error;
      }
    }
    if (!selected) {
      throw fallbackError ?? exactError;
    }
  }

  const evidence: HostedGateEvidence = {
    headSha: sha,
    ...(evidenceSha !== sha ? { evidenceHeadSha: evidenceSha } : {}),
    ...(ciReuse
      ? {
          reusedFromSha: ciReuse.reusedFromSha,
          reusedRunId: ciReuse.reusedRunId,
          patchIdMatched: true satisfies true,
        }
      : {}),
    ...(selected.fallbackCoveredWorkflows.length > 0
      ? { fallbackCoveredWorkflows: selected.fallbackCoveredWorkflows }
      : {}),
    workflows: selected.workflows.map((run) => ({
      id: run.id,
      name: run.name,
      event: run.event,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      url: run.html_url,
    })),
  };
  const notApplicableWorkflows = (notApplicableScheduledWorkflows ?? []).filter(
    (workflowName) =>
      matchingAuthoritativeRuns(workflowRuns, workflowName, sha, false).length === 0,
  );
  return notApplicableWorkflows.length > 0 ? { ...evidence, notApplicableWorkflows } : evidence;
}

export function workflowRunQueryPaths(
  repo: string,
  { sha, recentSha, headBranch }: { sha: string; recentSha: string; headBranch?: string },
  page = 1,
) {
  const pageSuffix = `per_page=${WORKFLOW_RUNS_PAGE_SIZE}&page=${page}`;
  const shas = [...new Set([sha, recentSha].filter(Boolean))];
  const queries = shas.map(
    (headSha) => `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&${pageSuffix}`,
  );
  if (headBranch) {
    queries.push(
      `repos/${repo}/actions/runs?branch=${encodeURIComponent(headBranch)}&event=pull_request&${pageSuffix}`,
    );
  }
  return queries;
}

function loadWorkflowRunsForQuery(queryForPage: (page: number) => string) {
  const loadPage = (page: number) =>
    parseWorkflowRunPage(
      execGhApiRead(queryForPage(page), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

  // Bound every SHA query to GitHub's documented search window.
  const firstPage = loadPage(1);
  const workflowRuns = [...firstPage.workflowRuns];
  for (let page = 2; page <= workflowRunPageCount(firstPage.totalCount); page += 1) {
    workflowRuns.push(...loadPage(page).workflowRuns);
  }
  return workflowRuns;
}

function loadWorkflowRuns(repo: string, sha: string, recentSha: string, headBranch?: string) {
  const queries = workflowRunQueryPaths(repo, { sha, recentSha, headBranch });
  const withPage = (query: string, page: number) => query.replace(/page=1$/u, `page=${page}`);
  const workflowRuns = queries.flatMap((query) =>
    loadWorkflowRunsForQuery((page) => withPage(query, page)),
  );
  return [...new Map(workflowRuns.map((run) => [run.id, run])).values()];
}

function loadCiReuseCandidateRuns(repo: string, headBranch: string) {
  const raw = execFileSync(
    "gh",
    [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "ci.yml",
      "--branch",
      headBranch,
      "--limit",
      String(CI_REUSE_RUN_LIST_LIMIT),
      "--json",
      "databaseId,workflowName,headSha,headBranch,event,status,conclusion,createdAt,updatedAt,url,displayTitle",
    ],
    {
      encoding: "utf8",
      env: plainGhEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const runs = JSON.parse(stripAnsi(raw)) as unknown;
  if (!Array.isArray(runs)) {
    throw new Error("Expected gh run list to return an array.");
  }
  if (!runs.every(isRecord)) {
    throw new Error("Expected every gh run list entry to be an object.");
  }
  // The workflow selector above supplies the path identity that the REST
  // release-gate matcher normally reads from each full workflow-run object.
  return runs.map(
    (run): WorkflowRun => ({
      id: optionalNumber(run, "databaseId"),
      name: readStringField(run, "workflowName"),
      event: readStringField(run, "event"),
      status: readStringField(run, "status"),
      conclusion: optionalNullableString(run, "conclusion"),
      head_sha: readStringField(run, "headSha"),
      head_branch: readStringField(run, "headBranch"),
      path: CI_WORKFLOW_PATH,
      created_at: readStringField(run, "createdAt"),
      updated_at: readStringField(run, "updatedAt"),
      html_url: readStringField(run, "url"),
      display_title: readStringField(run, "displayTitle"),
    }),
  );
}

export function loadPullRequestCommitShas(
  { baseSha, headSha }: { baseSha: string; headSha: string },
  execGit: ExecGit = runGit,
) {
  const output = execGit(["rev-list", "--reverse", `${baseSha}..${headSha}`]);
  const shas = output.replace(/\r?\n$/u, "").split(/\r?\n/u);
  if (shas.length === 0 || shas.some((sha) => !/^[0-9a-f]{40,64}$/u.test(sha))) {
    throw new Error("Expected pull request commit object ids from git rev-list.");
  }
  if (!shas.includes(headSha)) {
    throw new Error(`Expected pull request commit list to contain head ${headSha}.`);
  }
  return shas;
}

function loadPullRequestChangedPaths(baseSha: string, headSha: string) {
  return runGit(["diff", "--name-only", `${baseSha}...${headSha}`])
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
}

function loadCiGateJobs(
  repo: string,
  workflowRuns: WorkflowRun[],
  sha: string,
  nowMs = Date.now(),
) {
  // Only an in-progress exact-head CI run can benefit from gate proof.
  const candidates = workflowRuns.filter(
    (run) =>
      run?.name === "CI" &&
      run?.head_sha === sha &&
      (run?.status === "in_progress" || run?.status === "queued") &&
      isRecentRun(run, nowMs),
  );
  return candidates.flatMap((run) => {
    const attempt = run.run_attempt ?? 1;
    // The jobs endpoint pages at 100 and full-scope runs already sit near
    // that; page until the gate job is visible so growth past one page can
    // never silently disable the early-proof path.
    const jobs: CiGateJob[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const payload = JSON.parse(
        execGhApiRead(
          `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      ) as unknown;
      const pageJobs =
        isRecord(payload) && Array.isArray(payload.jobs)
          ? payload.jobs.filter(isRecord).map(toCiGateJob)
          : [];
      jobs.push(...pageJobs);
      const totalCount = Number(isRecord(payload) ? (payload.total_count ?? 0) : 0);
      if (
        pageJobs.length === 0 ||
        jobs.length >= totalCount ||
        jobs.some((job) => job.name === CI_GATE_CHECK_NAME)
      ) {
        break;
      }
    }
    // Re-read the run after fetching its attempt jobs and drop the evidence if
    // the attempt advanced in between: otherwise a rerun starting in that
    // window would let the just-fetched prior-attempt gate vouch for an
    // attempt that has not reached its own gate. Same-attempt completion is
    // fine — a run that finished successfully still proves this attempt, and
    // a non-success completion must not be blessed by its own earlier gate.
    const current = JSON.parse(
      execGhApiRead(`repos/${repo}/actions/runs/${run.id}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as unknown;
    if (!isRecord(current)) {
      return [];
    }
    const sameAttempt = (current.run_attempt ?? attempt) === attempt;
    const stillPending = current.status === "in_progress" || current.status === "queued";
    const completedSuccess = current.status === "completed" && current.conclusion === "success";
    if (!sameAttempt || (!stillPending && !completedSuccess)) {
      return [];
    }
    return jobs;
  });
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pullRequest = JSON.parse(
    execGhApiRead(`repos/${args.repo}/pulls/${args.pr}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as unknown;
  const head = isRecord(pullRequest) && isRecord(pullRequest.head) ? pullRequest.head : undefined;
  const headRepo = head && isRecord(head.repo) ? head.repo : undefined;
  const headBranch = head ? readStringField(head, "ref") : undefined;
  const headRepository = headRepo ? readStringField(headRepo, "full_name") : undefined;
  const headSha = head ? readStringField(head, "sha") : undefined;
  if (!headBranch || !headRepository || !headSha) {
    throw new Error(`PR #${args.pr} is missing head metadata.`);
  }
  if (headSha !== args.sha) {
    throw new Error(`PR #${args.pr} head changed from ${args.sha} to ${headSha}.`);
  }
  // Paths, membership and patch IDs share one snapshot; a newer API base may not exist locally.
  const changedPaths = loadPullRequestChangedPaths(args.mainSha, headSha);
  const workflowRuns = loadWorkflowRuns(args.repo, args.sha, args.recentSha, headBranch);
  const evidence = collectHostedGateEvidence({
    sha: args.sha,
    mainSha: args.mainSha,
    pr: args.pr,
    recentSha: args.recentSha,
    pullRequestCommitShas: loadPullRequestCommitShas({ baseSha: args.mainSha, headSha }),
    pullRequestHeadBranch: headBranch,
    pullRequestHeadRepository: headRepository,
    workflowRuns,
    ciGateJobs: loadCiGateJobs(args.repo, workflowRuns, args.sha),
    loadCiReuseCandidates: () => loadCiReuseCandidateRuns(args.repo, headBranch),
    notApplicableScheduledWorkflows: notApplicableScheduledHostedWorkflows(changedPaths),
    changelogOnly: args.changelogOnly,
  });
  const evidenceHeadSha = evidence.evidenceHeadSha ?? args.sha;
  const notApplicableWorkflows =
    "notApplicableWorkflows" in evidence ? evidence.notApplicableWorkflows : undefined;
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    repo: args.repo,
    pullRequestNumber: args.pr,
    selection: {
      mode: evidence.patchIdMatched
        ? "patch-identical-pre-rebase"
        : evidenceHeadSha === args.sha
          ? "exact-head"
          : "recent-pr-head",
      maxAgeHours: HOSTED_GATE_MAX_AGE_HOURS,
    },
    ...evidence,
  };
  mkdirSync(path.dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`);
  if (evidence.patchIdMatched) {
    const reusedRun = manifest.workflows.find((workflow) => workflow.id === evidence.reusedRunId);
    const updatedAtMs = runUpdatedAtMs({ updated_at: reusedRun?.updatedAt });
    const ageHours =
      updatedAtMs === null
        ? "unknown"
        : `${(Math.max(0, Date.now() - updatedAtMs) / (60 * 60 * 1_000)).toFixed(1)}h`;
    console.log(
      `hosted CI reused from patch-identical pre-rebase head ${evidence.reusedFromSha} (run ${evidence.reusedRunId}, age ${ageHours})`,
    );
  }
  console.log(
    `Hosted gates passed for PR #${args.pr} at ${args.sha} using ${evidenceHeadSha}: ${manifest.workflows
      .map((workflow) => `${workflow.name}#${workflow.id}`)
      .join(", ")}${
      notApplicableWorkflows?.length ? `; not applicable: ${notApplicableWorkflows.join(", ")}` : ""
    }`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
