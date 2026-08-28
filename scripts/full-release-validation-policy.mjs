import { createHash } from "node:crypto";
import {
  validateFullReleaseCandidateBinding,
  validateFullReleaseCandidateRequest,
} from "./full-release-candidate-contract.mjs";

const SUCCESSFUL_JOB_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);
const MAX_REPORTED_ISSUES = 25;
const MAX_SUMMARY_ISSUES = 5;
const MAX_LABEL_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;
const MAX_URL_LENGTH = 1024;
const EXACT_TARGET_EVIDENCE_REUSE_POLICY = "exact-target-full-validation-v1";
const CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY = "changelog-only-release-v1";
const HARD_GH_TRANSPORT_PATTERN =
  /HTTP (?:400|401|403|404|410|422)\b|Bad credentials|authentication required|not authenticated|gh auth login|unknown (?:command|flag)|Usage: gh\b|ENOENT|EACCES/iu;
const TRANSIENT_GH_TRANSPORT_PATTERN =
  /HTTP 429\b|HTTP 5[0-9][0-9]\b|Server Error|secondary rate limit|API rate limit|abuse detection|error connecting to|context deadline exceeded|connection reset by peer|connection refused|TLS handshake timeout|i\/o timeout|timed out|\btimeout\b|network is unreachable|unexpected EOF|ETIMEDOUT|ECONNRESET|EAI_AGAIN/iu;
const RELEASE_GH_ARTIFACT_MISSING_LINE_PATTERN =
  /^(?:no valid artifacts found(?: to download)?|no artifact matches any of the names(?: or patterns)? provided|could not find any artifacts|artifact .+ not found)$/iu;
const RELEASE_GH_ARTIFACT_CONTENT_ERROR_PATTERN =
  /unexpected end of JSON|\b(?:artifact|archive|JSON)\b.{0,80}\b(?:malformed|invalid|oversized|too large|exceeds? (?:the )?size limit)\b|\b(?:malformed|invalid|oversized)\b.{0,80}\b(?:artifact|archive|JSON)\b/iu;

const RELEASE_DECISION_STATES = Object.freeze([
  "qualifying",
  "blocked_diagnostics_running",
  "passed",
  "blocked_complete",
  "orchestration_error",
  "cancelled_with_children",
]);

const RELEASE_DECISION_STATE_SET = new Set(RELEASE_DECISION_STATES);
const CHILD_SPECS = Object.freeze([
  {
    dispatchName: "Dispatch CI",
    displayName: "CI",
    key: "normalCi",
    parentJobName: "Run normal full CI",
    rerunGroups: ["all", "ci"],
    suffix: "-ci",
    workflow: "ci.yml",
  },
  {
    dispatchName: "Dispatch plugin prerelease",
    displayName: "Plugin Prerelease",
    key: "pluginPrerelease",
    parentJobName: "Run plugin prerelease validation",
    rerunGroups: ["all", "plugin-prerelease"],
    suffix: "-plugin-prerelease",
    workflow: "plugin-prerelease.yml",
  },
  {
    dispatchName: "Dispatch release checks",
    displayName: "OpenClaw Release Checks",
    key: "releaseChecks",
    parentJobName: "Run release/live/Docker/QA validation",
    rerunGroups: [
      "all",
      "install-smoke",
      "cross-os",
      "live-e2e",
      "package",
      "qa-parity",
      "qa-live",
    ],
    suffix: "-release-checks",
    workflow: "openclaw-release-checks.yml",
  },
  {
    dispatchName: "Dispatch npm Telegram E2E",
    displayName: "NPM Telegram Beta E2E",
    key: "npmTelegram",
    parentJobName: "Run package Telegram E2E",
    rerunGroups: ["npm-telegram"],
    suffix: "-npm-telegram",
    workflow: "npm-telegram-beta-e2e.yml",
  },
  {
    dispatchName: "Dispatch OpenClaw Performance",
    displayName: "OpenClaw Performance",
    key: "productPerformance",
    parentJobName: "Run product performance evidence",
    rerunGroups: ["all", "performance"],
    suffix: "",
    workflow: "openclaw-performance.yml",
  },
]);
const HISTORICAL_EXECUTION_PLAN_KEYS = Object.freeze(
  [
    "blockers",
    "children",
    "errors",
    "evidenceReuse",
    "gates",
    "kind",
    "parentRunAttempt",
    "parentRunId",
    "releaseProfile",
    "rerunGroup",
    "sha256",
    "targetSha",
    "trustedWorkflow",
    "version",
    "workflowRef",
    "workflowSha",
  ].toSorted(),
);
const ATTEMPT_AWARE_V2_EXECUTION_PLAN_KEYS = Object.freeze(
  [
    ...HISTORICAL_EXECUTION_PLAN_KEYS,
    "attemptEvidenceVersion",
    "candidate",
    "candidateRequest",
    "repository",
  ].toSorted((left, right) => left.localeCompare(right)),
);
const HISTORICAL_EXECUTION_PLAN_CHILD_KEYS = Object.freeze(
  [
    "dispatchName",
    "displayTitle",
    "key",
    "required",
    "result",
    "runAttempt",
    "runId",
    "selected",
    "source",
    "url",
    "workflow",
    "workflowRef",
    "workflowSha",
  ].toSorted(),
);
const ATTEMPT_AWARE_EXECUTION_PLAN_CHILD_KEYS = Object.freeze(
  [...HISTORICAL_EXECUTION_PLAN_CHILD_KEYS, "sourceParentAttempt"].toSorted((left, right) =>
    left.localeCompare(right),
  ),
);

function releaseGhTransportErrorText(error) {
  const values = [error];
  const seen = new Set();
  const parts = [];
  while (values.length > 0) {
    const value = values.shift();
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      if (value instanceof Error) {
        parts.push(value.name, value.message);
      }
      for (const key of ["stderr", "stdout", "code", "signal", "cause"]) {
        if (key in value && value[key] !== undefined) {
          values.push(value[key]);
        }
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      parts.push(String(value));
    }
  }
  return parts.join("\n");
}

export function classifyReleaseGhTransportError(error) {
  const text = releaseGhTransportErrorText(error);
  if (HARD_GH_TRANSPORT_PATTERN.test(text)) {
    return "hard";
  }
  return TRANSIENT_GH_TRANSPORT_PATTERN.test(text) ? "transient" : "ambiguous";
}

