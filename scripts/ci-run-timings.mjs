#!/usr/bin/env node

// Summarizes GitHub Actions run/job timings for CI analysis.
import { execFileSync } from "node:child_process";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { execPlainGh } from "./lib/plain-gh.mjs";

const DEFAULT_GITHUB_REPOSITORY = "openclaw/openclaw";
const RUN_JOBS_PAGE_SIZE = 20;
const RUN_JOBS_MAX_PAGES = 25;
const GH_JSON_RETRY_DELAYS_MS = [1_000, 3_000, 6_000];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseJsonCommand(command, args, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= GH_JSON_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
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
    databaseId: job.databaseId ?? job.id,
    name: job.name,
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

function parseRunList(raw) {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function isPnpmStoreWarmupGatedJobName(name) {
  return (
    name === "build-artifacts" ||
    name === "check-docs" ||
    name === "check-guards" ||
    name === "check-shrinkwrap" ||
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
  if (!run?.databaseId) {
    throw new Error(`No push CI run found for origin/main ${headSha.slice(0, 10)}`);
  }
  return String(run.databaseId);
}

function listRecentSuccessfulCiRuns(limit) {
  const raw = execPlainGh(
    [
      "run",
      "list",
      "--branch",
      "main",
      "--workflow",
      "CI",
      "--limit",
      String(Math.max(limit * 4, limit)),
      "--json",
      "databaseId,headSha,status,conclusion",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw)
    .filter((run) => run.status === "completed" && run.conclusion === "success")
    .slice(0, limit);
}

function loadRun(runId) {
  const run = parseJsonCommand("gh", [
    "run",
    "view",
    runId,
    "--json",
    "status,conclusion,createdAt,updatedAt",
  ]);
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY;
  const pages = [];
  let totalCount = null;
  for (let page = 1; page <= RUN_JOBS_MAX_PAGES; page += 1) {
    const payload = parseJsonCommand("gh", [
      "api",
      "-X",
      "GET",
      `repos/${repository}/actions/runs/${runId}/jobs?per_page=${RUN_JOBS_PAGE_SIZE}&page=${page}`,
    ]);
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
  return {
    ...run,
    jobs: collectRunJobsFromPages(pages),
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
  let explicitRunId;
  let limit = 15;
  let recentLimit = null;
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
    const limitOption = consumePositiveIntFlag(args, index, "--limit");
    if (limitOption) {
      limit = limitOption.value;
      index = limitOption.nextIndex;
      continue;
    }
    const recentOption = consumePositiveIntFlag(args, index, "--recent");
    if (recentOption) {
      recentLimit = recentOption.value;
      index = recentOption.nextIndex;
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

  return {
    explicitRunId,
    limit,
    recentLimit,
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

async function main() {
  const { explicitRunId, limit, recentLimit, useLatestMain } = parseRunTimingArgs(
    process.argv.slice(2),
  );
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

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
