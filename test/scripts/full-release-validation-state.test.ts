import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFullReleaseCandidateBinding } from "../../scripts/full-release-candidate-contract.mjs";
import {
  composeReleaseAttemptJobs,
  isReleaseGhArtifactMissingError,
  MAX_RELEASE_ARTIFACT_BYTES,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  affectedActiveRunIds,
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  buildReleaseStateArtifact,
  classifyReleaseGhTransportError,
  classifyReleaseSnapshot,
  formatReleaseStateOutcome,
  readChild,
  releaseGhRetryDelayMs,
  releaseStateChildEvidence,
  serializeReleaseArtifact,
  selectReleaseStateArtifacts,
  validateChildBinding,
  validateReleaseExecutionPlanArtifact,
  validateReleaseStateArtifact,
  verifyReleaseStateArtifacts,
  updateReleaseTransportEpisode,
} from "../../scripts/full-release-validation-state.mjs";
import {
  fullReleaseCandidateBindingFixture,
  fullReleaseCandidateManifestFixture,
} from "../helpers/full-release-candidate.js";
import { waitForChildClose, waitForFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/full-release-validation-state.mjs");
const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const TRUSTED_MAIN = { fullRef: "refs/heads/main", ref: "main", sha: SHA };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function candidateRequestInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: "openclaw/openclaw",
    targetSha: TARGET_SHA,
    toolingSha: SHA,
    releaseProfile: "stable",
    releaseSoak: true,
    upgradeSurvivorBaseline: "openclaw@latest",
    upgradeSurvivorBaselines: "",
    upgradeSurvivorScenarios: "reported-issues",
    allowFrozenTargetScenarioOmissions: false,
    allowUnreleasedChangelog: false,
    sharedImagePolicy: "no-push-artifact",
    ...overrides,
  };
}

function candidateRequestEnvironment(overrides: Record<string, string> = {}) {
  return {
    CANDIDATE_RELEASE_SOAK: "true",
    CANDIDATE_UPGRADE_SURVIVOR_BASELINE: "openclaw@latest",
    CANDIDATE_UPGRADE_SURVIVOR_BASELINES: "",
    CANDIDATE_UPGRADE_SURVIVOR_SCENARIOS: "reported-issues",
    CANDIDATE_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "false",
    CANDIDATE_ALLOW_UNRELEASED_CHANGELOG: "false",
    CANDIDATE_SHARED_IMAGE_POLICY: "no-push-artifact",
    ...overrides,
  };
}

function candidateBinding(requestOverrides: Record<string, unknown> = {}) {
  return fullReleaseCandidateBindingFixture({
    ...candidateRequestInput(requestOverrides),
    ...requestOverrides,
  });
}

function evidenceManifest() {
  return { runAttempt: 1, runId: "99", targetSha: TARGET_SHA };
}

function generatedManifest(planArtifact: Record<string, any>): Record<string, any> {
  return {
    candidateBinding: planArtifact.candidate ?? null,
    childRuns: {
      normalCi: "101",
      npmTelegram: "",
      pluginPrerelease: "",
      productPerformance: { blocking: true, conclusion: "", runId: "" },
      releaseChecks: "",
    },
    controls: {
      performanceBlocking: true,
      performanceReportPublication: "artifact-only",
      stableSoakRequired: false,
    },
    executionPlanSha256: planArtifact.sha256,
    releaseProfile: "stable",
    rerunGroup: "ci",
    runAttempt: 2,
    runId: "77",
    runReleaseSoak: "false",
    sourceParentRunAttempt: 1,
    targetRef: "main",
    targetSha: TARGET_SHA,
    version: 3,
    workflowFullRef: "refs/heads/release-ci/tooling",
    workflowName: "Full Release Validation",
    workflowRef: "release-ci/tooling",
    workflowRefType: "branch",
    workflowSha: SHA,
  };
}

function child(key: string, overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "",
    dispatchName: `Dispatch ${key}`,
    displayTitle: key,
    errors: [],
    jobs: [],
    key,
    required: true,
    result: "success",
    runAttempt: 1,
    runId: "101",
    selected: true,
    source: "fresh",
    status: "in_progress",
    url: "https://example.invalid/runs/101",
    workflow: "ci.yml",
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return buildReleaseExecutionPlan({
    children: {
      normalCi: { result: "success", runAttempt: 1, runId: "101" },
      npmTelegram: { result: "success", runAttempt: 1, runId: "404" },
      pluginPrerelease: { result: "success", runAttempt: 1, runId: "202" },
      productPerformance: { result: "success", runAttempt: 1, runId: "505" },
      releaseChecks: { result: "success", runAttempt: 1, runId: "303" },
    },
    dockerPreflightResult: "success",
    evidenceReuse: false,
    parentRunAttempt: 2,
    parentRunId: "77",
    candidateBindingResult: "success",
    rerunGroup: "all",
    resolveTargetResult: "success",
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  });
}

function executionPlan(
  overrides: Record<string, unknown> = {},
  artifactOverrides: Record<string, unknown> = {},
) {
  const {
    candidateRequest,
    expected: expectedOverrides,
    ...remainingArtifactOverrides
  } = artifactOverrides;
  const expected = {
    parentRunAttempt: 1,
    parentRunId: "77",
    repository: "openclaw/openclaw",
    targetSha: TARGET_SHA,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...(candidateRequest === undefined ? {} : { candidateRequest }),
    ...(expectedOverrides as Record<string, unknown> | undefined),
  };
  const built = plan({ ...overrides, parentRunAttempt: expected.parentRunAttempt });
  return buildReleaseExecutionPlanArtifact({
    children: built.children,
    expected,
    gates: built.gates,
    releaseProfile: "stable",
    rerunGroup: typeof overrides.rerunGroup === "string" ? overrides.rerunGroup : "all",
    trustedWorkflow: TRUSTED_MAIN,
    ...remainingArtifactOverrides,
  });
}

function reusedEvidenceChildren() {
  return [
    ["normalCi", "101", "CI"],
    ["pluginPrerelease", "202", "Plugin Prerelease"],
    ["releaseChecks", "303", "OpenClaw Release Checks"],
    ["productPerformance", "505", "OpenClaw Performance"],
  ].map(([role, runId, name]) => ({
    displayTitle: `${name} full-release-validation-99-1`,
    headBranch: "release-ci/tooling",
    role,
    runAttempt: 1,
    runId,
    url: `https://example.invalid/runs/${runId}`,
    workflowSha: SHA,
  }));
}

function runPlanSubprocess(overrides: Record<string, unknown>) {
  const root = tempDirs.make("frv-candidate-plan-");
  const output = join(root, "full-release-execution-plan.json");
  const planInputs = {
    candidateBindingResult: "skipped",
    candidateRequestInput: candidateRequestInput(),
    children: {},
    dockerPreflightResult: "success",
    evidenceReuse: false,
    parentRunAttempt: 1,
    parentRunId: "77",
    rerunGroup: "all",
    resolveTargetResult: "success",
    trustedWorkflow: TRUSTED_MAIN,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  };
  const result = spawnSync(process.execPath, [SCRIPT, "plan"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FULL_RELEASE_EXECUTION_PLAN_PATH: output,
      FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(planInputs),
      GITHUB_REF_NAME: "release-ci/tooling",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "77",
      GITHUB_SHA: SHA,
      RELEASE_PROFILE: "stable",
      RERUN_GROUP: planInputs.rerunGroup,
      TARGET_SHA,
    },
    timeout: 10_000,
  });
  return { output, result };
}