export function isReleaseGhArtifactMissingError(error) {
  if (classifyReleaseGhTransportError(error) !== "ambiguous") {
    return false;
  }
  const text = releaseGhTransportErrorText(error);
  if (RELEASE_GH_ARTIFACT_CONTENT_ERROR_PATTERN.test(text)) {
    return false;
  }
  return text
    .split(/\r?\n/u)
    .some((line) => RELEASE_GH_ARTIFACT_MISSING_LINE_PATTERN.test(line.trim()));
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function boundedString(value, maxLength) {
  return stringValue(value)
    .replaceAll(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function positiveInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function booleanValue(value) {
  return value === true || value === "true";
}

export function releaseChildSpec(key) {
  const spec = CHILD_SPECS.find((entry) => entry.key === key);
  if (!spec) {
    throw new Error(`release child key is invalid: `);
  }
  return spec;
}

function normalizedAttemptJob(job, runAttempt) {
  const name = boundedString(job?.name, MAX_LABEL_LENGTH);
  if (!name) {
    throw new Error(`release child attempt ${runAttempt} contains an unnamed job`);
  }
  return {
    acceptedRunAttempt: runAttempt,
    completedAt: stringValue(job?.completed_at ?? job?.completedAt),
    conclusion: boundedString(job?.conclusion, MAX_LABEL_LENGTH),
    name,
    startedAt: stringValue(job?.started_at ?? job?.startedAt),
    status: boundedString(job?.status, MAX_LABEL_LENGTH),
    url: boundedString(job?.html_url ?? job?.url, MAX_URL_LENGTH),
  };
}

export function validateReleaseChildRunProvenance(run, expected = {}) {
  const plannedRunAttempt = positiveInteger(expected.plannedRunAttempt);
  const effectiveRunAttempt = positiveInteger(run?.run_attempt);
  const path = stringValue(run?.path).split("@", 1)[0];
  const dispatchActor = boundedString(run?.actor?.login, MAX_LABEL_LENGTH);
  const triggeringActor = boundedString(run?.triggering_actor?.login, MAX_LABEL_LENGTH);
  if (
    plannedRunAttempt === undefined ||
    effectiveRunAttempt === undefined ||
    effectiveRunAttempt < plannedRunAttempt ||
    String(run?.id ?? "") !== String(expected.runId ?? "") ||
    run?.event !== "workflow_dispatch" ||
    path !== `.github/workflows/${expected.workflow}` ||
    run?.display_title !== expected.displayTitle ||
    run?.head_branch !== expected.workflowRef ||
    run?.head_sha !== expected.workflowSha ||
    (expected.repository !== undefined &&
      run?.repository?.full_name !== String(expected.repository)) ||
    dispatchActor !== "github-actions[bot]" ||
    !triggeringActor ||
    (effectiveRunAttempt === plannedRunAttempt && triggeringActor !== "github-actions[bot]")
  ) {
    throw new Error(`release child provenance changed: ${expected.key ?? expected.runId}`);
  }
  return {
    dispatchActor,
    effectiveRunAttempt,
    repository: stringValue(run?.repository?.full_name, stringValue(expected.repository)),
    triggeringActor,
  };
}

function compositeJobsDigestPayload(value) {
  return {
    effectiveRunAttempt: value.effectiveRunAttempt,
    jobs: value.jobs,
    plannedRunAttempt: value.plannedRunAttempt,
  };
}

export function releaseCompositeJobsSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(compositeJobsDigestPayload(value))))
    .digest("hex");
}

export function composeReleaseAttemptJobs(attempts, expected = {}) {
  const plannedRunAttempt = positiveInteger(expected.plannedRunAttempt);
  const effectiveRunAttempt = positiveInteger(expected.effectiveRunAttempt);
  if (
    plannedRunAttempt === undefined ||
    effectiveRunAttempt === undefined ||
    effectiveRunAttempt < plannedRunAttempt
  ) {
    throw new Error("release child attempt range is invalid");
  }
  if (!Array.isArray(attempts)) {
    throw new Error("release child attempt evidence is invalid");
  }
  const normalizedAttempts = attempts.map((attempt) => ({
    jobs: Array.isArray(attempt?.jobs) ? attempt.jobs : [],
    runAttempt: positiveInteger(attempt?.runAttempt),
  }));
  const expectedCount = effectiveRunAttempt - plannedRunAttempt + 1;
  if (normalizedAttempts.length !== expectedCount) {
    throw new Error("release child attempt evidence is gapped");
  }

  const accepted = new Map();
  for (let index = 0; index < normalizedAttempts.length; index += 1) {
    const attempt = normalizedAttempts[index];
    const expectedAttempt = plannedRunAttempt + index;
    if (attempt.runAttempt !== expectedAttempt || attempt.jobs.length === 0) {
      throw new Error("release child attempt evidence is gapped");
    }
    const names = new Set();
    for (const rawJob of attempt.jobs) {
      const job = normalizedAttemptJob(rawJob, expectedAttempt);
      if (names.has(job.name)) {
        throw new Error(
          `release child attempt ${expectedAttempt} contains duplicate job identity: ${job.name}`,
        );
      }
      names.add(job.name);
      accepted.set(job.name, job);
    }
  }

  const composite = {
    effectiveRunAttempt,
    jobs: [...accepted.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    plannedRunAttempt,
  };
  return { ...composite, sha256: releaseCompositeJobsSha256(composite) };
}

export function composeReleaseChildAttemptEvidence({ attempts, expected, run }) {
  const provenance = validateReleaseChildRunProvenance(run, expected);
  const composite = composeReleaseAttemptJobs(attempts, {
    effectiveRunAttempt: provenance.effectiveRunAttempt,
    plannedRunAttempt: expected.plannedRunAttempt,
  });
  return {
    compositeJobsSha256: composite.sha256,
    dispatchActor: provenance.dispatchActor,
    effectiveRunAttempt: composite.effectiveRunAttempt,
    jobs: composite.jobs,
    observedRunAttempts: attempts.map((attempt) => attempt.runAttempt),
    plannedRunAttempt: composite.plannedRunAttempt,
    repository: provenance.repository,
    runId: String(run.id),
    triggeringActor: provenance.triggeringActor,
  };
}

export function validateReleaseChildDispatchBinding({
  child,
  log,
  plannedRunAttempt,
  repository,
  targetSha,
}) {
  const escapedRepo = String(repository).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactPattern = new RegExp(
    `https://github\\.com/${escapedRepo}/actions/runs/([1-9][0-9]*) \\(attempt ([1-9][0-9]*)\\)`,
    "gu",
  );
  const urlPattern = new RegExp(
    `https://github\\.com/${escapedRepo}/actions/runs/([1-9][0-9]*)`,
    "gu",
  );
  const exact = Array.from(String(log).matchAll(exactPattern), (match) => ({
    runAttempt: Number(match[2]),
    runId: match[1],
  }));
  const runIds = [...new Set(Array.from(String(log).matchAll(urlPattern), (match) => match[1]))];
  const exactBound =
    exact.length === 1 &&
    exact[0].runId === String(child.runId) &&
    exact[0].runAttempt === Number(plannedRunAttempt);
  const historicalUrlBound =
    exact.length === 0 && runIds.length === 1 && runIds[0] === String(child.runId);
  if (!exactBound && !historicalUrlBound) {
    throw new Error(`release child is not uniquely emitted by its parent job: ${child.key}`);
  }
  if (child.key !== "npmTelegram" && !String(log).includes(`TARGET_SHA: ${targetSha}`)) {
    throw new Error(`release child parent target SHA changed: ${child.key}`);
  }
  if (child.key === "productPerformance" && !String(log).includes("-f publish_reports=false")) {
    throw new Error("release performance child is not dispatched in artifact-only mode");
  }
}

function candidatePreparationRequired(input) {
  if (
    booleanValue(input.evidenceReuse) ||
    stringValue(input.releasePackageSpec).trim() ||
    stringValue(input.packageAcceptancePackageSpec).trim()
  ) {
    return false;
  }
  if (["all", "plugin-prerelease", "cross-os", "package"].includes(input.rerunGroup)) {
    return true;
  }
  return input.rerunGroup === "live-e2e" && !stringValue(input.liveSuiteFilter).trim();
}

function canonicalSkippedPlanChild(spec, { evidenceReuse, expected }) {
  return {
    dispatchName: spec.dispatchName,
    displayTitle: `${spec.displayName} full-release-validation-${expected.parentRunId}-${expected.parentRunAttempt}${spec.suffix}`,
    key: spec.key,
    required: false,
    result: "skipped",
    runAttempt: null,
    runId: "",
    selected: false,
    source: evidenceReuse.requested ? "reused" : "fresh",
    sourceParentAttempt: null,
    url: "",
    workflow: spec.workflow,
    workflowRef: stringValue(expected.workflowRef).trim(),
    workflowSha: stringValue(expected.workflowSha).trim(),
  };
}

function executionPlanChildRequired(spec, rerunGroup) {
  if (spec.key !== "npmTelegram") {
    return spec.rerunGroups.includes(rerunGroup);
  }
  return rerunGroup === "all" || rerunGroup === "npm-telegram";
}

export function buildReleaseExecutionPlan(input) {
  const parentRunId = stringValue(input.parentRunId).trim();
  const parentRunAttempt = positiveInteger(input.parentRunAttempt);
  const rerunGroup = stringValue(input.rerunGroup).trim();
  if (!parentRunId || parentRunAttempt === undefined || !rerunGroup) {
    throw new Error("release execution plan identity is invalid");
  }
  const reused = booleanValue(input.evidenceReuse);
  const childInputs =
    input.children && typeof input.children === "object" && !Array.isArray(input.children)
      ? input.children
      : {};
  const npmTelegramForAll =
    rerunGroup === "all" &&
    Boolean(
      stringValue(input.npmTelegramPackageSpec).trim() ||
      stringValue(input.releasePackageSpec).trim(),
    );
  const children = CHILD_SPECS.map((spec) => {
    const raw = childInputs[spec.key] ?? {};
    const required =
      spec.key === "npmTelegram"
        ? rerunGroup === "npm-telegram" || npmTelegramForAll
        : spec.rerunGroups.includes(rerunGroup);
    const dispatchId = `full-release-validation-${parentRunId}-${parentRunAttempt}${spec.suffix}`;
    return {
      dispatchName: spec.dispatchName,
      displayTitle: `${spec.displayName} ${dispatchId}`,
      key: spec.key,
      required,
      result: stringValue(raw.result, "skipped"),
      runAttempt: positiveInteger(raw.runAttempt) ?? null,
      runId: stringValue(raw.runId).trim(),
      selected: required,
      source: reused ? "reused" : "fresh",
      sourceParentAttempt: null,
      url: stringValue(raw.url).trim(),
      workflow: spec.workflow,
      workflowRef: stringValue(input.workflowRef).trim(),
      workflowSha: stringValue(input.workflowSha).trim(),
    };
  });
  const gates = [
    {
      name: "Resolve target ref",
      required: true,
      result: stringValue(input.resolveTargetResult, "missing"),
    },
    {
      name: "Verify Docker runtime image assets",
      required: !reused && rerunGroup === "all",
      result: stringValue(input.dockerPreflightResult, "skipped"),
    },
    {
      name: "Prepare shared release candidate",
      required: candidatePreparationRequired(input),
      result: stringValue(input.candidateBindingResult, "skipped"),
    },
  ];
  return { children, gates };
}

function normalizedGate(gate) {
  return {
    name: boundedString(gate?.name, MAX_LABEL_LENGTH),
    required: gate?.required === true,
    result: boundedString(gate?.result, MAX_LABEL_LENGTH),
  };
}

function normalizedEvidenceReuse(evidenceReuse) {
  if (!evidenceReuse || evidenceReuse.requested !== true) {
    return { requested: false };
  }
  return {
    changedPaths: Array.isArray(evidenceReuse.changedPaths)
      ? evidenceReuse.changedPaths
          .map((value) => boundedString(value, MAX_LABEL_LENGTH))
          .filter(Boolean)
      : [],
    evidenceSha: boundedString(evidenceReuse.evidenceSha, MAX_LABEL_LENGTH),
    policy: boundedString(evidenceReuse.policy, MAX_LABEL_LENGTH),
    requested: true,
    rootRunId: boundedString(evidenceReuse.rootRunId, MAX_LABEL_LENGTH),
    runUrl: boundedString(evidenceReuse.runUrl, MAX_URL_LENGTH),
    selectedRunId: boundedString(evidenceReuse.selectedRunId, MAX_LABEL_LENGTH),
    sourceManifest:
      evidenceReuse.sourceManifest &&
      typeof evidenceReuse.sourceManifest === "object" &&
      !Array.isArray(evidenceReuse.sourceManifest)
        ? structuredClone(evidenceReuse.sourceManifest)
        : null,
  };
}

function validEvidenceReuseIdentity(evidenceReuse) {
  if (!evidenceReuse.requested) {
    return true;
  }
  const validChangedPaths =
    (evidenceReuse.policy === EXACT_TARGET_EVIDENCE_REUSE_POLICY &&
      evidenceReuse.changedPaths.length === 0) ||
    (evidenceReuse.policy === CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY &&
      evidenceReuse.changedPaths.length === 1 &&
      evidenceReuse.changedPaths[0] === "CHANGELOG.md");
  return (
    /^[a-f0-9]{40}$/u.test(evidenceReuse.evidenceSha) &&
    /^[1-9][0-9]*$/u.test(evidenceReuse.rootRunId) &&
    /^[1-9][0-9]*$/u.test(evidenceReuse.selectedRunId) &&
    evidenceReuse.sourceManifest !== null &&
    validChangedPaths
  );
}

function normalizedTrustedWorkflow(identity) {
  const ref = boundedString(identity?.ref, MAX_LABEL_LENGTH);
  const fullRef = boundedString(identity?.fullRef, MAX_LABEL_LENGTH);
  const sha = boundedString(identity?.sha, MAX_LABEL_LENGTH);
  if (
    !ref ||
    !/^[a-f0-9]{40}$/u.test(sha) ||
    (fullRef !== `refs/heads/${ref}` && fullRef !== `refs/tags/${ref}`)
  ) {
    throw new Error("release execution plan trusted workflow identity is invalid");
  }
  return { fullRef, ref, sha };
}

function hasExactKeys(value, expectedKeys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(expectedKeys)
  );
}

