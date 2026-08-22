import { createHash } from "node:crypto";

const SUCCESSFUL_JOB_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);
const MAX_REPORTED_ISSUES = 25;
const MAX_SUMMARY_ISSUES = 5;
const MAX_LABEL_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;
const MAX_URL_LENGTH = 1024;
const EXACT_TARGET_EVIDENCE_REUSE_POLICY = "exact-target-full-validation-v1";
const CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY = "changelog-only-release-v1";
const HARD_GH_TRANSPORT_PATTERN =
  /HTTP (?:401|403)\b|Bad credentials|authentication required|not authenticated|gh auth login|unknown (?:command|flag)|Usage: gh\b|ENOENT|EACCES/iu;
const TRANSIENT_GH_TRANSPORT_PATTERN =
  /HTTP 429\b|HTTP 5[0-9][0-9]\b|Server Error|secondary rate limit|API rate limit|abuse detection|error connecting to|context deadline exceeded|connection reset by peer|connection refused|TLS handshake timeout|i\/o timeout|network is unreachable|unexpected EOF|ETIMEDOUT|ECONNRESET|EAI_AGAIN/iu;

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
    rerunGroups: ["all", "ci"],
    suffix: "-ci",
    workflow: "ci.yml",
  },
  {
    dispatchName: "Dispatch plugin prerelease",
    displayName: "Plugin Prerelease",
    key: "pluginPrerelease",
    rerunGroups: ["all", "plugin-prerelease"],
    suffix: "-plugin-prerelease",
    workflow: "plugin-prerelease.yml",
  },
  {
    dispatchName: "Dispatch release checks",
    displayName: "OpenClaw Release Checks",
    key: "releaseChecks",
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
    rerunGroups: ["npm-telegram"],
    suffix: "-npm-telegram",
    workflow: "npm-telegram-beta-e2e.yml",
  },
  {
    dispatchName: "Dispatch OpenClaw Performance",
    displayName: "OpenClaw Performance",
    key: "productPerformance",
    rerunGroups: ["all", "performance"],
    suffix: "",
    workflow: "openclaw-performance.yml",
  },
]);

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
  return TRANSIENT_GH_TRANSPORT_PATTERN.test(text) ? "transient" : "hard";
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

function booleanValue(value) {
  return value === true || value === "true";
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
      result: stringValue(input.prepareCandidateResult, "skipped"),
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

function executionPlanDigestPayload(plan) {
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

export function releaseExecutionPlanSha256(plan) {
  return createHash("sha256")
    .update(JSON.stringify(executionPlanDigestPayload(plan)))
    .digest("hex");
}

export function buildReleaseExecutionPlanArtifact({
  blockers = [],
  children,
  errors = [],
  evidenceReuse,
  expected,
  gates,
  releaseProfile,
  rerunGroup,
  trustedWorkflow,
}) {
  const normalizedReuse = normalizedEvidenceReuse(evidenceReuse);
  if (!validEvidenceReuseIdentity(normalizedReuse)) {
    throw new Error("release execution plan evidence reuse binding is invalid");
  }
  const plan = {
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
    children: children.map(normalizedPlanChild),
    blockers: normalizeIssues(blockers, "release_blocker"),
    errors: normalizeIssues(errors, "orchestration_error"),
  };
  return { ...plan, sha256: releaseExecutionPlanSha256(plan) };
}

export function validateReleaseExecutionPlanArtifact(payload, expected = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("release execution plan artifact is invalid");
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
    (expected.maxParentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) > Number(expected.maxParentRunAttempt)) ||
    (expected.workflowRef !== undefined && payload.workflowRef !== expected.workflowRef) ||
    (expected.workflowSha !== undefined && payload.workflowSha !== expected.workflowSha) ||
    (expected.releaseProfile !== undefined && payload.releaseProfile !== expected.releaseProfile) ||
    (expected.rerunGroup !== undefined && payload.rerunGroup !== expected.rerunGroup) ||
    (expected.targetSha !== undefined && payload.targetSha !== expected.targetSha)
  ) {
    throw new Error("release execution plan artifact binding is invalid");
  }
  const evidenceReuse = normalizedEvidenceReuse(payload.evidenceReuse);
  if (!validEvidenceReuseIdentity(evidenceReuse)) {
    throw new Error("release execution plan evidence reuse binding is invalid");
  }
  const trustedWorkflow = normalizedTrustedWorkflow(payload.trustedWorkflow);
  const plan = {
    ...payload,
    parentRunAttempt: positiveInteger(payload.parentRunAttempt),
    parentRunId: String(payload.parentRunId),
    children: validatePlan(payload.children),
    blockers: normalizeIssues(payload.blockers, "release_blocker"),
    errors: normalizeIssues(payload.errors, "orchestration_error"),
    evidenceReuse,
    gates: Array.isArray(payload.gates) ? payload.gates.map(normalizedGate) : [],
    trustedWorkflow,
  };
  const sha256 = releaseExecutionPlanSha256(plan);
  if (payload.sha256 !== sha256) {
    throw new Error("release execution plan artifact digest is invalid");
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

  let state;
  if (cancelled && active.length > 0) {
    state = "cancelled_with_children";
  } else if (errors.length > 0) {
    state = "orchestration_error";
  } else if (blockers.length > 0) {
    state = active.length > 0 ? "blocked_diagnostics_running" : "blocked_complete";
  } else if (active.length > 0) {
    state = "qualifying";
  } else {
    state = "passed";
  }

  return {
    activeRunIds: active.map((child) => String(child.runId)),
    blockers,
    errors,
    state,
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
      const jobStarted = Date.parse(job.started_at);
      const jobCompleted = Date.parse(job.completed_at);
      return {
        conclusion: stringValue(job.conclusion),
        durationMinutes:
          Number.isFinite(jobStarted) && Number.isFinite(jobCompleted)
            ? Math.round(((jobCompleted - jobStarted) / 60_000) * 10) / 10
            : null,
        name: boundedString(job.name, MAX_LABEL_LENGTH),
        startedAt: stringValue(job.started_at),
        status: stringValue(job.status),
        url: boundedString(job.html_url ?? job.url, MAX_URL_LENGTH),
      };
    }),
  };
}

