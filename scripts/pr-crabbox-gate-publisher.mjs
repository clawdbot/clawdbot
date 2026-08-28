#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";
import {
  buildCrabboxGateCommand,
  crabboxGatePlanDigest,
  CRABBOX_GATE_CHECK_NAME,
  formatCrabboxGateCheckSummary,
  validateCrabboxGatePlan,
} from "./pr-lib/crabbox-gate-contract.mjs";
import { resolveCrabboxGatePlan } from "./pr-lib/crabbox-gate-plan.mts";

const REPOSITORY = "openclaw/openclaw";
const ORGANIZATION = "openclaw";
const WORKFLOW = ".github/workflows/pr-crabbox-gate-publisher.yml";
const BOOTSTRAP_PATH = "scripts/crabbox-untrusted-bootstrap.sh";
const CHECK_NAME = CRABBOX_GATE_CHECK_NAME;
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

export { buildCrabboxGateCommand };

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
    ["base_sha", "bootstrap_sha256", "crabbox_lease_id", "crabbox_run_id", "head_sha", "pr_number"],
    "workflow inputs",
  );
  const context = {
    actor,
    baseSha: requiredString(inputs.base_sha, "base_sha"),
    bootstrapSha256: requiredString(inputs.bootstrap_sha256, "bootstrap_sha256"),
    headSha: requiredString(inputs.head_sha, "head_sha"),
    leaseId: requiredString(inputs.crabbox_lease_id, "crabbox_lease_id"),
    prNumber: requiredPositiveInteger(inputs.pr_number, "pr_number"),
    repository: REPOSITORY,
    runId: requiredString(inputs.crabbox_run_id, "crabbox_run_id"),
    workflowSha,
  };
  if (!SHA_PATTERN.test(context.baseSha) || !SHA_PATTERN.test(context.headSha)) {
    throw new Error("base_sha and head_sha must be exactly 40 lowercase hex characters");
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
    base.sha !== context.baseSha ||
    head.sha !== context.headSha ||
    record(head.repo, "pull request.head.repo").full_name !== REPOSITORY
  ) {
    throw new Error("pull request exact base, head, or head repository does not match");
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

function validateBaseAncestry(value, context) {
  const comparison = record(value, "base ancestry comparison");
  const baseCommit = record(comparison.base_commit, "base ancestry comparison.base_commit");
  const mergeBase = record(
    comparison.merge_base_commit,
    "base ancestry comparison.merge_base_commit",
  );
  const identical = comparison.status === "identical";
  if (
    baseCommit.sha !== context.baseSha ||
    mergeBase.sha !== context.baseSha ||
    comparison.behind_by !== 0 ||
    (identical
      ? context.baseSha !== context.workflowSha || comparison.ahead_by !== 0
      : comparison.status !== "ahead" ||
        context.baseSha === context.workflowSha ||
        !Number.isSafeInteger(comparison.ahead_by) ||
        comparison.ahead_by < 1)
  ) {
    throw new Error("pull request base is not an ancestor of the trusted publisher workflow SHA");
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
  const plan = validateCrabboxGatePlan(context.plan);
  if (plan.baseSha !== context.baseSha || plan.headSha !== context.headSha) {
    throw new Error("Crabbox run plan does not bind the requested base and head");
  }
  const expectedCommand = [
    "--script",
    ".local/crabbox-untrusted-bootstrap.sh",
    context.headSha,
    "/bin/bash",
    "-lc",
    buildCrabboxGateCommand(plan, bootstrapSha256),
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
  if (
    proof.label !== `openclaw-pr-gate:${context.prNumber}:${context.baseSha}:${context.headSha}`
  ) {
    throw new Error("Crabbox run label does not bind the requested PR, base, and exact head");
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
      `OPENCLAW_CRABBOX_GATE_BASE=${context.baseSha}`,
      `OPENCLAW_CRABBOX_GATE_HEAD=${context.headSha}`,
      `OPENCLAW_CRABBOX_GATE_PLAN_SHA256=${crabboxGatePlanDigest(plan)}`,
      `OPENCLAW_CRABBOX_GATE_TARGET_COUNT=${plan.targets.length}`,
      `OPENCLAW_CRABBOX_BOOTSTRAP_SHA256=${bootstrapSha256}`,
    ]) {
      if (log.split(marker).length !== 2) {
        throw new Error(`Crabbox retained log must contain exactly one ${marker} marker`);
      }
    }
  }
}

function bootstrapHash(bootstrapPath = BOOTSTRAP_PATH) {
  return createHash("sha256").update(readFileSync(bootstrapPath)).digest("hex");
}

function resolvePlanInDetachedWorktree(context) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-gate-plan-"));
  const worktree = path.join(tempRoot, "head");
  try {
    execFileSync("git", ["fetch", "--no-tags", "origin", context.headSha], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync("git", ["worktree", "add", "--detach", worktree, context.headSha], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return resolveCrabboxGatePlan({
      baseSha: context.baseSha,
      cwd: worktree,
      headSha: context.headSha,
    });
  } finally {
    try {
      if (existsSync(worktree)) {
        execFileSync("git", ["worktree", "remove", "--force", worktree], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  }
}

/** @type {(context: Parameters<typeof resolvePlanInDetachedWorktree>[0]) => ReturnType<typeof resolvePlanInDetachedWorktree> | Promise<ReturnType<typeof resolvePlanInDetachedWorktree>>} */
const defaultResolvePlan = resolvePlanInDetachedWorktree;

export async function runPublisher({
  broker,
  event,
  github,
  organization,
  env,
  now = Date.now(),
  resolvePlan = defaultResolvePlan,
}) {
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
  validateBaseAncestry(
    await github.request(
      "GET",
      `/repos/${REPOSITORY}/compare/${context.baseSha}...${context.workflowSha}`,
    ),
    context,
  );
  context.plan = await Promise.resolve(resolvePlan(context));
  if (context.plan.baseSha !== context.baseSha || context.plan.headSha !== context.headSha) {
    throw new Error("Crabbox gate plan does not bind the requested base and head");
  }
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
        summary: formatCrabboxGateCheckSummary({
          baseSha: context.baseSha,
          headSha: context.headSha,
          leaseId: context.leaseId,
          planDigest: crabboxGatePlanDigest(context.plan),
          runId: context.runId,
          targetCount: context.plan.targets.length,
          workflowSha: context.workflowSha,
        }),
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
  accessClientId = "",
  accessClientSecret = "",
  baseUrl,
  token,
  fetchImpl = fetch,
}) {
  const base = new URL(requiredString(baseUrl, "Crabbox coordinator URL"));
  const hasAccess = Boolean(accessClientId);
  if (hasAccess !== Boolean(accessClientSecret)) {
    throw new Error("Crabbox Access client id and secret must be provided together");
  }
  const headers = {
    Authorization: `Bearer ${requiredString(token, "Crabbox coordinator token")}`,
    ...(hasAccess
      ? {
          "CF-Access-Client-Id": accessClientId,
          "CF-Access-Client-Secret": accessClientSecret,
        }
      : {}),
  };
  return {
    async request(requestPath, options = {}) {
      const response = await fetchImpl(new URL(requestPath, base), {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          `API GET ${requestPath} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
      }
      return options.text ? response.text() : response.json();
    },
  };
}

export function createGitHubApi({ token, fetchImpl = fetch }) {
  return {
    async request(method, requestPath, body) {
      const response = await fetchImpl(`https://api.github.com${requestPath}`, {
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
          `GitHub API ${method} ${requestPath} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
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
    accessClientId: process.env.CRABBOX_ACCESS_CLIENT_ID,
    accessClientSecret: process.env.CRABBOX_ACCESS_CLIENT_SECRET,
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
      const plan = validateCrabboxGatePlan(
        JSON.parse(readFileSync(requiredString(process.argv[3], "plan path"), "utf8")),
      );
      const bootstrapSha256 = requiredString(process.argv[4], "bootstrap SHA-256");
      console.log(buildCrabboxGateCommand(plan, bootstrapSha256));
    } else {
      await main();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
