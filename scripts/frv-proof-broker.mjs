#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";
import { validateForwardAncestry } from "./pr-lib/crabbox-gate-contract.mjs";

const REPOSITORY = "openclaw/openclaw";
const BROKER_WORKFLOW = ".github/workflows/frv-proof-broker.yml";
const FIXTURE_WORKFLOW = ".github/workflows/frv-proof-fixture.yml";
const FIXTURE_WORKFLOW_ID = "frv-proof-fixture.yml";
const FIXTURE_NAME = "FRV Proof Fixture";
const FIXTURE_OPERATION = "noop";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT = 120;

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const compare = (left, right) => left.localeCompare(right);
  const actual = Object.keys(value).toSorted(compare);
  const wanted = [...expected].toSorted(compare);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function requiredEnv(env, name) {
  return requiredString(env[name], name);
}

export function validateBrokerRequest(event, env) {
  if (!isRecord(event)) {
    throw new Error("GITHUB_EVENT_PATH must contain an object");
  }
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  if (repository !== REPOSITORY) {
    throw new Error(`FRV proof broker requires repository ${REPOSITORY}`);
  }
  if (requiredEnv(env, "GITHUB_EVENT_NAME") !== "workflow_dispatch") {
    throw new Error("FRV proof broker requires workflow_dispatch");
  }
  if (requiredEnv(env, "GITHUB_REF") !== "refs/heads/main") {
    throw new Error("FRV proof broker must run from refs/heads/main");
  }
  const workflowSha = requiredEnv(env, "GITHUB_WORKFLOW_SHA");
  const eventSha = requiredEnv(env, "GITHUB_SHA");
  if (!SHA_PATTERN.test(workflowSha) || workflowSha !== eventSha) {
    throw new Error("FRV proof broker requires one exact trusted workflow SHA");
  }
  const expectedWorkflowRef = `${REPOSITORY}/${BROKER_WORKFLOW}@refs/heads/main`;
  if (requiredEnv(env, "GITHUB_WORKFLOW_REF") !== expectedWorkflowRef) {
    throw new Error(`FRV proof broker requires ${expectedWorkflowRef}`);
  }
  const actor = requiredEnv(env, "GITHUB_ACTOR");
  if (actor !== requiredEnv(env, "GITHUB_TRIGGERING_ACTOR")) {
    throw new Error("FRV proof broker actor must match the triggering actor");
  }
  const runId = requiredPositiveInteger(requiredEnv(env, "GITHUB_RUN_ID"), "GITHUB_RUN_ID");
  const runAttempt = requiredPositiveInteger(
    requiredEnv(env, "GITHUB_RUN_ATTEMPT"),
    "GITHUB_RUN_ATTEMPT",
  );

  assertExactKeys(event.inputs, ["landed_sha", "pr_number"], "workflow inputs");
  const inputs = event.inputs;
  const prNumber = requiredPositiveInteger(inputs.pr_number, "pr_number");
  const landedSha = requiredString(inputs.landed_sha, "landed_sha");
  if (!SHA_PATTERN.test(landedSha)) {
    throw new Error("landed_sha must be exactly 40 lowercase hex characters");
  }
  const correlation = `frv-proof-${runId}-${runAttempt}`;

  return {
    actor,
    correlation,
    landedSha,
    prNumber,
    repository: REPOSITORY,
    runId,
    workflowSha,
  };
}

