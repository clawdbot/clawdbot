#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  classifyReleaseGhTransportError,
  composeReleaseChildAttemptEvidence,
  HISTORICAL_CONTINUATION_SOURCE_MODE,
  normalizeReleaseCandidate,
  normalizeReleaseValidationInputs,
  releaseChildSpec,
  requireCanonicalReleaseContinuationWorkflowRef,
  selectHistoricalReleaseSourceInputJob,
  terminalPolicyPass,
  validateReleaseChildDispatchBinding,
  validateReleaseChildRunProvenance,
  validateReleaseExecutionPlanArtifact,
  verifyReleaseContinuationSource,
} from "./full-release-validation-policy.mjs";
import { verifyTrustedWorkflowRef } from "./full-release-validation-workflow-trust.mjs";
import { plainGhAuthenticatedEnv, resolvePlainGhBin } from "./lib/plain-gh.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY = "openclaw/openclaw";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 60_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 60_000;
const PLAN_FILENAME = "full-release-execution-plan.json";
const MANIFEST_FILENAME = "full-release-validation-manifest.json";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

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

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    command,
    dryRun: false,
    failedOnly: false,
    json: false,
    legacyPlanPath: "",
    repository: DEFAULT_REPOSITORY,
    runId: "",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--run") {
      options.runId = requiredValue(argv[++index], "--run");
    } else if (argument === "--repo") {
      options.repository = requiredValue(argv[++index], "--repo");
    } else if (argument === "--legacy-plan") {
      options.legacyPlanPath = requiredValue(argv[++index], "--legacy-plan");
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
  if (command === "verify" && options.legacyPlanPath) {
    throw new Error("verify reads the final run execution plan; omit --legacy-plan");
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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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
      if (
        /no valid artifacts found|artifact .* not found|could not find any artifacts/iu.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        return undefined;
      }
      throw error;
    }
    const path = join(directory, PLAN_FILENAME);
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size < 1 || size > 128 * 1024) {
      throw new Error("immutable execution plan artifact is missing or oversized");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function downloadSourceManifest(repository, runId, runAttempt) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-frv-source-manifest-"));
  try {
    const names = [
      `full-release-validation-${runId}-${runAttempt}`,
      `full-release-validation-${runId}`,
    ];
    for (const [index, name] of names.entries()) {
      const directory = join(root, String(index));
      mkdirSync(directory);
      try {
        await execGhRead([
          "run",
          "download",
          runId,
          "--repo",
          repository,
          "--name",
          name,
          "--dir",
          directory,
        ]);
      } catch (error) {
        if (
          /no valid artifacts found|artifact .* not found|could not find any artifacts/iu.test(
            error instanceof Error ? error.message : String(error),
          )
        ) {
          continue;
        }
        throw error;
      }
      const path = join(directory, MANIFEST_FILENAME);
      const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      if (size < 1 || size > 128 * 1024) {
        throw new Error("source release manifest artifact is missing or oversized");
      }
      return JSON.parse(readFileSync(path, "utf8"));
    }
    return undefined;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

export function validateLegacySource(
  value,
  expectedRunId,
  expectedRepository = DEFAULT_REPOSITORY,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy continuation plan must be an object");
  }
  const source = value.source;
  const children = value.children;
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    !children ||
    typeof children !== "object" ||
    Array.isArray(children)
  ) {
    throw new Error("legacy continuation source and children are required");
  }
  const sourceRunAttempt = positiveInteger(source.runAttempt, "source run attempt");
  const targetSha = requiredValue(value.targetSha, "legacy target SHA");
  let validationInputs;
  try {
    validationInputs = normalizeReleaseValidationInputs(value.validationInputs);
  } catch (error) {
    throw new Error("legacy continuation validation inputs are incomplete", { cause: error });
  }
  const continuation = {
    candidate: normalizeReleaseCandidate(value.candidate, {
      parentRunAttempt: sourceRunAttempt,
      parentRunId: expectedRunId,
      targetSha,
    }),
    publicationEnabled: false,
    releaseProfile: requiredValue(value.releaseProfile, "legacy release profile"),
    rerunGroup: "all",
    runReleaseSoak: String(value.runReleaseSoak),
    sourceDisplayTitle: requiredValue(source.displayTitle, "source display title"),
    sourceEvent: requiredValue(source.event, "source event"),
    sourceRepository: requiredValue(source.repository, "source repository"),
    sourceRunAttempt,
    sourceRunId: requiredValue(source.runId, "source run ID"),
    sourceWorkflowPath: requiredValue(source.workflowPath, "source workflow path"),
    sourceWorkflowRef: requiredValue(source.workflowRef, "source workflow ref"),
    sourceWorkflowSha: requiredValue(source.workflowSha, "source workflow SHA"),
    sourceEvidenceMode: HISTORICAL_CONTINUATION_SOURCE_MODE,
    toolingSha: requiredValue(value.toolingSha, "continuation tooling SHA"),
    validationInputs,
  };
  requireCanonicalReleaseContinuationWorkflowRef(
    continuation.sourceWorkflowRef,
    continuation.sourceWorkflowSha,
  );
  if (
    continuation.sourceRunId !== expectedRunId ||
    continuation.sourceRepository !== expectedRepository ||
    continuation.sourceEvent !== "workflow_dispatch" ||
    continuation.sourceWorkflowPath !== ".github/workflows/full-release-validation.yml" ||
    !SHA_PATTERN.test(continuation.sourceWorkflowSha) ||
    !["beta", "stable", "full"].includes(continuation.releaseProfile) ||
    !["true", "false"].includes(continuation.runReleaseSoak) ||
    !continuation.candidate ||
    continuation.candidate.packageSourceSha !== targetSha ||
    !SHA_PATTERN.test(targetSha) ||
    !SHA_PATTERN.test(continuation.toolingSha) ||
    !continuation.validationInputs
  ) {
    throw new Error("legacy continuation identity is invalid");
  }
  const normalizedChildren = Object.fromEntries(
    Object.entries(children).map(([key, child]) => {
      let spec;
      try {
        spec = releaseChildSpec(key);
      } catch {
        throw new Error(`legacy continuation child key is invalid: ${key}`);
      }
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        throw new Error(`legacy continuation child is invalid: ${key}`);
      }
      const normalized = {
        displayTitle: requiredValue(child.displayTitle, `${key} display title`),
        runAttempt: positiveInteger(child.runAttempt, `${key} run attempt`),
        runId: requiredValue(child.runId, `${key} run ID`),
        sourceParentAttempt: positiveInteger(
          child.sourceParentAttempt,
          `${key} source parent attempt`,
        ),
        url: String(child.url ?? ""),
        workflow: requiredValue(child.workflow, `${key} workflow`),
        workflowRef: requiredValue(child.workflowRef, `${key} workflow ref`),
        workflowSha: requiredValue(child.workflowSha, `${key} workflow SHA`),
      };
      if (
        normalized.workflow !== spec.workflow ||
        !/^[1-9][0-9]*$/u.test(normalized.runId) ||
        !SHA_PATTERN.test(normalized.workflowSha) ||
        normalized.sourceParentAttempt > sourceRunAttempt ||
        normalized.workflowRef !== continuation.sourceWorkflowRef ||
        normalized.workflowSha !== continuation.sourceWorkflowSha ||
        normalized.displayTitle !==
          `${spec.displayName} full-release-validation-${expectedRunId}-${normalized.sourceParentAttempt}${spec.suffix}` ||
        normalized.url !==
          `https://github.com/${expectedRepository}/actions/runs/${normalized.runId}`
      ) {
        throw new Error(`legacy continuation child identity is invalid: ${key}`);
      }
      return [key, normalized];
    }),
  );
  const npmTelegramRequired =
    (typeof continuation.validationInputs.npmTelegramPackageSpec === "string" &&
      continuation.validationInputs.npmTelegramPackageSpec.trim().length > 0) ||
    (typeof continuation.validationInputs.releasePackageSpec === "string" &&
      continuation.validationInputs.releasePackageSpec.trim().length > 0);
  const expectedChildKeys = [
    "normalCi",
    "pluginPrerelease",
    "releaseChecks",
    "productPerformance",
    ...(npmTelegramRequired ? ["npmTelegram"] : []),
  ].toSorted();
  if (
    JSON.stringify(Object.keys(normalizedChildren).toSorted()) !== JSON.stringify(expectedChildKeys)
  ) {
    throw new Error("legacy continuation child inventory is invalid");
  }
  return {
    children: normalizedChildren,
    continuation,
    legacy: true,
    releaseProfile: continuation.releaseProfile,
    rerunGroup: "all",
    targetSha,
  };
}

