import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseExecutionPlanSha256 } from "../../scripts/full-release-validation-policy.mjs";
import {
  affectedActiveRunIds,
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  buildReleaseStateArtifact,
  classifyReleaseGhTransportError,
  classifyReleaseSnapshot,
  formatReleaseStateOutcome,
  selectReleaseStateArtifacts,
  validateChildBinding,
  validateReleaseExecutionPlanArtifact,
  verifyReleaseStateArtifacts,
} from "../../scripts/full-release-validation-state.mjs";
import { waitForChildClose, waitForFile } from "../helpers/process-wait.js";

const SCRIPT = resolve("scripts/full-release-validation-state.mjs");
const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const TRUSTED_MAIN = { fullRef: "refs/heads/main", ref: "main", sha: SHA };

function evidenceManifest() {
  return { runAttempt: 1, runId: "99", targetSha: TARGET_SHA };
}

function generatedManifest(planArtifact: Record<string, any>): Record<string, any> {
  return {
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
    prepareCandidateResult: "success",
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
  const expected = {
    parentRunAttempt: 1,
    parentRunId: "77",
    targetSha: TARGET_SHA,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...((artifactOverrides.expected as Record<string, unknown> | undefined) ?? {}),
  };
  const built = plan({ ...overrides, parentRunAttempt: expected.parentRunAttempt });
  return buildReleaseExecutionPlanArtifact({
    children: built.children,
    expected,
    gates: built.gates,
    releaseProfile: "stable",
    rerunGroup: String(overrides.rerunGroup ?? "all"),
    trustedWorkflow: TRUSTED_MAIN,
    ...artifactOverrides,
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

describe("full release execution plan", () => {
  it.each([
    ["HTTP 429: rate limited", "transient"],
    ["HTTP 503: Server Error", "transient"],
    ["spawnSync gh ETIMEDOUT", "transient"],
    ["read ECONNRESET", "transient"],
    ["getaddrinfo EAI_AGAIN api.github.com", "transient"],
    ["unexpected EOF", "transient"],
    ["HTTP 401: Bad credentials", "hard"],
    ["HTTP 403: secondary rate limit", "hard"],
    ["unknown flag: --name\nUsage: gh run download", "hard"],
  ] as const)("classifies GitHub transport error %s as %s", (message, expected) => {
    expect(
      classifyReleaseGhTransportError(Object.assign(new Error(message), { stderr: message })),
    ).toBe(expected);
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
        children: result.children.map((entry) => ({
          ...entry,
          errors: [],
          jobs: [],
          status: "missing",
        })),
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
        plan({ prepareCandidateResult: "skipped", rerunGroup }).gates.find(
          (entry) => entry.name === "Prepare shared release candidate",
        ),
      ).toMatchObject({ required: false });
    },
  );

  it("does not prepare a candidate for published packages", () => {
    expect(
      plan({
        packageAcceptancePackageSpec: "openclaw@2026.8.4-beta.3",
        prepareCandidateResult: "skipped",
        rerunGroup: "package",
      }).gates.at(-1),
    ).toMatchObject({ required: false });
  });

  it("requires live-e2e candidate preparation only without a suite filter", () => {
    expect(plan({ rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject({ required: true });
    expect(plan({ liveSuiteFilter: "discord", rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject(
      {
        required: false,
      },
    );
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

  it("binds the exact child attempt and tooling tuple", () => {
    const result = validateChildBinding(
      child("normalCi"),
      {
        conclusion: "",
        created_at: "2026-08-21T00:00:00Z",
        display_title: "normalCi",
        event: "workflow_dispatch",
        head_branch: "release-ci/tooling",
        head_sha: SHA,
        html_url: "https://example.invalid/runs/101",
        id: 101,
        path: ".github/workflows/ci.yml@refs/heads/release-ci/tooling",
        run_attempt: 2,
        status: "in_progress",
        updated_at: "2026-08-21T00:01:00Z",
      },
      [],
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        kind: "provenance_mismatch",
        message: expect.stringContaining("attempt"),
      }),
    ]);
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
  function artifact(
    mode: "decision" | "drain",
    parentRunAttempt = 2,
    sealedPlan = executionPlan({ rerunGroup: "ci" }),
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
      }),
    ];
    return buildReleaseStateArtifact({
      children,
      decision: { activeRunIds: [], blockers: [], errors: [], state: "passed" },
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
    });
  }

  it("uses one policy for decision, drain, and final verification", () => {
    expect(
      verifyReleaseStateArtifacts(
        executionPlan({ rerunGroup: "ci" }),
        artifact("decision"),
        artifact("drain"),
        {
          parentRunAttempt: 2,
          parentRunId: "77",
          releaseProfile: "stable",
          rerunGroup: "ci",
          targetSha: TARGET_SHA,
          workflowSha: SHA,
        },
      ),
    ).toMatchObject({ decision: { state: "passed" }, drain: { state: "passed" } });
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
      {
        maxParentRunAttempt: 3,
        parentRunId: "77",
        releaseProfile: "stable",
        rerunGroup: "ci",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      },
    );
    expect(selected.sourceAttempts).toEqual({ decision: 2, drain: 1, executionPlan: 1 });
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
      reason: "canonical terminal release policy",
    },
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.errors = [{ kind: "api_error", message: "hidden" }];
      },
      name: "hidden child collector error",
      reason: "contains collector errors",
    },
  ])("rejects a malformed passed drain with $name", ({ mutate, reason }) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = artifact("decision", 2, sealedPlan);
    const drain = structuredClone(artifact("drain", 2, sealedPlan));
    mutate(drain);
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
    ).toThrow(reason);
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
      prepareCandidateResult: "skipped",
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
  *"/jobs?"*) exit 0 ;;
esac
printf '%s\\n' '{"id":101,"event":"workflow_dispatch","path":".github/workflows/ci.yml@refs/heads/release-ci/tooling","display_title":"CI full-release-validation-77-1-ci","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"completed","conclusion":"success","created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/101"}'
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
      prepareCandidateResult: "skipped",
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

  it("adopts the immutable attempt-one plan on an attempt-two collector retry", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-plan-restore-"));
    const output = join(root, "full-release-execution-plan.json");
    const sealed = executionPlan({ rerunGroup: "ci" });
    writeFileSync(output, JSON.stringify(sealed));
    const result = spawnSync(process.execPath, [SCRIPT, "plan"], {
      env: {
        ...process.env,
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_RESTORE_PLAN: "true",
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      parentRunAttempt: 1,
      sha256: sealed.sha256,
    });
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
          prepareCandidateResult: "skipped",
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
    childProcess.kill("SIGTERM");
    await exitPromise;
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
            prepareCandidateResult: "skipped",
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
          prepareCandidateResult: "skipped",
          rerunGroup: "ci",
          resolveTargetResult: "success",
        }),
      ),
    );
    writeFileSync(
      gh,
      `#!/bin/sh
printf ready > "$FRV_GH_READY"
if [ "$1" = "api" ] && echo "$2" | grep -q '/jobs'; then
  exit 0
fi
printf '%s\\n' '{"id":101,"event":"workflow_dispatch","path":".github/workflows/ci.yml@refs/heads/release-ci/tooling","display_title":"CI full-release-validation-77-1-ci","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"in_progress","conclusion":null,"created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/101"}'
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
    childProcess.kill("SIGTERM");
    await exitPromise;
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
printf '{"id":%s,"event":"workflow_dispatch","path":".github/workflows/%s@refs/heads/release-ci/tooling","display_title":"%s","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"%s","conclusion":"%s","created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/%s"}\\n' "$run_id" "$workflow" "$title" "$status" "$([ "$run_id" = 101 ] && echo failure || echo success)" "$run_id"
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
      prepareCandidateResult: "success",
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
