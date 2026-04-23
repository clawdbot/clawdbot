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

export function summarizeRunTimings(run, limit = 15) {
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
        status: job.status,
      };
    });
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

function printSection(title, jobs, metric) {
  console.log(title);
  for (const job of jobs) {
    console.log(
      `${String(job.name).padEnd(48)} ${formatSeconds(job[metric]).padStart(6)}  queue=${formatSeconds(job.queueSeconds).padStart(6)}  ${job.status}/${job.conclusion}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex === -1 ? 15 : Math.max(1, Number.parseInt(args[limitIndex + 1] ?? "", 10) || 15);
  const runId =
    args.find((arg, index) => index !== limitIndex && index !== limitIndex + 1) ??
    getLatestCiRunId();
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
