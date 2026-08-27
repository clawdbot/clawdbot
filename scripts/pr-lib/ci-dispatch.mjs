#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { execGhJson, execGhRead, execPlainGh, workflowRunsApiArgs } from "../lib/plain-gh.mjs";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^run_[a-z0-9]+$/u;
const LEASE_ID_PATTERN = /^cbx_[a-z0-9]+$/u;

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

function buildCiDispatchArgs(record, backend = { name: "ci" }) {
  requirePrRecord(record);
  if (backend.name === "crabbox") {
    return [
      "workflow",
      "run",
      "pr-crabbox-gate-publisher.yml",
      "--ref",
      "main",
      "-f",
      `pr_number=${record.pr}`,
      "-f",
      `head_sha=${record.headRefOid}`,
      "-f",
      `crabbox_run_id=${backend.runId}`,
      "-f",
      `crabbox_lease_id=${backend.leaseId}`,
      "-f",
      `bootstrap_sha256=${backend.bootstrapSha256}`,
    ];
  }
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

function listCiRuns(headRefOid, backend = { name: "ci" }) {
  const args =
    backend.name === "crabbox"
      ? [
          "api",
          "--method",
          "GET",
          "repos/openclaw/openclaw/actions/workflows/pr-crabbox-gate-publisher.yml/runs",
          "-f",
          "event=workflow_dispatch",
          "-f",
          "branch=main",
          "-f",
          "per_page=20",
        ]
      : workflowRunsApiArgs("openclaw/openclaw", headRefOid, "workflow_dispatch", 20);
  return execGhJson(args, { stdio: ["ignore", "pipe", "pipe"] }).workflow_runs;
}

function readCurrentPrHeadOid(pr) {
  return execGhRead(["pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid"], {
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
  backend = { name: "ci" },
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
  const priorRunIds = new Set(listRuns(record.headRefOid, backend).map((run) => run.id));
  const headBeforeDispatch = readHeadOid(record.pr);
  if (headBeforeDispatch !== record.headRefOid) {
    throw new Error(
      `PR #${record.pr} head changed before CI dispatch (expected ${record.headRefOid}, got ${headBeforeDispatch}).`,
    );
  }
  runDispatch(buildCiDispatchArgs(record, backend));

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const run = listRuns(record.headRefOid, backend).find((candidate) => {
      const identityMatches =
        backend.name === "crabbox"
          ? candidate.head_branch === "main" &&
            candidate.display_title === `PR Crabbox gate #${record.pr} / ${backend.runId}`
          : candidate.head_sha === record.headRefOid;
      return (
        identityMatches &&
        !priorRunIds.has(candidate.id) &&
        typeof candidate.html_url === "string" &&
        candidate.html_url.length > 0
      );
    });
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

function parseBackendArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected value for ${name ?? "backend option"}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate option: ${name}`);
    }
    options.set(name, value);
  }
  const backendName = options.get("--backend") ?? "ci";
  if (backendName === "ci") {
    if (options.size > (options.has("--backend") ? 1 : 0)) {
      throw new Error("Crabbox proof options require --backend crabbox.");
    }
    return { name: "ci" };
  }
  if (backendName !== "crabbox") {
    throw new Error(`Unsupported CI backend: ${backendName}`);
  }
  const runId = options.get("--run-id") ?? "";
  const leaseId = options.get("--lease-id") ?? "";
  const bootstrapSha256 = options.get("--bootstrap-sha256") ?? "";
  const expected = new Set(["--backend", "--run-id", "--lease-id", "--bootstrap-sha256"]);
  if ([...options.keys()].some((name) => !expected.has(name))) {
    throw new Error("Unknown Crabbox backend option.");
  }
  if (
    !RUN_ID_PATTERN.test(runId) ||
    !LEASE_ID_PATTERN.test(leaseId) ||
    !SHA256_PATTERN.test(bootstrapSha256)
  ) {
    throw new Error("Crabbox backend requires valid run, lease, and bootstrap SHA-256 values.");
  }
  return { bootstrapSha256, leaseId, name: "crabbox", runId };
}

// Dispatch always targets the REMOTE head; unpushed local work silently gets
// no CI. Warn (never block) when a same-named local branch points elsewhere,
// so an operator who meant to test local changes pushes first. Best-effort:
// any git failure (no repo, no branch) skips the check.
function warnOnLocalHeadDrift(record) {
  const probe = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${record.headRefName}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (probe.status !== 0) {
    return;
  }
  const localOid = probe.stdout.trim();
  if (SHA_PATTERN.test(localOid) && localOid !== record.headRefOid) {
    console.error(
      `warning: local branch ${record.headRefName} is at ${localOid}, but CI is being dispatched for the remote head ${record.headRefOid}; push first if you meant to test local changes.`,
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length < 4 || !["true", "false"].includes(argv[3])) {
    console.error(
      "Usage: ci-dispatch.mjs <PR> <headRefName> <headRefOid> <isCrossRepository> [--backend crabbox --run-id <id> --lease-id <id> --bootstrap-sha256 <hash>]",
    );
    process.exitCode = 2;
    return;
  }
  const record = {
    pr: Number(argv[0]),
    headRefName: argv[1],
    headRefOid: argv[2],
    isCrossRepository: argv[3] === "true",
  };
  const backend = parseBackendArgs(argv.slice(4));
  requirePrRecord(record);
  warnOnLocalHeadDrift(record);
  const run = await dispatchCiForPr(record, backend);
  if (run) {
    console.log(
      `GitHub accepted ${backend.name} dispatch for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      "Observed a new exact-SHA manual run after dispatch; GitHub does not expose a dispatch correlation ID, so concurrent requests cannot be distinguished.",
    );
    console.log(`observed_run_url=${run.html_url}`);
  } else {
    console.log(
      `Requested ${backend.name} CI for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      "run_url=pending (GitHub accepted the dispatch, but Actions has not indexed it yet)",
    );
    console.log(
      backend.name === "crabbox"
        ? "inspect_with=gh api --method GET repos/openclaw/openclaw/actions/workflows/pr-crabbox-gate-publisher.yml/runs -f event=workflow_dispatch -f branch=main -f per_page=20"
        : `inspect_with=gh api --method GET repos/openclaw/openclaw/actions/workflows/ci.yml/runs -f event=workflow_dispatch -f head_sha=${record.headRefOid} -f per_page=20`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
