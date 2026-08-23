import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  continueFailed,
  continuationBranchName,
  createClient,
  inspectContinuation,
  loadPlan,
  preflightContinuation,
  validateLegacySource,
} from "../../scripts/frv.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  HISTORICAL_CONTINUATION_SOURCE_MODE,
  releaseChildSpec,
  releaseCompositeJobsSha256,
  verifyReleaseContinuationSource,
} from "../../scripts/full-release-validation-policy.mjs";
import { resolveReleaseToolingIdentity } from "../../scripts/release-tooling-identity.mjs";
import { validateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const SOURCE_REF = `release-ci/${SHA.slice(0, 12)}-77`;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const VALIDATION_INPUTS = {
  allowUnreleasedChangelog: "false",
  codexPluginSpec: "",
  crossOsSuiteFilter: "",
  liveSuiteFilter: "",
  mode: "both",
  npmTelegramPackageSpec: "",
  npmTelegramProviderMode: "mock-openai",
  npmTelegramScenario: "",
  packageAcceptancePackageSpec: "",
  pluginPrereleaseNodeExcludePatternsJson: "[]",
  provider: "openai",
  releasePackageSpec: "",
  skipPackageTelegramE2e: "false",
  targetContextRef: "",
};

function candidate(parentRunId = "77", parentRunAttempt = "1") {
  return {
    imageArchiveSha256: "1".repeat(64),
    imageArtifactDigest: "2".repeat(64),
    imageArtifactId: "12",
    imageArtifactName: `image-${parentRunId}-${parentRunAttempt}`,
    imageArtifactRunAttempt: parentRunAttempt,
    imageArtifactRunId: parentRunId,
    packageArtifactDigest: "3".repeat(64),
    packageArtifactId: "13",
    packageArtifactName: `package-${parentRunId}-${parentRunAttempt}`,
    packageArtifactRunAttempt: parentRunAttempt,
    packageArtifactRunId: parentRunId,
    packageFileName: "openclaw-current.tgz",
    packageSha256: "4".repeat(64),
    packageSourceSha: TARGET_SHA,
    packageVersion: "2026.8.1-beta.3",
    prepublishPluginRegistryArtifactDigest: "5".repeat(64),
    prepublishPluginRegistryArtifactId: "14",
    prepublishPluginRegistryArtifactName: `plugins-${parentRunId}-${parentRunAttempt}`,
    prepublishPluginRegistryArtifactRunAttempt: parentRunAttempt,
    prepublishPluginRegistryArtifactRunId: parentRunId,
    prepublishPluginRegistryManifestSha256: "6".repeat(64),
  };
}

function continuation() {
  return {
    candidate: candidate(),
    publicationEnabled: false,
    releaseProfile: "beta",
    rerunGroup: "all",
    runReleaseSoak: "false",
    sourceDisplayTitle: "Full Release Validation",
    sourceEvent: "workflow_dispatch",
    sourceRepository: "openclaw/openclaw",
    sourceRunAttempt: 1,
    sourceRunId: "77",
    sourceWorkflowPath: ".github/workflows/full-release-validation.yml",
    sourceWorkflowRef: SOURCE_REF,
    sourceWorkflowSha: SHA,
    sourceEvidenceMode: HISTORICAL_CONTINUATION_SOURCE_MODE,
    toolingSha: SHA,
    validationInputs: VALIDATION_INPUTS,
  };
}

function sealedContinuationPlan(selected = child("normalCi", "101"), parentRunId = "88") {
  const source = continuation();
  const branch = continuationBranchName(source.sourceRunId, source.toolingSha);
  return buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 1,
    children: [
      {
        ...selected,
        dispatchName: "Dispatch CI",
        result: "success",
        source: "continuation",
      },
    ],
    continuation: source,
    evidenceReuse: { requested: false },
    expected: {
      parentRunAttempt: 1,
      parentRunId,
      targetSha: TARGET_SHA,
      workflowRef: branch,
      workflowSha: SHA,
    },
    gates: [{ name: "Resolve target ref", required: true, result: "success" }],
    releaseProfile: "beta",
    rerunGroup: "all",
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
  });
}

function job(name: string, conclusion = "success") {
  return {
    completed_at: "2026-08-22T00:01:00Z",
    conclusion,
    html_url: `https://example.invalid/jobs/${name}`,
    name,
    started_at: "2026-08-22T00:00:00Z",
    status: "completed",
  };
}