function releaseExecutionPlanShape(payload) {
  const hasAttemptEvidence = Object.hasOwn(payload, "attemptEvidenceVersion");
  const attemptEvidenceVersion = hasAttemptEvidence ? payload.attemptEvidenceVersion : undefined;
  const expectedPlanKeys = hasAttemptEvidence
    ? ATTEMPT_AWARE_V2_EXECUTION_PLAN_KEYS
    : HISTORICAL_EXECUTION_PLAN_KEYS;
  const expectedChildKeys = hasAttemptEvidence
    ? ATTEMPT_AWARE_EXECUTION_PLAN_CHILD_KEYS
    : HISTORICAL_EXECUTION_PLAN_CHILD_KEYS;
  if (
    (hasAttemptEvidence && attemptEvidenceVersion !== 2) ||
    !hasExactKeys(payload, expectedPlanKeys) ||
    !Array.isArray(payload.children) ||
    payload.children.some((child) => !hasExactKeys(child, expectedChildKeys))
  ) {
    throw new Error("release execution plan artifact schema is invalid");
  }
  return hasAttemptEvidence ? "attempt-aware-v2" : "historical";
}

function executionPlanDigestPayload(plan) {
  if (!Object.hasOwn(plan, "attemptEvidenceVersion")) {
    return {
      blockers: plan.blockers,
      children: plan.children,
      errors: plan.errors,
      evidenceReuse: plan.evidenceReuse,
      gates: plan.gates,
      kind: plan.kind,
      parentRunAttempt: plan.parentRunAttempt,
      parentRunId: plan.parentRunId,
      releaseProfile: plan.releaseProfile,
      rerunGroup: plan.rerunGroup,
      targetSha: plan.targetSha,
      trustedWorkflow: plan.trustedWorkflow,
      version: plan.version,
      workflowRef: plan.workflowRef,
      workflowSha: plan.workflowSha,
    };
  }
  return {
    attemptEvidenceVersion: plan.attemptEvidenceVersion,
    blockers: plan.blockers,
    candidate: plan.candidate,
    candidateRequest: plan.candidateRequest,
    children: plan.children,
    errors: plan.errors,
    evidenceReuse: plan.evidenceReuse,
    gates: plan.gates,
    kind: plan.kind,
    parentRunAttempt: plan.parentRunAttempt,
    parentRunId: plan.parentRunId,
    releaseProfile: plan.releaseProfile,
    repository: plan.repository,
    rerunGroup: plan.rerunGroup,
    targetSha: plan.targetSha,
    trustedWorkflow: plan.trustedWorkflow,
    version: plan.version,
    workflowRef: plan.workflowRef,
    workflowSha: plan.workflowSha,
  };
}

export function releaseExecutionPlanSha256(plan) {
  return createHash("sha256")
    .update(JSON.stringify(executionPlanDigestPayload(plan)))
    .digest("hex");
}

