#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { execGhApiRead } from "./lib/plain-gh.mjs";

export const SCHEDULED_HOSTED_WORKFLOWS = [
  "Blacksmith Testbox",
  "Blacksmith ARM Testbox",
  "Blacksmith Build Artifacts Testbox",
  "Workflow Sanity",
];
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const BUILD_ARTIFACTS_WORKFLOW = "Blacksmith Build Artifacts Testbox";
const ARTIFACT_FALLBACK_REQUIRED_WORKFLOWS = [
  "Blacksmith Testbox",
  "Blacksmith ARM Testbox",
  "Workflow Sanity",
];
const WORKFLOW_RUNS_PAGE_SIZE = 100;
const MAX_WORKFLOW_RUN_SEARCH_RESULTS = 1_000;
const COMPARE_COMMITS_PAGE_SIZE = 100;
export const HOSTED_GATE_MAX_AGE_HOURS = 24;
const HOSTED_GATE_MAX_AGE_MS = HOSTED_GATE_MAX_AGE_HOURS * 60 * 60 * 1_000;
const HOSTED_GATE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected ${optionName} <value>.`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    repo: "",
    sha: "",
    pr: 0,
    recentSha: "",
    output: "",
    changelogOnly: false,
  };
  const seen = new Set();
  const setOnce = (flag, key, value) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once.`);
    }
    seen.add(flag);
    args[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        setOnce(arg, "repo", readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--sha":
        setOnce(arg, "sha", readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--pr": {
        const value = Number(readOptionValue(argv, index, arg));
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error("Expected --pr <positive-integer>.");
        }
        setOnce(arg, "pr", value);
        index += 1;
        break;
      }
      case "--recent-sha":
        setOnce(arg, "recentSha", readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--output":
        setOnce(arg, "output", readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--changelog-only":
        setOnce(arg, "changelogOnly", true);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.repo || !args.sha || !args.pr || !args.output) {
    throw new Error(
      "Usage: node scripts/verify-pr-hosted-gates.mjs --repo <owner/repo> --sha <sha> --pr <number> [--recent-sha <sha>] --output <path>",
    );
  }
  return args;
}

function formatObservedRuns(runs) {
  if (runs.length === 0) {
    return "none";
  }
  return runs
    .map(
      (run) => `${run.id ?? "unknown"}:${run.status ?? "unknown"}/${run.conclusion ?? "unknown"}`,
    )
    .join(", ");
}

function isReleaseGateCiRun(run, sha) {
  return (
    run?.event === "workflow_dispatch" &&
    run?.head_sha === sha &&
    String(run?.path ?? "").split("@", 1)[0] === CI_WORKFLOW_PATH &&
    run?.display_title === `CI release gate ${sha}`
  );
}

function matchingAuthoritativeRuns(runs, workflowName, sha, allowManual = true) {
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

function latestRun(runs) {
  return runs.toSorted((left, right) =>
    String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")),
  )[0];
}

function runUpdatedAtMs(run) {
  const value = Date.parse(String(run?.updated_at ?? ""));
  return Number.isFinite(value) ? value : null;
}

function isRecentRun(run, nowMs) {
  const updatedAtMs = runUpdatedAtMs(run);
  return (
    updatedAtMs !== null &&
    updatedAtMs >= nowMs - HOSTED_GATE_MAX_AGE_MS &&
    updatedAtMs <= nowMs + HOSTED_GATE_CLOCK_SKEW_MS
  );
}

function isSuccessfulRecentRun(run, nowMs) {
  return run?.status === "completed" && run.conclusion === "success" && isRecentRun(run, nowMs);
}

function preferredCiRun(runs, nowMs) {
  const scheduledRuns = runs.filter((run) => run.event === "pull_request");
  const latestScheduledRun = latestRun(scheduledRuns);
  const latestCompletedScheduledRun = latestRun(
    scheduledRuns.filter((run) => run.status === "completed"),
  );
  const latestManualRun = latestRun(runs.filter((run) => run.event === "workflow_dispatch"));

  // Manual proof may replace stale scheduled success or a pending run,
  // never an unresolved terminal non-success.
  if (latestCompletedScheduledRun && latestCompletedScheduledRun.conclusion !== "success") {
    return latestCompletedScheduledRun;
  }
  if (latestScheduledRun?.status === "completed" && isRecentRun(latestScheduledRun, nowMs)) {
    return latestScheduledRun;
  }
  return latestManualRun ?? latestScheduledRun;
}

function successfulRunOrThrow(
  runs,
  workflowName,
  sha,
  { allowManual = true, nowMs = Date.now() } = {},
) {
  const matchingRuns = matchingAuthoritativeRuns(runs, workflowName, sha, allowManual);
  const run = workflowName === "CI" ? preferredCiRun(matchingRuns, nowMs) : latestRun(matchingRuns);
  if (!isSuccessfulRecentRun(run, nowMs)) {
    throw new Error(
      `Missing successful recent ${workflowName} workflow for ${sha}. Observed: ${formatObservedRuns(matchingRuns)}`,
    );
  }
  return run;
}

function hasSuccessfulRecentReleaseGate(workflowRuns, sha, nowMs) {
  const releaseGate = latestRun(workflowRuns.filter((run) => isReleaseGateCiRun(run, sha)));
  return isSuccessfulRecentRun(releaseGate, nowMs);
}

function runBelongsToPullRequest(
  run,
  pr,
  pullRequestCommitShas,
  pullRequestHeadBranch,
  pullRequestHeadRepository,
) {
  if (run?.pull_requests?.some((pullRequest) => pullRequest?.number === pr)) {
    return true;
  }
  if (Array.isArray(run?.pull_requests) && run.pull_requests.length > 0) {
    return false;
  }
  // Fork pull_request runs currently arrive with pull_requests: []. Require
  // the immutable commit plus its PR head identity; branch identity alone is
  // mutable, while ancestry alone can include commits from merged branches.
  return (
    pullRequestCommitShas.has(run?.head_sha) &&
    run?.head_branch === pullRequestHeadBranch &&
    run?.head_repository?.full_name?.toLowerCase() === pullRequestHeadRepository.toLowerCase()
  );
}

function canCoverQueuedBuildArtifacts(workflowRuns, sha, nowMs) {
  if (!hasSuccessfulRecentReleaseGate(workflowRuns, sha, nowMs)) {
    return false;
  }
  const supportingGatesPassed = ARTIFACT_FALLBACK_REQUIRED_WORKFLOWS.every((workflowName) => {
    const run = latestRun(matchingAuthoritativeRuns(workflowRuns, workflowName, sha, false));
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

function stripAnsi(raw) {
  const escape = String.fromCharCode(27);
  return raw.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "");
}

export function parseWorkflowRunPage(raw) {
  const page = JSON.parse(stripAnsi(raw));
  return {
    totalCount: page.total_count ?? 0,
    workflowRuns: page.workflow_runs ?? [],
  };
}

export function workflowRunPageCount(totalCount) {
  return Math.min(
    Math.ceil(totalCount / WORKFLOW_RUNS_PAGE_SIZE),
    MAX_WORKFLOW_RUN_SEARCH_RESULTS / WORKFLOW_RUNS_PAGE_SIZE,
  );
}

export function collectHostedGateEvidence({
  sha,
  pr,
  recentSha,
  pullRequestCommitShas = [],
  pullRequestHeadBranch = "",
  pullRequestHeadRepository = "",
  workflowRuns,
  changelogOnly = false,
  nowMs = Date.now(),
}) {
  if (!Array.isArray(workflowRuns)) {
    throw new Error("workflowRuns must be an array.");
  }
  const pullRequestCommitShaSet = new Set(pullRequestCommitShas);

  const collectForSha = (evidenceSha, { allowManual, requiredScheduledWorkflows = new Set() }) => {
    const workflows = [];
    const fallbackCoveredWorkflows = [];
    if (!changelogOnly) {
      workflows.push(
        successfulRunOrThrow(workflowRuns, "CI", evidenceSha, {
          allowManual,
          nowMs,
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
      if (matchingRuns.length === 0 && !requiredScheduledWorkflows.has(workflowName)) {
        continue;
      }
      if (
        allowManual &&
        workflowName === BUILD_ARTIFACTS_WORKFLOW &&
        canCoverQueuedBuildArtifacts(workflowRuns, evidenceSha, nowMs)
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

  let evidenceSha = sha;
  let selected;
  try {
    selected = collectForSha(sha, { allowManual: true });
  } catch (exactError) {
    // Hosted CI proves the PR cohort, not ancestry freshness. A newer head's
    // failure must not discard a complete same-PR green cohort from the last
    // 24 hours; review and focused gates own the newer delta.
    const targetScheduledWorkflows = new Set(
      SCHEDULED_HOSTED_WORKFLOWS.filter(
        (workflowName) =>
          matchingAuthoritativeRuns(workflowRuns, workflowName, sha, false).length > 0,
      ),
    );
    const fallbackShas = [
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
        .toSorted((left, right) =>
          String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")),
        )
        .map((run) => run.head_sha),
    ].filter(Boolean);
    let fallbackError;
    for (const fallbackSha of new Set(fallbackShas)) {
      try {
        selected = collectForSha(fallbackSha, {
          allowManual: false,
          requiredScheduledWorkflows: targetScheduledWorkflows,
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

  const evidence = {
    headSha: sha,
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
  if (evidenceSha !== sha) {
    evidence.evidenceHeadSha = evidenceSha;
  }
  if (selected.fallbackCoveredWorkflows.length > 0) {
    evidence.fallbackCoveredWorkflows = selected.fallbackCoveredWorkflows;
  }
  return evidence;
}

export function workflowRunQueryPaths(repo, { sha, recentSha, headBranch }, page = 1) {
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

function loadWorkflowRunsForQuery(queryForPage) {
  const loadPage = (page) =>
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

function loadWorkflowRuns(repo, sha, recentSha, headBranch) {
  const queries = workflowRunQueryPaths(repo, { sha, recentSha, headBranch });
  const withPage = (query, page) => query.replace(/page=1$/u, `page=${page}`);
  const workflowRuns = queries.flatMap((query) =>
    loadWorkflowRunsForQuery((page) => withPage(query, page)),
  );
  return [...new Map(workflowRuns.map((run) => [run.id, run])).values()];
}

export function compareCommitPageCount(totalCommits) {
  if (!Number.isSafeInteger(totalCommits) || totalCommits < 0) {
    throw new Error("Expected comparison total_commits to be a non-negative integer.");
  }
  return Math.max(1, Math.ceil(totalCommits / COMPARE_COMMITS_PAGE_SIZE));
}

function loadPullRequestCommitShas(repo, { baseSha, headSha }) {
  const loadPage = (page) =>
    JSON.parse(
      execGhApiRead(
        `repos/${repo}/compare/${baseSha}...${headSha}?per_page=${COMPARE_COMMITS_PAGE_SIZE}&page=${page}`,
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );

  // The PR commits endpoint stops at 250. GitHub's paginated comparison is
  // equivalent to git log BASE..HEAD and keeps the membership proof complete.
  const firstPage = loadPage(1);
  const pages = [firstPage];
  for (let page = 2; page <= compareCommitPageCount(firstPage?.total_commits); page += 1) {
    pages.push(loadPage(page));
  }
  const shas = pages.flatMap((comparison, index) => {
    if (!Array.isArray(comparison?.commits)) {
      throw new Error(`Expected comparison commit page ${index + 1} to be an array.`);
    }
    return comparison.commits.map((commit) => commit?.sha).filter(Boolean);
  });
  if (shas.length !== firstPage.total_commits) {
    throw new Error(
      `Expected ${firstPage.total_commits} comparison commits, received ${shas.length}.`,
    );
  }
  return shas;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pullRequest = JSON.parse(
    execGhApiRead(`repos/${args.repo}/pulls/${args.pr}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const headBranch = pullRequest?.head?.ref;
  const headRepository = pullRequest?.head?.repo?.full_name;
  const baseSha = pullRequest?.base?.sha;
  const headSha = pullRequest?.head?.sha;
  if (!headBranch || !headRepository || !baseSha || !headSha) {
    throw new Error(`PR #${args.pr} is missing head or base metadata.`);
  }
  if (headSha !== args.sha) {
    throw new Error(`PR #${args.pr} head changed from ${args.sha} to ${headSha}.`);
  }
  const evidence = collectHostedGateEvidence({
    sha: args.sha,
    pr: args.pr,
    recentSha: args.recentSha,
    pullRequestCommitShas: loadPullRequestCommitShas(args.repo, { baseSha, headSha }),
    pullRequestHeadBranch: headBranch,
    pullRequestHeadRepository: headRepository,
    workflowRuns: loadWorkflowRuns(args.repo, args.sha, args.recentSha, headBranch),
    changelogOnly: args.changelogOnly,
  });
  const evidenceHeadSha = evidence.evidenceHeadSha ?? args.sha;
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    repo: args.repo,
    pullRequestNumber: args.pr,
    selection: {
      mode: evidenceHeadSha === args.sha ? "exact-head" : "recent-pr-head",
      maxAgeHours: HOSTED_GATE_MAX_AGE_HOURS,
    },
    ...evidence,
  };
  mkdirSync(path.dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Hosted gates passed for PR #${args.pr} at ${args.sha} using ${evidenceHeadSha}: ${manifest.workflows
      .map((workflow) => `${workflow.name}#${workflow.id}`)
      .join(", ")}`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
