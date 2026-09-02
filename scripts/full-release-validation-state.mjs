#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildFullReleaseCandidateRequest } from "./full-release-candidate-contract.mjs";
import {
  affectedActiveRunIds,
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  buildReleaseStateArtifact,
  classifyReleaseGhTransportError,
  classifyReleaseSnapshot,
  composeReleaseChildAttemptEvidence,
  formatReleaseStateOutcome,
  releasePlanGateFailures,
  MAX_RELEASE_ARTIFACT_BYTES,
  serializeReleaseArtifact,
  selectReleaseStateArtifacts,
  validateReleaseChildRunProvenance,
  validateReleaseCoveragePolicyBinding,
  validateReleaseExecutionPlanArtifact,
  validateReleaseTelegramWaiverBinding,
  verifyReleaseStateArtifacts,
} from "./full-release-validation-policy.mjs";
import { sortJsonValueKeys } from "./lib/canonical-json.mjs";

export * from "./full-release-validation-policy.mjs";

const execFileAsync = promisify(execFile);
const RELEASE_SUMMARY_PATH =
  process.env.OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR ??
  fileURLToPath(new URL("./release-ci-summary.mjs", import.meta.url));
const API_ERROR_PATTERN =
  /HTTP [45][0-9][0-9]|API|Bad credentials|rate limit|network|connection|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN/u;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const GH_TIMEOUT_MS = 60_000;
const TRANSPORT_UNCERTAINTY_MS = 15 * 60_000;
let ghRetryDeadline;

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function requiredString(value, label) {
  const normalized = stringValue(value).trim();
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

function requiredBoolean(value, label) {
  const normalized = requiredString(value, label);
  if (normalized !== "true" && normalized !== "false") {
    throw new Error(`${label} must be true or false`);
  }
  return normalized === "true";
}

async function abortableSleep(milliseconds, signal) {
  let abortError;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      abortError = signal?.reason instanceof Error ? signal.reason : new Error("operation aborted");
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  if (abortError instanceof Error) {
    throw new Error(abortError.message, { cause: abortError });
  }
}

const deadlineDelayMs = (delay, deadline, now) =>
  Number.isFinite(deadline) ? Math.max(0, Math.min(delay, deadline - now)) : delay;

export function releaseGhRetryDelayMs(attempt, deadlineMonotonicMs, nowMonotonicMs) {
  return deadlineDelayMs(Math.min(attempt * 10_000, 60_000), deadlineMonotonicMs, nowMonotonicMs);
}

async function runGh(args, options = {}) {
  const attempts = options.attempts ?? 6;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await execFileAsync("gh", args, {
        encoding: "utf8",
        env: process.env,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        signal: options.signal,
        timeout: GH_TIMEOUT_MS,
      });
      return result.stdout;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      if (attempt === attempts || classifyReleaseGhTransportError(error) !== "transient") {
        throw error;
      }
      const delay = releaseGhRetryDelayMs(attempt, ghRetryDeadline, performance.now());
      if (delay === 0) {
        throw error;
      }
      await abortableSleep(delay, options.signal);
    }
  }
  throw lastError;
}

async function githubJson(path, signal) {
  return JSON.parse(
    await runGh(["api", `repos/${process.env.GITHUB_REPOSITORY}/${path}`], { signal }),
  );
}

