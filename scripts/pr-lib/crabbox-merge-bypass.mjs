#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  isProtectedMainWorkflowPath,
  parseCrabboxGateCheckSummary,
  validateForwardAncestry,
} from "./crabbox-gate-contract.mjs";

const CHECK_APP_ID = 15368;
const CRABBOX_CHECK_NAME = "openclaw/crabbox-gate";
const CI_CHECK_NAME = "openclaw/ci-gate";
const BYPASSABLE_JOB_CONCLUSIONS = new Set(["failure", "timed_out"]);

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function latestNamedCheck(checkRuns, name) {
  const matches = checkRuns
    .filter((value) => record(value, "check run").name === name)
    .toSorted(
      (left, right) =>
        requiredPositiveInteger(record(right, "check run").id, "check run id") -
        requiredPositiveInteger(record(left, "check run").id, "check run id"),
    );
  const check = matches[0];
  if (!check) {
    throw new Error(`missing exact-head ${name} check`);
  }
  return record(check, name);
}

function validateCheckIdentity(check, { conclusion, headSha, name }) {
  if (
    check.name !== name ||
    check.head_sha !== headSha ||
    check.status !== "completed" ||
    !conclusion.has(check.conclusion) ||
    record(check.app, `${name} app`).id !== CHECK_APP_ID
  ) {
    throw new Error(`${name} check identity, exact head, app, or result does not match`);
  }
}

function parseCiDetailsUrl(value) {
  const match = requiredString(value, "openclaw/ci-gate details URL").match(
    /^https:\/\/github\.com\/openclaw\/openclaw\/actions\/runs\/(\d+)\/job\/(\d+)$/u,
  );
  if (!match) {
    throw new Error("openclaw/ci-gate details URL is not an exact Actions run/job URL");
  }
  return {
    jobId: Number(match[2]),
    runId: Number(match[1]),
  };
}

function parsePublisherDetailsUrl(value) {
  const match = requiredString(value, "openclaw/crabbox-gate details URL").match(
    /^https:\/\/github\.com\/openclaw\/openclaw\/actions\/runs\/(\d+)$/u,
  );
  if (!match) {
    throw new Error("openclaw/crabbox-gate details URL is not an exact Actions run URL");
  }
  return Number(match[1]);
}