export function buildReleaseExecutionPlanArtifact({
  attemptEvidenceVersion,
  blockers = [],
  candidate = null,
  children,
  errors = [],
  evidenceReuse,
  expected,
  gates,
  releaseProfile,
  rerunGroup,
  trustedWorkflow,
}) {
  const attemptAware = attemptEvidenceVersion !== undefined;
  const normalizedAttemptEvidenceVersion = attemptAware
    ? Number(attemptEvidenceVersion)
    : undefined;
  if (attemptAware && normalizedAttemptEvidenceVersion !== 2) {
    throw new Error("release execution plan attempt evidence version is invalid");
  }
  const normalizedReuse = normalizedEvidenceReuse(evidenceReuse);
  if (!validEvidenceReuseIdentity(normalizedReuse)) {
    throw new Error("release execution plan evidence reuse binding is invalid");
  }
  const normalizedChildren = children.map((child) => {
    const spec = releaseChildSpec(child.key);
    return normalizedPlanChild(
      { ...child, dispatchName: spec.dispatchName },
      { sourceParentAttempt: attemptAware },
    );
  });
  for (const spec of CHILD_SPECS) {
    if (
      !normalizedChildren.some((child) => child.key === spec.key) &&
      !executionPlanChildRequired(spec, rerunGroup)
    ) {
      normalizedChildren.push(
        normalizedPlanChild(
          canonicalSkippedPlanChild(spec, {
            evidenceReuse: normalizedReuse,
            expected,
          }),
          { sourceParentAttempt: attemptAware },
        ),
      );
    }
  }
  const basePlan = {
    version: 1,
    kind: "openclaw.full-release-execution-plan",
    parentRunId: String(expected.parentRunId),
    parentRunAttempt: positiveInteger(expected.parentRunAttempt),
    workflowRef: boundedString(expected.workflowRef, MAX_LABEL_LENGTH),
    workflowSha: boundedString(expected.workflowSha, MAX_LABEL_LENGTH),
    targetSha: boundedString(expected.targetSha, MAX_LABEL_LENGTH),
    trustedWorkflow: normalizedTrustedWorkflow(trustedWorkflow),
    releaseProfile: boundedString(releaseProfile, MAX_LABEL_LENGTH),
    rerunGroup: boundedString(rerunGroup, MAX_LABEL_LENGTH),
    evidenceReuse: normalizedReuse,
    gates: gates.map(normalizedGate),
    children: normalizedChildren,
    blockers: normalizeIssues(blockers, "release_blocker"),
    errors: normalizeIssues(errors, "orchestration_error"),
  };
  if (!attemptAware) {
    return { ...basePlan, sha256: releaseExecutionPlanSha256(basePlan) };
  }
  const repository = boundedString(expected.repository, MAX_LABEL_LENGTH);
  const normalizedCandidateRequest = validateFullReleaseCandidateRequest(expected.candidateRequest);
  const plan = {
    ...basePlan,
    attemptEvidenceVersion: 2,
    repository,
    candidateRequest: normalizedCandidateRequest,
    candidate: candidate === null ? null : validateFullReleaseCandidateBinding(candidate),
  };
  validateCandidatePlanBinding(plan, expected.candidateRequest);
  return { ...plan, sha256: releaseExecutionPlanSha256(plan) };
}

function validateCandidatePlanBinding(plan, expectedCandidateRequest) {
  const request = validateFullReleaseCandidateRequest(plan.candidateRequest);
  if (
    request.repository !== plan.repository ||
    request.targetSha !== plan.targetSha ||
    request.toolingSha !== plan.workflowSha ||
    request.toolingSha !== plan.trustedWorkflow.sha ||
    request.releaseProfile !== plan.releaseProfile
  ) {
    throw new Error("release candidate request differs from the execution plan identity");
  }
  if (
    expectedCandidateRequest !== undefined &&
    JSON.stringify(request) !==
      JSON.stringify(validateFullReleaseCandidateRequest(expectedCandidateRequest))
  ) {
    throw new Error("release candidate request differs from the expected plan inputs");
  }
  if (plan.candidate !== null) {
    const candidate = validateFullReleaseCandidateBinding(plan.candidate);
    if (JSON.stringify(candidate.request) !== JSON.stringify(request)) {
      throw new Error("release candidate binding request differs from the execution plan");
    }
  }
}

export function validateReleaseExecutionPlanArtifact(payload, expected = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("release execution plan artifact is invalid");
  }
  const shape = releaseExecutionPlanShape(payload);
  const sha256 = releaseExecutionPlanSha256(payload);
  if (payload.sha256 !== sha256) {
    throw new Error("release execution plan artifact digest is invalid");
  }
  if (
    payload.version !== 1 ||
    payload.kind !== "openclaw.full-release-execution-plan" ||
    !/^[1-9][0-9]*$/u.test(String(payload.parentRunId ?? "")) ||
    positiveInteger(payload.parentRunAttempt) === undefined ||
    !/^[a-f0-9]{40}$/u.test(String(payload.workflowSha ?? "")) ||
    (payload.targetSha !== "" && !/^[a-f0-9]{40}$/u.test(String(payload.targetSha ?? ""))) ||
    (expected.parentRunId !== undefined &&
      String(payload.parentRunId) !== String(expected.parentRunId)) ||
    (expected.sourceParentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) !== Number(expected.sourceParentRunAttempt)) ||
    (expected.maxParentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) > Number(expected.maxParentRunAttempt)) ||
    (expected.workflowRef !== undefined && payload.workflowRef !== expected.workflowRef) ||
    (expected.workflowSha !== undefined && payload.workflowSha !== expected.workflowSha) ||
    (expected.releaseProfile !== undefined && payload.releaseProfile !== expected.releaseProfile) ||
    (expected.rerunGroup !== undefined && payload.rerunGroup !== expected.rerunGroup) ||
    (expected.targetSha !== undefined && payload.targetSha !== expected.targetSha) ||
    (shape === "attempt-aware-v2" &&
      expected.repository !== undefined &&
      payload.repository !== expected.repository)
  ) {
    throw new Error("release execution plan artifact binding is invalid");
  }
  const evidenceReuse = normalizedEvidenceReuse(payload.evidenceReuse);
  if (!validEvidenceReuseIdentity(evidenceReuse)) {
    throw new Error("release execution plan evidence reuse binding is invalid");
  }
  const trustedWorkflow = normalizedTrustedWorkflow(payload.trustedWorkflow);
  const children = validatePlan(payload.children, {
    sourceParentAttempt: shape !== "historical",
  });
  validateExecutionPlanChildBindings(children, payload);
  const plan = {
    ...payload,
    parentRunAttempt: positiveInteger(payload.parentRunAttempt),
    parentRunId: String(payload.parentRunId),
    children,
    blockers: normalizeIssues(payload.blockers, "release_blocker"),
    errors: normalizeIssues(payload.errors, "orchestration_error"),
    evidenceReuse,
    gates: Array.isArray(payload.gates) ? payload.gates.map(normalizedGate) : [],
    trustedWorkflow,
    ...(shape === "attempt-aware-v2"
      ? {
          attemptEvidenceVersion: 2,
          repository: String(payload.repository),
          candidateRequest: validateFullReleaseCandidateRequest(payload.candidateRequest),
          candidate:
            payload.candidate === null
              ? null
              : validateFullReleaseCandidateBinding(payload.candidate),
        }
      : {}),
  };
  if (shape === "attempt-aware-v2") {
    validateCandidatePlanBinding(plan, expected.candidateRequest);
  }
  return { ...plan, sha256 };
}

function normalizeIssue(issue, fallbackKind) {
  return {
    child: boundedString(issue?.child, MAX_LABEL_LENGTH),
    conclusion: boundedString(issue?.conclusion, MAX_LABEL_LENGTH),
    job: boundedString(issue?.job, MAX_LABEL_LENGTH),
    kind: boundedString(issue?.kind, MAX_LABEL_LENGTH) || fallbackKind,
    message: boundedString(issue?.message, MAX_MESSAGE_LENGTH),
    runId: boundedString(issue?.runId, MAX_LABEL_LENGTH),
    url: boundedString(issue?.url, MAX_URL_LENGTH),
  };
}