async function githubAttemptJobs(runId, runAttempt, signal) {
  return (
    await runGh(
      [
        "api",
        "--paginate",
        `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
        "--jq",
        ".jobs[] | @json",
      ],
      { signal },
    )
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function issue(kind, child, message, extra = {}) {
  return {
    child: child.key,
    kind,
    message,
    runId: stringValue(child.runId),
    url: stringValue(child.url),
    ...extra,
  };
}

export function validateChildBinding(child, run, composite) {
  const errors = [];
  let provenance = {};
  try {
    provenance = validateReleaseChildRunProvenance(run, {
      ...child,
      plannedRunAttempt: child.runAttempt,
      repository: process.env.GITHUB_REPOSITORY,
    });
  } catch (error) {
    errors.push(
      issue("provenance_mismatch", child, error instanceof Error ? error.message : String(error)),
    );
  }
  return {
    ...child,
    ...provenance,
    compositeJobsSha256: stringValue(composite.sha256),
    conclusion: stringValue(run.conclusion),
    createdAt: stringValue(run.created_at),
    errors,
    jobs: composite.jobs,
    observedRunAttempts: composite.observedRunAttempts,
    plannedRunAttempt: Number(child.runAttempt),
    runAttempt: Number(run.run_attempt),
    runId: String(run.id),
    status: stringValue(run.status),
    updatedAt: stringValue(run.updated_at),
    url: stringValue(run.html_url, child.url),
    workflowRef: stringValue(run.head_branch),
    workflowSha: stringValue(run.head_sha),
  };
}

export async function readChild(child, previous, signal, options = {}) {
  if (!child.selected) {
    return { ...child, errors: [], jobs: [], status: "skipped" };
  }
  if (!child.runId || !child.runAttempt) {
    const error = issue("dispatch_missing", child, `${child.key} omitted its exact run identity`);
    return { ...child, errors: [error], jobs: [], status: "missing" };
  }
  try {
    const run = options.readRun
      ? await options.readRun(child.runId, signal)
      : await githubJson(`actions/runs/${child.runId}`, signal);
    const currentAttempt = positiveInteger(run.run_attempt, `${child.key} run attempt`);
    const plannedAttempt = positiveInteger(child.runAttempt, `${child.key} planned run attempt`);
    if (currentAttempt < plannedAttempt) {
      return validateChildBinding(child, run, {
        jobs: [],
        observedRunAttempts: [],
        sha256: "",
      });
    }
    const attempts = await Promise.all(
      Array.from({ length: currentAttempt - plannedAttempt + 1 }, async (_, index) => {
        const runAttempt = plannedAttempt + index;
        return {
          jobs: options.readAttemptJobs
            ? await options.readAttemptJobs(child.runId, runAttempt, signal)
            : await githubAttemptJobs(child.runId, runAttempt, signal),
          runAttempt,
        };
      }),
    );
    if (run.status !== "completed" && attempts.at(-1)?.jobs.length === 0) {
      if (attempts.slice(0, -1).some((attempt) => attempt.jobs.length === 0)) {
        throw new Error(`${child.key} child attempt evidence is gapped`);
      }
      const partial = validateChildBinding(child, run, {
        jobs: [],
        observedRunAttempts: [],
        sha256: "",
      });
      return (previous?.compositeJobsSha256 || previous?.transportFailure) &&
        partial.errors.length === 0
        ? {
            ...previous,
            conclusion: stringValue(run.conclusion),
            status: stringValue(run.status),
          }
        : partial;
    }
    const evidence = composeReleaseChildAttemptEvidence({
      attempts,
      expected: {
        ...child,
        plannedRunAttempt: plannedAttempt,
        repository: process.env.GITHUB_REPOSITORY,
      },
      run,
    });
    return validateChildBinding(child, run, {
      jobs: evidence.jobs,
      observedRunAttempts: evidence.observedRunAttempts,
      sha256: evidence.compositeJobsSha256,
    });
  } catch (error) {
    const degraded = classifyReleaseGhTransportError(error) === "transient";
    const provenanceMismatch =
      error instanceof Error && error.message.startsWith("release child provenance changed:");
    const readError = issue(
      provenanceMismatch ? "provenance_mismatch" : "api_error",
      child,
      `${child.key} GitHub read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    ghRetryDeadline ??= degraded ? performance.now() + TRANSPORT_UNCERTAINTY_MS : undefined;
    return {
      ...child,
      ...previous,
      errors: degraded
        ? (previous?.errors ?? []).filter((entry) => entry.kind === "provenance_mismatch")
        : [
            ...(previous?.errors ?? []).filter((entry) => entry.kind === "provenance_mismatch"),
            readError,
          ],
      status: degraded ? "transport_uncertain" : stringValue(previous?.status, "unknown"),
      transportFailure: degraded ? { errorClass: "transient" } : undefined,
    };
  }
}

export function updateReleaseTransportEpisode(previous, children, options = {}) {
  const monotonicNow = options.monotonicNow ?? performance.now();
  const wallNow = options.wallNow ?? Date.now();
  const uncertain = children.filter((child) => child.transportFailure?.errorClass === "transient");
  const affected = uncertain
    .map((child) => ({
      child: child.key,
      compositeJobsSha256: stringValue(child.compositeJobsSha256),
      errorClass: "transient",
      lastValidAt: stringValue(child.updatedAt),
      runAttempt: child.runAttempt,
      runId: String(child.runId),
    }))
    .toSorted((left, right) => left.child.localeCompare(right.child, "en"));
  if (affected.length === 0) {
    return { status: "certain" };
  }
  const deadline = options.deadline ?? ghRetryDeadline ?? monotonicNow + TRANSPORT_UNCERTAINTY_MS;
  const wallStart = wallNow + deadline - monotonicNow - TRANSPORT_UNCERTAINTY_MS;
  const episode = previous?.deadlineMonotonicMs
    ? previous
    : {
        deadlineAt: new Date(wallStart + TRANSPORT_UNCERTAINTY_MS).toISOString(),
        deadlineMonotonicMs: deadline,
        startedAt: new Date(wallStart).toISOString(),
      };
  return {
    ...episode,
    affected,
    error:
      monotonicNow >= episode.deadlineMonotonicMs
        ? issue(
            "transport_deadline_exceeded",
            { key: "<collector>" },
            `GitHub transport remained uncertain; affected ${affected.map((child) => `${child.child}:${child.runId}:${child.runAttempt}`).join(",")}`,
          )
        : undefined,
    status: monotonicNow >= episode.deadlineMonotonicMs ? "expired" : "uncertain",
  };
}

export function parsePlanInputs(value) {
  const parsed = JSON.parse(requiredString(value, "plan inputs JSON"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("plan inputs JSON must be an object");
  }
  return parsed;
}

export function hydrateReusedPlan(plan, evidence) {
  const byRole = new Map((evidence.children ?? []).map((child) => [child.role, child]));
  return plan.map((child) => {
    if (!child.selected) {
      return child;
    }
    const reused = byRole.get(child.key);
    if (!reused) {
      return child;
    }
    return {
      ...child,
      displayTitle: reused.displayTitle,
      result: "success",
      // Reuse keeps the dispatch origin, so a human rerun still composes earlier jobs.
      // Verified manifests predating childEvidence only carry the effective attempt.
      runAttempt:
        evidence.manifest.childEvidence === undefined
          ? reused.runAttempt
          : evidence.manifest.childEvidence[child.key].plannedRunAttempt,
      runId: reused.runId,
      url: reused.url,
      workflowRef: reused.headBranch,
      workflowSha: reused.workflowSha,
    };
  });
}

function changedPathsValue(value) {
  if (Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(stringValue(value, "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function validateReuse(executionPlan, signal) {
  const { children: plan, evidenceReuse, trustedWorkflow } = executionPlan;
  if (!evidenceReuse.requested) {
    return { blockers: [], children: plan, errors: [] };
  }
  try {
    const args = [
      RELEASE_SUMMARY_PATH,
      "--validate-run",
      requiredString(evidenceReuse.selectedRunId, "evidence selected run ID"),
      "--repo",
      requiredString(process.env.GITHUB_REPOSITORY, "GitHub repository"),
      "--trusted-workflow-ref",
      requiredString(trustedWorkflow?.ref, "trusted workflow ref"),
      "--trusted-workflow-full-ref",
      requiredString(trustedWorkflow?.fullRef, "trusted workflow full ref"),
      "--trusted-workflow-sha",
      requiredString(trustedWorkflow?.sha, "trusted workflow SHA"),
      "--verifier-source-sha",
      requiredString(executionPlan.workflowSha, "workflow SHA"),
      "--verifier-source-file",
      RELEASE_SUMMARY_PATH,
      "--expected-target-sha",
      requiredString(process.env.TARGET_SHA, "target SHA"),
      "--expected-evidence-policy",
      requiredString(evidenceReuse.policy, "evidence policy"),
      "--expected-evidence-sha",
      requiredString(evidenceReuse.evidenceSha, "evidence SHA"),
      "--expected-root-run-id",
      requiredString(evidenceReuse.rootRunId, "evidence root run ID"),
      "--expected-selected-run-id",
      requiredString(evidenceReuse.selectedRunId, "evidence selected run ID"),
      "--expected-changed-paths-json",
      JSON.stringify(changedPathsValue(evidenceReuse.changedPaths)),
      "--json",
    ];
    const result = await execFileAsync(process.execPath, args, {
      encoding: "utf8",
      env: process.env,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      signal,
      timeout: GH_TIMEOUT_MS * 6,
    });
    const evidence = JSON.parse(result.stdout);
    if (
      evidence.releaseProfile !== process.env.RELEASE_PROFILE ||
      evidence.rerunGroup !== process.env.RERUN_GROUP ||
      !evidence.manifest ||
      typeof evidence.manifest !== "object" ||
      Array.isArray(evidence.manifest)
    ) {
      throw new Error("reused release evidence no longer matches the requested validation");
    }
    validateReleaseTelegramWaiverBinding(executionPlan, evidence.manifest.validationInputs);
    validateReleaseCoveragePolicyBinding(executionPlan, evidence.manifest.validationInputs);
    return {
      blockers: [],
      children: hydrateReusedPlan(plan, evidence),
      errors: [],
      sourceManifest: sortJsonValueKeys(evidence.manifest),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry = {
      child: "<evidence>",
      kind: API_ERROR_PATTERN.test(message) ? "api_error" : "reused_evidence_invalid",
      message,
      runId: stringValue(evidenceReuse.selectedRunId),
      url: stringValue(evidenceReuse.runUrl),
    };
    return API_ERROR_PATTERN.test(message)
      ? { blockers: [], children: plan, errors: [entry] }
      : { blockers: [entry], children: plan, errors: [] };
  }
}

function writeArtifact(path, payload) {
  const json = serializeReleaseArtifact(payload);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
}

function writeResult(path, payload) {
  writeArtifact(path, payload);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `state=${payload.state}\n`);
    for (const [key, child] of Object.entries(payload.children ?? {})) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}_conclusion=${child.conclusion ?? ""}\n`);
    }
  }
}

function writeExecutionPlan(path, payload) {
  writeArtifact(path, payload);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${payload.sha256}\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `source_parent_attempt=${payload.parentRunAttempt}\n`,
    );
  }
}

function appendSummary(mode, payload) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## ${mode === "decision" ? "Release Decision" : "Diagnostic Drain"}\n\n${formatReleaseStateOutcome(payload)}\n`,
  );
}

export function formatReleaseStateHeartbeat(mode, decision) {
  return `${mode} heartbeat: state=${decision.state} active=${decision.activeRunIds.length} blockers=${decision.blockers.length} errors=${decision.errors.length}`;
}

async function cancelAffectedChildren(children, blockers, cancelledRunIds, signal) {
  const errors = [];
  for (const runId of affectedActiveRunIds(children, blockers, cancelledRunIds)) {
    const child = children.find((entry) => String(entry.runId) === runId);
    try {
      await runGh(["run", "cancel", runId], { attempts: 1, signal });
      cancelledRunIds.add(runId);
    } catch (error) {
      errors.push(
        issue(
          "api_error",
          child ?? { key: "<child>", runId },
          `exact child cancellation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }
  return errors;
}

function readArtifact(path, label) {
  try {
    if (statSync(path).size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error("release artifact exceeds the size limit");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function verifyMode() {
  const expected = {
    maxParentRunAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT, "parent run attempt"),
    parentRunId: requiredString(process.env.GITHUB_RUN_ID, "parent run ID"),
    repository: requiredString(process.env.GITHUB_REPOSITORY, "GitHub repository"),
    releaseProfile: requiredString(process.env.RELEASE_PROFILE, "release profile"),
    rerunGroup: requiredString(process.env.RERUN_GROUP, "rerun group"),
    targetSha: requiredString(process.env.TARGET_SHA, "target SHA"),
    workflowRef: requiredString(process.env.GITHUB_REF_NAME, "workflow ref"),
    workflowSha: requiredString(process.env.GITHUB_SHA, "workflow SHA"),
  };
  const verified = verifyReleaseStateArtifacts(
    readArtifact(
      requiredString(process.env.RELEASE_EXECUTION_PLAN_PATH, "execution plan path"),
      "execution plan",
    ),
    readArtifact(requiredString(process.env.RELEASE_DECISION_PATH, "decision path"), "decision"),
    readArtifact(requiredString(process.env.DIAGNOSTIC_DRAIN_PATH, "drain path"), "drain"),
    expected,
  );
  appendSummary("decision", verified.decision);
  appendSummary("drain", verified.drain);
}

function planExpected() {
  return {
    coveragePolicy: process.env.COVERAGE_POLICY || undefined,
    telegramWaiver: process.env.TELEGRAM_WAIVER ?? "",
    ...(process.env.TARGET_VERSION ? { targetVersion: process.env.TARGET_VERSION } : {}),
    parentRunId: requiredString(process.env.GITHUB_RUN_ID, "parent run ID"),
    repository: requiredString(process.env.GITHUB_REPOSITORY, "GitHub repository"),
    releaseProfile: requiredString(process.env.RELEASE_PROFILE, "release profile"),
    rerunGroup: requiredString(process.env.RERUN_GROUP, "rerun group"),
    targetSha: stringValue(process.env.TARGET_SHA),
    workflowSha: requiredString(process.env.GITHUB_SHA, "workflow SHA"),
    workflowRef: requiredString(process.env.GITHUB_REF_NAME, "workflow ref"),
  };
}

function candidateRequestFromInputs(planInputs) {
  return buildFullReleaseCandidateRequest(planInputs.candidateRequestInput);
}

function candidateRequestFromEnvironment() {
  return buildFullReleaseCandidateRequest({
    repository: process.env.GITHUB_REPOSITORY,
    targetSha: process.env.TARGET_SHA,
    toolingSha: process.env.GITHUB_SHA,
    releaseProfile: process.env.RELEASE_PROFILE,
    releaseSoak: requiredBoolean(process.env.CANDIDATE_RELEASE_SOAK, "candidate release soak"),
    upgradeSurvivorBaseline: process.env.CANDIDATE_UPGRADE_SURVIVOR_BASELINE,
    upgradeSurvivorBaselines: process.env.CANDIDATE_UPGRADE_SURVIVOR_BASELINES,
    upgradeSurvivorScenarios: process.env.CANDIDATE_UPGRADE_SURVIVOR_SCENARIOS,
    allowFrozenTargetScenarioOmissions: requiredBoolean(
      process.env.CANDIDATE_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS,
      "candidate frozen-target policy",
    ),
    allowUnreleasedChangelog: requiredBoolean(
      process.env.CANDIDATE_ALLOW_UNRELEASED_CHANGELOG,
      "candidate changelog policy",
    ),
    sharedImagePolicy: process.env.CANDIDATE_SHARED_IMAGE_POLICY,
  });
}

function evidenceReuseFromInputs(planInputs, sourceManifest = {}) {
  return {
    changedPaths: changedPathsValue(planInputs.evidenceChangedPaths),
    evidenceSha: stringValue(planInputs.evidenceSha),
    policy: stringValue(planInputs.evidencePolicy),
    requested: planInputs.evidenceReuse === true || planInputs.evidenceReuse === "true",
    rootRunId: stringValue(planInputs.evidenceRootRunId),
    runUrl: stringValue(planInputs.evidenceRunUrl),
    selectedRunId: stringValue(planInputs.evidenceRunId),
    sourceManifest,
  };
}

function trustedWorkflowFromInputs(planInputs) {
  return planInputs.trustedWorkflow;
}

function candidateFromInputs(planInputs, gates) {
  const candidate = planInputs.candidateEvidence ?? null;
  const bindingRequired = gates.some(
    (gate) =>
      ["Acquire full release candidate", "Prepare shared release candidate"].includes(gate.name) &&
      gate.required,
  );
  if (!bindingRequired) {
    if (candidate !== null) {
      throw new Error("release candidate evidence exists when candidate binding is not required");
    }
    return null;
  }
  if (
    stringValue(planInputs.candidateAcquisitionResult ?? planInputs.candidateBindingResult) ===
    "success"
  ) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("successful release candidate binding omitted producer evidence");
    }
    return candidate;
  }
  if (candidate !== null) {
    throw new Error("release candidate evidence exists without successful binding");
  }
  return null;
}

async function planMode() {
  const outputPath = requiredString(
    process.env.FULL_RELEASE_EXECUTION_PLAN_PATH,
    "execution plan output path",
  );
  const expected = planExpected();
  const currentAttempt = positiveInteger(process.env.GITHUB_RUN_ATTEMPT, "parent run attempt");

  if (process.env.FULL_RELEASE_RESTORE_PLAN === "true") {
    const restoredPayload = readArtifact(outputPath, "execution plan");
    const restored = validateReleaseExecutionPlanArtifact(restoredPayload, {
      ...expected,
      ...(restoredPayload.attemptEvidenceVersion !== undefined
        ? { candidateRequest: candidateRequestFromEnvironment() }
        : {}),
      sourceParentRunAttempt: 1,
    });
    writeExecutionPlan(outputPath, restored);
    return;
  }
  if (currentAttempt !== 1) {
    throw new Error("collector retry omitted the immutable attempt-one execution plan");
  }

  const planInputs = {
    ...parsePlanInputs(process.env.FULL_RELEASE_PLAN_INPUTS_JSON),
    releaseProfile: expected.releaseProfile,
  };
  const attemptEvidenceVersion = Number(planInputs.childPhaseVersion) === 3 ? 3 : 2;
  const built = buildReleaseExecutionPlan(planInputs);
  const candidate = candidateFromInputs(planInputs, built.gates);
  const candidateRequest = candidateRequestFromInputs(planInputs);
  const abortController = new AbortController();
  let finished = false;
  let plan = buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion,
    candidate,
    coveragePolicy: planInputs.coveragePolicy,
    children: built.children,
    evidenceReuse: evidenceReuseFromInputs(planInputs),
    expected: { ...expected, candidateRequest, parentRunAttempt: currentAttempt },
    gates: built.gates,
    releaseProfile: expected.releaseProfile,
    rerunGroup: expected.rerunGroup,
    telegramWaiver: planInputs.telegramWaiver,
    targetVersion: planInputs.targetVersion,
    trustedWorkflow: trustedWorkflowFromInputs(planInputs),
  });
  const stop = () => {
    if (finished) {
      return;
    }
    abortController.abort(new Error("execution plan collection cancelled"));
    plan = buildReleaseExecutionPlanArtifact({
      attemptEvidenceVersion,
      blockers: plan.blockers,
      candidate: plan.candidate,
      coveragePolicy: plan.coveragePolicy,
      children: plan.children,
      errors: [
        ...plan.errors,
        {
          child: "<collector>",
          kind: "collector_cancelled",
          message: "execution plan collector received a termination signal",
        },
      ],
      evidenceReuse: plan.evidenceReuse,
      expected: {
        ...expected,
        candidateRequest: plan.candidateRequest,
        parentRunAttempt: currentAttempt,
      },
      gates: plan.gates,
      releaseProfile: expected.releaseProfile,
      rerunGroup: expected.rerunGroup,
      telegramWaiver: plan.telegramWaiver,
      targetVersion: plan.targetVersion,
      trustedWorkflow: plan.trustedWorkflow,
    });
    writeExecutionPlan(outputPath, plan);
    finished = true;
    process.exit(1);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const reuse = await validateReuse(plan, abortController.signal);
  if (finished) {
    return;
  }
  plan = buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion,
    blockers: reuse.blockers,
    candidate,
    coveragePolicy: planInputs.coveragePolicy,
    children: reuse.children,
    errors: reuse.errors,
    evidenceReuse: evidenceReuseFromInputs(planInputs, reuse.sourceManifest),
    expected: { ...expected, candidateRequest, parentRunAttempt: currentAttempt },
    gates: built.gates,
    releaseProfile: expected.releaseProfile,
    rerunGroup: expected.rerunGroup,
    telegramWaiver: planInputs.telegramWaiver,
    targetVersion: planInputs.targetVersion,
    trustedWorkflow: trustedWorkflowFromInputs(planInputs),
  });
  writeExecutionPlan(outputPath, plan);
  finished = true;
  if ((reuse.blockers?.length ?? 0) > 0 || (reuse.errors?.length ?? 0) > 0) {
    throw new Error("release execution plan could not bind reusable evidence");
  }
}

async function collectMode(mode) {
  const expected = {
    parentRunAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT, "parent run attempt"),
    parentRunId: requiredString(process.env.GITHUB_RUN_ID, "parent run ID"),
    repository: requiredString(process.env.GITHUB_REPOSITORY, "GitHub repository"),
    targetSha: stringValue(process.env.TARGET_SHA),
    workflowRef: requiredString(process.env.GITHUB_REF_NAME, "workflow ref"),
    workflowSha: requiredString(process.env.GITHUB_SHA, "workflow SHA"),
  };
  const releaseProfile = requiredString(process.env.RELEASE_PROFILE, "release profile");
  const rerunGroup = requiredString(process.env.RERUN_GROUP, "rerun group");
  const outputPath = requiredString(process.env.FULL_RELEASE_STATE_PATH, "state output path");
  const executionPlan = validateReleaseExecutionPlanArtifact(
    readArtifact(
      requiredString(process.env.FULL_RELEASE_EXECUTION_PLAN_PATH, "execution plan path"),
      "execution plan",
    ),
    {
      parentRunId: expected.parentRunId,
      repository: expected.repository,
      releaseProfile,
      rerunGroup,
      targetSha: expected.targetSha,
      workflowSha: expected.workflowSha,
    },
  );
  const plan = executionPlan.children;
  const gateFailures = releasePlanGateFailures(executionPlan.gates);
  const failFast = mode === "decision" && process.env.FAIL_FAST === "true";
  const pollIntervalMs =
    Number(process.env.FULL_RELEASE_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs =
    Number(process.env.FULL_RELEASE_HEARTBEAT_INTERVAL_MS) || DEFAULT_HEARTBEAT_INTERVAL_MS;
  const cancelledRunIds = new Set();
  let snapshots = plan.map((child) => ({
    ...child,
    errors: [],
    jobs: [],
    status: child.selected && child.runId ? "queued" : child.selected ? "missing" : "skipped",
  }));
  let finished = false;
  const abortController = new AbortController();
  let decisionReuse = { blockers: [], children: plan, errors: [] };
  let transport = { status: "certain" };

  const writePayload = (decision, cancellation = {}) => {
    const payload = buildReleaseStateArtifact({
      cancellation,
      children: snapshots,
      decision,
      executionPlan,
      expected,
      mode,
      releaseProfile,
      rerunGroup,
      transport,
    });
    writeResult(outputPath, payload);
    appendSummary(mode, payload);
    return payload;
  };
  const stop = () => {
    if (finished) {
      return;
    }
    abortController.abort(new Error(`${mode} collector cancelled`));
    const decision = classifyReleaseSnapshot({
      cancelled: true,
      children: snapshots,
      extraBlockers: executionPlan.blockers,
      extraErrors: [
        ...executionPlan.errors,
        ...(transport.error ? [transport.error] : []),
        {
          child: "<collector>",
          kind: "collector_cancelled",
          message: `${mode} collector received a termination signal`,
        },
      ],
      localFailures: gateFailures,
      releaseProfile,
      workflowRef: expected.workflowRef,
    });
    writePayload(decision, { cancelledRunIds, requested: true });
    finished = true;
    process.exit(1);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  if (mode === "decision" && executionPlan.evidenceReuse.requested) {
    decisionReuse = await validateReuse(executionPlan, abortController.signal);
    const exactPlan = JSON.stringify(
      plan.map(({ key, runAttempt, runId }) => ({ key, runAttempt, runId })),
    );
    const revalidatedPlan = JSON.stringify(
      decisionReuse.children.map(({ key, runAttempt, runId }) => ({ key, runAttempt, runId })),
    );
    if (exactPlan !== revalidatedPlan) {
      decisionReuse = {
        ...decisionReuse,
        blockers: [
          ...decisionReuse.blockers,
          {
            child: "<evidence>",
            kind: "provenance_mismatch",
            message: "revalidated evidence child identities differ from the immutable plan",
            runId: executionPlan.evidenceReuse.rootRunId,
            url: executionPlan.evidenceReuse.runUrl,
          },
        ],
      };
    }
    if (
      JSON.stringify(sortJsonValueKeys(decisionReuse.sourceManifest)) !==
      JSON.stringify(sortJsonValueKeys(executionPlan.evidenceReuse.sourceManifest))
    ) {
      decisionReuse = {
        ...decisionReuse,
        blockers: [
          ...decisionReuse.blockers,
          {
            child: "<evidence>",
            kind: "provenance_mismatch",
            message: "revalidated evidence source manifest differs from the immutable plan",
            runId: executionPlan.evidenceReuse.rootRunId,
            url: executionPlan.evidenceReuse.runUrl,
          },
        ],
      };
    }
  }

  let nextHeartbeat = 0;
  while (!finished) {
    ghRetryDeadline = transport.deadlineMonotonicMs;
    snapshots = await Promise.all(
      plan.map((child, index) => readChild(child, snapshots[index], abortController.signal)),
    );
    transport = updateReleaseTransportEpisode(transport, snapshots);
    const transportReadErrors = transport.error ? [transport.error] : [];
    let decision = classifyReleaseSnapshot({
      children: snapshots,
      extraBlockers: [...executionPlan.blockers, ...decisionReuse.blockers],
      extraErrors: [...transportReadErrors, ...executionPlan.errors, ...decisionReuse.errors],
      localFailures: gateFailures,
      releaseProfile,
      workflowRef: expected.workflowRef,
    });
    if (Date.now() >= nextHeartbeat) {
      console.log(formatReleaseStateHeartbeat(mode, decision));
      nextHeartbeat = Date.now() + heartbeatIntervalMs;
    }
    if (failFast && decision.blockers.length > 0) {
      const cancellationErrors = await cancelAffectedChildren(
        snapshots,
        decision.blockers,
        cancelledRunIds,
        abortController.signal,
      );
      if (cancellationErrors.length > 0) {
        decision = classifyReleaseSnapshot({
          children: snapshots,
          extraBlockers: [
            ...executionPlan.blockers,
            ...decisionReuse.blockers,
            ...decision.blockers,
          ],
          extraErrors: [
            ...transportReadErrors,
            ...executionPlan.errors,
            ...decisionReuse.errors,
            ...cancellationErrors,
          ],
          localFailures: gateFailures,
          releaseProfile,
          workflowRef: expected.workflowRef,
        });
      }
    }
    const done =
      mode === "decision"
        ? decision.state !== "qualifying" &&
          !(decision.state === "passed" && transport.status === "uncertain")
        : transport.status !== "uncertain" &&
          (decision.state === "orchestration_error" ||
            (decision.state !== "qualifying" && decision.activeRunIds.length === 0));
    if (done) {
      const payload = writePayload(decision, { cancelledRunIds, requested: false });
      finished = true;
      process.exitCode =
        payload.state === "passed" ? 0 : payload.state === "orchestration_error" ? 2 : 1;
      return;
    }
    await abortableSleep(
      deadlineDelayMs(pollIntervalMs, transport.deadlineMonotonicMs, performance.now()),
      abortController.signal,
    );
  }
}

function readStateCandidates(root, prefix, runId, maxParentRunAttempt, filename) {
  const pattern = new RegExp(`^${prefix}-${runId}-([1-9][0-9]*)$`, "u");
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = pattern.exec(entry.name);
      return match ? { attempt: Number(match[1]), name: entry.name } : undefined;
    })
    .filter(Boolean)
    .filter((entry) => entry.attempt <= maxParentRunAttempt)
    .map((entry) => {
      const payload = readArtifact(join(root, entry.name, filename), entry.name);
      if (Number(payload.parentRunAttempt) !== entry.attempt) {
        throw new Error(`${entry.name} payload attempt differs from its artifact name`);
      }
      return { name: entry.name, payload };
    });
  const directPath = join(root, filename);
  if (existsSync(directPath)) {
    const payload = readArtifact(directPath, filename);
    const attempt = positiveInteger(payload.parentRunAttempt, `${filename} parent run attempt`);
    if (attempt <= maxParentRunAttempt) {
      candidates.push({ name: `${prefix}-${runId}-${attempt}`, payload });
    }
  }
  return candidates;
}

async function validateManifestMode() {
  const expected = {
    maxParentRunAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT, "parent run attempt"),
    parentRunId: requiredString(process.env.GITHUB_RUN_ID, "parent run ID"),
    repository: requiredString(process.env.GITHUB_REPOSITORY, "GitHub repository"),
    releaseProfile: requiredString(process.env.RELEASE_PROFILE, "release profile"),
    rerunGroup: requiredString(process.env.RERUN_GROUP, "rerun group"),
    targetSha: requiredString(process.env.TARGET_SHA, "target SHA"),
    workflowRef: requiredString(process.env.GITHUB_REF_NAME, "workflow ref"),
    workflowSha: requiredString(process.env.GITHUB_SHA, "workflow SHA"),
  };
  const manifestPath = requiredString(
    process.env.RELEASE_VALIDATION_MANIFEST_PATH,
    "release validation manifest path",
  );
  const executionPlanPayload = readArtifact(
    requiredString(process.env.RELEASE_EXECUTION_PLAN_PATH, "execution plan path"),
    "execution plan",
  );
  const executionPlan = validateReleaseExecutionPlanArtifact(executionPlanPayload, expected);
  const verified =
    executionPlan.attemptEvidenceVersion !== undefined
      ? verifyReleaseStateArtifacts(
          executionPlanPayload,
          readArtifact(
            requiredString(process.env.RELEASE_DECISION_PATH, "release decision path"),
            "release decision",
          ),
          readArtifact(
            requiredString(process.env.DIAGNOSTIC_DRAIN_PATH, "diagnostic drain path"),
            "diagnostic drain",
          ),
          expected,
        )
      : undefined;
  const drain = verified?.drain;
  const rawManifest = readArtifact(manifestPath, "release validation manifest");
  const { validateParentManifest } = await import("./release-ci-summary.mjs");
  const manifest = validateParentManifest(rawManifest, {
    candidateBinding: executionPlan.candidate ?? null,
    repository: expected.repository,
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT, "parent run attempt"),
    runId: executionPlan.parentRunId,
    workflowRef: executionPlan.workflowRef,
    workflowSha: executionPlan.workflowSha,
  });
  validateReleaseTelegramWaiverBinding(executionPlan, manifest.validationInputs);
  validateReleaseCoveragePolicyBinding(executionPlan, manifest.validationInputs);
  const expectedChildRunIds = Object.fromEntries(
    executionPlan.children.map((child) => [
      child.key,
      child.selected ? stringValue(child.runId) : "",
    ]),
  );
  const expectedEvidenceReuse = executionPlan.evidenceReuse.requested
    ? {
        changedPaths: executionPlan.evidenceReuse.changedPaths,
        evidenceSha: executionPlan.evidenceReuse.evidenceSha,
        policy: executionPlan.evidenceReuse.policy,
        runId: executionPlan.evidenceReuse.rootRunId,
        selectedRunId: executionPlan.evidenceReuse.selectedRunId,
      }
    : undefined;
  const expectedChildEvidence = drain
    ? Object.fromEntries(
        Object.entries(drain.children).map(([key, child]) => [
          key,
          {
            compositeJobsSha256: child.compositeJobsSha256,
            dispatchActor: child.dispatchActor,
            effectiveRunAttempt: child.runAttempt,
            jobs: child.timing.jobs.map((job) => ({
              acceptedRunAttempt: job.acceptedRunAttempt,
              completedAt: job.completedAt,
              conclusion: job.conclusion,
              name: job.name,
              startedAt: job.startedAt,
              status: job.status,
              url: job.url,
            })),
            observedRunAttempts: child.observedRunAttempts,
            plannedRunAttempt: child.plannedRunAttempt,
            repository: child.repository,
            runId: child.runId,
            triggeringActor: child.triggeringActor,
          },
        ]),
      )
    : undefined;
  if (
    manifest.targetSha !== executionPlan.targetSha ||
    manifest.releaseProfile !== executionPlan.releaseProfile ||
    manifest.rerunGroup !== executionPlan.rerunGroup ||
    JSON.stringify(sortJsonValueKeys(manifest.childRunIds)) !==
      JSON.stringify(sortJsonValueKeys(expectedChildRunIds)) ||
    JSON.stringify(sortJsonValueKeys(manifest.evidenceReuse)) !==
      JSON.stringify(sortJsonValueKeys(expectedEvidenceReuse)) ||
    (executionPlan.attemptEvidenceVersion !== undefined &&
      JSON.stringify(sortJsonValueKeys(rawManifest.childEvidence)) !==
        JSON.stringify(sortJsonValueKeys(expectedChildEvidence))) ||
    rawManifest.executionPlanSha256 !== executionPlan.sha256 ||
    Number(rawManifest.sourceParentRunAttempt) !== executionPlan.parentRunAttempt
  ) {
    throw new Error("release validation manifest differs from the immutable execution plan");
  }
  writeArtifact(manifestPath, rawManifest);
}

function selectMode() {
  const expected = {
    maxParentRunAttempt: positiveInteger(
      process.env.GITHUB_RUN_ATTEMPT,
      "current parent run attempt",
    ),
    parentRunId: requiredString(process.env.GITHUB_RUN_ID, "parent run ID"),
    repository: requiredString(process.env.GITHUB_REPOSITORY, "GitHub repository"),
    releaseProfile: requiredString(process.env.RELEASE_PROFILE, "release profile"),
    rerunGroup: requiredString(process.env.RERUN_GROUP, "rerun group"),
    targetSha: requiredString(process.env.TARGET_SHA, "target SHA"),
    workflowRef: requiredString(process.env.GITHUB_REF_NAME, "workflow ref"),
    workflowSha: requiredString(process.env.GITHUB_SHA, "workflow SHA"),
  };
  const selected = selectReleaseStateArtifacts(
    readArtifact(
      requiredString(process.env.RELEASE_EXECUTION_PLAN_PATH, "execution plan path"),
      "execution plan",
    ),
    readStateCandidates(
      requiredString(process.env.RELEASE_DECISION_ATTEMPTS_PATH, "decision attempts path"),
      "full-release-decision",
      expected.parentRunId,
      expected.maxParentRunAttempt,
      "full-release-decision.json",
    ),
    readStateCandidates(
      requiredString(process.env.DIAGNOSTIC_DRAIN_ATTEMPTS_PATH, "drain attempts path"),
      "full-release-diagnostics",
      expected.parentRunId,
      expected.maxParentRunAttempt,
      "full-release-diagnostic-manifest.json",
    ),
    expected,
  );
  writeArtifact(
    requiredString(process.env.RELEASE_DECISION_PATH, "selected decision path"),
    selected.decision,
  );
  writeArtifact(
    requiredString(process.env.DIAGNOSTIC_DRAIN_PATH, "selected drain path"),
    selected.drain,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `decision_source_attempt=${selected.sourceAttempts.decision}\n`,
    );
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `drain_source_attempt=${selected.sourceAttempts.drain}\n`,
    );
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "plan") {
    await planMode();
    return;
  }
  if (mode === "verify") {
    verifyMode();
    return;
  }
  if (mode === "select") {
    selectMode();
    return;
  }
  if (mode === "validate-manifest") {
    await validateManifestMode();
    return;
  }
  if (!["decision", "drain"].includes(mode)) {
    throw new Error(
      "usage: full-release-validation-state.mjs <plan|decision|drain|select|validate-manifest|verify>",
    );
  }
  await collectMode(mode);
}

if (process.argv[1]?.endsWith("full-release-validation-state.mjs")) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
