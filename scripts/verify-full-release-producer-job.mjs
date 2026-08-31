#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const OPTION_NAMES = ["--repository", "--job-id", "--job-name", "--run-id", "--run-attempt"];

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!OPTION_NAMES.includes(name) || !value || options.has(name)) {
      throw new Error(`invalid or duplicate option: ${name ?? "<missing>"}`);
    }
    options.set(name, value);
  }
  for (const name of OPTION_NAMES) {
    if (!options.has(name)) {
      throw new Error(`missing ${name}`);
    }
  }
  return options;
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function actualIdentifier(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
}

function assertEqual(actual, expected, label) {
  if (actualIdentifier(actual) !== expected) {
    throw new Error(
      `producer ${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const repository = options.get("--repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("repository must be an owner/name pair");
  }
  const jobId = positiveInteger(options.get("--job-id"), "job ID");
  const jobName = options.get("--job-name");
  const runId = positiveInteger(options.get("--run-id"), "run ID");
  const runAttempt = positiveInteger(options.get("--run-attempt"), "run attempt");

  // Bind evidence only to the exact producer captured before untrusted code ran.
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/jobs/${jobId}`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`producer job lookup failed with exit code ${result.status ?? "unknown"}`);
  }

  let job;
  try {
    job = JSON.parse(result.stdout);
  } catch {
    throw new Error("producer job lookup returned invalid JSON");
  }
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("producer job lookup must return an object");
  }

  assertEqual(job.id, jobId, "job ID");
  assertEqual(job.name, jobName, "job name");
  assertEqual(job.run_id, runId, "run ID");
  assertEqual(job.run_attempt, runAttempt, "run attempt");
  assertEqual(job.status, "completed", "job status");
  assertEqual(job.conclusion, "success", "job conclusion");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