function normalizeIssues(issues, fallbackKind) {
  return (Array.isArray(issues) ? issues : [])
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => normalizeIssue(issue, fallbackKind));
}

function isReleaseCheckJobAdvisory({ jobName, releaseProfile, workflowRef }) {
  if (
    jobName.startsWith("Run QA Lab parity lane (") ||
    jobName === "Run QA Lab parity report" ||
    jobName.startsWith("Run QA Lab runtime-pair lane (") ||
    jobName === "Verify QA Lab runtime-pair lanes" ||
    jobName === "Run QA Lab live Discord lane" ||
    jobName === "Run QA Lab live WhatsApp lane" ||
    jobName === "Run QA Lab live Slack lane"
  ) {
    return true;
  }
  if (/^tideclaw\/alpha\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z$/u.test(workflowRef)) {
    return !(
      jobName === "resolve_target" ||
      jobName === "Prepare release package artifact" ||
      jobName.startsWith("install_smoke_release_checks / ") ||
      jobName === "Run package acceptance" ||
      jobName.startsWith("Run package acceptance / ")
    );
  }
  return (
    releaseProfile === "beta" &&
    (jobName.startsWith("Run package acceptance / Telegram package acceptance / ") ||
      (jobName.startsWith("Run repo/live E2E validation / ") &&
        (jobName.includes("Docker live") ||
          jobName.includes("Live media suites") ||
          jobName.includes("validate_live_provider_suites") ||
          jobName.includes("validate_release_live_cache") ||
          jobName.includes("prepare_live_test_image"))))
  );
}

function failedJobsForPolicy(child, releaseProfile, workflowRef) {
  return child.jobs.filter((job) => {
    if (
      job.status !== "completed" ||
      SUCCESSFUL_JOB_CONCLUSIONS.has(String(job.conclusion ?? ""))
    ) {
      return false;
    }
    if (child.key === "releaseChecks") {
      return !isReleaseCheckJobAdvisory({
        jobName: stringValue(job.name),
        releaseProfile,
        workflowRef,
      });
    }
    return !(child.key === "productPerformance" && releaseProfile === "beta");
  });
}

export function terminalPolicyPass(child, releaseProfile, workflowRef) {
  if (child.status !== "completed") {
    return false;
  }
  if (child.conclusion === "success") {
    return true;
  }
  if (child.key === "productPerformance" && releaseProfile === "beta") {
    return true;
  }
  if (child.key === "releaseChecks") {
    const verifier = child.jobs.find((job) => job.name === "Verify release checks");
    return (
      verifier?.status === "completed" &&
      verifier.conclusion === "success" &&
      failedJobsForPolicy(child, releaseProfile, workflowRef).length === 0
    );
  }
  return false;
}

function dispatchMissingBlockers(children) {
  return children
    .filter(
      (child) =>
        child.required &&
        child.selected &&
        (!/^[1-9][0-9]*$/u.test(String(child.runId ?? "")) ||
          positiveInteger(child.runAttempt) === undefined),
    )
    .map((child) => ({
      child: child.key,
      conclusion: stringValue(child.result, "missing"),
      job: child.dispatchName || `Dispatch ${child.key}`,
      kind: "dispatch_missing",
      message: `${child.key} required dispatch did not record an exact run ID and attempt`,
      runId: stringValue(child.runId),
      url: stringValue(child.url),
    }));
}

function dispatchResultBlockers(children) {
  return children
    .filter(
      (child) =>
        child.required && child.selected && child.source === "fresh" && child.result !== "success",
    )
    .map((child) => ({
      child: child.key,
      conclusion: stringValue(child.result, "missing"),
      job: child.dispatchName || `Dispatch ${child.key}`,
      kind: "dispatch_failed",
      message: `${child.key} required dispatch ended with ${stringValue(child.result, "missing")}`,
      runId: stringValue(child.runId),
      url: stringValue(child.url),
    }));
}

function releaseState(cancelled, activeRunIds, blockers, errors) {
  const active = activeRunIds.length > 0;
  return (
    (cancelled && active && "cancelled_with_children") ||
    (errors.length > 0 && "orchestration_error") ||
    (blockers.length > 0 && (active ? "blocked_diagnostics_running" : "blocked_complete")) ||
    (active ? "qualifying" : "passed")
  );
}

export function classifyReleaseSnapshot({
  cancelled = false,
  children,
  extraBlockers = [],
  extraErrors = [],
  localFailures = [],
  releaseProfile,
  workflowRef,
}) {
  const selected = children.filter((child) => child.selected);
  const active = selected.filter(
    (child) => child.runId && child.runAttempt && child.status !== "completed",
  );
  const childErrors = selected.flatMap((child) =>
    (child.errors ?? []).filter((error) => error.kind !== "dispatch_missing"),
  );
  const childJobBlockers = selected.flatMap((child) =>
    failedJobsForPolicy(child, releaseProfile, workflowRef).map((job) => ({
      child: child.key,
      conclusion: job.conclusion,
      job: job.name,
      kind: "job_failure",
      message: `${child.key} job failed policy`,
      runId: child.runId,
      url: job.html_url ?? job.url ?? child.url,
    })),
  );
  const childJobBlockerKeys = new Set(
    childJobBlockers.map((blocker) => `${blocker.child}:${blocker.runId}`),
  );
  const terminalBlockers = selected
    .filter(
      (child) =>
        child.runId &&
        child.runAttempt &&
        child.status === "completed" &&
        !terminalPolicyPass(child, releaseProfile, workflowRef) &&
        !childJobBlockerKeys.has(`${child.key}:${child.runId}`),
    )
    .map((child) => ({
      child: child.key,
      conclusion: child.conclusion,
      job: "<workflow>",
      kind: "workflow_failure",
      message: `${child.key} workflow failed release policy`,
      runId: child.runId,
      url: child.url,
    }));
  const blockers = normalizeIssues(
    [
      ...localFailures,
      ...extraBlockers,
      ...dispatchMissingBlockers(selected),
      ...dispatchResultBlockers(selected),
      ...childJobBlockers,
      ...terminalBlockers,
    ],
    "release_blocker",
  );
  const errors = normalizeIssues([...extraErrors, ...childErrors], "orchestration_error");

  const activeRunIds = active.map((child) => String(child.runId)).toSorted();
  return {
    activeRunIds,
    blockers,
    errors,
    state: releaseState(cancelled, activeRunIds, blockers, errors),
  };
}

function childTiming(child) {
  const started = Date.parse(child.createdAt);
  const updated = Date.parse(child.updatedAt);
  return {
    durationMinutes:
      Number.isFinite(started) && Number.isFinite(updated)
        ? Math.round(((updated - started) / 60_000) * 10) / 10
        : null,
    jobs: child.jobs.map((job) => {
      const startedAt = stringValue(job.started_at ?? job.startedAt);
      const completedAt = stringValue(job.completed_at ?? job.completedAt);
      const jobStarted = Date.parse(startedAt);
      const jobCompleted = Date.parse(completedAt);
      return {
        acceptedRunAttempt: positiveInteger(job.acceptedRunAttempt),
        completedAt,
        conclusion: stringValue(job.conclusion),
        durationMinutes:
          Number.isFinite(jobStarted) && Number.isFinite(jobCompleted)
            ? Math.round(((jobCompleted - jobStarted) / 60_000) * 10) / 10
            : null,
        name: boundedString(job.name, MAX_LABEL_LENGTH),
        startedAt,
        status: stringValue(job.status),
        url: boundedString(job.html_url ?? job.url, MAX_URL_LENGTH),
      };
    }),
  };
}

function normalizedPlanChild(child, options = {}) {
  const normalized = {
    dispatchName: boundedString(child.dispatchName, MAX_LABEL_LENGTH),
    displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
    key: boundedString(child.key, MAX_LABEL_LENGTH),
    required: child.required === true,
    result: boundedString(child.result, MAX_LABEL_LENGTH),
    runAttempt: positiveInteger(child.runAttempt) ?? null,
    runId: boundedString(child.runId, MAX_LABEL_LENGTH),
    selected: child.selected === true,
    source: child.source === "reused" ? "reused" : "fresh",
    url: boundedString(child.url, MAX_URL_LENGTH),
    workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
    workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
    workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
  };
  return options.sourceParentAttempt === false
    ? normalized
    : {
        ...normalized,
        sourceParentAttempt: positiveInteger(child.sourceParentAttempt) ?? null,
      };
}