function record(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function nestedRecord(value, key, label) {
  return record(record(value, label)[key], `${label}.${key}`);
}

function validateActorPermission(value, actor) {
  const permission = requiredString(record(value, "actor permission").permission, "permission");
  if (!new Set(["admin", "maintain", "write"]).has(permission)) {
    throw new Error(`actor ${actor} lacks repository write permission`);
  }
}

function validatePullRequest(value, context) {
  const pull = record(value, "pull request");
  if (
    pull.number !== context.prNumber ||
    pull.state !== "closed" ||
    pull.merged !== true ||
    typeof pull.merged_at !== "string" ||
    pull.merged_at.length === 0
  ) {
    throw new Error("proof target must be the requested merged pull request");
  }
  if (pull.merge_commit_sha !== context.landedSha) {
    throw new Error("pull request merge commit does not match the requested landed SHA");
  }
  if (nestedRecord(pull, "base", "pull request").ref !== "main") {
    throw new Error("pull request base must be main");
  }
  if (nestedRecord(pull, "base", "pull request").repo?.full_name !== context.repository) {
    throw new Error("pull request base repository does not match");
  }
}

function validateLandedAncestry(value, context) {
  validateForwardAncestry(
    value,
    { baseSha: context.landedSha, headSha: context.workflowSha },
    "landed controller ancestry",
  );
}

function validateFixtureWorkflow(value) {
  const workflow = record(value, "fixture workflow");
  if (
    workflow.name !== FIXTURE_NAME ||
    workflow.path !== FIXTURE_WORKFLOW ||
    workflow.state !== "active"
  ) {
    throw new Error("fixture workflow identity does not match the fixed active workflow");
  }
  requiredPositiveInteger(workflow.id, "fixture workflow id");
}

function validateMainRef(value, workflowSha) {
  const ref = record(value, "main ref");
  if (ref.ref !== "refs/heads/main") {
    throw new Error("main ref identity does not match");
  }
  const mainSha = requiredString(nestedRecord(ref, "object", "main ref").sha, "main ref SHA");
  if (!SHA_PATTERN.test(mainSha) || mainSha !== workflowSha) {
    throw new Error("trusted main moved before fixture dispatch");
  }
}

export function validateFixtureRun(value, expected) {
  const run = record(value, "fixture run");
  if (nestedRecord(run, "repository", "fixture run").full_name !== expected.repository) {
    throw new Error("fixture run repository does not match");
  }
  if (run.path !== FIXTURE_WORKFLOW) {
    throw new Error("fixture run workflow does not match");
  }
  if (run.head_sha !== expected.headSha || run.head_branch !== expected.branch) {
    throw new Error("fixture run source does not match the trusted main workflow SHA");
  }
  if (run.event !== "workflow_dispatch") {
    throw new Error("fixture run event does not match");
  }
  const expectedTitle = `${FIXTURE_NAME} [${FIXTURE_OPERATION}] ${expected.correlation}`;
  if (run.display_title !== expectedTitle) {
    throw new Error("fixture run operation or correlation does not match");
  }
  const runId = requiredPositiveInteger(run.id, "fixture run id");
  if (expected.runId !== undefined && runId !== expected.runId) {
    throw new Error("fixture run id changed");
  }
  if (requiredPositiveInteger(run.run_attempt, "fixture run attempt") !== expected.attempt) {
    throw new Error("fixture run attempt does not match");
  }
  if (run.status !== "completed" || run.conclusion !== expected.conclusion) {
    throw new Error(`fixture run must complete with ${expected.conclusion}`);
  }
  return run;
}

function fixtureRunIdentityMatches(value, context) {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.head_branch === "main" &&
    value.event === "workflow_dispatch" &&
    value.display_title === `${FIXTURE_NAME} [${FIXTURE_OPERATION}] ${context.correlation}`
  );
}

