#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  classifyReleaseGhTransportError,
  composeReleaseChildAttemptEvidence,
  isReleaseGhArtifactMissingError,
  MAX_RELEASE_ARTIFACT_BYTES,
  releaseChildSpec,
  terminalPolicyPass,
  validateReleaseChildDispatchBinding,
  validateReleaseChildRunProvenance,
  validateReleaseExecutionPlanArtifact,
} from "./full-release-validation-policy.mjs";
import { plainGhAuthenticatedEnv, resolvePlainGhBin } from "./lib/plain-gh.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY = "openclaw/openclaw";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 60_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 60_000;
const PLAN_FILENAME = "full-release-execution-plan.json";

function requiredValue(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function configuredTimeout(name, fallback) {
  return positiveInteger(process.env[name] || fallback, name);
}

function createOperationDeadline() {
  const deadline = Date.now() + configuredTimeout("OPENCLAW_FRV_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(deadline)) {
    throw new Error("FRV operation deadline is invalid");
  }
  return deadline;
}

function validateOperationDeadline(deadline) {
  if (!Number.isSafeInteger(deadline) || deadline < 1) {
    throw new Error("FRV operation deadline must be a positive integer");
  }
  return deadline;
}

function remainingOperationTime(deadline, label = "FRV operation") {
  const remaining = validateOperationDeadline(deadline) - Date.now();
  if (remaining < 1) {
    throw new Error(`${label} timed out`);
  }
  return remaining;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    command,
    dryRun: false,
    failedOnly: false,
    json: false,
    repository: DEFAULT_REPOSITORY,
    runId: "",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--run") {
      options.runId = requiredValue(argv[++index], "--run");
    } else if (argument === "--repo") {
      options.repository = requiredValue(argv[++index], "--repo");
    } else if (argument === "--failed") {
      options.failedOnly = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!["continue", "status", "verify"].includes(command)) {
    throw new Error("usage: pnpm frv <status|continue|verify> --run <id> [--failed]");
  }
  if (!/^[1-9][0-9]*$/u.test(options.runId)) {
    throw new Error("--run must be a positive decimal");
  }
  if (command === "continue" && !options.failedOnly) {
    throw new Error("continue requires --failed");
  }
  if (command !== "continue" && (options.failedOnly || options.dryRun)) {
    throw new Error("--failed and --dry-run are valid only with continue");
  }
  return options;
}

async function execCommand(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 60_000,
  });
  return result.stdout.trim();
}

function execGh(args, options = {}) {
  return execCommand(resolvePlainGhBin(), args, {
    ...options,
    env: plainGhAuthenticatedEnv(),
  });
}

async function sleep(milliseconds) {
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function execGhRead(args, options = {}) {
  const attempts = options.attempts ?? 4;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await execGh(args, options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || classifyReleaseGhTransportError(error) !== "transient") {
        throw error;
      }
      await sleep(Math.min(attempt * 1000, 5000));
    }
  }
  throw lastError;
}

async function ghJson(repository, path) {
  return JSON.parse(await execGhRead(["api", `repos/${repository}/${path}`]));
}

