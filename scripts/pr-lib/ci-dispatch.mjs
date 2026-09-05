#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { execGhJson, execGhRead, execPlainGh, workflowRunsApiArgs } from "../lib/plain-gh.mjs";
import {
  isProtectedMainWorkflowPath,
  parseCrabboxGateCheckSummary,
} from "./crabbox-gate-contract.mjs";

const REPOSITORY = "openclaw/openclaw";
const CRABBOX_WORKFLOW = ".github/workflows/pr-crabbox-gate-publisher.yml";
const CRABBOX_CHECK = "openclaw/crabbox-gate";
const CRABBOX_CHECK_APP_ID = 15368;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function requirePrRecord({ baseRefOid, pr, headRefName, headRefOid, isCrossRepository }) {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error("Expected a positive PR number.");
  }
  if (typeof headRefName !== "string" || headRefName.length === 0 || headRefName.startsWith("-")) {
    throw new Error("Expected a non-empty PR headRefName.");
  }
  if (!SHA_PATTERN.test(headRefOid) || !SHA_PATTERN.test(baseRefOid)) {
    throw new Error("Expected full PR baseRefOid and headRefOid values.");
  }
  if (isCrossRepository === true) {
    throw new Error(
      `PR #${pr} comes from a fork; release-gate workflow dispatch requires a branch in the base repository at ${headRefOid}.`,
    );
  }
}