export function buildReleaseStateArtifact({
  cancellation = {},
  children,
  decision,
  executionPlan,
  expected,
  mode,
  releaseProfile,
  rerunGroup,
}) {
  const activeRunIds = (decision.activeRunIds ?? []).map(String);
  if (
    activeRunIds.some((runId) => !/^[1-9][0-9]*$/u.test(runId)) ||
    new Set(activeRunIds).size !== activeRunIds.length ||
    JSON.stringify(activeRunIds) !== JSON.stringify(activeRunIds.toSorted())
  ) {
    throw new Error("release state active run IDs are malformed, duplicated, or unordered");
  }
  return {
    version: 2,
    kind:
      mode === "decision"
        ? "openclaw.full-release-decision"
        : "openclaw.full-release-diagnostic-drain",
    mode,
    parentRunId: expected.parentRunId,
    parentRunAttempt: expected.parentRunAttempt,
    sourceParentRunAttempt: executionPlan.parentRunAttempt,
    workflowRef: expected.workflowRef,
    workflowSha: expected.workflowSha,
    targetSha: expected.targetSha,
    releaseProfile,
    rerunGroup,
    executionPlanSha256: executionPlan.sha256,
    state: decision.state,
    activeRunIds,
    blockers: decision.blockers,
    errors: decision.errors,
    cancellation: {
      cancelledRunIds: [...(cancellation.cancelledRunIds ?? [])].map(String),
      requested: cancellation.requested === true,
    },
    children: Object.fromEntries(
      children
        .filter((child) => child.selected && child.runId && child.runAttempt)
        .map((child) => [
          child.key,
          {
            compositeJobsSha256: boundedString(child.compositeJobsSha256, MAX_LABEL_LENGTH),
            conclusion: stringValue(child.conclusion),
            dispatchActor: boundedString(child.dispatchActor, MAX_LABEL_LENGTH),
            displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
            errors: normalizeIssues(child.errors, "orchestration_error"),
            observedRunAttempts: Array.isArray(child.observedRunAttempts)
              ? child.observedRunAttempts.map((value) => {
                  const attempt = positiveInteger(value);
                  if (attempt === undefined) {
                    throw new Error(`release state child attempt is invalid: ${child.key}`);
                  }
                  return attempt;
                })
              : [],
            plannedRunAttempt: positiveInteger(child.plannedRunAttempt ?? child.runAttempt),
            runAttempt: positiveInteger(child.runAttempt),
            runId: String(child.runId),
            repository: boundedString(child.repository, MAX_LABEL_LENGTH),
            status: stringValue(child.status),
            timing: childTiming(child),
            url: boundedString(child.url, MAX_URL_LENGTH),
            workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
            workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
            workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
            triggeringActor: boundedString(child.triggeringActor, MAX_LABEL_LENGTH),
          },
        ]),
    ),
  };
}

function validatePlan(value, options = {}) {
  if (!Array.isArray(value)) {
    throw new Error("release state plan is invalid");
  }
  const keys = new Set();
  return value.map((child) => {
    const normalized = normalizedPlanChild(child, options);
    if (
      !normalized.key ||
      !normalized.workflow ||
      !normalized.displayTitle ||
      !normalized.dispatchName ||
      keys.has(normalized.key) ||
      (normalized.required && !normalized.selected)
    ) {
      throw new Error("release state child plan is invalid");
    }
    keys.add(normalized.key);
    return normalized;
  });
}

function validateExecutionPlanChildBindings(children, payload) {
  const expectedKeys = CHILD_SPECS.map((spec) => spec.key).toSorted();
  if (
    JSON.stringify(children.map((child) => child.key).toSorted()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error("release execution plan child inventory is invalid");
  }
  for (const child of children) {
    const spec = releaseChildSpec(child.key);
    if (child.dispatchName !== spec.dispatchName || child.workflow !== spec.workflow) {
      throw new Error(`release execution plan child identity is invalid: ${child.key}`);
    }
    if (
      child.source === "fresh" &&
      (child.displayTitle !==
        `${spec.displayName} full-release-validation-${payload.parentRunId}-${payload.parentRunAttempt}${spec.suffix}` ||
        child.workflowRef !== payload.workflowRef ||
        child.workflowSha !== payload.workflowSha)
    ) {
      throw new Error(`release execution plan child identity is invalid: ${child.key}`);
    }
  }
}

export function validateReleaseStateArtifact(payload, expected, expectedMode) {
  const expectedValues = expected ?? {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("release state artifact is invalid");
  }
  const mode = expectedMode ?? payload.mode;
  const expectedKind =
    mode === "decision"
      ? "openclaw.full-release-decision"
      : "openclaw.full-release-diagnostic-drain";
  if (
    payload.version !== 2 ||
    payload.mode !== mode ||
    payload.kind !== expectedKind ||
    !RELEASE_DECISION_STATE_SET.has(stringValue(payload.state)) ||
    typeof payload.cancellation?.requested !== "boolean" ||
    !Array.isArray(payload.cancellation?.cancelledRunIds) ||
    !/^[a-f0-9]{64}$/u.test(String(payload.executionPlanSha256 ?? "")) ||
    positiveInteger(payload.parentRunAttempt) === undefined ||
    positiveInteger(payload.sourceParentRunAttempt) === undefined ||
    (expectedValues.parentRunId !== undefined &&
      String(payload.parentRunId) !== String(expectedValues.parentRunId)) ||
    (expectedValues.parentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) !== Number(expectedValues.parentRunAttempt)) ||
    (expectedValues.maxParentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) > Number(expectedValues.maxParentRunAttempt)) ||
    (expectedValues.workflowRef !== undefined &&
      payload.workflowRef !== expectedValues.workflowRef) ||
    (expectedValues.workflowSha !== undefined &&
      payload.workflowSha !== expectedValues.workflowSha) ||
    (expectedValues.targetSha !== undefined && payload.targetSha !== expectedValues.targetSha) ||
    (expectedValues.releaseProfile !== undefined &&
      payload.releaseProfile !== expectedValues.releaseProfile) ||
    (expectedValues.rerunGroup !== undefined && payload.rerunGroup !== expectedValues.rerunGroup)
  ) {
    throw new Error("release state artifact binding is invalid");
  }
  const blockers = normalizeIssues(payload.blockers, "release_blocker");
  const errors = normalizeIssues(payload.errors, "orchestration_error");
  if (!Array.isArray(payload.activeRunIds)) {
    throw new Error("release state active run IDs are invalid");
  }
  const activeRunIds = payload.activeRunIds.map(String);
  if (
    activeRunIds.some((runId) => !/^[1-9][0-9]*$/u.test(runId)) ||
    new Set(activeRunIds).size !== activeRunIds.length ||
    JSON.stringify(activeRunIds) !== JSON.stringify(activeRunIds.toSorted())
  ) {
    throw new Error("release state active run IDs are malformed, duplicated, or unordered");
  }
  const children =
    payload.children && typeof payload.children === "object" && !Array.isArray(payload.children)
      ? Object.fromEntries(
          Object.entries(payload.children).map(([key, child]) => {
            if (!child || typeof child !== "object" || Array.isArray(child)) {
              throw new Error(`release state child snapshot is invalid: ${key}`);
            }
            if (!Array.isArray(child.timing?.jobs)) {
              throw new Error(`release state child jobs are invalid: ${key}`);
            }
            const plannedRunAttempt = positiveInteger(child.plannedRunAttempt);
            const runAttempt = positiveInteger(child.runAttempt);
            const observedRunAttempts = Array.isArray(child.observedRunAttempts)
              ? child.observedRunAttempts.map((value) => positiveInteger(value))
              : undefined;
            const expectedRunAttempts =
              plannedRunAttempt === undefined || runAttempt === undefined
                ? []
                : Array.from(
                    { length: runAttempt - plannedRunAttempt + 1 },
                    (_, index) => plannedRunAttempt + index,
                  );
            if (
              (child.compositeJobsSha256 || (observedRunAttempts?.length ?? 0) > 0) &&
              (plannedRunAttempt === undefined ||
                runAttempt === undefined ||
                !observedRunAttempts ||
                observedRunAttempts.some((value) => value === undefined) ||
                JSON.stringify(observedRunAttempts) !== JSON.stringify(expectedRunAttempts))
            ) {
              throw new Error(`release state child attempt evidence is invalid: ${key}`);
            }
            const timingJobs = child.timing.jobs.map((job) => ({
              acceptedRunAttempt: positiveInteger(job?.acceptedRunAttempt),
              completedAt: stringValue(job?.completedAt),
              conclusion: stringValue(job?.conclusion),
              durationMinutes:
                typeof job?.durationMinutes === "number" ? job.durationMinutes : null,
              name: boundedString(job?.name, MAX_LABEL_LENGTH),
              startedAt: stringValue(job?.startedAt),
              status: stringValue(job?.status),
              url: boundedString(job?.url, MAX_URL_LENGTH),
            }));
            const jobNames = timingJobs.map((job) => job.name);
            if (
              child.compositeJobsSha256 &&
              (timingJobs.length === 0 ||
                timingJobs.some(
                  (job) =>
                    !job.name ||
                    job.acceptedRunAttempt === undefined ||
                    job.acceptedRunAttempt < plannedRunAttempt ||
                    job.acceptedRunAttempt > runAttempt,
                ) ||
                new Set(jobNames).size !== jobNames.length ||
                JSON.stringify(jobNames) !== JSON.stringify(jobNames.toSorted()))
            ) {
              throw new Error(`release state child composite jobs are invalid: ${key}`);
            }
            return [
              key,
              {
                compositeJobsSha256: boundedString(child.compositeJobsSha256, MAX_LABEL_LENGTH),
                conclusion: stringValue(child.conclusion),
                dispatchActor: boundedString(child.dispatchActor, MAX_LABEL_LENGTH),
                displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
                errors: normalizeIssues(child.errors, "orchestration_error"),
                observedRunAttempts: observedRunAttempts ?? [],
                plannedRunAttempt,
                runAttempt,
                runId: String(child.runId ?? ""),
                repository: boundedString(child.repository, MAX_LABEL_LENGTH),
                status: stringValue(child.status),
                timing: {
                  durationMinutes:
                    typeof child.timing?.durationMinutes === "number"
                      ? child.timing.durationMinutes
                      : null,
                  jobs: timingJobs,
                },
                url: boundedString(child.url, MAX_URL_LENGTH),
                workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
                workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
                workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
                triggeringActor: boundedString(child.triggeringActor, MAX_LABEL_LENGTH),
              },
            ];
          }),
        )
      : {};
  return {
    ...payload,
    activeRunIds,
    blockers,
    children,
    errors,
    parentRunAttempt: positiveInteger(payload.parentRunAttempt),
    sourceParentRunAttempt: positiveInteger(payload.sourceParentRunAttempt),
  };
}

