#!/usr/bin/env node

import { execFileSync } from "node:child_process";

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

function parseRunList(raw) {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
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
        queueSeconds: secondsBetween(created, started),
        started,
        completed,
        status: job.status,
      };
    });

  return { created, jobs, updated };
}

export function summarizeRunTimings(run, limit = 15) {
  const { created, jobs, updated } = collectRunTimingContext(run);
  const byDuration = [...jobs]
    .filter((job) => job.durationSeconds !== null)
    .toSorted((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, limit);
  const byQueue = [...jobs]
    .filter((job) => job.queueSeconds !== null && (job.durationSeconds ?? 0) > 5)
    .toSorted((left, right) => right.queueSeconds - left.queueSeconds)
    .slice(0, limit);
  const badJobs = jobs.filter(
    (job) => job.conclusion && !["success", "skipped", "cancelled"].includes(job.conclusion),
  );

  return {
    byDuration,
    byQueue,
    conclusion: run.conclusion ?? "",
    status: run.status ?? "",
    wallSeconds: secondsBetween(created, updated),
    badJobs,
  };
}

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
  const raw = execFileSync(
    "gh",
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
  const raw = execFileSync(
    "gh",
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
  const raw = execFileSync(
    "gh",
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
  return JSON.parse(
    execFileSync(
      "gh",
      ["run", "view", runId, "--json", "status,conclusion,createdAt,updatedAt,jobs"],
      {
        encoding: "utf8",
      },
    ),
  );
}

function summarizeJobs(run) {
  const { created, jobs, updated } = collectRunTimingContext(run);
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
    firstQueueSeconds: Number.isFinite(firstStart) ? secondsBetween(created, firstStart) : null,
    jobCount: successfulDurations.length,
    maxDurationSeconds: successfulDurations.length === 0 ? null : Math.max(...successfulDurations),
    p90DurationSeconds: percentile(successfulDurations, 0.9),
    p95DurationSeconds: percentile(successfulDurations, 0.95),
    wallSeconds: secondsBetween(created, updated),
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function printSection(title, jobs, metric) {
  console.log(title);
  for (const job of jobs) {
    console.log(
      `${String(job.name).padEnd(48)} ${formatSeconds(job[metric]).padStart(6)}  queue=${formatSeconds(job.queueSeconds).padStart(6)}  ${job.status}/${job.conclusion}`,
    );
  }
}

export function parseRunTimingArgs(args) {
  const recentIndex = args.indexOf("--recent");
  const limitIndex = args.indexOf("--limit");
  const ignoredArgIndexes = new Set();
  for (const [index, arg] of args.entries()) {
    if (arg === "--" || arg === "--latest-main") {
      ignoredArgIndexes.add(index);
    }
  }
  if (limitIndex !== -1) {
    ignoredArgIndexes.add(limitIndex);
    ignoredArgIndexes.add(limitIndex + 1);
  }
  if (recentIndex !== -1) {
    ignoredArgIndexes.add(recentIndex);
    ignoredArgIndexes.add(recentIndex + 1);
  }
  const limit =
    limitIndex === -1 ? 15 : Math.max(1, Number.parseInt(args[limitIndex + 1] ?? "", 10) || 15);
  const recentLimit =
    recentIndex === -1 ? null : Math.max(1, Number.parseInt(args[recentIndex + 1] ?? "", 10) || 10);
  return {
    explicitRunId: args.find((_arg, index) => !ignoredArgIndexes.has(index)),
    limit,
    recentLimit,
    useLatestMain: args.includes("--latest-main"),
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
          `firstQueue=${formatSeconds(summary.firstQueueSeconds)}`,
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
  const summary = summarizeRunTimings(loadRun(runId), limit);

  console.log(
    `CI run ${runId}: ${summary.status}/${summary.conclusion} wall=${formatSeconds(summary.wallSeconds)}`,
  );
  printSection("\nSlowest jobs", summary.byDuration, "durationSeconds");
  printSection("\nLongest queues", summary.byQueue, "queueSeconds");
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
