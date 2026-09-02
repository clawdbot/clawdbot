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

function verifierEvidenceNeedsRefresh(error) {
  if (!error || typeof error !== "object" || typeof error.stdout !== "string") {
    return false;
  }
  try {
    const failure = JSON.parse(error.stdout);
    return failure?.valid === false && failure.refreshable === true;
  } catch {
    return false;
  }
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

function readFreshGhApi(repository, path, args = []) {
  // Rerun decisions require current attempts and jobs, not a relay's earlier snapshot.
  return execGhRead([
    "api",
    `repos/${repository}/${path}`,
    "-H",
    "Cache-Control: max-age=0",
    ...args,
  ]);
}

async function ghJson(repository, path) {
  return JSON.parse(await readFreshGhApi(repository, path));
}

async function ghAttemptJobs(repository, runId, runAttempt) {
  const output = await readFreshGhApi(
    repository,
    `actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    ["--paginate", "--jq", ".jobs[] | @json"],
  );
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

function hasExactChildRunIdentity(child) {
  return (
    typeof child.runId === "string" &&
    /^[1-9][0-9]*$/u.test(child.runId) &&
    Number.isSafeInteger(child.runAttempt) &&
    child.runAttempt > 0
  );
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
  if (plan.candidate?.producer.runId === String(rootRunId)) {
    throw new Error(
      "parent-owned sealed candidate artifacts do not survive parent reruns; start a fresh all-group FRV",
    );
  }
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
  if (
    parentJobs.some(
      (job) =>
        Number(job.run_attempt) === source.sourceRunAttempt &&
        job.conclusion !== "skipped" &&
        /^(?:Prepare release npm artifacts|Prepare release Docker artifacts) \/ /u.test(
          job.name ?? "",
        ),
    )
  ) {
    throw new Error(
      "parent-owned publication artifacts do not survive parent reruns; start a fresh all-group FRV",
    );
  }
  const missingChildren = selectedChildren(plan)
    .filter((child) => !hasExactChildRunIdentity(child))
    .map((child) => child.key)
    .toSorted();
  if (missingChildren.length > 0) {
    throw new Error(
      `selected FRV children did not record exact run IDs and attempts: ${missingChildren.join(", ")}; start a fresh all-group FRV`,
    );
  }
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
      if (!hasExactChildRunIdentity(child)) {
        return {
          compositeJobsSha256: "",
          conclusion: "",
          effectiveRunAttempt: null,
          key: child.key,
          passed: false,
          plannedRunAttempt: child.runAttempt ?? null,
          runId: String(child.runId ?? ""),
          status: "missing",
          url: String(child.url ?? ""),
        };
      }
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
    missing: children.filter((child) => child.status === "missing"),
    passed: children.filter((child) => child.status === "passed"),
  };
}

export function createClient(repository, dependencies = {}) {
  const apiJson = dependencies.apiJson ?? ((path) => ghJson(repository, path));
  const apiText =
    dependencies.apiText ??
    ((path, jq) => readFreshGhApi(repository, path, jq ? ["--paginate", "--jq", jq] : []));
  const mutate = dependencies.mutate ?? ((args) => execGh(args));
  const rerun = (runId, action) =>
    mutate(["api", "-X", "POST", `repos/${repository}/actions/runs/${runId}/${action}`]);
  const execute = dependencies.execCommand ?? execCommand;
  const attemptJobs =
    dependencies.getAttemptJobs ??
    ((runId, runAttempt) => ghAttemptJobs(repository, runId, runAttempt));
  const verify = async (runId, plan, operationDeadline, expectedRunAttempts) => {
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
        ...(expectedRunAttempts === undefined
          ? []
          : ["--expected-run-attempts-json", JSON.stringify(expectedRunAttempts)]),
        "--json",
      ],
      {
        timeoutMs: remainingOperationTime(
          operationDeadline ?? createOperationDeadline(),
          "FRV verification",
        ),
      },
    );
  };
  return {
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
    rerunFailed: (runId) => rerun(runId, "rerun-failed-jobs"),
    rerunParent: (runId) => rerun(runId, "rerun"),
    verify,
    async verifySeal(runId, plan, operationDeadline, expectedRunAttempts) {
      try {
        await verify(runId, plan, operationDeadline, expectedRunAttempts);
        return true;
      } catch (error) {
        if (verifierEvidenceNeedsRefresh(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function controllerRunAttempt(run, sourceAttempt, expectedAttempt) {
  const runId = String(run.id);
  const observedAttempt = positiveInteger(run.run_attempt, `${runId} run attempt`);
  switch (true) {
    case observedAttempt < sourceAttempt:
      throw new Error(`rerun source ${runId} attempt regressed`);
    case observedAttempt > expectedAttempt:
      throw new Error(`controller-owned run ${runId} advanced past attempt ${expectedAttempt}`);
    default:
      return observedAttempt;
  }
}

async function waitForTerminal(runIds, client, operationDeadline, expectedAttempts = new Map()) {
  const pollMs = configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS);
  while (Date.now() < operationDeadline) {
    const runs = await Promise.all(runIds.map((runId) => client.getRun(runId)));
    const ready = runs.every((run) => {
      const runId = String(run.id);
      const expectedAttempt = expectedAttempts.get(runId);
      if (expectedAttempt === undefined) {
        return run.status === "completed";
      }
      const observedAttempt = controllerRunAttempt(run, expectedAttempt - 1, expectedAttempt);
      return run.status === "completed" && observedAttempt === expectedAttempt;
    });
    if (ready) {
      return runs;
    }
    await sleep(Math.min(pollMs, remainingOperationTime(operationDeadline)));
  }
  throw new Error(`timed out waiting for runs: ${runIds.join(", ")}`);
}

async function reconcileAttemptStarts(
  minimumAttempts,
  priorRuns,
  client,
  mutationResults,
  operationDeadline,
) {
  const reconcileDeadline = Math.min(
    operationDeadline,
    Date.now() +
      configuredTimeout("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", DEFAULT_RECONCILE_TIMEOUT_MS),
  );
  const hardFailures = mutationResults.filter(
    (result) =>
      result.status === "rejected" && classifyReleaseGhTransportError(result.reason) === "hard",
  );
  const pending = new Set(
    [...minimumAttempts.keys()].filter(
      (_, index) => !hardFailures.includes(mutationResults[index]),
    ),
  );
  while (pending.size > 0 && Date.now() < reconcileDeadline) {
    const runs = await Promise.all([...pending].map((runId) => client.getRun(runId)));
    for (const run of runs) {
      const runId = String(run.id);
      const priorRun = priorRuns.get(runId);
      if (JSON.stringify(runIdentity(run)) !== JSON.stringify(runIdentity(priorRun))) {
        throw new Error(`rerun source ${runId} changed during mutation reconciliation`);
      }
      const sourceAttempt = positiveInteger(priorRun.run_attempt, `${runId} source run attempt`);
      const expectedAttempt = minimumAttempts.get(runId);
      const observedAttempt = controllerRunAttempt(run, sourceAttempt, expectedAttempt);
      if (observedAttempt === expectedAttempt) {
        pending.delete(runId);
      }
    }
    if (pending.size > 0) {
      const remainingReconcileTime = reconcileDeadline - Date.now();
      if (remainingReconcileTime < 1) {
        break;
      }
      await sleep(
        Math.min(
          configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS),
          remainingReconcileTime,
        ),
      );
    }
  }
  if (pending.size > 0) {
    const runIds = [...minimumAttempts.keys()];
    const failures = [...pending].flatMap((runId) => {
      const result = mutationResults[runIds.indexOf(runId)];
      if (result?.status !== "rejected") {
        return [];
      }
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return [`${runId}: ${reason}`];
    });
    throw new Error(
      `rerun mutation did not produce an observable newer attempt for ${[...pending].join(
        ", ",
      )}${failures.length > 0 ? ` (${failures.join("; ")})` : ""}`,
    );
  }
  if (hardFailures[0]) {
    throw hardFailures[0].reason;
  }
  remainingOperationTime(operationDeadline);
}

function runIdentity(run) {
  return {
    actor: String(run.actor?.login ?? ""),
    displayTitle: String(run.display_title ?? ""),
    event: String(run.event ?? ""),
    headBranch: String(run.head_branch ?? ""),
    headSha: String(run.head_sha ?? ""),
    id: String(run.id),
    path: String(run.path ?? ""),
    repository: String(run.repository?.full_name ?? run.repository ?? ""),
  };
}

function exactTerminalRunState(run, runId) {
  const state = {
    ...runIdentity(run),
    conclusion: run.conclusion ?? null,
    runAttempt: positiveInteger(run.run_attempt, `${runId} run attempt`),
  };
  if (state.id !== runId || String(run.status ?? "") !== "completed") {
    throw new Error(`rerun source ${runId} is no longer the exact terminal run`);
  }
  return state;
}

async function freezeVerificationAttempts(plan, rootRunId, status, client) {
  const expectedRunAttempts = new Map(
    status.children.map((child) => [child.runId, child.effectiveRunAttempt]),
  );
  // Reuse verification rereads its root and selected parent manifests too.
  const parentRunIds = new Set([
    rootRunId,
    ...(plan.evidenceReuse?.requested
      ? [plan.evidenceReuse.rootRunId, plan.evidenceReuse.selectedRunId]
      : []),
  ]);
  for (const parentRunId of parentRunIds) {
    const run = await client.getRun(parentRunId);
    if (String(run.id) !== parentRunId) {
      throw new Error(`verification parent run identity changed: ${parentRunId}`);
    }
    const terminal = parentRunId === rootRunId ? exactTerminalRunState(run, rootRunId) : undefined;
    if (terminal && terminal.conclusion !== "success") {
      throw new Error(`final parent rerun failed: ${rootRunId}`);
    }
    expectedRunAttempts.set(
      parentRunId,
      terminal?.runAttempt ?? positiveInteger(run.run_attempt, `${parentRunId} run attempt`),
    );
  }
  return Object.fromEntries(expectedRunAttempts.entries());
}

export async function continueFailed(plan, rootRunId, client, options = {}) {
  const operationDeadline =
    options.operationDeadline === undefined
      ? createOperationDeadline()
      : validateOperationDeadline(options.operationDeadline);
  const ownedAttempts = new Map();
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
    remainingOperationTime(operationDeadline);
    const mutationResults = await Promise.allSettled(
      status.failed.map((child) => client.rerunFailed(child.runId)),
    );
    await reconcileAttemptStarts(
      minimumAttempts,
      priorRuns,
      client,
      mutationResults,
      operationDeadline,
    );
    minimumAttempts.forEach((attempt, runId) => ownedAttempts.set(runId, attempt));
    await waitForTerminal(
      status.failed.map((child) => child.runId),
      client,
      operationDeadline,
      minimumAttempts,
    );
    status = await inspectContinuation(plan, client);
    for (const child of status.children) {
      const expectedAttempt = ownedAttempts.get(child.runId);
      if (expectedAttempt !== undefined) {
        controllerRunAttempt(
          { id: child.runId, run_attempt: child.effectiveRunAttempt },
          expectedAttempt,
          expectedAttempt,
        );
      }
    }
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
  let completedParent = await client.getRun(rootRunId);
  let verificationAttempts;
  let parentSealed = false;
  if (
    completedParent.conclusion === "success" &&
    childEvidenceAdvanced &&
    client.verifySeal !== undefined
  ) {
    verificationAttempts = await freezeVerificationAttempts(plan, rootRunId, status, client);
    parentSealed = await client.verifySeal(
      rootRunId,
      plan,
      operationDeadline,
      verificationAttempts,
    );
    if (!parentSealed) {
      const verifiedParent = exactTerminalRunState(completedParent, rootRunId);
      completedParent = await client.getRun(rootRunId);
      const currentParent = exactTerminalRunState(completedParent, rootRunId);
      if (JSON.stringify(currentParent) !== JSON.stringify(verifiedParent)) {
        throw new Error(`verification parent run changed before rerun dispatch: ${rootRunId}`);
      }
    }
  }
  if (!parentSealed && (completedParent.conclusion !== "success" || childEvidenceAdvanced)) {
    const terminalParent = exactTerminalRunState(completedParent, rootRunId);
    const minimumAttempts = new Map([[rootRunId, terminalParent.runAttempt + 1]]);
    remainingOperationTime(operationDeadline);
    const mutationResults = await Promise.allSettled([client.rerunParent(rootRunId)]);
    await reconcileAttemptStarts(
      minimumAttempts,
      new Map([[rootRunId, completedParent]]),
      client,
      mutationResults,
      operationDeadline,
    );
    ownedAttempts.set(rootRunId, minimumAttempts.get(rootRunId));
    await waitForTerminal([rootRunId], client, operationDeadline, minimumAttempts);
  }
  if (!parentSealed) {
    await waitForTerminal([...ownedAttempts.keys()], client, operationDeadline, ownedAttempts);
    verificationAttempts = await freezeVerificationAttempts(plan, rootRunId, status, client);
    await client.verify(rootRunId, plan, operationDeadline, verificationAttempts);
  }
  return {
    action: ownedAttempts.has(rootRunId) ? "reran-parent" : "verified-parent",
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
