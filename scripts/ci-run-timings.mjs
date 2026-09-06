#!/usr/bin/env node

// Summarizes GitHub Actions run/job timings for CI analysis.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { execPlainGh } from "./lib/plain-gh.mjs";

const DEFAULT_GITHUB_REPOSITORY = "openclaw/openclaw";
const RUN_JOBS_PAGE_SIZE = 100;
const RUN_JOBS_MAX_PAGES = 25;
const TREND_RUNS_MAX_PAGES = 100;
const DEFAULT_TREND_COMPARE_HOURS = 12;
const DEFAULT_TREND_DETAIL_RUNS = 100;
const GH_JSON_RETRY_DELAYS_MS = [1_000, 3_000, 6_000];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseJsonCommand(command, args, onAttempt = null, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= GH_JSON_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      onAttempt?.();
      const stdout =
        command === "gh"
          ? execPlainGh(args, {
              encoding: "utf8",
              ...options,
            })
          : execFileSync(command, args, {
              encoding: "utf8",
              ...options,
            });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableGhJsonErrorMessage(message);
      if (!retryable || attempt === GH_JSON_RETRY_DELAYS_MS.length) {
        throw error;
      }
      sleepSync(GH_JSON_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

export function isRetryableGhJsonErrorMessage(message) {
  return /HTTP 5\d\d|HTTP 429|Server Error|secondary rate limit|abuse detection|ETIMEDOUT|ECONNRESET|EAI_AGAIN/iu.test(
    message,
  );
}

function normalizeRunJob(job) {
  return {
    completedAt: job.completedAt ?? job.completed_at ?? null,
    conclusion: job.conclusion ?? "",
    createdAt: job.createdAt ?? job.created_at ?? null,
    databaseId: job.databaseId ?? job.id,
    labels: Array.isArray(job.labels) ? job.labels : [],
    name: job.name,
    runnerGroupName: job.runnerGroupName ?? job.runner_group_name ?? null,
    runnerName: job.runnerName ?? job.runner_name ?? null,
    startedAt: job.startedAt ?? job.started_at ?? null,
    status: job.status ?? "",
  };
}

/**
 * Flattens paginated GitHub run job responses.
 */
export function collectRunJobsFromPages(pages) {
  return pages.flatMap((page) => (Array.isArray(page.jobs) ? page.jobs.map(normalizeRunJob) : []));
}

function parseTime(value) {
  if (!value || value === "0001-01-01T00:00:00Z") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function secondsBetween(start, end) {
  return start !== null && end !== null ? Math.round((end - start) / 1000) : null;
}

function formatSeconds(value) {
  return value === null ? "" : `${value}s`;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function summarizeDistribution(values) {
  return {
    count: values.length,
    max: values.length === 0 ? null : Math.max(...values),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
  };
}

function parseRunList(raw) {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function isPnpmStoreWarmupGatedJobName(name) {
  return (
    name === "build-artifacts" ||
    name === "check-docs" ||
    name === "check-guards" ||
    name === "check-npm-lock" ||
    name === "check-prod-types" ||
    name === "check-lint" ||
    name === "check-dependencies" ||
    name === "check-test-types" ||
    name.startsWith("check-additional-") ||
    name.startsWith("checks-fast-") ||
    (name.startsWith("checks-node-") && !name.startsWith("checks-node-compat-"))
  );
}

function collectRunTimingContext(run) {
  const created = parseTime(run.createdAt);
  const updated = parseTime(run.updatedAt);
  const jobs = (run.jobs ?? [])
    .filter((job) => !job.name?.startsWith("matrix."))
    .map((job) => {
      const started = parseTime(job.startedAt);
      const completed = parseTime(job.completedAt);
      return {
        conclusion: job.conclusion ?? "",
        durationSeconds: secondsBetween(started, completed),
        name: job.name,
        // Actions exposes job start time, but not the split between `needs`
        // dependency wait and runner queue. Keep the combined delay honest.
        startDelaySeconds: secondsBetween(created, started),
        started,
        completed,
        status: job.status,
      };
    });

  return { created, jobs, updated };
}

/**
 * Summarizes longest jobs and total timing for a workflow run.
 */
export function summarizeRunTimings(run, limit = 15) {
  const { created, jobs, updated } = collectRunTimingContext(run);
  if (jobs.length === 0) {
    throw new Error("CI run timing summary requires at least one job");
  }
  const byDuration = [...jobs]
    .filter((job) => job.durationSeconds !== null)
    .toSorted((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, limit);
  const byStartDelay = [...jobs]
    .filter((job) => job.startDelaySeconds !== null && (job.durationSeconds ?? 0) > 5)
    .toSorted((left, right) => right.startDelaySeconds - left.startDelaySeconds)
    .slice(0, limit);
  const badJobs = jobs.filter(
    (job) => job.conclusion && !["success", "skipped", "cancelled"].includes(job.conclusion),
  );

  return {
    byDuration,
    byStartDelay,
    conclusion: run.conclusion ?? "",
    status: run.status ?? "",
    wallSeconds: secondsBetween(created, updated),
    badJobs,
  };
}

/**
 * Summarizes pnpm store warmup overlap near run start.
 */
export function summarizePnpmStoreWarmupBarrier(run, windowSeconds = 5) {
  const { jobs } = collectRunTimingContext(run);
  const preflight = jobs.find((job) => job.name === "preflight");
  const warmup = jobs.find((job) => job.name === "pnpm-store-warmup");
  if (!warmup?.started || !warmup?.completed) {
    return null;
  }

  const postWarmupJobs = jobs.filter(
    (job) =>
      job.name !== "preflight" &&
      job.name !== "security-fast" &&
      job.name !== "pnpm-store-warmup" &&
      isPnpmStoreWarmupGatedJobName(job.name) &&
      job.status === "completed" &&
      job.conclusion !== "skipped" &&
      job.started !== null &&
      job.started >= warmup.completed &&
      (job.durationSeconds ?? 0) > 5,
  );
  const startDelays = postWarmupJobs
    .map((job) => secondsBetween(warmup.completed, job.started))
    .filter((delay) => delay !== null);

  return {
    activePostWarmupJobCount: postWarmupJobs.length,
    firstPostWarmupStartDelaySeconds: startDelays.length === 0 ? null : Math.min(...startDelays),
    postWarmupP95StartDelaySeconds: percentile(startDelays, 0.95),
    postWarmupStartedWithinWindow: startDelays.filter((delay) => delay <= windowSeconds).length,
    preflightToWarmupCompleteSeconds: secondsBetween(
      preflight?.completed ?? null,
      warmup.completed,
    ),
    preflightToWarmupStartSeconds: secondsBetween(preflight?.completed ?? null, warmup.started),
    warmupDurationSeconds: secondsBetween(warmup.started, warmup.completed),
    warmupResult: `${warmup.status}/${warmup.conclusion}`,
    windowSeconds,
  };
}

/**
 * Selects the latest main push CI run, optionally matching a head SHA.
 *
 * @param {Array<Record<string, unknown>>} runs
 * @param {string | null} [headSha]
 */
export function selectLatestMainPushCiRun(runs, headSha = null) {
  const pushRuns = runs.filter((run) => run.event === "push");
  if (headSha) {
    const matchingRun = pushRuns.find((run) => run.headSha === headSha);
    if (matchingRun) {
      return matchingRun;
    }
  }
  return pushRuns[0] ?? null;
}

function getLatestCiRunId() {
  const raw = execPlainGh(
    ["run", "list", "--branch", "main", "--workflow", "CI", "--limit", "1", "--json", "databaseId"],
    { encoding: "utf8" },
  );
  const runs = JSON.parse(raw);
  const runId = runs[0]?.databaseId;
  if (!runId) {
    throw new Error("No CI runs found on main");
  }
  return String(runId);
}

function getRemoteMainSha() {
  const raw = execFileSync("git", ["ls-remote", "origin", "main"], { encoding: "utf8" }).trim();
  const [sha] = raw.split(/\s+/u);
  if (!sha) {
    throw new Error("Could not resolve origin/main");
  }
  return sha;
}

function getLatestMainPushCiRunId() {
  const headSha = getRemoteMainSha();
  const raw = execPlainGh(
    [
      "run",
      "list",
      "--branch",
      "main",
      "--workflow",
      "CI",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,event,status,conclusion",
    ],
    { encoding: "utf8" },
  );
  const run = selectLatestMainPushCiRun(parseRunList(raw), headSha);
  const databaseId = run?.databaseId;
  if (typeof databaseId !== "string" && typeof databaseId !== "number") {
    throw new Error(`No push CI run found for origin/main ${headSha.slice(0, 10)}`);
  }
  return String(databaseId);
}

function listRecentSuccessfulCiRuns(limit) {
  const raw = execPlainGh(
    [
      "run",
      "list",
      "--branch",
      "main",
      "--event",
      "push",
      "--workflow",
      "CI",
      "--limit",
      String(Math.max(limit * 4, limit)),
      "--json",
      "databaseId,headSha,event,status,conclusion",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw)
    .filter(
      (run) => run.event === "push" && run.status === "completed" && run.conclusion === "success",
    )
    .slice(0, limit);
}

/**
 * @param {string | number} runId
 * @param {number | null} [runAttempt]
 */
function loadRunJobs(runId, runAttempt = null) {
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY;
  const runPath = runAttempt === null ? `runs/${runId}` : `runs/${runId}/attempts/${runAttempt}`;
  const pages = [];
  let totalCount = null;
  let requestCount = 0;
  for (let page = 1; page <= RUN_JOBS_MAX_PAGES; page += 1) {
    const payload = parseJsonCommand(
      "gh",
      [
        "api",
        "-X",
        "GET",
        `repos/${repository}/actions/${runPath}/jobs?per_page=${RUN_JOBS_PAGE_SIZE}&page=${page}`,
      ],
      () => {
        requestCount += 1;
      },
    );
    pages.push(payload);
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    totalCount = typeof payload.total_count === "number" ? payload.total_count : totalCount;
    if (
      jobs.length === 0 ||
      (totalCount !== null && collectRunJobsFromPages(pages).length >= totalCount)
    ) {
      break;
    }
  }
  return { jobs: collectRunJobsFromPages(pages), requestCount };
}

function loadRun(runId) {
  const run = parseJsonCommand("gh", [
    "run",
    "view",
    runId,
    "--json",
    "status,conclusion,createdAt,updatedAt",
  ]);
  return {
    ...run,
    jobs: loadRunJobs(runId).jobs,
  };
}

function normalizeTrendRun(run) {
  return {
    conclusion: run.conclusion ?? "",
    createdAt: run.createdAt ?? run.created_at ?? null,
    databaseId: run.databaseId ?? run.id,
    headSha: run.headSha ?? run.head_sha ?? "",
    runAttempt: run.runAttempt ?? run.run_attempt ?? 1,
    status: run.status ?? "",
    updatedAt: run.updatedAt ?? run.updated_at ?? null,
    url: run.url ?? run.html_url ?? "",
  };
}

function listTrendCiRuns(cutoffMs) {
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY;
  const runs = [];
  let requestCount = 0;
  for (let page = 1; page <= TREND_RUNS_MAX_PAGES; page += 1) {
    const payload = parseJsonCommand(
      "gh",
      [
        "api",
        "-X",
        "GET",
        `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&page=${page}`,
      ],
      () => {
        requestCount += 1;
      },
    );
    const pageRuns = Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs.map(normalizeTrendRun)
      : [];
    runs.push(...pageRuns);
    const oldestCreatedAt = parseTime(pageRuns.at(-1)?.createdAt);
    if (pageRuns.length < 100 || (oldestCreatedAt !== null && oldestCreatedAt < cutoffMs)) {
      break;
    }
  }
  return {
    requestCount,
    runs: runs.filter((run) => {
      const createdAt = parseTime(run.createdAt);
      return createdAt !== null && createdAt >= cutoffMs;
    }),
  };
}

function summarizeJobs(run) {
  const { created, jobs, updated } = collectRunTimingContext(run);
  if (jobs.length === 0) {
    throw new Error("CI run timing summary requires at least one job");
  }
  const completedJobs = jobs.filter((job) => job.started !== null && job.completed !== null);
  const successfulDurations = jobs
    .filter((job) => job.status === "completed" && job.conclusion === "success")
    .map((job) => job.durationSeconds)
    .filter((duration) => duration !== null);
  const firstStart = Math.min(...completedJobs.map((job) => job.started));
  const lastComplete = Math.max(...completedJobs.map((job) => job.completed));

  return {
    avgDurationSeconds:
      successfulDurations.length === 0
        ? null
        : Math.round(
            successfulDurations.reduce((sum, duration) => sum + duration, 0) /
              successfulDurations.length,
          ),
    executionWindowSeconds:
      Number.isFinite(firstStart) && Number.isFinite(lastComplete)
        ? secondsBetween(firstStart, lastComplete)
        : null,
    firstStartDelaySeconds: Number.isFinite(firstStart)
      ? secondsBetween(created, firstStart)
      : null,
    jobCount: successfulDurations.length,
    maxDurationSeconds: successfulDurations.length === 0 ? null : Math.max(...successfulDurations),
    p90DurationSeconds: percentile(successfulDurations, 0.9),
    p95DurationSeconds: percentile(successfulDurations, 0.95),
    wallSeconds: secondsBetween(created, updated),
  };
}

function isSyntheticTimingJob(job) {
  return job.name?.startsWith("matrix.") || job.name === "ci-timings-summary";
}

function isAggregateTimingJob(job) {
  return isSyntheticTimingJob(job) || job.name === "openclaw/ci-gate";
}

function summarizeTrendRun(run) {
  const createdAt = parseTime(run.createdAt);
  const updatedAt = parseTime(run.updatedAt);
  const jobs = (run.jobs ?? []).filter((job) => !isSyntheticTimingJob(job));
  const createdJobs = jobs
    .map((job) => ({ job, createdAt: parseTime(job.createdAt) }))
    .filter((entry) => entry.createdAt !== null);
  const firstJobCreatedAt =
    createdJobs.length === 0 ? null : Math.min(...createdJobs.map((entry) => entry.createdAt));
  const activeJobs = jobs
    .map((job) => ({
      completedAt: parseTime(job.completedAt),
      createdAt: parseTime(job.createdAt),
      job,
      startedAt: parseTime(job.startedAt),
    }))
    .filter(
      (entry) =>
        entry.job.conclusion !== "skipped" &&
        entry.startedAt !== null &&
        entry.completedAt !== null,
    );
  const jobTimings = activeJobs
    .filter((entry) => !isAggregateTimingJob(entry.job))
    .map((entry) => ({
      dependencyGatedSeconds: secondsBetween(firstJobCreatedAt, entry.createdAt),
      executionSeconds: secondsBetween(entry.startedAt, entry.completedAt),
      labels: entry.job.labels,
      name: entry.job.name,
      runnerGroupName: entry.job.runnerGroupName,
      runnerName: entry.job.runnerName,
      runnerQueueSeconds: secondsBetween(entry.createdAt, entry.startedAt),
    }));
  const completionOrder = activeJobs.toSorted(
    (left, right) =>
      right.completedAt - left.completedAt ||
      String(left.job.name).localeCompare(String(right.job.name)) ||
      Number(left.job.databaseId ?? 0) - Number(right.job.databaseId ?? 0),
  );
  // The run list keeps the original workflow creation time after a rerun.
  // Attempt-specific job data remains useful, but exclude cross-attempt run
  // wall/admission metrics rather than mixing it with the latest attempt.
  const firstAttempt = run.runAttempt === 1;

  return {
    admittedWallSeconds: firstAttempt ? secondsBetween(firstJobCreatedAt, updatedAt) : null,
    conclusion: run.conclusion,
    createdAt: run.createdAt,
    databaseId: run.databaseId,
    detailsLoaded: Array.isArray(run.jobs),
    headSha: run.headSha,
    jobTimings,
    lastWorkOwner:
      completionOrder.find((entry) => !isAggregateTimingJob(entry.job))?.job.name ?? null,
    runAttempt: run.runAttempt,
    status: run.status,
    terminalOwner: completionOrder[0]?.job.name ?? null,
    url: run.url,
    wallSeconds: firstAttempt ? secondsBetween(createdAt, updatedAt) : null,
    workflowAdmissionSeconds: firstAttempt ? secondsBetween(createdAt, firstJobCreatedAt) : null,
  };
}

function summarizeOutcomes(runs) {
  const counts = {
    actionRequired: 0,
    cancelled: 0,
    failure: 0,
    inProgress: 0,
    neutral: 0,
    other: 0,
    pending: 0,
    queued: 0,
    skipped: 0,
    stale: 0,
    startupFailure: 0,
    success: 0,
    timedOut: 0,
    total: runs.length,
  };
  const conclusionKeys = new Map([
    ["action_required", "actionRequired"],
    ["cancelled", "cancelled"],
    ["failure", "failure"],
    ["neutral", "neutral"],
    ["skipped", "skipped"],
    ["stale", "stale"],
    ["startup_failure", "startupFailure"],
    ["success", "success"],
    ["timed_out", "timedOut"],
  ]);
  let completedNonCancelled = 0;
  for (const run of runs) {
    if (run.status === "completed" && run.conclusion !== "cancelled") {
      completedNonCancelled += 1;
    }
    const key =
      run.status === "completed"
        ? conclusionKeys.get(run.conclusion)
        : run.status === "in_progress"
          ? "inProgress"
          : run.status;
    if (key && Object.hasOwn(counts, key)) {
      counts[key] += 1;
    } else {
      counts.other += 1;
    }
  }
  return {
    ...counts,
    cancellationRate: counts.total === 0 ? null : counts.cancelled / counts.total,
    nonCancelledPassRate:
      completedNonCancelled === 0 ? null : counts.success / completedNonCancelled,
  };
}

function summarizeCriticalOwners(runSummaries) {
  const counts = new Map();
  for (const run of runSummaries) {
    if (run.lastWorkOwner) {
      counts.set(run.lastWorkOwner, (counts.get(run.lastWorkOwner) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, runs]) => ({ name, runs }))
    .toSorted((left, right) => right.runs - left.runs || left.name.localeCompare(right.name));
}

function summarizeTrendCohort(runs, runSummaries) {
  const successfulRuns = runSummaries.filter(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
  const jobTimings = successfulRuns.flatMap((run) => run.jobTimings);
  return {
    criticalOwners: summarizeCriticalOwners(successfulRuns),
    jobMetrics: {
      dependencyGatedSeconds: summarizeDistribution(
        jobTimings.map((job) => job.dependencyGatedSeconds).filter((value) => value !== null),
      ),
      executionSeconds: summarizeDistribution(
        jobTimings.map((job) => job.executionSeconds).filter((value) => value !== null),
      ),
      runnerQueueSeconds: summarizeDistribution(
        jobTimings.map((job) => job.runnerQueueSeconds).filter((value) => value !== null),
      ),
    },
    outcomes: summarizeOutcomes(runs),
    samples: {
      detailedSuccessfulRuns: successfulRuns.filter((run) => run.detailsLoaded).length,
      successfulRuns: successfulRuns.length,
      timedJobs: jobTimings.length,
    },
    runMetrics: {
      admittedWallSeconds: summarizeDistribution(
        successfulRuns.map((run) => run.admittedWallSeconds).filter((value) => value !== null),
      ),
      successfulWallSeconds: summarizeDistribution(
        successfulRuns.map((run) => run.wallSeconds).filter((value) => value !== null),
      ),
      workflowAdmissionSeconds: summarizeDistribution(
        successfulRuns.map((run) => run.workflowAdmissionSeconds).filter((value) => value !== null),
      ),
    },
  };
}

function summarizeJobNames(runSummaries, fromMs, toMs) {
  const byName = new Map();
  for (const run of runSummaries) {
    const createdAt = parseTime(run.createdAt);
    if (
      createdAt === null ||
      createdAt < fromMs ||
      createdAt >= toMs ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    ) {
      continue;
    }
    for (const job of run.jobTimings) {
      const timings = byName.get(job.name) ?? [];
      timings.push(job);
      byName.set(job.name, timings);
    }
  }
  return byName;
}

function summarizeNamedJobComparison(runSummaries, priorWindow, comparisonWindow) {
  const prior = summarizeJobNames(runSummaries, priorWindow.fromMs, priorWindow.toMs);
  const comparison = summarizeJobNames(
    runSummaries,
    comparisonWindow.fromMs,
    comparisonWindow.toMs,
  );
  return [...new Set([...prior.keys(), ...comparison.keys()])]
    .map((name) => {
      const summarize = (timings) => ({
        executionSeconds: summarizeDistribution(
          (timings ?? []).map((job) => job.executionSeconds).filter((value) => value !== null),
        ),
        runnerQueueSeconds: summarizeDistribution(
          (timings ?? []).map((job) => job.runnerQueueSeconds).filter((value) => value !== null),
        ),
      });
      return {
        comparison: summarize(comparison.get(name)),
        name,
        prior: summarize(prior.get(name)),
      };
    })
    .toSorted(
      (left, right) =>
        (right.comparison.executionSeconds.p90 ?? -1) -
          (left.comparison.executionSeconds.p90 ?? -1) || left.name.localeCompare(right.name),
    );
}

function metricDelta(comparison, prior, key) {
  const comparisonValue = comparison?.[key] ?? null;
  const priorValue = prior?.[key] ?? null;
  return comparisonValue === null || priorValue === null ? null : comparisonValue - priorValue;
}

/**
 * Aggregates main CI runs into a baseline, previous comparison window, and latest window.
 */
export function summarizeTrendTimings(runs, options) {
  const { compareDurationMs, generatedAtMs, trendDurationMs } = options;
  const baselineFromMs = generatedAtMs - trendDurationMs;
  const comparisonFromMs = generatedAtMs - compareDurationMs;
  const priorFromMs = comparisonFromMs - compareDurationMs;
  const inWindow = (run, fromMs, toMs) => {
    const createdAt = parseTime(run.createdAt);
    return createdAt !== null && createdAt >= fromMs && createdAt < toMs;
  };
  const baselineRuns = runs.filter((run) => inWindow(run, baselineFromMs, generatedAtMs));
  const priorRuns = runs.filter((run) => inWindow(run, priorFromMs, comparisonFromMs));
  const comparisonRuns = runs.filter((run) => inWindow(run, comparisonFromMs, generatedAtMs));
  const runSummaries = baselineRuns
    .map(summarizeTrendRun)
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const baselineSummaries = runSummaries.filter((run) =>
    inWindow(run, baselineFromMs, generatedAtMs),
  );
  const priorSummaries = runSummaries.filter((run) => inWindow(run, priorFromMs, comparisonFromMs));
  const comparisonSummaries = runSummaries.filter((run) =>
    inWindow(run, comparisonFromMs, generatedAtMs),
  );
  const cohorts = {
    baseline: summarizeTrendCohort(baselineRuns, baselineSummaries),
    comparison: summarizeTrendCohort(comparisonRuns, comparisonSummaries),
    prior: summarizeTrendCohort(priorRuns, priorSummaries),
  };

  return {
    changes: {
      executionP90Seconds: metricDelta(
        cohorts.comparison.jobMetrics.executionSeconds,
        cohorts.prior.jobMetrics.executionSeconds,
        "p90",
      ),
      runnerQueueP95Seconds: metricDelta(
        cohorts.comparison.jobMetrics.runnerQueueSeconds,
        cohorts.prior.jobMetrics.runnerQueueSeconds,
        "p95",
      ),
      successfulWallP50Seconds: metricDelta(
        cohorts.comparison.runMetrics.successfulWallSeconds,
        cohorts.prior.runMetrics.successfulWallSeconds,
        "p50",
      ),
      successfulWallP90Seconds: metricDelta(
        cohorts.comparison.runMetrics.successfulWallSeconds,
        cohorts.prior.runMetrics.successfulWallSeconds,
        "p90",
      ),
      workflowAdmissionP95Seconds: metricDelta(
        cohorts.comparison.runMetrics.workflowAdmissionSeconds,
        cohorts.prior.runMetrics.workflowAdmissionSeconds,
        "p95",
      ),
    },
    cohorts,
    jobs: summarizeNamedJobComparison(
      runSummaries,
      { fromMs: priorFromMs, toMs: comparisonFromMs },
      { fromMs: comparisonFromMs, toMs: generatedAtMs },
    ),
    runs: runSummaries,
    windows: {
      baseline: {
        from: new Date(baselineFromMs).toISOString(),
        to: new Date(generatedAtMs).toISOString(),
      },
      comparison: {
        from: new Date(comparisonFromMs).toISOString(),
        to: new Date(generatedAtMs).toISOString(),
      },
      prior: {
        from: new Date(priorFromMs).toISOString(),
        to: new Date(comparisonFromMs).toISOString(),
      },
    },
  };
}

function formatDistribution(summary) {
  return [
    `n=${summary.count}`,
    `p50=${formatSeconds(summary.p50)}`,
    `p90=${formatSeconds(summary.p90)}`,
    `p95=${formatSeconds(summary.p95)}`,
    `max=${formatSeconds(summary.max)}`,
  ].join("  ");
}

function formatDelta(value) {
  if (value === null) {
    return "";
  }
  return `${value > 0 ? "+" : ""}${formatSeconds(value)}`;
}

function formatPercent(value) {
  return value === null ? "" : `${(value * 100).toFixed(1)}%`;
}

function printTrendCohort(name, cohort) {
  const outcomes = cohort.outcomes;
  console.log(`\n${name}`);
  console.log(
    [
      `runs=${outcomes.total}`,
      `success=${outcomes.success}`,
      `failure=${outcomes.failure}`,
      `timed-out=${outcomes.timedOut}`,
      `startup-failure=${outcomes.startupFailure}`,
      `action-required=${outcomes.actionRequired}`,
      `neutral=${outcomes.neutral}`,
      `skipped=${outcomes.skipped}`,
      `stale=${outcomes.stale}`,
      `cancelled=${outcomes.cancelled}`,
      `queued=${outcomes.queued}`,
      `pending=${outcomes.pending}`,
      `in-progress=${outcomes.inProgress}`,
      `other=${outcomes.other}`,
      `pass=${formatPercent(outcomes.nonCancelledPassRate)}`,
      `cancelled-rate=${formatPercent(outcomes.cancellationRate)}`,
    ].join("  "),
  );
  console.log(
    `successful wall       ${formatDistribution(cohort.runMetrics.successfulWallSeconds)}`,
  );
  console.log(
    `workflow admission    ${formatDistribution(cohort.runMetrics.workflowAdmissionSeconds)}`,
  );
  console.log(
    `dependency gating     ${formatDistribution(cohort.jobMetrics.dependencyGatedSeconds)}`,
  );
  console.log(`runner queue          ${formatDistribution(cohort.jobMetrics.runnerQueueSeconds)}`);
  console.log(`job execution         ${formatDistribution(cohort.jobMetrics.executionSeconds)}`);
  console.log(
    `detail sample       ${cohort.samples.detailedSuccessfulRuns}/${cohort.samples.successfulRuns} successful runs, ${cohort.samples.timedJobs} jobs`,
  );
}

function printTrendReport(report) {
  const { baseline, comparison, prior } = report.cohorts;
  console.log(
    `CI trend: ${report.options.trendHours}h baseline; latest ${report.options.compareHours}h vs prior ${report.options.compareHours}h`,
  );
  console.log(
    `API requests=${report.apiRequests.total} (run-list=${report.apiRequests.runList}, jobs=${report.apiRequests.jobs}); detailed=${report.sampling.detailedSuccessfulRuns}/${report.sampling.eligibleSuccessfulRuns} successful runs`,
  );
  printTrendCohort("Baseline", baseline);
  printTrendCohort("Prior comparison window", prior);
  printTrendCohort("Latest comparison window", comparison);

  console.log("\nLatest minus prior");
  console.log(
    [
      `wall-p50=${formatDelta(report.changes.successfulWallP50Seconds)}`,
      `wall-p90=${formatDelta(report.changes.successfulWallP90Seconds)}`,
      `admission-p95=${formatDelta(report.changes.workflowAdmissionP95Seconds)}`,
      `queue-p95=${formatDelta(report.changes.runnerQueueP95Seconds)}`,
      `execution-p90=${formatDelta(report.changes.executionP90Seconds)}`,
    ].join("  "),
  );

  if (comparison.criticalOwners.length > 0) {
    console.log("\nLatest critical-path owners");
    for (const owner of comparison.criticalOwners.slice(0, 15)) {
      console.log(`${String(owner.name).padEnd(56)} ${owner.runs} run(s)`);
    }
  }

  const timedJobs = report.jobs.filter((job) => job.comparison.executionSeconds.count > 0);
  if (timedJobs.length > 0) {
    console.log("\nLatest job execution p90");
    for (const job of timedJobs.slice(0, 15)) {
      console.log(
        `${String(job.name).padEnd(56)} latest=${formatSeconds(job.comparison.executionSeconds.p90).padStart(6)}  prior=${formatSeconds(job.prior.executionSeconds.p90).padStart(6)}`,
      );
    }
  }
}

function printSection(title, jobs, metric) {
  console.log(title);
  for (const job of jobs) {
    console.log(
      `${String(job.name).padEnd(48)} ${formatSeconds(job[metric]).padStart(6)}  start-delay=${formatSeconds(job.startDelaySeconds).padStart(6)}  ${job.status}/${job.conclusion}`,
    );
  }
}

/**
 * Parses CI run timing CLI arguments.
 */
export function parseRunTimingArgs(args) {
  let compareHours = DEFAULT_TREND_COMPARE_HOURS;
  let compareHoursSpecified = false;
  let detailRuns = DEFAULT_TREND_DETAIL_RUNS;
  let detailRunsSpecified = false;
  let explicitRunId;
  let json = false;
  let limit = 15;
  let limitSpecified = false;
  let outputPath = null;
  let recentLimit = null;
  let trendHours = null;
  let useLatestMain = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--latest-main") {
      useLatestMain = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const limitOption = consumePositiveIntFlag(args, index, "--limit");
    if (limitOption) {
      limit = limitOption.value;
      limitSpecified = true;
      index = limitOption.nextIndex;
      continue;
    }
    const recentOption = consumePositiveIntFlag(args, index, "--recent");
    if (recentOption) {
      recentLimit = recentOption.value;
      index = recentOption.nextIndex;
      continue;
    }
    const trendOption = consumePositiveIntFlag(args, index, "--trend-hours");
    if (trendOption) {
      trendHours = trendOption.value;
      index = trendOption.nextIndex;
      continue;
    }
    const compareOption = consumePositiveIntFlag(args, index, "--compare-hours");
    if (compareOption) {
      compareHours = compareOption.value;
      compareHoursSpecified = true;
      index = compareOption.nextIndex;
      continue;
    }
    const detailOption = consumePositiveIntFlag(args, index, "--detail-runs");
    if (detailOption) {
      detailRuns = detailOption.value;
      detailRunsSpecified = true;
      index = detailOption.nextIndex;
      continue;
    }
    const outputOption = consumeStringFlag(args, index, "--output");
    if (outputOption) {
      outputPath = outputOption.value;
      index = outputOption.nextIndex;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown CI run timing option: ${arg}`);
    }
    if (explicitRunId) {
      throw new Error(`Unexpected CI run id argument: ${arg}`);
    }
    explicitRunId = arg;
  }

  if (recentLimit !== null && (explicitRunId || useLatestMain)) {
    throw new Error("--recent cannot be combined with a run id or --latest-main");
  }
  if (explicitRunId && useLatestMain) {
    throw new Error("A run id cannot be combined with --latest-main");
  }
  if (trendHours !== null) {
    if (explicitRunId || useLatestMain || recentLimit !== null || limitSpecified) {
      throw new Error("--trend-hours cannot be combined with single-run or --recent options");
    }
    if (trendHours < compareHours * 2) {
      throw new Error("--trend-hours must cover at least two --compare-hours windows");
    }
  } else if (compareHoursSpecified || detailRunsSpecified || json || outputPath !== null) {
    throw new Error("--compare-hours, --detail-runs, --json, and --output require --trend-hours");
  }

  return {
    compareHours,
    detailRuns,
    explicitRunId,
    json,
    limit,
    outputPath,
    recentLimit,
    trendHours,
    useLatestMain,
  };
}

function consumePositiveIntFlag(args, index, flag) {
  const arg = args[index];
  const inlinePrefix = `${flag}=`;
  if (arg.startsWith(inlinePrefix)) {
    return {
      nextIndex: index,
      value: parsePositiveInt(arg.slice(inlinePrefix.length), flag),
    };
  }
  if (arg !== flag) {
    return null;
  }
  const rawValue = args[index + 1];
  if (!rawValue || rawValue.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return {
    nextIndex: index + 1,
    value: parsePositiveInt(rawValue, flag),
  };
}

function consumeStringFlag(args, index, flag) {
  const arg = args[index];
  const inlinePrefix = `${flag}=`;
  if (arg.startsWith(inlinePrefix)) {
    const value = arg.slice(inlinePrefix.length);
    if (!value) {
      throw new Error(`${flag} requires a value`);
    }
    return { nextIndex: index, value };
  }
  if (arg !== flag) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return { nextIndex: index + 1, value };
}

function selectTrendDetailCandidates(runs, generatedAtMs, compareDurationMs, limit) {
  const comparisonFromMs = generatedAtMs - compareDurationMs;
  const priorFromMs = comparisonFromMs - compareDurationMs;
  const successfulRuns = runs.filter(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
  const comparison = successfulRuns.filter(
    (run) => (parseTime(run.createdAt) ?? 0) >= comparisonFromMs,
  );
  const prior = successfulRuns.filter((run) => {
    const createdAt = parseTime(run.createdAt) ?? 0;
    return createdAt >= priorFromMs && createdAt < comparisonFromMs;
  });
  const older = successfulRuns.filter((run) => (parseTime(run.createdAt) ?? 0) < priorFromMs);
  const selected = [];
  let comparisonIndex = 0;
  let priorIndex = 0;
  while (
    selected.length < limit &&
    (comparisonIndex < comparison.length || priorIndex < prior.length)
  ) {
    if (comparisonIndex < comparison.length && selected.length < limit) {
      selected.push(comparison[comparisonIndex]);
      comparisonIndex += 1;
    }
    if (priorIndex < prior.length && selected.length < limit) {
      selected.push(prior[priorIndex]);
      priorIndex += 1;
    }
  }
  return [
    ...selected,
    ...comparison.slice(comparisonIndex),
    ...prior.slice(priorIndex),
    ...older,
  ].slice(0, limit);
}

function runTrendReport(options) {
  const generatedAtMs = Date.now();
  const trendDurationMs = options.trendHours * 60 * 60 * 1000;
  const compareDurationMs = options.compareHours * 60 * 60 * 1000;
  const listed = listTrendCiRuns(generatedAtMs - trendDurationMs);
  const eligibleRuns = listed.runs.filter(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
  const detailCandidates = selectTrendDetailCandidates(
    listed.runs,
    generatedAtMs,
    compareDurationMs,
    options.detailRuns,
  );
  console.error(
    `[ci-timings] loading job details for ${detailCandidates.length}/${eligibleRuns.length} successful runs; expect at least ${detailCandidates.length} job API requests`,
  );
  const detailsByRun = new Map();
  let jobsRequestCount = 0;
  for (const run of detailCandidates) {
    const loaded = loadRunJobs(run.databaseId, run.runAttempt);
    jobsRequestCount += loaded.requestCount;
    detailsByRun.set(run.databaseId, loaded.jobs);
  }
  const runs = listed.runs.map((run) =>
    detailsByRun.has(run.databaseId) ? { ...run, jobs: detailsByRun.get(run.databaseId) } : run,
  );
  const summary = summarizeTrendTimings(runs, {
    compareDurationMs,
    generatedAtMs,
    trendDurationMs,
  });
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY;
  return {
    apiRequests: {
      jobs: jobsRequestCount,
      runList: listed.requestCount,
      total: listed.requestCount + jobsRequestCount,
    },
    generatedAt: new Date(generatedAtMs).toISOString(),
    options: {
      compareHours: options.compareHours,
      detailRuns: options.detailRuns,
      trendHours: options.trendHours,
    },
    repository,
    sampling: {
      detailedSuccessfulRuns: detailCandidates.length,
      eligibleSuccessfulRuns: eligibleRuns.length,
    },
    ...summary,
  };
}

async function main() {
  const options = parseRunTimingArgs(process.argv.slice(2));
  const { explicitRunId, limit, recentLimit, useLatestMain } = options;
  if (options.trendHours !== null) {
    const report = runTrendReport(options);
    const reportJson = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath) {
      mkdirSync(path.dirname(options.outputPath), { recursive: true });
      writeFileSync(options.outputPath, reportJson);
    }
    if (options.json) {
      process.stdout.write(reportJson);
    } else {
      printTrendReport(report);
      if (options.outputPath) {
        console.log(`\nJSON report: ${options.outputPath}`);
      }
    }
    return;
  }
  if (recentLimit !== null) {
    for (const run of listRecentSuccessfulCiRuns(recentLimit)) {
      const summary = summarizeJobs(loadRun(run.databaseId));
      console.log(
        [
          `CI run ${run.databaseId}`,
          run.headSha.slice(0, 10),
          `wall=${formatSeconds(summary.wallSeconds)}`,
          `exec=${formatSeconds(summary.executionWindowSeconds)}`,
          `firstStartDelay=${formatSeconds(summary.firstStartDelaySeconds)}`,
          `jobs=${summary.jobCount}`,
          `avg=${formatSeconds(summary.avgDurationSeconds)}`,
          `p90=${formatSeconds(summary.p90DurationSeconds)}`,
          `p95=${formatSeconds(summary.p95DurationSeconds)}`,
          `max=${formatSeconds(summary.maxDurationSeconds)}`,
        ].join("  "),
      );
    }
    return;
  }
  const runId = explicitRunId ?? (useLatestMain ? getLatestMainPushCiRunId() : getLatestCiRunId());
  const run = loadRun(runId);
  const summary = summarizeRunTimings(run, limit);
  const warmupBarrier = summarizePnpmStoreWarmupBarrier(run);

  console.log(
    `CI run ${runId}: ${summary.status}/${summary.conclusion} wall=${formatSeconds(summary.wallSeconds)}`,
  );
  if (warmupBarrier) {
    console.log("\npnpm-store-warmup barrier");
    console.log(
      [
        `result=${warmupBarrier.warmupResult}`,
        `preflight->start=${formatSeconds(warmupBarrier.preflightToWarmupStartSeconds)}`,
        `duration=${formatSeconds(warmupBarrier.warmupDurationSeconds)}`,
        `preflight->complete=${formatSeconds(warmupBarrier.preflightToWarmupCompleteSeconds)}`,
      ].join("  "),
    );
    console.log(
      [
        `active-post-warmup-jobs=${warmupBarrier.activePostWarmupJobCount}`,
        `first-start-delay=${formatSeconds(warmupBarrier.firstPostWarmupStartDelaySeconds)}`,
        `p95-start-delay=${formatSeconds(warmupBarrier.postWarmupP95StartDelaySeconds)}`,
        `started-within-${warmupBarrier.windowSeconds}s=${warmupBarrier.postWarmupStartedWithinWindow}`,
      ].join("  "),
    );
  }
  printSection("\nSlowest jobs", summary.byDuration, "durationSeconds");
  printSection(
    "\nLongest start delays (dependencies + runner queue)",
    summary.byStartDelay,
    "startDelaySeconds",
  );
  if (summary.badJobs.length > 0) {
    console.log("\nFailed jobs");
    for (const job of summary.badJobs) {
      console.log(`${job.name} ${job.status}/${job.conclusion}`);
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