function normalizedPlanChild(child) {
  return {
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
    activeRunIds: decision.activeRunIds,
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
            conclusion: stringValue(child.conclusion),
            displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
            errors: normalizeIssues(child.errors, "orchestration_error"),
            runAttempt: positiveInteger(child.runAttempt),
            runId: String(child.runId),
            status: stringValue(child.status),
            timing: childTiming(child),
            url: boundedString(child.url, MAX_URL_LENGTH),
            workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
            workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
            workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
          },
        ]),
    ),
  };
}

function validatePlan(value) {
  if (!Array.isArray(value)) {
    throw new Error("release state plan is invalid");
  }
  const keys = new Set();
  return value.map((child) => {
    const normalized = normalizedPlanChild(child);
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
  const activeRunIds = Array.isArray(payload.activeRunIds)
    ? payload.activeRunIds.map(String).filter((runId) => /^[1-9][0-9]*$/u.test(runId))
    : [];
  const children =
    payload.children && typeof payload.children === "object" && !Array.isArray(payload.children)
      ? Object.fromEntries(
          Object.entries(payload.children).map(([key, child]) => {
            if (!child || typeof child !== "object" || Array.isArray(child)) {
              throw new Error(`release state child snapshot is invalid: ${key}`);
            }
            const timingJobs = Array.isArray(child.timing?.jobs)
              ? child.timing.jobs.map((job) => ({
                  conclusion: stringValue(job?.conclusion),
                  durationMinutes:
                    typeof job?.durationMinutes === "number" ? job.durationMinutes : null,
                  name: boundedString(job?.name, MAX_LABEL_LENGTH),
                  startedAt: stringValue(job?.startedAt),
                  status: stringValue(job?.status),
                  url: boundedString(job?.url, MAX_URL_LENGTH),
                }))
              : [];
            return [
              key,
              {
                conclusion: stringValue(child.conclusion),
                displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
                errors: normalizeIssues(child.errors, "orchestration_error"),
                runAttempt: positiveInteger(child.runAttempt),
                runId: String(child.runId ?? ""),
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

function verifyStateChildren(state, executionPlan, label) {
  const selected = executionPlan.children.filter((entry) => entry.selected);
  const expectedKeys = selected.map((child) => child.key).toSorted();
  const actualKeys = Object.keys(state.children).toSorted();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} child set differs from the immutable execution plan`);
  }
  if (
    state.activeRunIds.length > 0 ||
    state.cancellation?.requested === true ||
    (state.cancellation?.cancelledRunIds?.length ?? 0) > 0
  ) {
    throw new Error(`${label} claims passed with active or cancelled children`);
  }
  const snapshots = selected.map((child) => {
    if (!child.runId || !child.runAttempt) {
      throw new Error(`selected release child omitted exact identity: ${child.key}`);
    }
    const snapshot = state.children[child.key];
    if (
      !snapshot ||
      snapshot.runId !== child.runId ||
      snapshot.runAttempt !== child.runAttempt ||
      snapshot.displayTitle !== child.displayTitle ||
      snapshot.workflow !== child.workflow ||
      snapshot.workflowRef !== child.workflowRef ||
      snapshot.workflowSha !== child.workflowSha
    ) {
      throw new Error(`${label} child provenance differs from the immutable plan: ${child.key}`);
    }
    if (snapshot.errors.length > 0) {
      throw new Error(`${label} child contains collector errors: ${child.key}`);
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
  const recomputed = classifyReleaseSnapshot({
    children: snapshots,
    extraBlockers: executionPlan.blockers,
    extraErrors: executionPlan.errors,
    localFailures: releasePlanGateFailures(executionPlan.gates),
    releaseProfile: executionPlan.releaseProfile,
    workflowRef: executionPlan.workflowRef,
  });
  if (
    state.state !== "passed" ||
    state.blockers.length > 0 ||
    state.errors.length > 0 ||
    recomputed.state !== "passed" ||
    recomputed.blockers.length > 0 ||
    recomputed.errors.length > 0
  ) {
    throw new Error(`${label} does not satisfy canonical terminal release policy`);
  }
}

export function verifyReleaseStateArtifacts(
  executionPlanPayload,
  decisionPayload,
  drainPayload,
  expected = {},
) {
  const executionPlan = validateReleaseExecutionPlanArtifact(executionPlanPayload, expected);
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
  verifyStateChildren(decision, executionPlan, "release decision");
  verifyStateChildren(drain, executionPlan, "diagnostic drain");
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

function newestStateCandidate(candidates, mode, runId, expected) {
  const prefix = mode === "decision" ? "full-release-decision" : "full-release-diagnostics";
  const pattern = new RegExp(`^${prefix}-${runId}-([1-9][0-9]*)$`, "u");
  const maxParentRunAttempt =
    expected.maxParentRunAttempt === undefined
      ? Number.POSITIVE_INFINITY
      : Number(expected.maxParentRunAttempt);
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
  return verifyReleaseStateArtifacts(executionPlan, decision, drain, selectionExpected);
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