function runnerBackend(job) {
  const values = [
    ...(Array.isArray(job.labels) ? job.labels : []),
    job.runner_name,
    job.runner_group_name,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (values.includes("blacksmith")) {
    return "blacksmith";
  }
  if (
    !values.includes("self-hosted") &&
    (values.includes("github actions") ||
      values.includes("ubuntu-") ||
      values.includes("windows-") ||
      values.includes("macos-"))
  ) {
    return "github-hosted";
  }
  return "unknown";
}

function validateRequiredChecks(requiredChecks) {
  if (!Array.isArray(requiredChecks)) {
    throw new Error("required checks must be an array");
  }
  const pending = requiredChecks.filter(
    (check) => record(check, "required check").bucket === "pending",
  );
  if (pending.length > 0) {
    throw new Error("required checks are still pending");
  }
  const unsatisfied = requiredChecks.filter(
    (check) => !["pass"].includes(record(check, "required check").bucket),
  );
  if (
    unsatisfied.length !== 1 ||
    record(unsatisfied[0], "unsatisfied required check").name !== CI_CHECK_NAME ||
    !["fail", "skipping"].includes(unsatisfied[0].bucket)
  ) {
    throw new Error(`the only unsatisfied required check must be ${CI_CHECK_NAME}`);
  }
}

export function validateCrabboxMergeBypass({
  actor,
  checkRuns,
  expectedLeaseId,
  expectedRunId,
  finalMainRef,
  headSha,
  jobs,
  mainComparison,
  mainRef,
  membership,
  pullRequest,
  publisherRun,
  requiredChecks,
  workflowRun,
}) {
  const actorRecord = record(actor, "authenticated actor");
  const actorLogin = requiredString(actorRecord.login, "authenticated actor login");
  const membershipRecord = record(membership, "organization membership");
  if (
    membershipRecord.state !== "active" ||
    membershipRecord.role !== "admin" ||
    record(membershipRecord.user, "organization membership user").login !== actorLogin
  ) {
    throw new Error(`${actorLogin} is not an active openclaw organization admin`);
  }
  validateRequiredChecks(requiredChecks);

  const checkRunList = record(checkRuns, "check-runs response").check_runs;
  if (!Array.isArray(checkRunList)) {
    throw new Error("check-runs response is missing check_runs");
  }
  const crabboxCheck = latestNamedCheck(checkRunList, CRABBOX_CHECK_NAME);
  validateCheckIdentity(crabboxCheck, {
    conclusion: new Set(["success"]),
    headSha,
    name: CRABBOX_CHECK_NAME,
  });
  const binding = parseCrabboxGateCheckSummary(
    record(crabboxCheck.output, "openclaw/crabbox-gate output").summary,
  );
  const pull = record(pullRequest, "pull request");
  if (
    binding.runId !== expectedRunId ||
    binding.leaseId !== expectedLeaseId ||
    binding.headSha !== headSha ||
    pull.number < 1 ||
    pull.state !== "open" ||
    pull.draft !== false ||
    record(pull.head, "pull request head").sha !== headSha ||
    record(record(pull.head, "pull request head").repo, "pull request head repo").full_name !==
      "openclaw/openclaw" ||
    record(pull.base, "pull request base").sha !== binding.baseSha ||
    record(record(pull.base, "pull request base").repo, "pull request base repo").full_name !==
      "openclaw/openclaw" ||
    record(pull.base, "pull request base").ref !== "main"
  ) {
    throw new Error("openclaw/crabbox-gate does not bind the expected broker proof");
  }
  const publisherRunId = parsePublisherDetailsUrl(crabboxCheck.details_url);
  const publisher = record(publisherRun, "Crabbox publisher workflow run");
  if (
    publisher.id !== publisherRunId ||
    publisher.status !== "completed" ||
    publisher.conclusion !== "success" ||
    publisher.event !== "workflow_dispatch" ||
    publisher.head_branch !== "main" ||
    publisher.head_sha !== binding.workflowSha ||
    !isProtectedMainWorkflowPath(publisher.path, ".github/workflows/pr-crabbox-gate-publisher.yml")
  ) {
    throw new Error("Crabbox check is not bound to the current protected-main publisher workflow");
  }
  const mainRefRecord = record(mainRef, "protected main ref");
  const mainSha = record(mainRefRecord.object, "protected main ref.object").sha;
  if (mainRefRecord.ref !== "refs/heads/main") {
    throw new Error("protected main ref is malformed");
  }
  validateForwardAncestry(
    mainComparison,
    { baseSha: binding.workflowSha, headSha: mainSha },
    "protected main",
  );
  const finalMainRefRecord = record(finalMainRef, "final protected main ref");
  if (
    finalMainRefRecord.ref !== "refs/heads/main" ||
    record(finalMainRefRecord.object, "final protected main ref.object").sha !== mainSha
  ) {
    throw new Error("protected main moved during final Crabbox merge validation");
  }

  const ciCheck = latestNamedCheck(checkRunList, CI_CHECK_NAME);
  validateCheckIdentity(ciCheck, {
    conclusion: new Set(["failure", "skipped"]),
    headSha,
    name: CI_CHECK_NAME,
  });
  const { jobId: ciGateJobId, runId: ciRunId } = parseCiDetailsUrl(ciCheck.details_url);
  const run = record(workflowRun, "CI workflow run");
  if (
    run.id !== ciRunId ||
    run.head_sha !== headSha ||
    run.status !== "completed" ||
    !["failure", "startup_failure", "timed_out"].includes(run.conclusion) ||
    !["pull_request", "workflow_dispatch"].includes(run.event) ||
    !isProtectedMainWorkflowPath(run.path, ".github/workflows/ci.yml")
  ) {
    throw new Error("normal CI workflow identity, exact head, or terminal result does not match");
  }

  const jobList = record(jobs, "CI jobs response").jobs;
  if (!Array.isArray(jobList)) {
    throw new Error("CI jobs response is missing jobs");
  }
  const ciGateJob = jobList.find((value) => record(value, "CI job").id === ciGateJobId);
  if (
    !ciGateJob ||
    ciGateJob.name !== CI_CHECK_NAME ||
    ciGateJob.status !== "completed" ||
    ciGateJob.conclusion !== ciCheck.conclusion
  ) {
    throw new Error("normal CI gate job does not match its exact check run");
  }

  const unsuccessfulJobs = jobList
    .map((value) => record(value, "CI job"))
    .filter(
      (job) =>
        job.id !== ciGateJobId &&
        typeof job.conclusion === "string" &&
        !["neutral", "skipped", "success"].includes(job.conclusion),
    );
  const infrastructureJobs = [];
  if (run.conclusion === "startup_failure" && unsuccessfulJobs.length === 0) {
    infrastructureJobs.push({
      backend: "github-actions",
      conclusion: "startup_failure",
      id: ciRunId,
      name: "workflow startup",
    });
  } else {
    if (unsuccessfulJobs.length === 0) {
      throw new Error("normal CI has no blocking job with GitHub-owned infrastructure evidence");
    }
    for (const job of unsuccessfulJobs) {
      const id = requiredPositiveInteger(job.id, "CI job id");
      if (!BYPASSABLE_JOB_CONCLUSIONS.has(job.conclusion)) {
        throw new Error(`CI job ${id} conclusion is not a startup or provisioning outage`);
      }
      const backend = runnerBackend(job);
      if (!["blacksmith", "github-hosted"].includes(backend)) {
        throw new Error(`CI job ${id} runner backend is not a recognized hosted runner`);
      }
      if (typeof job.runner_name === "string" && job.runner_name.trim().length > 0) {
        throw new Error(`CI job ${id} acquired a runner; only unacquired outages may bypass`);
      }
      if (!Array.isArray(job.steps)) {
        throw new Error(`CI job ${id} is missing GitHub-owned step metadata`);
      }
      const failedStep = job.steps.find((value) =>
        ["action_required", "failure"].includes(record(value, `CI job ${id} step`).conclusion),
      );
      if (failedStep) {
        throw new Error(`CI job ${id} has a failed workflow step`);
      }
      if (job.steps.length > 0) {
        throw new Error(`CI job ${id} executed workflow steps; only no-step outages may bypass`);
      }
      infrastructureJobs.push({
        backend,
        conclusion: job.conclusion,
        id,
        name: requiredString(job.name, `CI job ${id} name`),
      });
    }
  }

  return {
    actor: actorLogin,
    crabboxCheckId: requiredPositiveInteger(crabboxCheck.id, "openclaw/crabbox-gate check id"),
    crabboxCheckUrl: requiredString(crabboxCheck.details_url, "openclaw/crabbox-gate URL"),
    crabboxPublisherRunId: publisherRunId,
    ciGateCheckId: requiredPositiveInteger(ciCheck.id, "openclaw/ci-gate check id"),
    ciGateUrl: requiredString(ciCheck.details_url, "openclaw/ci-gate URL"),
    ciRunId,
    infrastructureJobs,
    mainSha,
    planDigest: binding.planDigest,
    targetCount: binding.targetCount,
    workflowSha: binding.workflowSha,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Crabbox merge bypass verifier requires flag/value pairs");
    }
    args[flag.slice(2)] = value;
  }
  return args;
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobs = readJson(args.jobs, "CI jobs");
  const proof = validateCrabboxMergeBypass({
    actor: readJson(args.actor, "authenticated actor"),
    checkRuns: readJson(args["check-runs"], "check runs"),
    expectedLeaseId: requiredString(args["lease-id"], "lease id"),
    expectedRunId: requiredString(args["run-id"], "run id"),
    headSha: requiredString(args.head, "head SHA"),
    jobs,
    finalMainRef: readJson(args["final-main-ref"], "final protected main ref"),
    mainComparison: readJson(args["main-comparison"], "protected main comparison"),
    mainRef: readJson(args["main-ref"], "protected main ref"),
    membership: readJson(args.membership, "organization membership"),
    pullRequest: readJson(args["pull-request"], "pull request"),
    publisherRun: readJson(args["publisher-run"], "Crabbox publisher workflow run"),
    requiredChecks: readJson(args["required-checks"], "required checks"),
    workflowRun: readJson(args["workflow-run"], "workflow run"),
  });
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
