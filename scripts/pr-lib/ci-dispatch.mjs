#!/usr/bin/env node

import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { execPlainGh } from "../lib/plain-gh.mjs";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function requirePrRecord({ pr, headRefName, headRefOid, isCrossRepository }) {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error("Expected a positive PR number.");
  }
  if (typeof headRefName !== "string" || headRefName.length === 0 || headRefName.startsWith("-")) {
    throw new Error("Expected a non-empty PR headRefName.");
  }
  if (!SHA_PATTERN.test(headRefOid)) {
    throw new Error("Expected a full PR headRefOid.");
  }
  if (isCrossRepository === true) {
    throw new Error(
      `PR #${pr} comes from a fork; release-gate workflow dispatch requires a branch in the base repository at ${headRefOid}.`,
    );
  }
}

function buildCiDispatchArgs(record) {
  requirePrRecord(record);
  return [
    "workflow",
    "run",
    "ci.yml",
    "--ref",
    record.headRefName,
    "-f",
    `target_ref=${record.headRefOid}`,
    "-f",
    "release_gate=true",
    "-f",
    `pull_request_number=${record.pr}`,
  ];
}

function listCiRuns(headRefOid) {
  return JSON.parse(
    execPlainGh(
      [
        "run",
        "list",
        "--commit",
        headRefOid,
        "--workflow",
        "ci.yml",
        "--event",
        "workflow_dispatch",
        "--limit",
        "20",
        "--json",
        "databaseId,url,headSha,createdAt,status",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
}

function readCurrentPrHeadOid(pr) {
  return execPlainGh(["pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function dispatchCiForPr(
  record,
  {
    pollAttempts = 10,
    pollIntervalMs = 1500,
    listRuns = listCiRuns,
    runDispatch = (args) =>
      execPlainGh(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    readHeadOid = readCurrentPrHeadOid,
    wait = delay,
  } = {},
) {
  requirePrRecord(record);
  const priorRunIds = new Set(listRuns(record.headRefOid).map((run) => run.databaseId));
  const headBeforeDispatch = readHeadOid(record.pr);
  if (headBeforeDispatch !== record.headRefOid) {
    throw new Error(
      `PR #${record.pr} head changed before CI dispatch (expected ${record.headRefOid}, got ${headBeforeDispatch}).`,
    );
  }
  runDispatch(buildCiDispatchArgs(record));

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const run = listRuns(record.headRefOid).find(
      (candidate) =>
        candidate.headSha === record.headRefOid &&
        !priorRunIds.has(candidate.databaseId) &&
        typeof candidate.url === "string" &&
        candidate.url.length > 0,
    );
    if (run) {
      const headAtObservation = readHeadOid(record.pr);
      if (headAtObservation !== record.headRefOid) {
        throw new Error(
          `PR #${record.pr} head changed before an exact-SHA CI run became visible (expected ${record.headRefOid}, got ${headAtObservation}); verify the run before retrying.`,
        );
      }
      return run;
    }
    if (attempt < pollAttempts) {
      await wait(pollIntervalMs);
    }
  }
  const headAfterDispatch = readHeadOid(record.pr);
  if (headAfterDispatch !== record.headRefOid) {
    throw new Error(
      `PR #${record.pr} head changed while CI dispatch was being indexed (expected ${record.headRefOid}, got ${headAfterDispatch}); verify the run before retrying.`,
    );
  }
  return undefined;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || !["true", "false"].includes(argv[3])) {
    console.error("Usage: ci-dispatch.mjs <PR> <headRefName> <headRefOid> <isCrossRepository>");
    process.exitCode = 2;
    return;
  }
  const record = {
    pr: Number(argv[0]),
    headRefName: argv[1],
    headRefOid: argv[2],
    isCrossRepository: argv[3] === "true",
  };
  const run = await dispatchCiForPr(record);
  if (run) {
    console.log(
      `GitHub accepted CI dispatch for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      "Observed a new exact-SHA manual run after dispatch; GitHub does not expose a dispatch correlation ID, so concurrent requests cannot be distinguished.",
    );
    console.log(`observed_run_url=${run.url}`);
  } else {
    console.log(
      `Requested CI for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      "run_url=pending (GitHub accepted the dispatch, but Actions has not indexed it yet)",
    );
    console.log(
      `inspect_with=gh run list --commit ${record.headRefOid} --workflow ci.yml --event workflow_dispatch`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