export function releasePlanGateFailures(gates) {
  return gates
    .filter((gate) => gate.required && gate.result !== "success")
    .map((gate) => ({
      child: "<parent>",
      conclusion: stringValue(gate.result, "missing"),
      job: stringValue(gate.name, "parent gate"),
      kind: "parent_gate_failure",
      message: `${stringValue(gate.name, "parent gate")} did not succeed`,
    }));
}

export function releaseStateChildEvidence(child) {
  return canonicalValue({
    compositeJobsSha256: child.compositeJobsSha256,
    conclusion: child.conclusion,
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
    status: child.status,
    triggeringActor: child.triggeringActor,
    workflow: child.workflow,
    workflowRef: child.workflowRef,
    workflowSha: child.workflowSha,
  });
}

function verifyStateStructure(state, executionPlan, label) {
  const selected = executionPlan.children.filter((entry) => entry.selected);
  const expectedKeys = selected.map((child) => child.key).toSorted();
  if (JSON.stringify(Object.keys(state.children).toSorted()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} child set differs from the immutable execution plan`);
  }
  const snapshots = selected.map((child) => {
    if (!child.runId || !child.runAttempt) {
      throw new Error(`selected release child omitted exact identity: ${child.key}`);
    }
    const snapshot = state.children[child.key];
    if (
      !snapshot ||
      snapshot.runId !== child.runId ||
      snapshot.plannedRunAttempt !== child.runAttempt ||
      snapshot.runAttempt < child.runAttempt ||
      snapshot.displayTitle !== child.displayTitle ||
      snapshot.workflow !== child.workflow ||
      snapshot.workflowRef !== child.workflowRef ||
      snapshot.workflowSha !== child.workflowSha
    ) {
      throw new Error(`${label} child provenance differs from the immutable plan: ${child.key}`);
    }
    if (executionPlan.attemptEvidenceVersion !== undefined) {
      if (
        snapshot.dispatchActor !== "github-actions[bot]" ||
        !snapshot.triggeringActor ||
        !snapshot.repository
      ) {
        throw new Error(`${label} child rerun provenance is invalid: ${child.key}`);
      }
      const expectedAttempts = Array.from(
        { length: snapshot.runAttempt - child.runAttempt + 1 },
        (_, index) => child.runAttempt + index,
      );
      if (JSON.stringify(snapshot.observedRunAttempts) !== JSON.stringify(expectedAttempts)) {
        throw new Error(`${label} child attempt evidence is gapped: ${child.key}`);
      }
      const composite = {
        effectiveRunAttempt: snapshot.runAttempt,
        jobs: snapshot.timing.jobs.map((job) => {
          const acceptedRunAttempt = positiveInteger(job.acceptedRunAttempt);
          if (
            acceptedRunAttempt === undefined ||
            acceptedRunAttempt < child.runAttempt ||
            acceptedRunAttempt > snapshot.runAttempt
          ) {
            throw new Error(`${label} child job attempt is invalid: ${child.key}`);
          }
          return {
            acceptedRunAttempt,
            completedAt: job.completedAt,
            conclusion: job.conclusion,
            name: job.name,
            startedAt: job.startedAt,
            status: job.status,
            url: job.url,
          };
        }),
        plannedRunAttempt: child.runAttempt,
      };
      if (
        snapshot.compositeJobsSha256 !== releaseCompositeJobsSha256(composite) ||
        new Set(composite.jobs.map((job) => job.name)).size !== composite.jobs.length
      ) {
        throw new Error(`${label} child composite job evidence is invalid: ${child.key}`);
      }
    }
    return Object.assign({}, child, snapshot, {
      jobs: snapshot.timing.jobs.map((job) => ({
        conclusion: job.conclusion,
        html_url: job.url,
        name: job.name,
        status: job.status,
        url: job.url,
      })),
    });
  });
  const { cancelledRunIds, requested } = state.cancellation;
  const affectedRunIds = new Set(affectedActiveRunIds(snapshots, state.blockers));
  if (
    (requested &&
      !state.errors.some(
        ({ child, kind }) => child === "<collector>" && kind === "collector_cancelled",
      )) ||
    new Set(cancelledRunIds).size !== cancelledRunIds.length ||
    cancelledRunIds.some((runId) => !/^[1-9][0-9]*$/u.test(runId) || !affectedRunIds.has(runId))
  ) {
    throw new Error(`${label} cancellation differs from exact child state`);
  }
  const baseline = classifyReleaseSnapshot({
    children: snapshots,
    extraBlockers: executionPlan.blockers,
    extraErrors: executionPlan.errors,
    localFailures: releasePlanGateFailures(executionPlan.gates),
    releaseProfile: executionPlan.releaseProfile,
    workflowRef: executionPlan.workflowRef,
  });
  if (JSON.stringify(state.activeRunIds) !== JSON.stringify(baseline.activeRunIds)) {
    throw new Error(`${label} activeRunIds differs from canonical release policy`);
  }
  for (const key of ["blockers", "errors"]) {
    const claimed = new Set(state[key].map((issue) => JSON.stringify(issue)));
    if (baseline[key].some((issue) => !claimed.has(JSON.stringify(issue)))) {
      throw new Error(`${label} omits baseline ${key}`);
    }
  }
  if (releaseState(requested, state.activeRunIds, state.blockers, state.errors) !== state.state) {
    throw new Error(`${label} state differs from canonical release policy`);
  }
}

function verifyStateTransition(decision, drain) {
  const reuseRecovery =
    ["blocked_complete", "blocked_diagnostics_running"].includes(decision.state) &&
    drain.state === "passed" &&
    decision.errors.length === 0 &&
    decision.blockers.length > 0 &&
    decision.blockers.every(
      ({ child, kind }) =>
        child === "<evidence>" && ["reused_evidence_invalid", "provenance_mismatch"].includes(kind),
    );
  if (
    ["qualifying", "blocked_diagnostics_running"].includes(drain.state) ||
    decision.state === "qualifying" ||
    (decision.state === "passed" && drain.state === "blocked_complete") ||
    (decision.state.startsWith("blocked_") && drain.state === "passed" && !reuseRecovery)
  ) {
    throw new Error("release decision and diagnostic drain transition is invalid");
  }
  if (
    decision.state.startsWith("blocked_") &&
    drain.state === "blocked_complete" &&
    !decision.blockers.every((blocker) =>
      drain.blockers.some(
        (candidate) =>
          JSON.stringify(candidate) === JSON.stringify(blocker) ||
          (blocker.kind === "workflow_failure" &&
            candidate.kind === "job_failure" &&
            ["child", "runId"].every((key) => candidate[key] === blocker[key])),
      ),
    )
  ) {
    throw new Error("diagnostic drain changed or removed a release decision blocker");
  }
}

function verifyReleaseStatePair(planPayload, decisionPayload, drainPayload, expected = {}) {
  const executionPlan = validateReleaseExecutionPlanArtifact(planPayload, expected);
  const decision = validateReleaseStateArtifact(decisionPayload, expected, "decision");
  const drain = validateReleaseStateArtifact(drainPayload, expected, "drain");
  if (
    decision.executionPlanSha256 !== executionPlan.sha256 ||
    drain.executionPlanSha256 !== executionPlan.sha256 ||
    decision.sourceParentRunAttempt !== executionPlan.parentRunAttempt ||
    drain.sourceParentRunAttempt !== executionPlan.parentRunAttempt
  ) {
    throw new Error("release decision and diagnostic drain execution plans differ");
  }
  verifyStateStructure(decision, executionPlan, "release decision");
  verifyStateStructure(drain, executionPlan, "diagnostic drain");
  verifyStateTransition(decision, drain);
  return {
    decision,
    drain,
    executionPlan,
    sourceAttempts: {
      decision: decision.parentRunAttempt,
      drain: drain.parentRunAttempt,
      executionPlan: executionPlan.parentRunAttempt,
    },
  };
}

export function verifyReleaseStateArtifacts(plan, decision, drain, expected = {}) {
  const verified = verifyReleaseStatePair(plan, decision, drain, expected);
  if (verified.decision.state !== "passed" || verified.drain.state !== "passed") {
    const outcome = verified.drain.state === "passed" ? verified.decision : verified.drain;
    throw new Error(formatReleaseStateOutcome(outcome));
  }
  for (const child of verified.executionPlan.children.filter((entry) => entry.selected)) {
    if (
      JSON.stringify(releaseStateChildEvidence(verified.decision.children[child.key])) !==
      JSON.stringify(releaseStateChildEvidence(verified.drain.children[child.key]))
    ) {
      throw new Error(`release decision and diagnostic drain child evidence differ: ${child.key}`);
    }
  }
  return verified;
}

function newestStateCandidate(candidates, mode, runId, expected) {
  const prefix = mode === "decision" ? "full-release-decision" : "full-release-diagnostics";
  const pattern = new RegExp(`^${prefix}-${runId}-([1-9][0-9]*)$`, "u");
  const maxParentRunAttempt = Number(expected.maxParentRunAttempt ?? Number.POSITIVE_INFINITY);
  const sorted = candidates
    .map((candidate) => {
      const match = pattern.exec(String(candidate.name ?? ""));
      return match ? { ...candidate, attempt: Number(match[1]) } : undefined;
    })
    .filter(Boolean)
    .filter((candidate) => candidate.attempt <= maxParentRunAttempt)
    .toSorted((left, right) => right.attempt - left.attempt);
  const newest = sorted[0];
  if (!newest) {
    throw new Error(`no ${mode} artifact exists at or before the current parent attempt`);
  }
  const payload = validateReleaseStateArtifact(newest.payload, expected, mode);
  if (payload.parentRunAttempt !== newest.attempt) {
    throw new Error(`${mode} artifact name and source attempt differ`);
  }
  return payload;
}

export function selectReleaseStateArtifacts(
  executionPlanPayload,
  decisionCandidates,
  drainCandidates,
  expected = {},
) {
  const executionPlan = validateReleaseExecutionPlanArtifact(executionPlanPayload, expected);
  const selectionExpected = {
    ...expected,
    parentRunAttempt: undefined,
  };
  const decision = newestStateCandidate(
    decisionCandidates,
    "decision",
    executionPlan.parentRunId,
    selectionExpected,
  );
  const drain = newestStateCandidate(
    drainCandidates,
    "drain",
    executionPlan.parentRunId,
    selectionExpected,
  );
  return verifyReleaseStatePair(executionPlan, decision, drain, selectionExpected);
}

function issueSummary(prefix, issue) {
  const label =
    issue.job || issue.message || issue.child || issue.kind || `${prefix.toLowerCase()} detail`;
  const result = issue.conclusion ? ` (${issue.conclusion})` : "";
  const url = issue.url ? ` ${issue.url}` : "";
  return `- ${prefix}: ${label}${result}${url}`;
}

function releaseStateDetailLines(payload, maxItems = MAX_SUMMARY_ISSUES) {
  const normalizedMax = Math.max(1, Math.min(maxItems || MAX_SUMMARY_ISSUES, 10));
  const lines = [];
  for (const blocker of payload.blockers.slice(0, normalizedMax)) {
    lines.push(issueSummary("Blocker", blocker));
  }
  for (const error of payload.errors.slice(0, normalizedMax)) {
    lines.push(issueSummary("Collector error", error));
  }
  const omitted =
    Math.max(0, payload.blockers.length - normalizedMax) +
    Math.max(0, payload.errors.length - normalizedMax);
  if (omitted > 0) {
    lines.push(`- ${omitted} additional blocker/error item(s) omitted`);
  }
  return lines;
}

export function formatReleaseStateOutcome(payload) {
  const lines = [`Full Release Validation state: ${payload.state}`];
  lines.push(...releaseStateDetailLines(payload));
  if (payload.state === "blocked_diagnostics_running") {
    lines.push(
      "Diagnostic Drain is still collecting terminal evidence; diagnose now, retry later.",
    );
  } else if (payload.state === "orchestration_error") {
    lines.push("Recover the collector against the same exact child runs; do not redispatch tests.");
  } else if (payload.state === "cancelled_with_children") {
    lines.push("The collector stopped while exact child runs remained active.");
  }
  return lines.join("\n");
}

export function affectedActiveRunIds(children, blockers, cancelledRunIds = new Set()) {
  const affected = new Set(
    blockers.map((blocker) => String(blocker.runId ?? "")).filter((runId) => runId),
  );
  return children
    .filter(
      (child) =>
        child.status !== "completed" &&
        affected.has(String(child.runId)) &&
        !cancelledRunIds.has(String(child.runId)),
    )
    .map((child) => String(child.runId));
}