function buildCiDispatchArgs(record, backend) {
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
      `base_sha=${record.baseRefOid}`,
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

function listCiRuns(headRefOid, backend) {
  const args =
    backend.name === "crabbox"
      ? [
          "api",
          "--method",
          "GET",
          `repos/${REPOSITORY}/actions/workflows/pr-crabbox-gate-publisher.yml/runs`,
          "-f",
          "event=workflow_dispatch",
          "-f",
          "branch=main",
          "-f",
          "per_page=20",
        ]
      : workflowRunsApiArgs(REPOSITORY, headRefOid, "workflow_dispatch", 20);
  return execGhJson(args, { stdio: ["ignore", "pipe", "pipe"] }).workflow_runs;
}

function readCurrentPrHeadOid(pr) {
  return execGhRead(["pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readWorkflowRun(runId) {
  return execGhJson(["api", "--method", "GET", `repos/${REPOSITORY}/actions/runs/${runId}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readExactHeadChecks(headSha) {
  const endpoint = `repos/${REPOSITORY}/commits/${headSha}/check-runs?filter=latest&per_page=100`;
  const pages = execGhJson(["api", "--paginate", "--slurp", endpoint], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.check_runs))) {
    throw new Error("Exact-head check-run pages are malformed.");
  }
  return pages.flatMap(({ check_runs }) => check_runs);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function requireUnchangedHead(record, phase, readHeadOid) {
  const current = readHeadOid(record.pr);
  if (current !== record.headRefOid) {
    throw new Error(
      `PR #${record.pr} head changed ${phase} (expected ${record.headRefOid}, got ${current}).`,
    );
  }
}

async function waitForCrabboxResult(
  record,
  observedRun,
  {
    readChecks = readExactHeadChecks,
    readRun = readWorkflowRun,
    readHeadOid = readCurrentPrHeadOid,
    terminalPollAttempts = 1080,
    terminalPollIntervalMs = 15_000,
    wait = delay,
  },
) {
  let run;
  for (let attempt = 1; attempt <= terminalPollAttempts; attempt += 1) {
    run = readRun(observedRun.id);
    if (run.status === "completed") {
      break;
    }
    if (attempt < terminalPollAttempts) {
      await wait(terminalPollIntervalMs);
    }
  }
  if (run?.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `Protected-main Crabbox publisher did not complete successfully (${run?.status ?? "missing"}/${run?.conclusion ?? "missing"}).`,
    );
  }
  if (
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    !SHA_PATTERN.test(run.head_sha) ||
    !isProtectedMainWorkflowPath(run.path, CRABBOX_WORKFLOW)
  ) {
    throw new Error("Protected-main Crabbox publisher run identity is invalid.");
  }
  requireUnchangedHead(record, "before exact-head check observation", readHeadOid);
  const check = readChecks(record.headRefOid)
    .filter(
      (candidate) =>
        candidate.name === CRABBOX_CHECK &&
        candidate.head_sha === record.headRefOid &&
        candidate.status === "completed" &&
        candidate.conclusion === "success" &&
        candidate.app?.id === CRABBOX_CHECK_APP_ID &&
        candidate.details_url === run.html_url,
    )
    .toSorted((a, b) => b.id - a.id)[0];
  if (!check) {
    throw new Error("Protected publisher succeeded without the exact-head GitHub Actions check.");
  }
  const binding = parseCrabboxGateCheckSummary(check.output?.summary);
  if (
    binding.baseSha !== record.baseRefOid ||
    binding.headSha !== record.headRefOid ||
    binding.workflowSha !== run.head_sha
  ) {
    throw new Error(
      "Crabbox check summary does not bind the dispatched PR base, head, and workflow.",
    );
  }
  requireUnchangedHead(record, "before returning Crabbox proof", readHeadOid);
  return {
    actionsRunId: run.id,
    actionsRunUrl: run.html_url,
    backend: "crabbox",
    checkId: check.id,
    provider: "aws",
    target: "linux",
    ...binding,
  };
}

async function dispatchCiForPr(
  record,
  backend,
  {
    listRuns = listCiRuns,
    pollAttempts = 10,
    pollIntervalMs = 1500,
    readHeadOid = readCurrentPrHeadOid,
    runDispatch = (args) =>
      execPlainGh(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    wait = delay,
    waitForCrabbox = waitForCrabboxResult,
  } = {},
) {
  requirePrRecord(record);
  const priorRunIds = new Set(listRuns(record.headRefOid, backend).map((run) => run.id));
  requireUnchangedHead(record, "before CI dispatch", readHeadOid);
  runDispatch(buildCiDispatchArgs(record, backend));

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const run = listRuns(record.headRefOid, backend).find((candidate) => {
      const identityMatches =
        backend.name === "crabbox"
          ? candidate.head_branch === "main" &&
            candidate.display_title === `PR Crabbox gate #${record.pr} / ${record.headRefOid}`
          : candidate.head_sha === record.headRefOid;
      return (
        identityMatches &&
        !priorRunIds.has(candidate.id) &&
        typeof candidate.html_url === "string" &&
        candidate.html_url.length > 0
      );
    });
    if (run) {
      requireUnchangedHead(record, "before an exact-SHA CI run became visible", readHeadOid);
      return backend.name === "crabbox" ? waitForCrabbox(record, run, { readHeadOid, wait }) : run;
    }
    if (attempt < pollAttempts) {
      await wait(pollIntervalMs);
    }
  }
  requireUnchangedHead(record, "while CI dispatch was being indexed", readHeadOid);
  return undefined;
}

function parseBackendArgs(argv) {
  if (argv.length === 0) {
    return { name: "ci" };
  }
  if (argv.length === 2 && argv[0] === "--backend" && argv[1] === "crabbox") {
    return { name: "crabbox" };
  }
  throw new Error("Expected only --backend crabbox.");
}

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
  if (argv.length < 5 || !["true", "false"].includes(argv[4])) {
    console.error(
      "Usage: ci-dispatch.mjs <PR> <headRefName> <headRefOid> <baseRefOid> <isCrossRepository> [--backend crabbox]",
    );
    process.exitCode = 2;
    return;
  }
  const record = {
    baseRefOid: argv[3],
    pr: Number(argv[0]),
    headRefName: argv[1],
    headRefOid: argv[2],
    isCrossRepository: argv[4] === "true",
  };
  const backend = parseBackendArgs(argv.slice(5));
  requirePrRecord(record);
  warnOnLocalHeadDrift(record);
  const result = await dispatchCiForPr(record, backend);
  if (result) {
    console.log(
      `GitHub accepted ${backend.name} dispatch for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      backend.name === "crabbox" ? JSON.stringify(result) : `observed_run_url=${result.html_url}`,
    );
    return;
  }
  console.log(
    `Requested ${backend.name} CI for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
  );
  console.log("run_url=pending (GitHub accepted the dispatch, but Actions has not indexed it yet)");
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
