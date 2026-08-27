#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";

const REPOSITORY = "openclaw/openclaw";
const ORGANIZATION = "openclaw";
const WORKFLOW = ".github/workflows/pr-crabbox-gate-publisher.yml";
const BOOTSTRAP_PATH = "scripts/crabbox-untrusted-bootstrap.sh";
const CHECK_NAME = "openclaw/crabbox-gate";
const CHECK_APP_ID = 15368;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^run_[a-z0-9]+$/u;
const LEASE_ID_PATTERN = /^cbx_[a-z0-9]+$/u;
const MAX_PROOF_AGE_MS = 2 * 60 * 60 * 1000;
const EXPECTED_MARKERS = [
  "OPENCLAW_CRABBOX_GATE_VERSION=1",
  "OPENCLAW_CRABBOX_GATE_MODE=remote_crabbox_aws",
  "OPENCLAW_CRABBOX_GATE_STAGE=build:ok",
  "OPENCLAW_CRABBOX_GATE_STAGE=check:ok",
  "OPENCLAW_CRABBOX_GATE_STAGE=test:ok",
  "OPENCLAW_CRABBOX_GATE_RESULT=success",
];

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

function record(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const input = record(value, label);
  const actual = Object.keys(input).toSorted((a, b) => a.localeCompare(b));
  const wanted = [...expected].toSorted((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
  return input;
}

function requiredEnv(env, name) {
  return requiredString(env[name], name);
}

export function buildCrabboxGateCommand(headSha, bootstrapSha256) {
  return [
    "set -euo pipefail",
    "umask 022",
    `printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_VERSION=1' 'OPENCLAW_CRABBOX_GATE_MODE=remote_crabbox_aws' 'OPENCLAW_CRABBOX_GATE_HEAD=${headSha}' 'OPENCLAW_CRABBOX_BOOTSTRAP_SHA256=${bootstrapSha256}'`,
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=build:start'",
    "pnpm build",
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=build:ok' 'OPENCLAW_CRABBOX_GATE_STAGE=check:start'",
    "pnpm check",
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=check:ok' 'OPENCLAW_CRABBOX_GATE_STAGE=test:start'",
    "CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test",
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=test:ok' 'OPENCLAW_CRABBOX_GATE_RESULT=success'",
  ].join("; ");
}

export function validatePublisherRequest(event, env) {
  if (requiredEnv(env, "GITHUB_REPOSITORY") !== REPOSITORY) {
    throw new Error(`Crabbox gate publisher requires repository ${REPOSITORY}`);
  }
  if (requiredEnv(env, "GITHUB_EVENT_NAME") !== "workflow_dispatch") {
    throw new Error("Crabbox gate publisher requires workflow_dispatch");
  }
  if (requiredEnv(env, "GITHUB_REF") !== "refs/heads/main") {
    throw new Error("Crabbox gate publisher must run from refs/heads/main");
  }
  const workflowSha = requiredEnv(env, "GITHUB_WORKFLOW_SHA");
  if (!SHA_PATTERN.test(workflowSha) || workflowSha !== requiredEnv(env, "GITHUB_SHA")) {
    throw new Error("Crabbox gate publisher requires one exact trusted workflow SHA");
  }
  const expectedWorkflowRef = `${REPOSITORY}/${WORKFLOW}@refs/heads/main`;
  if (requiredEnv(env, "GITHUB_WORKFLOW_REF") !== expectedWorkflowRef) {
    throw new Error(`Crabbox gate publisher requires ${expectedWorkflowRef}`);
  }
  const actor = requiredEnv(env, "GITHUB_ACTOR");
  if (actor !== requiredEnv(env, "GITHUB_TRIGGERING_ACTOR")) {
    throw new Error("Crabbox gate publisher actor must match the triggering actor");
  }
  const inputs = assertExactKeys(
    record(event, "workflow event").inputs,
    ["bootstrap_sha256", "crabbox_lease_id", "crabbox_run_id", "head_sha", "pr_number"],
    "workflow inputs",
  );
  const context = {
    actor,
    bootstrapSha256: requiredString(inputs.bootstrap_sha256, "bootstrap_sha256"),
    headSha: requiredString(inputs.head_sha, "head_sha"),
    leaseId: requiredString(inputs.crabbox_lease_id, "crabbox_lease_id"),
    prNumber: requiredPositiveInteger(inputs.pr_number, "pr_number"),
    repository: REPOSITORY,
    runId: requiredString(inputs.crabbox_run_id, "crabbox_run_id"),
    workflowSha,
  };
  if (!SHA_PATTERN.test(context.headSha)) {
    throw new Error("head_sha must be exactly 40 lowercase hex characters");
  }
  if (!SHA256_PATTERN.test(context.bootstrapSha256)) {
    throw new Error("bootstrap_sha256 must be exactly 64 lowercase hex characters");
  }
  if (!RUN_ID_PATTERN.test(context.runId) || !LEASE_ID_PATTERN.test(context.leaseId)) {
    throw new Error("Crabbox run or lease id is malformed");
  }
  return context;
}

function validatePullRequest(value, context) {
  const pull = record(value, "pull request");
  const head = record(pull.head, "pull request.head");
  const base = record(pull.base, "pull request.base");
  if (pull.number !== context.prNumber || pull.state !== "open") {
    throw new Error("gate target must be the requested open pull request");
  }
  if (
    head.sha !== context.headSha ||
    record(head.repo, "pull request.head.repo").full_name !== REPOSITORY
  ) {
    throw new Error("pull request exact head or head repository does not match");
  }
  if (base.ref !== "main" || record(base.repo, "pull request.base.repo").full_name !== REPOSITORY) {
    throw new Error("pull request base must be openclaw/openclaw main");
  }
}

function validateActiveAdminMembership(value, actor) {
  const membership = record(value, "organization membership");
  if (
    membership.state !== "active" ||
    membership.role !== "admin" ||
    record(membership.user, "organization membership.user").login !== actor
  ) {
    throw new Error(`actor ${actor} is not an active ${ORGANIZATION} organization admin`);
  }
}

function validateTrustedMain(value, workflowSha) {
  const ref = record(value, "main ref");
  if (ref.ref !== "refs/heads/main" || record(ref.object, "main ref.object").sha !== workflowSha) {
    throw new Error("trusted main moved before Crabbox proof publication");
  }
}

function parseTime(value, label) {
  const timestamp = Date.parse(requiredString(value, label));
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

export function validateBrokerProof({ bootstrapSha256, context, events, log, now, run, userId }) {
  const proof = record(run, "Crabbox run");
  const expectedCommand = [
    "--script",
    ".local/crabbox-untrusted-bootstrap.sh",
    context.headSha,
    "/bin/bash",
    "-lc",
    buildCrabboxGateCommand(context.headSha, bootstrapSha256),
  ];
  const leaseIds = new Set([
    proof.leaseID,
    ...(Array.isArray(proof.leaseIDs) ? proof.leaseIDs : []),
  ]);
  if (
    proof.id !== context.runId ||
    proof.owner !== `github:${userId}` ||
    proof.org !== ORGANIZATION ||
    proof.provider !== "aws" ||
    proof.target !== "linux" ||
    proof.state !== "succeeded" ||
    proof.phase !== "released" ||
    proof.exitCode !== 0 ||
    proof.logTruncated !== false ||
    !leaseIds.has(context.leaseId)
  ) {
    throw new Error(
      "Crabbox run identity, ownership, provider, lifecycle, or result does not match",
    );
  }
  if (proof.label !== `openclaw-pr-gate:${context.prNumber}:${context.headSha}`) {
    throw new Error("Crabbox run label does not bind the requested PR and exact head");
  }
  if (
    !Array.isArray(proof.command) ||
    JSON.stringify(proof.command) !== JSON.stringify(expectedCommand)
  ) {
    throw new Error("Crabbox run command does not match the canonical exact-head gate");
  }
  const startedAt = parseTime(proof.startedAt, "Crabbox run startedAt");
  const endedAt = parseTime(proof.endedAt, "Crabbox run endedAt");
  if (startedAt > endedAt || endedAt > now || now - endedAt > MAX_PROOF_AGE_MS) {
    throw new Error("Crabbox run is not a fresh completed proof");
  }
  if (!Array.isArray(events) || events.length === 0 || proof.eventCount !== events.length) {
    throw new Error("Crabbox events are missing or incomplete");
  }
  const expectedUpload = `.crabbox/scripts/${bootstrapSha256.slice(0, 12)}-crabbox-untrusted-bootstrap.sh`;
  const eventTypes = [];
  for (const [index, value] of events.entries()) {
    const event = record(value, `Crabbox event ${index + 1}`);
    const eventType = requiredString(event.type, `Crabbox event ${index + 1} type`);
    if (event.runID !== context.runId || event.seq !== index + 1) {
      throw new Error("Crabbox event sequence or run identity does not match");
    }
    eventTypes.push(eventType);
    if (eventType === "run.failed" || eventType.endsWith(".failed")) {
      throw new Error(`Crabbox proof contains failed event ${eventType}`);
    }
    if (eventType === "script.uploaded" && event.message !== expectedUpload) {
      throw new Error("Crabbox uploaded bootstrap hash does not match trusted main");
    }
    if (eventType === "lease.created") {
      if (
        event.leaseID !== context.leaseId ||
        event.provider !== "aws" ||
        event.target !== "linux"
      ) {
        throw new Error("Crabbox lease event does not match AWS/Linux proof");
      }
    }
    if (eventType === "command.finished" && event.exitCode !== 0) {
      throw new Error("Crabbox command event did not finish successfully");
    }
  }
  const requiredOrder = [
    "run.started",
    "lease.created",
    "script.uploaded",
    "command.started",
    "command.finished",
    "lease.released",
  ];
  let priorIndex = -1;
  for (const type of requiredOrder) {
    const index = eventTypes.indexOf(type);
    if (index < 0) {
      throw new Error(`Crabbox proof is missing ${type}`);
    }
    if (index <= priorIndex) {
      throw new Error(`Crabbox proof event order is invalid at ${type}`);
    }
    priorIndex = index;
  }
  if (typeof log !== "string") {
    throw new Error("Crabbox retained log must be a string");
  }
  if (log.length > 0) {
    for (const marker of [
      ...EXPECTED_MARKERS,
      `OPENCLAW_CRABBOX_GATE_HEAD=${context.headSha}`,
      `OPENCLAW_CRABBOX_BOOTSTRAP_SHA256=${bootstrapSha256}`,
    ]) {
      if (log.split(marker).length !== 2) {
        throw new Error(`Crabbox retained log must contain exactly one ${marker} marker`);
      }
    }
  }
}

function bootstrapHash(path = BOOTSTRAP_PATH) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function runPublisher({ broker, event, github, organization, env, now = Date.now() }) {
  const context = validatePublisherRequest(event, env);
  const localBootstrapHash = bootstrapHash();
  if (localBootstrapHash !== context.bootstrapSha256) {
    throw new Error("requested bootstrap hash does not match trusted main");
  }
  validateActiveAdminMembership(
    await organization.request(
      "GET",
      `/orgs/${ORGANIZATION}/memberships/${encodeURIComponent(context.actor)}`,
    ),
    context.actor,
  );
  validatePullRequest(
    await github.request("GET", `/repos/${REPOSITORY}/pulls/${context.prNumber}`),
    context,
  );
  validateTrustedMain(
    await github.request("GET", `/repos/${REPOSITORY}/git/ref/heads/main`),
    context.workflowSha,
  );
  const user = record(
    await github.request("GET", `/users/${encodeURIComponent(context.actor)}`),
    "GitHub actor",
  );
  const userId = requiredPositiveInteger(user.id, "GitHub actor id");
  const runResponse = record(
    await broker.request(`/v1/runs/${context.runId}`),
    "Crabbox run response",
  );
  const eventsResponse = record(
    await broker.request(`/v1/runs/${context.runId}/events?limit=500`),
    "Crabbox events response",
  );
  validateBrokerProof({
    bootstrapSha256: localBootstrapHash,
    context,
    events: eventsResponse.events,
    log: await broker.request(`/v1/runs/${context.runId}/logs`, { text: true }),
    now,
    run: runResponse.run,
    userId,
  });
  validatePullRequest(
    await github.request("GET", `/repos/${REPOSITORY}/pulls/${context.prNumber}`),
    context,
  );
  validateActiveAdminMembership(
    await organization.request(
      "GET",
      `/orgs/${ORGANIZATION}/memberships/${encodeURIComponent(context.actor)}`,
    ),
    context.actor,
  );
  validateTrustedMain(
    await github.request("GET", `/repos/${REPOSITORY}/git/ref/heads/main`),
    context.workflowSha,
  );
  const check = record(
    await github.request("POST", `/repos/${REPOSITORY}/check-runs`, {
      conclusion: "success",
      details_url: `${requiredEnv(env, "GITHUB_SERVER_URL")}/${REPOSITORY}/actions/runs/${requiredEnv(env, "GITHUB_RUN_ID")}`,
      head_sha: context.headSha,
      name: CHECK_NAME,
      output: {
        summary: `Trusted Crabbox AWS proof ${context.runId} / ${context.leaseId}; build, check, and full test passed on exact head ${context.headSha}.`,
        title: "Crabbox AWS exact-head gate passed",
      },
      status: "completed",
    }),
    "published check run",
  );
  if (
    check.name !== CHECK_NAME ||
    check.head_sha !== context.headSha ||
    check.conclusion !== "success" ||
    record(check.app, "published check run.app").id !== CHECK_APP_ID
  ) {
    throw new Error(
      "published check run identity or GitHub Actions app integration does not match",
    );
  }
  return { checkId: requiredPositiveInteger(check.id, "published check ID"), context };
}

export function createJsonApi({
  accessClientId,
  accessClientSecret,
  baseUrl,
  token,
  fetchImpl = fetch,
}) {
  const base = new URL(baseUrl);
  requiredString(accessClientId, "Crabbox Access client id");
  requiredString(accessClientSecret, "Crabbox Access client secret");
  requiredString(token, "Crabbox coordinator token");
  return {
    async request(path, options = {}) {
      const response = await fetchImpl(new URL(path, base), {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Access-Client-Id": accessClientId,
          "CF-Access-Client-Secret": accessClientSecret,
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          `API GET ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
      }
      return options.text ? response.text() : response.json();
    },
  };
}

export function createGitHubApi({ token, fetchImpl = fetch }) {
  return {
    async request(method, path, body) {
      const response = await fetchImpl(`https://api.github.com${path}`, {
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
        throw new Error(
          `GitHub API ${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
      }
      return response.status === 204 ? null : response.json();
    },
  };
}

async function main() {
  const event = JSON.parse(readFileSync(requiredEnv(process.env, "GITHUB_EVENT_PATH"), "utf8"));
  const brokerUrl = requiredEnv(process.env, "CRABBOX_COORDINATOR");
  const broker = createJsonApi({
    accessClientId: requiredEnv(process.env, "CRABBOX_ACCESS_CLIENT_ID"),
    accessClientSecret: requiredEnv(process.env, "CRABBOX_ACCESS_CLIENT_SECRET"),
    baseUrl: brokerUrl.endsWith("/") ? brokerUrl : `${brokerUrl}/`,
    token: requiredEnv(process.env, "CRABBOX_COORDINATOR_TOKEN"),
  });
  const github = createGitHubApi({ token: requiredEnv(process.env, "GH_TOKEN") });
  const organization = createGitHubApi({
    token: requiredEnv(process.env, "GH_APP_TOKEN"),
  });
  const result = await runPublisher({ broker, env: process.env, event, github, organization });
  console.log(`published_check_id=${result.checkId}`);
  console.log(`published_head_sha=${result.context.headSha}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    if (process.argv[2] === "--print-command") {
      const headSha = requiredString(process.argv[3], "head SHA");
      const bootstrapSha256 = requiredString(process.argv[4], "bootstrap SHA-256");
      if (!SHA_PATTERN.test(headSha) || !SHA256_PATTERN.test(bootstrapSha256)) {
        throw new Error("print-command requires an exact head SHA and bootstrap SHA-256");
      }
      console.log(buildCrabboxGateCommand(headSha, bootstrapSha256));
    } else {
      await main();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