async function ghAttemptJobs(repository, runId, runAttempt) {
  const output = await execGhRead([
    "api",
    "--paginate",
    `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    "--jq",
    ".jobs[] | @json",
  ]);
  return output
    ? output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function downloadExecutionPlan(repository, runId) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-frv-plan-"));
  try {
    try {
      await execGhRead([
        "run",
        "download",
        runId,
        "--repo",
        repository,
        "--name",
        `full-release-execution-plan-${runId}`,
        "--dir",
        directory,
      ]);
    } catch (error) {
      if (isReleaseGhArtifactMissingError(error)) {
        return undefined;
      }
      throw error;
    }
    const path = join(directory, PLAN_FILENAME);
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size < 1 || size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error("immutable execution plan artifact is missing or oversized");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function selectedChildren(plan) {
  return plan.children.filter((child) => child.selected);
}

function assertChildRunIdentity(child, run, repository = DEFAULT_REPOSITORY) {
  return validateReleaseChildRunProvenance(run, {
    ...child,
    plannedRunAttempt: child.runAttempt,
    repository,
  });
}

function exactParentJob(parentJobs, child, sourceParentAttempt) {
  const spec = releaseChildSpec(child.key);
  const matches = parentJobs.filter(
    (job) =>
      job.name === spec.parentJobName && Number(job.run_attempt) === Number(sourceParentAttempt),
  );
  if (
    matches.length !== 1 ||
    matches[0].status !== "completed" ||
    !["success", "failure"].includes(String(matches[0].conclusion))
  ) {
    throw new Error(`source parent dispatch job is missing or ambiguous: ${child.key}`);
  }
  return matches[0];
}

export async function preflightContinuation(
  plan,
  rootRunId,
  client,
  repository = DEFAULT_REPOSITORY,
) {
  if (plan.rerunGroup !== "all") {
    throw new Error("FRV continuation requires an all-group root");
  }
  const source = {
    sourceDisplayTitle: "Full Release Validation",
    sourceEvent: "workflow_dispatch",
    sourceRepository: repository,
    sourceRunAttempt: plan.parentRunAttempt,
    sourceRunId: String(rootRunId),
    sourceWorkflowPath: ".github/workflows/full-release-validation.yml",
    sourceWorkflowRef: plan.workflowRef,
    sourceWorkflowSha: plan.workflowSha,
  };
  const sourceRun = await client.getRunAttempt(source.sourceRunId, source.sourceRunAttempt);
  if (
    String(sourceRun.id) !== source.sourceRunId ||
    Number(sourceRun.run_attempt) !== source.sourceRunAttempt ||
    sourceRun.display_title !== source.sourceDisplayTitle ||
    sourceRun.event !== source.sourceEvent ||
    String(sourceRun.path ?? "").split("@", 1)[0] !== source.sourceWorkflowPath ||
    sourceRun.head_branch !== source.sourceWorkflowRef ||
    sourceRun.head_sha !== source.sourceWorkflowSha ||
    sourceRun.repository?.full_name !== source.sourceRepository
  ) {
    throw new Error("source full release parent identity changed");
  }
  const parentJobs = await client.getParentJobs(source.sourceRunId);
  const resolveJobs = parentJobs.filter(
    (job) =>
      job.name === "Resolve target ref" &&
      Number(job.run_attempt) === Number(source.sourceRunAttempt),
  );
  if (resolveJobs.length !== 1 || resolveJobs[0].status !== "completed") {
    throw new Error("source full release input job is missing or ambiguous");
  }
  const resolveLog = await client.getJobLog(resolveJobs[0].id);
  if (
    !String(resolveLog).includes("RERUN_GROUP: all") ||
    !String(resolveLog).includes("FAIL_FAST: false") ||
    !String(resolveLog).includes(`TARGET_SHA: ${plan.targetSha}`)
  ) {
    throw new Error("source full release root is not an exact fail-fast-disabled all-group target");
  }
  const childObservations = await Promise.all(
    selectedChildren(plan).map(async (child) => {
      const sourceParentAttempt = child.sourceParentAttempt ?? source.sourceRunAttempt;
      const parentJob = exactParentJob(parentJobs, child, sourceParentAttempt);
      const [childRun, parentLog] = await Promise.all([
        client.getRunAttempt(child.runId, child.runAttempt),
        client.getJobLog(parentJob.id),
      ]);
      return { child, childRun, parentLog };
    }),
  );
  for (const { child, parentLog } of childObservations) {
    validateReleaseChildDispatchBinding({
      child,
      log: parentLog,
      plannedRunAttempt: child.runAttempt,
      repository,
      targetSha: plan.targetSha,
    });
  }
  for (const { child, childRun } of childObservations) {
    assertChildRunIdentity(child, childRun, repository);
  }
  return sourceRun;
}

export async function inspectContinuation(plan, client) {
  const children = await Promise.all(
    selectedChildren(plan).map(async (child) => {
      const run = await client.getRun(child.runId);
      assertChildRunIdentity(child, run, client.repository ?? DEFAULT_REPOSITORY);
      const effectiveRunAttempt = positiveInteger(run.run_attempt, `${child.key} run attempt`);
      const attempts = await Promise.all(
        Array.from({ length: effectiveRunAttempt - child.runAttempt + 1 }, async (_, index) => {
          const runAttempt = child.runAttempt + index;
          return {
            jobs: await client.getAttemptJobs(child.runId, runAttempt),
            runAttempt,
          };
        }),
      );
      if (run.status !== "completed" && attempts.at(-1)?.jobs.length === 0) {
        if (attempts.slice(0, -1).some((attempt) => attempt.jobs.length === 0)) {
          throw new Error(`child attempt evidence is gapped: ${child.key}`);
        }
        return {
          compositeJobsSha256: "",
          conclusion: String(run.conclusion ?? ""),
          effectiveRunAttempt,
          key: child.key,
          passed: false,
          plannedRunAttempt: child.runAttempt,
          runId: child.runId,
          status: "active",
          url: String(run.html_url ?? child.url ?? ""),
        };
      }
      const evidence = composeReleaseChildAttemptEvidence({
        attempts,
        expected: {
          ...child,
          plannedRunAttempt: child.runAttempt,
          repository: client.repository ?? DEFAULT_REPOSITORY,
        },
        run,
      });
      const active = run.status !== "completed";
      const passed =
        !active &&
        terminalPolicyPass(
          {
            conclusion: run.conclusion,
            jobs: evidence.jobs,
            key: child.key,
            status: run.status,
          },
          plan.releaseProfile,
          child.workflowRef,
        );
      return {
        compositeJobsSha256: evidence.compositeJobsSha256,
        conclusion: String(run.conclusion ?? ""),
        dispatchActor: evidence.dispatchActor,
        effectiveRunAttempt,
        key: child.key,
        passed,
        plannedRunAttempt: child.runAttempt,
        repository: evidence.repository,
        runId: child.runId,
        status: active ? "active" : passed ? "passed" : "failed",
        triggeringActor: evidence.triggeringActor,
        url: String(run.html_url ?? child.url ?? ""),
      };
    }),
  );
  return {
    children,
    failed: children.filter((child) => child.status === "failed"),
    active: children.filter((child) => child.status === "active"),
    passed: children.filter((child) => child.status === "passed"),
  };
}

export function createClient(repository, dependencies = {}) {
  const apiJson = dependencies.apiJson ?? ((path) => ghJson(repository, path));
  const apiText =
    dependencies.apiText ??
    ((path, jq) =>
      execGhRead(
        jq
          ? ["api", "--paginate", `repos/${repository}/${path}`, "--jq", jq]
          : ["api", `repos/${repository}/${path}`],
      ));
  const mutate = dependencies.mutate ?? ((args) => execGh(args));
  const execute = dependencies.execCommand ?? execCommand;
  const attemptJobs =
    dependencies.getAttemptJobs ??
    ((runId, runAttempt) => ghAttemptJobs(repository, runId, runAttempt));
  const client = {
    repository,
    getAttemptJobs(runId, runAttempt) {
      return attemptJobs(runId, runAttempt);
    },
    getRun(runId) {
      return apiJson(`actions/runs/${runId}`);
    },
    getRunAttempt(runId, runAttempt) {
      return apiJson(`actions/runs/${runId}/attempts/${runAttempt}`);
    },
    async getParentJobs(runId) {
      const output = await apiText(
        `actions/runs/${runId}/jobs?filter=all&per_page=100`,
        ".jobs[] | @json",
      );
      return output
        ? output
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    },
    getJobLog(jobId) {
      return apiText(`actions/jobs/${jobId}/logs`);
    },
    async rerunFailed(runId) {
      await mutate(["run", "rerun", runId, "--repo", repository, "--failed"]);
    },
    async rerunParent(runId) {
      await mutate(["run", "rerun", runId, "--repo", repository]);
      return runId;
    },
    async verify(runId, plan, operationDeadline = createOperationDeadline()) {
      const sourceSha = plan.trustedWorkflow?.sha;
      return execute(
        process.execPath,
        [
          "scripts/release-ci-summary.mjs",
          "--validate-run",
          runId,
          "--repo",
          repository,
          "--trusted-workflow-ref",
          plan.trustedWorkflow?.ref ?? "main",
          "--trusted-workflow-full-ref",
          plan.trustedWorkflow?.fullRef ?? "refs/heads/main",
          "--trusted-workflow-sha",
          sourceSha,
          "--verifier-source-sha",
          sourceSha,
          "--verifier-source-file",
          "scripts/release-ci-summary.mjs",
          "--json",
        ],
        {
          timeoutMs: remainingOperationTime(operationDeadline, "FRV verification"),
        },
      );
    },
  };
  return client;
}

async function waitForTerminal(runIds, client, operationDeadline, minimumAttempts = new Map()) {
  validateOperationDeadline(operationDeadline);
  const pollMs = configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS);
  while (Date.now() < operationDeadline) {
    const runs = await Promise.all(runIds.map((runId) => client.getRun(runId)));
    const ready = runs.every(
      (run) =>
        run.status === "completed" &&
        Number(run.run_attempt) >= Number(minimumAttempts.get(String(run.id)) ?? 1),
    );
    if (ready) {
      return runs;
    }
    await sleep(Math.min(pollMs, remainingOperationTime(operationDeadline)));
  }
  throw new Error(`timed out waiting for runs: ${runIds.join(", ")}`);
}

async function reconcileAttemptStarts(minimumAttempts, client, mutationResults, operationDeadline) {
  validateOperationDeadline(operationDeadline);
  const reconcileStartedAt = Date.now();
  const reconcileTimeoutMs = configuredTimeout(
    "OPENCLAW_FRV_RECONCILE_TIMEOUT_MS",
    DEFAULT_RECONCILE_TIMEOUT_MS,
  );
  const pending = new Set(minimumAttempts.keys());
  while (
    pending.size > 0 &&
    Date.now() < operationDeadline &&
    Date.now() - reconcileStartedAt < reconcileTimeoutMs
  ) {
    const runs = await Promise.all([...pending].map((runId) => client.getRun(runId)));
    for (const run of runs) {
      const runId = String(run.id);
      if (Number(run.run_attempt) >= minimumAttempts.get(runId)) {
        pending.delete(runId);
      }
    }
    if (pending.size > 0) {
      const remainingReconcileTime = reconcileTimeoutMs - (Date.now() - reconcileStartedAt);
      if (remainingReconcileTime < 1) {
        break;
      }
      await sleep(
        Math.min(
          configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS),
          remainingOperationTime(operationDeadline),
          remainingReconcileTime,
        ),
      );
    }
  }
  remainingOperationTime(operationDeadline);
  if (pending.size > 0) {
    const failures = mutationResults
      .map((result, index) =>
        result.status === "rejected"
          ? `${[...minimumAttempts.keys()][index]}: ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`
          : "",
      )
      .filter(Boolean);
    throw new Error(
      `rerun mutation did not produce an observable newer attempt for ${[...pending].join(
        ", ",
      )}${failures.length > 0 ? ` (${failures.join("; ")})` : ""}`,
    );
  }
}

function exactTerminalRunState(run, runId) {
  const state = {
    displayTitle: String(run.display_title ?? ""),
    conclusion: run.conclusion ?? null,
    event: String(run.event ?? ""),
    headBranch: String(run.head_branch ?? ""),
    headSha: String(run.head_sha ?? ""),
    id: String(run.id),
    path: String(run.path ?? ""),
    repository: String(run.repository?.full_name ?? run.repository ?? ""),
    runAttempt: positiveInteger(run.run_attempt, `${runId} run attempt`),
    status: String(run.status ?? ""),
    triggeringActor: String(run.triggering_actor?.login ?? ""),
  };
  if (state.id !== runId || state.status !== "completed") {
    throw new Error(`rerun source ${runId} is no longer the exact terminal run`);
  }
  return state;
}

async function rerunWithTransientRetry(runId, priorRun, mutation, client, operationDeadline) {
  const prior = exactTerminalRunState(priorRun, runId);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    remainingOperationTime(operationDeadline);
    try {
      await mutation(runId);
      return;
    } catch (error) {
      if (classifyReleaseGhTransportError(error) !== "transient") {
        throw error;
      }
      const observedRun = await client.getRun(runId);
      const observedAttempt = positiveInteger(observedRun.run_attempt, `${runId} run attempt`);
      if (observedAttempt > prior.runAttempt) {
        return;
      }
      const observed = exactTerminalRunState(observedRun, runId);
      if (JSON.stringify(observed) !== JSON.stringify(prior)) {
        throw new Error(`rerun source ${runId} changed after a rejected mutation`, {
          cause: error,
        });
      }
      if (attempt === 2) {
        throw error;
      }
    }
  }
}

export async function continueFailed(plan, rootRunId, client, options = {}) {
  const operationDeadline =
    options.operationDeadline === undefined
      ? createOperationDeadline()
      : validateOperationDeadline(options.operationDeadline);
  await preflightContinuation(plan, rootRunId, client, client.repository ?? DEFAULT_REPOSITORY);
  let status = await inspectContinuation(plan, client);
  if (status.active.length > 0) {
    await waitForTerminal(
      status.active.map((child) => child.runId),
      client,
      operationDeadline,
    );
    status = await inspectContinuation(plan, client);
  }
  if (status.failed.length > 0) {
    if (options.dryRun) {
      return { action: "would-rerun", status };
    }
    const priorRuns = new Map(
      await Promise.all(
        status.failed.map(async (child) => {
          const run = await client.getRun(child.runId);
          const terminal = exactTerminalRunState(run, child.runId);
          if (
            terminal.runAttempt !== child.effectiveRunAttempt ||
            terminal.conclusion !== child.conclusion
          ) {
            throw new Error(`failed child ${child.runId} changed before rerun dispatch`);
          }
          return [child.runId, run];
        }),
      ),
    );
    const minimumAttempts = new Map(
      status.failed.map((child) => [child.runId, child.effectiveRunAttempt + 1]),
    );
    const mutationResults = await Promise.allSettled(
      status.failed.map((child) =>
        rerunWithTransientRetry(
          child.runId,
          priorRuns.get(child.runId),
          client.rerunFailed.bind(client),
          client,
          operationDeadline,
        ),
      ),
    );
    await reconcileAttemptStarts(minimumAttempts, client, mutationResults, operationDeadline);
    await waitForTerminal(
      status.failed.map((child) => child.runId),
      client,
      operationDeadline,
      minimumAttempts,
    );
    status = await inspectContinuation(plan, client);
  }
  if (status.active.length > 0 || status.failed.length > 0) {
    throw new Error("failed child reruns did not produce a complete green composite");
  }
  if (options.dryRun) {
    return { action: "would-rerun-parent", status };
  }
  const childEvidenceAdvanced = status.children.some(
    (child) => child.effectiveRunAttempt !== child.plannedRunAttempt,
  );
  const parent = await client.getRun(rootRunId);
  if (parent.status !== "completed") {
    await waitForTerminal([rootRunId], client, operationDeadline);
  }
  const completedParent = await client.getRun(rootRunId);
  let parentReran = false;
  if (completedParent.conclusion !== "success" || childEvidenceAdvanced) {
    const minimumAttempts = new Map([
      [rootRunId, positiveInteger(completedParent.run_attempt, "parent run attempt") + 1],
    ]);
    const mutationResults = await Promise.allSettled([
      rerunWithTransientRetry(
        rootRunId,
        completedParent,
        client.rerunParent.bind(client),
        client,
        operationDeadline,
      ),
    ]);
    await reconcileAttemptStarts(minimumAttempts, client, mutationResults, operationDeadline);
    parentReran = true;
    await waitForTerminal([rootRunId], client, operationDeadline, minimumAttempts);
  }
  const finalParent = await client.getRun(rootRunId);
  if (finalParent.conclusion !== "success") {
    throw new Error(`final parent rerun failed: ${rootRunId}`);
  }
  await client.verify(rootRunId, plan, operationDeadline);
  return {
    action: parentReran ? "reran-parent" : "verified-parent",
    finalRunId: rootRunId,
    status,
  };
}

export async function loadPlan(options, loadExecutionPlan = downloadExecutionPlan) {
  const payload = await loadExecutionPlan(options.repository, options.runId);
  if (!payload) {
    throw new Error("run has no authenticated immutable FRV plan");
  }
  const plan = validateReleaseExecutionPlanArtifact(payload, { parentRunId: options.runId });
  if (plan.attemptEvidenceVersion === undefined) {
    throw new Error("run predates attempt-aware immutable plans; run a fresh all-group FRV");
  }
  if (plan.rerunGroup !== "all") {
    throw new Error("FRV continuation requires an all-group root");
  }
  return plan;
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const child of value.status?.children ?? value.children ?? []) {
    console.log(
      `${child.key}: ${child.status} attempt=${child.effectiveRunAttempt} planned=${child.plannedRunAttempt} run=${child.runId}`,
    );
  }
  if (value.action) {
    console.log(`action: ${value.action}`);
  }
  if (value.finalRunId) {
    console.log(`final run: https://github.com/openclaw/openclaw/actions/runs/${value.finalRunId}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = createClient(options.repository);
  if (options.command === "verify") {
    const plan = await loadPlan(options);
    const evidence = await client.verify(options.runId, plan, createOperationDeadline());
    console.log(evidence);
    return;
  }
  const plan = await loadPlan(options);
  if (options.command === "status") {
    print(await inspectContinuation(plan, client), options.json);
    return;
  }
  print(
    await continueFailed(plan, options.runId, client, {
      dryRun: options.dryRun,
    }),
    options.json,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`[frv] ${error instanceof Error ? error.message : String(error)}`);
    console.error("[frv] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