describe("full release execution plan", () => {
  it("omits only the owner-waived Telegram child from stable package validation", () => {
    const input = {
      releaseProfile: "stable",
      releasePackageSpec: "openclaw@2026.8.1",
      targetVersion: "2026.8.1",
      telegramWaiver: "2026.8.1-owner-approved",
      children: {},
    };
    const ordinary = plan({ ...input, telegramWaiver: "" });
    const waived = plan(input);
    expect(waived.children.filter((child) => child.required).map((child) => child.key)).toEqual(
      ordinary.children
        .filter((child) => child.required && child.key !== "npmTelegram")
        .map((child) => child.key),
    );
    expect(waived.gates).toEqual(ordinary.gates);
    expect(waived.children.find((child) => child.key === "npmTelegram")).toMatchObject({
      required: false,
      selected: false,
      result: "skipped",
      runId: "",
    });
  });

  it.each([
    { telegramWaiver: "unknown" },
    { targetVersion: "2026.8.2" },
    { targetVersion: "2026.8.1-beta.3" },
    { releaseProfile: "beta" },
    { rerunGroup: "npm-telegram" },
    { liveSuiteFilter: "qa-live-matrix,qa-live-telegram" },
    { liveSuiteFilter: "TELEGRAM" },
    { liveSuiteFilter: "qa-live" },
    { liveSuiteFilter: "qa-live-all" },
    { liveSuiteFilter: "qa-all" },
    { liveSuiteFilter: "qa-live-non-slack" },
    { liveSuiteFilter: "qa-non-slack" },
    { liveSuiteFilter: "non-slack" },
    { liveSuiteFilter: "no-slack" },
    { liveSuiteFilter: "without-slack" },
    { releasePackageSpec: "openclaw@2026.8.2" },
    { packageAcceptancePackageSpec: "openclaw@latest" },
    { npmTelegramPackageSpec: "openclaw@2026.8.1-beta.3" },
  ])("rejects a Telegram waiver outside its owner-approved scope: %j", (override) => {
    expect(() =>
      plan({
        telegramWaiver: "2026.8.1-owner-approved",
        targetVersion: "2026.8.1",
        releaseProfile: "stable",
        ...override,
      }),
    ).toThrow(/Telegram waiver/u);
  });

  it("seals the Telegram waiver and exact version into the immutable plan", () => {
    const waiver = { telegramWaiver: "2026.8.1-owner-approved", targetVersion: "2026.8.1" };
    const artifact = executionPlan({ ...waiver, releaseProfile: "stable", children: {} }, waiver);
    expect(validateReleaseExecutionPlanArtifact(artifact)).toMatchObject(waiver);
    const changed = { ...artifact, targetVersion: "2026.8.2" };
    expect(() => validateReleaseExecutionPlanArtifact(changed)).toThrow(/digest/u);
    expect(() =>
      validateReleaseExecutionPlanArtifact({
        ...changed,
        sha256: releaseExecutionPlanSha256(changed),
      }),
    ).toThrow(/Telegram waiver/u);
    expect(() => validateReleaseExecutionPlanArtifact(artifact, { telegramWaiver: "" })).toThrow(
      /Telegram waiver/u,
    );
    const candidate = candidateBinding();
    expect(() =>
      executionPlan(
        { ...waiver, releaseProfile: "stable", children: {} },
        { ...waiver, attemptEvidenceVersion: 2, candidate, candidateRequest: candidate.request },
      ),
    ).toThrow("Telegram waiver target version differs from the release candidate");
    const manifest = fullReleaseCandidateManifestFixture(candidateRequestInput());
    manifest.package.version = "2026.8.1";
    const matchingCandidate = buildFullReleaseCandidateBinding({
      manifest,
      artifact: candidate.evidenceArtifact,
    });
    const sealedCandidatePlan = executionPlan(
      { ...waiver, releaseProfile: "stable", children: {} },
      {
        ...waiver,
        attemptEvidenceVersion: 2,
        candidate: matchingCandidate,
        candidateRequest: matchingCandidate.request,
      },
    );
    expect(validateReleaseExecutionPlanArtifact(sealedCandidatePlan)).toMatchObject(waiver);
  });

  it("seals complete candidate producer evidence into attempt-aware plans", () => {
    const candidate = candidateBinding();
    const artifact = executionPlan(
      {},
      {
        attemptEvidenceVersion: 2,
        candidate,
        candidateRequest: candidate.request,
      },
    );
    expect(artifact.attemptEvidenceVersion).toBe(2);
    expect(artifact.candidate).toEqual(candidate);
    expect(validateReleaseExecutionPlanArtifact(artifact).candidate).toEqual(candidate);
  });

  it("rejects malformed candidate evidence and digests candidate changes", () => {
    const candidate = candidateBinding();
    expect(() =>
      executionPlan(
        {},
        {
          attemptEvidenceVersion: 2,
          candidate: { ...candidate, manifestSha256: "" },
          candidateRequest: candidate.request,
        },
      ),
    ).toThrow("manifestSha256");

    const first = executionPlan(
      {},
      { attemptEvidenceVersion: 2, candidate, candidateRequest: candidate.request },
    );
    const secondCandidate = {
      ...candidate,
      evidenceArtifact: { ...candidate.evidenceArtifact, id: "105" },
    };
    const second = executionPlan(
      {},
      {
        attemptEvidenceVersion: 2,
        candidate: secondCandidate,
        candidateRequest: secondCandidate.request,
      },
    );
    expect(first.sha256).not.toBe(second.sha256);
  });

  it("keeps historical plans candidate-free", () => {
    expect(executionPlan()).not.toHaveProperty("candidate");
  });

  it.each([
    ["repository", { repository: "other/repository" }],
    ["target", { targetSha: "c".repeat(40) }],
    ["tooling", { toolingSha: "d".repeat(40) }],
    ["profile", { releaseProfile: "minimum" }],
    ["soak", { releaseSoak: false }],
    ["survivor baseline", { upgradeSurvivorBaseline: "openclaw@beta" }],
    ["survivor scenarios", { upgradeSurvivorScenarios: "base" }],
    ["frozen-target policy", { allowFrozenTargetScenarioOmissions: true }],
    ["changelog policy", { allowUnreleasedChangelog: true }],
    ["image policy", { sharedImagePolicy: "existing-only" }],
  ])("cross-binds candidate %s policy during plan build and validation", (_label, override) => {
    const expectedCandidate = candidateBinding();
    const mismatchedCandidate = candidateBinding(override);
    expect(() =>
      executionPlan(
        {},
        {
          attemptEvidenceVersion: 2,
          candidate: mismatchedCandidate,
          candidateRequest: expectedCandidate.request,
        },
      ),
    ).toThrow("release candidate binding request differs from the execution plan");

    const valid = executionPlan(
      {},
      {
        attemptEvidenceVersion: 2,
        candidate: expectedCandidate,
        candidateRequest: expectedCandidate.request,
      },
    );
    const forged: Record<string, any> = {
      ...valid,
      candidate: mismatchedCandidate,
    };
    forged.sha256 = releaseExecutionPlanSha256(forged);
    expect(() => validateReleaseExecutionPlanArtifact(forged)).toThrow(
      "release candidate binding request differs from the execution plan",
    );

    const forgedExpectedTuple: Record<string, any> = {
      ...valid,
      candidate: mismatchedCandidate,
      candidateRequest: mismatchedCandidate.request,
    };
    forgedExpectedTuple.sha256 = releaseExecutionPlanSha256(forgedExpectedTuple);
    expect(() =>
      validateReleaseExecutionPlanArtifact(forgedExpectedTuple, {
        candidateRequest: expectedCandidate.request,
      }),
    ).toThrow(
      /release candidate request differs from the (execution plan identity|expected plan inputs)/u,
    );
  });

  it.each([
    ["target", { targetSha: "c".repeat(40) }],
    ["tooling", { toolingSha: "d".repeat(40) }],
    ["profile", { releaseProfile: "minimum" }],
  ])("rejects candidate %s identity that disagrees with the outer plan", (_label, override) => {
    const mismatchedCandidate = candidateBinding(override);
    expect(() =>
      executionPlan(
        {},
        {
          attemptEvidenceVersion: 2,
          candidate: mismatchedCandidate,
          candidateRequest: mismatchedCandidate.request,
        },
      ),
    ).toThrow("release candidate request differs from the execution plan identity");
  });

  it.each([
    ["HTTP 429: rate limited", "transient"],
    ["HTTP 503: Server Error", "transient"],
    ["spawnSync gh ETIMEDOUT", "transient"],
    ["read ECONNRESET", "transient"],
    ["getaddrinfo EAI_AGAIN api.github.com", "transient"],
    ["unexpected EOF", "transient"],
    ["HTTP 401: Bad credentials", "hard"],
    ["HTTP 403: secondary rate limit", "transient"],
    ["HTTP 403: Resource not accessible by integration", "hard"],
    ["HTTP 403: permission denied", "hard"],
    ["HTTP 404: workflow not found", "hard"],
    ["HTTP 410: artifact expired", "hard"],
    ["HTTP 422: invalid workflow input", "hard"],
    ["unknown flag: --name\nUsage: gh run download", "hard"],
    ["operation timed out", "transient"],
    ["gh exited after sending the request", "ambiguous"],
  ] as const)("classifies GitHub transport error %s as %s", (message, expected) => {
    expect(
      classifyReleaseGhTransportError(Object.assign(new Error(message), { stderr: message })),
    ).toBe(expected);
  });

  it.each([
    "no valid artifacts found to download",
    "no artifact matches any of the names or patterns provided",
    "no artifact matches any of the names provided",
    "could not find any artifacts",
    "artifact full-release-execution-plan-123 not found",
  ])("recognizes recursive missing-artifact output: %s", (message) => {
    const error = Object.assign(new Error("gh run download failed"), {
      cause: Object.assign(new Error("download command failed"), { stderr: message }),
    });
    expect(isReleaseGhArtifactMissingError(error)).toBe(true);
  });

  it.each([
    "error fetching artifacts: HTTP 401: Bad credentials",
    "error fetching artifacts: HTTP 403: forbidden",
    "error fetching artifacts: HTTP 404: Not Found",
    "error fetching artifacts: HTTP 410: Gone",
    "error fetching artifacts: HTTP 422: invalid run",
    "HTTP 429: API rate limit exceeded",
    "HTTP 503: Server Error",
    "unknown flag: --name\nUsage: gh run download",
    "artifact request timed out",
    "artifact archive is malformed",
    "Unexpected end of JSON input",
    "artifact archive exceeds the size limit",
  ])("does not turn fatal artifact errors into absence: %s", (message) => {
    const error = Object.assign(new Error(message), {
      cause: new Error("no artifact matches any of the names or patterns provided"),
      stderr: message,
    });
    expect(isReleaseGhArtifactMissingError(error)).toBe(false);
  });

  it("keeps required coverage selected when dispatch output is missing", () => {
    const result = plan({
      children: { normalCi: { result: "success", runAttempt: "", runId: "" } },
      rerunGroup: "ci",
    });
    expect(result.children.find((entry) => entry.key === "normalCi")).toMatchObject({
      required: true,
      runAttempt: null,
      runId: "",
      selected: true,
    });
    expect(
      classifyReleaseSnapshot({
        children: result.children.map((entry) =>
          Object.assign({}, entry, { errors: [], jobs: [], status: "missing" }),
        ),
        releaseProfile: "stable",
        workflowRef: "release-ci/tooling",
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ kind: "dispatch_missing" })],
      state: "blocked_complete",
    });
  });

  it.each(["install-smoke", "qa-parity", "qa-live"])(
    "does not require candidate preparation for focused %s",
    (rerunGroup) => {
      expect(
        plan({ candidateBindingResult: "skipped", rerunGroup }).gates.find(
          (entry) => entry.name === "Prepare shared release candidate",
        ),
      ).toMatchObject({ required: false });
    },
  );

  it("does not prepare a candidate for published packages", () => {
    expect(
      plan({
        packageAcceptancePackageSpec: "openclaw@2026.8.4-beta.3",
        candidateBindingResult: "skipped",
        rerunGroup: "package",
      }).gates.at(-1),
    ).toMatchObject({ required: false });
  });

  it("does not require candidate acquisition when reusing release evidence", () => {
    expect(
      plan({
        candidateAcquisitionResult: "skipped",
        candidateRequired: true,
        childPhaseVersion: 3,
        evidenceReuse: true,
      }).gates.at(-1),
    ).toMatchObject({
      name: "Acquire full release candidate",
      required: false,
      result: "skipped",
    });
  });

  it("requires live-e2e candidate preparation only without a suite filter", () => {
    expect(plan({ rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject({ required: true });
    expect(plan({ liveSuiteFilter: "discord", rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject(
      {
        required: false,
      },
    );
  });

  it("seals required candidate evidence only after successful binding", () => {
    const candidate = candidateBinding();
    const { output, result } = runPlanSubprocess({
      candidateBindingResult: "success",
      candidateEvidence: candidate,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      attemptEvidenceVersion: 2,
      candidate,
      candidateRequest: candidate.request,
    });
  });

  it.each([
    ["target", { targetSha: "c".repeat(40) }],
    ["tooling", { toolingSha: "d".repeat(40) }],
    ["profile", { releaseProfile: "minimum" }],
  ])("rejects subprocess candidate %s mismatch against trusted plan inputs", (_label, override) => {
    const { result } = runPlanSubprocess({
      candidateBindingResult: "success",
      candidateEvidence: candidateBinding(override),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "release candidate binding request differs from the execution plan",
    );
  });

  it("rejects successful required candidate binding without evidence", () => {
    const { result } = runPlanSubprocess({ candidateBindingResult: "success" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "successful release candidate binding omitted producer evidence",
    );
  });

  it.each(["skipped", "failure"])(
    "rejects candidate evidence when required binding is %s",
    (candidateBindingResult) => {
      const { result } = runPlanSubprocess({
        candidateBindingResult,
        candidateEvidence: candidateBinding(),
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "release candidate evidence exists without successful binding",
      );
    },
  );

  it("rejects candidate evidence when binding is not required", () => {
    const { result } = runPlanSubprocess({
      candidateBindingResult: "success",
      candidateEvidence: candidateBinding(),
      rerunGroup: "ci",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "release candidate evidence exists when candidate binding is not required",
    );
  });

  it("rejects malformed evidence after successful required binding", () => {
    const { result } = runPlanSubprocess({
      candidateBindingResult: "success",
      candidateEvidence: { schema: "invalid" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("full release candidate binding keys must be exactly");
  });

  it("rejects a digest-valid plan with an incomplete reuse selection tuple", () => {
    const artifact = executionPlan(
      { rerunGroup: "ci" },
      {
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: TARGET_SHA,
          policy: "exact-target-full-validation-v1",
          requested: true,
          rootRunId: "99",
          runUrl: "https://example.invalid/runs/99",
          selectedRunId: "99",
          sourceManifest: evidenceManifest(),
        },
      },
    );
    const incompleteArtifact = {
      ...artifact,
      evidenceReuse: { ...artifact.evidenceReuse, selectedRunId: "" },
    };
    const digestValidArtifact = {
      ...incompleteArtifact,
      sha256: releaseExecutionPlanSha256(incompleteArtifact),
    };
    expect(() => validateReleaseExecutionPlanArtifact(digestValidArtifact)).toThrow(
      "release execution plan evidence reuse binding is invalid",
    );
  });
});

describe("release child attempt composition", () => {
  const job = (name: string, conclusion: string) => ({
    completed_at: "2026-08-22T00:01:00Z",
    conclusion,
    html_url: `https://example.invalid/jobs/${name}`,
    name,
    started_at: "2026-08-22T00:00:00Z",
    status: "completed",
  });

  it("lets a later failure replace an earlier success", () => {
    const result = composeReleaseAttemptJobs(
      [
        { jobs: [job("test", "success")], runAttempt: 1 },
        { jobs: [job("test", "failure")], runAttempt: 2 },
      ],
      { effectiveRunAttempt: 2, plannedRunAttempt: 1 },
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({ acceptedRunAttempt: 2, conclusion: "failure", name: "test" }),
    ]);
  });

  it("lets a later success replace a failure while carrying absent green jobs", () => {
    const result = composeReleaseAttemptJobs(
      [
        { jobs: [job("lint", "success"), job("test", "failure")], runAttempt: 1 },
        { jobs: [job("test", "success")], runAttempt: 2 },
      ],
      { effectiveRunAttempt: 2, plannedRunAttempt: 1 },
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({ acceptedRunAttempt: 1, conclusion: "success", name: "lint" }),
      expect.objectContaining({ acceptedRunAttempt: 2, conclusion: "success", name: "test" }),
    ]);
  });

  it("ignores terminal skipped jobs before duplicate identity checks", () => {
    const matrixPlaceholder = job("matrix.check_name", "skipped");
    const skippedJob = job("disabled-check", "skipped");
    const result = composeReleaseAttemptJobs(
      [
        {
          jobs: [
            matrixPlaceholder,
            matrixPlaceholder,
            skippedJob,
            skippedJob,
            job("test", "success"),
          ],
          runAttempt: 1,
        },
      ],
      { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({ acceptedRunAttempt: 1, conclusion: "success", name: "test" }),
    ]);
  });

  it.each([
    ["nonterminal", { ...job("matrix.check_name", "skipped"), status: "queued" }],
    ["nonskipped", job("disabled-check", "success")],
  ])("still rejects duplicate %s jobs", (_label, retainedJob) => {
    expect(() =>
      composeReleaseAttemptJobs([{ jobs: [retainedJob, retainedJob], runAttempt: 1 }], {
        effectiveRunAttempt: 1,
        plannedRunAttempt: 1,
      }),
    ).toThrow("duplicate job identity");
  });

  it("rejects duplicate logical jobs and gapped attempts", () => {
    expect(() =>
      composeReleaseAttemptJobs(
        [{ jobs: [job("test", "failure"), job("test", "success")], runAttempt: 1 }],
        { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
      ),
    ).toThrow("duplicate job identity");
    expect(() =>
      composeReleaseAttemptJobs(
        [
          { jobs: [job("test", "failure")], runAttempt: 1 },
          { jobs: [job("test", "success")], runAttempt: 3 },
        ],
        { effectiveRunAttempt: 3, plannedRunAttempt: 1 },
      ),
    ).toThrow("gapped");
  });
});

describe("release decision policy", () => {
  it("reports a decisive blocker while unrelated diagnostics continue", () => {
    const result = classifyReleaseSnapshot({
      children: [
        child("normalCi", {
          jobs: [{ conclusion: "failure", name: "test", status: "completed" }],
        }),
        child("releaseChecks", { runId: "202" }),
      ],
      releaseProfile: "stable",
      workflowRef: "main",
    });
    expect(result).toMatchObject({
      activeRunIds: ["101", "202"],
      state: "blocked_diagnostics_running",
    });
  });

  it("keeps advisory QA and beta performance failures non-blocking", () => {
    const result = classifyReleaseSnapshot({
      children: [
        child("releaseChecks", {
          conclusion: "failure",
          jobs: [
            {
              conclusion: "failure",
              name: "Run QA Lab runtime-pair lane (core)",
              status: "completed",
            },
            { conclusion: "success", name: "Verify release checks", status: "completed" },
          ],
          status: "completed",
        }),
        child("productPerformance", {
          conclusion: "failure",
          jobs: [{ conclusion: "failure", name: "benchmark", status: "completed" }],
          runId: "202",
          status: "completed",
        }),
      ],
      releaseProfile: "beta",
      workflowRef: "main",
    });
    expect(result).toMatchObject({ blockers: [], errors: [], state: "passed" });
  });

  it("preserves a blocker and an API error independently", () => {
    const result = classifyReleaseSnapshot({
      children: [
        child("normalCi", {
          jobs: [{ conclusion: "failure", name: "test", status: "completed" }],
        }),
        child("releaseChecks", {
          errors: [{ kind: "api_error", message: "HTTP 503", runId: "202" }],
          runId: "202",
          status: "unknown",
        }),
      ],
      releaseProfile: "stable",
      workflowRef: "main",
    });
    expect(result).toMatchObject({
      blockers: [expect.objectContaining({ job: "test" })],
      errors: [expect.objectContaining({ kind: "api_error" })],
      state: "orchestration_error",
    });
  });

  it("accepts a monotonically newer attempt for the exact child tuple", () => {
    const result = validateChildBinding(
      child("normalCi"),
      {
        actor: { login: "github-actions[bot]" },
        conclusion: "",
        created_at: "2026-08-21T00:00:00Z",
        display_title: "normalCi",
        event: "workflow_dispatch",
        head_branch: "release-ci/tooling",
        head_sha: SHA,
        html_url: "https://example.invalid/runs/101",
        id: 101,
        path: ".github/workflows/ci.yml@refs/heads/release-ci/tooling",
        repository: { full_name: "openclaw/openclaw" },
        run_attempt: 2,
        status: "in_progress",
        updated_at: "2026-08-21T00:01:00Z",
        triggering_actor: { login: "release-operator" },
      },
      {
        jobs: [],
        observedRunAttempts: [1, 2],
        sha256: "c".repeat(64),
      },
    );
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ plannedRunAttempt: 1, runAttempt: 2 });
  });

  it.each([
    "HTTP 503: Server Error",
    "HTTP 429: API rate limit exceeded",
    "HTTP 403: secondary rate limit",
    "read ECONNRESET",
  ])("preserves the last valid snapshot through %s and then recovers", async (message) => {
    const planned = child("normalCi");
    const previous = {
      ...planned,
      conclusion: "success",
      jobs: [{ conclusion: "success", name: "test", status: "completed" }],
      status: "completed",
    };
    let fail = true;
    const readRun = async () => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error(message), {
          stderr: message,
        });
      }
      return {
        actor: { login: "github-actions[bot]" },
        conclusion: "success",
        created_at: "2026-08-21T00:00:00Z",
        display_title: planned.displayTitle,
        event: "workflow_dispatch",
        head_branch: planned.workflowRef,
        head_sha: planned.workflowSha,
        html_url: planned.url,
        id: 101,
        path: ".github/workflows/ci.yml",
        repository: { full_name: "openclaw/openclaw" },
        run_attempt: 1,
        status: "completed",
        triggering_actor: { login: "github-actions[bot]" },
        updated_at: "2026-08-21T00:01:00Z",
      };
    };
    const readAttemptJobs = async () => [
      {
        completed_at: "2026-08-21T00:01:00Z",
        conclusion: "success",
        html_url: "https://example.invalid/jobs/test",
        name: "test",
        started_at: "2026-08-21T00:00:00Z",
        status: "completed",
      },
    ];

    const degraded = await readChild(planned, previous, undefined, {
      readAttemptJobs,
      readRun,
    });
    expect(degraded).toMatchObject({
      conclusion: "success",
      errors: [],
      jobs: previous.jobs,
      status: "transport_uncertain",
    });
    expect(
      classifyReleaseSnapshot({
        children: [degraded],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ errors: [], state: "qualifying" });

    const recovered = await readChild(planned, degraded, undefined, {
      readAttemptJobs,
      readRun,
    });
    expect(recovered).toMatchObject({
      conclusion: "success",
      errors: [],
      status: "completed",
    });
    expect(
      classifyReleaseSnapshot({
        children: [recovered],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ errors: [], state: "passed" });
  });

  it("keeps exhausted transient reads uncertain instead of terminal", async () => {
    const planned = child("normalCi");
    const readRun = async () => {
      throw Object.assign(new Error("HTTP 503: Server Error"), {
        stderr: "HTTP 503: Server Error",
      });
    };
    let snapshot: Record<string, unknown> = planned;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      snapshot = await readChild(planned, snapshot, undefined, { readRun });
    }
    expect(snapshot).toMatchObject({
      errors: [],
      status: "transport_uncertain",
    });
    expect(
      classifyReleaseSnapshot({
        children: [snapshot],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({
      errors: [],
      state: "qualifying",
    });
  });

  it("keeps degraded reads nonterminal and cancellation-visible", async () => {
    const planned = child("normalCi");
    const degraded = await readChild(planned, planned, undefined, {
      readRun: async () => {
        throw Object.assign(new Error("read ECONNRESET"), { stderr: "read ECONNRESET" });
      },
    });
    expect(
      classifyReleaseSnapshot({
        cancelled: true,
        children: [degraded],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({
      activeRunIds: ["101"],
      errors: [],
      state: "cancelled_with_children",
    });
  });

  it("fails child provenance mismatches without consuming preserved success", async () => {
    const planned = child("normalCi");
    const observed = await readChild(
      planned,
      { ...planned, conclusion: "success", status: "completed" },
      undefined,
      {
        readAttemptJobs: async () => [],
        readRun: async () => ({
          actor: { login: "github-actions[bot]" },
          conclusion: "success",
          display_title: planned.displayTitle,
          event: "workflow_dispatch",
          head_branch: planned.workflowRef,
          head_sha: "c".repeat(40),
          id: 101,
          path: ".github/workflows/ci.yml",
          repository: { full_name: "openclaw/openclaw" },
          run_attempt: 1,
          status: "completed",
          triggering_actor: { login: "github-actions[bot]" },
        }),
      },
    );
    expect(observed.errors).toEqual([expect.objectContaining({ kind: "provenance_mismatch" })]);
    expect(
      classifyReleaseSnapshot({
        children: [observed],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ state: "orchestration_error" });
  });

  it.each(["HTTP 403: Resource not accessible by integration", "HTTP 403: Bad credentials"])(
    "keeps %s terminal",
    async (message) => {
      const planned = child("normalCi");
      const observed = await readChild(planned, planned, undefined, {
        readRun: async () => {
          throw Object.assign(new Error(message), { stderr: message });
        },
      });
      expect(observed).toMatchObject({
        errors: [expect.objectContaining({ kind: "api_error" })],
        transportFailure: undefined,
      });
    },
  );

  it("keeps malformed child responses terminal", async () => {
    const planned = child("normalCi");
    const observed = await readChild(planned, planned, undefined, {
      readRun: async () => ({}),
    });
    expect(observed.errors).toEqual([expect.objectContaining({ kind: "api_error" })]);
  });

  it("preserves complete composite evidence when the run read succeeds but jobs fail", async () => {
    const planned = child("normalCi");
    const previous = {
      ...planned,
      compositeJobsSha256: "f".repeat(64),
      conclusion: "success",
      jobs: [{ conclusion: "success", name: "test", status: "completed" }],
      observedRunAttempts: [1],
      plannedRunAttempt: 1,
      status: "completed",
      transportFailure: { errorClass: "transient" },
    };
    const observed = await readChild(planned, previous, undefined, {
      readAttemptJobs: async (_runId, attempt) => {
        if (attempt === 2) {
          throw Object.assign(new Error("HTTP 503: Server Error"), {
            stderr: "HTTP 503: Server Error",
          });
        }
        return previous.jobs;
      },
      readRun: async () => ({
        actor: { login: "github-actions[bot]" },
        conclusion: "",
        display_title: planned.displayTitle,
        event: "workflow_dispatch",
        head_branch: planned.workflowRef,
        head_sha: planned.workflowSha,
        id: 101,
        path: ".github/workflows/ci.yml",
        repository: { full_name: "openclaw/openclaw" },
        run_attempt: 2,
        status: "in_progress",
        triggering_actor: { login: "github-actions[bot]" },
      }),
    });
    expect(observed).toMatchObject({
      compositeJobsSha256: previous.compositeJobsSha256,
      jobs: previous.jobs,
      runAttempt: 1,
      status: "transport_uncertain",
      transportFailure: { errorClass: "transient" },
    });
    expect(
      await readChild(
        planned,
        {
          ...planned,
          status: "transport_uncertain",
          transportFailure: { errorClass: "transient" },
        },
        undefined,
        {
          readAttemptJobs: async () => [],
          readRun: async () => ({
            actor: { login: "github-actions[bot]" },
            display_title: planned.displayTitle,
            event: "workflow_dispatch",
            head_branch: planned.workflowRef,
            head_sha: planned.workflowSha,
            id: 101,
            path: ".github/workflows/ci.yml",
            repository: { full_name: "openclaw/openclaw" },
            run_attempt: 1,
            status: "in_progress",
            triggering_actor: { login: "github-actions[bot]" },
          }),
        },
      ),
    ).toMatchObject({
      status: "in_progress",
      transportFailure: { errorClass: "transient" },
    });
  });

  it("uses one fixed monotonic transport deadline until recovery", () => {
    const uncertainChild = {
      ...child("normalCi"),
      transportFailure: { errorClass: "transient" },
    };
    const first = updateReleaseTransportEpisode(undefined, [uncertainChild], {
      deadline: 900_000,
      monotonicNow: 100,
      wallNow: Date.parse("2026-08-29T00:00:00.100Z"),
    });
    const repeated = updateReleaseTransportEpisode(first, [uncertainChild], {
      monotonicNow: 899_999,
      wallNow: Date.parse("2026-08-29T01:00:00Z"),
    });
    const expired = updateReleaseTransportEpisode(first, [uncertainChild], {
      monotonicNow: 900_100,
      wallNow: Date.parse("2026-08-29T02:00:00Z"),
    });
    expect(repeated).toMatchObject({
      deadlineAt: first.deadlineAt,
      startedAt: "2026-08-29T00:00:00.000Z",
      status: "uncertain",
    });
    expect(expired).toMatchObject({
      deadlineAt: first.deadlineAt,
      error: { kind: "transport_deadline_exceeded" },
      status: "expired",
    });
    expect(
      updateReleaseTransportEpisode(first, [{ ...uncertainChild, transportFailure: undefined }]),
    ).toEqual({ status: "certain" });
  });

  it("caps GitHub retry sleep at the remaining transport deadline", () => {
    expect(releaseGhRetryDelayMs(6, 105_000, 100_000)).toBe(5_000);
    expect(releaseGhRetryDelayMs(6, 100_000, 100_000)).toBe(0);
  });

  it("cancels only exact active affected children", () => {
    expect(
      affectedActiveRunIds(
        [
          child("normalCi"),
          child("releaseChecks", { runId: "202" }),
          child("npmTelegram", { runId: "303", status: "completed" }),
        ],
        [{ runId: "101" }, { runId: "303" }],
      ),
    ).toEqual(["101"]);
  });
});

describe("release state artifacts", () => {
  const FAILED_JOB = {
    conclusion: "failure",
    name: "test",
    status: "completed",
    url: "https://example.invalid/jobs/test",
  };

  function artifact(
    mode: "decision" | "drain",
    parentRunAttempt = 2,
    sealedPlan = executionPlan({ rerunGroup: "ci" }),
    childOverrides: Record<string, unknown> = {},
    options: Record<string, any> = {},
  ) {
    const plannedChild = sealedPlan.children.find(
      (entry: Record<string, any>) => entry.key === "normalCi",
    );
    const children = [
      child("normalCi", {
        ...plannedChild,
        conclusion: "success",
        createdAt: "2026-08-21T00:00:00Z",
        status: "completed",
        updatedAt: "2026-08-21T00:01:00Z",
        ...childOverrides,
      }),
    ];
    const cancellation = options.cancellation ?? {};
    const decision = classifyReleaseSnapshot({
      cancelled: cancellation.requested === true,
      children,
      extraBlockers: options.extraBlockers,
      extraErrors: options.extraErrors,
      releaseProfile: "stable",
      workflowRef: "release-ci/tooling",
    });
    return buildReleaseStateArtifact({
      cancellation,
      children,
      decision,
      executionPlan: sealedPlan,
      expected: {
        parentRunAttempt,
        parentRunId: "77",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      },
      mode,
      releaseProfile: "stable",
      rerunGroup: "ci",
      transport: options.transport,
    });
  }

  function stateArtifact(
    mode: "decision" | "drain",
    state: string,
    sealedPlan = executionPlan({ rerunGroup: "ci" }),
  ) {
    const active = { conclusion: "", status: "in_progress" };
    if (state === "qualifying") {
      return artifact(mode, 2, sealedPlan, active);
    }
    if (state === "blocked_diagnostics_running") {
      return artifact(mode, 2, sealedPlan, { ...active, jobs: [FAILED_JOB] });
    }
    if (state === "blocked_complete") {
      return artifact(mode, 2, sealedPlan, { conclusion: "failure", jobs: [FAILED_JOB] });
    }
    if (state === "orchestration_error") {
      return artifact(
        mode,
        2,
        sealedPlan,
        {},
        {
          extraErrors: [{ child: "<collector>", kind: "api_error", message: `${mode} error` }],
        },
      );
    }
    if (state === "cancelled_with_children") {
      return artifact(mode, 2, sealedPlan, active, {
        cancellation: { cancelledRunIds: [], requested: true },
        extraErrors: [
          {
            child: "<collector>",
            kind: "collector_cancelled",
            message: `${mode} collector received a termination signal`,
          },
        ],
      });
    }
    return artifact(mode, 2, sealedPlan);
  }

  function blockedArtifacts(sealedPlan = executionPlan({ rerunGroup: "ci" })) {
    return {
      decision: artifact("decision", 2, sealedPlan, {
        conclusion: "",
        jobs: [FAILED_JOB],
        status: "in_progress",
      }),
      drain: artifact("drain", 2, sealedPlan, {
        conclusion: "failure",
        jobs: [FAILED_JOB],
      }),
      sealedPlan,
    };
  }

  function stateExpected(maxParentRunAttempt = 2) {
    return {
      maxParentRunAttempt,
      parentRunId: "77",
      releaseProfile: "stable",
      rerunGroup: "ci",
      targetSha: TARGET_SHA,
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    };
  }

  function compositeArtifact(status = "completed"): Record<string, any> {
    const composite = composeReleaseAttemptJobs(
      [
        {
          jobs: ["qa smoke ci", "QA Smoke CI"].map((name) => ({
            conclusion: "success",
            name,
            status: "completed",
          })),
          runAttempt: 1,
        },
      ],
      { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
    );
    return artifact("decision", 2, executionPlan({ rerunGroup: "ci" }), {
      compositeJobsSha256: composite.sha256,
      conclusion: status === "completed" ? "success" : "",
      dispatchActor: "github-actions[bot]",
      jobs: composite.jobs,
      observedRunAttempts: [1],
      plannedRunAttempt: 1,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      status,
      triggeringActor: "github-actions[bot]",
    });
  }

  function selectPair(
    sealedPlan: Record<string, any>,
    decision: Record<string, any>,
    drain: Record<string, any>,
  ) {
    return selectReleaseStateArtifacts(
      sealedPlan,
      [{ name: "full-release-decision-77-2", payload: decision }],
      [{ name: "full-release-diagnostics-77-2", payload: drain }],
      stateExpected(),
    );
  }

  it("uses one policy for decision, drain, and final verification", () => {
    expect(
      verifyReleaseStateArtifacts(
        executionPlan({ rerunGroup: "ci" }),
        artifact("decision"),
        artifact("drain"),
        { ...stateExpected(), parentRunAttempt: 2 },
      ),
    ).toMatchObject({ decision: { state: "passed" }, drain: { state: "passed" } });
  });

  it("records a blocker while transport is simultaneously uncertain", () => {
    const transport = updateReleaseTransportEpisode(undefined, [
      {
        ...child("normalCi"),
        transportFailure: { errorClass: "transient" },
      },
    ]);
    const payload = artifact(
      "decision",
      2,
      executionPlan({ rerunGroup: "ci" }),
      { conclusion: "", jobs: [FAILED_JOB], status: "in_progress" },
      { transport },
    );
    expect(payload).toMatchObject({
      blockerCount: 1,
      state: "blocked_diagnostics_running",
      transport: { status: "uncertain" },
    });
  });

  it("records expired transport without serializing collector internals", () => {
    const transport = updateReleaseTransportEpisode(
      undefined,
      [{ ...child("normalCi"), transportFailure: { errorClass: "transient" } }],
      {
        deadline: 900_000,
        monotonicNow: 0,
        wallNow: Date.parse("2026-08-29T00:00:00Z"),
      },
    );
    const expired = updateReleaseTransportEpisode(
      transport,
      [{ ...child("normalCi"), transportFailure: { errorClass: "transient" } }],
      { monotonicNow: 900_000, wallNow: Date.parse("2026-08-29T00:15:00Z") },
    );
    const payload = artifact(
      "decision",
      2,
      executionPlan({ rerunGroup: "ci" }),
      {},
      {
        extraErrors: [expired.error],
        transport: expired,
      },
    );
    expect(payload.errors).toContainEqual(
      expect.objectContaining({ kind: "transport_deadline_exceeded" }),
    );
    expect(payload.transport).not.toHaveProperty("deadlineMonotonicMs");
    expect(payload.transport).not.toHaveProperty("error");
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).not.toThrow();
  });

  it("does not create fail-fast cancellation targets from uncertainty alone", () => {
    const snapshots = [
      {
        ...child("normalCi"),
        status: "transport_uncertain",
        transportFailure: { errorClass: "transient" },
      },
    ];
    const decision = classifyReleaseSnapshot({
      children: snapshots,
      releaseProfile: "stable",
      workflowRef: "main",
    });
    expect(decision).toMatchObject({ blockers: [], state: "qualifying" });
    expect(affectedActiveRunIds(snapshots, decision.blockers)).toEqual([]);
  });

  it("keeps a complete deterministic 31-entry blocker index", () => {
    const jobs = Array.from({ length: 31 }, (_, index) => ({
      ...FAILED_JOB,
      completed_at: `2026-08-29T00:00:${String(index).padStart(2, "0")}Z`,
      name: `failed-${String(index).padStart(2, "0")}`,
    }));
    const payload = artifact("decision", 2, executionPlan({ rerunGroup: "ci" }), {
      conclusion: "failure",
      jobs,
    });
    expect(payload.blockers).toHaveLength(25);
    expect(payload.blockerIndex).toHaveLength(31);
    expect(payload).toMatchObject({
      blockerCount: 31,
      firstPrimaryFailure: { job: "failed-00", kind: "job_failure" },
    });
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).not.toThrow();
  });

  it("keeps a maximal paginated retry blocker index within the artifact budget", () => {
    const attempts = Array.from({ length: 5 }, (_unused, attempt) => ({
      jobs: Array.from({ length: 100 }, (_, offset) => {
        const index = attempt * 100 + offset;
        return {
          ...FAILED_JOB,
          name: `failed-${String(index).padStart(3, "0")}`,
          url: `https://example.invalid/jobs/${"x".repeat(960)}-${index}`,
        };
      }),
      runAttempt: attempt + 1,
    }));
    const composite = composeReleaseAttemptJobs(attempts, {
      effectiveRunAttempt: 5,
      plannedRunAttempt: 1,
    });
    const payload = artifact("decision", 2, executionPlan({ rerunGroup: "ci" }), {
      compositeJobsSha256: composite.sha256,
      conclusion: "failure",
      jobs: composite.jobs,
      observedRunAttempts: attempts.map(({ runAttempt }) => runAttempt),
      plannedRunAttempt: 1,
      runAttempt: 5,
    });
    const bytes = Buffer.byteLength(serializeReleaseArtifact(payload), "utf8");
    expect(payload.blockerIndex).toHaveLength(500);
    expect(bytes).toBeLessThanOrEqual(MAX_RELEASE_ARTIFACT_BYTES);
  });

  it("reads legacy v2 evidence without claiming blocked-list completeness", () => {
    const passed = structuredClone(artifact("decision"));
    const blocked = structuredClone(stateArtifact("decision", "blocked_complete"));
    for (const payload of [passed, blocked]) {
      delete payload.blockerCount;
      delete payload.blockerIndex;
      delete payload.firstPrimaryFailure;
      delete payload.transport;
    }
    expect(validateReleaseStateArtifact(passed, stateExpected(), "decision")).toMatchObject({
      blockerCount: null,
      transport: { status: "certain" },
    });
    expect(validateReleaseStateArtifact(blocked, stateExpected(), "decision")).toMatchObject({
      blockerCount: null,
      state: "blocked_complete",
      transport: null,
    });
  });

  it("rejects malformed complete blocker evidence", () => {
    const payload = structuredClone(stateArtifact("decision", "blocked_complete"));
    payload.blockerCount = Number(payload.blockerCount) + 1;
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).toThrow(
      "release state machine evidence is invalid",
    );
  });

  it("round-trips mixed-case composite jobs through state validation", () => {
    const payload = compositeArtifact();
    expect(payload.children.normalCi.timing.jobs.map((job: { name: string }) => job.name)).toEqual([
      "QA Smoke CI",
      "qa smoke ci",
    ]);
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).not.toThrow();
  });

  it("rejects noncanonical composite job ordering", () => {
    const payload = compositeArtifact();
    payload.children.normalCi.timing.jobs.reverse();
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).toThrow(
      "release state child composite jobs are invalid: normalCi",
    );
  });

  it("accepts a queued run snapshot after its jobs have progressed", () => {
    expect(
      validateReleaseStateArtifact(compositeArtifact("queued"), stateExpected(), "decision"),
    ).toMatchObject({
      activeRunIds: ["101"],
      children: {
        normalCi: {
          status: "queued",
          timing: {
            jobs: [
              { name: "QA Smoke CI", status: "completed" },
              { name: "qa smoke ci", status: "completed" },
            ],
          },
        },
      },
      state: "qualifying",
    });
  });

  it("requires Decision and Drain to carry identical accepted attempt evidence", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact("decision", 2, sealedPlan);
    const drain = structuredClone(artifact("drain", 2, sealedPlan));
    const snapshot = drain.children.normalCi!;
    snapshot.runAttempt = 2;
    expect(() =>
      verifyReleaseStateArtifacts(sealedPlan, decision, drain, {
        maxParentRunAttempt: 2,
        parentRunId: "77",
        releaseProfile: "stable",
        rerunGroup: "ci",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      }),
    ).toThrow("release decision and diagnostic drain child evidence differ");
  });

  it("includes terminal status and conclusion in canonical child evidence", () => {
    const base = {
      compositeJobsSha256: "a".repeat(64),
      conclusion: "success",
      dispatchActor: "github-actions[bot]",
      observedRunAttempts: [1],
      plannedRunAttempt: 1,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runId: "101",
      status: "completed",
      timing: { jobs: [] },
      triggeringActor: "vincentkoc",
      workflow: "ci.yml",
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    };
    expect(releaseStateChildEvidence(base)).not.toEqual(
      releaseStateChildEvidence({ ...base, conclusion: "failure" }),
    );
    expect(releaseStateChildEvidence(base)).not.toEqual(
      releaseStateChildEvidence({ ...base, status: "in_progress" }),
    );
  });

  it.each([
    [
      "beta performance",
      "performance",
      "productPerformance",
      [
        {
          conclusion: "failure",
          name: "benchmark",
          status: "completed",
        },
      ],
    ],
    [
      "beta release-check advisory",
      "qa-parity",
      "releaseChecks",
      [
        {
          conclusion: "failure",
          name: "Run QA Lab runtime-pair lane (core)",
          status: "completed",
        },
        {
          conclusion: "success",
          name: "Verify release checks",
          status: "completed",
        },
      ],
    ],
  ])(
    "rejects divergent terminal conclusions on the $0 surface",
    (_label, rerunGroup, key, jobs) => {
      const sealedPlan = executionPlan({ rerunGroup }, { releaseProfile: "beta", rerunGroup });
      const plannedChild = sealedPlan.children.find(
        (entry: Record<string, any>) => entry.key === key,
      );
      const makeArtifact = (mode: "decision" | "drain", conclusion: string) =>
        buildReleaseStateArtifact({
          children: [
            child(key, {
              ...plannedChild,
              conclusion,
              createdAt: "2026-08-21T00:00:00Z",
              jobs,
              status: "completed",
              updatedAt: "2026-08-21T00:01:00Z",
            }),
          ],
          decision: { activeRunIds: [], blockers: [], errors: [], state: "passed" },
          executionPlan: sealedPlan,
          expected: {
            parentRunAttempt: 2,
            parentRunId: "77",
            targetSha: TARGET_SHA,
            workflowRef: "release-ci/tooling",
            workflowSha: SHA,
          },
          mode,
          releaseProfile: "beta",
          rerunGroup,
        });
      expect(() =>
        verifyReleaseStateArtifacts(
          sealedPlan,
          makeArtifact("decision", "success"),
          makeArtifact("drain", "failure"),
          {
            maxParentRunAttempt: 2,
            parentRunId: "77",
            releaseProfile: "beta",
            rerunGroup,
            targetSha: TARGET_SHA,
            workflowRef: "release-ci/tooling",
            workflowSha: SHA,
          },
        ),
      ).toThrow("release decision and diagnostic drain child evidence differ");
    },
  );

  it.each([
    [
      "duplicate active run IDs",
      (value: Record<string, any>) => (value.activeRunIds = ["101", "101"]),
    ],
    [
      "unordered active run IDs",
      (value: Record<string, any>) => (value.activeRunIds = ["202", "101"]),
    ],
    [
      "malformed active run IDs",
      (value: Record<string, any>) => (value.activeRunIds = ["", "101"]),
    ],
    [
      "duplicate observed attempts",
      (value: Record<string, any>) => (value.children.normalCi.observedRunAttempts = [1, 1]),
    ],
    [
      "unordered observed attempts",
      (value: Record<string, any>) => (value.children.normalCi.observedRunAttempts = [2, 1]),
    ],
    [
      "gapped observed attempts",
      (value: Record<string, any>) => (value.children.normalCi.observedRunAttempts = [1, 3]),
    ],
  ])("rejects $0 without filtering or cleanup", (_name, mutate) => {
    const payload = structuredClone(artifact("decision"));
    mutate(payload);
    expect(() =>
      validateReleaseStateArtifact(payload, {
        parentRunAttempt: 2,
        parentRunId: "77",
        releaseProfile: "stable",
        rerunGroup: "ci",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      }),
    ).toThrow(/invalid|gapped|malformed/u);
  });

  it("selects the newest decision and drain independently across asymmetric retries", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const selected = selectReleaseStateArtifacts(
      sealedPlan,
      [
        { name: "full-release-decision-77-1", payload: artifact("decision", 1, sealedPlan) },
        { name: "full-release-decision-77-2", payload: artifact("decision", 2, sealedPlan) },
      ],
      [{ name: "full-release-diagnostics-77-1", payload: artifact("drain", 1, sealedPlan) }],
      stateExpected(3),
    );
    expect(selected.sourceAttempts).toEqual({ decision: 2, drain: 1, executionPlan: 1 });
  });

  it("selects a blocked decision with its completed diagnostic drain", () => {
    const { decision, sealedPlan } = blockedArtifacts();
    const drain = artifact("drain", 2, sealedPlan, {
      conclusion: "failure",
      jobs: [
        FAILED_JOB,
        { ...FAILED_JOB, name: "terminal diagnostic", url: "https://example.invalid/jobs/drain" },
      ],
    });
    const selected = selectPair(sealedPlan, decision, drain);
    expect(selected).toMatchObject({
      decision: { activeRunIds: ["101"], state: "blocked_diagnostics_running" },
      drain: { activeRunIds: [], blockers: [{ job: "test" }, { job: "terminal diagnostic" }] },
    });
  });

  it("selects a terminal blocked pair when workflow evidence refines to failed jobs", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact("decision", 2, sealedPlan, {
      conclusion: "failure",
      jobs: [],
    });
    const drain = stateArtifact("drain", "blocked_complete", sealedPlan);
    expect(selectPair(sealedPlan, decision, drain).drain.blockers).toContainEqual(
      expect.objectContaining({ job: "test", kind: "job_failure" }),
    );
  });

  it.each([
    ["blocked_diagnostics_running", "orchestration_error"],
    ["blocked_complete", "orchestration_error"],
    ["passed", "orchestration_error"],
    ["orchestration_error", "passed"],
    ["orchestration_error", "blocked_complete"],
    ["orchestration_error", "orchestration_error"],
  ])("selects recovery evidence from %s to %s", (from, to) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    expect(
      selectPair(
        sealedPlan,
        stateArtifact("decision", from, sealedPlan),
        stateArtifact("drain", to, sealedPlan),
      ),
    ).toMatchObject({ decision: { state: from }, drain: { state: to } });
  });

  it("selects a fail-fast cancellation bound to its active blocked child", () => {
    const { decision, drain, sealedPlan } = blockedArtifacts();
    decision.cancellation = { cancelledRunIds: ["101"], requested: false };
    expect(selectPair(sealedPlan, decision, drain).decision.cancellation).toEqual({
      cancelledRunIds: ["101"],
      requested: false,
    });
  });

  it.each([
    ["cancelled_with_children", "passed"],
    ["passed", "cancelled_with_children"],
  ])("selects signal cancellation recovery evidence from %s to %s", (from, to) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    expect(
      selectPair(
        sealedPlan,
        stateArtifact("decision", from, sealedPlan),
        stateArtifact("drain", to, sealedPlan),
      ),
    ).toMatchObject({ decision: { state: from }, drain: { state: to } });
  });

  it("selects a cancellation request that races with child completion", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact(
      "decision",
      2,
      sealedPlan,
      {},
      {
        cancellation: { requested: true },
        extraErrors: [
          {
            child: "<collector>",
            kind: "collector_cancelled",
            message: "decision collector received a termination signal",
          },
        ],
      },
    );
    const drain = stateArtifact("drain", "passed", sealedPlan);
    expect(selectPair(sealedPlan, decision, drain).decision.state).toBe("orchestration_error");
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "Full Release Validation state: orchestration_error",
    );
  });

  it("rejects a forged passed state with an unproven cancellation request", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact("decision", 2, sealedPlan);
    const drain = artifact("drain", 2, sealedPlan);
    decision.cancellation = { cancelledRunIds: [], requested: true };
    expect(() => selectPair(sealedPlan, decision, drain)).toThrow("cancellation differs");
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "cancellation differs",
    );
  });

  it("selects reuse-validation blocker recovery without authorizing publication", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact(
      "decision",
      2,
      sealedPlan,
      {},
      {
        extraBlockers: [
          {
            child: "<evidence>",
            kind: "reused_evidence_invalid",
            message: "reuse validation failed",
          },
        ],
      },
    );
    const drain = stateArtifact("drain", "passed", sealedPlan);
    expect(selectPair(sealedPlan, decision, drain).decision.state).toBe("blocked_complete");
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "Full Release Validation state: blocked_complete\n- Blocker: reuse validation failed",
    );
  });

  it.each(["reused_evidence_invalid", "provenance_mismatch"])(
    "selects active %s recovery without authorizing publication",
    (kind) => {
      const sealedPlan = executionPlan({ rerunGroup: "ci" });
      const decision = artifact(
        "decision",
        2,
        sealedPlan,
        { conclusion: "", status: "in_progress" },
        { extraBlockers: [{ child: "<evidence>", kind, message: "evidence failed" }] },
      );
      const drain = stateArtifact("drain", "passed", sealedPlan);
      expect(selectPair(sealedPlan, decision, drain).decision.state).toBe(
        "blocked_diagnostics_running",
      );
      expect(() =>
        verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected()),
      ).toThrow(
        "Full Release Validation state: blocked_diagnostics_running\n- Blocker: evidence failed",
      );
    },
  );

  it("rejects evidence recovery mixed with a child-run blocker", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact(
      "decision",
      2,
      sealedPlan,
      { conclusion: "", jobs: [FAILED_JOB], status: "in_progress" },
      {
        extraBlockers: [
          { child: "<evidence>", kind: "reused_evidence_invalid", message: "evidence failed" },
        ],
      },
    );
    expect(() =>
      selectPair(sealedPlan, decision, stateArtifact("drain", "passed", sealedPlan)),
    ).toThrow("transition is invalid");
  });

  it("rejects blocked artifacts for publication with the terminal drain blocker", () => {
    const { decision, drain, sealedPlan } = blockedArtifacts();
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "Full Release Validation state: blocked_complete\n- Blocker: test (failure)",
    );
  });

  it("reports the decision error when a recovered drain passed", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    expect(() =>
      verifyReleaseStateArtifacts(
        sealedPlan,
        stateArtifact("decision", "orchestration_error", sealedPlan),
        stateArtifact("drain", "passed", sealedPlan),
        stateExpected(),
      ),
    ).toThrow("Full Release Validation state: orchestration_error\n- Collector error:");
  });

  it("does not authorize selected signal cancellation evidence", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    expect(() =>
      verifyReleaseStateArtifacts(
        sealedPlan,
        stateArtifact("decision", "cancelled_with_children", sealedPlan),
        stateArtifact("drain", "passed", sealedPlan),
        stateExpected(),
      ),
    ).toThrow("Full Release Validation state: cancelled_with_children");
  });

  it.each([
    {
      name: "removed decision blocker",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain = artifact("drain", 2, pair.sealedPlan, {
          conclusion: "failure",
          jobs: [],
        });
      },
      reason: "changed or removed",
    },
    {
      name: "changed decision blocker",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain = artifact("drain", 2, pair.sealedPlan, {
          conclusion: "failure",
          jobs: [{ ...FAILED_JOB, name: "different test" }],
        });
      },
      reason: "changed or removed",
    },
    {
      name: "child provenance drift",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain.children.normalCi!.displayTitle = "nearby title";
      },
      reason: "provenance differs",
    },
    {
      name: "active drain",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain = artifact("drain", 2, pair.sealedPlan, {
          conclusion: "",
          jobs: [FAILED_JOB],
          status: "in_progress",
        });
      },
      reason: "transition is invalid",
    },
    {
      name: "signal cancellation without active children",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain.cancellation = { cancelledRunIds: ["101"], requested: true };
      },
      reason: "cancellation differs",
    },
    {
      name: "falsely classified drain",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain.state = "passed";
      },
      reason: "differs from canonical release policy",
    },
  ])("rejects a blocked transition with $name", ({ mutate, reason }) => {
    const pair = blockedArtifacts();
    mutate(pair);
    const { decision, drain, sealedPlan } = pair;
    expect(() => selectPair(sealedPlan, decision, drain)).toThrow(reason);
  });

  it.each([
    ["qualifying", "passed"],
    ["passed", "blocked_complete"],
    ["blocked_complete", "passed"],
    ["blocked_diagnostics_running", "passed"],
    ["blocked_diagnostics_running", "blocked_diagnostics_running"],
    ["orchestration_error", "blocked_diagnostics_running"],
    ["cancelled_with_children", "blocked_diagnostics_running"],
  ])("rejects contradictory evidence from %s to %s", (from, to) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    expect(() =>
      selectPair(
        sealedPlan,
        stateArtifact("decision", from, sealedPlan),
        stateArtifact("drain", to, sealedPlan),
      ),
    ).toThrow("transition is invalid");
  });

  it.each([
    {
      name: "unplanned signal cancellation ID",
      cancelledRunIds: ["999"],
      state: "cancelled_with_children",
    },
    {
      name: "fail-fast cancellation without a blocker",
      cancelledRunIds: ["101"],
      state: "qualifying",
    },
    {
      name: "duplicate fail-fast cancellation ID",
      cancelledRunIds: ["101", "101"],
      state: "blocked_diagnostics_running",
    },
    {
      name: "nonnumeric fail-fast cancellation ID",
      cancelledRunIds: ["01"],
      state: "blocked_diagnostics_running",
    },
  ])("rejects $name", ({ cancelledRunIds, state }) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = stateArtifact("decision", state, sealedPlan);
    decision.cancellation = {
      cancelledRunIds,
      requested: state === "cancelled_with_children",
    };
    expect(() =>
      selectPair(sealedPlan, decision, stateArtifact("drain", "passed", sealedPlan)),
    ).toThrow("cancellation differs");
  });

  it("accepts runtime-only blockers and errors as conservative evidence", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact(
      "decision",
      2,
      sealedPlan,
      {},
      {
        extraBlockers: [
          { child: "<evidence>", kind: "provenance_mismatch", message: "reuse drift" },
        ],
        extraErrors: [{ child: "<collector>", kind: "api_error", message: "collector failed" }],
      },
    );
    expect(
      selectPair(sealedPlan, decision, stateArtifact("drain", "passed", sealedPlan)),
    ).toMatchObject({
      decision: {
        blockers: [expect.objectContaining({ kind: "provenance_mismatch" })],
        errors: [expect.objectContaining({ kind: "api_error" })],
        state: "orchestration_error",
      },
    });
  });

  it("fails closed when bounded runtime errors displace baseline child errors", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const childErrors = Array.from({ length: 25 }, (_, index) => ({
      child: "normalCi",
      kind: "api_error",
      message: `child error ${index}`,
    }));
    const extraErrors = Array.from({ length: 5 }, (_, index) => ({
      child: "<collector>",
      kind: "api_error",
      message: `collector error ${index}`,
    }));
    const decision = artifact("decision", 2, sealedPlan, { errors: childErrors }, { extraErrors });
    expect(() =>
      selectPair(sealedPlan, decision, stateArtifact("drain", "passed", sealedPlan)),
    ).toThrow("omits baseline errors");
  });

  function selectFromFilesystem(layout: "asymmetric" | "multi" | "single") {
    const root = mkdtempSync(join(tmpdir(), `frv-select-${layout}-`));
    const executionPlanPath = join(root, "plan.json");
    const decisionRoot = join(root, "decisions");
    const drainRoot = join(root, "drains");
    const decisionPath = join(root, "selected-decision.json");
    const drainPath = join(root, "selected-drain.json");
    const outputPath = join(root, "output.txt");
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    mkdirSync(decisionRoot);
    mkdirSync(drainRoot);
    writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
    const writeCandidate = (
      candidateRoot: string,
      prefix: string,
      filename: string,
      mode: "decision" | "drain",
      attempt: number,
      direct: boolean,
    ) => {
      const target = direct
        ? join(candidateRoot, filename)
        : join(candidateRoot, `${prefix}-77-${attempt}`, filename);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, JSON.stringify(artifact(mode, attempt, sealedPlan)));
    };
    if (layout === "single") {
      writeCandidate(
        decisionRoot,
        "full-release-decision",
        "full-release-decision.json",
        "decision",
        2,
        true,
      );
      writeCandidate(
        drainRoot,
        "full-release-diagnostics",
        "full-release-diagnostic-manifest.json",
        "drain",
        2,
        true,
      );
    } else {
      writeCandidate(
        decisionRoot,
        "full-release-decision",
        "full-release-decision.json",
        "decision",
        1,
        false,
      );
      writeCandidate(
        decisionRoot,
        "full-release-decision",
        "full-release-decision.json",
        "decision",
        2,
        false,
      );
      writeCandidate(
        drainRoot,
        "full-release-diagnostics",
        "full-release-diagnostic-manifest.json",
        "drain",
        layout === "asymmetric" ? 1 : 2,
        false,
      );
    }
    const result = spawnSync(process.execPath, [SCRIPT, "select"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DIAGNOSTIC_DRAIN_ATTEMPTS_PATH: drainRoot,
        DIAGNOSTIC_DRAIN_PATH: drainPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "3",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        RELEASE_DECISION_ATTEMPTS_PATH: decisionRoot,
        RELEASE_DECISION_PATH: decisionPath,
        RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(outputPath, "utf8");
  }

  it("selects state from the direct-file layout used for one artifact match", () => {
    expect(selectFromFilesystem("single")).toContain("decision_source_attempt=2");
  });

  it("selects the newest state from the subdirectory layout used for multiple matches", () => {
    expect(selectFromFilesystem("multi")).toContain("drain_source_attempt=2");
  });

  it("selects asymmetric Decision and Drain retries from filesystem artifacts", () => {
    expect(selectFromFilesystem("asymmetric")).toContain("drain_source_attempt=1");
  });

  it.each([
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.displayTitle = "nearby title";
      },
      name: "changed child display title",
      reason: "provenance differs",
    },
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.workflow = "nearby.yml";
      },
      name: "changed child workflow",
      reason: "provenance differs",
    },
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.workflowRef = "main";
      },
      name: "changed child workflow ref",
      reason: "provenance differs",
    },
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.workflowSha = "f".repeat(40);
      },
      name: "changed child tooling SHA",
      reason: "provenance differs",
    },
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.conclusion = "failure";
      },
      name: "failed child hidden behind passed state",
      reason: "omits baseline blockers",
    },
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.errors = [{ kind: "api_error", message: "hidden" }];
      },
      name: "hidden child collector error",
      reason: "omits baseline errors",
    },
  ])("rejects a malformed passed drain with $name", ({ mutate, reason }) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact("decision", 2, sealedPlan);
    const drain = structuredClone(artifact("drain", 2, sealedPlan));
    mutate(drain);
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      reason,
    );
  });

  it("uses state-specific operator guidance", () => {
    expect(
      formatReleaseStateOutcome({
        blockers: [{ conclusion: "failure", job: "test", url: "https://example.invalid/job" }],
        errors: [],
        state: "blocked_diagnostics_running",
      }),
    ).toContain("diagnose now, retry later");
    expect(
      formatReleaseStateOutcome({ blockers: [], errors: [], state: "blocked_complete" }),
    ).not.toContain("still collecting");
  });
});