async function waitForInitialRun(api, context, sleep) {
  const branch = encodeURIComponent("main");
  for (let poll = 0; poll < POLL_LIMIT; poll += 1) {
    const response = record(
      await api.request(
        "GET",
        `/actions/workflows/${FIXTURE_WORKFLOW_ID}/runs?event=workflow_dispatch&branch=${branch}&per_page=20`,
      ),
      "fixture workflow runs",
    );
    const runs = response.workflow_runs;
    if (!Array.isArray(runs)) {
      throw new Error("fixture workflow runs response is invalid");
    }
    const candidate = runs.find((run) => fixtureRunIdentityMatches(run, context));
    if (candidate) {
      const run = record(candidate, "fixture run");
      if (run.status !== "completed") {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      return validateFixtureRun(run, {
        attempt: 1,
        branch: "main",
        conclusion: "failure",
        correlation: context.correlation,
        headSha: context.workflowSha,
        repository: context.repository,
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for the broker-owned fixture run");
}

async function waitForRerun(api, context, fixtureRunId, sleep) {
  for (let poll = 0; poll < POLL_LIMIT; poll += 1) {
    const run = record(await api.request("GET", `/actions/runs/${fixtureRunId}`), "fixture run");
    const attempt = requiredPositiveInteger(run.run_attempt, "fixture run attempt");
    if (attempt < 2 || run.status !== "completed") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    return validateFixtureRun(run, {
      attempt: 2,
      branch: "main",
      conclusion: "success",
      correlation: context.correlation,
      headSha: context.workflowSha,
      repository: context.repository,
      runId: fixtureRunId,
    });
  }
  throw new Error("timed out waiting for the failed-job rerun");
}

async function validateMutationAuthority(api, context) {
  validateActorPermission(
    await api.request("GET", `/collaborators/${encodeURIComponent(context.actor)}/permission`),
    context.actor,
  );
  validatePullRequest(await api.request("GET", `/pulls/${context.prNumber}`), context);
  validateLandedAncestry(
    await api.request("GET", `/compare/${context.landedSha}...${context.workflowSha}`),
    context,
  );
}

async function validateFixturePrerequisite(api) {
  validateFixtureWorkflow(await api.request("GET", `/actions/workflows/${FIXTURE_WORKFLOW_ID}`));
}

async function validateTrustedMain(api, context) {
  validateMainRef(await api.request("GET", "/git/ref/heads/main"), context.workflowSha);
}

export async function runProofBroker({ api, env, event, sleep = setTimeoutPromise }) {
  const context = validateBrokerRequest(event, env);
  await validateFixturePrerequisite(api);
  await validateMutationAuthority(api, context);
  await validateTrustedMain(api, context);

  await api.request("POST", `/actions/workflows/${FIXTURE_WORKFLOW_ID}/dispatches`, {
    inputs: {
      correlation: context.correlation,
      operation: FIXTURE_OPERATION,
    },
    ref: "main",
  });
  const initialRun = await waitForInitialRun(api, context, sleep);
  const fixtureRunId = requiredPositiveInteger(initialRun.id, "fixture run id");
  await validateMutationAuthority(api, context);
  await api.request("POST", `/actions/runs/${fixtureRunId}/rerun-failed-jobs`);
  await waitForRerun(api, context, fixtureRunId, sleep);
  return {
    actor: context.actor,
    correlation: context.correlation,
    fixtureRunAttempt: 2,
    fixtureRunId,
    landedSha: context.landedSha,
    operation: FIXTURE_OPERATION,
    prNumber: context.prNumber,
    repository: context.repository,
    sourceRef: "refs/heads/main",
    workflowSha: context.workflowSha,
  };
}

function setTimeoutPromise(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function createGitHubApi({ repository, token, fetchImpl = fetch }) {
  if (repository !== REPOSITORY) {
    throw new Error(`FRV proof broker requires repository ${REPOSITORY}`);
  }
  const baseUrl = `https://api.github.com/repos/${repository}`;
  return {
    async request(method, path, body) {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        method,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${detail}`);
      }
      if (response.status === 204) {
        return null;
      }
      return response.json();
    },
  };
}

async function main() {
  const eventPath = requiredEnv(process.env, "GITHUB_EVENT_PATH");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const token = requiredEnv(process.env, "GH_TOKEN");
  const api = createGitHubApi({ repository: REPOSITORY, token });
  const receipt = await runProofBroker({ api, env: process.env, event });
  const receiptPath = requiredEnv(process.env, "FRV_PROOF_RECEIPT");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `receipt_path=${receiptPath}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## FRV failed-job rerun proof",
        "",
        `- Pull request: #${receipt.prNumber}`,
        `- Landed controller: \`${receipt.landedSha}\``,
        `- Trusted broker SHA: \`${receipt.workflowSha}\``,
        `- Fixture run: \`${receipt.fixtureRunId}\`, attempt \`2\``,
        "- Fixed operation: `noop`",
        "- Fixture source: trusted `main` at the broker workflow SHA",
        "",
      ].join("\n"),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