function selectedChildren(plan) {
  if (plan.legacy) {
    return Object.entries(plan.children).map(([key, child]) =>
      Object.assign({}, child, { key, required: true, selected: true }),
    );
  }
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
  const source = plan.continuation
    ? plan.continuation
    : {
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
    !String(resolveLog).includes(`TARGET_SHA: ${plan.targetSha}`)
  ) {
    throw new Error("source full release root is not an exact all-group target");
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
  const sourceChildLogs = Object.fromEntries(
    childObservations.map(({ child, parentLog }) => [child.key, parentLog]),
  );
  if (plan.continuation) {
    if (typeof client.loadSourceManifest !== "function" && !plan.legacy) {
      throw new Error("FRV continuation client cannot load the exact source manifest");
    }
    const sourceManifest = await client.loadSourceManifest?.(
      source.sourceRunId,
      source.sourceRunAttempt,
    );
    const sourceInputLog =
      !sourceManifest &&
      plan.continuation.sourceEvidenceMode === HISTORICAL_CONTINUATION_SOURCE_MODE
        ? await client.getJobLog(
            selectHistoricalReleaseSourceInputJob(parentJobs, source.sourceRunAttempt).id,
          )
        : undefined;
    verifyReleaseContinuationSource({
      children: selectedChildren(plan),
      continuation: plan.continuation,
      repository,
      sourceChildLogs,
      sourceInputLog,
      sourceManifest,
      sourceRun,
      targetSha: plan.targetSha,
    });
  } else {
    if (
      String(sourceRun.id) !== source.sourceRunId ||
      Number(sourceRun.run_attempt) !== source.sourceRunAttempt ||
      sourceRun.display_title !== source.sourceDisplayTitle ||
      sourceRun.event !== source.sourceEvent ||
      String(sourceRun.path ?? "").split("@", 1)[0] !== source.sourceWorkflowPath ||
      sourceRun.head_branch !== source.sourceWorkflowRef ||
      sourceRun.head_sha !== source.sourceWorkflowSha ||
      sourceRun.repository?.full_name !== source.sourceRepository ||
      source.sourceRepository !== repository
    ) {
      throw new Error("source full release parent identity changed");
    }
    for (const { child, parentLog } of childObservations) {
      validateReleaseChildDispatchBinding({
        child,
        log: parentLog,
        plannedRunAttempt: child.runAttempt,
        repository,
        targetSha: plan.targetSha,
      });
    }
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

export function continuationBranchName(sourceRunId, toolingSha) {
  return `release-ci/${toolingSha.slice(0, 12)}-${positiveInteger(sourceRunId, "source run ID")}`;
}

function continuationPlanIdentity(plan) {
  return canonicalJson({
    children: selectedChildren(plan).map(
      ({
        displayTitle,
        key,
        runAttempt,
        runId,
        sourceParentAttempt,
        workflow,
        workflowRef,
        workflowSha,
      }) => ({
        displayTitle,
        key,
        runAttempt,
        runId,
        sourceParentAttempt,
        workflow,
        workflowRef,
        workflowSha,
      }),
    ),
    continuation: plan.continuation,
    releaseProfile: plan.releaseProfile,
    rerunGroup: plan.rerunGroup,
    targetSha: plan.targetSha,
  });
}

function refApiPath(branch) {
  return `git/ref/heads/${branch
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function githubNotFound(error) {
  return /HTTP 404\b|Not Found/iu.test(error instanceof Error ? error.message : String(error));
}

function githubRepositoryFromRemote(remote) {
  const normalized = String(remote)
    .trim()
    .replace(/\.git$/u, "");
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)$/iu.exec(normalized) ??
    /^git@github\.com:([^/]+\/[^/]+)$/iu.exec(normalized) ??
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/iu.exec(normalized);
  return match?.[1] ?? "";
}

function continuationParentPlanError(run, options) {
  return new Error(
    `exact continuation parent ${run.id} terminated with conclusion ${run.conclusion ?? "<missing>"} without a valid immutable execution plan`,
    options,
  );
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
  const git = dependencies.git ?? ((args) => execCommand("git", args));
  const report = dependencies.report ?? ((message) => console.error(message));
  const loadExecutionPlan =
    dependencies.loadExecutionPlan ?? ((runId) => downloadExecutionPlan(repository, runId));
  const loadSourceManifest =
    dependencies.loadSourceManifest ??
    ((runId, runAttempt) => downloadSourceManifest(repository, runId, runAttempt));
  const attemptJobs =
    dependencies.getAttemptJobs ??
    ((runId, runAttempt) => ghAttemptJobs(repository, runId, runAttempt));
  const verifyTrustedMainSha = async (workflowSha, label) => {
    const comparison = await apiJson(`compare/${workflowSha}...main`);
    try {
      verifyTrustedWorkflowRef(
        workflowSha,
        "main",
        () => "",
        () => comparison.status === "ahead" || comparison.status === "identical",
      );
    } catch (error) {
      throw new Error(
        `${label} SHA ${workflowSha} is not reachable from protected main in ${repository}`,
        { cause: error },
      );
    }
  };
  const client = {
    repository,
    loadSourceManifest,
    verifyTrustedSourceSha: (workflowSha) => verifyTrustedMainSha(workflowSha, "Source workflow"),
    verifyTrustedToolingSha: (workflowSha) => verifyTrustedMainSha(workflowSha, "Tooling"),
    async findContinuationParent(plan, branch, workflowSha) {
      const response = await apiJson(
        `actions/workflows/full-release-validation.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=100`,
      );
      const candidates = (response.workflow_runs ?? []).filter(
        (entry) =>
          entry.head_sha === workflowSha &&
          entry.head_branch === branch &&
          entry.event === "workflow_dispatch",
      );
      const inspected = await Promise.all(
        candidates.map((entry) => apiJson(`actions/runs/${entry.id}`)),
      );
      const matches = inspected.filter(
        (entry) =>
          String(entry.id) !== "" &&
          entry.head_sha === workflowSha &&
          entry.head_branch === branch &&
          entry.event === "workflow_dispatch" &&
          String(entry.path ?? "").split("@", 1)[0] ===
            ".github/workflows/full-release-validation.yml" &&
          entry.repository?.full_name === repository,
      );
      if (matches.length > 1) {
        throw new Error("multiple continuation parents exist for the deterministic tooling ref");
      }
      const match = matches[0];
      if (!match) {
        return undefined;
      }
      const payload = await loadExecutionPlan(String(match.id));
      if (!payload) {
        return { pending: true, run: match };
      }
      const sealed = validateReleaseExecutionPlanArtifact(payload, {
        parentRunId: String(match.id),
        releaseProfile: plan.releaseProfile,
        rerunGroup: "all",
        targetSha: plan.targetSha,
        workflowRef: branch,
        workflowSha,
      });
      if (
        JSON.stringify(continuationPlanIdentity(sealed)) !==
        JSON.stringify(continuationPlanIdentity(plan))
      ) {
        throw new Error("existing continuation parent differs from the reviewed source plan");
      }
      return { pending: false, run: match };
    },
    async ensureWorkflowRef(branch, workflowSha) {
      let existing;
      try {
        existing = await apiJson(refApiPath(branch));
      } catch (error) {
        if (!githubNotFound(error)) {
          throw error;
        }
      }
      if (existing) {
        if (existing.object?.sha !== workflowSha) {
          throw new Error("continuation tooling ref exists at a different OID");
        }
        return;
      }
      let createError;
      try {
        await mutate([
          "api",
          "--method",
          "POST",
          `repos/${repository}/git/refs`,
          "-f",
          `ref=refs/heads/${branch}`,
          "-f",
          `sha=${workflowSha}`,
        ]);
        return;
      } catch (error) {
        createError = error;
      }
      const reconciled = await apiJson(refApiPath(branch));
      if (reconciled.object?.sha !== workflowSha) {
        throw new Error(
          `continuation tooling ref creation is ambiguous: ${
            createError instanceof Error ? createError.message : String(createError)
          }`,
          { cause: createError },
        );
      }
    },
    async dispatchContinuation(plan) {
      const workflowSha = plan.continuation.toolingSha;
      await client.verifyTrustedToolingSha(workflowSha);
      const file = await apiJson(
        `contents/.github/workflows/full-release-validation.yml?ref=${workflowSha}`,
      );
      const workflow = Buffer.from(
        String(file.content ?? "").replaceAll("\n", ""),
        "base64",
      ).toString("utf8");
      if (!workflow.includes("continuation_plan_json:")) {
        throw new Error("frozen continuation tooling does not support FRV continuation");
      }
      const branch = continuationBranchName(plan.continuation.sourceRunId, workflowSha);
      await client.ensureWorkflowRef(branch, workflowSha);
      let existing = await client.findContinuationParent(plan, branch, workflowSha);
      if (existing) {
        if (existing.pending && existing.run.status === "completed") {
          throw continuationParentPlanError(existing.run);
        }
        report(`adopting exact continuation parent ${existing.run.id} on ${branch}`);
        return { branch, runId: String(existing.run.id), workflowSha };
      }
      const validation = plan.continuation.validationInputs;
      const inputs = {
        ref: plan.targetSha,
        expected_sha: plan.targetSha,
        target_context_ref: String(validation.targetContextRef ?? ""),
        release_profile: plan.releaseProfile,
        run_release_soak: plan.continuation.runReleaseSoak,
        provider: String(validation.provider ?? "openai"),
        mode: String(validation.mode ?? "both"),
        live_suite_filter: String(validation.liveSuiteFilter ?? ""),
        cross_os_suite_filter: String(validation.crossOsSuiteFilter ?? ""),
        release_package_spec: String(validation.releasePackageSpec ?? ""),
        package_acceptance_package_spec: String(validation.packageAcceptancePackageSpec ?? ""),
        codex_plugin_spec: String(validation.codexPluginSpec ?? ""),
        npm_telegram_package_spec: String(validation.npmTelegramPackageSpec ?? ""),
        npm_telegram_provider_mode: String(validation.npmTelegramProviderMode ?? ""),
        npm_telegram_scenario: String(validation.npmTelegramScenario ?? ""),
        skip_package_telegram_e2e: String(validation.skipPackageTelegramE2e ?? "false"),
        allow_unreleased_changelog: String(validation.allowUnreleasedChangelog ?? "false"),
        plugin_prerelease_node_exclude_patterns_json: String(
          validation.pluginPrereleaseNodeExcludePatternsJson ?? "[]",
        ),
        rerun_group: "all",
        reuse_evidence: "false",
        fail_fast: "false",
        dispatch_release_evidence: "false",
        trusted_workflow_json: JSON.stringify({
          fullRef: "refs/heads/main",
          ref: "main",
          sha: workflowSha,
        }),
        continuation_plan_json: JSON.stringify({
          ...plan.continuation,
          children: plan.children,
          targetSha: plan.targetSha,
        }),
      };
      const args = [
        "workflow",
        "run",
        "full-release-validation.yml",
        "--repo",
        repository,
        "--ref",
        branch,
      ];
      for (const [key, value] of Object.entries(inputs)) {
        args.push("-f", `${key}=${value}`);
      }
      let dispatchError;
      if (!existing) {
        try {
          await mutate(args);
        } catch (error) {
          if (classifyReleaseGhTransportError(error) === "hard") {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`continuation parent dispatch was rejected: ${message}`, {
              cause: error,
            });
          }
          dispatchError = error;
        }
      }
      const deadline =
        Date.now() + Number(process.env.OPENCLAW_FRV_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
      while (Date.now() < deadline) {
        existing = await client.findContinuationParent(plan, branch, workflowSha);
        if (existing) {
          if (existing.pending && existing.run.status === "completed") {
            throw continuationParentPlanError(existing.run);
          }
          report(`adopting exact continuation parent ${existing.run.id} on ${branch}`);
          return { branch, runId: String(existing.run.id), workflowSha };
        }
        await sleep(Number(process.env.OPENCLAW_FRV_POLL_MS || DEFAULT_POLL_MS));
      }
      if (dispatchError) {
        const message =
          dispatchError instanceof Error
            ? dispatchError.message
            : typeof dispatchError === "string"
              ? dispatchError
              : "unknown mutation error";
        throw new Error(
          `continuation parent dispatch failed and no exact run was observed: ${message}`,
          { cause: dispatchError },
        );
      }
      throw new Error("could not resolve continuation parent run ID");
    },
    async deleteWorkflowRef(branch, workflowSha) {
      let origin;
      try {
        origin = await git(["remote", "get-url", "origin"]);
      } catch (error) {
        report(
          `warning: leaving continuation tooling ref ${branch}; local origin could not be verified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { deleted: false };
      }
      if (githubRepositoryFromRemote(origin).toLowerCase() !== repository.toLowerCase()) {
        report(
          `warning: leaving continuation tooling ref ${branch}; local origin does not map to ${repository}`,
        );
        return { deleted: false };
      }
      try {
        await git([
          "push",
          `--force-with-lease=refs/heads/${branch}:${workflowSha}`,
          "origin",
          `:refs/heads/${branch}`,
        ]);
        return { deleted: true };
      } catch (error) {
        report(
          `warning: leaving continuation tooling ref ${branch}; atomic lease deletion failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { deleted: false };
      }
    },
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
    async verify(runId, plan) {
      const sourceSha = plan.trustedWorkflow?.sha ?? plan.continuation?.toolingSha;
      return execCommand(process.execPath, [
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
      ]);
    },
  };
  return client;
}

async function waitForTerminal(runIds, client, minimumAttempts = new Map()) {
  const deadline = Date.now() + Number(process.env.OPENCLAW_FRV_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const pollMs = Number(process.env.OPENCLAW_FRV_POLL_MS || DEFAULT_POLL_MS);
  while (Date.now() < deadline) {
    const runs = await Promise.all(runIds.map((runId) => client.getRun(runId)));
    const ready = runs.every(
      (run) =>
        run.status === "completed" &&
        Number(run.run_attempt) >= Number(minimumAttempts.get(String(run.id)) ?? 1),
    );
    if (ready) {
      return runs;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, pollMs);
    });
  }
  throw new Error(`timed out waiting for runs: ${runIds.join(", ")}`);
}

async function reconcileAttemptStarts(minimumAttempts, client, mutationResults) {
  const deadline =
    Date.now() +
    Number(process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS || DEFAULT_RECONCILE_TIMEOUT_MS);
  const pending = new Set(minimumAttempts.keys());
  while (pending.size > 0 && Date.now() < deadline) {
    const runs = await Promise.all([...pending].map((runId) => client.getRun(runId)));
    for (const run of runs) {
      const runId = String(run.id);
      if (Number(run.run_attempt) >= minimumAttempts.get(runId)) {
        pending.delete(runId);
      }
    }
    if (pending.size > 0) {
      await sleep(Number(process.env.OPENCLAW_FRV_POLL_MS || DEFAULT_POLL_MS));
    }
  }
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

async function rerunWithTransientRetry(runId, priorRun, mutation, client) {
  const prior = exactTerminalRunState(priorRun, runId);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
  await preflightContinuation(plan, rootRunId, client, client.repository ?? DEFAULT_REPOSITORY);
  if (plan.continuation) {
    if (typeof client.verifyTrustedSourceSha !== "function") {
      throw new Error("continuation client cannot verify its source workflow SHA");
    }
    await client.verifyTrustedSourceSha(plan.continuation.sourceWorkflowSha);
  }
  if (plan.legacy) {
    if (typeof client.verifyTrustedToolingSha !== "function") {
      throw new Error("legacy continuation client cannot verify its frozen Tooling SHA");
    }
    await client.verifyTrustedToolingSha(plan.continuation.toolingSha);
  }
  let status = await inspectContinuation(plan, client);
  if (status.active.length > 0) {
    await waitForTerminal(
      status.active.map((child) => child.runId),
      client,
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
        ),
      ),
    );
    await reconcileAttemptStarts(minimumAttempts, client, mutationResults);
    await waitForTerminal(
      status.failed.map((child) => child.runId),
      client,
      minimumAttempts,
    );
    status = await inspectContinuation(plan, client);
  }
  if (status.active.length > 0 || status.failed.length > 0) {
    throw new Error("failed child reruns did not produce a complete green composite");
  }
  if (options.dryRun) {
    return { action: plan.legacy ? "would-dispatch-parent" : "would-rerun-parent", status };
  }
  if (plan.legacy) {
    const dispatched = await client.dispatchContinuation(plan);
    await waitForTerminal([dispatched.runId], client);
    const run = await client.getRun(dispatched.runId);
    const finalPlanPayload = await options.loadExecutionPlan(dispatched.runId);
    let finalPlan;
    try {
      finalPlan = validateReleaseExecutionPlanArtifact(finalPlanPayload, {
        parentRunId: dispatched.runId,
      });
    } catch (error) {
      throw continuationParentPlanError(run, { cause: error });
    }
    if (run.conclusion !== "success") {
      throw new Error(`continuation parent failed: ${dispatched.runId}`);
    }
    if (
      JSON.stringify(continuationPlanIdentity(finalPlan)) !==
      JSON.stringify(continuationPlanIdentity(plan))
    ) {
      throw new Error("continuation parent execution plan differs from the reviewed source plan");
    }
    await client.verify(dispatched.runId, finalPlan);
    await client.deleteWorkflowRef(dispatched.branch, dispatched.workflowSha);
    return { action: "dispatched-parent", finalRunId: dispatched.runId, status };
  }
  const parent = await client.getRun(rootRunId);
  if (parent.status !== "completed") {
    await waitForTerminal([rootRunId], client);
  }
  const completedParent = await client.getRun(rootRunId);
  let parentReran = false;
  if (completedParent.conclusion !== "success") {
    const minimumAttempts = new Map([
      [rootRunId, positiveInteger(completedParent.run_attempt, "parent run attempt") + 1],
    ]);
    const mutationResults = await Promise.allSettled([
      rerunWithTransientRetry(rootRunId, completedParent, client.rerunParent.bind(client), client),
    ]);
    await reconcileAttemptStarts(minimumAttempts, client, mutationResults);
    parentReran = true;
    await waitForTerminal([rootRunId], client, minimumAttempts);
  }
  const finalParent = await client.getRun(rootRunId);
  if (finalParent.conclusion !== "success") {
    throw new Error(`final parent rerun failed: ${rootRunId}`);
  }
  await client.verify(rootRunId, plan);
  return {
    action: parentReran ? "reran-parent" : "verified-parent",
    finalRunId: rootRunId,
    status,
  };
}

export async function loadPlan(options, loadExecutionPlan = downloadExecutionPlan) {
  const payload = await loadExecutionPlan(options.repository, options.runId);
  if (options.legacyPlanPath) {
    if (payload) {
      throw new Error("run has a canonical execution plan; reject --legacy-plan");
    }
    return validateLegacySource(
      readJson(options.legacyPlanPath, "legacy continuation plan"),
      options.runId,
      options.repository,
    );
  }
  if (!payload) {
    throw new Error("run predates immutable FRV plans; provide --legacy-plan");
  }
  const plan = validateReleaseExecutionPlanArtifact(payload, { parentRunId: options.runId });
  if (plan.attemptEvidenceVersion !== 1) {
    throw new Error("run predates attempt-aware immutable plans; provide --legacy-plan");
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
    const evidence = await client.verify(options.runId, plan);
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
      loadExecutionPlan: (runId) => downloadExecutionPlan(options.repository, runId),
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