describe("collector subprocess", () => {
  it.each([
    {
      changedPaths: [],
      evidenceSha: TARGET_SHA,
      name: "exact-target",
      policy: "exact-target-full-validation-v1",
      trustedWorkflow: TRUSTED_MAIN,
    },
    {
      changedPaths: ["CHANGELOG.md"],
      evidenceSha: "c".repeat(40),
      name: "changelog-only",
      policy: "changelog-only-release-v1",
      trustedWorkflow: {
        fullRef: `refs/tags/release-publish/${SHA.slice(0, 12)}-123`,
        ref: `release-publish/${SHA.slice(0, 12)}-123`,
        sha: SHA,
      },
    },
  ])("seals and revalidates the complete $name reuse tuple", (reuse) => {
    const root = mkdtempSync(join(tmpdir(), "frv-plan-reuse-"));
    const output = join(root, "full-release-execution-plan.json");
    const validator = join(root, "release-evidence-validator.mjs");
    const validatorArgs = join(root, "validator-args.json");
    writeFileSync(
      validator,
      `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.FRV_VALIDATOR_ARGS, JSON.stringify(args));
const value = (flag) => args[args.indexOf(flag) + 1];
const expected = JSON.parse(process.env.FRV_EXPECTED_REUSE);
for (const [flag, wanted] of Object.entries(expected)) {
  if (value(flag) !== wanted) {
    console.error(\`\${flag} mismatch: \${value(flag)} != \${wanted}\`);
    process.exit(1);
  }
}
console.log(JSON.stringify({
  children: JSON.parse(process.env.FRV_REUSED_CHILDREN),
  manifest: JSON.parse(process.env.FRV_EVIDENCE_MANIFEST),
  releaseProfile: process.env.RELEASE_PROFILE,
  rerunGroup: process.env.RERUN_GROUP,
}));
`,
    );
    const planInputs = {
      candidateRequestInput: candidateRequestInput(),
      children: {},
      dockerPreflightResult: "skipped",
      evidenceChangedPaths: reuse.changedPaths,
      evidenceManifest: { attackerControlled: true },
      evidencePolicy: reuse.policy,
      evidenceReuse: true,
      evidenceRootRunId: "99",
      evidenceRunId: "99",
      evidenceRunUrl: "https://example.invalid/runs/99",
      evidenceSha: reuse.evidenceSha,
      parentRunAttempt: 1,
      parentRunId: "77",
      candidateBindingResult: "skipped",
      rerunGroup: "all",
      resolveTargetResult: "success",
      trustedWorkflow: reuse.trustedWorkflow,
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    };
    const result = spawnSync(process.execPath, [SCRIPT, "plan"], {
      env: {
        ...process.env,
        FRV_EXPECTED_REUSE: JSON.stringify({
          "--expected-changed-paths-json": JSON.stringify(reuse.changedPaths),
          "--expected-evidence-policy": reuse.policy,
          "--expected-evidence-sha": reuse.evidenceSha,
          "--expected-root-run-id": "99",
          "--expected-selected-run-id": "99",
          "--expected-target-sha": TARGET_SHA,
          "--trusted-workflow-full-ref": reuse.trustedWorkflow.fullRef,
          "--trusted-workflow-ref": reuse.trustedWorkflow.ref,
          "--trusted-workflow-sha": reuse.trustedWorkflow.sha,
          "--validate-run": "99",
        }),
        FRV_EVIDENCE_MANIFEST: JSON.stringify(evidenceManifest()),
        FRV_REUSED_CHILDREN: JSON.stringify(reusedEvidenceChildren()),
        FRV_VALIDATOR_ARGS: validatorArgs,
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(planInputs),
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "all",
        TARGET_SHA,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      children: [
        expect.objectContaining({ key: "normalCi", runId: "101", source: "reused" }),
        expect.objectContaining({ key: "pluginPrerelease", runId: "202", source: "reused" }),
        expect.objectContaining({ key: "releaseChecks", runId: "303", source: "reused" }),
        expect.objectContaining({ key: "npmTelegram", selected: false }),
        expect.objectContaining({ key: "productPerformance", runId: "505", source: "reused" }),
      ],
      evidenceReuse: {
        changedPaths: reuse.changedPaths,
        evidenceSha: reuse.evidenceSha,
        policy: reuse.policy,
        requested: true,
        rootRunId: "99",
        runUrl: "https://example.invalid/runs/99",
        selectedRunId: "99",
        sourceManifest: evidenceManifest(),
      },
      trustedWorkflow: reuse.trustedWorkflow,
    });
    expect(JSON.parse(readFileSync(validatorArgs, "utf8"))).toContain("--expected-selected-run-id");
  });

  it("blocks Decision when canonical evidence manifest changes after planning", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-reuse-manifest-mismatch-"));
    const output = join(root, "decision.json");
    const executionPlanPath = join(root, "plan.json");
    const gh = join(root, "gh");
    const validator = join(root, "validator.mjs");
    const sealedPlan = executionPlan(
      { rerunGroup: "ci" },
      {
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: TARGET_SHA,
          policy: "exact-target-full-validation-v1",
          requested: true,
          rootRunId: "99",
          runUrl: "https://example.invalid/runs/99",
          selectedRunId: "99",
          sourceManifest: evidenceManifest(),
        },
      },
    );
    writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
    writeFileSync(
      gh,
      `#!/bin/sh
case "$*" in
  *"/attempts/1/jobs?"*)
    printf '%s\\n' '{"name":"test","status":"completed","conclusion":"success","started_at":"2026-08-21T00:00:00Z","completed_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/jobs/1"}'
    exit 0
    ;;
esac
printf '%s\\n' '{"id":101,"event":"workflow_dispatch","path":".github/workflows/ci.yml@refs/heads/release-ci/tooling","display_title":"CI full-release-validation-77-1-ci","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"completed","conclusion":"success","created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/101","actor":{"login":"github-actions[bot]"},"triggering_actor":{"login":"github-actions[bot]"},"repository":{"full_name":"openclaw/openclaw"}}'
`,
    );
    chmodSync(gh, 0o755);
    writeFileSync(
      validator,
      `console.log(JSON.stringify({
  children: ${JSON.stringify(reusedEvidenceChildren())},
  manifest: {runAttempt: 1, runId: "99", targetSha: "${"c".repeat(40)}"},
  releaseProfile: "stable",
  rerunGroup: "ci"
}));\n`,
    );
    const result = spawnSync(process.execPath, [SCRIPT, "decision"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAIL_FAST: "false",
        FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        FULL_RELEASE_STATE_PATH: output,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
        PATH: `${root}:${process.env.PATH}`,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(readFileSync(output, "utf8")).blockers).toContainEqual(
      expect.objectContaining({
        kind: "provenance_mismatch",
        message: "revalidated evidence source manifest differs from the immutable plan",
      }),
    );
  });

  it("validates a generated manifest against its immutable execution plan", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-generated-manifest-"));
    const executionPlanPath = join(root, "plan.json");
    const manifestPath = join(root, "manifest.json");
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
    writeFileSync(manifestPath, JSON.stringify(generatedManifest(sealedPlan)));
    const env = {
      ...process.env,
      GITHUB_REF_NAME: "release-ci/tooling",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "77",
      GITHUB_SHA: SHA,
      RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      RELEASE_PROFILE: "stable",
      RELEASE_VALIDATION_MANIFEST_PATH: manifestPath,
      RERUN_GROUP: "ci",
      TARGET_SHA,
    };
    const valid = spawnSync(process.execPath, [SCRIPT, "validate-manifest"], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    expect(valid.status, valid.stderr).toBe(0);
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...generatedManifest(sealedPlan), sourceParentRunAttempt: 2 }),
    );
    const invalid = spawnSync(process.execPath, [SCRIPT, "validate-manifest"], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain(
      "release validation manifest differs from the immutable execution plan",
    );
  });

  it("binds the generated manifest to the candidate sealed by attempt one", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-generated-candidate-manifest-"));
    const decisionPath = join(root, "decision.json");
    const drainPath = join(root, "drain.json");
    const executionPlanPath = join(root, "plan.json");
    const manifestPath = join(root, "manifest.json");
    const candidate = candidateBinding();
    const sealedPlan = executionPlan(
      { rerunGroup: "ci" },
      { attemptEvidenceVersion: 2, candidate, candidateRequest: candidate.request },
    );
    const plannedChild = sealedPlan.children.find(
      (entry: Record<string, any>) => entry.key === "normalCi",
    );
    const composite = composeReleaseAttemptJobs(
      [
        {
          jobs: [
            {
              completed_at: "2026-08-21T00:01:00Z",
              conclusion: "success",
              html_url: "https://example.invalid/jobs/test",
              name: "test",
              started_at: "2026-08-21T00:00:00Z",
              status: "completed",
            },
          ],
          runAttempt: 1,
        },
      ],
      { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
    );
    const children = [
      child("normalCi", {
        ...plannedChild,
        compositeJobsSha256: composite.sha256,
        conclusion: "success",
        createdAt: "2026-08-21T00:00:00Z",
        dispatchActor: "github-actions[bot]",
        jobs: composite.jobs,
        observedRunAttempts: [1],
        plannedRunAttempt: 1,
        repository: "openclaw/openclaw",
        status: "completed",
        triggeringActor: "github-actions[bot]",
        updatedAt: "2026-08-21T00:01:00Z",
      }),
    ];
    const decision = classifyReleaseSnapshot({
      cancelled: false,
      children,
      releaseProfile: "stable",
      workflowRef: "release-ci/tooling",
    });
    const stateArtifact = (mode: "decision" | "drain") =>
      buildReleaseStateArtifact({
        cancellation: {},
        children,
        decision,
        executionPlan: sealedPlan,
        expected: {
          parentRunAttempt: 2,
          parentRunId: "77",
          targetSha: TARGET_SHA,
          workflowRef: "release-ci/tooling",
          workflowSha: SHA,
        },
        mode,
        releaseProfile: "stable",
        rerunGroup: "ci",
      });
    const decisionArtifact = stateArtifact("decision");
    const drainArtifact = stateArtifact("drain");
    const childEvidence = Object.fromEntries(
      Object.entries(drainArtifact.children).map(([key, stateChild]: [string, any]) => [
        key,
        {
          compositeJobsSha256: stateChild.compositeJobsSha256,
          dispatchActor: stateChild.dispatchActor,
          effectiveRunAttempt: stateChild.runAttempt,
          jobs: stateChild.timing.jobs.map((job: Record<string, unknown>) => ({
            acceptedRunAttempt: job.acceptedRunAttempt,
            completedAt: job.completedAt,
            conclusion: job.conclusion,
            name: job.name,
            startedAt: job.startedAt,
            status: job.status,
            url: job.url,
          })),
          observedRunAttempts: stateChild.observedRunAttempts,
          plannedRunAttempt: stateChild.plannedRunAttempt,
          repository: stateChild.repository,
          runId: stateChild.runId,
          triggeringActor: stateChild.triggeringActor,
        },
      ]),
    );
    writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
    writeFileSync(decisionPath, JSON.stringify(decisionArtifact));
    writeFileSync(drainPath, JSON.stringify(drainArtifact));
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...generatedManifest(sealedPlan), childEvidence }),
    );
    const env = {
      ...process.env,
      DIAGNOSTIC_DRAIN_PATH: drainPath,
      GITHUB_REF_NAME: "release-ci/tooling",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "77",
      GITHUB_SHA: SHA,
      RELEASE_DECISION_PATH: decisionPath,
      RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      RELEASE_PROFILE: "stable",
      RELEASE_VALIDATION_MANIFEST_PATH: manifestPath,
      RERUN_GROUP: "ci",
      TARGET_SHA,
    };
    const valid = spawnSync(process.execPath, [SCRIPT, "validate-manifest"], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    expect(valid.status, valid.stderr).toBe(0);

    const changed = {
      ...generatedManifest(sealedPlan),
      candidateBinding: {
        ...candidate,
        evidenceArtifact: { ...candidate.evidenceArtifact, id: "999" },
      },
      childEvidence,
    };
    writeFileSync(manifestPath, JSON.stringify(changed));
    const invalid = spawnSync(process.execPath, [SCRIPT, "validate-manifest"], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("candidate");
  });

  it.each([
    {
      mutate: (manifest: Record<string, any>) => {
        manifest.childRuns.normalCi = "999";
      },
      name: "wrong selected child",
      planReuse: false,
    },
    {
      mutate: (manifest: Record<string, any>) => {
        manifest.childRuns.releaseChecks = "303";
      },
      name: "nonempty unselected child",
      planReuse: false,
    },
    {
      mutate: (manifest: Record<string, any>) => {
        manifest.evidenceReuse.selectedRunId = "100";
      },
      name: "wrong evidence reuse tuple",
      planReuse: true,
    },
  ])("rejects a generated manifest with $name", ({ mutate, planReuse }) => {
    const root = mkdtempSync(join(tmpdir(), "frv-invalid-generated-manifest-"));
    const executionPlanPath = join(root, "plan.json");
    const manifestPath = join(root, "manifest.json");
    const reuse = {
      changedPaths: [],
      evidenceSha: TARGET_SHA,
      policy: "exact-target-full-validation-v1",
      requested: true,
      rootRunId: "99",
      runUrl: "https://example.invalid/runs/99",
      selectedRunId: "99",
      sourceManifest: evidenceManifest(),
    };
    const sealedPlan = executionPlan(
      { rerunGroup: "ci" },
      planReuse ? { evidenceReuse: reuse } : {},
    );
    const manifest = generatedManifest(sealedPlan);
    if (planReuse) {
      manifest.evidenceReuse = {
        changedPaths: reuse.changedPaths,
        evidenceSha: reuse.evidenceSha,
        policy: reuse.policy,
        runId: reuse.rootRunId,
        selectedRunId: reuse.selectedRunId,
      };
    }
    mutate(manifest);
    writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [SCRIPT, "validate-manifest"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        RELEASE_PROFILE: "stable",
        RELEASE_VALIDATION_MANIFEST_PATH: manifestPath,
        RERUN_GROUP: "ci",
        TARGET_SHA,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "release validation manifest differs from the immutable execution plan",
    );
  });

  it("persists a classified plan that Release Decision can consume after reuse rejection", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-classified-plan-"));
    const output = join(root, "full-release-execution-plan.json");
    const decisionOutput = join(root, "full-release-decision.json");
    const validator = join(root, "release-evidence-validator.mjs");
    writeFileSync(
      validator,
      'console.error("sealed reuse selection rejected"); process.exit(1);\n',
    );
    const planInputs = {
      candidateRequestInput: candidateRequestInput(),
      children: {},
      dockerPreflightResult: "skipped",
      evidenceChangedPaths: [],
      evidencePolicy: "exact-target-full-validation-v1",
      evidenceReuse: true,
      evidenceRootRunId: "99",
      evidenceRunId: "99",
      evidenceRunUrl: "https://example.invalid/runs/99",
      evidenceSha: TARGET_SHA,
      parentRunAttempt: 1,
      parentRunId: "77",
      candidateBindingResult: "skipped",
      rerunGroup: "all",
      resolveTargetResult: "success",
      trustedWorkflow: TRUSTED_MAIN,
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    };
    const baseEnv = {
      ...process.env,
      FULL_RELEASE_EXECUTION_PLAN_PATH: output,
      GITHUB_REF_NAME: "release-ci/tooling",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "77",
      GITHUB_SHA: SHA,
      OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
      RELEASE_PROFILE: "stable",
      RERUN_GROUP: "all",
      TARGET_SHA,
    };
    const planResult = spawnSync(process.execPath, [SCRIPT, "plan"], {
      encoding: "utf8",
      env: {
        ...baseEnv,
        FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(planInputs),
      },
      timeout: 10_000,
    });
    expect(planResult.status).toBe(2);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      blockers: [expect.objectContaining({ kind: "reused_evidence_invalid" })],
      errors: [],
    });

    const decisionResult = spawnSync(process.execPath, [SCRIPT, "decision"], {
      encoding: "utf8",
      env: {
        ...baseEnv,
        FAIL_FAST: "false",
        FULL_RELEASE_STATE_PATH: decisionOutput,
      },
      timeout: 10_000,
    });
    expect(decisionResult.status).toBe(1);
    expect(JSON.parse(readFileSync(decisionOutput, "utf8"))).toMatchObject({
      state: "blocked_complete",
    });
    expect(JSON.parse(readFileSync(decisionOutput, "utf8")).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "reused_evidence_invalid" })]),
    );
  });

  it("restores the phased attempt-one plan unchanged on an attempt-two collector retry", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-plan-restore-"));
    const output = join(root, "full-release-execution-plan.json");
    const githubOutput = join(root, "github-output");
    const candidate = candidateBinding();
    const phasedChildren = {
      normalCi: { result: "success", runAttempt: 1, runId: "101" },
      pluginPrereleaseIndependent: { result: "success", runAttempt: 1, runId: "202" },
      pluginPrereleaseCandidate: { result: "success", runAttempt: 1, runId: "203" },
      releaseChecksIndependent: { result: "success", runAttempt: 1, runId: "303" },
      releaseChecksCandidate: { result: "success", runAttempt: 1, runId: "304" },
      npmTelegram: { result: "success", runAttempt: 1, runId: "404" },
      productPerformance: { result: "success", runAttempt: 1, runId: "505" },
    };
    const sealed = executionPlan(
      {
        candidateAcquisitionResult: "success",
        candidateRequired: true,
        childPhaseVersion: 3,
        children: phasedChildren,
      },
      {
        attemptEvidenceVersion: 3,
        candidate,
        candidateRequest: candidate.request,
      },
    );
    writeFileSync(output, JSON.stringify(sealed));
    const result = spawnSync(process.execPath, [SCRIPT, "plan"], {
      env: {
        ...process.env,
        ...candidateRequestEnvironment(),
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_PLAN_INPUTS_JSON: "must-not-be-read-during-restore",
        FULL_RELEASE_RESTORE_PLAN: "true",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "all",
        TARGET_SHA,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const restored = JSON.parse(readFileSync(output, "utf8")) as typeof sealed;
    expect(restored).toMatchObject({
      attemptEvidenceVersion: 3,
      parentRunAttempt: 1,
      sha256: sealed.sha256,
    });
    expect(restored.candidate).toEqual(candidate);
    expect(restored).toMatchObject({ candidate: { publisher: candidate.publisher } });
    const phasedKeys = new Set([
      "pluginPrereleaseIndependent",
      "pluginPrereleaseCandidate",
      "releaseChecksIndependent",
      "releaseChecksCandidate",
    ]);
    expect(restored.children.filter((entry) => phasedKeys.has(entry.key))).toEqual(
      sealed.children.filter((entry) => phasedKeys.has(entry.key)),
    );
    expect(readFileSync(githubOutput, "utf8")).toContain("source_parent_attempt=1\n");
  });

  it.each([
    {
      mutate: (artifact: Record<string, any>) => {
        artifact.parentRunAttempt = 2;
      },
      name: "wrong source parent attempt",
    },
    {
      mutate: (artifact: Record<string, any>) => {
        artifact.targetSha = "c".repeat(40);
      },
      name: "wrong validation SHA",
    },
    {
      mutate: (artifact: Record<string, any>) => {
        artifact.children[0].workflow = "plugin-prerelease.yml";
      },
      name: "wrong child identity",
    },
  ])("rejects restored execution plan artifact with $name", ({ mutate }) => {
    const artifact = structuredClone(executionPlan({ rerunGroup: "ci" }));
    mutate(artifact);
    artifact.sha256 = releaseExecutionPlanSha256(artifact);
    expect(() =>
      validateReleaseExecutionPlanArtifact(artifact, {
        parentRunId: "77",
        releaseProfile: "stable",
        rerunGroup: "ci",
        sourceParentRunAttempt: 1,
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      }),
    ).toThrow(/release execution plan (artifact binding|child identity) is invalid/u);
  });

  it("writes the execution plan immediately when SIGTERM interrupts a stalled reuse API", async () => {
    const root = mkdtempSync(join(tmpdir(), "frv-plan-signal-"));
    const gh = join(root, "gh");
    const ghReady = join(root, "gh-ready");
    const output = join(root, "full-release-execution-plan.json");
    writeFileSync(gh, '#!/bin/sh\nprintf ready > "$FRV_GH_READY"\nsleep 30\n');
    chmodSync(gh, 0o755);
    const childProcess = spawn(process.execPath, [SCRIPT, "plan"], {
      env: {
        ...process.env,
        EVIDENCE_CHANGED_PATHS: "[]",
        FRV_GH_READY: ghReady,
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify({
          candidateRequestInput: candidateRequestInput(),
          children: { normalCi: { result: "skipped", runAttempt: "", runId: "" } },
          dockerPreflightResult: "skipped",
          evidenceChangedPaths: [],
          evidencePolicy: "exact-target-full-validation-v1",
          evidenceReuse: true,
          evidenceRootRunId: "99",
          evidenceRunId: "99",
          evidenceRunUrl: "https://example.invalid/runs/99",
          evidenceSha: TARGET_SHA,
          parentRunAttempt: 1,
          parentRunId: "77",
          candidateBindingResult: "skipped",
          rerunGroup: "ci",
          resolveTargetResult: "success",
          trustedWorkflow: TRUSTED_MAIN,
          workflowRef: "release-ci/tooling",
          workflowSha: SHA,
        }),
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        PATH: `${root}:${process.env.PATH}`,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA,
      },
      stdio: "ignore",
    });
    await waitForFile(ghReady, 5_000);
    const exitPromise = waitForChildClose(childProcess);
    const started = Date.now();
    expect(childProcess.kill("SIGTERM")).toBe(true);
    await expect(exitPromise).resolves.toEqual({ code: 1, signal: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      errors: [expect.objectContaining({ kind: "collector_cancelled" })],
      parentRunAttempt: 1,
    });
  });

  it("records target resolution failure even when no target SHA exists", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-state-target-failure-"));
    const output = join(root, "decision.json");
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan(
          {
            children: { normalCi: { result: "skipped", runAttempt: "", runId: "" } },
            dockerPreflightResult: "skipped",
            candidateBindingResult: "skipped",
            rerunGroup: "ci",
            resolveTargetResult: "failure",
          },
          {
            expected: {
              parentRunAttempt: 1,
              parentRunId: "77",
              targetSha: "",
              workflowRef: "release-ci/tooling",
              workflowSha: SHA,
            },
          },
        ),
      ),
    );
    const result = spawnSync(process.execPath, [SCRIPT, "decision"], {
      env: {
        ...process.env,
        FAIL_FAST: "false",
        FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        FULL_RELEASE_STATE_PATH: output,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA: "",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(1);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact).toMatchObject({
      state: "blocked_complete",
      targetSha: "",
    });
    expect(artifact.blockers).toContainEqual(
      expect.objectContaining({
        kind: "parent_gate_failure",
        message: expect.stringContaining("Resolve target ref"),
      }),
    );
  });

  it("writes an immediate terminal handoff with active identity on SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "frv-state-signal-"));
    const gh = join(root, "gh");
    const ghReady = join(root, "gh-ready");
    const output = join(root, "drain.json");
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan({
          children: { normalCi: { result: "success", runAttempt: 1, runId: "101" } },
          dockerPreflightResult: "skipped",
          candidateBindingResult: "skipped",
          rerunGroup: "ci",
          resolveTargetResult: "success",
        }),
      ),
    );
    writeFileSync(
      gh,
      `#!/bin/sh
printf ready > "$FRV_GH_READY"
case "$*" in
  "api --paginate repos/openclaw/openclaw/actions/runs/101/attempts/1/jobs?per_page=100 --jq .jobs[] | @json")
    exit 0
    ;;
esac
printf '%s\\n' '{"id":101,"event":"workflow_dispatch","path":".github/workflows/ci.yml@refs/heads/release-ci/tooling","display_title":"CI full-release-validation-77-1-ci","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"in_progress","conclusion":null,"created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/101","actor":{"login":"github-actions[bot]"},"triggering_actor":{"login":"github-actions[bot]"},"repository":{"full_name":"openclaw/openclaw"}}'
`,
    );
    chmodSync(gh, 0o755);
    const childProcess = spawn(process.execPath, [SCRIPT, "drain"], {
      env: {
        ...process.env,
        FAIL_FAST: "false",
        FRV_GH_READY: ghReady,
        FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        FULL_RELEASE_POLL_INTERVAL_MS: "60000",
        FULL_RELEASE_STATE_PATH: output,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        PATH: `${root}:${process.env.PATH}`,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA: "b".repeat(40),
      },
      stdio: "ignore",
    });
    await waitForFile(ghReady, 5_000);
    const exitPromise = waitForChildClose(childProcess);
    expect(childProcess.kill("SIGTERM")).toBe(true);
    await expect(exitPromise).resolves.toEqual({ code: 1, signal: null });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      activeRunIds: ["101"],
      cancellation: { requested: true },
      state: "cancelled_with_children",
    });
  });

  it("cancels only the exact affected child and never cancels from drain", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-state-fail-fast-"));
    const gh = join(root, "gh");
    const calls = join(root, "calls");
    writeFileSync(calls, "");
    writeFileSync(
      gh,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FRV_GH_CALLS"
if [ "$1" = "run" ] && [ "$2" = "cancel" ]; then
  exit 0
fi
case "$*" in
  *"/jobs?"*)
    case "$*" in
      *"/101/"*) printf '%s\\n' '{"name":"test","status":"completed","conclusion":"failure","html_url":"https://example.invalid/jobs/test"}' ;;
    esac
    exit 0
    ;;