function child(key: string, runId: string) {
  const spec = releaseChildSpec(key);
  return {
    displayTitle: `${spec.displayName} full-release-validation-77-1${spec.suffix}`,
    key,
    required: true,
    runAttempt: 1,
    runId,
    selected: true,
    sourceParentAttempt: 1,
    url: `https://example.invalid/runs/${runId}`,
    workflow: spec.workflow,
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

function runFor(entry: ReturnType<typeof child>, attempt: number, conclusion: string | null) {
  return {
    conclusion,
    actor: { login: "github-actions[bot]" },
    display_title: entry.displayTitle,
    event: "workflow_dispatch",
    head_branch: entry.workflowRef,
    head_sha: entry.workflowSha,
    html_url: entry.url,
    id: Number(entry.runId),
    path: `.github/workflows/${entry.workflow}`,
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: attempt,
    status: conclusion === null ? "in_progress" : "completed",
    triggering_actor: { login: attempt > 1 ? "release-operator" : "github-actions[bot]" },
  };
}

function plan(children: ReturnType<typeof child>[]) {
  return {
    children,
    parentRunAttempt: 1,
    parentRunId: "77",
    releaseProfile: "beta",
    rerunGroup: "all",
    targetSha: TARGET_SHA,
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

function continuationPlan(
  children: ReturnType<typeof child>[],
  source: Omit<ReturnType<typeof continuation>, "sourceEvidenceMode"> & {
    sourceEvidenceMode?: string;
  } = continuation(),
) {
  return {
    children: Object.fromEntries(children.map((entry) => [entry.key, entry])),
    continuation: source,
    legacy: true,
    releaseProfile: source.releaseProfile,
    rerunGroup: "all",
    targetSha: TARGET_SHA,
  };
}

function sourceManifest(children: ReturnType<typeof child>[], source = continuation()) {
  const childRuns = {
    normalCi: "",
    npmTelegram: "",
    pluginPrerelease: "",
    productPerformance: { blocking: true, conclusion: "failure", runId: "" },
    releaseChecks: "",
  };
  for (const entry of children) {
    if (entry.key === "productPerformance") {
      childRuns.productPerformance.runId = entry.runId;
    } else {
      childRuns[entry.key as keyof Omit<typeof childRuns, "productPerformance">] = entry.runId;
    }
  }
  return {
    childRuns,
    controls: {
      performanceBlocking: true,
      performanceReportPublication: "artifact-only",
      stableSoakRequired: false,
    },
    releaseProfile: source.releaseProfile,
    rerunGroup: "all",
    runAttempt: source.sourceRunAttempt,
    runId: source.sourceRunId,
    runReleaseSoak: source.runReleaseSoak,
    targetSha: TARGET_SHA,
    validationInputs: source.validationInputs,
    workflowRef: source.sourceWorkflowRef,
    workflowSha: source.sourceWorkflowSha,
  };
}

function historicalRootResolveLog(source = continuation()) {
  const environment = {
    ALLOW_UNRELEASED_CHANGELOG: source.validationInputs.allowUnreleasedChangelog,
    CODEX_PLUGIN_SPEC: source.validationInputs.codexPluginSpec,
    CROSS_OS_SUITE_FILTER: source.validationInputs.crossOsSuiteFilter,
    LIVE_SUITE_FILTER: source.validationInputs.liveSuiteFilter,
    NPM_TELEGRAM_PACKAGE_SPEC: source.validationInputs.npmTelegramPackageSpec,
    PACKAGE_ACCEPTANCE_PACKAGE_SPEC: source.validationInputs.packageAcceptancePackageSpec,
    PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON:
      source.validationInputs.pluginPrereleaseNodeExcludePatternsJson,
    RELEASE_PACKAGE_SPEC: source.validationInputs.releasePackageSpec,
    RELEASE_PROFILE: source.releaseProfile,
    RUN_RELEASE_SOAK: source.runReleaseSoak,
    SKIP_PACKAGE_TELEGRAM_E2E: source.validationInputs.skipPackageTelegramE2e,
    TARGET_CONTEXT_REF: source.validationInputs.targetContextRef,
  };
  return [
    "2026-08-22T00:00:00Z ##[group]Run summarize",
    "2026-08-22T00:00:00Z   env:",
    ...Object.entries(environment).map(
      ([key, value]) => `2026-08-22T00:00:00Z     ${key}: ${value}`,
    ),
    "2026-08-22T00:00:00Z ##[endgroup]",
  ].join("\n");
}

function historicalReleaseChecksResolveLog(source = continuation()) {
  const environment = {
    CANDIDATE_ARTIFACT_JSON_INPUT: JSON.stringify(source.candidate),
    RELEASE_MODE_INPUT: source.validationInputs.mode,
    RELEASE_PROVIDER_INPUT: source.validationInputs.provider,
    RELEASE_REF_INPUT: source.candidate.packageSourceSha,
  };
  return [
    "2026-08-22T00:00:00Z ##[group]Run capture",
    "2026-08-22T00:00:00Z   env:",
    ...Object.entries(environment).map(
      ([key, value]) => `2026-08-22T00:00:00Z     ${key}: ${value}`,
    ),
    "2026-08-22T00:00:00Z ##[endgroup]",
  ].join("\n");
}

function historicalReusableInputsLog(source = continuation()) {
  const entries = Object.entries({
    advisory: "false",
    allow_unreleased_changelog: source.validationInputs.allowUnreleasedChangelog,
    codex_plugin_spec: source.validationInputs.codexPluginSpec,
    cross_os_suite_filter: source.validationInputs.crossOsSuiteFilter,
    dispatch_release_evidence: "false",
    expected_sha: source.candidate.packageSourceSha,
    fail_fast: "false",
    live_suite_filter: source.validationInputs.liveSuiteFilter,
    mode: source.validationInputs.mode,
    npm_telegram_package_spec: source.validationInputs.npmTelegramPackageSpec,
    npm_telegram_provider_mode: source.validationInputs.npmTelegramProviderMode,
    npm_telegram_scenario: source.validationInputs.npmTelegramScenario,
    package_acceptance_package_spec: source.validationInputs.packageAcceptancePackageSpec,
    plugin_prerelease_node_exclude_patterns_json:
      source.validationInputs.pluginPrereleaseNodeExcludePatternsJson,
    prepare_only: "true",
    provider: source.validationInputs.provider,
    ref: source.candidate.packageSourceSha,
    release_package_spec: source.validationInputs.releasePackageSpec,
    release_profile: source.releaseProfile,
    rerun_group: "all",
    reuse_evidence: "false",
    run_release_soak: source.runReleaseSoak,
    skip_package_telegram_e2e: source.validationInputs.skipPackageTelegramE2e,
    target_context_ref: source.validationInputs.targetContextRef,
  })
    .filter(([key, value]) => key !== "npm_telegram_scenario" || value !== "")
    .map(([key, value]) => `2026-08-22T00:00:00Z   ${key}: ${value}`);
  return [
    "2026-08-22T00:00:00Z ##[group] Inputs",
    ...entries,
    "2026-08-22T00:00:00Z ##[endgroup]",
  ].join("\n");
}

function historicalWorkflowSource() {
  const defaults: Record<string, string> = {
    allow_unreleased_changelog: "false",
    codex_plugin_spec: '""',
    cross_os_suite_filter: '""',
    live_suite_filter: '""',
    mode: "both",
    npm_telegram_package_spec: '""',
    npm_telegram_provider_mode: "mock-openai",
    npm_telegram_scenario: '""',
    package_acceptance_package_spec: '""',
    plugin_prerelease_node_exclude_patterns_json: '"[]"',
    provider: "openai",
    release_package_spec: '""',
    skip_package_telegram_e2e: "false",
    target_context_ref: '""',
  };
  return [
    "name: Full Release Validation",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    ...Object.entries(defaults).flatMap(([key, value]) => {
      const lines = [`      ${key}:`, `        default: ${value}`, "        type: string"];
      if (key === "provider") {
        lines.push("        options:", "          - openai", "          - anthropic");
      }
      return lines;
    }),
    "permissions:",
    "  contents: read",
  ].join("\n");
}

function historicalCandidateArtifacts(source = continuation()) {
  const value = source.candidate;
  const common = (id: string, name: string, digest: string) => ({
    archiveSha256: digest,
    digest: `sha256:${digest}`,
    expired: false,
    id,
    name,
    runAttempt: source.sourceRunAttempt,
    runId: source.sourceRunId,
    workflowRef: source.sourceWorkflowRef,
    workflowSha: source.sourceWorkflowSha,
  });
  return {
    image: {
      ...common(value.imageArtifactId, value.imageArtifactName, value.imageArtifactDigest),
      imageArchiveSha256: value.imageArchiveSha256,
      imageArchiveFileName: "shared-images.tar.zst",
      imageArchiveFormat: "docker-tar+zstd",
      imageArchiveManifestSha256: value.imageArchiveSha256,
      imageConclusion: "success",
      imageKind: "docker-e2e",
      imageSchema: "openclaw.shared-docker-image-artifact/v1",
      imageSchemaVersion: 1,
      imageWorkflowSha: source.sourceWorkflowSha,
      manifestRunAttempt: source.sourceRunAttempt,
      manifestRunId: source.sourceRunId,
      packageSha256: value.packageSha256,
      packageSourceSha: value.packageSourceSha,
      targetSha: value.packageSourceSha,
    },
    package: {
      ...common(value.packageArtifactId, value.packageArtifactName, value.packageArtifactDigest),
      fileName: value.packageFileName,
      fileSha256: value.packageSha256,
      packageName: "openclaw",
      packageSourceSha: value.packageSourceSha,
      packageVersion: value.packageVersion,
    },
    pluginRegistry: {
      ...common(
        value.prepublishPluginRegistryArtifactId,
        value.prepublishPluginRegistryArtifactName,
        value.prepublishPluginRegistryArtifactDigest,
      ),
      candidateVersion: value.packageVersion,
      manifestSha256: value.prepublishPluginRegistryManifestSha256,
      schema: "openclaw.prepublish-plugin-registry/v1",
      schemaVersion: 1,
      sourceSha: value.packageSourceSha,
    },
  };
}

function preflightMethods(
  children: ReturnType<typeof child>[],
  childRun: (entry: ReturnType<typeof child>) => Record<string, unknown>,
  candidateIdentity?: ReturnType<typeof candidate>,
  historicalOverrides: Partial<{
    candidateArtifacts: ReturnType<typeof historicalCandidateArtifacts>;
    releaseChecksResolveLog: string;
    reusableInputsLog: string;
    rootResolveLog: string;
    source: ReturnType<typeof continuation>;
    sourceWorkflow: string;
  }> = {},
) {
  const source = historicalOverrides.source ?? continuation();
  const byRunId = new Map(children.map((entry) => [entry.runId, entry]));
  const releaseChecks = children.find((entry) => entry.key === "releaseChecks");
  const jobs = [
    {
      conclusion: "success",
      id: 1,
      name: "Resolve target ref",
      run_attempt: 1,
      status: "completed",
    },
    {
      conclusion: "skipped",
      id: 2,
      name: "Check for reusable validation evidence",
      run_attempt: 1,
      status: "completed",
    },
    {
      conclusion: "success",
      id: 3,
      name: "Prepare shared release candidate / validate_selected_ref",
      run_attempt: 1,
      status: "completed",
    },
    ...children.map((entry, index) => ({
      conclusion: "failure",
      id: index + 4,
      name: releaseChildSpec(entry.key).parentJobName,
      run_attempt: entry.sourceParentAttempt,
      status: "completed",
    })),
  ];
  return {
    getJobLog: async (jobId: number) => {
      if (jobId === 1) {
        return [
          `RERUN_GROUP: all`,
          `TARGET_SHA: ${TARGET_SHA}`,
          historicalOverrides.rootResolveLog ?? historicalRootResolveLog(source),
        ].join("\n");
      }
      if (jobId === 3) {
        return historicalOverrides.reusableInputsLog ?? historicalReusableInputsLog(source);
      }
      if (jobId === 99) {
        return (
          historicalOverrides.releaseChecksResolveLog ??
          historicalReleaseChecksResolveLog({
            ...source,
            candidate: candidateIdentity ?? source.candidate,
          })
        );
      }
      const entry = children[jobId - 4]!;
      return [
        `TARGET_SHA: ${TARGET_SHA}`,
        ...(entry.key === "productPerformance" ? ["-f publish_reports=false"] : []),
        ...(candidateIdentity && ["pluginPrerelease", "releaseChecks"].includes(entry.key)
          ? [`CANDIDATE_ARTIFACT_JSON: ${JSON.stringify(candidateIdentity)}`]
          : []),
        `Dispatched ${entry.workflow}: https://github.com/openclaw/openclaw/actions/runs/${entry.runId} (attempt ${entry.runAttempt})`,
      ].join("\n");
    },
    getParentJobs: async (runId: string) =>
      runId === releaseChecks?.runId
        ? [
            {
              conclusion: "success",
              id: 99,
              name: "resolve_target",
              run_attempt: releaseChecks.runAttempt,
              status: "completed",
            },
          ]
        : jobs,
    getWorkflowSource: async () => historicalOverrides.sourceWorkflow ?? historicalWorkflowSource(),
    loadHistoricalCandidateArtifacts: async () =>
      historicalOverrides.candidateArtifacts ?? historicalCandidateArtifacts(source),
    loadSourceManifest: async () => sourceManifest(children),
    verifyTrustedSourceSha: async () => {},
    getRunAttempt: async (runId: string) => {
      if (runId === "77") {
        return {
          display_title: "Full Release Validation",
          event: "workflow_dispatch",
          head_branch: SOURCE_REF,
          head_sha: SHA,
          id: 77,
          path: ".github/workflows/full-release-validation.yml",
          repository: { full_name: "openclaw/openclaw" },
          run_attempt: 1,
          status: "completed",
          conclusion: "failure",
        };
      }
      return childRun(byRunId.get(runId)!);
    },
  };
}

describe("frv continuation controller", () => {
  it("uses the canonical release-ci identity accepted by tooling and evidence validators", () => {
    const branch = continuationBranchName("77", SHA);
    const requestedIdentityJson = JSON.stringify({
      fullRef: "refs/heads/main",
      ref: "main",
      sha: SHA,
    });
    expect(branch).toBe(`release-ci/${SHA.slice(0, 12)}-77`);
    expect(
      resolveReleaseToolingIdentity({
        requestedIdentityJson,
        workflowContract: "2",
        workflowFullRef: `refs/heads/${branch}`,
        workflowRef: branch,
        workflowSha: SHA,
      }),
    ).toEqual(JSON.parse(requestedIdentityJson));
    expect(
      validateFullReleaseValidationEvidence({
        run: {
          conclusion: "success",
          event: "workflow_dispatch",
          head_branch: branch,
          head_sha: SHA,
          id: 88,
          name: "Full Release Validation",
          path: ".github/workflows/full-release-validation.yml",
          repository: { full_name: "openclaw/openclaw" },
          run_attempt: 1,
          status: "completed",
        },
        manifest: {
          runAttempt: "1",
          runId: "88",
          targetRef: TARGET_SHA,
          targetSha: TARGET_SHA,
          version: 3,
          workflowFullRef: `refs/heads/${branch}`,
          workflowName: "Full Release Validation",
          workflowRef: branch,
          workflowRefType: "branch",
          workflowSha: SHA,
        },
        expectedRepository: "openclaw/openclaw",
        expectedRunId: "88",
        expectedTargetSha: TARGET_SHA,
        expectedWorkflowBranch: "main",
        isTrustedMainAncestor: () => true,
      }),
    ).toMatchObject({ source: "sha-pinned-main" });
  });

  it("adopts an active newer attempt without rerunning it", async () => {
    const selected = child("normalCi", "101");
    let reads = 0;
    let reruns = 0;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async (_runId: string, attempt: number) =>
        attempt === 1 ? [job("test", "failure")] : reads < 2 ? [] : [job("test")],
      getRun: async (runId: string) => {
        if (runId === "77") {
          return { conclusion: "success", id: 77, run_attempt: 1, status: "completed" };
        }
        reads += 1;
        return reads < 2 ? runFor(selected, 2, null) : runFor(selected, 2, "success");
      },
      rerunFailed: async () => {
        reruns += 1;
      },
      rerunParent: async () => {},
      verify: async () => "{}",
      repository: "openclaw/openclaw",
    };
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_TIMEOUT_MS = "100";
    const result = await continueFailed(plan([selected]), "77", client);
    expect(result.action).toBe("verified-parent");
    expect(reruns).toBe(0);
  });

  it("reruns failed children concurrently, leaves green children untouched, then reruns parent", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const green = child("releaseChecks", "303");
    const attempts = new Map([
      ["101", 1],
      ["202", 1],
      ["303", 1],
      ["77", 1],
    ]);
    const conclusions = new Map([
      ["101", "failure"],
      ["202", "failure"],
      ["303", "success"],
      ["77", "failure"],
    ]);
    const events: string[] = [];
    const byId = new Map([
      ["101", first],
      ["202", second],
      ["303", green],
    ]);
    const client = {
      ...preflightMethods([first, second, green], (entry) =>
        runFor(entry, 1, conclusions.get(entry.runId)!),
      ),
      getAttemptJobs: async (runId: string, attempt: number) => [
        job("test", attempt === 1 ? conclusions.get(runId) : "success"),
      ],
      getRun: async (runId: string) => {
        if (runId === "77") {
          return {
            conclusion: conclusions.get(runId),
            id: 77,
            run_attempt: attempts.get(runId),
            status: "completed",
          };
        }
        const entry = byId.get(runId)!;
        return runFor(entry, attempts.get(runId)!, conclusions.get(runId)!);
      },
      rerunFailed: async (runId: string) => {
        events.push(`child:${runId}`);
        attempts.set(runId, 2);
        conclusions.set(runId, "success");
        await Promise.resolve();
      },
      rerunParent: async () => {
        events.push("parent");
        attempts.set("77", 2);
        conclusions.set("77", "success");
      },
      verify: async () => {
        events.push("verify");
        return "{}";
      },
      repository: "openclaw/openclaw",
    };
    const result = await continueFailed(plan([first, second, green]), "77", client);
    expect(result.finalRunId).toBe("77");
    expect(events.slice(0, 2).toSorted()).toEqual(["child:101", "child:202"]);
    expect(events).not.toContain("child:303");
    expect(events.indexOf("parent")).toBeGreaterThan(events.indexOf("child:202"));
    expect(events.at(-1)).toBe("verify");
  });

  it("dispatches a zero-child legacy parent and requires its final immutable plan", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const byRunId = new Map(children.map((entry) => [entry.runId, entry]));
    const legacyContinuation = {
      candidate: candidate(),
      publicationEnabled: false,
      releaseProfile: "beta",
      rerunGroup: "all",
      runReleaseSoak: "false",
      sourceDisplayTitle: "Full Release Validation",
      sourceEvent: "workflow_dispatch",
      sourceRepository: "openclaw/openclaw",
      sourceRunAttempt: 1,
      sourceRunId: "77",
      sourceWorkflowPath: ".github/workflows/full-release-validation.yml",
      sourceWorkflowRef: SOURCE_REF,
      sourceWorkflowSha: SHA,
      toolingSha: SHA,
      validationInputs: VALIDATION_INPUTS,
    };
    const finalPlan = buildReleaseExecutionPlanArtifact({
      attemptEvidenceVersion: 1,
      children: children.map((entry) => ({
        ...entry,
        dispatchName: releaseChildSpec(entry.key).dispatchName,
        result: "success",
        source: "continuation",
      })),
      continuation: legacyContinuation,
      evidenceReuse: { requested: false },
      expected: {
        parentRunAttempt: 1,
        parentRunId: "88",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/current",
        workflowSha: SHA,
      },
      gates: [{ name: "Resolve target ref", required: true, result: "success" }],
      releaseProfile: "beta",
      rerunGroup: "all",
      trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
    });
    let dispatched = 0;
    let deletedBranch = "";
    let parentReruns = 0;
    let finalPlanPayload: Record<string, unknown> | undefined = finalPlan;
    const client = {
      ...preflightMethods(children, (entry) => runFor(entry, 1, "success"), candidate()),
      deleteWorkflowRef: async (branch: string) => {
        deletedBranch = branch;
      },
      dispatchContinuation: async () => {
        dispatched += 1;
        return { branch: "release-ci/current", runId: "88", workflowSha: SHA };
      },
      getAttemptJobs: async () => [job("test")],
      getRun: async (runId: string) =>
        runId === "88"
          ? { conclusion: "success", id: 88, run_attempt: 1, status: "completed" }
          : runFor(byRunId.get(runId)!, 1, "success"),
      rerunFailed: async () => {},
      rerunParent: async () => {
        parentReruns += 1;
      },
      verifyTrustedSourceSha: async () => {},
      verifyTrustedToolingSha: async () => {},
      verify: async () => "{}",
      repository: "openclaw/openclaw",
    };
    await continueFailed(continuationPlan(children, legacyContinuation), "77", client, {
      loadExecutionPlan: async () => finalPlanPayload,
    });
    expect(dispatched).toBe(1);
    expect(deletedBranch).toBe("release-ci/current");
    expect(parentReruns).toBe(0);
    finalPlanPayload = undefined;
    await expect(
      continueFailed(continuationPlan(children, legacyContinuation), "77", client, {
        loadExecutionPlan: async () => finalPlanPayload,
      }),
    ).rejects.toThrow(
      "exact continuation parent 88 terminated with conclusion success without a valid immutable execution plan",
    );
    expect(dispatched).toBe(2);
  });

  it("rejects incomplete or drifted legacy child inventories", () => {
    const legacyChild = (key: string, runId: string) => {
      const spec = releaseChildSpec(key);
      return {
        ...child(key, runId),
        displayTitle: `${spec.displayName} full-release-validation-77-1${spec.suffix}`,
        url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
        workflow: spec.workflow,
        workflowRef: SOURCE_REF,
      };
    };
    const normalCi = legacyChild("normalCi", "101");
    const legacy = {
      candidate: candidate(),
      children: {
        normalCi,
        pluginPrerelease: {
          ...legacyChild("pluginPrerelease", "202"),
        },
        productPerformance: {
          ...legacyChild("productPerformance", "303"),
        },
        releaseChecks: {
          ...legacyChild("releaseChecks", "404"),
        },
      },
      releaseProfile: "beta",
      runReleaseSoak: "false",
      source: {
        displayTitle: "Full Release Validation",
        event: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runId: "77",
        workflowPath: ".github/workflows/full-release-validation.yml",
        workflowRef: SOURCE_REF,
        workflowSha: SHA,
      },
      targetSha: TARGET_SHA,
      toolingSha: SHA,
      validationInputs: VALIDATION_INPUTS,
    };
    expect(validateLegacySource(legacy, "77")).toMatchObject({
      children: {
        normalCi: {
          runAttempt: normalCi.runAttempt,
          runId: normalCi.runId,
          workflow: normalCi.workflow,
          workflowRef: normalCi.workflowRef,
          workflowSha: normalCi.workflowSha,
        },
      },
      continuation: {
        sourceEvidenceMode: HISTORICAL_CONTINUATION_SOURCE_MODE,
      },
      targetSha: TARGET_SHA,
    });
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          children: {
            ...legacy.children,
            unknown: { ...normalCi, workflow: "ci.yml" },
          },
        },
        "77",
      ),
    ).toThrow("legacy continuation child key is invalid: unknown");
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          children: {
            ...legacy.children,
            normalCi: { ...normalCi, workflow: "openclaw-release-checks.yml" },
          },
        },
        "77",
      ),
    ).toThrow("legacy continuation child identity is invalid: normalCi");
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          children: {
            normalCi,
          },
        },
        "77",
      ),
    ).toThrow("legacy continuation child inventory is invalid");
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          validationInputs: { mode: "both", provider: "openai" },
        },
        "77",
      ),
    ).toThrow("legacy continuation validation inputs are incomplete");
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          source: {
            ...legacy.source,
            workflowRef: "release-ci/legacy",
          },
        },
        "77",
      ),
    ).toThrow(
      "legacy continuation source workflow ref is not a canonical trusted main or release-ci/<sha12>-<digits> route; run a new all-group FRV before continuing",
    );
  });

  it("reports the effective attempt and composite digest", async () => {
    const selected = child("normalCi", "101");
    const result = await inspectContinuation(plan([selected]), {
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === 1 ? "failure" : "success"),
      ],
      getRun: async () => runFor(selected, 2, "success"),
    });
    const expectedJobs = [
      {
        acceptedRunAttempt: 2,
        completedAt: "2026-08-22T00:01:00Z",
        conclusion: "success",
        name: "test",
        startedAt: "2026-08-22T00:00:00Z",
        status: "completed",
        url: "https://example.invalid/jobs/test",
      },
    ];
    expect(result.children[0]).toMatchObject({
      compositeJobsSha256: releaseCompositeJobsSha256({
        effectiveRunAttempt: 2,
        jobs: expectedJobs,
        plannedRunAttempt: 1,
      }),
      effectiveRunAttempt: 2,
      status: "passed",
    });
  });

  it("rejects legacy mode when the root already has a canonical plan", async () => {
    const root = tempDirs.make("frv-legacy-bypass-");
    const legacyPlanPath = join(root, "legacy.json");
    writeFileSync(legacyPlanPath, "{}");
    await expect(
      loadPlan(
        {
          legacyPlanPath,
          repository: "openclaw/openclaw",
          runId: "88",
        },
        async () => sealedContinuationPlan(child("normalCi", "101"), "88"),
      ),
    ).rejects.toThrow("run has a canonical execution plan; reject --legacy-plan");
  });

  it("rejects focused and non-FRV roots before any mutation", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const baseClient = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async () => [job("test", "failure")],
      getRun: async () => runFor(selected, 1, "failure"),
      repository: "openclaw/openclaw",
      rerunFailed: async () => {
        mutations += 1;
      },
      rerunParent: async () => {
        mutations += 1;
      },
      verify: async () => "{}",
    };
    await expect(
      continueFailed({ ...plan([selected]), rerunGroup: "ci" }, "77", baseClient),
    ).rejects.toThrow("requires an all-group root");
    const wrongWorkflow = {
      ...baseClient,
      getRunAttempt: async (runId: string) =>
        runId === "77"
          ? {
              display_title: "Full Release Validation",
              event: "workflow_dispatch",
              head_branch: SOURCE_REF,
              head_sha: SHA,
              id: 77,
              path: ".github/workflows/ci.yml",
              repository: { full_name: "openclaw/openclaw" },
              run_attempt: 1,
            }
          : runFor(selected, 1, "failure"),
    };
    await expect(continueFailed(plan([selected]), "77", wrongWorkflow)).rejects.toThrow(
      "source full release parent identity changed",
    );
    expect(mutations).toBe(0);
  });

  it("rejects a source from the wrong repository before mutation", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const methods = preflightMethods([selected], (entry) => runFor(entry, 1, "failure"));
    await expect(
      continueFailed(plan([selected]), "77", {
        ...methods,
        getAttemptJobs: async () => [job("test", "failure")],
        getRun: async () => runFor(selected, 1, "failure"),
        getRunAttempt: async (runId: string) => {
          const run = await methods.getRunAttempt(runId);
          return {
            ...run,
            repository: { full_name: "someone/else" },
          };
        },
        repository: "openclaw/openclaw",
        rerunFailed: async () => {
          mutations += 1;
        },
      }),
    ).rejects.toThrow("source full release parent identity changed");
    expect(mutations).toBe(0);
  });

  it("reconciles a partial transient rerun failure without duplicating work", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const attempts = new Map([
      ["101", 1],
      ["202", 1],
      ["77", 1],
    ]);
    const conclusions = new Map([
      ["101", "failure"],
      ["202", "failure"],
      ["77", "success"],
    ]);
    const calls: string[] = [];
    const byId = new Map([
      ["101", first],
      ["202", second],
    ]);
    const client = {
      ...preflightMethods([first, second], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === 1 ? "failure" : "success"),
      ],
      getRun: async (runId: string) =>
        runId === "77"
          ? {
              conclusion: conclusions.get(runId),
              id: 77,
              run_attempt: attempts.get(runId),
              status: "completed",
            }
          : runFor(byId.get(runId)!, attempts.get(runId)!, conclusions.get(runId)!),
      repository: "openclaw/openclaw",
      rerunFailed: async (runId: string) => {
        calls.push(runId);
        attempts.set(runId, 2);
        conclusions.set(runId, "success");
        if (runId === "101") {
          throw new Error("HTTP 502 after dispatch");
        }
      },
      rerunParent: async () => {},
      verify: async () => "{}",
    };
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS = "100";
    const result = await continueFailed(plan([first, second]), "77", client);
    expect(result.action).toBe("verified-parent");
    expect(calls.toSorted()).toEqual(["101", "202"]);
  });

  it("retries a transient rejected rerun only while the prior terminal attempt is unchanged", async () => {
    const selected = child("normalCi", "101");
    let attempt = 1;
    let conclusion = "failure";
    let reruns = 0;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async (_runId: string, runAttempt: number) => [
        job("test", runAttempt === 1 ? "failure" : "success"),
      ],
      getRun: async (runId: string) =>
        runId === "77"
          ? { conclusion: "success", id: 77, run_attempt: 1, status: "completed" }
          : runFor(selected, attempt, conclusion),
      repository: "openclaw/openclaw",
      rerunFailed: async () => {
        reruns += 1;
        if (reruns === 1) {
          throw new Error("HTTP 502 before dispatch");
        }
        attempt = 2;
        conclusion = "success";
      },
      rerunParent: async () => {},
      verify: async () => "{}",
    };
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS = "100";
    await expect(continueFailed(plan([selected]), "77", client)).resolves.toMatchObject({
      action: "verified-parent",
    });
    expect(reruns).toBe(2);
  });

  it.each([
    ["release profile", (manifest: Record<string, any>) => (manifest.releaseProfile = "stable")],
    ["release soak", (manifest: Record<string, any>) => (manifest.runReleaseSoak = "true")],
    [
      "validation input",
      (manifest: Record<string, any>) => (manifest.validationInputs.provider = "anthropic"),
    ],
  ])("rejects source manifest tampering before mutation: %s", async (_label, tamper) => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const methods = preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate());
    const manifest = structuredClone(sourceManifest(children));
    tamper(manifest);
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...methods,
        loadSourceManifest: async () => manifest,
      }),
    ).rejects.toThrow("continuation source identity differs from the immutable plan");
  });

  it("accepts an exact historical failed root when no source manifest exists", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const methods = preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate());
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...methods,
        loadSourceManifest: async () => undefined,
      }),
    ).resolves.toMatchObject({ conclusion: "failure", id: 77 });
  });

  it("rejects source identity before reading historical logs or artifacts", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    let evidenceReads = 0;
    const methods = preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate());
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...methods,
        getParentJobs: async () => {
          evidenceReads += 1;
          return [];
        },
        getRunAttempt: async () => ({
          ...(await methods.getRunAttempt("77")),
          head_sha: "f".repeat(40),
        }),
        loadHistoricalCandidateArtifacts: async () => {
          evidenceReads += 1;
          return {};
        },
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow("source full release parent identity changed");
    expect(evidenceReads).toBe(0);
  });

  it("rejects untrusted source lineage before reading historical logs or artifacts", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    let evidenceReads = 0;
    const methods = preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate());
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...methods,
        getParentJobs: async () => {
          evidenceReads += 1;
          return [];
        },
        loadHistoricalCandidateArtifacts: async () => {
          evidenceReads += 1;
          return {};
        },
        loadSourceManifest: async () => {
          evidenceReads += 1;
          return undefined;
        },
        verifyTrustedSourceSha: async () => {
          throw new Error("source is not on protected main");
        },
      }),
    ).rejects.toThrow("source is not on protected main");
    expect(evidenceReads).toBe(0);
  });

  it.each([
    ["releaseProfile", "root", "RELEASE_PROFILE"],
    ["runReleaseSoak", "root", "RUN_RELEASE_SOAK"],
    ["allowUnreleasedChangelog", "root", "ALLOW_UNRELEASED_CHANGELOG"],
    ["codexPluginSpec", "root", "CODEX_PLUGIN_SPEC"],
    ["crossOsSuiteFilter", "root", "CROSS_OS_SUITE_FILTER"],
    ["liveSuiteFilter", "root", "LIVE_SUITE_FILTER"],
    ["mode", "child", "RELEASE_MODE_INPUT"],
    ["npmTelegramPackageSpec", "root", "NPM_TELEGRAM_PACKAGE_SPEC"],
    ["npmTelegramProviderMode", "inputs", "npm_telegram_provider_mode"],
    ["npmTelegramScenario", "inputs", "npm_telegram_scenario"],
    ["packageAcceptancePackageSpec", "root", "PACKAGE_ACCEPTANCE_PACKAGE_SPEC"],
    [
      "pluginPrereleaseNodeExcludePatternsJson",
      "root",
      "PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON",
    ],
    ["provider", "child", "RELEASE_PROVIDER_INPUT"],
    ["releasePackageSpec", "root", "RELEASE_PACKAGE_SPEC"],
    ["skipPackageTelegramE2e", "root", "SKIP_PACKAGE_TELEGRAM_E2E"],
    ["targetContextRef", "inputs", "target_context_ref"],
  ])("rejects manifestless historical source log drift: %s", async (_field, surface, key) => {
    const source = continuation();
    source.validationInputs = {
      allowUnreleasedChangelog: "true",
      codexPluginSpec: "@openclaw/codex@beta",
      crossOsSuiteFilter: "windows/packaged-upgrade",
      liveSuiteFilter: "qa-live-telegram",
      mode: "fresh",
      npmTelegramPackageSpec: "openclaw@beta",
      npmTelegramProviderMode: "live-frontier",
      npmTelegramScenario: "send-text",
      packageAcceptancePackageSpec: "openclaw@beta",
      pluginPrereleaseNodeExcludePatternsJson: '["extensions/example"]',
      provider: "anthropic",
      releasePackageSpec: "openclaw@beta",
      skipPackageTelegramE2e: "true",
      targetContextRef: "release/2026.8.1",
    };
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
      child("npmTelegram", "505"),
    ];
    const rootResolveLog = historicalRootResolveLog(source).replace(
      new RegExp(` ${key}:.*`, "u"),
      ` ${key}: tampered`,
    );
    const releaseChecksResolveLog = historicalReleaseChecksResolveLog(source).replace(
      new RegExp(` ${key}:.*`, "u"),
      ` ${key}: tampered`,
    );
    const reusableInputsLog = historicalReusableInputsLog(source).replace(
      new RegExp(` ${key}:.*`, "u"),
      ` ${key}: tampered`,
    );
    await expect(
      preflightContinuation(continuationPlan(children, source), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate(), {
          releaseChecksResolveLog:
            surface === "child"
              ? releaseChecksResolveLog
              : historicalReleaseChecksResolveLog(source),
          reusableInputsLog:
            surface === "inputs" ? reusableInputsLog : historicalReusableInputsLog(source),
          rootResolveLog: surface === "root" ? rootResolveLog : historicalRootResolveLog(source),
          source,
        }),
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow("historical continuation");
  });

  it("accepts an omitted blank npm Telegram scenario only from the exact source schema", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate()),
        loadSourceManifest: async () => undefined,
      }),
    ).resolves.toMatchObject({ id: 77 });
  });

  it("ignores reusable defaults shadowed by authoritative root inputs", async () => {
    const source = continuation();
    source.validationInputs = {
      ...source.validationInputs,
      codexPluginSpec: "@openclaw/codex@beta",
      liveSuiteFilter: "qa-live-telegram",
    };
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const reusableInputsLog = historicalReusableInputsLog(source)
      .replace(" codex_plugin_spec: @openclaw/codex@beta", " codex_plugin_spec: ")
      .replace(" live_suite_filter: qa-live-telegram", " live_suite_filter: ");
    await expect(
      preflightContinuation(continuationPlan(children, source), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate(), {
          reusableInputsLog,
          source,
        }),
        loadSourceManifest: async () => undefined,
      }),
    ).resolves.toMatchObject({ id: 77 });
  });

  it("rejects an omitted input whose exact source schema default is nonblank", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const reusableInputsLog = historicalReusableInputsLog()
      .split("\n")
      .filter((line) => !line.includes(" npm_telegram_provider_mode:"))
      .join("\n");
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate(), {
          reusableInputsLog,
        }),
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow("historical continuation reusable input is missing: npmTelegramProviderMode");
  });

  it("rejects duplicate root resolver env blocks", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const log = historicalRootResolveLog();
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate(), {
          rootResolveLog: `${log}\n${log}`,
        }),
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow("historical continuation root resolver input block is missing or ambiguous");
  });

  it("rejects an incomplete reusable Inputs group", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate(), {
          reusableInputsLog: historicalReusableInputsLog().replace("##[endgroup]", ""),
        }),
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow("historical continuation reusable Inputs group is missing or ambiguous");
  });

  it("rejects a source workflow schema missing an input default", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const sourceWorkflow = historicalWorkflowSource().replace(
      / {6}npm_telegram_scenario:\n {8}default: ""\n {8}type: string\n/u,
      "",
    );
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate(), {
          sourceWorkflow,
        }),
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow(
      "historical continuation workflow input default is missing: npm_telegram_scenario",
    );
  });

  it.each([
    ["service digest", "package", "archiveSha256"],
    ["package hash", "package", "fileSha256"],
    ["plugin manifest hash", "pluginRegistry", "manifestSha256"],
    ["Docker archive hash", "image", "imageArchiveSha256"],
    ["producer attempt", "image", "runAttempt"],
  ])("rejects historical candidate artifact drift: %s", async (_label, kind, field) => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const candidateArtifacts = historicalCandidateArtifacts();
    const artifact = candidateArtifacts[kind as keyof typeof candidateArtifacts] as Record<
      string,
      unknown
    >;
    artifact[field] = field === "runAttempt" ? 2 : "f".repeat(64);
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate(), {
          candidateArtifacts,
        }),
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow("historical continuation");
  });

  it("rejects a release-checks resolver from the wrong child attempt", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const methods = preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate());
    const getParentJobs = methods.getParentJobs;
    await expect(
      preflightContinuation(continuationPlan(children), "77", {
        ...methods,
        getParentJobs: async (runId: string) => {
          const jobs = await getParentJobs(runId);
          return runId === "303" ? jobs.map((childJob) => ({ ...childJob, run_attempt: 2 })) : jobs;
        },
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow(
      "historical continuation release-checks resolver job is missing or ambiguous",
    );
  });

  it("keeps a canonical continuation source manifest mandatory", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const source = continuation();
    delete (source as { sourceEvidenceMode?: string }).sourceEvidenceMode;
    const methods = preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate());
    await expect(
      preflightContinuation(continuationPlan(children, source), "77", {
        ...methods,
        loadSourceManifest: async () => undefined,
      }),
    ).rejects.toThrow("continuation source manifest is missing");
  });

  it("rejects a source candidate artifact tamper before mutation", async () => {
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const tamperedCandidate = { ...candidate(), packageSha256: "f".repeat(64) };
    await expect(
      preflightContinuation(
        continuationPlan(children),
        "77",
        preflightMethods(children, (entry) => runFor(entry, 1, "failure"), tamperedCandidate),
      ),
    ).rejects.toThrow("release child candidate identity changed");
  });

  it("rejects dropped npm Telegram inventory required by package inputs", async () => {
    const source = continuation();
    source.validationInputs = {
      ...source.validationInputs,
      releasePackageSpec: "openclaw@beta",
    };
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
      child("npmTelegram", "505"),
    ];
    const manifest = sourceManifest(children, source);
    manifest.childRuns.npmTelegram = "";
    await expect(
      preflightContinuation(continuationPlan(children, source), "77", {
        ...preflightMethods(children, (entry) => runFor(entry, 1, "failure"), candidate()),
        loadSourceManifest: async () => manifest,
      }),
    ).rejects.toThrow("continuation source child inventory differs from the immutable plan");
  });

  it("rejects a strict manifest continuation record that differs from the immutable plan", () => {
    const source = continuation();
    const children = [
      child("normalCi", "101"),
      child("pluginPrerelease", "202"),
      child("releaseChecks", "303"),
      child("productPerformance", "404"),
    ];
    const sourceChildLogs = Object.fromEntries(
      children.map((entry) => [
        entry.key,
        [
          `TARGET_SHA: ${TARGET_SHA}`,
          ...(entry.key === "productPerformance" ? ["-f publish_reports=false"] : []),
          ...(["pluginPrerelease", "releaseChecks"].includes(entry.key)
            ? [`CANDIDATE_ARTIFACT_JSON: ${JSON.stringify(candidate())}`]
            : []),
          `Dispatched ${entry.workflow}: https://github.com/openclaw/openclaw/actions/runs/${entry.runId} (attempt 1)`,
        ].join("\n"),
      ]),
    );
    expect(() =>
      verifyReleaseContinuationSource({
        children,
        continuation: source,
        recordedContinuation: { ...source, runReleaseSoak: "true" },
        repository: "openclaw/openclaw",
        sourceChildLogs,
        sourceManifest: sourceManifest(children, source),
        sourceRun: {
          conclusion: "failure",
          display_title: source.sourceDisplayTitle,
          event: source.sourceEvent,
          head_branch: source.sourceWorkflowRef,
          head_sha: source.sourceWorkflowSha,
          id: Number(source.sourceRunId),
          path: source.sourceWorkflowPath,
          repository: { full_name: source.sourceRepository },
          run_attempt: source.sourceRunAttempt,
          status: "completed",
        },
        targetSha: TARGET_SHA,
      }),
    ).toThrow("recorded continuation source differs from the immutable plan");
  });

  it("does not retry when a rejected rerun reread changes the prior run provenance", async () => {
    const selected = child("normalCi", "101");
    let drifted = false;
    let reruns = 0;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async () => [job("test", "failure")],
      getRun: async (runId: string) => {
        if (runId === "77") {
          return { conclusion: "success", id: 77, run_attempt: 1, status: "completed" };
        }
        return {
          ...runFor(selected, 1, "failure"),
          head_sha: drifted ? "f".repeat(40) : SHA,
        };
      },
      repository: "openclaw/openclaw",
      rerunFailed: async () => {
        reruns += 1;
        drifted = true;
        throw new Error("HTTP 502 before dispatch");
      },
      rerunParent: async () => {},
      verify: async () => "{}",
    };
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS = "5";
    await expect(continueFailed(plan([selected]), "77", client)).rejects.toThrow(
      "rerun source 101 changed after a rejected mutation",
    );
    expect(reruns).toBe(1);
  });

  it("uses frozen tooling, adopts the same parent on restart, and never reselects main", async () => {
    const reviewed = {
      children: { normalCi: child("normalCi", "101") },
      continuation: continuation(),
      legacy: true,
      releaseProfile: "beta",
      rerunGroup: "all",
      targetSha: TARGET_SHA,
    };
    const branch = continuationBranchName("77", SHA);
    const sealed = sealedContinuationPlan(child("normalCi", "101"));
    const reads: string[] = [];
    const mutations: string[][] = [];
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        reads.push(path);
        if (path === `compare/${SHA}...main`) {
          return { status: "ahead" };
        }
        if (path.startsWith("contents/")) {
          return { content: Buffer.from("continuation_plan_json:").toString("base64") };
        }
        if (path.startsWith("git/ref/")) {
          return { object: { sha: SHA } };
        }
        if (path.startsWith("actions/workflows/")) {
          return {
            workflow_runs: [
              {
                event: "workflow_dispatch",
                head_branch: branch,
                head_sha: SHA,
                id: 88,
                path: ".github/workflows/full-release-validation.yml",
              },
            ],
          };
        }
        if (path === "actions/runs/88") {
          return {
            event: "workflow_dispatch",
            head_branch: branch,
            head_sha: SHA,
            id: 88,
            path: ".github/workflows/full-release-validation.yml",
            repository: { full_name: "openclaw/openclaw" },
          };
        }
        throw new Error(`unexpected read: ${path}`);
      },
      loadExecutionPlan: async () => sealed,
      mutate: async (args: string[]) => {
        mutations.push(args);
        return "";
      },
    });
    expect(await client.dispatchContinuation(reviewed)).toMatchObject({ branch, runId: "88" });
    expect(await client.dispatchContinuation(reviewed)).toMatchObject({ branch, runId: "88" });
    expect(mutations).toEqual([]);
    expect(reads.some((path) => path.includes(`?ref=${SHA}`))).toBe(true);
    expect(
      reads.every((path) => !path.includes("origin/main") && !path.endsWith("?ref=main")),
    ).toBe(true);
  });

  it("adopts an exact active continuation parent before its plan artifact exists", async () => {
    const reviewed = {
      children: { normalCi: child("normalCi", "101") },
      continuation: continuation(),
      legacy: true,
      releaseProfile: "beta",
      rerunGroup: "all",
      targetSha: TARGET_SHA,
    };
    const branch = continuationBranchName("77", SHA);
    const mutations: string[][] = [];
    const reports: string[] = [];
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        if (path === `compare/${SHA}...main`) {
          return { status: "ahead" };
        }
        if (path.startsWith("contents/")) {
          return { content: Buffer.from("continuation_plan_json:").toString("base64") };
        }
        if (path.startsWith("git/ref/")) {
          return { object: { sha: SHA } };
        }
        if (path.startsWith("actions/workflows/")) {
          return {
            workflow_runs: [
              {
                event: "workflow_dispatch",
                head_branch: branch,
                head_sha: SHA,
                id: 88,
              },
            ],
          };
        }
        if (path === "actions/runs/88") {
          return {
            conclusion: null,
            event: "workflow_dispatch",
            head_branch: branch,
            head_sha: SHA,
            id: 88,
            path: ".github/workflows/full-release-validation.yml",
            repository: { full_name: "openclaw/openclaw" },
            status: "in_progress",
          };
        }
        throw new Error(`unexpected read: ${path}`);
      },
      loadExecutionPlan: async () => undefined,
      mutate: async (args: string[]) => {
        mutations.push(args);
        return "";
      },
      report: (message: string) => reports.push(message),
    });
    await expect(client.dispatchContinuation(reviewed)).resolves.toMatchObject({
      branch,
      runId: "88",
    });
    expect(mutations).toEqual([]);
    expect(reports).toEqual([expect.stringContaining("adopting exact continuation parent 88")]);
  });

  it("fails precisely when an exact continuation parent terminates without a valid plan", async () => {
    const reviewed = {
      children: { normalCi: child("normalCi", "101") },
      continuation: continuation(),
      legacy: true,
      releaseProfile: "beta",
      rerunGroup: "all",
      targetSha: TARGET_SHA,
    };
    const branch = continuationBranchName("77", SHA);
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        if (path === `compare/${SHA}...main`) {
          return { status: "ahead" };
        }
        if (path.startsWith("contents/")) {
          return { content: Buffer.from("continuation_plan_json:").toString("base64") };
        }
        if (path.startsWith("git/ref/")) {
          return { object: { sha: SHA } };
        }
        if (path.startsWith("actions/workflows/")) {
          return {
            workflow_runs: [
              {
                event: "workflow_dispatch",
                head_branch: branch,
                head_sha: SHA,
                id: 88,
              },
            ],
          };
        }
        if (path === "actions/runs/88") {
          return {
            conclusion: "failure",
            event: "workflow_dispatch",
            head_branch: branch,
            head_sha: SHA,
            id: 88,
            path: ".github/workflows/full-release-validation.yml",
            repository: { full_name: "openclaw/openclaw" },
            status: "completed",
          };
        }
        throw new Error(`unexpected read: ${path}`);
      },
      loadExecutionPlan: async () => undefined,
    });
    await expect(client.dispatchContinuation(reviewed)).rejects.toThrow(
      "exact continuation parent 88 terminated with conclusion failure without a valid immutable execution plan",
    );
  });

  it("rejects untrusted frozen tooling before ref or workflow mutation", async () => {
    const mutations: string[][] = [];
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        if (path === `compare/${SHA}...main`) {
          return { status: "behind" };
        }
        throw new Error(`unexpected read after trust rejection: ${path}`);
      },
      mutate: async (args: string[]) => {
        mutations.push(args);
        return "";
      },
    });
    await expect(
      client.dispatchContinuation({
        children: { normalCi: child("normalCi", "101") },
        continuation: continuation(),
        legacy: true,
        releaseProfile: "beta",
        rerunGroup: "all",
        targetSha: TARGET_SHA,
      }),
    ).rejects.toThrow(`not reachable from protected main in openclaw/openclaw`);
    expect(mutations).toEqual([]);
  });

  it("trusts source and continuation tooling SHAs independently", async () => {
    const sourceSha = "c".repeat(40);
    const reads: string[] = [];
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        reads.push(path);
        if (path === `compare/${SHA}...main`) {
          return { status: "ahead" };
        }
        if (path === `compare/${sourceSha}...main`) {
          return { status: "diverged" };
        }
        throw new Error(`unexpected read: ${path}`);
      },
    });
    await expect(client.verifyTrustedToolingSha(SHA)).resolves.toBeUndefined();
    await expect(client.verifyTrustedSourceSha(sourceSha)).rejects.toThrow(
      `Source workflow SHA ${sourceSha} is not reachable from protected main`,
    );
    expect(reads).toEqual([`compare/${SHA}...main`, `compare/${sourceSha}...main`]);
  });

  it("fails a deterministic dispatch rejection immediately without adoption polling", async () => {
    const branch = continuationBranchName("77", SHA);
    let runLists = 0;
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        if (path === `compare/${SHA}...main`) {
          return { status: "ahead" };
        }
        if (path.startsWith("contents/")) {
          return { content: Buffer.from("continuation_plan_json:").toString("base64") };
        }
        if (path.startsWith("git/ref/")) {
          return { object: { sha: SHA } };
        }
        if (path.startsWith("actions/workflows/")) {
          runLists += 1;
          return { workflow_runs: [] };
        }
        throw new Error(`unexpected read: ${path}`);
      },
      mutate: async () => {
        throw new Error("HTTP 422 invalid workflow input");
      },
    });
    await expect(
      client.dispatchContinuation(continuationPlan([child("normalCi", "101")])),
    ).rejects.toThrow("continuation parent dispatch was rejected: HTTP 422 invalid workflow input");
    expect(runLists).toBe(1);
    expect(branch).toBe(`release-ci/${SHA.slice(0, 12)}-77`);
  });

  it.each([
    ["transient", "HTTP 502 after dispatch"],
    ["ambiguous", "gh exited after sending the request"],
  ])("reconciles an exact parent after a %s dispatch response", async (_label, message) => {
    const branch = continuationBranchName("77", SHA);
    let dispatched = false;
    let runLists = 0;
    const reports: string[] = [];
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        if (path === `compare/${SHA}...main`) {
          return { status: "ahead" };
        }
        if (path.startsWith("contents/")) {
          return { content: Buffer.from("continuation_plan_json:").toString("base64") };
        }
        if (path.startsWith("git/ref/")) {
          return { object: { sha: SHA } };
        }
        if (path.startsWith("actions/workflows/")) {
          runLists += 1;
          return {
            workflow_runs: dispatched
              ? [
                  {
                    event: "workflow_dispatch",
                    head_branch: branch,
                    head_sha: SHA,
                    id: 88,
                  },
                ]
              : [],
          };
        }
        if (path === "actions/runs/88") {
          return {
            conclusion: null,
            event: "workflow_dispatch",
            head_branch: branch,
            head_sha: SHA,
            id: 88,
            path: ".github/workflows/full-release-validation.yml",
            repository: { full_name: "openclaw/openclaw" },
            status: "in_progress",
          };
        }
        throw new Error(`unexpected read: ${path}`);
      },
      loadExecutionPlan: async () => undefined,
      mutate: async () => {
        dispatched = true;
        throw new Error(message);
      },
      report: (value: string) => reports.push(value),
    });
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_TIMEOUT_MS = "100";
    await expect(
      client.dispatchContinuation(continuationPlan([child("normalCi", "101")])),
    ).resolves.toMatchObject({ branch, runId: "88" });
    expect(runLists).toBe(2);
    expect(reports).toEqual([expect.stringContaining("adopting exact continuation parent 88")]);
  });

  it("uses an atomic exact-OID lease to delete the deterministic ref", async () => {
    const gitCalls: string[][] = [];
    const client = createClient("openclaw/openclaw", {
      git: async (args: string[]) => {
        gitCalls.push(args);
        return args[0] === "remote" ? "https://github.com/openclaw/openclaw.git" : "";
      },
    });
    const branch = continuationBranchName("77", SHA);
    await expect(client.deleteWorkflowRef(branch, SHA)).resolves.toEqual({ deleted: true });
    expect(gitCalls).toEqual([
      ["remote", "get-url", "origin"],
      ["push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`],
    ]);
  });

  it("leaves the deterministic ref when local origin is not the selected repository", async () => {
    const gitCalls: string[][] = [];
    const reports: string[] = [];
    const client = createClient("openclaw/openclaw", {
      git: async (args: string[]) => {
        gitCalls.push(args);
        return "https://github.com/someone/else.git";
      },
      report: (message: string) => reports.push(message),
    });
    await expect(client.deleteWorkflowRef(continuationBranchName("77", SHA), SHA)).resolves.toEqual(
      { deleted: false },
    );
    expect(gitCalls).toEqual([["remote", "get-url", "origin"]]);
    expect(reports).toEqual([
      expect.stringContaining("local origin does not map to openclaw/openclaw"),
    ]);
  });

  it("leaves the deterministic ref when the exact-OID lease is rejected", async () => {
    const reports: string[] = [];
    const client = createClient("openclaw/openclaw", {
      git: async (args: string[]) => {
        if (args[0] === "remote") {
          return "git@github.com:openclaw/openclaw.git";
        }
        throw new Error("stale info");
      },
      report: (message: string) => reports.push(message),
    });
    await expect(client.deleteWorkflowRef(continuationBranchName("77", SHA), SHA)).resolves.toEqual(
      { deleted: false },
    );
    expect(reports).toEqual([expect.stringContaining("atomic lease deletion failed: stale info")]);
  });

  it("rejects a supplied child not emitted by the source parent", async () => {
    const selected = child("normalCi", "101");
    const methods = preflightMethods([selected], (entry) => runFor(entry, 1, "failure"));
    await expect(
      preflightContinuation(plan([selected]), "77", {
        ...methods,
        getJobLog: async (jobId: number) =>
          jobId === 1
            ? `RERUN_GROUP: all\nTARGET_SHA: ${TARGET_SHA}`
            : `TARGET_SHA: ${TARGET_SHA}\nDispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/999 (attempt 1)`,
      }),
    ).rejects.toThrow("not uniquely emitted");
  });
});