esac
endpoint="$2"
[ "$endpoint" = "--paginate" ] && endpoint="$3"
run_id=$(printf '%s' "$endpoint" | sed 's#^.*/##')
title="CI full-release-validation-77-1-ci"
workflow="ci.yml"
case "$run_id" in
  202) title="Plugin Prerelease full-release-validation-77-1-plugin-prerelease"; workflow="plugin-prerelease.yml" ;;
  303) title="OpenClaw Release Checks full-release-validation-77-1-release-checks"; workflow="openclaw-release-checks.yml" ;;
  505) title="OpenClaw Performance full-release-validation-77-1"; workflow="openclaw-performance.yml" ;;
esac
status="completed"
[ "$run_id" = 101 ] && status="$FRV_FAILED_RUN_STATUS"
printf '{"id":%s,"event":"workflow_dispatch","path":".github/workflows/%s@refs/heads/release-ci/tooling","display_title":"%s","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"%s","conclusion":"%s","created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/%s","actor":{"login":"github-actions[bot]"},"triggering_actor":{"login":"github-actions[bot]"},"repository":{"full_name":"openclaw/openclaw"}}\\n' "$run_id" "$workflow" "$title" "$status" "$([ "$run_id" = 101 ] && echo failure || echo success)" "$run_id"
`,
    );
    chmodSync(gh, 0o755);
    const planInputs = {
      children: {
        normalCi: { result: "success", runAttempt: 1, runId: "101" },
        pluginPrerelease: { result: "success", runAttempt: 1, runId: "202" },
        productPerformance: { result: "success", runAttempt: 1, runId: "505" },
        releaseChecks: { result: "success", runAttempt: 1, runId: "303" },
      },
      dockerPreflightResult: "success",
      evidenceReuse: false,
      parentRunAttempt: 2,
      parentRunId: "77",
      candidateBindingResult: "success",
      rerunGroup: "all",
      resolveTargetResult: "success",
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    };
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan(planInputs, {
          expected: {
            parentRunAttempt: 1,
            parentRunId: "77",
            targetSha: TARGET_SHA,
            workflowRef: "release-ci/tooling",
            workflowSha: SHA,
          },
        }),
      ),
    );
    const baseEnv = {
      ...process.env,
      FRV_GH_CALLS: calls,
      FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      GITHUB_REF_NAME: "release-ci/tooling",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "77",
      GITHUB_SHA: SHA,
      PATH: `${root}:${process.env.PATH}`,
      RELEASE_PROFILE: "stable",
      RERUN_GROUP: "all",
      TARGET_SHA: "b".repeat(40),
    };
    const decision = spawnSync(process.execPath, [SCRIPT, "decision"], {
      env: {
        ...baseEnv,
        FAIL_FAST: "true",
        FRV_FAILED_RUN_STATUS: "in_progress",
        FULL_RELEASE_STATE_PATH: join(root, "decision.json"),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(decision.signal, decision.stderr).toBeNull();
    const afterDecision = readFileSync(calls, "utf8");
    expect(afterDecision).toContain("run cancel 101");
    expect(afterDecision).not.toContain("run cancel 202");
    writeFileSync(calls, "");
    const drain = spawnSync(process.execPath, [SCRIPT, "drain"], {
      env: {
        ...baseEnv,
        FAIL_FAST: "false",
        FRV_FAILED_RUN_STATUS: "completed",
        FULL_RELEASE_STATE_PATH: join(root, "drain.json"),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(drain.signal, drain.stderr).toBeNull();
    expect(readFileSync(calls, "utf8")).not.toContain("run cancel");
  });
});
