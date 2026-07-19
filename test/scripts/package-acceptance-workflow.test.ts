// Package Acceptance Workflow tests cover package acceptance workflow script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const PACKAGE_ACCEPTANCE_WORKFLOW = ".github/workflows/package-acceptance.yml";
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const LIVE_MEDIA_RUNNER_DOCKERFILE = ".github/images/live-media-runner/Dockerfile";
const LIVE_MEDIA_RUNNER_IMAGE = "ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04";
const LIVE_MEDIA_RUNNER_IMAGE_WORKFLOW = ".github/workflows/live-media-runner-image.yml";
const NPM_TELEGRAM_WORKFLOW = ".github/workflows/npm-telegram-beta-e2e.yml";
const MANTIS_DISCORD_SMOKE_WORKFLOW = ".github/workflows/mantis-discord-smoke.yml";
const MANTIS_DISCORD_STATUS_REACTIONS_WORKFLOW =
  ".github/workflows/mantis-discord-status-reactions.yml";
const MANTIS_DISCORD_THREAD_ATTACHMENT_WORKFLOW =
  ".github/workflows/mantis-discord-thread-attachment.yml";
const MANTIS_SLACK_DESKTOP_SMOKE_WORKFLOW = ".github/workflows/mantis-slack-desktop-smoke.yml";
const MANTIS_TELEGRAM_DESKTOP_PROOF_WORKFLOW =
  ".github/workflows/mantis-telegram-desktop-proof.yml";
const MANTIS_TELEGRAM_LIVE_WORKFLOW = ".github/workflows/mantis-telegram-live.yml";
const MANTIS_WEB_UI_CHAT_PROOF_WORKFLOW = ".github/workflows/mantis-web-ui-chat-proof.yml";
const PACKAGE_JSON = "package.json";
const SETUP_PNPM_STORE_CACHE_ACTION = ".github/actions/setup-pnpm-store-cache/action.yml";
const DOCKER_E2E_PLAN_ACTION = ".github/actions/docker-e2e-plan/action.yml";
const RELEASE_CHECKS_WORKFLOW = ".github/workflows/openclaw-release-checks.yml";
const RELEASE_TELEGRAM_QA_WORKFLOW = ".github/workflows/openclaw-release-telegram-qa.yml";
const RELEASE_PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const PLUGIN_PRERELEASE_WORKFLOW = ".github/workflows/plugin-prerelease.yml";
const OPENCLAW_NPM_RELEASE_WORKFLOW = ".github/workflows/openclaw-npm-release.yml";
const PLUGIN_CLAWHUB_RELEASE_WORKFLOW = ".github/workflows/plugin-clawhub-release.yml";
const PLUGIN_NPM_RELEASE_WORKFLOW = ".github/workflows/plugin-npm-release.yml";
const PLUGIN_RELEASE_CONTINUE_WORKFLOW = ".github/workflows/plugin-release-continue.yml";
const ANDROID_RELEASE_WORKFLOW = ".github/workflows/android-release.yml";
const STABLE_MAIN_CLOSEOUT_WORKFLOW = ".github/workflows/openclaw-stable-main-closeout.yml";
const WINDOWS_NODE_RELEASE_WORKFLOW = ".github/workflows/windows-node-release.yml";
const FULL_RELEASE_VALIDATION_WORKFLOW = ".github/workflows/full-release-validation.yml";
const REPO_ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();
const RELEASE_MAINTAINER_SKILL = resolve(
  REPO_ROOT,
  ".agents/skills/release-openclaw-maintainer/SKILL.md",
);
const QA_LIVE_TRANSPORTS_WORKFLOW = ".github/workflows/qa-live-transports-convex.yml";
const UPDATE_MIGRATION_WORKFLOW = ".github/workflows/update-migration.yml";
const CI_CHECK_TESTBOX_WORKFLOW = ".github/workflows/ci-check-testbox.yml";
const CI_CHECK_ARM_TESTBOX_WORKFLOW = ".github/workflows/ci-check-arm-testbox.yml";
const CI_BUILD_ARTIFACTS_TESTBOX_WORKFLOW = ".github/workflows/ci-build-artifacts-testbox.yml";
const WINDOWS_BLACKSMITH_TESTBOX_WORKFLOW = ".github/workflows/windows-blacksmith-testbox.yml";
const CRABBOX_HYDRATE_WORKFLOW = ".github/workflows/crabbox-hydrate.yml";
const CRABBOX_CONFIG = ".crabbox.yaml";
const SCHEDULED_LIVE_CHECKS_WORKFLOW = ".github/workflows/openclaw-scheduled-live-checks.yml";
const CI_HYDRATE_LIVE_AUTH_SCRIPT = "scripts/ci-hydrate-live-auth.sh";
const VERIFY_PROVIDER_SECRETS_SCRIPT =
  ".agents/skills/release-openclaw-ci/scripts/verify-provider-secrets.mjs";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const SETUP_NODE_V6 = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const DOWNLOAD_ARTIFACT_V8 = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowStep = {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowMatrixEntry = {
  advisory?: boolean;
  command?: string;
  profiles?: string;
  suite_group?: string;
  suite_id?: string;
};

type WorkflowJob = {
  "continue-on-error"?: boolean | string;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean | string;
  };
  environment?: string;
  env?: Record<string, string>;
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  strategy?: {
    "fail-fast"?: boolean;
    "max-parallel"?: number | string;
    matrix?: {
      include?: WorkflowMatrixEntry[];
      lane?: string;
      profile?: string[];
    };
  };
  secrets?: string | Record<string, string>;
  "timeout-minutes"?: number | string;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type Workflow = {
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function isExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

function workflowPaths(): string[] {
  return readdirSync(".github/workflows")
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `.github/workflows/${name}`);
}

function workflowJob(path: string, jobName: string): WorkflowJob {
  const job = readWorkflow(path).jobs?.[jobName];
  if (!job) {
    throw new Error(`Expected workflow job ${jobName} in ${path}`);
  }
  return job;
}

function workflowStep(job: WorkflowJob, stepName: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Expected workflow step ${stepName}`);
  }
  return step;
}

function shellFunctionSource(source: string, functionName: string): string {
  const startMarker = `${functionName}() {`;
  const endMarker = "\n}\n";
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Expected shell function ${functionName}`);
  }
  const end = source.indexOf(endMarker, start);
  if (end < 0) {
    throw new Error(`Expected shell function terminator for ${functionName}`);
  }
  return source.slice(start, end + endMarker.length);
}

function workflowMatrixEntry(path: string, jobName: string, suiteId: string): WorkflowMatrixEntry {
  const entry = workflowJob(path, jobName).strategy?.matrix?.include?.find(
    (candidate) => candidate.suite_id === suiteId,
  );
  if (!entry) {
    throw new Error(`Expected workflow matrix entry ${suiteId} in ${jobName}`);
  }
  return entry;
}

function expectTextToIncludeAll(text: string | undefined, snippets: string[]): void {
  if (text === undefined) {
    throw new Error("Expected text to be defined before checking snippets");
  }
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

function runPackageAcceptanceSummary(params: {
  advisory?: boolean;
  dockerArtifactResult?: string;
  dockerRegistryResult?: string;
  telegramAdvisory?: boolean;
  telegramEnabled: boolean;
  telegramResult: string;
}) {
  const summary = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "summary");
  const script = workflowStep(summary, "Verify package acceptance results").run;
  if (!script) {
    throw new Error("Expected package acceptance summary script");
  }
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ADVISORY: String(params.advisory ?? false),
      DOCKER_ARTIFACT_RESULT: params.dockerArtifactResult ?? "success",
      DOCKER_REGISTRY_RESULT: params.dockerRegistryResult ?? "skipped",
      PACKAGE_INTEGRITY_RESULT: "success",
      PACKAGE_TELEGRAM_RESULT: params.telegramResult,
      PATH: process.env.PATH,
      RESOLVE_RESULT: "success",
      TELEGRAM_ADVISORY: String(params.telegramAdvisory ?? false),
      TELEGRAM_ENABLED: String(params.telegramEnabled),
    },
  });
}

function runNpmTelegramInputValidation(overrides: Record<string, string>) {
  const job = workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e");
  const script = workflowStep(job, "Validate inputs and secrets").run;
  if (!script) {
    throw new Error("Expected npm Telegram input validation script");
  }
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      OPENCLAW_QA_CONVEX_SECRET_CI: "test-secret",
      OPENCLAW_QA_CONVEX_SITE_URL: "https://example.invalid",
      PACKAGE_ARTIFACT_DIGEST: "",
      PACKAGE_ARTIFACT_ID: "",
      PACKAGE_ARTIFACT_NAME: "",
      PACKAGE_ARTIFACT_RUN_ATTEMPT: "",
      PACKAGE_ARTIFACT_RUN_ID: "",
      PACKAGE_FILE_NAME: "",
      PACKAGE_SHA256: "",
      PACKAGE_SOURCE_SHA: "",
      PACKAGE_SPEC: "openclaw@beta",
      PACKAGE_VERSION: "",
      PATH: process.env.PATH,
      PROVIDER_MODE: "mock-openai",
      ...overrides,
    },
  });
}

function runNpmTelegramArtifactValidation(params: {
  currentRunId: string;
  producerRunId: string;
  producerStatus: "completed" | "in_progress" | "queued";
  producerConclusion: "success" | null;
}) {
  const job = workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e");
  const script = workflowStep(job, "Validate package artifact identity").run;
  if (!script) {
    throw new Error("Expected npm Telegram artifact identity script");
  }
  const binDir = tempDirs.make("npm-telegram-artifact-gh-");
  const ghPath = `${binDir}/gh`;
  writeFileSync(
    ghPath,
    `#!/bin/sh
case "$*" in
  *actions/artifacts*) printf '%s\\n' "$MOCK_ARTIFACT_JSON" ;;
  *actions/runs*) printf '%s\\n' "$MOCK_ATTEMPT_JSON" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(ghPath, 0o755);
  const attempt = "2";
  const artifactId = "987";
  const artifactName = `package-under-test-${params.producerRunId}-${attempt}`;
  const digest = "a".repeat(64);
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ARTIFACT_DIGEST: digest,
      ARTIFACT_ID: artifactId,
      ARTIFACT_NAME: artifactName,
      ARTIFACT_RUN_ATTEMPT: attempt,
      ARTIFACT_RUN_ID: params.producerRunId,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ID: params.currentRunId,
      MOCK_ARTIFACT_JSON: JSON.stringify({
        created_at: "2026-07-15T08:49:20Z",
        digest: `sha256:${digest}`,
        expired: false,
        id: Number(artifactId),
        name: artifactName,
        workflow_run: { id: Number(params.producerRunId) },
      }),
      MOCK_ATTEMPT_JSON: JSON.stringify({
        conclusion: params.producerConclusion,
        id: Number(params.producerRunId),
        run_attempt: Number(attempt),
        run_started_at: "2026-07-15T08:39:00Z",
        status: params.producerStatus,
        updated_at: "2026-07-15T08:49:30Z",
      }),
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });
}

function runReleasePublishInputValidation(overrides: Record<string, string>) {
  const job = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
  const script = workflowStep(job, "Validate inputs").run;
  if (!script) {
    throw new Error("Expected release publish input validation script");
  }
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "1",
      FULL_RELEASE_VALIDATION_RUN_ID: "222",
      OPENCLAW_NPM_RESUME_RUN_ID: "",
      PATH: process.env.PATH,
      PLUGINS: "",
      PLUGIN_PUBLISH_SCOPE: "all-publishable",
      PREFLIGHT_RUN_ID: "111",
      PUBLISH_OPENCLAW_NPM: "true",
      RELEASE_NPM_DIST_TAG: "beta",
      RELEASE_PROFILE: "beta",
      RELEASE_TAG: "v2026.7.1-beta.3",
      WINDOWS_NODE_INSTALLER_DIGESTS: "",
      WINDOWS_NODE_TAG: "",
      WORKFLOW_REF: "refs/heads/main",
      ...overrides,
    },
  });
}

function runOpenClawNpmTrustedRefGuard(overrides: Record<string, string>) {
  const job = workflowJob(OPENCLAW_NPM_RELEASE_WORKFLOW, "validate_publish_request");
  const script = workflowStep(job, "Require trusted workflow ref for publish").run;
  if (!script) {
    throw new Error("Expected OpenClaw npm trusted ref guard");
  }
  const binDir = tempDirs.make("openclaw-npm-trusted-ref-");
  const gitPath = `${binDir}/git`;
  writeFileSync(
    gitPath,
    `#!/bin/sh\nif [ "$1" = "fetch" ]; then exit 0; fi\nif [ "$1" = "merge-base" ]; then [ "\${MOCK_WORKFLOW_ANCESTOR}" = "true" ]; exit $?; fi\nexit 2\n`,
  );
  chmodSync(gitPath, 0o755);
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      MOCK_WORKFLOW_ANCESTOR: "true",
      PATH: `${binDir}:${process.env.PATH}`,
      RELEASE_NPM_DIST_TAG: "beta",
      RELEASE_TAG: "v2026.7.2-beta.1",
      WORKFLOW_REF: "refs/heads/release/2026.7.2",
      WORKFLOW_SHA: "a".repeat(40),
      ...overrides,
    },
  });
}

function runReleaseChecksSummary(params: {
  currentAttempt: string;
  currentResult: "cancelled" | "failure" | "skipped" | "success";
  resolveResult?: "failure" | "success";
  telegramSelected?: boolean;
  workflowRef?: string;
}) {
  const summary = workflowJob(RELEASE_CHECKS_WORKFLOW, "summary");
  const script = workflowStep(summary, "Verify release check results").run;
  if (!script) {
    throw new Error("Expected release checks summary script");
  }
  const runId = "123456";
  const targetSha = "a".repeat(40);
  const workdir = tempDirs.make("openclaw-release-check-status-");
  return spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      CROSS_OS_RELEASE_CHECKS_RESULT: "success",
      DOCKER_E2E_RELEASE_CHECKS_RESULT: "success",
      GITHUB_RUN_ATTEMPT: params.currentAttempt,
      GITHUB_RUN_ID: runId,
      INSTALL_SMOKE_RELEASE_CHECKS_RESULT: "success",
      LIVE_REPO_E2E_RELEASE_CHECKS_RESULT: "success",
      MATURITY_SCORECARD_RELEASE_CHECKS_RESULT: "skipped",
      PACKAGE_ACCEPTANCE_RELEASE_CHECKS_RESULT: "success",
      PATH: process.env.PATH,
      PREPARE_RELEASE_PACKAGE_RESULT: "success",
      QA_LAB_PARITY_LANE_RELEASE_CHECKS_RESULT: "skipped",
      QA_LAB_PARITY_REPORT_RELEASE_CHECKS_RESULT: "skipped",
      QA_LAB_RUNTIME_PARITY_RELEASE_CHECKS_RESULT: "skipped",
      QA_LIVE_DISCORD_RELEASE_CHECKS_RESULT: "skipped",
      QA_LIVE_RELEASE_CHECKS_RESULT: "skipped",
      QA_LIVE_SLACK_RELEASE_CHECKS_RESULT: "skipped",
      QA_LIVE_TELEGRAM_RELEASE_CHECKS_RESULT: params.currentResult,
      QA_LIVE_TELEGRAM_SELECTED: String(params.telegramSelected ?? true),
      QA_LIVE_WHATSAPP_RELEASE_CHECKS_RESULT: "skipped",
      RELEASE_CHECK_RUN_ATTEMPT: params.currentAttempt,
      RELEASE_CHECK_RUN_ID: runId,
      RELEASE_CHECK_TARGET_SHA: targetSha,
      RESOLVE_TARGET_RESULT: params.resolveResult ?? "success",
      RUNTIME_TOOL_COVERAGE_RELEASE_CHECKS_RESULT: "skipped",
      WORKFLOW_REF: params.workflowRef ?? "refs/heads/release/2026.7.1",
    },
  });
}

describe("package acceptance workflow", () => {
  it("requires selected plugin names or complete immutable evidence for broad publication", () => {
    const selected = runReleasePublishInputValidation({
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "",
      FULL_RELEASE_VALIDATION_RUN_ID: "",
      PLUGINS: "@openclaw/meta",
      PLUGIN_PUBLISH_SCOPE: "selected",
      PREFLIGHT_RUN_ID: "",
      PUBLISH_OPENCLAW_NPM: "false",
    });
    expect(selected.status, selected.stderr).toBe(0);

    const emptySelected = runReleasePublishInputValidation({
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "",
      FULL_RELEASE_VALIDATION_RUN_ID: "",
      PLUGINS: "   ",
      PLUGIN_PUBLISH_SCOPE: "selected",
      PREFLIGHT_RUN_ID: "",
      PUBLISH_OPENCLAW_NPM: "false",
    });
    expect(emptySelected.status).toBe(1);
    expect(emptySelected.stderr).toContain("plugin_publish_scope=selected requires plugins");

    const broadWithoutEvidence = runReleasePublishInputValidation({
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "",
      FULL_RELEASE_VALIDATION_RUN_ID: "",
      PREFLIGHT_RUN_ID: "",
      PUBLISH_OPENCLAW_NPM: "false",
    });
    expect(broadWithoutEvidence.status).toBe(1);
    expect(broadWithoutEvidence.stderr).toContain("require preflight_run_id");

    const partialEvidence = runReleasePublishInputValidation({
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "",
      FULL_RELEASE_VALIDATION_RUN_ID: "",
      PLUGINS: "@openclaw/meta",
      PLUGIN_PUBLISH_SCOPE: "selected",
      PUBLISH_OPENCLAW_NPM: "false",
    });
    expect(partialEvidence.status).toBe(1);
    expect(partialEvidence.stderr).toContain("require full_release_validation_run_id");

    expect(runReleasePublishInputValidation({ PUBLISH_OPENCLAW_NPM: "false" }).status).toBe(0);

    const invalidResumeRun = runReleasePublishInputValidation({
      OPENCLAW_NPM_RESUME_RUN_ID: "not-a-run-id",
    });
    expect(invalidResumeRun.status).toBe(1);
    expect(invalidResumeRun.stderr).toContain(
      "openclaw_npm_resume_run_id must be a positive GitHub Actions run id",
    );
  });

  it("accepts only main-reachable protected SHA-pinned release publish tags", () => {
    const workflowSha = "a".repeat(40);
    const binDir = tempDirs.make("release-publish-gh-");
    const ghPath = `${binDir}/gh`;
    writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' "\${MOCK_MERGE_BASE_SHA}"\n`);
    chmodSync(ghPath, 0o755);
    const pinnedEnv = {
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${binDir}:${process.env.PATH}`,
      WORKFLOW_REF: `refs/tags/release-publish/${workflowSha.slice(0, 12)}-123`,
      WORKFLOW_SHA: workflowSha,
    };

    const valid = runReleasePublishInputValidation({
      ...pinnedEnv,
      MOCK_MERGE_BASE_SHA: workflowSha,
    });
    expect(valid.status, valid.stderr).toBe(0);

    const mismatchedName = runReleasePublishInputValidation({
      ...pinnedEnv,
      WORKFLOW_REF: `refs/tags/release-publish/${"b".repeat(12)}-123`,
    });
    expect(mismatchedName.status).toBe(1);
    expect(mismatchedName.stderr).toContain(
      "SHA-pinned release publish tag does not match workflow SHA",
    );

    const unreachable = runReleasePublishInputValidation({
      ...pinnedEnv,
      MOCK_MERGE_BASE_SHA: "c".repeat(40),
    });
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain(
      "SHA-pinned release publish tag revision is not reachable from current main",
    );
  });

  it("allows protected SHA-pinned tooling tags through the core npm publish guard", () => {
    const workflowSha = "a".repeat(40);
    const protectedRef = `refs/tags/release-publish/${workflowSha.slice(0, 12)}-123`;

    const valid = runOpenClawNpmTrustedRefGuard({
      WORKFLOW_REF: protectedRef,
      WORKFLOW_SHA: workflowSha,
    });
    expect(valid.status, valid.stderr).toBe(0);

    const mismatchedName = runOpenClawNpmTrustedRefGuard({
      WORKFLOW_REF: `refs/tags/release-publish/${"b".repeat(12)}-123`,
      WORKFLOW_SHA: workflowSha,
    });
    expect(mismatchedName.status).toBe(1);
    expect(mismatchedName.stderr).toContain(
      "SHA-pinned release-publish tag does not match the OpenClaw npm workflow SHA",
    );

    const unreachable = runOpenClawNpmTrustedRefGuard({
      MOCK_WORKFLOW_ANCESTOR: "false",
      WORKFLOW_REF: protectedRef,
      WORKFLOW_SHA: workflowSha,
    });
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain(
      "SHA-pinned OpenClaw npm workflow revision is not reachable from current main",
    );
  });

  it("allows protected SHA-pinned tooling tags to consume token-bootstrap evidence", () => {
    const publishJob = workflowJob(PLUGIN_NPM_RELEASE_WORKFLOW, "publish_plugins_npm");
    const evidenceStep = workflowStep(publishJob, "Consume immutable npm publication evidence");

    expect(evidenceStep.run).toContain("^refs/tags/release-publish/([a-f0-9]{12})-[1-9][0-9]*$");
    expect(evidenceStep.run).toContain(
      '[[ "$WORKFLOW_REF" == "refs/heads/main" || "$sha_pinned_release_publish" == "true" ]]',
    );
    expect(evidenceStep.run).toContain('git merge-base --is-ancestor "$WORKFLOW_SHA" origin/main');
  });

  it("retries child environment approval when deployment propagation lags", () => {
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const orchestration = workflowStep(publishJob, "Dispatch publish workflows").run;
    if (!orchestration) {
      throw new Error("Expected release publish orchestration script");
    }
    const waitForRun = shellFunctionSource(orchestration, "wait_for_run");
    const stateAssignment = waitForRun.indexOf('last_state="$state"');
    const approvalRetry = waitForRun.indexOf(
      'approve_pending_deployments "${workflow}" "${run_id}" "${expected_sha}" ||',
    );

    expect(stateAssignment).toBeGreaterThan(-1);
    expect(approvalRetry).toBeGreaterThan(stateAssignment);
    expect(waitForRun).toContain("propagation lag cannot strand an approved release");
  });

  it("resolves broad release evidence and exact-binds every publish child", () => {
    const resolveJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const publishOrchestration = workflowStep(publishJob, "Dispatch publish workflows");

    for (const stepName of [
      "Download OpenClaw npm preflight manifest",
      "Resolve full release validation run",
      "Download full release validation manifest",
      "Download trusted release validation tooling",
      "Validate OpenClaw npm preflight manifest",
      "Validate full release validation manifest",
    ]) {
      expect(workflowStep(resolveJob, stepName).if).toContain(
        "inputs.plugin_publish_scope == 'all-publishable'",
      );
    }
    for (const stepName of [
      "Write Android release approval",
      "Attest Android release approval",
      "Upload Android release approval",
    ]) {
      expect(workflowStep(publishJob, stepName).if).toContain("inputs.publish_openclaw_npm");
    }

    expect(publishOrchestration.env?.PARENT_WORKFLOW_SHA).toBe("${{ github.sha }}");
    expect(publishOrchestration.env?.CHILD_WORKFLOW_REF).toBe("${{ github.ref_name }}");
    expect(readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8")).toContain(
      "otherwise approve and monitor the detached runs separately",
    );
    expectTextToIncludeAll(publishOrchestration.run, [
      'gh api "repos/${GITHUB_REPOSITORY}/commits/${encoded_workflow_ref}"',
      'if [[ "$resolved_workflow_sha" != "$expected_sha" ]]',
      'verify_child_run_sha "$workflow" "$run_id" "$expected_sha" || return 1',
      'approve_pending_deployments "${workflow}" "${run_id}" "${expected_sha}"',
      'wait_for_run windows-node-release.yml "${windows_node_run_id}" "${PARENT_WORKFLOW_SHA}"',
      'dispatch_workflow_at_ref "${RELEASE_TAG}" "${TARGET_SHA}" android-release.yml',
      'wait_for_run android-release.yml "${android_release_run_id}" "${TARGET_SHA}"',
      'wait_for_run plugin-npm-release.yml "${plugin_npm_run_id}" "${PARENT_WORKFLOW_SHA}"',
      'wait_for_run_background openclaw-npm-release.yml "${openclaw_npm_run_id}" "${PARENT_WORKFLOW_SHA}"',
      "plugin-clawhub-release.yml: detached; approval and publish not awaited",
      "plugin-clawhub-new.yml: detached; approvals and bootstrap not awaited",
    ]);
  });

  it("dispatches ClawHub only after plugin npm succeeds", () => {
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const orchestration = workflowStep(publishJob, "Dispatch publish workflows").run;
    if (!orchestration) {
      throw new Error("Expected release publish orchestration script");
    }

    const pluginNpmDispatch = orchestration.indexOf(
      'plugin_npm_run_id="$(dispatch_workflow plugin-npm-release.yml',
    );
    const pluginNpmWait = orchestration.indexOf(
      'wait_for_run plugin-npm-release.yml "${plugin_npm_run_id}"',
    );
    const continuationDispatch = orchestration.indexOf(
      "dispatch_workflow plugin-release-continue.yml",
    );
    const clawHubDispatch = orchestration.indexOf(
      'plugin_clawhub_run_id="$(dispatch_workflow_at_ref',
    );
    const clawHubBootstrapDispatch = orchestration.indexOf(
      'plugin_clawhub_bootstrap_run_id="$(dispatch_workflow_at_ref',
    );

    expect(pluginNpmDispatch).toBeGreaterThan(-1);
    expect(continuationDispatch).toBeGreaterThan(pluginNpmDispatch);
    expect(continuationDispatch).toBeLessThan(pluginNpmWait);
    expect(pluginNpmWait).toBeGreaterThan(pluginNpmDispatch);
    expect(clawHubDispatch).toBeGreaterThan(pluginNpmWait);
    expect(clawHubBootstrapDispatch).toBeGreaterThan(pluginNpmWait);
    expect(orchestration).toContain(
      "Plugin npm publish failed; ClawHub publish was not dispatched.",
    );
    expect(orchestration).not.toContain("cancelling dispatched ClawHub child workflows");
  });

  it("starts prerelease core publication before plugin npm convergence", () => {
    const publishStep = workflowStep(
      workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish"),
      "Dispatch publish workflows",
    );
    const orchestration = publishStep.run;
    if (!orchestration) {
      throw new Error("Expected release publish orchestration script");
    }

    const pluginNpmWait = orchestration.indexOf(
      'wait_for_run plugin-npm-release.yml "${plugin_npm_run_id}"',
    );
    const continuationDispatch = orchestration.indexOf(
      "dispatch_workflow plugin-release-continue.yml",
    );
    const prereleaseCoreStart = orchestration.indexOf(
      'if ! is_stable_release && [[ "${PUBLISH_OPENCLAW_NPM}" == "true" ]]; then',
    );

    expect(prereleaseCoreStart).toBeGreaterThan(-1);
    expect(prereleaseCoreStart).toBeLessThan(pluginNpmWait);
    expect(continuationDispatch).toBeGreaterThan(prereleaseCoreStart);
    expect(continuationDispatch).toBeLessThan(pluginNpmWait);
    expect(orchestration).toContain(
      "ClawHub convergence failed; beta core release remains publishable.",
    );
    expect(orchestration).toContain(
      "Release state: beta-live; plugin ecosystem convergence remains asynchronous",
    );
    expect(orchestration).toContain(
      "Core prerelease publication starts before every fallible plugin",
    );
    expect(publishStep.env?.CLAWHUB_PLAN_OUTCOME).toBe("${{ steps.clawhub_plan.outcome }}");
    expect(orchestration).toContain('if [[ "${CLAWHUB_PLAN_OUTCOME}" != "success" ]]; then');
    expect(orchestration).toContain(
      "ClawHub release planning step failed; prerelease ecosystem repair is required.",
    );
    expect(orchestration).toContain(
      '[[ "${PUBLISH_OPENCLAW_NPM}" == "true" && "${WAIT_FOR_CLAWHUB}" != "true" ]]',
    );
    expect(orchestration).toContain('if [[ "${plugin_ecosystem_detached}" != "true" ]]; then');
    expect(orchestration).toContain("Plugin ecosystem continuation dispatch failed");
    expect(orchestration).toContain("return_run_details: true");
    expect(orchestration).toContain('[[ "${WAIT_FOR_CLAWHUB}" == "true" ]]');
    expect(orchestration).toMatch(
      /plugin_ecosystem_is_required\(\) \{\n\s+is_stable_release \|\|\n\s+\[\[ "\$\{PUBLISH_OPENCLAW_NPM\}" != "true" \]\]/,
    );
    expect(orchestration).toContain(
      'if should_wait_for_plugin_ecosystem && [[ "${ecosystem_failed}" == "0" && "${clawhub_failed}" == "0" && "${plugin_npm_succeeded}" == "true" ]]; then',
    );
    expect(orchestration).toContain('if ! plugin_clawhub_run_id="$(dispatch_workflow_at_ref');
    expect(orchestration).toContain(
      "Plugin ecosystem did not converge; prerelease core and GitHub publication completed at beta-live.",
    );
    expect(orchestration).toMatch(
      /upload_release_evidence_assets\n\s+publish_github_release\n\s+mark_release_completion\n\s+upload_release_evidence_assets/,
    );
    expect(orchestration).toContain('.releaseState = "verification-passed"');
    expect(orchestration).toContain(".pluginPublishScope = $plugin_publish_scope");
    expect(orchestration).toContain(".releaseProfile = $release_profile");
    expect(orchestration).toContain(
      ".windowsNodeInstallerDigests = $windows_node_installer_digests",
    );
    expect(orchestration).toContain("windows_node_installer_digests='{}'");
  });

  it("continues prerelease plugin publication outside the beta-live critical path", () => {
    const job = workflowJob(PLUGIN_RELEASE_CONTINUE_WORKFLOW, "continue_plugin_release");
    const identity = workflowStep(job, "Validate continuation identity");
    const download = workflowStep(job, "Download parent ClawHub release plan");
    const wait = workflowStep(job, "Wait for plugin npm");
    const handoff = workflowStep(job, "Download plugin npm release handoff");
    const continuation = workflowStep(job, "Continue ClawHub release");
    const continuationRun = continuation.run;
    if (!continuationRun) {
      throw new Error("Expected plugin release continuation script");
    }

    expect(job.permissions?.actions).toBe("write");
    expect(job["timeout-minutes"]).toBe(300);
    expect(identity.run).toContain(
      '[[ "${PARENT_WORKFLOW_SHA}" =~ ^[a-f0-9]{40}$ && "${GITHUB_SHA}" == "${PARENT_WORKFLOW_SHA}" ]]',
    );
    expect(download.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    expect(download.with?.["run-id"]).toBe("${{ inputs.release_publish_run_id }}");
    expect(wait.run).toContain(
      'gh run watch --repo "${GITHUB_REPOSITORY}" "${PLUGIN_NPM_RUN_ID}" --exit-status',
    );
    expect(handoff.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    expect(handoff.with?.name).toContain("plugin-npm-release-handoff-");
    expect(handoff.with?.["run-id"]).toBe("${{ inputs.plugin_npm_run_id }}");
    expect(continuationRun).toContain('.kind == "openclaw-plugin-npm-release-handoff"');
    expect(continuationRun).toContain(".releasePublishRunId == $parent_run_id");
    expect(continuationRun).toContain(".sourceSha == $release_sha");
    expect(continuationRun).toContain(".pluginNpm.inputs == $handoff[0].inputs");
    expect(continuationRun).toContain("dispatch_target normal");
    expect(continuationRun).toContain("dispatch_target bootstrap");
    expect(continuationRun).toContain("return_run_details: true");
    expect(continuationRun).toContain('status: "ecosystem-converged"');
  });

  it("emits an immutable parent-bound plugin npm handoff", () => {
    const job = workflowJob(PLUGIN_NPM_RELEASE_WORKFLOW, "record_release_handoff");
    const write = workflowStep(job, "Write immutable release handoff");
    const upload = workflowStep(job, "Upload immutable release handoff");

    expect(job.if).toContain("inputs.release_publish_run_id != ''");
    expect(job.if).toContain("needs.publish_plugins_npm.result == 'success'");
    expectTextToIncludeAll(write.run, [
      'kind: "openclaw-plugin-npm-release-handoff"',
      "releasePublishRunId: $release_publish_run_id",
      "sourceSha: $source_sha",
      "workflowSha: $workflow_sha",
      "npm_dist_tag: $npm_dist_tag",
      "preflight_only: $preflight_only",
    ]);
    expect(upload.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(upload.with?.name).toContain("plugin-npm-release-handoff-");
  });

  it("compares dependency evidence zip contents independently of archive timestamps", () => {
    const orchestration = workflowStep(
      workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish"),
      "Dispatch publish workflows",
    ).run;
    if (!orchestration) {
      throw new Error("Expected release publish orchestration script");
    }
    const tempDir = tempDirs.make("release-evidence-zip-");
    const sourceDir = `${tempDir}/source`;
    const existingDir = `${tempDir}/existing`;
    const sourceZip = `${tempDir}/source.zip`;
    const existingZip = `${tempDir}/existing.zip`;
    const symlinkZip = `${tempDir}/symlink.zip`;
    const corruptZip = `${tempDir}/corrupt.zip`;
    for (const dir of [sourceDir, existingDir]) {
      mkdirSync(`${dir}/dependency-evidence`, { recursive: true });
      writeFileSync(`${dir}/dependency-evidence/proof.json`, '{"ok":true}\n');
    }
    execFileSync("touch", ["-t", "198001010000", `${sourceDir}/dependency-evidence/proof.json`]);
    execFileSync("touch", ["-t", "202001010000", `${existingDir}/dependency-evidence/proof.json`]);
    execFileSync("zip", ["-X", "-q", sourceZip, "dependency-evidence/proof.json"], {
      cwd: sourceDir,
    });
    execFileSync("zip", ["-X", "-q", existingZip, "dependency-evidence/proof.json"], {
      cwd: existingDir,
    });
    symlinkSync("../../outside", `${existingDir}/dependency-evidence/link`);
    execFileSync("zip", ["-X", "-y", "-q", symlinkZip, "dependency-evidence/link"], {
      cwd: existingDir,
    });
    const sourceArchive = readFileSync(sourceZip);
    writeFileSync(corruptZip, sourceArchive.subarray(0, -10));

    const compare = (left: string, right: string) =>
      spawnSync("python3", ["scripts/compare-release-evidence-zip.py", left, right], {
        encoding: "utf8",
      });

    const result = compare(sourceZip, existingZip);
    const symlinkResult = compare(symlinkZip, symlinkZip);
    const corruptResult = compare(corruptZip, corruptZip);

    expect(result.status, result.stderr).toBe(0);
    expect(symlinkResult.status).toBe(1);
    expect(symlinkResult.stderr).toContain("unsupported dependency evidence archive entry");
    expect(corruptResult.status).toBe(1);
    expect(corruptResult.stderr).toContain("dependency evidence ZIP comparison failed");
    expect(orchestration).toContain("find dependency-evidence -type f -exec touch -t 198001010000");
    expect(orchestration).toContain(
      'attach_or_verify_release_asset "${asset_path}" "${asset_name}" zip-tree',
    );
    expect(orchestration).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/compare-release-evidence-zip.py"',
    );
  });

  it("verifies immutable postpublish evidence before stable closeout reads it", () => {
    const workflow = readFileSync(STABLE_MAIN_CLOSEOUT_WORKFLOW, "utf8");
    const evidenceStep = workflowStep(
      workflowJob(STABLE_MAIN_CLOSEOUT_WORKFLOW, "verify"),
      "Verify release workflow evidence",
    );
    const attachStep = workflowStep(
      workflowJob(STABLE_MAIN_CLOSEOUT_WORKFLOW, "verify"),
      "Attach immutable closeout evidence",
    );
    const checksumIndex = workflow.indexOf(
      'sha256sum --strict --status -c "$evidence_checksum_asset"',
    );
    const evidenceReadIndex = workflow.indexOf('evidence_release_tag="$(jq -r');
    const releaseVersionGateIndex = workflow.indexOf(
      'if [[ "$main_version" != "$release_package_version" &&',
    );
    const evidenceDownloadIndex = workflow.indexOf(
      'gh_with_retry release download "$evidence_source_tag"',
    );
    const partialRepairIndex = workflow.indexOf('if [[ -f "$closeout_json_path" ]]; then');
    const existingCloseoutEvidenceMatchIndex = workflow.indexOf(
      'if [[ -n "$existing_closeout_full_release_validation_run_id" &&',
    );
    const rollbackDrillGateIndex = workflow.indexOf(
      'if [[ -z "$ROLLBACK_DRILL_ID" || -z "$ROLLBACK_DRILL_DATE" ]]; then',
    );
    const rollbackDrillPushSkipIndex = workflow.indexOf(
      "Stable closeout skipped: rollback drill repository variables are missing",
    );
    const evidenceScriptSyntax = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: evidenceStep.run,
    });
    const attachScriptSyntax = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: attachStep.run,
    });

    expect(evidenceScriptSyntax.status, evidenceScriptSyntax.stderr).toBe(0);
    expect(attachScriptSyntax.status, attachScriptSyntax.stderr).toBe(0);
    expect(workflow).toContain('evidence_checksum_asset="${evidence_asset}.sha256"');
    expect(workflow).toContain('--pattern "$evidence_checksum_asset"');
    expect(workflow).toContain('fallback_package_version="${BASH_REMATCH[1]}"');
    expect(workflow).toContain('tag_package_content="$RUNNER_TEMP/tag-package-content.b64"');
    expect(workflow).toContain(
      'gh_with_retry api "repos/$GITHUB_REPOSITORY/contents/package.json?ref=$tag"',
    );
    expect(workflow).toContain("for attempt in 1 2 3; do");
    expect(workflow).toContain("sleep $((attempt * 5))");
    expect(workflow).toContain(
      "Stable closeout could not read package.json for $tag from GitHub API.",
    );
    expect(workflow).toContain(
      "Stable closeout package.json content for $tag was not valid base64.",
    );
    expect(workflow).toContain('tag_package_version="$(jq -r');
    expect(workflow).toContain('evidence_source_tag="v$fallback_package_version"');
    expect(workflow).toContain('gh_with_retry release download "$evidence_source_tag"');
    expect(workflow).toContain("Checkout fallback evidence tag");
    expect(workflow).toContain("Bind fallback correction to the published package source");
    expect(workflow).toContain(
      "Fallback correction ${{ needs.resolve.outputs.tag }} must point to the same source commit",
    );
    expect(workflow).toContain("main_ref: ${{ steps.inputs.outputs.main_ref }}");
    expect(workflow).toContain("TRIGGER_SHA: ${{ github.sha }}");
    expect(workflow).toContain('main_ref="$TRIGGER_SHA"');
    expect(workflow).toContain("ref: ${{ needs.resolve.outputs.main_ref }}");
    expect(workflow).toContain(
      "Stable closeout skipped: $evidence_source_tag predates immutable postpublish evidence.",
    );
    expect(workflow).toContain("Stable closeout is required for $tag");
    expect(workflow).toContain('closeout_checksum_asset="${closeout_asset}.sha256"');
    expect(workflow).toContain('expected_closeout_digest="$(awk');
    expect(workflow).toContain('actual_closeout_digest="$(sha256sum "$closeout_json_path"');
    expect(workflow).toContain(
      "Stable closeout manifest for $tag is incomplete; refusing to repair it.",
    );
    expect(workflow).toContain(
      'if [[ -f "$closeout_checksum_path" && ! -f "$closeout_json_path" ]]; then',
    );
    expect(workflow).toContain(
      "Stable closeout evidence for $tag has an invalid checksum; refusing to repair it.",
    );
    expect(workflow).toContain("repair_partial_closeout=false");
    expect(workflow).toContain(
      "Stable closeout manifest for $tag does not match immutable postpublish evidence; refusing to accept it.",
    );
    expect(workflow).toContain("Stable closeout already complete for $tag.");
    expect(workflow).toContain("allow_failed_publish_recovery:");
    expect(workflow).toContain(
      'const recoveryRequested = process.env.ALLOW_FAILED_PUBLISH_RECOVERY === "true";',
    );
    expect(workflow).toContain("Failed-publish recovery requires conclusion=failure");
    expect(workflow).toContain(
      '--require-complete-platform-assets "$ALLOW_FAILED_PUBLISH_RECOVERY"',
    );
    expect(workflow).toContain("verify_checksum_manifest OpenClaw-Android-SHA256SUMS.txt");
    expect(workflow).toContain("verify_checksum_manifest OpenClawCompanion-SHA256SUMS.txt");
    expect(workflow).toContain("actual=\"$(awk 'NF { name=$2;");
    expect(workflow).toContain('sub(/^\\*/, "", name)');
    expect(workflow).not.toContain('sub(/^\\\\*/, "", name)');
    expect(workflow).toContain('sed \'s/\\r$//\' "$manifest" > "$normalized"');
    expect(workflow).toContain('sha256sum --strict --check "$normalized"');
    expect(workflow).toContain(
      "Windows Node Release must contain one successful signed-installer promotion job.",
    );
    expect(workflow).toContain('"Verify Authenticode signatures"');
    expect(workflow).toContain("EXPECTED_INSTALLER_DIGESTS:");
    expect(workflow).toContain('--windows-node-release-run-id "${WINDOWS_NODE_RELEASE_RUN_ID:-}"');
    expect(workflow).toContain(
      '--windows-node-installer-digests "${WINDOWS_NODE_INSTALLER_DIGESTS:-}"',
    );
    expect(workflow).toContain(
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/android-release.yml"',
    );
    expect(workflow).toContain(
      "Stable closeout requires repository variables RELEASE_ROLLBACK_DRILL_ID and RELEASE_ROLLBACK_DRILL_DATE, or explicit manual overrides.",
    );
    expect(workflow).toContain(
      "REPAIR_PARTIAL_CLOSEOUT: ${{ needs.resolve.outputs.repair_partial_closeout }}",
    );
    expect(workflow).toContain('--allow-stale-rollback-drill "$REPAIR_PARTIAL_CLOSEOUT"');
    expect(workflow).toContain(
      'awk -v asset="openclaw-${release_version}-stable-main-closeout.json"',
    );
    expect(workflow).toContain("attach_or_verify \\");
    expect(attachStep.run).toContain('cp -- "$source_path" "$existing_dir/$asset_name"');
    expect(attachStep.run).toContain(
      '"$existing_dir/$asset_name#$asset_name" --repo "$GITHUB_REPOSITORY"',
    );
    expect(attachStep.run).not.toContain('"$source_path#$asset_name"');
    expect(workflow).toContain(
      "full_release_validation_run_attempt: ${{ steps.inputs.outputs.full_release_validation_run_attempt }}",
    );
    expect(workflow).toContain("(.[0].runAttempt == null) or");
    expect(workflow).toContain(
      'release_manifest_asset="openclaw-${evidence_version}-release-manifest.json"',
    );
    expect(workflow).toContain('sha256sum --strict --status -c "$release_manifest_checksum_asset"');
    expect(workflow).toContain(
      '"$existing_closeout_full_release_validation_run_attempt" != "$full_release_validation_run_attempt"',
    );
    expect(evidenceStep.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ needs.resolve.outputs.full_release_validation_run_attempt }}",
    );
    expect(evidenceStep.run).toContain(
      "actions/runs/${FULL_RELEASE_VALIDATION_RUN_ID}/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}",
    );
    expect(evidenceStep.run).toContain(
      'String(run.run_attempt ?? "") !== process.env.FULL_RELEASE_VALIDATION_RUN_ATTEMPT',
    );
    expect(evidenceStep.run).toContain(
      'manifest_asset="openclaw-${evidence_version}-release-manifest.json"',
    );
    expect(evidenceStep.run).toContain('gh_with_retry release download "$EVIDENCE_TAG"');
    expect(evidenceStep.run).toContain(".runId == $run_id");
    expect(evidenceStep.run).toContain(".runAttempt == $run_attempt");
    expect(workflow).toContain(
      '--full-release-validation-run-attempt "$FULL_RELEASE_VALIDATION_RUN_ATTEMPT"',
    );
    expect(checksumIndex).toBeGreaterThan(-1);
    expect(evidenceReadIndex).toBeGreaterThan(checksumIndex);
    expect(existingCloseoutEvidenceMatchIndex).toBeGreaterThan(evidenceReadIndex);
    expect(workflow.slice(checksumIndex, existingCloseoutEvidenceMatchIndex)).not.toContain(
      'echo "should_closeout=false"',
    );
    expect(releaseVersionGateIndex).toBeGreaterThan(-1);
    expect(partialRepairIndex).toBeGreaterThan(-1);
    expect(partialRepairIndex).toBeLessThan(releaseVersionGateIndex);
    expect(evidenceDownloadIndex).toBeGreaterThan(releaseVersionGateIndex);
    expect(rollbackDrillGateIndex).toBeGreaterThan(existingCloseoutEvidenceMatchIndex);
    expect(rollbackDrillPushSkipIndex).toBeGreaterThan(rollbackDrillGateIndex);
  });

  it("keeps pnpm version selection sourced from packageManager", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      packageManager?: string;
    };
    const setupPnpmAction = readFileSync(SETUP_PNPM_STORE_CACHE_ACTION, "utf8");

    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]+$/u);
    expect(setupPnpmAction).toContain("Setup pnpm from packageManager");
    expect(setupPnpmAction).toContain("PACKAGE_MANAGER_FILE: ${{ inputs.package-manager-file }}");
    expect(setupPnpmAction).toContain('case "$package_manager" in');
    expect(setupPnpmAction).toContain('corepack prepare "$package_manager" --activate');
    expect(setupPnpmAction).toContain(
      "if: ${{ inputs.use-actions-cache == 'true' && runner.os != 'Windows' }}",
    );
    expect(setupPnpmAction).toContain(
      "key: pnpm-store-${{ runner.os }}-${{ runner.arch }}-${{ inputs.node-version }}-${{ hashFiles(inputs.package-manager-file) }}-${{ hashFiles(inputs.lockfile-path) }}",
    );
    expect(setupPnpmAction).not.toContain("pnpm/action-setup");
    expect(setupPnpmAction).not.toContain("shasum");
    expect(setupPnpmAction).not.toContain("PNPM_VERSION_INPUT");
    expect(setupPnpmAction).not.toContain("version: ${{ inputs.pnpm-version }}");
    expect(setupPnpmAction).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(setupPnpmAction).toContain('echo "PNPM_HOME=$PNPM_HOME" >> "$GITHUB_ENV"');

    const setupNodeAction = readFileSync(".github/actions/setup-node-env/action.yml", "utf8");
    expect(setupNodeAction).toContain("Normalize container toolcache");
    expect(setupNodeAction).toContain("ln -s /__t /opt/hostedtoolcache");
    expect(setupNodeAction).toContain("use-actions-cache: ${{ inputs.use-actions-cache }}");

    for (const workflowPath of workflowPaths()) {
      const workflowText = readFileSync(workflowPath, "utf8");
      expect(workflowText, workflowPath).not.toContain("PNPM_VERSION");
      expect(workflowText, workflowPath).not.toContain("pnpm-version:");
      expect(workflowText, workflowPath).not.toContain("pnpm/action-setup");
    }
  });

  it("keeps Crabbox hydration compatible with local Actions replay", () => {
    const crabboxConfig = parse(readFileSync(CRABBOX_CONFIG, "utf8")) as {
      actions?: { job?: string };
    };
    const workflowText = readFileSync(CRABBOX_HYDRATE_WORKFLOW, "utf8");
    const hydrate = workflowJob(CRABBOX_HYDRATE_WORKFLOW, "hydrate");
    const hydrateWindowsDaemon = workflowJob(CRABBOX_HYDRATE_WORKFLOW, "hydrate-windows-daemon");
    const hydrateGithub = workflowJob(CRABBOX_HYDRATE_WORKFLOW, "hydrate-github");

    expect(crabboxConfig.actions?.job).toBe("hydrate");
    expect(hydrate.if).toBe(
      "${{ inputs.crabbox_job != 'hydrate-github' && inputs.crabbox_job != 'hydrate-windows-daemon' }}",
    );
    expect(workflowStep(hydrate, "Setup Node.js").uses).toBe(SETUP_NODE_V6);
    expect(workflowStep(hydrate, "Setup Node.js").with?.["node-version"]).toBe("24");
    const hydratePnpm = workflowStep(hydrate, "Setup pnpm and dependencies");
    expect(hydratePnpm.if).toBeUndefined();
    expect(hydratePnpm.run).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(hydratePnpm.run).toContain("COREPACK_HOME");
    expect(workflowText).toContain('PNPM_CONFIG_STORE_DIR: "/var/cache/crabbox/pnpm/store"');
    expect(hydratePnpm.run).toContain("prepare_crabbox_pnpm_dirs");
    expect(hydratePnpm.run).toContain('case "${PNPM_CONFIG_MODULES_DIR:?}" in "$volatile_root"/*)');
    expect(hydratePnpm.run).toContain(
      'case "${PNPM_CONFIG_VIRTUAL_STORE_DIR:?}" in "$volatile_root"/*)',
    );
    expect(hydratePnpm.run).toContain('rm -rf -- "$volatile_root"');
    expect(hydratePnpm.run).toContain('mkdir -p "$volatile_root" "$PNPM_CONFIG_STORE_DIR"');
    expect(hydratePnpm.run).toContain(
      'mkdir -p "$PNPM_CONFIG_MODULES_DIR" "$PNPM_CONFIG_VIRTUAL_STORE_DIR"',
    );
    expect(hydratePnpm.run).toContain("Refusing unsafe pnpm directory");
    expect(hydratePnpm.run).not.toContain('rm -rf -- "${PNPM_CONFIG_MODULES_DIR:?}"');
    expect(hydratePnpm.run).toContain(
      '[ "$(readlink node_modules)" = "${PNPM_CONFIG_MODULES_DIR:-}" ]',
    );
    expect(hydratePnpm.run).toContain("pnpm_install_artifacts_ready");
    expect(hydratePnpm.run).toContain("run_pnpm_install || run_pnpm_install");
    expect(hydratePnpm.run).toContain('setsid pnpm "${install_args[@]}"');
    expect(hydratePnpm.run).toContain("grep -qE '^Done in .+ using pnpm v'");
    expect(hydratePnpm.run).toContain("https://github.com/pnpm/pnpm/issues/12297");
    expect(hydratePnpm.run).toContain('kill -TERM -- "-$pnpm_pid"');
    expect(hydratePnpm.run).toContain('kill -KILL -- "-$pnpm_pid"');
    expect(hydratePnpm.run).toContain('test -s "$PNPM_CONFIG_MODULES_DIR/.modules.yaml"');
    expect(hydratePnpm.run).toContain('test -x "$PNPM_CONFIG_MODULES_DIR/.bin/oxfmt"');
    expect(hydratePnpm.run).toContain('test -f "$PNPM_CONFIG_MODULES_DIR/typescript/package.json"');
    expect(workflowStep(hydrate, "Fetch main ref").run).toContain(
      "timeout --signal=TERM --kill-after=10s 30s git",
    );
    expect(workflowStep(hydrate, "Fetch main ref").run).toContain(
      "fetch --no-tags --prune --no-recurse-submodules --depth=50 origin",
    );
    expect(workflowStep(hydrate, "Fetch main ref").run).toContain(
      '"+refs/heads/main:refs/remotes/origin/main"',
    );
    expect(workflowStep(hydrate, "Prepare Crabbox shell").if).toBeUndefined();
    const prepareCrabboxShell = workflowStep(hydrate, "Prepare Crabbox shell").run;
    expect(prepareCrabboxShell).toContain("link_node_tool()");
    expect(prepareCrabboxShell).toContain('readlink -f "$source"');
    expect(prepareCrabboxShell).toContain('readlink -f "$target"');
    expect(prepareCrabboxShell).toContain("link_node_tool corepack");
    expect(workflowStep(hydrate, "Ensure Docker is running").if).toBeUndefined();
    expect(workflowStep(hydrate, "Ensure SSH is available").if).toBeUndefined();
    expect(workflowStep(hydrate, "Hydrate provider env helper").if).toBeUndefined();
    expect(workflowStep(hydrate, "Mark Crabbox ready").run).toContain("COREPACK_HOME");
    expect(workflowStep(hydrate, "Hydrate provider env helper").env).toBeUndefined();

    expect(hydrateWindowsDaemon.if).toBe("${{ inputs.crabbox_job == 'hydrate-windows-daemon' }}");
    expect(workflowStep(hydrateWindowsDaemon, "Setup Node.js").uses).toBe(SETUP_NODE_V6);
    const hydrateWindowsPnpm = workflowStep(hydrateWindowsDaemon, "Setup pnpm and dependencies");
    expect(hydrateWindowsPnpm.shell).toBe("powershell");
    expect(hydrateWindowsPnpm.run).toContain(
      '$env:PNPM_CONFIG_MODULES_DIR = Join-Path $pnpmCacheRoot "node_modules"',
    );
    expect(hydrateWindowsPnpm.run).toContain(
      '$env:PNPM_CONFIG_VIRTUAL_STORE_DIR = Join-Path $pnpmCacheRoot "virtual-store"',
    );
    expect(hydrateWindowsPnpm.run).not.toContain("PNPM_CONFIG_PACKAGE_IMPORT_METHOD");
    expect(hydrateWindowsPnpm.run).toContain("--config.side-effects-cache=false");
    expect(hydrateWindowsPnpm.run).toContain("--ignore-scripts=true");
    expect(hydrateWindowsPnpm.run).toContain('$env:PNPM_CONFIG_CHILD_CONCURRENCY = "4"');
    expect(hydrateWindowsPnpm.run).toContain('$env:PNPM_CONFIG_NETWORK_CONCURRENCY = "8"');
    expect(hydrateWindowsPnpm.run).toContain('$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = "false"');
    expect(hydrateWindowsPnpm.run).toContain(
      "$Value | Out-File -FilePath $Path -Encoding utf8 -Append",
    );
    expect(hydrateWindowsPnpm.run).toContain('"--filter",');
    expect(hydrateWindowsPnpm.run).toContain('"openclaw",');
    expect(hydrateWindowsPnpm.run).toContain(
      "New-Item -ItemType Junction -Path $workspaceNodeModules -Target $env:PNPM_CONFIG_MODULES_DIR",
    );
    expect(hydrateWindowsPnpm.run).toContain(".pnpm-workspace-state-v1.json");
    expect(hydrateWindowsPnpm.run).not.toContain("Remove-Item -Recurse -Force");
    expect(hydrateWindowsPnpm.run).not.toContain("Add-Content -Path $env:GITHUB_ENV");
    expect(hydrateWindowsPnpm.run).not.toContain("Add-Content -Path $env:GITHUB_PATH");
    expect(hydrateWindowsPnpm.run).toContain("corepack enable --install-directory $env:PNPM_HOME");
    expect(hydrateWindowsPnpm.run).toContain("pnpm @installArgs");
    expect(hydrateWindowsPnpm.run).toContain(
      '$corepackShimDir = Join-Path $nodeBin "node_modules\\corepack\\shims"',
    );
    const hydrateWindowsFetch = workflowStep(hydrateWindowsDaemon, "Fetch main ref");
    expect(hydrateWindowsFetch.shell).toBe("powershell");
    expect(hydrateWindowsFetch.run).toContain(
      "$fetchInfo = New-Object System.Diagnostics.ProcessStartInfo",
    );
    expect(hydrateWindowsFetch.run).toContain('$fetchInfo.FileName = "git"');
    expect(hydrateWindowsFetch.run).toContain("$fetchInfo.WorkingDirectory = $repo");
    expect(hydrateWindowsFetch.run).toContain("$fetchInfo.UseShellExecute = $false");
    expect(hydrateWindowsFetch.run).not.toContain("$fetchInfo.RedirectStandardOutput = $true");
    expect(hydrateWindowsFetch.run).not.toContain("$fetchInfo.RedirectStandardError = $true");
    expect(hydrateWindowsFetch.run).toContain("$fetch = New-Object System.Diagnostics.Process");
    expect(hydrateWindowsFetch.run).toContain("$fetch.StartInfo = $fetchInfo");
    expect(hydrateWindowsFetch.run).toContain("$fetch.WaitForExit(30000)");
    expect(hydrateWindowsFetch.run).toContain("$fetch.Kill()");
    expect(hydrateWindowsFetch.run).not.toContain("StandardOutput.ReadToEnd()");
    expect(hydrateWindowsFetch.run).not.toContain("StandardError.ReadToEnd()");
    expect(hydrateWindowsFetch.run).toContain("git fetch failed with exit code $($fetch.ExitCode)");
    expect(hydrateWindowsFetch.run).toContain(
      "--no-tags --no-progress --prune --no-recurse-submodules --depth=50",
    );
    expect(hydrateWindowsFetch.run).toContain('"+refs/heads/main:refs/remotes/origin/main"');
    expect(workflowStep(hydrateWindowsDaemon, "Mark Crabbox ready").shell).toBe("powershell");
    expect(workflowStep(hydrateWindowsDaemon, "Mark Crabbox ready").run).toContain('"NODE_BIN"');
    expect(workflowStep(hydrateWindowsDaemon, "Mark Crabbox ready").run).toContain('"PNPM_HOME"');
    expect(workflowStep(hydrateWindowsDaemon, "Mark Crabbox ready").run).toContain('"PATH"');
    expect(workflowText).toContain("OPENCLAW_CRABBOX_HYDRATE_DOWNLOAD_TIMEOUT_SECONDS:-300");
    expect(workflowText).toContain("OPENCLAW_CRABBOX_HYDRATE_DOWNLOAD_RETRIES:-3");
    expect(workflowText).toContain("--retry-all-errors");
    expect(workflowText).not.toContain("curl -fsSL https://get.docker.com | sudo sh");

    expect(hydrateGithub.if).toBe("${{ inputs.crabbox_job == 'hydrate-github' }}");
    expect(workflowStep(hydrateGithub, "Setup Node environment").uses).toBe(
      "./.github/actions/setup-node-env",
    );
    expect(workflowStep(hydrateGithub, "Setup Node environment").env?.PNPM_HOME).toBe(
      "${{ runner.temp }}/pnpm-home",
    );
    const hydrateGithubCrabboxShell = workflowStep(hydrateGithub, "Prepare Crabbox shell").run;
    expect(hydrateGithubCrabboxShell).toContain("link_node_tool()");
    expect(hydrateGithubCrabboxShell).toContain('readlink -f "$source"');
    expect(hydrateGithubCrabboxShell).toContain('readlink -f "$target"');
    expect(hydrateGithubCrabboxShell).toContain("link_node_tool corepack");
    expect(workflowStep(hydrateGithub, "Hydrate provider env helper").env?.FACTORY_API_KEY).toBe(
      "${{ secrets.FACTORY_API_KEY }}",
    );
  });

  it("defaults Crabbox proof to Blacksmith while keeping direct jobs on Azure", () => {
    const crabboxConfig = parse(readFileSync(CRABBOX_CONFIG, "utf8")) as {
      aws?: { region?: string };
      capacity?: {
        availabilityZones?: string[];
        fallback?: string;
        market?: string;
        regions?: string[];
      };
      jobs?: {
        changed?: {
          command?: string;
          market?: string;
          provider?: string;
          shell?: boolean;
          type?: string;
        };
        prewarm?: { market?: string; provider?: string; type?: string };
      };
      provider?: string;
      ssh?: { port?: string; user?: string };
    };

    expect(crabboxConfig.provider).toBe("blacksmith-testbox");
    expect(crabboxConfig.capacity?.market).toBe("on-demand");
    expect(crabboxConfig.capacity?.fallback).toBeUndefined();
    expect(crabboxConfig.capacity?.regions).toBeUndefined();
    expect(crabboxConfig.capacity?.availabilityZones).toBeUndefined();
    expect(crabboxConfig.aws?.region).toBe("eu-west-1");
    expect(crabboxConfig.jobs?.prewarm?.market).toBe("on-demand");
    expect(crabboxConfig.jobs?.prewarm?.provider).toBe("azure");
    expect(crabboxConfig.jobs?.prewarm?.type).toBe("Standard_D4ads_v6");
    expect(crabboxConfig.jobs?.changed?.market).toBe("on-demand");
    expect(crabboxConfig.jobs?.changed?.provider).toBe("azure");
    expect(crabboxConfig.jobs?.changed?.type).toBe("Standard_D4ads_v6");
    expect(crabboxConfig.jobs?.changed?.shell).toBe(true);
    expect(crabboxConfig.jobs?.changed?.command).toContain("set -euo pipefail");
    expect(crabboxConfig.jobs?.changed?.command).toContain("git init -q");
    expect(crabboxConfig.jobs?.changed?.command).toContain(
      "commit -q --no-gpg-sign -m remote-check-tree",
    );
    expect(crabboxConfig.jobs?.changed?.command).toContain("env CI=1 corepack pnpm check --timed");
    expect(crabboxConfig.ssh?.user).toBe("crabbox");
    expect(crabboxConfig.ssh?.port).toBe("22");
  });

  it("resolves candidate package sources before reusing Docker E2E lanes", () => {
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");

    expect(workflow).toContain("name: Package Acceptance");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("workflow_ref:");
    expect(workflow).toContain("package_ref:");
    expect(workflow).toContain("source:");
    expect(workflow).toContain("- npm");
    expect(workflow).toContain("- ref");
    expect(workflow).toContain("- url");
    expect(workflow).toContain("- trusted-url");
    expect(workflow).toContain("- artifact");
    expect(workflow).toContain("trusted_source_id:");
    expect(workflow).toContain("TRUSTED_SOURCE_ID: ${{ inputs.trusted_source_id }}");
    expect(workflow).toContain('--trusted-source-id "$TRUSTED_SOURCE_ID"');
    expect(workflow).toContain("scripts/resolve-openclaw-package-candidate.mjs");
    expect(workflow).toContain('--package-ref "$PACKAGE_REF"');
    expect(workflow).toContain("artifact-ids: ${{ inputs.artifact_id }}");
    expect(workflow).toContain("actions/artifacts/${ARTIFACT_ID}");
    expect(workflow).toContain("name: ${{ env.PACKAGE_ARTIFACT_NAME }}");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain(
      "uses: ./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
    );
    expect(workflow).toContain(
      "ref: ${{ needs.resolve_package.outputs.package_source_sha || inputs.workflow_ref }}",
    );
    expect(workflow).toContain(
      "package_artifact_name: ${{ needs.resolve_package.outputs.package_artifact_name }}",
    );
    expect(workflow).toContain("package_integrity:");
    expect(workflow).toContain("name: Package integrity");
    expect(workflow).toContain('node scripts/check-openclaw-package-tarball.mjs "$package"');
    expect(workflow).toContain('[[ "$actual_sha256" == "$EXPECTED_PACKAGE_SHA256" ]]');
    expect(workflow).toContain("needs: [resolve_package, package_integrity]");
    expect(workflow).toContain("package_integrity=${PACKAGE_INTEGRITY_RESULT}");
  });

  it("keeps ref packaging independent of workflow-checkout dependencies", () => {
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");
    const resolveJob = workflow.slice(
      workflow.indexOf("  resolve_package:"),
      workflow.indexOf("  package_integrity:"),
    );

    expect(resolveJob).toContain("scripts/resolve-openclaw-package-candidate.mjs");
    expect(resolveJob).not.toContain("pnpm install");
  });

  it("offers bounded product profiles and can run Telegram against the resolved artifact", () => {
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");
    const npmTelegramWorkflow = readFileSync(NPM_TELEGRAM_WORKFLOW, "utf8");

    expect(workflow).toContain("suite_profile:");
    expect(workflow).toContain("published_upgrade_survivor_baseline:");
    expect(workflow).toContain("published_upgrade_survivor_baselines:");
    expect(workflow).toContain("last-stable-4");
    expect(workflow).toContain("all-since-2026.4.23");
    expect(workflow).toContain("published_upgrade_survivor_scenarios:");
    expect(workflow).toContain("scripts/resolve-upgrade-survivor-baselines.mjs");
    expect(workflow).toContain("--history-count 6");
    expect(workflow).toContain("--include-version 2026.4.23");
    expect(workflow).toContain("--pre-date 2026-03-15T00:00:00Z");
    expect(workflow).toContain('"last-stable-"');
    expect(workflow).toContain('"all-since-"');
    expect(workflow).toContain("npm-onboard-channel-agent gateway-network config-reload");
    expect(workflow).toContain("npm-onboard-channel-agent doctor-switch");
    expect(workflow).toContain("update-channel-switch skill-install update-corrupt-plugin");
    expect(workflow).toContain("update-corrupt-plugin upgrade-survivor");
    expect(workflow).toContain("published-upgrade-survivor");
    expect(workflow).toContain(
      "published-upgrade-survivor root-managed-vps-upgrade update-restart-auth",
    );
    expect(workflow).toContain("plugins-offline plugin-update");
    expect(workflow).toContain("include_release_path_suites=true");
    expect(workflow).not.toContain("telegram_mode requires source=npm");
    expect(workflow).toContain("uses: ./.github/workflows/npm-telegram-beta-e2e.yml");
    expect(workflow).toContain(
      "package_artifact_name: ${{ needs.resolve_package.outputs.package_artifact_name }}",
    );
    expect(workflow).toContain(
      "package_artifact_digest: ${{ needs.resolve_package.outputs.package_artifact_digest }}",
    );
    expect(workflow).toContain(
      "package_artifact_id: ${{ needs.resolve_package.outputs.package_artifact_id }}",
    );
    expect(workflow).toContain(
      "package_artifact_run_attempt: ${{ needs.resolve_package.outputs.package_artifact_run_attempt }}",
    );
    expect(workflow).toContain(
      "package_artifact_run_id: ${{ needs.resolve_package.outputs.package_artifact_run_id }}",
    );
    expect(workflow).toContain(
      "package_file_name: ${{ needs.resolve_package.outputs.package_file_name }}",
    );
    expect(workflow).toContain(
      "package_sha256: ${{ needs.resolve_package.outputs.package_sha256 }}",
    );
    expect(workflow).toContain(
      "package_source_sha: ${{ needs.resolve_package.outputs.package_source_sha }}",
    );
    expect(workflow).toContain(
      "package_version: ${{ needs.resolve_package.outputs.package_version }}",
    );
    expect(workflow).toContain("telegram_scenarios:");
    expect(workflow).toContain("scenario: ${{ inputs.telegram_scenarios }}");
    expect(workflow).toContain(
      "package_label: openclaw@${{ needs.resolve_package.outputs.package_version }}",
    );
    expect(npmTelegramWorkflow).toContain("package_artifact_run_id:");
    expect(npmTelegramWorkflow).toContain("Download package-under-test artifact from release run");
    expect(npmTelegramWorkflow).toContain("run-id: ${{ inputs.package_artifact_run_id }}");
    expect(npmTelegramWorkflow).toContain("github-token: ${{ github.token }}");
    expect(workflow).toContain(
      "package_source_sha: ${{ steps.resolve.outputs.package_source_sha }}",
    );
    expect(workflow).toContain(
      "harness_ref: ${{ needs.resolve_package.outputs.package_source_sha || inputs.workflow_ref }}",
    );
    expect(workflow).toContain('fallback_version="$(npm view openclaw@latest version)"');
    expect(workflow).toContain('echo "baseline=$fallback_baseline" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "published_upgrade_survivor_baseline: ${{ needs.resolve_package.outputs.published_upgrade_survivor_baseline }}",
    );
    expect(workflow).toContain(
      "published_upgrade_survivor_baselines: ${{ needs.resolve_package.outputs.published_upgrade_survivor_baselines }}",
    );
    expect(workflow).toContain(
      "published_upgrade_survivor_scenarios: ${{ needs.resolve_package.outputs.published_upgrade_survivor_scenarios }}",
    );
    expect(workflow).toContain("Published upgrade survivor baseline:");
    expect(workflow).toContain("Published upgrade survivor baselines:");
    expect(workflow).toContain("Published upgrade survivor scenarios:");
  });

  it("requires full release child workflows to run at the parent workflow SHA", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const releaseChecksWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const performanceJob = workflow.slice(
      workflow.indexOf("  performance:\n"),
      workflow.indexOf("\n  summary:"),
    );

    expect(workflow).toContain("TARGET_SHA: ${{ needs.resolve_target.outputs.sha }}");
    expect(workflow).toContain("CHILD_WORKFLOW_REF: ${{ github.ref_name }}");
    expect(workflow).toContain("PARENT_WORKFLOW_SHA: ${{ github.sha }}");
    expect(workflow).toContain("release_package_spec:");
    expect(workflow).toContain('args+=(-f release_package_spec="$RELEASE_PACKAGE_SPEC")');
    expect(workflow).toContain("package_acceptance_package_spec:");
    expect(workflow).toContain(
      'args+=(-f package_acceptance_package_spec="$PACKAGE_ACCEPTANCE_PACKAGE_SPEC")',
    );
    expect(workflow).toContain("codex_plugin_spec:");
    expect(workflow).toContain('args+=(-f codex_plugin_spec="$CODEX_PLUGIN_SPEC")');
    expect(releaseChecksWorkflow).toContain(
      'codex_plugin_spec="npm:@openclaw/codex@${BASH_REMATCH[1]}"',
    );
    expect(releaseChecksWorkflow).toContain(
      "codex_plugin_spec: ${{ needs.resolve_target.outputs.codex_plugin_spec }}",
    );
    expect(workflow).toContain("--json status,conclusion,url,attempt,headSha,jobs");
    expect(workflow).toContain(
      'gh_with_retry api "repos/${GITHUB_REPOSITORY}/commits/${encoded_workflow_ref}" --jq .sha',
    );
    expect(workflow).toContain(
      "Child workflow ref ${CHILD_WORKFLOW_REF} moved to ${current_workflow_sha}, expected ${PARENT_WORKFLOW_SHA}; refusing dispatch.",
    );
    expect(workflow).toContain('if [[ "$head_sha" != "$PARENT_WORKFLOW_SHA" ]]; then');
    expect(workflow).toContain('gh workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@" 2>&1');
    expect(performanceJob).toContain(
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(performanceJob).toContain('-f dispatch_id="$dispatch_id"');
    expect(performanceJob).toContain(
      'DISPATCH_RUN_NAME="$dispatch_run_name" CHILD_WORKFLOW_REF="$CHILD_WORKFLOW_REF"',
    );
    expect(performanceJob).toContain(".display_title == env.DISPATCH_RUN_NAME");
    expect(performanceJob).toContain("Could not find exact dispatched run ${dispatch_run_name}");
    expect(performanceJob).not.toContain("BEFORE_IDS=");
    expect(performanceJob).not.toContain(
      "did not return an Actions run URL; refusing to guess from recent workflow_dispatch runs",
    );
    expect(workflow).toContain(
      "child run used workflow SHA ${head_sha}, expected parent workflow SHA ${PARENT_WORKFLOW_SHA}",
    );
    expect(workflow).toContain(
      "Use the SHA-pinned release helper when a moving branch cannot stay fixed",
    );
    expect(workflow).toContain("| Child | Result | Minutes | Head SHA | Run |");
    expect(releaseChecksWorkflow).toContain("refs/heads/release-ci/[0-9a-f]{12}-[0-9]+");
    expect(releaseChecksWorkflow).toContain(
      "source: ${{ (needs.resolve_target.outputs.package_acceptance_package_spec != '' || needs.resolve_target.outputs.release_package_spec != '') && 'npm' || 'artifact' }}",
    );
    expect(releaseChecksWorkflow).toContain(
      "package_spec: ${{ needs.resolve_target.outputs.package_acceptance_package_spec || needs.resolve_target.outputs.release_package_spec || 'openclaw@beta' }}",
    );
  });

  it("keeps performance evidence advisory for beta releases", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const performanceStep = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "performance"),
      "Dispatch and monitor OpenClaw Performance",
    );
    const summaryStep = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary"),
      "Verify child workflow results",
    );

    expect(performanceStep.env?.RELEASE_PROFILE).toBe("${{ inputs.release_profile }}");
    expectTextToIncludeAll(performanceStep.run, [
      "fail_on_regression=true",
      'if [[ "$RELEASE_PROFILE" == "beta" ]]',
      "fail_on_regression=false",
      '-f fail_on_regression="$fail_on_regression"',
      "Release impact: advisory",
      "advisory for beta",
    ]);
    expect(summaryStep.env?.RELEASE_PROFILE).toBe("${{ inputs.release_profile }}");
    expectTextToIncludeAll(summaryStep.run, [
      '[[ "$RELEASE_PROFILE" == "beta" ]] && performance_advisory=1',
      'check_child "product_performance" "$PERFORMANCE_RUN_ID" "$performance_required" "$performance_advisory"',
    ]);
    expect(workflow).toContain('performanceBlocking: ($releaseProfile != "beta")');
    expect(workflow).toContain('blocking: ($releaseProfile != "beta")');
  });

  it("keeps beta performance advisory at the publish gate", () => {
    const validationStep = workflowStep(
      workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target"),
      "Validate full release validation manifest",
    );
    const npmValidationStep = workflowStep(
      workflowJob(".github/workflows/openclaw-npm-release.yml", "publish_openclaw_npm"),
      "Verify full release validation target",
    );

    expectTextToIncludeAll(validationStep.run, [
      'if [[ "$release_profile" != "beta" && "$performance_blocking" != "true" ]]',
      "Full release validation manifest does not record blocking product performance evidence.",
    ]);
    expectTextToIncludeAll(npmValidationStep.run, [
      'if [[ "$RELEASE_NPM_DIST_TAG" != "beta" && "$PERFORMANCE_BLOCKING" != "true" ]]',
      "Full release validation manifest does not record blocking product performance evidence.",
    ]);
  });

  it("keeps child-job fail-fast polling best-effort", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    expect(workflow.match(/continuing with authoritative workflow conclusion\./gu)).toHaveLength(3);
  });

  it("adopts exact full-release child runs without retrying ambiguous dispatch posts", () => {
    const childDispatches = [
      ["normal_ci", "Dispatch and monitor CI"],
      ["plugin_prerelease", "Dispatch and monitor plugin prerelease"],
      ["release_checks", "Dispatch and monitor release checks"],
      ["npm_telegram", "Dispatch and monitor npm Telegram E2E"],
      ["performance", "Dispatch and monitor OpenClaw Performance"],
    ] as const;
    const dispatchScripts = childDispatches.map(([jobName, stepName]) => {
      const job = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, jobName);
      return workflowStep(job, stepName).run ?? "";
    });

    for (const script of dispatchScripts) {
      expect(script.match(/gh workflow run/gu)).toHaveLength(1);
      expect(script).not.toContain("gh_with_retry workflow run");
      expectTextToIncludeAll(script, [
        "A failed dispatch POST can still create a run. Never retry it",
        'encoded_workflow_ref="$(jq -rn --arg value "$CHILD_WORKFLOW_REF"',
        'gh_with_retry api "repos/${GITHUB_REPOSITORY}/commits/${encoded_workflow_ref}" --jq .sha',
        '"$current_workflow_sha" != "$PARENT_WORKFLOW_SHA"',
        "refusing dispatch.",
        "set +e",
        "dispatch_status=$?",
        'if [[ "$dispatch_status" -ne 0 && ! "$dispatch_output" =~ $GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN ]]',
        "dispatch failed with non-ambiguous status ${dispatch_status}; refusing adoption polling.",
        'DISPATCH_RUN_NAME="$dispatch_run_name" CHILD_WORKFLOW_REF="$CHILD_WORKFLOW_REF"',
        ".display_title == env.DISPATCH_RUN_NAME and .head_branch == env.CHILD_WORKFLOW_REF",
        "Multiple runs matched ${dispatch_run_name}; refusing to guess.",
        "The dispatch was not retried to avoid creating a duplicate child.",
        "adopted exact run ${run_id}",
      ]);
      expect(script.indexOf("dispatch failed with non-ambiguous status")).toBeLessThan(
        script.indexOf('run_id=""'),
      );
    }

    const parsedWorkflow = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const transientPattern = parsedWorkflow.env?.GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN;
    expect(transientPattern).toBeDefined();
    const transientError = new RegExp(transientPattern ?? "", "u");
    for (const message of [
      "could not create workflow dispatch event: HTTP 500: Failed to run workflow dispatch",
      "gh: HTTP 502",
      "500 Internal Server Error",
      "invalid character '<' looking for beginning of value",
      "error connecting to api.github.com",
      "context deadline exceeded",
      "read: connection reset by peer",
      "connect: connection refused",
      "net/http: TLS handshake timeout",
      "read: i/o timeout",
      "network is unreachable",
      "unexpected EOF",
      'Post "https://api.github.com/repos/openclaw/openclaw/actions/workflows/ci.yml/dispatches": EOF',
      "EOF",
      "ETIMEDOUT",
      "ECONNRESET",
      "EAI_AGAIN",
    ]) {
      expect(transientError.test(message), message).toBe(true);
    }
    for (const message of [
      "HTTP 400: Bad Request",
      "HTTP 401: Bad credentials",
      "HTTP 403: Resource not accessible by integration",
      "HTTP 404: workflow not found",
      "HTTP 422: Validation Failed",
      "HTTP 429: too many requests",
      "unknown flag --field",
      "EOFError while parsing local input",
    ]) {
      expect(transientError.test(message), message).toBe(false);
    }

    const summaryScript =
      workflowStep(
        workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary"),
        "Verify child workflow results",
      ).run ?? "";
    for (const script of [...dispatchScripts, summaryScript]) {
      expect(script.match(/gh_with_retry\(\)/gu)).toHaveLength(1);
      expectTextToIncludeAll(script, [
        '"$output" == *"HTTP 429"*',
        '"$output" == *"abuse detection"*',
        '"$output" =~ $GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN',
        'return "$status"',
      ]);
    }

    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const retryCalls = workflow.split("\n").filter((line) => line.includes("gh_with_retry "));
    expect(retryCalls).toHaveLength(37);
    for (const call of retryCalls) {
      expect(call).toMatch(/gh_with_retry (api|run view)/u);
    }
    expect(workflow).not.toMatch(/gh_with_retry (workflow run|run cancel)/u);
    expectTextToIncludeAll(workflow, [
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-ci"',
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-plugin-prerelease"',
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-release-checks"',
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-npm-telegram"',
      'args+=(-f dispatch_id="$dispatch_id")',
    ]);
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "format('CI {0}', inputs.dispatch_id)",
    );
    expect(readFileSync(".github/workflows/plugin-prerelease.yml", "utf8")).toContain(
      "format('Plugin Prerelease {0}', inputs.dispatch_id)",
    );
    expect(readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8")).toContain(
      "format('OpenClaw Release Checks {0}', inputs.dispatch_id)",
    );
    expect(readFileSync(NPM_TELEGRAM_WORKFLOW, "utf8")).toContain(
      "format('NPM Telegram Beta E2E {0}', inputs.dispatch_id)",
    );
  });

  it("keeps exhaustive update migration as a separate manual package gate", () => {
    const workflow = readFileSync(UPDATE_MIGRATION_WORKFLOW, "utf8");
    const packageWorkflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");

    expect(workflow).toContain("name: Update Migration");
    expect(workflow).toContain("uses: ./.github/workflows/package-acceptance.yml");
    expect(workflow).toContain("source: ref");
    expect(workflow).toContain("suite_profile: custom");
    expect(workflow).toContain("docker_lanes: update-migration");
    expect(workflow).toContain("default: all-since-2026.4.23");
    expect(workflow).toContain("default: plugin-deps-cleanup");
    expect(workflow).toContain("telegram_mode: none");
    expect(workflow).toContain("secrets: inherit");
    expect(packageWorkflow).toContain("published-upgrade-survivor/update-migration");
  });
});

describe("package artifact reuse", () => {
  it("binds package acceptance input artifacts to the complete producer tuple", () => {
    const resolvePackage = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package");
    expect(
      workflowStep(resolvePackage, "Checkout package workflow ref").with?.["persist-credentials"],
    ).toBe(false);
    const identity = workflowStep(resolvePackage, "Validate package artifact input identity");
    expect(identity.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ inputs.artifact_digest }}",
      ARTIFACT_ID: "${{ inputs.artifact_id }}",
      ARTIFACT_NAME: "${{ inputs.artifact_name }}",
      ARTIFACT_RUN_ATTEMPT: "${{ inputs.artifact_run_attempt }}",
      ARTIFACT_RUN_ID: "${{ inputs.artifact_run_id }}",
      EXPECTED_PACKAGE_FILE_NAME: "${{ inputs.package_file_name }}",
      EXPECTED_PACKAGE_SHA256: "${{ inputs.package_sha256 }}",
      EXPECTED_PACKAGE_SOURCE_SHA: "${{ inputs.package_source_sha }}",
      EXPECTED_PACKAGE_VERSION: "${{ inputs.package_version }}",
    });
    expectTextToIncludeAll(identity.run, [
      "source=artifact requires the complete immutable artifact and package identity tuple.",
      '[[ "$ARTIFACT_NAME" == *"-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}" ]]',
      '--arg digest "sha256:${ARTIFACT_DIGEST}"',
      "actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}",
    ]);
    expect(workflowStep(resolvePackage, "Download package artifact input").with).toMatchObject({
      "artifact-ids": "${{ inputs.artifact_id }}",
      "github-token": "${{ github.token }}",
      "run-id": "${{ inputs.artifact_run_id }}",
    });
    const resolve = workflowStep(resolvePackage, "Resolve package candidate");
    expect(resolve.env).toMatchObject({
      PACKAGE_FILE_NAME: "${{ inputs.package_file_name }}",
      PACKAGE_SHA256: "${{ inputs.package_sha256 }}",
      PACKAGE_SOURCE_SHA: "${{ inputs.package_source_sha }}",
      PACKAGE_VERSION: "${{ inputs.package_version }}",
    });
    expectTextToIncludeAll(resolve.run, [
      'artifact_tarball="${artifact_dir}/${PACKAGE_FILE_NAME}"',
      "Selected artifact package SHA-256 differs from package_sha256.",
      "Resolved package identity differs from the declared immutable tuple.",
    ]);

    const packageIntegrity = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "package_integrity");
    expect(
      workflowStep(packageIntegrity, "Download package-under-test artifact").with,
    ).toMatchObject({
      "artifact-ids": "${{ needs.resolve_package.outputs.package_artifact_id }}",
      "github-token": "${{ github.token }}",
      "run-id": "${{ needs.resolve_package.outputs.package_artifact_run_id }}",
    });
  });

  it("lets reusable Docker E2E consume an already resolved package artifact", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const parsedWorkflow = parse(workflow) as {
      on?: { workflow_call?: { inputs?: Record<string, unknown> } };
    };
    const packageJson = readFileSync(PACKAGE_JSON, "utf8");
    const scheduler = readFileSync("scripts/test-docker-all.mjs", "utf8");
    const publishedUpgradeSurvivor = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");

    expect(workflow).toContain("package_artifact_name:");
    expect(workflow).toContain("package_artifact_digest:");
    expect(workflow).toContain("package_artifact_id:");
    expect(workflow).toContain("package_artifact_run_attempt:");
    expect(workflow).toContain("package_artifact_run_id:");
    expect(workflow).toContain("package_file_name:");
    expect(workflow).toContain("package_source_sha:");
    expect(workflow).toContain("package_sha256:");
    expect(workflow).toContain("package_version:");
    expect(workflow).toContain("published_upgrade_survivor_baseline:");
    expect(workflow).toContain("published_upgrade_survivor_baselines:");
    expect(workflow).toContain("published_upgrade_survivor_scenarios:");
    expect(parsedWorkflow.on?.workflow_call?.inputs).toHaveProperty(
      "allow_frozen_target_scenario_omissions",
    );
    expect(workflow).toContain("docker_e2e_bare_image:");
    expect(workflow).toContain("docker_e2e_functional_image:");
    expect(workflow).toContain("OPENCLAW_DOCKER_E2E_SELECTED_SHA:");
    expect(workflow).toContain(
      "OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: ${{ inputs.published_upgrade_survivor_baseline }}",
    );
    expect(workflow).toContain(
      "OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: ${{ matrix.group.published_upgrade_survivor_baselines || inputs.published_upgrade_survivor_baselines }}",
    );
    expect(workflow).toContain(
      "OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: ${{ inputs.published_upgrade_survivor_scenarios }}",
    );
    expect(workflow).toContain("OPENCLAW_UPGRADE_SURVIVOR_TARGET_ROOT: ${{ github.workspace }}");
    expect(workflow).toContain(
      "OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: ${{ inputs.allow_frozen_target_scenario_omissions && '1' || '0' }}",
    );
    expect(workflow).toContain("Download current-run OpenClaw Docker E2E package");
    expect(workflow).toContain("Download previous-run OpenClaw Docker E2E package");
    expect(workflow).toContain("inputs.package_artifact_id != ''");
    expect(workflow).toContain(
      'bare_image="${PROVIDED_BARE_IMAGE:-ghcr.io/${repository}-docker-e2e-bare:${image_tag}}"',
    );
    expect(workflow).toContain(
      'functional_image="${PROVIDED_FUNCTIONAL_IMAGE:-ghcr.io/${repository}-docker-e2e-functional:${image_tag}}"',
    );
    expect(workflow).toContain("artifact-ids: ${{ inputs.package_artifact_id }}");
    expect(workflow).toContain(
      '[[ "$ARTIFACT_NAME" == *"-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}" ]]',
    );
    expect(workflow).toContain('--arg digest "sha256:${ARTIFACT_DIGEST}"');
    expect(workflow).toContain("actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}");
    expect(workflow).not.toContain("uses: ./.github/actions/docker-e2e-plan");
    expect(workflow).toContain("Checkout trusted release harness");
    expect(workflow).toContain("OPENCLAW_DOCKER_E2E_REPO_ROOT:");
    expect(workflow).toContain("node .release-harness/scripts/test-docker-all.mjs --plan-json");
    expect(workflow).toContain("node .release-harness/scripts/docker-e2e.mjs github-outputs");
    expect(workflow).toContain("bash .release-harness/scripts/ci-docker-pull-retry.sh");
    const prepareDockerImage = workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image");
    expect(workflowStep(prepareDockerImage, "Plan Docker E2E images").env).toEqual({
      INCLUDE_OPENWEBUI: "${{ inputs.include_openwebui }}",
      INCLUDE_RELEASE_PATH_SUITES: "${{ inputs.include_release_path_suites }}",
      LANES: "${{ inputs.docker_lanes }}",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "${{ inputs.published_upgrade_survivor_baseline }}",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS:
        "${{ inputs.published_upgrade_survivor_baselines }}",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "${{ inputs.published_upgrade_survivor_scenarios }}",
      PREPARE_ONLY: "${{ inputs.prepare_only }}",
      RELEASE_TEST_PROFILE: "${{ inputs.release_test_profile }}",
    });
    expect(workflow).toContain("plan_docker_lane_groups:");
    expect(workflow).toContain("targeted_docker_lane_group_size:");
    expect(workflow).toContain("scripts/plan-targeted-docker-lane-groups.mjs");
    expect(workflow).toContain(
      "OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: ${{ inputs.published_upgrade_survivor_baselines }}",
    );
    expect(workflow).toContain("Docker E2E targeted lanes (${{ matrix.group.label }})");
    expect(workflow).toContain("LANES: ${{ matrix.group.docker_lanes }}");
    expect(workflow).toContain("GROUP_LABEL: ${{ matrix.group.label }}");
    expect(workflow).toContain("DOCKER_E2E_LANES: ${{ matrix.group.docker_lanes }}");
    expect(workflow).toContain("name: docker-e2e-${{ steps.plan.outputs.artifact_suffix }}");
    expect(scheduler).toContain(
      "published_upgrade_survivor_baseline=${shellQuote(env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC)}",
    );
    expect(scheduler).toContain(
      "published_upgrade_survivor_baselines=${shellQuote(env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS)}",
    );
    expect(scheduler).toContain(
      '["OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC", baseEnv.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC]',
    );
    expect(scheduler).toContain('["OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS",');
    expect(scheduler).toContain('["OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS",');
    expect(packageJson).toContain("OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1");
    expect(packageJson).toContain("test:docker:update-restart-auth");
    expect(packageJson).toContain("OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE=auto-auth");
    expect(publishedUpgradeSurvivor).toContain("validate_baseline_package_spec");
    expect(publishedUpgradeSurvivor).toContain("OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE");
    expect(publishedUpgradeSurvivor).toContain('local shim_dir="$npm_config_prefix/bin"');
    expect(publishedUpgradeSurvivor).toContain("seed_update_restart_probe_device_auth");
    expect(publishedUpgradeSurvivor).toContain("upgrade survivor restart probe");
    expect(publishedUpgradeSurvivor).toContain("write_update_restart_service_secretref_env");
    expect(publishedUpgradeSurvivor).toContain("GATEWAY_AUTH_TOKEN_REF=%s");
    expect(publishedUpgradeSurvivor).toContain(
      "env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw",
    );
    expect(publishedUpgradeSurvivor).toContain("phase prepare-update-restart-probe");
    expect(publishedUpgradeSurvivor).toContain("openclaw@(alpha|beta|latest|");
    expect(publishedUpgradeSurvivor).toContain("plugin_deps_cleanup_plugin_dirs");
    expect(publishedUpgradeSurvivor).toContain('"$(package_root)/extensions/$plugin"');
    expect(publishedUpgradeSurvivor).toContain("probe_gateway_endpoint");
    expect(publishedUpgradeSurvivor).toContain(
      "assert_legacy_plugin_dependency_debris_before_doctor",
    );
    expect(publishedUpgradeSurvivor.indexOf("phase seed-source-only-plugin-shadow")).toBeLessThan(
      publishedUpgradeSurvivor.indexOf("phase assert-baseline"),
    );
    expect(publishedUpgradeSurvivor).toContain('"id": "opik-openclaw"');
    expect(publishedUpgradeSurvivor).toContain('"configSchema": {');
    expect(publishedUpgradeSurvivor).toContain(
      "Legacy plugin dependency debris was already removed before doctor",
    );
    expect(
      publishedUpgradeSurvivor.indexOf('validate_baseline_package_spec "$baseline_spec"'),
    ).toBeLessThan(
      publishedUpgradeSurvivor.indexOf('npm install -g --prefix "$npm_config_prefix"'),
    );
  });

  it("bounds shared Docker image pulls so package acceptance cannot stall forever", () => {
    const pullHelper = readFileSync("scripts/ci-docker-pull-retry.sh", "utf8");
    const dockerE2ePlanAction = readFileSync(DOCKER_E2E_PLAN_ACTION, "utf8");

    expect(pullHelper).toContain("OPENCLAW_DOCKER_PULL_ATTEMPTS");
    expect(pullHelper).toContain("OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS");
    expect(pullHelper).toContain('timeout_seconds="${OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS:-180}"');
    expect(pullHelper).toContain(
      'retry_delay_seconds="${OPENCLAW_DOCKER_PULL_RETRY_DELAY_SECONDS:-5}"',
    );
    expect(pullHelper).toContain('source "$SCRIPT_DIR/lib/host-timeout.sh"');
    expect(pullHelper).toContain("openclaw_host_timeout_bin");
    expect(pullHelper).toContain('"$timeout_bin" --kill-after=1s 1s true');
    expect(pullHelper).toContain(
      '"$timeout_bin" --kill-after=30s "${timeout_seconds}s" docker pull "$image"',
    );
    expect(pullHelper).toContain('"$timeout_bin" "${timeout_seconds}s" docker pull "$image"');
    expect(pullHelper).toContain(
      "timeout or gtimeout command not found; cannot bound Docker pull after ${timeout_seconds}s",
    );
    expect(dockerE2ePlanAction.match(/bash scripts\/ci-docker-pull-retry\.sh/g)?.length).toBe(2);
    expect(dockerE2ePlanAction).not.toContain('docker pull "${OPENCLAW_DOCKER_E2E_');
  });

  it("reuses a content-addressed bare image for prepared E2E images", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");

    expect(workflow).toContain("bare_context_sha=");
    expect(workflow).toContain("-docker-e2e-bare:base-${bare_context_sha:0:32}");
    expect(workflow).toContain('docker manifest inspect "$CACHE_IMAGE_REF"');
    expect(workflow).toContain('cache=(--cache-from "$CACHE_IMAGE_REF")');
    expect(workflow).not.toContain('docker tag "$CACHE_IMAGE_REF" "$IMAGE_REF"');
    expect(workflow).toContain(
      "Shared release candidate preparation requires both Docker image variants.",
    );
    expect(workflow).toContain(
      "inputs.shared_image_artifact_id != '' && '1' || steps.plan.outputs.needs_bare_image",
    );
    expect(workflow).toContain("env DOCKER_BUILDKIT=1 docker build");
    expect(workflow).toContain(
      'if bash .release-harness/scripts/ci-docker-pull-retry.sh "$CACHE_IMAGE_REF"; then',
    );
    expect(workflow).toContain("Bare image cache pull failed; continuing with a cold build.");
    expect(workflow).toContain("--build-context openclaw_package=.artifacts/docker-e2e-package");
    expect(workflow).toContain('cache=(--cache-from "$BARE_IMAGE_REF")');
    expect(workflow).not.toContain('docker push "$CACHE_IMAGE_REF"');
    expect(workflow).toContain("uses: useblacksmith/setup-docker-builder@");
    expect(workflow).toContain("uses: useblacksmith/build-push-action@");
    expect(workflow).not.toContain("cache-from: type=gha,scope=docker-e2e");
    expect(workflow).not.toContain("cache-to: type=gha,mode=max,scope=docker-e2e");
  });

  it("prepares one immutable candidate for release validation children", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const prepare = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "prepare_release_candidate");
    const pluginDispatch = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "plugin_prerelease"),
      "Dispatch and monitor plugin prerelease",
    );
    const releaseDispatch = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "release_checks"),
      "Dispatch and monitor release checks",
    );

    expect(prepare.uses).toBe("./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
    expect(prepare.with).toMatchObject({
      prepare_only: true,
      shared_image_policy: "no-push-artifact",
    });
    expect(pluginDispatch.run).toContain(
      'args+=(-f candidate_artifact_json="$CANDIDATE_ARTIFACT_JSON")',
    );
    expect(releaseDispatch.run).toContain(
      'args+=(-f candidate_artifact_json="$CANDIDATE_ARTIFACT_JSON")',
    );
    expect(workflow).toContain("Shared release candidate preparation ended with");
  });

  it("gives memory extension shards enough CPU without lowering their planner cost", () => {
    const workflow = readFileSync(PLUGIN_PRERELEASE_WORKFLOW, "utf8");

    expect(workflow).toContain('extensionId.startsWith("memory-")');
    expect(workflow).toContain('"blacksmith-16vcpu-ubuntu-2404"');
    expect(workflow).toContain("vitest_max_workers:");
    expect(workflow).toContain("OPENCLAW_VITEST_MAX_WORKERS: ${{ matrix.vitest_max_workers }}");
    expect(readFileSync("scripts/lib/extension-test-plan.mjs", "utf8")).toContain(
      '"test/vitest/vitest.extension-memory.config.ts": 1',
    );
  });

  it("shards broad native live tests instead of one serial live-all job", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const retryHelper = readFileSync("scripts/ci-live-command-retry.sh", "utf8");

    expect(workflow).toContain("validate_selected_ref:\n    runs-on: ubuntu-24.04");
    expect(workflow).not.toContain("suite_id: live-all");
    expect(workflow).not.toContain("command: pnpm test:live\n");
    expect(workflow).toContain("suite_id: native-live-src-agents");
    expect(workflow).toContain("Checkout trusted live shard harness");
    expect(workflow).toContain(
      "command: node .release-harness/scripts/test-live-shard.mjs native-live-src-agents",
    );
    expect(workflow).toContain("suite_id: native-live-src-agents-zai-coding");
    expect(workflow).toContain(
      "command: ZAI_CODING_LIVE_TEST=1 node .release-harness/scripts/test-live-shard.mjs native-live-src-agents-zai-coding",
    );
    expect(workflow).toContain("OPENCLAW_LIVE_COMMAND: ${{ matrix.command }}");
    expect(workflow).toContain("live_suite_filter:");
    expect(workflow).toContain("validate_live_suite_filter:");
    expect(workflow).toContain("LIVE_SUITE_FILTER: ${{ inputs.live_suite_filter }}");
    expect(workflow).toContain("live-cache attempt ${attempt}/2");
    expect(workflow).toContain(
      "live_suite_filter '${LIVE_SUITE_FILTER}' does not match any runnable suite",
    );
    expect(workflow).toContain('add_profile_suite docker-live-models "beta minimum stable full"');
    expect(workflow).toContain(
      'add_profile_suite native-live-src-gateway-core "beta minimum stable full"',
    );
    expect(workflow).toContain('add_profile_suite native-live-src-infra "stable full"');
    expect(workflow).toContain('add_profile_suite live-gateway-docker "beta minimum stable full"');
    expect(workflow).toContain('add_profile_suite live-gateway-anthropic-docker "stable full"');
    expect(workflow).toContain('add_profile_suite live-gateway-anthropic-docker-full "full"');
    expect(workflow).toContain('add_profile_suite live-gateway-advisory-docker "full"');
    expect(workflow).toContain(
      'add_profile_suite live-gateway-advisory-docker-deepseek-fireworks "full"',
    );
    expect(workflow).toContain(
      'add_profile_suite live-gateway-advisory-docker-opencode-openrouter "full"',
    );
    expect(workflow).toContain('add_profile_suite live-gateway-advisory-docker-xai-zai "full"');
    expect(workflow).toContain('add_profile_suite live-cli-backend-docker "stable full"');
    expect(workflow).toContain('add_profile_suite live-subagent-announce-docker "stable full"');
    expect(workflow).toContain(
      "inputs.live_suite_filter == '' || inputs.live_suite_filter == matrix.suite_id",
    );
    expect(workflow).not.toContain("openai-ws-stream-live-e2e");
    expect(workflow).not.toContain("src/agents/openai-ws-stream.e2e.test.ts");
    expect(workflow).toContain("suite_id: live-gateway-advisory-docker-deepseek-fireworks");
    expect(workflow).toContain("suite_id: live-gateway-advisory-docker-opencode-openrouter");
    expect(workflow).toContain("suite_id: live-gateway-advisory-docker-xai-zai");
    expect(workflow).toContain("suite_id: live-subagent-announce-docker");
    expect(workflow).toContain("suite_group: live-gateway-advisory-docker");
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_PROVIDERS=deepseek,fireworks");
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_PROVIDERS=opencode-go,openrouter");
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_PROVIDERS=xai,zai");
    expect(workflow).toContain("inputs.live_suite_filter == matrix.suite_group");
    expect(workflow).toContain("OPENCLAW_LIVE_CLI_BACKEND_MODEL=claude-cli/claude-sonnet-4-6");
    expect(workflow).toContain("OPENCLAW_LIVE_CLI_BACKEND_AUTH=api-key");
    expect(workflow).not.toContain("OPENCLAW_LIVE_CLI_BACKEND_USE_CI_SAFE_CODEX_CONFIG=1");
    expect(workflow).not.toContain('service_tier=\\"fast\\"');
    expect(workflow).not.toContain("OPENCLAW_LIVE_CLI_BACKEND_ARGS=");
    expect(workflow).not.toContain("OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS=");
    expect(workflow).not.toContain(
      'OPENCLAW_LIVE_CLI_BACKEND_ARGS=["exec","--json","--color","never","--sandbox","danger-full-access","--skip-git-repo-check"]',
    );
    expect(workflow).toContain("bash .release-harness/scripts/ci-live-command-retry.sh");
    expect(workflow).toContain("use_github_hosted_runners:");
    expect(workflow).toMatch(
      /validate_repo_e2e:[\s\S]*?runs-on: \$\{\{ inputs\.use_github_hosted_runners && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
    );
    expect(workflow).toMatch(
      /validate_special_e2e:[\s\S]*?runs-on: \$\{\{ inputs\.use_github_hosted_runners && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
    );
    expect(workflow).toMatch(
      /validate_live_provider_suites:[\s\S]*?runs-on: \$\{\{ inputs\.use_github_hosted_runners && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
    );
    expect(workflow).toContain("suite_id: native-live-src-gateway-core");
    expect(workflow).toContain("suite_id: native-live-src-gateway-backends");
    expect(workflow).toContain(
      "command: OPENCLAW_LIVE_CODEX_HARNESS=1 OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key node .release-harness/scripts/test-live-shard.mjs native-live-src-gateway-core",
    );
    expect(workflow).toContain(
      "command: OPENCLAW_LIVE_CODEX_HARNESS=1 OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key node .release-harness/scripts/test-live-shard.mjs native-live-src-gateway-backends",
    );
    expect(workflow).toContain("suite_id: native-live-src-infra");
    expect(workflow).toContain(
      "command: OPENCLAW_LIVE_APNS_REACHABILITY=1 node .release-harness/scripts/test-live-shard.mjs native-live-src-infra",
    );
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-anthropic-smoke");
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_SETUP_TIMEOUT_MS=300000");
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-anthropic-opus");
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-anthropic-sonnet-haiku");
    expect(workflow).toContain("suite_group: native-live-src-gateway-profiles-anthropic");
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_MODELS=anthropic/claude-opus-4-8");
    expect(workflow).toContain("anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5");
    expect(workflow).toMatch(
      /suite_id: native-live-src-gateway-profiles-fireworks[\s\S]*?advisory: true/u,
    );
    expect(workflow).toMatch(
      /suite_id: native-live-src-gateway-profiles-openai[\s\S]*?timeout_minutes: 60[\s\S]*?profiles: beta minimum stable full/u,
    );
    expect(workflow).toContain(
      "command: OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.6-luna OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=180000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
    );
    expect(workflow).toContain(
      "OPENCLAW_LIVE_GATEWAY_MODELS=google/gemini-3.1-pro-preview node .release-harness/scripts/test-live-shard.mjs native-live-src-gateway-profiles",
    );
    expect(workflow).toContain(
      "OPENCLAW_LIVE_GATEWAY_MODELS=minimax/MiniMax-M2.7,minimax-portal/MiniMax-M2.7 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2",
    );
    expect(workflow).toMatch(
      /suite_id: native-live-src-gateway-profiles-fireworks[\s\S]*?timeout_minutes: 30[\s\S]*?advisory: true/u,
    );
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-deepseek");
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-opencode-go");
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-openrouter");
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-xai");
    expect(workflow).toContain("suite_id: native-live-src-gateway-profiles-zai");
    expect(workflow).not.toContain("Z.AI API Platform validation is temporarily disabled");
    expect(workflow).not.toContain(
      "OPENCLAW_LIVE_GATEWAY_PROVIDERS=deepseek,opencode-go,openrouter,xai,zai",
    );
    expect(workflow).toContain("suite_id: live-gateway-anthropic-docker");
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2");
    expect(workflow).toContain(
      "OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.6-luna OPENCLAW_LIVE_GATEWAY_MAX_MODELS=1 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
    );
    expect(workflow).toContain(
      "OPENCLAW_LIVE_GATEWAY_MODELS=anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2",
    );
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000");
    expect(workflow).toContain("timeout --foreground --kill-after=30s 35m");
    expect(workflow).toMatch(/suite_id: live-gateway-docker[\s\S]*?timeout_minutes: 40/u);
    expect(workflow).toContain("suite_id: native-live-extensions-a-k");
    expect(workflow).toContain("suite_id: native-live-extensions-l-n");
    expect(workflow).toContain("suite_id: native-live-extensions-moonshot");
    expect(workflow).toMatch(/suite_id: native-live-extensions-moonshot[\s\S]*?advisory: true/u);
    expect(workflow).toContain("OPENCLAW_LIVE_SUITE_ADVISORY: ${{ matrix.advisory }}");
    expect(workflow).toContain("Advisory live suite failed with exit code");
    expect(workflow).toMatch(
      /validate_live_media_provider_suites:[\s\S]*?OPENCLAW_LIVE_SUITE_ADVISORY: \$\{\{ matrix\.advisory \}\}[\s\S]*?shell: bash[\s\S]*?Advisory live suite failed with exit code/u,
    );
    expect(workflow).toMatch(
      /suite_id: live-gateway-advisory-docker-deepseek-fireworks[\s\S]*?advisory: true/u,
    );
    expect(workflow).toMatch(
      /validate_live_media_provider_suites:[\s\S]*?OPENCLAW_LIVE_SUITE_ADVISORY: \$\{\{ matrix\.advisory \}\}/u,
    );
    expect(workflow).toMatch(
      /suite_id: native-live-extensions-media-video-d[\s\S]*?timeout_minutes: 30[\s\S]*?advisory: true/u,
    );
    expect(workflow).toContain("suite_id: native-live-extensions-openai");
    expect(workflow).toContain("suite_id: native-live-extensions-o-z-other");
    expect(workflow).toContain("validate_live_media_provider_suites:");
    expect(workflow).toMatch(
      /validate_live_media_provider_suites:[\s\S]*?runs-on: \$\{\{ inputs\.use_github_hosted_runners && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
    );
    expect(workflow).toContain(`image: ${LIVE_MEDIA_RUNNER_IMAGE}`);
    expect(workflow).toContain("ffmpeg -version | head -1");
    expect(workflow).toContain("ffprobe -version | head -1");
    const imageDockerfile = readFileSync(LIVE_MEDIA_RUNNER_DOCKERFILE, "utf8");
    const imageWorkflow = readFileSync(LIVE_MEDIA_RUNNER_IMAGE_WORKFLOW, "utf8");
    const buildJob = workflowJob(LIVE_MEDIA_RUNNER_IMAGE_WORKFLOW, "build");
    const buildStep = workflowStep(buildJob, "Build and push live media runner image");
    expect(imageDockerfile).toMatch(/^FROM ubuntu:24\.04$/m);
    expect(imageDockerfile).toContain("apt-get install -y --no-install-recommends");
    for (const packageName of ["bash", "curl", "ffmpeg", "git", "openssh-client", "zstd"]) {
      expect(imageDockerfile).toContain(`    ${packageName} \\`);
    }
    expect(imageDockerfile).toContain("rm -rf /var/lib/apt/lists/*");
    expect(imageWorkflow).toContain(`- "${LIVE_MEDIA_RUNNER_DOCKERFILE}"`);
    expect(buildStep.with?.context).toBe(".github/images/live-media-runner");
    expect(buildStep.with?.file).toBe(LIVE_MEDIA_RUNNER_DOCKERFILE);
    expect(buildStep.with?.tags).toContain(LIVE_MEDIA_RUNNER_IMAGE);
    expect(workflow).toContain("suite_id: native-live-extensions-media-audio");
    expect(workflow).toContain("suite_id: native-live-extensions-media-music-google");
    expect(workflow).toContain("suite_id: native-live-extensions-media-music-minimax");
    expect(workflow).toContain("suite_id: native-live-extensions-media-video");
    expect(workflow).toContain("suite_group: native-live-extensions-media-video");
    expect(workflow).toContain("OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS=google,minimax");
    expect(workflow).toContain("OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS=openai,openrouter,xai");
    expect(workflow).toContain(
      "inputs.live_suite_filter == 'native-live-src-gateway-profiles-anthropic'",
    );
    expect(workflow).toContain(
      "inputs.live_suite_filter == 'native-live-src-gateway-profiles-opencode-go'",
    );
    expect(workflow).toContain("inputs.live_suite_filter == 'native-live-extensions-media-video'");
    expect(workflow).not.toContain("needs_ffmpeg: true");
    expect(retryHelper).toContain("OPENCLAW_LIVE_COMMAND_ATTEMPTS:-2");
    expect(retryHelper).toContain("ECONNRESET");
    expect(retryHelper).toContain("fetch failed");
    expect(retryHelper).toContain("gateway request timeout");
    expect(retryHelper).toContain("model idle timeout");
    expect(retryHelper).toContain("OPENCLAW_LIVE_COMMAND_RATE_LIMIT_RETRY_DELAY_SECONDS:-60");
    expect(retryHelper).toContain("Rate limit reached");
    expect(retryHelper).toContain("tokens per min");
    expect(
      workflow.match(/moonshot\) require_any Moonshot MOONSHOT_API_KEY KIMI_API_KEY ;;/gu),
    ).toHaveLength(2);
  });

  it("pins DeepSeek live profiles to both current V4 model refs", () => {
    const deepSeek = workflowMatrixEntry(
      LIVE_E2E_WORKFLOW,
      "validate_live_provider_suites",
      "native-live-src-gateway-profiles-deepseek",
    );
    const openCodeGo = workflowMatrixEntry(
      LIVE_E2E_WORKFLOW,
      "validate_live_provider_suites",
      "native-live-src-gateway-profiles-opencode-go-deepseek-glm",
    );

    expect(deepSeek).toMatchObject({
      advisory: true,
      command:
        "OPENCLAW_LIVE_GATEWAY_PROVIDERS=deepseek OPENCLAW_LIVE_GATEWAY_MODELS=deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro node .release-harness/scripts/test-live-shard.mjs native-live-src-gateway-profiles",
      profiles: "full",
    });
    expect(openCodeGo.command).toContain(
      "OPENCLAW_LIVE_GATEWAY_MODELS=opencode-go/deepseek-v4-flash,opencode-go/deepseek-v4-pro",
    );
  });

  it("pins OpenCode Go MiMo live profiles to both current V2.5 model refs", () => {
    const mimo = workflowMatrixEntry(
      LIVE_E2E_WORKFLOW,
      "validate_live_provider_suites",
      "native-live-src-gateway-profiles-opencode-go-mimo",
    );

    expect(mimo).toMatchObject({
      advisory: true,
      command:
        "OPENCLAW_LIVE_GATEWAY_PROVIDERS=opencode-go OPENCLAW_LIVE_GATEWAY_MODELS=opencode-go/mimo-v2.5,opencode-go/mimo-v2.5-pro node .release-harness/scripts/test-live-shard.mjs native-live-src-gateway-profiles",
      profiles: "full",
      suite_group: "native-live-src-gateway-profiles-opencode-go",
    });
    expect(mimo.command).not.toContain("opencode-go/mimo-v2-omni");
    expect(mimo.command).not.toContain("opencode-go/mimo-v2-pro");
  });

  it("runs the fresh OpenAI API-key default without hard-coding a model filter", () => {
    const openaiDefault = workflowMatrixEntry(
      LIVE_E2E_WORKFLOW,
      "validate_live_provider_suites",
      "native-live-src-gateway-profiles-openai-api-default",
    );

    expect(openaiDefault).toMatchObject({ profiles: "stable full" });
    expect(openaiDefault.command).toContain("OPENCLAW_LIVE_GATEWAY_OPENAI_API_DEFAULT=1");
    expect(openaiDefault.command).toContain("OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai");
    expect(openaiDefault.command).not.toContain("OPENCLAW_LIVE_GATEWAY_MODELS=");
  });

  it("runs Docker live harnesses from trusted helper scripts", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const providerSuites = workflowJob(LIVE_E2E_WORKFLOW, "validate_live_docker_provider_suites");
    const scenarios = readFileSync("scripts/lib/docker-e2e-scenarios.mjs", "utf8");
    const scheduler = readFileSync("scripts/test-docker-all.mjs", "utf8");
    const harness = readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8");
    const codexLiveTest = readFileSync("src/gateway/gateway-codex-harness.live.test.ts", "utf8");
    const liveDockerAuth = readFileSync("scripts/lib/live-docker-auth.sh", "utf8");
    const sharedLiveScripts = [
      readFileSync("scripts/test-live-models-docker.sh", "utf8"),
      readFileSync("scripts/test-live-gateway-models-docker.sh", "utf8"),
      readFileSync("scripts/test-live-cli-backend-docker.sh", "utf8"),
      readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8"),
      readFileSync("scripts/test-live-subagent-announce-docker.sh", "utf8"),
    ];
    const build = readFileSync("scripts/test-live-build-docker.sh", "utf8");
    const stage = readFileSync("scripts/lib/live-docker-stage.sh", "utf8");

    expect(workflow).toContain(
      'run: OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-models-docker.sh',
    );
    expect(workflow).toContain(
      "command: OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.6-luna OPENCLAW_LIVE_GATEWAY_MAX_MODELS=1",
    );
    expect(workflow).toContain(
      "command: OPENCLAW_LIVE_GATEWAY_PROVIDERS=minimax,minimax-portal OPENCLAW_LIVE_GATEWAY_MODELS=minimax/MiniMax-M2.7,minimax-portal/MiniMax-M2.7 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2",
    );
    expect(workflow).toContain(
      'command: OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 45m bash .release-harness/scripts/test-live-cli-backend-docker.sh',
    );
    expect(workflow).toContain(
      'command: OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 45m bash .release-harness/scripts/test-live-acp-bind-docker.sh',
    );
    expect(workflow).toContain(
      'command: OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 35m bash .release-harness/scripts/test-live-codex-harness-docker.sh',
    );
    const codexCompatibility = workflowStep(
      providerSuites,
      "Resolve frozen Codex live compatibility",
    );
    expect(codexCompatibility).toMatchObject({
      id: "codex_compat",
      env: {
        OPENCLAW_FROZEN_CODEX_SUITE_ID: "${{ matrix.suite_id }}",
        OPENCLAW_FROZEN_TARGET_ROOT: "${{ github.workspace }}",
        OPENCLAW_SELECTED_SHA: "${{ needs.validate_selected_ref.outputs.selected_sha }}",
        OPENCLAW_WORKFLOW_SHA: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
      },
      run: "node .release-harness/scripts/resolve-frozen-codex-live-suite.mjs",
    });
    for (const stepName of [
      "Validate live-test image artifact binding",
      "Download live-test image artifact",
      "Verify and load live-test image artifact",
      "Setup Node environment",
      "Hydrate live auth/profile inputs",
      "Log in to GHCR",
      "Configure suite-specific env",
    ]) {
      expect(workflowStep(providerSuites, stepName).if, stepName).toContain(
        "steps.codex_compat.outputs.run_lane != 'false'",
      );
    }
    const runCodexSuite = providerSuites.steps?.find((candidate) =>
      candidate.name?.startsWith("Run ${{ matrix.label }}"),
    );
    expect(runCodexSuite?.if).toContain("steps.codex_compat.outputs.run_lane != 'false'");
    for (const [model, thinking] of [
      ["sol", "ultra"],
      ["terra", "ultra"],
      ["luna", "max"],
    ]) {
      expect(workflow).toContain(
        `OPENCLAW_LIVE_CODEX_HARNESS_TARGETS=openai/gpt-5.6-${model}=${thinking}`,
      );
    }
    expect(workflow.match(/live-codex-harness\*-docker\)/gu)).toHaveLength(2);
    for (const suiteId of [
      "native-live-src-gateway-profiles-openai-api-default",
      "native-live-src-gateway-profiles-openai-gpt56-ultra",
      "live-codex-harness-gpt56-sol-docker",
      "live-codex-harness-gpt56-terra-docker",
      "live-codex-harness-gpt56-luna-docker",
      "live-codex-harness-gpt56-docker",
    ]) {
      expect(workflow).toContain(`add_profile_suite ${suiteId} "stable full"`);
    }
    expect(codexLiveTest).toContain("command: `/model ${modelKey} --runtime codex`");
    expect(codexLiveTest).toContain("thinkingLevel: CODEX_HARNESS_THINKING");
    expect(workflow).toContain(
      'command: OPENCLAW_LIVE_DOCKER_REPO_ROOT="$GITHUB_WORKSPACE" timeout --foreground --kill-after=30s 20m bash .release-harness/scripts/test-live-subagent-announce-docker.sh',
    );
    expect(scenarios).toContain("function liveDockerScriptCommand");
    expect(scenarios).toContain("const LIVE_DOCKER_DEFAULT_HARNESS_DIR");
    expect(scenarios).toContain("fileURLToPath(import.meta.url)");
    expect(scenarios).toContain('? ".release-harness"');
    expect(scenarios).toContain("process.env.OPENCLAW_DOCKER_E2E_REPO_ROOT");
    expect(scenarios).toContain(
      'harness="\\${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-${LIVE_DOCKER_DEFAULT_HARNESS_DIR}}"',
    );
    expect(scenarios).not.toContain("harness=.release-harness");
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-models-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-gateway-models-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-cli-backend-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-acp-bind-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-codex-harness-docker\.sh"/u);
    expect(scenarios).toMatch(
      /liveDockerScriptCommand\(\s*"e2e\/codex-npm-plugin-live-docker\.sh"/u,
    );
    expect(scenarios).toMatch(
      /liveDockerScriptCommand\(\s*"test-live-subagent-announce-docker\.sh"/u,
    );
    expect(scheduler).toContain("function liveDockerHarnessScriptCommand");
    expect(scheduler).toContain("const LIVE_DOCKER_DEFAULT_HARNESS_DIR");
    expect(scheduler).toContain('path.basename(SCRIPT_ROOT_DIR) === ".release-harness"');
    expect(scheduler).toContain("ROOT_DIR !== SCRIPT_ROOT_DIR");
    expect(scheduler).toContain(
      'harness="\\${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-${LIVE_DOCKER_DEFAULT_HARNESS_DIR}}"',
    );
    expect(scheduler).not.toContain("harness=.release-harness");
    expect(scheduler).toContain('liveDockerHarnessScriptCommand("test-live-build-docker.sh")');
    expect(liveDockerAuth).toContain("codex-cli | openai)");
    expect(liveDockerAuth).toContain("openclaw_live_init_docker_run_args()");
    expect(liveDockerAuth).toContain("openclaw_live_stage_profile_into_home()");
    expect(liveDockerAuth).toContain("openclaw_live_chown_bind_dirs_for_container_user()");
    expect(liveDockerAuth).toContain("openclaw_live_uses_managed_bind_dirs()");
    expect(liveDockerAuth).toContain('openclaw_live_truthy "${OPENCLAW_TESTBOX:-}"');
    expect(liveDockerAuth).toContain('[[ -n "${OPENCLAW_DOCKER_CACHE_HOME_DIR:-}" ]]');
    expect(liveDockerAuth).toContain(
      'timeout_value="${2:-${OPENCLAW_LIVE_DOCKER_RUN_TIMEOUT:-2700s}}"',
    );
    expect(harness).toContain('source "$TRUSTED_HARNESS_DIR/scripts/lib/live-docker-auth.sh"');
    expect(harness).not.toContain('source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"');
    expect(harness).toContain(
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"',
    );
    expect(harness).toContain(
      '-e OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR="${DOCKER_TRUSTED_HARNESS_CONTAINER_DIR}/scripts"',
    );
    expect(harness).toContain('node --import tsx "$trusted_scripts_dir/prepare-codex-ci-auth.ts"');
    expect(harness).toContain('source "$trusted_scripts_dir/lib/live-docker-stage.sh"');
    for (const script of [harness, ...sharedLiveScripts]) {
      expect(script).toContain('source "$TRUSTED_HARNESS_DIR/scripts/lib/live-docker-auth.sh"');
      expect(script).not.toContain('source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"');
      expect(script).toContain("openclaw_live_init_docker_run_args DOCKER_RUN_ARGS");
      expect(script).toContain("openclaw_live_prepare_bind_dir_for_container_user");
      expect(script).toContain("DOCKER_RUN_ARGS+=(--rm -t \\");
      expect(script).not.toContain("DOCKER_RUN_ARGS=(docker run --rm -t \\");
    }
    for (const script of sharedLiveScripts) {
      expect(script).toContain("openclaw_live_uses_managed_bind_dirs");
      expect(script).toContain(
        'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"',
      );
      expect(script).toContain('source "$trusted_scripts_dir/lib/live-docker-stage.sh"');
      expect(script).toContain(
        '-e OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR="${DOCKER_TRUSTED_HARNESS_CONTAINER_DIR}/scripts"',
      );
      expect(script).toContain(
        "openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_TRUSTED_HARNESS_MOUNT",
      );
    }
    for (const script of [
      readFileSync("scripts/test-live-cli-backend-docker.sh", "utf8"),
      readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8"),
      readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8"),
    ]) {
      expect(script).toContain("elif command -v gtimeout >/dev/null 2>&1; then");
      expect(script).toContain('if "$timeout_bin" --kill-after=1s 1s true');
      expect(script).toContain('"$timeout_bin" --kill-after=30s "$timeout_value" "$@"');
      expect(script).not.toContain('timeout --kill-after=30s "${OPENCLAW_LIVE_');
    }
    expect(readFileSync("scripts/test-live-models-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_MODELS_DOCKER_RUN_TIMEOUT:-2100s",
    );
    expect(readFileSync("scripts/test-live-gateway-models-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_GATEWAY_DOCKER_RUN_TIMEOUT:-2100s",
    );
    expect(readFileSync("scripts/test-live-cli-backend-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_CLI_BACKEND_DOCKER_RUN_TIMEOUT:-2700s",
    );
    expect(readFileSync("scripts/test-live-cli-backend-docker.sh", "utf8")).toContain(
      'CLI_SETUP_TIMEOUT_SECONDS="$(openclaw_live_read_positive_int_env OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS 180)"',
    );
    expect(readFileSync("scripts/test-live-cli-backend-docker.sh", "utf8")).toContain(
      'timeout_value="${OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS:?missing live CLI backend setup timeout seconds}s"',
    );
    expect(readFileSync("scripts/test-live-cli-backend-docker.sh", "utf8")).toContain(
      'echo "timeout command not found; cannot bound live CLI backend setup after ${timeout_value}"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_ACP_BIND_DOCKER_RUN_TIMEOUT:-2700s",
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      'ACP_SETUP_TIMEOUT_SECONDS="$(openclaw_live_read_positive_int_env OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS 180)"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      'timeout_value="${OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS:?missing live ACP bind setup timeout seconds}s"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      '-e OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS="$ACP_SETUP_TIMEOUT_SECONDS"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      '-e OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON="${OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON:-}"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      'echo "timeout command not found; cannot bound live ACP bind setup after ${timeout_value}"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      'run_setup_command npm install -g "@anthropic-ai/claude-code@$claude_code_version"',
    );
    const acpBindScript = readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8");
    expect(acpBindScript).toContain(
      "OPENCLAW_LIVE_ACP_BIND_CLAUDE_AUTH must be one of: auto, api-key, subscription.",
    );
    expect(acpBindScript).toContain(
      'if [[ "$ACP_AGENT" == "claude" && "$CLAUDE_AUTH_MODE" == "subscription" ]]; then',
    );
    expect(acpBindScript).toContain(
      "unset ANTHROPIC_API_KEY ANTHROPIC_API_KEY_OLD ANTHROPIC_API_TOKEN",
    );
    expect(acpBindScript).toContain('-e CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"');
    expect(acpBindScript).not.toContain("    -e ANTHROPIC_API_KEY \\\n");
    expect(workflow.match(/OPENCLAW_LIVE_ACP_BIND_CLAUDE_AUTH=subscription/g)).toHaveLength(2);
    expect(workflow.match(/OPENCLAW_LIVE_ACP_BIND_CLAUDE_AUTH=api-key/g)).toHaveLength(2);
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      "run_setup_command bash -lc 'curl -fsSL https://app.factory.ai/cli | sh'",
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_CODEX_HARNESS_DOCKER_RUN_TIMEOUT:-$((2100 * CODEX_HARNESS_TARGET_COUNT))s",
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      'CODEX_HARNESS_SETUP_TIMEOUT_SECONDS="$(openclaw_live_read_positive_int_env OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS 180)"',
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      'timeout_value="${OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS:?missing live Codex harness setup timeout seconds}s"',
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      '-e OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS="$CODEX_HARNESS_SETUP_TIMEOUT_SECONDS"',
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      'echo "timeout command not found; cannot bound live Codex harness setup after ${timeout_value}"',
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      'run_setup_command npm install -g "$OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC"',
    );
    expect(readFileSync("scripts/test-live-subagent-announce-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_SUBAGENT_DOCKER_RUN_TIMEOUT:-1200s",
    );
    expect(build).toContain('ROOT_DIR="${OPENCLAW_LIVE_DOCKER_REPO_ROOT:-$SCRIPT_ROOT_DIR}"');
    expect(build).toContain('source "$SCRIPT_ROOT_DIR/scripts/lib/docker-build.sh"');
    expect(build).toContain('source "$SCRIPT_ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(build).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_LIVE_DOCKER_PULL_TIMEOUT:-600s}}"',
    );
    expect(build).toContain('LIVE_IMAGE_PULL_ATTEMPTS="${OPENCLAW_LIVE_DOCKER_PULL_ATTEMPTS:-3}"');
    expect(build).toContain('docker_e2e_docker_cmd pull "$LIVE_IMAGE_NAME"');
    expect(build).not.toContain('docker pull "$LIVE_IMAGE_NAME"');
    expect(stage).toContain(
      'local scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"',
    );
    expect(stage).toContain('node --import tsx "$scripts_dir/live-docker-normalize-config.ts"');
  });

  it("fails Droid ACP Docker live proof when Factory auth is missing", () => {
    const script = readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8");

    expect(script).toContain("openclaw_live_acp_bind_load_factory_api_key_from_profile");
    expect(script).not.toContain('source "$PROFILE_FILE"');
    expect(script.indexOf("openclaw_live_acp_bind_load_factory_api_key_from_profile")).toBeLessThan(
      script.indexOf('if [[ "$ACP_AGENT" == "droid" && -z "${FACTORY_API_KEY:-}" ]]; then'),
    );
    expect(script).toContain(
      "ERROR: Droid Docker ACP bind requires FACTORY_API_KEY; Factory OAuth/keyring auth in ~/.factory is not portable into the container.",
    );
    expect(script).not.toContain(
      "SKIP: Droid Docker ACP bind requires FACTORY_API_KEY; Factory OAuth/keyring auth in ~/.factory is not portable into the container.",
    );
    expect(script).not.toMatch(
      /Droid Docker ACP bind requires FACTORY_API_KEY[\s\S]{0,160}(exit 0|continue)/u,
    );
  });

  it("plumbs live credentials through planned Docker E2E live lanes", () => {
    const reusableWorkflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const releaseChecksWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const scheduledWorkflow = readFileSync(SCHEDULED_LIVE_CHECKS_WORKFLOW, "utf8");
    const packageAcceptanceWorkflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");
    const testboxWorkflow = readFileSync(CI_CHECK_TESTBOX_WORKFLOW, "utf8");
    const dockerPlanAction = readFileSync(DOCKER_E2E_PLAN_ACTION, "utf8");
    const hydrateScript = readFileSync(CI_HYDRATE_LIVE_AUTH_SCRIPT, "utf8");
    const providerVerifier = readFileSync(VERIFY_PROVIDER_SECRETS_SCRIPT, "utf8");
    const testboxProviderSecretKeys = [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY_OLD",
      "ANTHROPIC_API_TOKEN",
      "FACTORY_API_KEY",
      "BYTEPLUS_API_KEY",
      "CEREBRAS_API_KEY",
      "DEEPINFRA_API_KEY",
      "DASHSCOPE_API_KEY",
      "GROQ_API_KEY",
      "KIMI_API_KEY",
      "MODELSTUDIO_API_KEY",
      "MOONSHOT_API_KEY",
      "MISTRAL_API_KEY",
      "MINIMAX_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "OPENCLAW_LIVE_BROWSER_CDP_URL",
      "OPENCLAW_LIVE_SETUP_TOKEN",
      "OPENCLAW_LIVE_SETUP_TOKEN_MODEL",
      "OPENCLAW_LIVE_SETUP_TOKEN_PROFILE",
      "OPENCLAW_LIVE_SETUP_TOKEN_VALUE",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "OPENROUTER_API_KEY",
      "QWEN_API_KEY",
      "FAL_KEY",
      "RUNWAY_API_KEY",
      "DEEPGRAM_API_KEY",
      "TOGETHER_API_KEY",
      "VYDRA_API_KEY",
      "XAI_API_KEY",
      "ZAI_API_KEY",
      "Z_AI_API_KEY",
      "BYTEPLUS_ACCESS_KEY_ID",
      "BYTEPLUS_SECRET_ACCESS_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENCLAW_CODEX_AUTH_JSON",
      "OPENCLAW_CODEX_CONFIG_TOML",
      "OPENCLAW_CLAUDE_JSON",
      "OPENCLAW_CLAUDE_CREDENTIALS_JSON",
      "OPENCLAW_CLAUDE_SETTINGS_JSON",
      "OPENCLAW_CLAUDE_SETTINGS_LOCAL_JSON",
      "OPENCLAW_GEMINI_SETTINGS_JSON",
      "FIREWORKS_API_KEY",
    ];
    const githubBackedTestboxProviderSteps = [
      workflowStep(
        workflowJob(CI_CHECK_TESTBOX_WORKFLOW, "check"),
        "Hydrate Testbox provider env helper",
      ),
      workflowStep(
        workflowJob(CI_CHECK_ARM_TESTBOX_WORKFLOW, "check-arm"),
        "Hydrate Testbox provider env helper",
      ),
      workflowStep(
        workflowJob(CI_BUILD_ARTIFACTS_TESTBOX_WORKFLOW, "build-artifacts"),
        "Hydrate Testbox provider env helper",
      ),
      workflowStep(
        workflowJob(CRABBOX_HYDRATE_WORKFLOW, "hydrate-github"),
        "Hydrate provider env helper",
      ),
    ];

    expect(hydrateScript).toContain("  FACTORY_API_KEY \\");
    expect(providerVerifier).toContain('url: "https://api.anthropic.com/v1/messages"');
    expect(providerVerifier).toContain('model: "claude-haiku-4-5"');
    expect(providerVerifier).toContain("validateResponse:");
    expect(providerVerifier).not.toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(dockerPlanAction).toContain('if [[ "$credentials" == *",factory,"* ]]; then');
    expectTextToIncludeAll(dockerPlanAction, [
      'if [[ "$credentials" == *",openai,"* ]]; then',
      "require_any OpenAI OPENAI_API_KEY",
      'if [[ "$credentials" == *",codex,"* ]]; then',
      "require_any Codex OPENCLAW_CODEX_AUTH_JSON",
      'if [[ "$credentials" == *",anthropic,"* ]]; then',
      "require_any Anthropic ANTHROPIC_API_TOKEN ANTHROPIC_API_KEY OPENCLAW_CLAUDE_CREDENTIALS_JSON OPENCLAW_CLAUDE_JSON",
      'if [[ "$credentials" == *",factory,"* ]]; then',
      "require_any Factory FACTORY_API_KEY",
      'if [[ "$credentials" == *",gemini,"* ]]; then',
      "require_any Gemini GEMINI_API_KEY GOOGLE_API_KEY OPENCLAW_GEMINI_SETTINGS_JSON",
      'if [[ "$credentials" == *",opencode,"* ]]; then',
      "require_any OpenCode OPENCODE_API_KEY OPENCODE_ZEN_API_KEY",
    ]);
    for (const workflow of [
      reusableWorkflow,
      releaseChecksWorkflow,
      scheduledWorkflow,
      packageAcceptanceWorkflow,
      testboxWorkflow,
    ]) {
      expect(workflow).toContain("FACTORY_API_KEY: ${{ secrets.FACTORY_API_KEY }}");
    }
    for (const step of githubBackedTestboxProviderSteps) {
      for (const key of testboxProviderSecretKeys) {
        expect(step.env?.[key]).toBe("${{ secrets." + key + " }}");
      }
    }
    expect(reusableWorkflow).toContain("FACTORY_API_KEY:\n        required: false");
    expect(packageAcceptanceWorkflow).toContain("FACTORY_API_KEY:\n        required: false");
    expectTextToIncludeAll(reusableWorkflow, [
      'if [[ "$credentials" == *",openai,"* ]]; then',
      "require_any OpenAI OPENAI_API_KEY",
      'if [[ "$credentials" == *",codex,"* ]]; then',
      "require_any Codex OPENCLAW_CODEX_AUTH_JSON",
      'if [[ "$credentials" == *",gemini,"* ]]; then',
      "require_any Gemini GEMINI_API_KEY GOOGLE_API_KEY OPENCLAW_GEMINI_SETTINGS_JSON",
      'if [[ "$credentials" == *",opencode,"* ]]; then',
      "require_any OpenCode OPENCODE_API_KEY OPENCODE_ZEN_API_KEY",
    ]);
    expect(reusableWorkflow.match(/OPENCLAW_LIVE_CLI_BACKEND_AUTH=subscription/g)).toHaveLength(2);
    expect(
      reusableWorkflow.match(
        /if \[\[ -n "\$\{OPENCLAW_CLAUDE_CREDENTIALS_JSON:-\}" \|\| -n "\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}" \]\]; then/g,
      ),
    ).toHaveLength(4);
  });

  it("finalizes dispatched Testbox delegation even when setup or the remote command fails", () => {
    const workflow = readFileSync(CI_CHECK_TESTBOX_WORKFLOW, "utf8");
    const checkTestboxJob = workflowJob(CI_CHECK_TESTBOX_WORKFLOW, "check");
    const runTestboxStep = workflowStep(checkTestboxJob, "Run Testbox");
    const runArmTestboxStep = workflowStep(
      workflowJob(CI_CHECK_ARM_TESTBOX_WORKFLOW, "check-arm"),
      "Run Testbox",
    );
    const runBuildArtifactsTestboxStep = workflowStep(
      workflowJob(CI_BUILD_ARTIFACTS_TESTBOX_WORKFLOW, "build-artifacts"),
      "Run Testbox",
    );
    const runWindowsTestboxStep = workflowStep(
      workflowJob(WINDOWS_BLACKSMITH_TESTBOX_WORKFLOW, "windows"),
      "Run Testbox",
    );

    expect(workflow).toContain('PNPM_CONFIG_STORE_DIR: "/tmp/openclaw-pnpm-store"');
    expect(workflow).not.toContain("PNPM_CONFIG_MODULES_DIR");
    expect(workflow).not.toContain("PNPM_CONFIG_VIRTUAL_STORE_DIR");
    expect(checkTestboxJob["timeout-minutes"]).toBe(
      "${{ fromJSON(inputs.timeout_minutes || '120') }}",
    );
    expect(runTestboxStep.uses).toContain("useblacksmith/run-testbox@");
    expect(runTestboxStep.if).toBe("github.event_name == 'workflow_dispatch' && always()");
    expect(runArmTestboxStep.if).toBe("always()");
    expect(runBuildArtifactsTestboxStep.if).toBe("always()");
    expect(runWindowsTestboxStep.if).toBe("always()");
    expect(runTestboxStep["continue-on-error"]).toBeUndefined();
  });

  it("allows the Telegram lane to run from reusable package acceptance artifacts", () => {
    const workflow = readFileSync(NPM_TELEGRAM_WORKFLOW, "utf8");

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("package_artifact_name:");
    expect(workflow).toContain("Download package-under-test artifact");
    expect(workflow).toContain("harness_ref:");
    expect(workflow).toContain("ref: ${{ inputs.harness_ref || github.sha }}");
    expect(workflow).toContain("OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ");
    expect(workflow).toContain("provider_mode:");
    expect(workflow).toContain("provider_mode must be mock-openai or live-frontier");
    expect(workflow).toContain("run_package_telegram_e2e:");
  });

  it("includes package acceptance in release checks", () => {
    const workflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const packageAcceptanceWorkflow = parse(readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8")) as {
      on?: {
        workflow_call?: { inputs?: Record<string, unknown> };
      };
    };
    const packageAcceptanceJob = workflowJob(
      RELEASE_CHECKS_WORKFLOW,
      "package_acceptance_release_checks",
    );
    const dockerAcceptanceJob = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "docker_acceptance");

    expect(workflow).toContain("package_acceptance_release_checks:");
    expect(packageAcceptanceWorkflow.on?.workflow_call?.inputs).toHaveProperty(
      "allow_frozen_target_scenario_omissions",
    );
    expect(packageAcceptanceJob.with).toMatchObject({
      allow_frozen_target_scenario_omissions:
        "${{ inputs.allow_frozen_target_scenario_omissions }}",
    });
    expect(dockerAcceptanceJob.with).toMatchObject({
      allow_frozen_target_scenario_omissions:
        "${{ inputs.allow_frozen_target_scenario_omissions || false }}",
    });
    expect(workflow).toContain(
      "live_repo_e2e_release_checks:\n    name: Run repo/live E2E validation\n    needs: [resolve_target]",
    );
    expect(workflow).toContain(
      "docker_e2e_release_checks:\n    name: Run Docker release-path validation\n    needs: [resolve_target, prepare_release_package]",
    );
    expect(workflow).toContain("include_release_path_suites: false");
    expect(workflow).toContain("include_release_path_suites: true");
    expect(workflow).toContain(
      "allow_frozen_target_scenario_omissions: ${{ inputs.allow_frozen_target_scenario_omissions }}",
    );
    expect(workflow).toContain("uses: ./.github/workflows/package-acceptance.yml");
    expect(workflow).toContain(
      "source: ${{ (needs.resolve_target.outputs.package_acceptance_package_spec != '' || needs.resolve_target.outputs.release_package_spec != '') && 'npm' || 'artifact' }}",
    );
    expect(workflow).toContain(
      "package_spec: ${{ needs.resolve_target.outputs.package_acceptance_package_spec || needs.resolve_target.outputs.release_package_spec || 'openclaw@beta' }}",
    );
    expect(workflow).toContain(".artifacts/docker-e2e-package/package-candidate.json");
    expect(workflow).toContain(
      "artifact_name: ${{ needs.prepare_release_package.outputs.artifact_name }}",
    );
    expect(workflow).toContain(
      "package_sha256: ${{ (needs.resolve_target.outputs.package_acceptance_package_spec == '' && needs.resolve_target.outputs.release_package_spec == '') && needs.prepare_release_package.outputs.package_sha256 || '' }}",
    );
    expect(workflow).toContain("suite_profile: custom");
    expect(workflow).toContain(
      "docker_lanes: doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape",
    );
    expect(workflow).toContain(
      "published_upgrade_survivor_baselines: ${{ needs.resolve_target.outputs.run_release_soak == 'true' && 'last-stable-4 2026.4.23 2026.5.2 2026.4.15' || '' }}",
    );
    expect(workflow).toContain(
      "published_upgrade_survivor_scenarios: ${{ needs.resolve_target.outputs.run_release_soak == 'true' && 'reported-issues' || '' }}",
    );
    expect(workflow).toContain("telegram_mode: mock-openai");
    expect(packageAcceptanceJob.with).toMatchObject({
      telegram_advisory: "${{ needs.resolve_target.outputs.release_profile == 'beta' }}",
    });
    expect(workflow).not.toContain("telegram_scenarios:");
    expect(workflow).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(workflow).toContain("ANTHROPIC_API_TOKEN: ${{ secrets.ANTHROPIC_API_TOKEN }}");
    expect(workflow).toContain(
      "OPENCLAW_QA_CONVEX_SITE_URL: ${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    );
    expect(workflow).toContain(
      "OPENCLAW_QA_CONVEX_SECRET_CI: ${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
    );
    expect(workflow).toContain("rerun_group:");
    expect(workflow).toContain("live_suite_filter:");
    expect(workflow).toContain("repo_live_suite_filter:");
    expect(workflow).toContain('repo_filter_tokens+=("$token")');
    expect(workflow).toContain(
      'repo_live_suite_filter="$(IFS=,; printf \'%s\' "${repo_filter_tokens[*]}")"',
    );
    expect(workflow).toContain("cross_os_suite_filter:");
    expect(workflow).toContain("advisory: false");
    expect(workflow).toContain(
      "suite_filter: ${{ needs.resolve_target.outputs.cross_os_suite_filter }}",
    );
    expect(workflow).toContain(
      "live_suite_filter: ${{ needs.resolve_target.outputs.repo_live_suite_filter }}",
    );
    expect(workflow).toContain(
      "contains(fromJSON('[\"all\",\"cross-os\",\"package\"]'), needs.resolve_target.outputs.rerun_group) || (needs.resolve_target.outputs.rerun_group == 'live-e2e' && needs.resolve_target.outputs.repo_live_suite_filter == '')",
    );
    expect(workflow).toContain(
      "(needs.resolve_target.outputs.rerun_group == 'live-e2e' || (needs.resolve_target.outputs.rerun_group == 'all' && needs.resolve_target.outputs.run_release_soak == 'true')) && needs.resolve_target.outputs.repo_live_suite_filter == ''",
    );
    expect(workflow).toContain(
      'if [[ "$release_profile" == "stable" || "$release_profile" == "full" ]]; then\n            run_release_soak=true',
    );
    expect(workflow).toContain("forced on for release_profile=stable and full");
    expect(workflow).toContain("- live-e2e");
    expect(workflow).toContain("- qa-live");
    expect(workflow).toContain("disabled_required_lanes=()");
    expect(workflow).toContain("live_suite_filter explicitly requested disabled QA live lane(s)");
    expect(workflow).toContain("OPENCLAW_RELEASE_QA_*_LIVE_CI_ENABLED");
    expect(workflow).not.toContain(
      "QA release-check lanes are advisory and do not block release validation.",
    );
  });

  it("prefers fresh Claude OAuth credentials for direct Anthropic live provider lanes", () => {
    const hydrateScript = readFileSync(CI_HYDRATE_LIVE_AUTH_SCRIPT, "utf8");

    expect(hydrateScript).toContain("  ANTHROPIC_OAUTH_TOKEN \\");
    expect(hydrateScript).toContain("access_token=\"$(jq -r '.claudeAiOauth.accessToken // empty'");
    expect(hydrateScript).toContain('export ANTHROPIC_OAUTH_TOKEN="$access_token"');
    expect(hydrateScript).toContain('local min_remaining_ms="$(( 90 * 60 * 1000 ))"');
    expect(hydrateScript).toContain(
      'printf \'ANTHROPIC_OAUTH_TOKEN=%s\\n\' "$access_token" >>"$GITHUB_ENV"',
    );
    for (const jobName of [
      "validate_live_models_docker",
      "validate_live_models_docker_targeted",
      "validate_live_provider_suites",
    ]) {
      expect(workflowJob(LIVE_E2E_WORKFLOW, jobName).env?.ANTHROPIC_OAUTH_TOKEN).toBe(
        "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
      );
    }
  });

  it("routes release Matrix through the QA Lab selector", () => {
    const releaseWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const releaseTelegramWorkflow = readFileSync(RELEASE_TELEGRAM_QA_WORKFLOW, "utf8");
    const qaWorkflow = readFileSync(".github/workflows/qa-live-transports-convex.yml", "utf8");
    const releaseJob = workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_live_release_checks");

    expect(releaseJob.uses).toBe("./.github/workflows/qa-live-transports-convex.yml");
    expect(releaseJob.secrets).toBeUndefined();
    expect(releaseJob.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(releaseJob.if).toContain('contains(fromJSON(\'["all","qa","qa-live"]\')');
    expect(releaseJob.with).toMatchObject({
      expected_sha: "${{ needs.resolve_target.outputs.revision }}",
      matrix_profile: "release",
      matrix_provider_mode: "mock-openai",
      matrix_primary_model: "mock-openai/gpt-5.6-luna",
      matrix_alternate_model: "mock-openai/gpt-5.6-luna-alt",
      matrix_attempts: 2,
      run_matrix: true,
      matrix_advisory: true,
    });
    for (const lane of ["mock_parity", "telegram", "discord", "whatsapp", "slack"]) {
      expect(releaseJob.with?.[`run_${lane}`]).toBeUndefined();
    }
    expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_mock_parity").if).toBe(
      "inputs.expected_sha == '' || inputs.run_mock_parity",
    );
    expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_matrix").if).toBe(
      "(github.event_name != 'workflow_call' || inputs.run_matrix) && !(github.event_name == 'workflow_dispatch' && inputs.matrix_profile == 'all')",
    );
    for (const channel of ["telegram", "discord", "whatsapp", "slack"]) {
      expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, `run_live_${channel}`).if).toBe(
        `inputs.expected_sha == '' || inputs.run_${channel}`,
      );
    }
    expect(releaseWorkflow).not.toContain("qa_live_matrix_release_checks");
    expect(releaseWorkflow).not.toContain("Run QA Lab live Matrix lane");
    expect(releaseWorkflow).not.toContain("pnpm openclaw qa matrix");
    expect(qaWorkflow).toContain("pnpm openclaw qa matrix");
    expect(qaWorkflow).toContain('for attempt in $(seq 1 "${MATRIX_ATTEMPTS}")');
    expect(qaWorkflow).toContain("matrix_status:");
    expect(qaWorkflow).toContain("value: ${{ jobs.run_live_matrix.outputs.status }}");
    expect(qaWorkflow).toContain('trusted_reason="repository-branch"');
    expect(qaWorkflow).toContain('"${selected_revision}" != "${EXPECTED_SHA}"');
    expect(qaWorkflow).toContain("EXPECTED_SHA: ${{ inputs.expected_sha }}");
    expect(
      workflowStep(
        workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "authorize_actor"),
        "Require maintainer-level repository access",
      ).env?.EXPECTED_SHA,
    ).toBe("${{ inputs.expected_sha }}");
    expect(qaWorkflow).toContain('(process.env.EXPECTED_SHA ?? "") !== ""');
    expect(qaWorkflow).not.toContain('"${{ inputs.expected_sha }}" !== ""');
    expect(qaWorkflow).toContain('if [[ -n "${EXPECTED_SHA}" ]]; then');
    const matrixJob = workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_matrix");
    const conditionalOpenAiSecret =
      "${{ (inputs.expected_sha != '' && inputs.matrix_provider_mode == 'live-frontier' || inputs.expected_sha == '' && github.event_name != 'workflow_dispatch') && secrets.OPENAI_API_KEY || '' }}";
    expect(workflowStep(matrixJob, "Validate required QA credential env").env?.OPENAI_API_KEY).toBe(
      conditionalOpenAiSecret,
    );
    expect(workflowStep(matrixJob, "Run Matrix live lane").env?.OPENAI_API_KEY).toBe(
      conditionalOpenAiSecret,
    );
    expect(workflowStep(matrixJob, "Run Matrix live lane").env).toMatchObject({
      MATRIX_PROVIDER_MODE:
        "${{ inputs.expected_sha != '' && inputs.matrix_provider_mode || github.event_name == 'workflow_dispatch' && 'mock-openai' || 'live-frontier' }}",
      MATRIX_PRIMARY_MODEL:
        "${{ inputs.expected_sha != '' && inputs.matrix_primary_model || github.event_name == 'workflow_dispatch' && 'mock-openai/gpt-5.6-luna' || env.OPENCLAW_CI_OPENAI_MODEL }}",
      MATRIX_ALTERNATE_MODEL:
        "${{ inputs.expected_sha != '' && inputs.matrix_alternate_model || github.event_name == 'workflow_dispatch' && 'mock-openai/gpt-5.6-luna-alt' || env.OPENCLAW_CI_OPENAI_FALLBACK_MODEL }}",
    });
    expect(workflowStep(matrixJob, "Upload Matrix QA artifacts").with?.name).toBe(
      "${{ inputs.expected_sha != '' && format('release-qa-live-matrix-{0}', inputs.expected_sha) || format('qa-live-matrix-{0}-{1}', github.run_id, github.run_attempt) }}",
    );
    expect(matrixJob["continue-on-error"]).toBe(
      "${{ github.event_name == 'workflow_call' && inputs.matrix_advisory }}",
    );
    expect(qaWorkflow).toContain("status: ${{ steps.record_status.outputs.status }}");
    expect(qaWorkflow).not.toContain('matrix_runner="legacy"');
    const shardedMatrixJob = workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_matrix_sharded");
    expect(shardedMatrixJob.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.matrix_profile == 'all' }}",
    );
    expect(shardedMatrixJob.strategy?.matrix?.profile).toEqual([
      "transport",
      "media",
      "e2ee-smoke",
      "e2ee-deep",
      "e2ee-cli",
    ]);
    expect(workflowStep(shardedMatrixJob, "Run Matrix live lane shard").run).toContain(
      '--profile "${{ matrix.profile }}"',
    );
    expect(releaseTelegramWorkflow).toContain(
      'echo "Telegram live lane failed on attempt ${attempt}; retrying once..." >&2',
    );
    expect(qaWorkflow).toContain(
      'echo "Matrix live lane failed on attempt ${attempt}; retrying..." >&2',
    );
    expect(qaWorkflow).not.toContain("OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS");
    expect(qaWorkflow).toContain('--profile "${matrix_profile}"');
    expect(qaWorkflow).not.toContain("--fail-fast");

    const matrixRunScript = workflowStep(matrixJob, "Run Matrix live lane").run ?? "";
    const resolveMatrixProfile = shellFunctionSource(matrixRunScript, "resolve_matrix_profile");
    const resolveProfile = (requested: string, helpText: string) =>
      execFileSync(
        "bash",
        [
          "-c",
          `${resolveMatrixProfile}\nresolve_matrix_profile "$1" "$2"`,
          "resolve-matrix-profile",
          requested,
          helpText,
        ],
        { encoding: "utf8" },
      ).trim();
    expect(resolveProfile("release", "profiles: all, fast, release, transport")).toBe("release");
    expect(resolveProfile("release", "profiles: all, fast, transport")).toBe("fast");
    expect(resolveProfile("e2ee-smoke", "profiles: all, fast, transport")).toBe("e2ee-smoke");
  });

  it("runs live transport lanes nightly while release checks stay gated", () => {
    const releaseWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const qaWorkflow = readFileSync(QA_LIVE_TRANSPORTS_WORKFLOW, "utf8");

    for (const channel of ["DISCORD", "WHATSAPP", "SLACK"]) {
      const lower = channel.toLowerCase();
      expect(releaseWorkflow).toContain(
        `RELEASE_QA_${channel}_LIVE_CI_ENABLED: \${{ vars.OPENCLAW_RELEASE_QA_${channel}_LIVE_CI_ENABLED || 'false' }}`,
      );
      expect(releaseWorkflow).toContain(`qa_live_${lower}_enabled="$qa_live_${lower}_ci_enabled"`);
      expect(releaseWorkflow).toContain(
        `needs.resolve_target.outputs.qa_live_${lower}_enabled == 'true'`,
      );
      expect(releaseWorkflow).not.toContain(
        `vars.OPENCLAW_RELEASE_QA_${channel}_LIVE_CI_ENABLED == 'true'`,
      );
      expect(qaWorkflow).not.toContain(`OPENCLAW_QA_${channel}_LIVE_CI_ENABLED`);
    }
  });

  it("requires QA live evidence artifacts when lanes run", () => {
    const cases = [
      ["run_mock_parity", "Upload parity artifacts", "always()"],
      [
        "run_live_runtime_token_efficiency",
        "Upload live runtime token-efficiency artifacts",
        "always() && steps.run_lane.outputs.output_dir != ''",
      ],
      ["run_live_matrix", "Upload Matrix QA artifacts", "always()"],
      ["run_live_matrix_sharded", "Upload Matrix QA shard artifacts", "always()"],
      ["run_live_telegram", "Upload Telegram QA artifacts", "always()"],
      ["run_live_discord", "Upload Discord QA artifacts", "always()"],
      ["run_live_whatsapp", "Upload WhatsApp QA artifacts", "always()"],
      ["run_live_slack", "Upload Slack QA artifacts", "always()"],
    ] as const;

    for (const [jobName, stepName, uploadCondition] of cases) {
      const uploadStep = workflowStep(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, jobName), stepName);

      expect(uploadStep.if, jobName).toBe(uploadCondition);
      expect(uploadStep.with?.["if-no-files-found"], jobName).toBe("error");
    }
  });

  it("preserves the primary runtime token-efficiency failure", () => {
    const job = workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_runtime_token_efficiency");
    const runStep = workflowStep(job, "Run live core runtime-pair lane");
    const reportStep = workflowStep(job, "Generate live runtime token-efficiency report");

    expect(runStep.run).toContain('mkdir -p "${output_dir}"');
    expect(runStep.run).toContain(
      "printf 'Runtime token-efficiency lane started.\\n' > \"${output_dir}/runtime-lane-started.txt\"",
    );
    expect(reportStep.if).toBe("steps.run_lane.outcome == 'success'");
  });

  it("requires release-check QA evidence artifacts when lanes run", () => {
    const cases = [
      ["qa_lab_parity_lane_release_checks", "Upload parity lane artifacts"],
      ["qa_lab_parity_report_release_checks", "Upload parity artifacts"],
      ["qa_lab_runtime_parity_release_checks", "Upload runtime parity artifacts"],
      ["qa_live_discord_release_checks", "Upload Discord QA artifacts"],
      ["qa_live_whatsapp_release_checks", "Upload WhatsApp QA artifacts"],
      ["qa_live_slack_release_checks", "Upload Slack QA artifacts"],
    ] as const;

    for (const [jobName, stepName] of cases) {
      const uploadStep = workflowStep(workflowJob(RELEASE_CHECKS_WORKFLOW, jobName), stepName);

      expect(uploadStep.if, jobName).toBe("always()");
      expect(uploadStep.uses, jobName).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with?.["if-no-files-found"], jobName).toBe("error");
    }

    const telegramUpload = workflowStep(
      workflowJob(RELEASE_TELEGRAM_QA_WORKFLOW, "run_telegram"),
      "Upload Telegram QA artifacts",
    );
    expect(telegramUpload.if).toContain("always()");
    expect(telegramUpload.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(telegramUpload.with?.["if-no-files-found"]).toBe("error");

    const runtimeCoverageUpload = workflowStep(
      workflowJob(RELEASE_CHECKS_WORKFLOW, "runtime_tool_coverage_release_checks"),
      "Upload runtime tool coverage artifacts",
    );
    expect(runtimeCoverageUpload.if).toContain("always()");
    expect(runtimeCoverageUpload.if).toContain(
      "steps.verify_runtime_parity_status.outputs.ready == 'true'",
    );
    expect(runtimeCoverageUpload.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(runtimeCoverageUpload.with?.["if-no-files-found"]).toBe("error");
  });

  it("runs canonical runtime-pair lanes in parallel and preserves one gate", () => {
    const laneJob = workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_lab_runtime_pair_lane_release_checks");
    const collectorJob = workflowJob(
      RELEASE_CHECKS_WORKFLOW,
      "qa_lab_runtime_parity_release_checks",
    );

    expect(laneJob.strategy?.["fail-fast"]).toBe(false);
    expect(laneJob.strategy?.matrix?.lane).toContain('["core","soak"]');
    expect(laneJob.strategy?.matrix?.lane).toContain('["core"]');
    const runtimePairRun = workflowStep(laneJob, "Run runtime-pair lane").run;
    expect(runtimePairRun).toContain('--runtime-pair-lane "$RUNTIME_PAIR_LANE"');
    expect(runtimePairRun).toContain("--runtime-parity-tier standard,live-only");
    expect(runtimePairRun).toContain("--runtime-parity-tier soak");
    expect(runtimePairRun).toContain("Frozen candidate cannot select runtime-pair lane");
    expect(workflowStep(laneJob, "Upload runtime-pair lane artifacts").with?.name).toContain(
      "${{ matrix.lane }}",
    );
    expect(collectorJob.needs).toEqual([
      "resolve_target",
      "qa_lab_runtime_pair_lane_release_checks",
    ]);
    expect(collectorJob.name).toBe("Verify QA Lab runtime-pair lanes");
    expect(workflowStep(collectorJob, "Download runtime-pair lane artifacts").with).toMatchObject({
      pattern: "release-qa-runtime-pair-lane-*-${{ needs.resolve_target.outputs.revision }}",
      "merge-multiple": true,
    });
    expect(workflowStep(collectorJob, "Verify runtime-pair lane statuses").run).toContain(
      "lanes=(core)",
    );
    expect(workflowStep(collectorJob, "Upload runtime parity artifacts").with?.name).toBe(
      "release-qa-runtime-parity-${{ needs.resolve_target.outputs.revision }}",
    );
  });

  it("requires live proof evidence artifacts when proof jobs run", () => {
    const cases = [
      {
        workflowPath: MANTIS_DISCORD_SMOKE_WORKFLOW,
        jobName: "run_discord_smoke",
        stepName: "Upload Mantis artifacts",
      },
      {
        workflowPath: MANTIS_DISCORD_STATUS_REACTIONS_WORKFLOW,
        jobName: "run_status_reactions",
        stepName: "Upload Mantis status reaction artifacts",
      },
      {
        workflowPath: MANTIS_DISCORD_THREAD_ATTACHMENT_WORKFLOW,
        jobName: "run_thread_attachment",
        stepName: "Upload Mantis thread attachment artifacts",
      },
      {
        workflowPath: MANTIS_SLACK_DESKTOP_SMOKE_WORKFLOW,
        jobName: "run_slack_desktop",
        stepName: "Upload Mantis Slack desktop artifacts",
      },
      {
        workflowPath: MANTIS_TELEGRAM_DESKTOP_PROOF_WORKFLOW,
        jobName: "run_telegram_desktop_proof",
        stepName: "Upload Mantis Telegram desktop artifacts",
      },
      {
        workflowPath: MANTIS_TELEGRAM_LIVE_WORKFLOW,
        jobName: "run_telegram_live",
        stepName: "Upload Mantis Telegram artifacts",
      },
      {
        workflowPath: MANTIS_WEB_UI_CHAT_PROOF_WORKFLOW,
        jobName: "run_web_ui_chat",
        stepName: "Upload Mantis web UI chat artifacts",
      },
      {
        workflowPath: NPM_TELEGRAM_WORKFLOW,
        jobName: "run_package_telegram_e2e",
        stepName: "Upload npm Telegram E2E artifacts",
      },
    ];

    for (const item of cases) {
      const label = `${item.workflowPath} ${item.jobName}`;
      const uploadStep = workflowStep(workflowJob(item.workflowPath, item.jobName), item.stepName);

      expect(uploadStep.if, label).toContain("always()");
      expect(uploadStep.uses, label).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with?.["if-no-files-found"], label).toBe("error");
    }
  });

  it("bounds Mantis Crabbox source retrieval", () => {
    const cases = [
      [MANTIS_DISCORD_STATUS_REACTIONS_WORKFLOW, "run_status_reactions"],
      [MANTIS_DISCORD_THREAD_ATTACHMENT_WORKFLOW, "run_thread_attachment"],
      [MANTIS_SLACK_DESKTOP_SMOKE_WORKFLOW, "run_slack_desktop"],
      [MANTIS_TELEGRAM_DESKTOP_PROOF_WORKFLOW, "run_telegram_desktop_proof"],
      [MANTIS_TELEGRAM_LIVE_WORKFLOW, "run_telegram_live"],
    ] as const;

    for (const [workflowPath, jobName] of cases) {
      const installStep = workflowStep(workflowJob(workflowPath, jobName), "Install Crabbox CLI");
      expect(installStep.run, workflowPath).toMatch(
        /timeout --signal=TERM --kill-after=10s 120s git (?:clone|-C .* fetch)/u,
      );
    }
  });

  it("maps every supported Slack approval checkpoint scenario family", () => {
    const workflow = readFileSync(MANTIS_SLACK_DESKTOP_SMOKE_WORKFLOW, "utf8");

    expectTextToIncludeAll(workflow, [
      'endswith("-exec-native")',
      'endswith("-plugin-native")',
      'startswith("slack-codex-")',
      'expected_result="Slack approval checkpoint passes for $scenario_label"',
    ]);
  });

  it("fails Docker E2E release lanes when summary artifacts are missing", () => {
    const cases = [
      {
        jobName: "validate_docker_e2e",
        summaryStep: "Summarize Docker E2E chunk",
        uploadStep: "Upload Docker E2E chunk artifacts",
      },
      {
        jobName: "validate_docker_lanes",
        summaryStep: "Summarize targeted Docker E2E lanes",
        uploadStep: "Upload targeted Docker E2E artifacts",
      },
      {
        jobName: "validate_docker_openwebui",
        summaryStep: "Summarize Open WebUI Docker E2E chunk",
        uploadStep: "Upload Open WebUI Docker E2E artifacts",
      },
    ];

    for (const item of cases) {
      const job = workflowJob(LIVE_E2E_WORKFLOW, item.jobName);
      const summaryStep = workflowStep(job, item.summaryStep);
      const uploadStep = workflowStep(job, item.uploadStep);

      expect(summaryStep.run, item.jobName).toContain("summary missing:");
      expect(summaryStep.run, item.jobName).toContain("exit 1");
      expect(uploadStep.with?.["if-no-files-found"], item.jobName).toBe("error");
    }
  });

  it("isolates Open WebUI release coverage on a lean large-disk runner", () => {
    const job = workflowJob(LIVE_E2E_WORKFLOW, "validate_docker_openwebui");
    const setupNode = workflowStep(job, "Setup Node environment");

    expect(job.if).toBe(
      "inputs.include_openwebui && inputs.docker_lanes == '' && (inputs.release_test_profile == 'stable' || inputs.release_test_profile == 'full')",
    );
    expect(job["runs-on"]).toBe("blacksmith-32vcpu-ubuntu-2404");
    expect(job.env?.OPENCLAW_DOCKER_ALL_RELEASE_PROFILE).toBe("${{ inputs.release_test_profile }}");
    expect(setupNode.with).toMatchObject({
      "install-bun": "false",
      "install-deps": "false",
      "use-actions-cache": "false",
    });
  });

  it("names package acceptance Telegram as artifact-backed package validation", () => {
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");

    expect(workflow).toContain("package_telegram:");
    expect(workflow).toContain("docker_acceptance_registry,");
    expect(workflow).toContain("PACKAGE_TELEGRAM_RESULT:");
    expect(workflow).toContain("package_telegram=${PACKAGE_TELEGRAM_RESULT}");
    expect(workflow).not.toContain("npm_telegram:");
  });

  it.each([
    {
      expectedOutput: undefined,
      expectedStatus: 0,
      name: "accepts Telegram result success when enabled=true",
      params: { telegramEnabled: true, telegramResult: "success" },
    },
    {
      expectedOutput: undefined,
      expectedStatus: 0,
      name: "accepts Telegram result skipped when enabled=false",
      params: { telegramEnabled: false, telegramResult: "skipped" },
    },
    {
      expectedOutput: "::error::package_telegram ended with skipped",
      expectedStatus: 1,
      name: "rejects a skipped Telegram lane when package acceptance enabled it",
      params: { telegramEnabled: true, telegramResult: "skipped" },
    },
    {
      expectedOutput: "::error::No Docker acceptance transport ran",
      expectedStatus: 1,
      name: "rejects package acceptance when no Docker transport ran",
      params: {
        dockerArtifactResult: "skipped",
        dockerRegistryResult: "skipped",
        telegramEnabled: false,
        telegramResult: "skipped",
      },
    },
    {
      expectedOutput:
        "::warning::package_telegram ended with skipped; package acceptance is advisory for this caller.",
      expectedStatus: 0,
      name: "preserves advisory handling for an unexpectedly skipped Telegram lane",
      params: { advisory: true, telegramEnabled: true, telegramResult: "skipped" },
    },
  ] as const)("$name", ({ expectedOutput, expectedStatus, params }) => {
    const result = runPackageAcceptanceSummary(params);

    expect(result.status).toBe(expectedStatus);
    if (expectedOutput) {
      expect(result.stdout).toContain(expectedOutput);
    } else {
      expect(result.stderr).toBe("");
    }
  });

  it("allows beta callers to make only Telegram package acceptance advisory", () => {
    const telegramResult = runPackageAcceptanceSummary({
      telegramAdvisory: true,
      telegramEnabled: true,
      telegramResult: "failure",
    });
    const dockerResult = runPackageAcceptanceSummary({
      dockerArtifactResult: "failure",
      telegramAdvisory: true,
      telegramEnabled: true,
      telegramResult: "success",
    });

    expect(telegramResult.status).toBe(0);
    expect(telegramResult.stdout).toContain(
      "::warning::package_telegram ended with failure; package acceptance is advisory for this caller.",
    );
    expect(dockerResult.status).toBe(1);
    expect(dockerResult.stdout).toContain("::error::docker_acceptance ended with failure");
  });

  it("gives release build steps enough Node heap", () => {
    for (const workflowPath of [LIVE_E2E_WORKFLOW, RELEASE_CHECKS_WORKFLOW]) {
      const jobs = readWorkflow(workflowPath).jobs ?? {};
      for (const [jobName, job] of Object.entries(jobs)) {
        for (const step of job.steps ?? []) {
          if (step.run === "pnpm build") {
            expect(step.env, `${workflowPath}:${jobName}:${step.name}`).toEqual({
              NODE_OPTIONS: "--max-old-space-size=8192",
            });
          }
        }
      }
    }
  });

  it("runs full release children from the trusted workflow ref", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const npmTelegramJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "npm_telegram");
    const performanceJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "performance");
    const dispatchStep = workflowStep(npmTelegramJob, "Dispatch and monitor npm Telegram E2E");

    expect(workflow).toContain("CHILD_WORKFLOW_REF: ${{ github.ref_name }}");
    expect(workflow).toContain('gh workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@" 2>&1');
    expect(npmTelegramJob.name).toBe("Run package Telegram E2E");
    expect(npmTelegramJob.needs).toEqual(["resolve_target"]);
    expect(npmTelegramJob["timeout-minutes"]).toBe(
      "${{ inputs.release_profile == 'full' && 360 || 60 }}",
    );
    expect(performanceJob["timeout-minutes"]).toBe(
      "${{ inputs.release_profile == 'full' && 360 || 120 }}",
    );
    expect(npmTelegramJob.if).toContain("inputs.rerun_group == 'npm-telegram'");
    expect(npmTelegramJob.if).not.toContain("inputs.rerun_group == 'all'");
    expect(dispatchStep.env).toEqual({
      CHILD_WORKFLOW_REF: "${{ github.ref_name }}",
      GH_TOKEN: "${{ github.token }}",
      PACKAGE_SPEC: "${{ inputs.npm_telegram_package_spec || inputs.release_package_spec }}",
      PARENT_WORKFLOW_SHA: "${{ github.sha }}",
      PROVIDER_MODE: "${{ inputs.npm_telegram_provider_mode }}",
      SCENARIO: "${{ inputs.npm_telegram_scenario }}",
      TARGET_SHA: "${{ needs.resolve_target.outputs.sha }}",
    });
    expectTextToIncludeAll(dispatchStep.run, [
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-npm-telegram"',
      'dispatch_output="$(gh workflow run npm-telegram-beta-e2e.yml --ref "$CHILD_WORKFLOW_REF" "${args[@]}" 2>&1)"',
      ".display_title == env.DISPATCH_RUN_NAME and .head_branch == env.CHILD_WORKFLOW_REF",
      "The dispatch was not retried to avoid creating a duplicate child.",
      'if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]; then',
      '-f harness_ref="$TARGET_SHA"',
      'args=(-f package_spec="$PACKAGE_SPEC"',
      'args+=(-f scenario="$SCENARIO")',
    ]);
    expect(dispatchStep.run).not.toContain("package_artifact");
    expectTextToIncludeAll(workflow, [
      "child_rerun_group=all",
      '-f rerun_group="$child_rerun_group"',
      'args+=(-f live_suite_filter="$LIVE_SUITE_FILTER")',
      'args+=(-f cross_os_suite_filter="$CROSS_OS_SUITE_FILTER")',
      'case "$RERUN_GROUP" in',
      "release-checks|install-smoke|cross-os|live-e2e|package|qa|qa-parity|qa-live)",
      "cancel-in-progress: ${{ (inputs.ref == 'main' && inputs.rerun_group == 'all') || startsWith(inputs.ref, 'tideclaw/alpha/') || startsWith(inputs.ref, 'release/') }}",
      "Verify release checks accepted Tideclaw alpha advisory lanes",
      "release_checks_advisory_only",
      "release_check_blocking_job",
      'if [[ "$RELEASE_PROFILE" == "beta" && "$1" == "Run package acceptance / Telegram package acceptance / "* ]]; then',
      'or (.name | startswith("Run QA Lab runtime-pair lane ("))',
      'or .name == "Run QA Lab live Discord lane"',
      'or (.name | startswith("Run package acceptance / Telegram package acceptance / ")))',
      "is a package-safety Tideclaw alpha release-check lane",
      '"Run package acceptance" | \\',
      '"Run package acceptance / "*)',
      'check_child "release_checks" "$RELEASE_CHECKS_RUN_ID" 1 1',
      "gh run cancel",
      "NORMAL_CI_RESULT: ${{ needs.normal_ci.result }}",
      "Sorry. Your account was suspended",
      'gh_with_retry run view "$run_id" --json status,conclusion,url,attempt,headSha,jobs',
    ]);
    expect(workflow).not.toContain("force-cancel");
    expect(workflow).not.toContain("workflow_ref:");
    expect(workflow).not.toContain("inputs.workflow_ref");
  });

  it("documents the full-release Telegram package path in operator summaries", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const releaseDocs = readFileSync("docs/reference/RELEASING.md", "utf8");
    const fullReleaseDocs = readFileSync("docs/reference/full-release-validation.md", "utf8");

    expectTextToIncludeAll(workflow, [
      "Published-package Telegram E2E:",
      "Package Telegram E2E: OpenClaw Release Checks Package Acceptance",
      "Package Telegram E2E: focused rerun requires \\`release_package_spec\\` or \\`npm_telegram_package_spec\\`",
    ]);
    expect(releaseDocs).toContain(
      "Focused `npm-telegram` reruns require `release_package_spec` or",
    );
    expectTextToIncludeAll(fullReleaseDocs, [
      "cross_os_suite_filter",
      "QA release-check failures block normal release validation",
      "input capture fails",
      "skipping the lane",
      "does not duplicate that",
      "canonical Package Acceptance Telegram E2E",
      "| `npm-telegram`      | Published-package Telegram E2E; requires `release_package_spec` or `npm_telegram_package_spec`. |",
    ]);
  });

  it("lets npm Telegram consume current-run or release-run package artifacts", () => {
    const job = workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e");
    const currentRunDownload = workflowStep(job, "Download package-under-test artifact");
    const releaseRunDownload = workflowStep(
      job,
      "Download package-under-test artifact from release run",
    );
    const validateStep = workflowStep(job, "Validate inputs and secrets");
    const identityStep = workflowStep(job, "Validate package artifact identity");
    const runStep = workflowStep(job, "Run package Telegram E2E");

    expect(currentRunDownload).toEqual({
      if: "inputs.package_artifact_name != '' && inputs.package_artifact_run_id == github.run_id",
      name: "Download package-under-test artifact",
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        "artifact-ids": "${{ inputs.package_artifact_id }}",
        "github-token": "${{ github.token }}",
        path: ".artifacts/telegram-package-under-test",
        "run-id": "${{ inputs.package_artifact_run_id }}",
      },
    });
    expect(releaseRunDownload).toEqual({
      if: "inputs.package_artifact_name != '' && inputs.package_artifact_run_id != github.run_id",
      name: "Download package-under-test artifact from release run",
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        "artifact-ids": "${{ inputs.package_artifact_id }}",
        "github-token": "${{ github.token }}",
        path: ".artifacts/telegram-package-under-test",
        "run-id": "${{ inputs.package_artifact_run_id }}",
      },
    });
    expectTextToIncludeAll(validateStep.run, [
      'if [[ -z "${PACKAGE_ARTIFACT_NAME// }" ]]; then',
      "Artifact-backed Telegram E2E requires all artifact identity fields or none.",
      "package_spec must be openclaw@alpha",
      "Artifact-backed Telegram E2E requires the complete immutable artifact and package identity tuple.",
    ]);
    expect(identityStep.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ inputs.package_artifact_digest }}",
      ARTIFACT_ID: "${{ inputs.package_artifact_id }}",
      ARTIFACT_NAME: "${{ inputs.package_artifact_name }}",
      ARTIFACT_RUN_ATTEMPT: "${{ inputs.package_artifact_run_attempt }}",
      ARTIFACT_RUN_ID: "${{ inputs.package_artifact_run_id }}",
    });
    expectTextToIncludeAll(identityStep.run, [
      "actions/artifacts/${ARTIFACT_ID}",
      '--arg digest "sha256:${ARTIFACT_DIGEST}"',
      "actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}",
      'if [[ "$ARTIFACT_RUN_ID" == "$GITHUB_RUN_ID" ]]',
      '.status == "queued" or .status == "in_progress"',
      ".conclusion == null",
      "Package Telegram artifact predates the active producer run attempt.",
      '.status == "completed"',
      '.conclusion == "success"',
      "artifact_created_at <= attempt_started_at",
      "artifact_created_at > attempt_completed_at",
      "Package Telegram artifact creation time is outside the declared producer run attempt.",
      "Package Telegram artifact producer run attempt does not match the requested tuple.",
    ]);
    expect(runStep.env).toMatchObject({
      PACKAGE_FILE_NAME: "${{ inputs.package_file_name || '' }}",
      PACKAGE_SHA256: "${{ inputs.package_sha256 || '' }}",
      PACKAGE_SOURCE_SHA: "${{ inputs.package_source_sha || '' }}",
      PACKAGE_VERSION: "${{ inputs.package_version || '' }}",
    });
    expectTextToIncludeAll(runStep.run, [
      'declared_package_tgz="${package_dir}/${PACKAGE_FILE_NAME}"',
      'manifest="${package_dir}/preflight-manifest.json"',
      'candidate_manifest="${package_dir}/package-candidate.json"',
      'find "${package_dir}" -type f -name "*.tgz"',
      "package artifact manifest contains duplicate package metadata",
      "Array.isArray(manifest.corePackageTarballs)",
      "manifest.corePackageTarballs === undefined",
      "package artifact tarball set does not match preflight manifest",
      "package candidate manifest does not match the OpenClaw tarball",
      "Package Telegram artifact SHA-256 differs from package_sha256.",
      "package candidate digest mismatch",
      "Package Telegram artifact tarball differs from package_file_name.",
      "Package Telegram artifact source SHA/version differs from the declared identity.",
      'export OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR="${package_dir}"',
      'export OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ="${package_tgz}"',
    ]);
  });

  it("accepts immutable artifacts produced earlier in the active workflow attempt", () => {
    const result = runNpmTelegramArtifactValidation({
      currentRunId: "123",
      producerConclusion: null,
      producerRunId: "123",
      producerStatus: "in_progress",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts active artifacts while GitHub still reports the workflow as queued", () => {
    const result = runNpmTelegramArtifactValidation({
      currentRunId: "123",
      producerConclusion: null,
      producerRunId: "123",
      producerStatus: "queued",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects queued artifacts after GitHub assigns a conclusion", () => {
    const result = runNpmTelegramArtifactValidation({
      currentRunId: "123",
      producerConclusion: "success",
      producerRunId: "123",
      producerStatus: "queued",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Current-run Package Telegram artifact is not from the active workflow attempt.",
    );
  });

  it("keeps completed external producer attempts success-gated", () => {
    const result = runNpmTelegramArtifactValidation({
      currentRunId: "456",
      producerConclusion: "success",
      producerRunId: "123",
      producerStatus: "completed",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects partial npm Telegram artifact identity instead of falling back to npm", () => {
    const result = runNpmTelegramInputValidation({
      PACKAGE_ARTIFACT_ID: "123",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Artifact-backed Telegram E2E requires all artifact identity fields or none.",
    );
  });

  it("uses bounded Convex lease waits instead of GitHub concurrency for CI Telegram consumers", () => {
    const telegramJobs = [
      [NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e", "Run package Telegram E2E", "600000"],
      [RELEASE_TELEGRAM_QA_WORKFLOW, "run_telegram", "Run Telegram live lane", "600000"],
      [QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_telegram", "Run Telegram live lane", "1800000"],
      [
        ".github/workflows/mantis-telegram-live.yml",
        "run_telegram_live",
        "Run Telegram live scenario and capture desktop evidence",
        "1800000",
      ],
    ] as const;

    for (const [workflowPath, jobName, stepName, acquireTimeoutMs] of telegramJobs) {
      const job = workflowJob(workflowPath, jobName);
      expect(job.concurrency).toBeUndefined();
      const step = workflowStep(job, stepName);
      expect(step.env?.OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS).toBe(acquireTimeoutMs);
    }
  });

  it("keeps release QA and repo E2E lanes off scarce 32-core runners", () => {
    const releaseChecksWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const liveE2eWorkflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");

    for (const jobName of [
      "qa_lab_parity_lane_release_checks",
      "qa_lab_parity_report_release_checks",
    ]) {
      expect(releaseChecksWorkflow).toMatch(
        new RegExp(`${jobName}:[\\s\\S]*?runs-on: ubuntu-24\\.04`, "u"),
      );
    }
    for (const jobName of [
      "trusted_identity",
      "build_candidate",
      "attest_candidate",
      "run_telegram",
      "advisory_status",
    ]) {
      expect(workflowJob(RELEASE_TELEGRAM_QA_WORKFLOW, jobName)["runs-on"]).toBe("ubuntu-24.04");
    }

    for (const jobName of [
      "run_mock_parity",
      "run_live_matrix",
      "run_live_matrix_sharded",
      "run_live_telegram",
      "run_live_discord",
      "run_live_whatsapp",
      "run_live_slack",
      "run_live_runtime_token_efficiency",
    ]) {
      expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, jobName)["runs-on"]).toBe(
        "blacksmith-16vcpu-ubuntu-2404",
      );
    }
    expectTextToIncludeAll(liveE2eWorkflow, [
      "OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=180000",
      "OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
    ]);
  });

  it("keeps release QA status artifacts blocking in the verifier", () => {
    const advisoryJobNames = [
      "qa_lab_parity_lane_release_checks",
      "qa_lab_parity_report_release_checks",
      "qa_lab_runtime_parity_release_checks",
      "qa_live_discord_release_checks",
      "qa_live_whatsapp_release_checks",
      "qa_live_slack_release_checks",
    ];

    for (const jobName of advisoryJobNames) {
      const job = workflowJob(RELEASE_CHECKS_WORKFLOW, jobName);
      expect(job["continue-on-error"], jobName).toBe(true);

      const recordStep = workflowStep(job, "Record advisory status");
      expect(recordStep.if, jobName).toBe("always()");
      expect(recordStep.run, jobName).toContain("status_path=");
      expect(recordStep.run, jobName).toContain(".artifacts/release-check-status");
      expect(recordStep.run, jobName).toContain("GITHUB_RUN_ID");
      expect(recordStep.run, jobName).toContain("GITHUB_RUN_ATTEMPT");
      expect(recordStep.run, jobName).toContain("target_sha=");
      expect(recordStep.run, jobName).toContain("variant=");
      expect(recordStep.env?.RELEASE_CHECK_TARGET_SHA, jobName).toBe(
        "${{ needs.resolve_target.outputs.revision }}",
      );
      expect(recordStep.env?.RELEASE_CHECK_STEP_OUTCOMES, jobName).toContain("upload_");

      const uploadStep = workflowStep(job, "Upload advisory status");
      expect(uploadStep.if, jobName).toBe("always()");
      expect(uploadStep.uses, jobName).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with?.name, jobName).toContain("release-check-status-");
      expect(uploadStep.with?.name, jobName).toContain(
        "${{ github.run_id }}-${{ github.run_attempt }}",
      );
      expect(uploadStep.with?.path, jobName).toMatch(
        /^\.artifacts\/release-check-status\/.+\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\.env$/u,
      );
      expect(uploadStep.with?.["if-no-files-found"], jobName).toBe("error");
    }

    const telegramCaller = workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_live_telegram_release_checks");
    const telegramDispatch = workflowStep(telegramCaller, "Dispatch and await trusted Telegram QA");
    expect(telegramDispatch.run).toContain('workflow="openclaw-release-telegram-qa.yml"');
    expect(telegramDispatch.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(telegramDispatch.run).toContain("--ref main");
    expect(telegramDispatch.run).toContain(
      '-f expected_trusted_workflow_sha="$expected_trusted_workflow_sha"',
    );
    expect(telegramDispatch.run).toContain(
      '[[ "$child_head_sha" == "$expected_trusted_workflow_sha" ]]',
    );
    expect(telegramCaller["continue-on-error"]).toBeUndefined();
    expect(telegramCaller["timeout-minutes"]).toBe(210);

    const telegramStatus = workflowJob(RELEASE_TELEGRAM_QA_WORKFLOW, "advisory_status");
    expect(telegramStatus["continue-on-error"]).toBeUndefined();
    const telegramRecord = workflowStep(telegramStatus, "Record advisory status");
    expectTextToIncludeAll(telegramRecord.run, [
      "run_id=",
      "run_attempt=",
      "target_sha=",
      "workflow_sha=",
      "job=",
      "variant=",
      "status=",
      "job_status=",
      "step_outcomes=",
    ]);
    const telegramStatusUpload = workflowStep(telegramStatus, "Upload advisory status");
    expect(telegramStatusUpload.if).toBe("always()");
    expect(telegramStatusUpload.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(telegramStatusUpload.with?.name).toBe(
      "release-check-status-qa-live-telegram-${{ inputs.target_sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(telegramStatusUpload.with?.path).toContain(
      "${{ steps.record_status.outputs.status_file }}",
    );
    expect(telegramStatusUpload.with?.["if-no-files-found"]).toBe("error");
    const telegramRequire = workflowStep(
      telegramStatus,
      "Require successful Telegram release check",
    );
    expect(telegramRequire.if).toBe("always()");
    expect(telegramRequire.run).toContain('[[ "$STATUS" == "success" ]]');

    const summary = workflowJob(RELEASE_CHECKS_WORKFLOW, "summary");
    expect(summary.needs).toContain("resolve_target");
    expect(summary.permissions?.actions).toBe("read");
    const downloadStep = workflowStep(summary, "Download advisory status artifacts");
    expect(downloadStep["continue-on-error"]).toBe(true);
    expect(downloadStep.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    expect(downloadStep.with?.pattern).toBe(
      "release-check-status-*-${{ needs.resolve_target.outputs.revision }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(downloadStep.with?.["merge-multiple"]).toBe(true);

    const verifyStep = workflowStep(summary, "Verify release check results");
    expect(verifyStep.env).toMatchObject({
      QA_LIVE_RELEASE_CHECKS_RESULT:
        "${{ needs.qa_live_release_checks.result == 'skipped' && 'skipped' || needs.qa_live_release_checks.outputs.matrix_status || 'failure' }}",
      RELEASE_CHECK_RUN_ATTEMPT: "${{ github.run_attempt }}",
      RELEASE_CHECK_RUN_ID: "${{ github.run_id }}",
      RELEASE_CHECK_TARGET_SHA: "${{ needs.resolve_target.outputs.revision }}",
    });
    expectTextToIncludeAll(verifyStep.run, [
      "release_check_result()",
      "validate_status_file()",
      "expected_status_artifact_count()",
      'actual_run_id="$(status_field "$file" run_id)"',
      'actual_run_attempt="$(status_field "$file" run_attempt)"',
      'actual_target_sha="$(status_field "$file" target_sha)"',
      'actual_job="$(status_field "$file" job)"',
      'actual_variant="$(status_field "$file" variant)"',
      "Expected ${expected_status_count} advisory status artifacts",
      "::warning::${status_count_message} Tideclaw alpha treats non-package-safety release-check lanes as advisory.",
      'elif [[ "$fallback" != "success" && "$fallback" != "skipped" ]]; then',
      'elif [[ "$fallback" == "success" ]]; then',
      "advisory_status_override_allowed()",
      'if advisory_status_override_allowed "$name"; then',
      "::warning::${name} ended with ${result}; Tideclaw alpha treats non-package-safety release-check lanes as advisory.",
      "::error::${name} ended with ${result}",
      '"qa_live_release_checks=${QA_LIVE_RELEASE_CHECKS_RESULT}"',
    ]);
    expect(verifyStep.run).not.toContain("qa_live_matrix_release_checks");
    expect(verifyStep.run).not.toContain(
      "QA release-check lanes are advisory and do not block release validation.",
    );

    const runtimeCoverage = workflowJob(
      RELEASE_CHECKS_WORKFLOW,
      "runtime_tool_coverage_release_checks",
    );
    expect(workflowStep(runtimeCoverage, "Download runtime parity status").with?.name).toBe(
      "release-check-status-qa-runtime-parity-${{ needs.resolve_target.outputs.revision }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expectTextToIncludeAll(
      workflowStep(runtimeCoverage, "Verify runtime parity producer status").run,
      ["run_id", "run_attempt", "target_sha", "job_name", "variant"],
    );
  });

  it.each([
    {
      emptyStderr: true,
      expected: [],
      name: "accepts a successful dispatched Telegram child",
      params: { currentAttempt: "2", currentResult: "success" },
      status: 0,
    },
    ...(["cancelled", "failure", "skipped"] as const).map((currentResult) => ({
      emptyStderr: false,
      expected: [`::error::qa_live_telegram_release_checks ended with ${currentResult}`],
      name: `rejects a ${currentResult} selected Telegram child`,
      params: { currentAttempt: "2", currentResult, telegramSelected: true },
      status: 1,
    })),
    {
      emptyStderr: false,
      expected: [],
      name: "accepts a skipped unselected Telegram dispatch",
      params: { currentAttempt: "2", currentResult: "skipped", telegramSelected: false },
      status: 0,
    },
    {
      emptyStderr: false,
      expected: ["::error::resolve_target ended with failure"],
      name: "keeps target resolution blocking before release children",
      params: {
        currentAttempt: "2",
        currentResult: "skipped",
        resolveResult: "failure",
        telegramSelected: false,
      },
      status: 1,
    },
    {
      emptyStderr: false,
      expected: ["qa_live_telegram_release_checks ended with cancelled", "Tideclaw alpha"],
      name: "keeps a cancelled Telegram child non-blocking for Tideclaw alpha",
      params: {
        currentAttempt: "2",
        currentResult: "cancelled",
        workflowRef: "refs/heads/tideclaw/alpha/2026-07-10-1200Z",
      },
      status: 0,
    },
  ] as const)("$name", ({ emptyStderr, expected, params, status }) => {
    const result = runReleaseChecksSummary(params);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(status);
    if (emptyStderr) {
      expect(result.stderr).toBe("");
    }
    for (const snippet of expected ?? []) {
      expect(output).toContain(snippet);
    }
  });

  it("summarizes start delay separately from execution time in full validation", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const parsedWorkflow = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const summaryJob = parsedWorkflow.jobs?.summary;
    const manifestStep = workflowStep(summaryJob ?? {}, "Write release validation manifest");

    expect(workflow).toContain("### Slowest jobs: ${label}");
    expect(workflow).toContain("### Longest start delays: ${label}");
    expect(workflow).toContain("Write release validation manifest");
    expect(workflow).toContain("PERFORMANCE_RUN_ID: ${{ needs.performance.outputs.run_id }}");
    expect(workflow).toContain("Upload release validation manifest");
    expect(workflow).toContain("Failed child detail: ${label}");
    expect(workflow).toContain("actions/runs/${run_id}/artifacts?per_page=100");
    expect(workflow).toContain("full-release-validation-${{ github.run_id }}");
    expect(workflow).toContain("| Job | Result | Start delay minutes | Run minutes |");
    expect(workflow).toContain(
      'gh_with_retry api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100"',
    );
    expect(workflow).toContain("(.started_at | ts) - (.created_at | ts)");
    expect(workflow).not.toContain('gh run view "$run_id" --json createdAt,jobs');
    expect(manifestStep.env?.PERFORMANCE_RUN_ID).toBe("${{ needs.performance.outputs.run_id }}");
    expect(manifestStep.run).toContain('--arg performanceRunId "$PERFORMANCE_RUN_ID"');
  });

  it("keeps release publish creation compatible with gh api and prerelease notes", () => {
    const workflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const npmWorkflow = readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8");
    const maintainerSkill = readFileSync(RELEASE_MAINTAINER_SKILL, "utf8");
    const fullReleaseWorkflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const resolveJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const resolveFullRun = workflowStep(resolveJob, "Resolve full release validation run");
    const resolveDownload = workflowStep(resolveJob, "Download full release validation manifest");
    const trustedTooling = workflowStep(resolveJob, "Download trusted release validation tooling");
    const validateManifest = workflowStep(resolveJob, "Validate full release validation manifest");
    const publishDownload = workflowStep(publishJob, "Download full release validation manifest");
    const publishOrchestration = workflowStep(publishJob, "Dispatch publish workflows");
    const npmPublishJob = workflowJob(
      ".github/workflows/openclaw-npm-release.yml",
      "publish_openclaw_npm",
    );
    const npmCheckout = workflowStep(npmPublishJob, "Checkout");
    const npmFullRun = workflowStep(npmPublishJob, "Verify full release validation run metadata");
    const npmDownload = workflowStep(npmPublishJob, "Download full release validation manifest");
    const npmTarget = workflowStep(npmPublishJob, "Verify full release validation target");

    expect(workflow).toContain("timeout-minutes: 120");
    expect(workflow).toContain("environment: npm-release");
    expect(workflow).toContain("Download OpenClaw npm preflight manifest");
    expect(workflow).toContain("Validate OpenClaw npm preflight manifest");
    expect(workflow).toContain("Download full release validation manifest");
    expect(workflow).toContain("Validate full release validation manifest");
    expect(workflow).toContain("scripts/validate-full-release-validation-evidence.mjs");
    expect(workflow).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(workflow).toContain("full_release_validation_run_attempt");
    expect(workflow).toContain("full_release_validation_run_id");
    expect(resolveFullRun.id).toBe("full_run");
    expect(resolveFullRun.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ inputs.full_release_validation_run_attempt }}",
    );
    expect(resolveFullRun.run).toContain(
      'run_endpoint+="/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}"',
    );
    expect(resolveFullRun.run).toContain('gh api "$run_endpoint"');
    expect(resolveJob.outputs?.full_release_validation_run_attempt).toBe(
      "${{ steps.full_run.outputs.attempt }}",
    );
    expect(resolveDownload.with?.name).toBe(
      "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ steps.full_run.outputs.attempt }}",
    );
    expect(trustedTooling.env?.WORKFLOW_SHA).toBe("${{ github.sha }}");
    expect(trustedTooling.run).toContain("validate-full-release-validation-evidence.mjs");
    expect(trustedTooling.run).toContain("release-ci-summary.mjs");
    expect(trustedTooling.run).toContain("scripts/lib/plain-gh.mjs");
    expect(validateManifest.env).toMatchObject({
      RUN_JSON_FILE: "${{ runner.temp }}/full-release-validation-run.json",
      TRUSTED_MAIN_REF: "refs/remotes/origin/main",
      VALIDATOR_FILE:
        "${{ runner.temp }}/release-validation-tooling/validate-full-release-validation-evidence.mjs",
      STRICT_VALIDATOR_FILE: "${{ runner.temp }}/release-validation-tooling/release-ci-summary.mjs",
    });
    expect(validateManifest.run).toContain(
      'MANIFEST_FILE="$manifest" node "$VALIDATOR_FILE" < "$RUN_JSON_FILE"',
    );
    expect(publishDownload.with?.name).toBe(
      "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ needs.resolve_release_target.outputs.full_release_validation_run_attempt }}",
    );
    expect(publishOrchestration.run).not.toContain("--full-release-validation-workflow-ref");
    expect(publishOrchestration.run).not.toContain("--full-release-validation-run");
    expect(publishOrchestration.run).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/release-verify-beta.ts"',
    );
    expect(publishOrchestration.run).toContain(".workflowRuns += [");
    expect(publishOrchestration.run).toContain('label: "Full Release Validation"');
    expect(publishOrchestration.run).toContain('"${validation_target_sha}" != "${TARGET_SHA}"');
    expect(publishOrchestration.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ needs.resolve_release_target.outputs.full_release_validation_run_attempt }}",
    );
    expect(publishOrchestration.run).toContain(
      '-f full_release_validation_run_attempt="${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}"',
    );
    expect(npmFullRun.id).toBe("full_run");
    expect(npmFullRun.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ inputs.full_release_validation_run_attempt }}",
    );
    expect(npmFullRun.run).toContain(
      "actions/runs/${FULL_RELEASE_VALIDATION_RUN_ID}/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}",
    );
    expect(npmFullRun.run).toContain('"$run_attempt" != "$FULL_RELEASE_VALIDATION_RUN_ATTEMPT"');
    expect(npmDownload.with?.name).toBe(
      "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ steps.full_run.outputs.attempt }}",
    );
    expect(npmTarget.env).toMatchObject({
      FULL_RELEASE_VALIDATION_RUN_ID: "${{ inputs.full_release_validation_run_id }}",
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "${{ steps.full_run.outputs.attempt }}",
    });
    expect(npmCheckout.with?.["fetch-depth"]).toBe(
      "${{ inputs.preflight_run_id != '' && 1 || 0 }}",
    );
    expect(workflow).toContain(
      "Full release validation must run rerun_group=all before npm publish",
    );
    expect(workflow).toContain(
      "publish_openclaw_npm=true requires plugin_publish_scope=all-publishable",
    );
    expect(workflow).toContain("preflight-manifest.json");
    expect(npmWorkflow).toContain("preflight-manifest.json");
    expect(npmWorkflow).toContain("Verify full release validation run metadata");
    expect(npmWorkflow).toContain("Verify full release validation target");
    expect(npmWorkflow).not.toContain("Build and smoke test final Docker runtime image");
    expect(fullReleaseWorkflow).toContain("docker_runtime_assets_preflight");
    expect(fullReleaseWorkflow).not.toContain("Build and smoke test final Docker runtime image");
    expect(fullReleaseWorkflow).toContain("docker build");
    expect(fullReleaseWorkflow).toContain("--target runtime-assets");
    expect(fullReleaseWorkflow).toContain("timeout --kill-after=30s 15m docker build");
    expect(fullReleaseWorkflow).not.toContain("node /app/openclaw.mjs agent");
    expect(fullReleaseWorkflow).toContain('OPENCLAW_EXTENSIONS="diagnostics-otel,codex"');
    expect(fullReleaseWorkflow).not.toContain("/app/src/agents/templates/HEARTBEAT.md");
    expect(fullReleaseWorkflow).toContain("inputs.rerun_group == 'all'");
    // The preflight no longer gates lane dispatch; the umbrella verifier
    // enforces its result instead.
    expect(fullReleaseWorkflow).toContain('"$DOCKER_RUNTIME_ASSETS_PREFLIGHT_RESULT" != "success"');
    expect(npmWorkflow).toContain("full_release_validation_run_id");
    expect(npmWorkflow).toContain("release_publish_run_id");
    expect(npmWorkflow).toContain("Real publish requires full_release_validation_run_id");
    expect(maintainerSkill).toContain("full_release_validation_run_id=<saved-run-id>");
    expect(maintainerSkill).toContain("full_release_validation_run_attempt=<saved-attempt>");
    expect(npmWorkflow).toContain(
      "Workflow-dispatched real publish requires release_publish_run_id",
    );
    expect(npmWorkflow).toContain("tarballSha256");
    expect(npmWorkflow).toContain("corePackageTarballs");
    expect(npmWorkflow).toContain("dependencyTarballs");
    expect(npmWorkflow).toContain("dependencyTarballs: process.env.AI_TARBALL_NAME");
    expect(npmWorkflow).toContain('packageName: "@openclaw/ai"');
    expect(npmWorkflow).toContain('packageName: "@openclaw/gateway-protocol"');
    expect(npmWorkflow).toContain('packageName: "@openclaw/gateway-client"');
    expect(npmWorkflow).toContain(
      "CORE_PACKAGE_DIRS: packages/ai packages/gateway-protocol packages/gateway-client",
    );
    expect(npmWorkflow).toContain("AI_TARBALL_SHA256");
    expect(npmWorkflow).toContain("GATEWAY_PROTOCOL_TARBALL_SHA256");
    expect(npmWorkflow).toContain("GATEWAY_CLIENT_TARBALL_SHA256");
    expect(npmWorkflow).toContain("does not match openclaw");
    expect(npmWorkflow).toContain("Frozen target does not depend on @openclaw/ai");
    expect(npmWorkflow).toContain("core-packages-SHA256SUMS");
    expect(npmWorkflow).toContain(".corePackageTarballs[] | [.packageName, .tarballName] | @tsv");
    expect(npmWorkflow).toContain('verify_args=("$TARBALL_PATH" "$PACKAGE_VERSION")');
    expect(npmWorkflow).toContain("Frozen target without an @openclaw/ai dependency");
    const npmTelegramWorkflow = readFileSync(NPM_TELEGRAM_WORKFLOW, "utf8");
    expect(npmTelegramWorkflow).toContain("preflight-manifest.json");
    expect(npmTelegramWorkflow).toContain("OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR");
    expect(npmTelegramWorkflow).toContain("package artifact digest mismatch");
    const publishSteps = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish").steps ?? [];
    const setupIndex = publishSteps.findIndex((step) => step.name === "Setup Node environment");
    const notesIndex = publishSteps.findIndex(
      (step) => step.name === "Prepare GitHub release notes",
    );
    const androidApprovalIndex = publishSteps.findIndex(
      (step) => step.name === "Write Android release approval",
    );
    const dispatchIndex = publishSteps.findIndex(
      (step) => step.name === "Dispatch publish workflows",
    );
    expect(setupIndex).toBeGreaterThan(-1);
    expect(notesIndex).toBeGreaterThan(setupIndex);
    expect(androidApprovalIndex).toBeGreaterThan(notesIndex);
    expect(dispatchIndex).toBeGreaterThan(notesIndex);
    expect(publishSteps[notesIndex]?.if).toBe("${{ inputs.publish_openclaw_npm }}");
    expect(publishSteps[notesIndex]?.run).toContain("scripts/render-github-release-notes.mjs");
    expect(workflow).toContain('git show "${TARGET_SHA}:CHANGELOG.md" > "${changelog_file}"');
    expect(workflow).not.toContain('awk -v version="${notes_version}"');
    expect(workflow).not.toContain("scripts/prepare-github-release-notes.mjs");
    expect(workflow).toContain("render_github_release_notes()");
    expect(workflow).toContain("verify_release_tag_target()");
    expect(workflow).toContain("canonical_release_body_matches()");
    expect(workflow).toContain('--notes-file "${prepared_release_notes_file}"');
    expect(workflow).not.toContain("gh api --repo");
    expect(workflow).not.toContain("timeout-minutes: 360");
  });

  it("keeps OpenClaw npm release pack tarball paths local before preflight upload", () => {
    const npmWorkflow = readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8");
    const packStepIndex = npmWorkflow.indexOf("- name: Pack prepared npm tarball");
    const copyIndex = npmWorkflow.indexOf('cp "$PACK_PATH" "$ARTIFACT_DIR/"');
    const uploadIndex = npmWorkflow.indexOf("- name: Upload prepared npm publish bundle");

    expect(packStepIndex).toBeGreaterThan(-1);
    expect(copyIndex).toBeGreaterThan(packStepIndex);
    expect(uploadIndex).toBeGreaterThan(packStepIndex);
    expect(npmWorkflow).toContain('PACK_NAME="$(node - "$PACK_OUTPUT"');
    expect(npmWorkflow).toContain("function resolveTarballFileName");
    expect(npmWorkflow).toContain('fileName.includes("\\0")');
    expect(npmWorkflow).toContain("fileName !== path.basename(fileName)");
    expect(npmWorkflow).toContain("fileName !== path.win32.basename(fileName)");
    expect(npmWorkflow).toContain("npm pack reported unsafe tarball filename");
    expect(npmWorkflow).toContain('PACK_PATH="$PWD/$PACK_NAME"');
    expect(npmWorkflow).toContain('TARBALL_NAME="$PACK_NAME"');
    expect(npmWorkflow).not.toContain("process.stdout.write(first.filename)");
    expect(npmWorkflow).not.toContain('TARBALL_NAME="$(basename "$PACK_PATH")"');
  });

  it("accepts tag-matched frozen release branches in OpenClaw npm preflight", () => {
    const preflight = workflowJob(OPENCLAW_NPM_RELEASE_WORKFLOW, "preflight_openclaw_npm");
    const metadata = workflowStep(preflight, "Validate release metadata");

    expect(metadata.run).toContain("git merge-base --is-ancestor");
    expect(metadata.run).toContain('RELEASE_BRANCH_NAME="release/${BASH_REMATCH[1]}"');
    expect(metadata.run).toContain(
      'git fetch --no-tags origin "+refs/heads/${RELEASE_BRANCH_NAME}:${RELEASE_BRANCH_REF}"',
    );
    expect(metadata.run).toContain('[[ "${RELEASE_REF}" == *"-alpha."* ]]');
  });

  it("gates stable GitHub publication on the Windows Hub release asset contract", () => {
    const releaseWorkflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const windowsWorkflow = readFileSync(WINDOWS_NODE_RELEASE_WORKFLOW, "utf8");
    const releaseDocs = readFileSync("docs/reference/RELEASING.md", "utf8");
    const releaseSkill = readFileSync(RELEASE_MAINTAINER_SKILL, "utf8");

    expect(releaseWorkflow).toContain(
      "Stable OpenClaw publish requires an explicit windows_node_tag.",
    );
    expect(releaseWorkflow).toContain(
      "Stable OpenClaw publish requires candidate-approved windows_node_installer_digests.",
    );
    expect(releaseWorkflow).toContain("promote_windows_release_assets()");
    expect(releaseWorkflow).toContain("dispatch_workflow windows-node-release.yml");
    expect(releaseWorkflow).toContain("verify_windows_release_asset_contract");
    expect(releaseWorkflow).toContain("Validate stable Windows source release");
    expect(releaseWorkflow).toContain("id: windows_source");
    expect(releaseWorkflow).toContain(
      "windows_node_installer_digests: ${{ steps.windows_source.outputs.installer_digests }}",
    );
    expect(releaseWorkflow).toContain(
      "APPROVED_INSTALLER_DIGESTS: ${{ inputs.windows_node_installer_digests }}",
    );
    expect(releaseWorkflow).toContain("no longer matches its candidate-approved digest");
    expect(releaseWorkflow).toContain(
      "WINDOWS_NODE_INSTALLER_DIGESTS: ${{ needs.resolve_release_target.outputs.windows_node_installer_digests }}",
    );
    expect(releaseWorkflow).toContain(
      '-f expected_installer_digests="${WINDOWS_NODE_INSTALLER_DIGESTS}"',
    );
    expect(releaseWorkflow).toContain("missing prevalidated Windows installer digests");
    expect(releaseWorkflow).toContain("does not match its pinned digest");
    expect(releaseWorkflow).toContain(
      "Stable release OpenClawCompanion asset names do not exactly match the current contract",
    );
    expect(releaseWorkflow).toContain('select(.name | startswith("OpenClawCompanion-"))');
    expect(releaseWorkflow).toContain(
      "Windows checksum manifest does not exactly match the installer asset contract",
    );
    expect(releaseWorkflow).toContain("Windows checksum manifest contains malformed entries");
    expect(releaseWorkflow).toContain("([.[].name] | unique | length) == length");
    expect(releaseWorkflow).toContain("Windows checksum manifest does not match pinned digest");
    expect(releaseWorkflow).toContain(
      "Windows source release ${WINDOWS_NODE_TAG} must contain exactly one required asset",
    );
    expect(releaseWorkflow.indexOf("Validate stable Windows source release")).toBeLessThan(
      releaseWorkflow.indexOf("\n  publish:\n"),
    );

    const createDraftCall = releaseWorkflow.lastIndexOf(
      "\n            create_or_update_github_release\n",
    );
    const promoteWindowsCall = releaseWorkflow.lastIndexOf(
      "\n              if promote_windows_release_assets; then\n",
    );
    const publishReleaseCall = releaseWorkflow.lastIndexOf(
      "\n              publish_github_release\n",
    );
    expect(createDraftCall).toBeGreaterThan(-1);
    expect(promoteWindowsCall).toBeGreaterThan(createDraftCall);
    expect(publishReleaseCall).toBeGreaterThan(promoteWindowsCall);

    expect(windowsWorkflow).not.toContain("default: latest");
    expect(windowsWorkflow).toContain("expected_installer_digests:");
    expect(windowsWorkflow).toContain("expected_installer_digests must contain exactly");
    expect(windowsWorkflow).toContain("must be an explicit openclaw-windows-node release tag");
    expect(windowsWorkflow).toContain("$installerPatterns = @(");
    expect(windowsWorkflow).toContain("Every matched installer is signature-checked");
    expect(windowsWorkflow).toContain("Get-ChildItem -LiteralPath dist -File");
    expect(windowsWorkflow).toContain(
      "Downloaded Windows source asset does not match pinned digest",
    );
    expect(windowsWorkflow).toContain(
      "--repo openclaw/openclaw-windows-node --json tagName,isDraft,isPrerelease,assets,url",
    );
    expect(windowsWorkflow).toContain(
      "Windows source release must contain exactly one required asset",
    );
    expect(windowsWorkflow).toContain(
      "Windows source release asset digest does not match the pinned digest",
    );
    expect(windowsWorkflow).toContain(
      "CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US",
    );
    expect(windowsWorkflow).toContain("has unexpected signer subject");
    expect(windowsWorkflow).toContain("OpenClawCompanion-SHA256SUMS.txt");
    expect(windowsWorkflow).toContain("Verify promoted release asset contract");
    expect(windowsWorkflow).toContain(
      "Promoted OpenClawCompanion asset names do not exactly match the current contract",
    );
    expect(windowsWorkflow).toContain(
      "$targetRelease = gh release view $env:RELEASE_TAG --repo $env:GITHUB_REPOSITORY --json assets",
    );
    expect(windowsWorkflow).toContain("Promoted Windows SHA-256 manifest does not match");
    expect(windowsWorkflow).toContain("Promoted Windows release asset checksum mismatch");
    expect(releaseDocs).toContain(
      "the selected `windows_node_tag`, its saved `windows_node_installer_digests`,",
    );
    expect(releaseDocs).toContain(
      "candidate-approved `windows_node_installer_digests`, and verify the canonical",
    );
    expect(releaseSkill).toContain(
      "candidate-approved installer digest map as `windows_node_installer_digests`.",
    );
  });

  it("gates stable GitHub publication on the signed Android APK contract", () => {
    const releaseWorkflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const androidWorkflow = readFileSync(ANDROID_RELEASE_WORKFLOW, "utf8");
    const androidDocs = readFileSync("docs/platforms/android.md", "utf8");
    const releaseDocs = readFileSync("docs/reference/RELEASING.md", "utf8");
    const approvalScript = readFileSync("scripts/validate-release-publish-approval.mjs", "utf8");

    expect(androidWorkflow).toContain("environment: android-release");
    expect(androidWorkflow).toContain(
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
    );
    expect(androidWorkflow).toContain("repositories: apps-signing");
    expect(androidWorkflow).toContain("permission-contents: read");
    expect(androidWorkflow).toContain("--mode materialize");
    expect(androidWorkflow).not.toContain("APPS_SIGNING_DEPLOY_KEY");
    expect(androidWorkflow).toContain("MATCH_PASSWORD");
    expect(androidWorkflow).toContain("scripts/validate-release-publish-approval.mjs");
    expect(releaseWorkflow).toContain("Write Android release approval");
    expect(releaseWorkflow).toContain("Attest Android release approval");
    expect(releaseWorkflow).toContain("Upload Android release approval");
    expect(releaseWorkflow).toContain("android-release-approval-${{ github.run_id }}");
    expect(releaseWorkflow).toContain("parentRunId: process.env.RELEASE_PUBLISH_RUN_ID");
    expect(releaseWorkflow).toContain("releaseTag: process.env.RELEASE_TAG");
    expect(releaseWorkflow).toContain("targetSha: process.env.TARGET_SHA");
    expect(androidWorkflow).toContain("Download parent release approval");
    expect(androidWorkflow).toContain(
      "android-release-approval-${{ inputs.release_publish_run_id }}",
    );
    expect(androidWorkflow).toContain(
      '--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/openclaw-release-publish.yml"',
    );
    expect(androidWorkflow).toContain('--source-ref "refs/heads/${EXPECTED_WORKFLOW_BRANCH}"');
    expect(approvalScript).toContain(
      "Attested Android release approval does not match this run request.",
    );
    expect(androidWorkflow).toContain('--artifact", "third-party');
    expect(androidWorkflow).toContain("OpenClaw-Android.apk");
    expect(androidWorkflow).toContain("OpenClaw-Android-SHA256SUMS.txt");
    expect(androidWorkflow).toContain("actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6");
    expect(androidWorkflow).toContain("--signer-workflow");
    expect(androidWorkflow).toContain('--source-ref "refs/tags/${RELEASE_TAG}"');
    expect(androidWorkflow).toContain("--deny-self-hosted-runners");
    expect(androidWorkflow).toContain("--verify-apk");
    expect(androidWorkflow).toContain('expected_source_ref="refs/tags/${RELEASE_TAG}"');
    expect(androidWorkflow).toContain("release_target_sha must be a full lowercase commit SHA");
    expect(androidWorkflow).toContain("does not match ${RELEASE_TAG} (${tag_sha})");
    expect(androidWorkflow).toContain(
      "must resolve to the same source commit as ${fallback_base_tag}",
    );
    expect(androidWorkflow).toContain("FALLBACK_ANDROID_BASE_TAG");
    expect(androidWorkflow).toContain("FALLBACK_ANDROID_BASE_SHA");
    expect(androidWorkflow).toContain('--source-digest "${FALLBACK_ANDROID_BASE_SHA}"');
    expect(androidWorkflow).toContain("steps.release_source.outputs.fallback_base_tag == ''");
    expect(androidWorkflow).toContain(
      "OPENCLAW_BUILD_TIMESTAMP: ${{ steps.release_approval.outputs.build_timestamp }}",
    );
    expect(androidWorkflow).toContain("GIT_COMMIT: ${{ inputs.release_target_sha }}");
    expect(androidWorkflow).toContain("--json tagName,isDraft,isPrerelease,createdAt,assets,url");
    expect(androidWorkflow).toContain("release_created_at=");
    expect(androidWorkflow).toContain(
      "Reusing verified Android APK from ${FALLBACK_ANDROID_BASE_TAG}",
    );
    expect(androidWorkflow).toContain("Existing Android release asset ${asset_name} differs");
    expect(androidWorkflow).not.toContain("--clobber");

    expect(releaseWorkflow).toContain("promote_android_release_asset()");
    expect(releaseWorkflow).toContain("is_android_release()");
    expect(androidWorkflow).toContain("requires a final or correction OpenClaw release tag");
    expect(androidWorkflow).toContain("previous_version_code");
    expect(androidWorkflow).toContain("must exceed ${previous_tag} versionCode");
    expect(androidWorkflow).toContain("standalone channel bootstrap");
    expect(releaseWorkflow).toContain(
      'dispatch_workflow_at_ref "${RELEASE_TAG}" "${TARGET_SHA}" android-release.yml',
    );
    expect(releaseWorkflow).toContain('-f release_target_sha="${TARGET_SHA}"');
    expect(releaseWorkflow).toContain("verify_android_release_asset_contract");
    expect(releaseWorkflow).toContain("Android release APK digest does not match");
    expect(releaseWorkflow).toContain("Android APK asset contract: verified");

    const createDraftCall = releaseWorkflow.lastIndexOf(
      "\n            create_or_update_github_release\n",
    );
    const promoteAndroidCall = releaseWorkflow.lastIndexOf(
      "\n              if promote_android_release_asset; then\n",
    );
    const publishReleaseCall = releaseWorkflow.lastIndexOf(
      "\n              publish_github_release\n",
    );
    expect(createDraftCall).toBeGreaterThan(-1);
    expect(promoteAndroidCall).toBeGreaterThan(createDraftCall);
    expect(publishReleaseCall).toBeGreaterThan(promoteAndroidCall);

    expect(androidDocs).toContain("github.com/openclaw/openclaw/releases");
    expect(androidDocs).not.toContain("releases/latest/download/OpenClaw-Android.apk");
    expect(androidDocs).toContain("gh attestation verify OpenClaw-Android.apk");
    expect(androidDocs).toContain('--source-ref "refs/tags/${release_tag}"');
    expect(releaseDocs).toContain("signed standalone Android APK");
  });

  it("rejects malformed Windows checksum manifest lines before parsing entries", () => {
    const releaseWorkflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const validateManifestLinesIndex = releaseWorkflow.indexOf("all(.[]; test(");
    const parseManifestLinesIndex = releaseWorkflow.indexOf("map(capture(");

    expect(validateManifestLinesIndex).toBeGreaterThan(-1);
    expect(parseManifestLinesIndex).toBeGreaterThan(validateManifestLinesIndex);
    expect(releaseWorkflow).toContain('else error("malformed Windows checksum manifest entry")');
  });

  it("rejects unsafe direct Windows recovery before uploading assets", () => {
    const windowsWorkflow = readFileSync(WINDOWS_NODE_RELEASE_WORKFLOW, "utf8");
    const classifyStableReleaseIndex = windowsWorkflow.indexOf("$stableRelease = -not (");
    const rejectPrereleaseSourceIndex = windowsWorkflow.indexOf(
      "if ($stableRelease -and $sourceRelease.isPrerelease)",
    );
    const rejectUnexpectedTargetAssetsIndex = windowsWorkflow.indexOf(
      "Target OpenClaw release contains unexpected OpenClawCompanion assets before upload",
    );
    const uploadAssetsIndex = windowsWorkflow.indexOf("gh release upload $env:RELEASE_TAG");

    expect(classifyStableReleaseIndex).toBeGreaterThan(-1);
    expect(rejectPrereleaseSourceIndex).toBeGreaterThan(classifyStableReleaseIndex);
    expect(windowsWorkflow).not.toContain("-not $targetRelease.isPrerelease");
    expect(rejectUnexpectedTargetAssetsIndex).toBeGreaterThan(-1);
    expect(uploadAssetsIndex).toBeGreaterThan(rejectUnexpectedTargetAssetsIndex);
  });

  it("keeps beta release verification and ClawHub publish repair hooks wired", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const releaseWorkflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const clawHubWorkflow = readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8");
    const clawHubNewWorkflow = readFileSync(".github/workflows/plugin-clawhub-new.yml", "utf8");
    const pluginNpmWorkflow = readFileSync(PLUGIN_NPM_RELEASE_WORKFLOW, "utf8");
    const openclawNpmWorkflow = readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8");
    const fastPretagScript = readFileSync("scripts/release-fast-pretag-check.sh", "utf8");
    const pluginPretagPackScript = readFileSync(
      "scripts/plugin-release-pretag-pack-check.ts",
      "utf8",
    );
    const approvalScript = readFileSync("scripts/validate-release-publish-approval.mjs", "utf8");
    const clawHubReleasePlanScript = readFileSync(
      "scripts/lib/openclaw-release-clawhub-plan.ts",
      "utf8",
    );
    const clawHubResolveRefIndex = clawHubWorkflow.indexOf("- name: Resolve checked-out ref");
    const clawHubValidateRefIndex = clawHubWorkflow.indexOf(
      "- name: Validate ref is on a trusted publish branch",
    );
    const clawHubSetupIndex = clawHubWorkflow.indexOf("- name: Setup Node environment");
    const clawHubMetadataIndex = clawHubWorkflow.indexOf(
      "- name: Validate publishable plugin metadata",
    );
    const releasePublishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const releaseInputGuard =
      workflowStep(
        workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target"),
        "Validate inputs",
      ).run ?? "";
    const trustedReleaseToolingCheckout = workflowStep(
      releasePublishJob,
      "Checkout trusted release tooling",
    );
    const releaseNodeSetup = workflowStep(releasePublishJob, "Setup Node environment");
    const trustedReleaseToolingInstall = workflowStep(
      releasePublishJob,
      "Install trusted release tooling dependencies",
    );
    const trustedClawHubPlan = workflowStep(releasePublishJob, "Resolve ClawHub release plan");
    const attestClawHubApproval = workflowStep(
      releasePublishJob,
      "Attest ClawHub bootstrap approval",
    );

    expect(packageJson.scripts?.["release:verify-beta"]).toBe(
      "node --import tsx scripts/release-verify-beta.ts",
    );
    expect(packageJson.scripts?.["release:candidate"]).toBe(
      "node scripts/release-candidate-checklist.mjs",
    );
    expect(packageJson.scripts?.["release:beta"]).toBe(
      "node scripts/release-candidate-checklist.mjs",
    );
    expect(packageJson.scripts?.["release:fast-pretag-check"]).toBe(
      "bash scripts/release-fast-pretag-check.sh",
    );
    expect(releaseNodeSetup.with?.["install-deps"]).toBe("false");
    expect(trustedReleaseToolingInstall.run).toContain("--dir .release-harness");
    expect(trustedReleaseToolingInstall.run).toContain("--frozen-lockfile");
    expect(trustedReleaseToolingInstall.run).toContain(
      "ln -s .release-harness/node_modules node_modules",
    );
    expect(trustedClawHubPlan["continue-on-error"]).toContain("contains(inputs.tag, '-beta.')");
    expect(attestClawHubApproval["continue-on-error"]).toContain("contains(inputs.tag, '-beta.')");
    expect(fastPretagScript).toContain(
      "node --import tsx scripts/plugin-release-pretag-pack-check.ts",
    );
    expect(fastPretagScript).not.toContain(
      "check-plugin-npm-runtime-builds.mjs --package extensions/diffs-language-pack",
    );
    expect(pluginPretagPackScript).toContain("scripts/check-plugin-npm-runtime-builds.mjs");
    expect(pluginPretagPackScript).toContain("scripts/plugin-npm-publish.sh");
    expect(pluginPretagPackScript).toContain("scripts/plugin-clawhub-publish.sh");
    expect(clawHubWorkflow).toContain('CLAWHUB_CLI_PACKAGE: "clawhub@0.23.1"');
    expect(clawHubWorkflow).not.toContain("CLAWHUB_REPOSITORY:");
    expect(clawHubWorkflow).not.toContain("CLAWHUB_REF:");
    expect(clawHubWorkflow).toContain("pack_plugins_clawhub_artifacts:");
    expect(clawHubWorkflow).toContain("Verify package-local runtime build");
    expect(clawHubWorkflow).toContain("Install pinned ClawHub CLI wrapper");
    expect(clawHubWorkflow).toContain("Pack ClawHub package artifact");
    expect(clawHubWorkflow).toContain("Upload ClawHub package artifact");
    expect(clawHubWorkflow).toContain("Validate OIDC source matches workflow ref");
    expect(clawHubWorkflow).toContain(
      "Dry-run target ref to validate; real OIDC publishes must dispatch the workflow with --ref set to the target release tag/ref",
    );
    expect(clawHubWorkflow).toContain(
      "Plugin ClawHub OIDC publishes must run from the same ref that is being published.",
    );
    expect(clawHubWorkflow).toContain("The ref input is only supported for dry_run=true.");
    expect(clawHubWorkflow).toContain(
      "Dry-run publish target differs from workflow ref; allowing validation-only dispatch.",
    );
    expect(clawHubWorkflow).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.dry_run != true && inputs.publish_scope == 'selected' && steps.plan.outputs.skipped_published_count != '0'",
    );
    expect(clawHubWorkflow).toContain(
      "uses: openclaw/clawhub/.github/workflows/package-publish.yml@d8096dfc039e86ab942ddf9ef117d04849fd84c1",
    );
    expect(clawHubWorkflow).toContain(
      'family: ${{ contains(fromJson(\'["@openclaw/acpx","@openclaw/diffs","@openclaw/feishu","@openclaw/qqbot"]\'), matrix.plugin.packageName) && \'bundle-plugin\' || \'\' }}',
    );
    expect(clawHubWorkflow).toContain("dry_run:");
    expect(clawHubWorkflow).toContain("default: false");
    expect(clawHubWorkflow).not.toContain("approve_plugin_clawhub_release:");
    expect(clawHubWorkflow).toContain("approve_plugins_clawhub_release:");
    expect(clawHubWorkflow).toContain("environment: clawhub-plugin-release");
    expect(clawHubWorkflow).toContain("inputs.dry_run != true");
    expect(clawHubWorkflow).toContain("release_publish_branch:");
    expect(clawHubWorkflow).toContain(
      "TRUSTED_PUBLISH_BRANCH: ${{ inputs.release_publish_branch || github.ref_name }}",
    );
    expect(clawHubWorkflow).toContain(
      "EXPECTED_WORKFLOW_BRANCH: ${{ inputs.release_publish_branch || github.ref_name }}",
    );
    expect(clawHubWorkflow).toContain(
      "always() && github.event_name == 'workflow_dispatch' && needs.preview_plugins_clawhub.outputs.has_candidates == 'true' && needs.pack_plugins_clawhub_artifacts.result == 'success' && (inputs.dry_run == true || needs.approve_plugins_clawhub_release.result == 'success')",
    );
    expect(clawHubWorkflow).toContain("package_artifact_name: ${{ matrix.plugin.artifactName }}");
    expect(clawHubWorkflow).toContain("source_repo: ${{ github.repository }}");
    expect(clawHubWorkflow).toContain(
      "source_commit: ${{ needs.preview_plugins_clawhub.outputs.ref_revision }}",
    );
    expect(clawHubWorkflow).toContain("source_ref: ${{ github.ref }}");
    expect(clawHubWorkflow).toContain("source_path: ${{ matrix.plugin.packageDir }}");
    expect(clawHubWorkflow).toContain(
      "inspector_artifact_name: ${{ matrix.plugin.artifactName }}-inspector",
    );
    expect(clawHubWorkflow).toContain(
      "publish_json_artifact_name: ${{ matrix.plugin.artifactName }}-publish-json",
    );
    expect(clawHubWorkflow).toContain("tags: ${{ matrix.plugin.publishTag }}");
    expect(clawHubWorkflow).toContain("dry_run: ${{ inputs.dry_run }}");
    expect(clawHubWorkflow).not.toContain("secrets.CLAWHUB_TOKEN");
    expect(clawHubWorkflow).not.toContain("clawhub_token:");
    expect(clawHubWorkflow).toContain("bootstrapCandidates");
    expect(clawHubWorkflow).toContain("missingTrustedPublisher");
    expect(clawHubWorkflow).toContain("bootstrap_candidate_count");
    expect(clawHubWorkflow).toContain("missing_trusted_publisher_count");
    expect(clawHubWorkflow).toContain("Bootstrap candidates requiring token bootstrap:");
    expect(clawHubWorkflow).toContain("Missing trusted publisher candidates:");
    expect(clawHubWorkflow).toContain("verify_published_clawhub_packages:");
    expect(clawHubWorkflow).toContain("inputs.dry_run != true");
    expect(clawHubWorkflow).toContain("Verify published ClawHub package");
    const clawHubVerifier = workflowJob(
      PLUGIN_CLAWHUB_RELEASE_WORKFLOW,
      "verify_published_clawhub_packages",
    );
    expect(clawHubVerifier["timeout-minutes"]).toBe(60);
    expect(clawHubVerifier.strategy).toBeUndefined();
    expect(clawHubVerifier.env).toMatchObject({
      OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS: "54",
      OPENCLAW_CLAWHUB_VERIFY_CONCURRENCY: "8",
      OPENCLAW_CLAWHUB_VERIFY_DELAY_MS: "30000",
    });
    expect(clawHubVerifier.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(workflowStep(clawHubVerifier, "Download published package inputs")).toMatchObject({
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        pattern: "clawhub-package-*",
        path: "${{ runner.temp }}/clawhub-package-artifacts",
        "merge-multiple": false,
      },
    });
    const clawHubVerifyRun = workflowStep(clawHubVerifier, "Verify published ClawHub packages").run;
    expectTextToIncludeAll(clawHubVerifyRun, [
      "scripts/verify-clawhub-release-batch.mjs",
      '--plan "${RUNNER_TEMP}/clawhub-batch-evidence/plan.json"',
      '--artifacts-root "${RUNNER_TEMP}/clawhub-package-artifacts"',
      '--registry "${CLAWHUB_REGISTRY}"',
      '--output "${RUNNER_TEMP}/clawhub-batch-evidence/evidence.json"',
    ]);
    expect(clawHubVerifyRun).not.toContain("fetchWithRetry");
    expect(clawHubVerifyRun).not.toContain(".json()");
    expect(clawHubVerifyRun).not.toContain('method: "HEAD"');
    expect(clawHubWorkflow).not.toContain("bash scripts/plugin-clawhub-publish.sh --publish");
    expect(clawHubWorkflow).not.toContain("Write ClawHub token config");
    expect(clawHubWorkflow).not.toContain("Checkout ClawHub CLI source");
    expect(clawHubWorkflow).not.toContain("packages/clawhub/src/cli.ts");
    expect(clawHubWorkflow).not.toContain(
      "bun install failed while preparing ClawHub CLI; retrying",
    );
    expect(clawHubWorkflow).toContain("max-parallel: 32");
    expect(clawHubResolveRefIndex).toBeGreaterThanOrEqual(0);
    expect(clawHubValidateRefIndex).toBeGreaterThan(clawHubResolveRefIndex);
    expect(clawHubSetupIndex).toBeGreaterThan(clawHubValidateRefIndex);
    expect(clawHubMetadataIndex).toBeGreaterThan(clawHubSetupIndex);
    expect(releaseWorkflow).toContain("Plugin npm run ID");
    expect(releaseWorkflow).toContain("Plugin ClawHub run ID");
    expect(releaseWorkflow).not.toContain(
      "did not return an Actions run URL; refusing to guess from recent workflow_dispatch runs",
    );
    expect(releaseWorkflow).toContain("return_run_details: true");
    expect(releaseWorkflow).toContain("'.workflow_run_id'");
    expect(releaseWorkflow).toContain("'.html_url'");
    expect(releaseWorkflow).toContain(
      'gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json headSha,url',
    );
    expect(releaseWorkflow).not.toContain("BEFORE_IDS=");
    expect(releaseWorkflow).not.toContain("before_json");
    expect(releaseWorkflow).toContain("plugin-clawhub-new.yml");
    expect(releaseWorkflow).toContain("Plugin ClawHub bootstrap run ID");
    expect(releaseWorkflow).toContain("scripts/openclaw-release-clawhub-plan.ts");
    expect(releaseWorkflow).toContain("scripts/openclaw-release-clawhub-runtime-state.ts");
    expect(isExecutable("scripts/openclaw-release-clawhub-plan.ts")).toBe(true);
    expect(isExecutable("scripts/openclaw-release-clawhub-runtime-state.ts")).toBe(true);
    expect(releaseWorkflow).toContain("openclaw-release-clawhub-plan.json");
    expect(trustedReleaseToolingCheckout.with).toMatchObject({
      ref: "${{ github.sha }}",
      path: ".release-harness",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(releaseWorkflow).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-release-clawhub-plan.ts"',
    );
    expect(trustedClawHubPlan.run).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-release-clawhub-plan.ts"',
    );
    expect(trustedClawHubPlan.run).toContain('--release-sha "${TARGET_SHA}"');
    expect(trustedClawHubPlan.run).toContain(
      '--release-publish-run-attempt "${GITHUB_RUN_ATTEMPT}"',
    );
    expect(trustedClawHubPlan.run).toContain(
      '--bootstrap-workflow-ref "${BOOTSTRAP_WORKFLOW_REF}"',
    );
    expect(trustedClawHubPlan.run).toContain(
      '--bootstrap-workflow-sha "${bootstrap_workflow_sha}"',
    );
    expect(trustedClawHubPlan.run).toContain('if [[ "${BOOTSTRAP_WORKFLOW_REF}" == "main" ]]');
    expect(trustedClawHubPlan.run).toContain('bootstrap_workflow_sha="${GITHUB_SHA}"');
    expect(trustedClawHubPlan.run).toContain(".bootstrap.ref == $bootstrap_ref");
    expect(trustedClawHubPlan.run).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
    );
    expect(trustedClawHubPlan.run).toContain(
      "jq -er '.bootstrap.shouldDispatch | select(type == \"boolean\") | tostring'",
    );
    expect(trustedClawHubPlan.run).not.toContain("cd .release-harness");
    expect(releaseWorkflow).toContain("Attest ClawHub bootstrap approval");
    expect(releaseWorkflow).toContain("Upload ClawHub bootstrap approval");
    expect(releaseWorkflow).toContain(
      "clawhub-bootstrap-approval-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(releaseWorkflow).toContain("parentWorkflowSha: process.env.GITHUB_SHA");
    expect(releaseWorkflow).toContain("bootstrapWorkflowSha: plan.bootstrapWorkflowSha");
    expect(releaseWorkflow).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-release-clawhub-runtime-state.ts"',
    );
    expect(releaseWorkflow).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/release-verify-beta.ts"',
    );
    expect(releaseWorkflow).toContain("openclaw-release-clawhub-runtime-state");
    expect(releaseWorkflow).toContain("bootstrap_plugins");
    expect(releaseWorkflow).toContain("missing_trusted_plugins");
    expect(releaseWorkflow).toContain(".summary.bootstrapPlugins");
    expect(releaseWorkflow).toContain(".summary.missingTrustedPlugins");
    expect(releaseWorkflow).toContain("append_clawhub_dispatch_args");
    expect(releaseWorkflow).toContain("write_clawhub_runtime_state");
    expect(releaseWorkflow).toContain(".[$target].inputs | to_entries[]");
    expect(releaseWorkflow).toContain(".verifierArgs[]");
    expect(releaseWorkflow).toContain(".proofLines.normal");
    expect(releaseWorkflow).toContain(".proofLines.bootstrap");
    expect(releaseWorkflow).toContain("Bootstrap/repair candidates:");
    expect(releaseWorkflow).toContain("Trusted-publisher repair plugins:");
    expect(releaseWorkflow).toContain(
      'echo "- ClawHub bootstrap workflow ref: \\`${bootstrap_summary_ref}\\` at \\`${bootstrap_summary_sha}\\`"',
    );
    expect(releaseWorkflow).toContain(
      "Waiting for plugin-clawhub-new.yml bootstrap to finish before continuing release publish.",
    );
    expect(releaseWorkflow).toContain(
      "refusing environment approval because the child workflow SHA is not approved",
    );
    const verifyBootstrapWorkflowIndex = releaseWorkflow.indexOf(
      'bootstrap_workflow_sha="$(verify_bootstrap_workflow_sha)"',
    );
    expect(releaseWorkflow).toContain('if [[ "${approved_ref}" == "main" ]]');
    expect(releaseWorkflow).toContain('[[ "${approved_ref}" == "${CHILD_WORKFLOW_REF}" ]]');
    expect(releaseWorkflow).toContain('[[ "${approved_sha}" == "${PARENT_WORKFLOW_SHA}" ]]');
    expect(releaseWorkflow).toContain(
      "Trusted main moved from approved ClawHub bootstrap workflow SHA",
    );
    const dispatchPluginNpmIndex = releaseWorkflow.indexOf(
      'plugin_npm_run_id="$(dispatch_workflow plugin-npm-release.yml',
    );
    expect(verifyBootstrapWorkflowIndex).toBeGreaterThan(-1);
    expect(dispatchPluginNpmIndex).toBeGreaterThan(verifyBootstrapWorkflowIndex);
    expect(releaseWorkflow).toContain("OpenClaw npm run ID");
    expect(releaseWorkflow).toContain("npm_telegram_run_id");
    expect(releaseWorkflow).toContain('release_publish_run_id="${GITHUB_RUN_ID}"');
    expect(releaseWorkflow).toContain("append_release_proof_to_github_release");
    expect(releaseWorkflow).toContain(
      'render_github_release_notes "${notes_file}" "${proof_file}" "${metadata_file}"',
    );
    expect(releaseWorkflow).toContain(".verificationIncluded == true");
    expect(releaseWorkflow).not.toContain("Release verification tail omitted");
    expect(releaseWorkflow).toContain("guard_existing_public_release");
    expect(releaseWorkflow).toContain(
      "already has a public GitHub release page without complete postpublish evidence",
    );
    expect(releaseWorkflow).toContain("resolve_openclaw_npm_publish_state");
    expect(releaseWorkflow).toContain(
      "already published on npm with this tag's preflight tarball; resuming from",
    );
    expect(releaseWorkflow).toContain("Cut a correction tag instead of resuming this publish.");
    expect(
      releaseWorkflow.match(/assets already promoted and verified; skipping dispatch/g),
    ).toHaveLength(2);
    expect(releaseWorkflow).toContain("registry tarball");
    expect(releaseWorkflow).toContain("openclawNpmTarball");
    // The release proof must cite the verified evidence tarball; the only
    // direct registry tarball query is the resume identity check.
    expect(
      releaseWorkflow.match(/npm view "openclaw@\$\{release_version\}" dist\.tarball/g),
    ).toHaveLength(1);
    expect(releaseWorkflow).toContain("release SHA");
    expect(clawHubReleasePlanScript).toContain("not awaited by this proof");
    expect(releaseWorkflow).toContain("wait_for_job_success");
    expect(releaseWorkflow).toContain("Validate release publish approval");
    expect(releaseWorkflow).toContain("approve_clawhub_bootstrap_environments");
    expect(releaseWorkflow).toContain(
      '"Validate release publish approval" \\\n              "${expected_sha}" || return 1',
    );
    expect(releaseWorkflow).toContain(
      'approve_child_publish_environment plugin-clawhub-new.yml "${run_id}" "${expected_sha}" || return 1',
    );
    expect(releaseWorkflow).toContain(
      '"Validate immutable bootstrap handoff" \\\n              "${expected_sha}" || return 1',
    );
    const firstBootstrapApproval = releaseWorkflow.indexOf(
      'approve_child_publish_environment plugin-clawhub-new.yml "${run_id}" "${expected_sha}"',
    );
    const protectedBootstrapValidation = releaseWorkflow.indexOf(
      '"Validate immutable bootstrap handoff"',
      firstBootstrapApproval,
    );
    const secondBootstrapApproval = releaseWorkflow.indexOf(
      'approve_child_publish_environment plugin-clawhub-new.yml "${run_id}" "${expected_sha}"',
      firstBootstrapApproval + 1,
    );
    expect(firstBootstrapApproval).toBeGreaterThan(-1);
    expect(protectedBootstrapValidation).toBeGreaterThan(firstBootstrapApproval);
    expect(secondBootstrapApproval).toBeGreaterThan(protectedBootstrapValidation);
    expect(releaseWorkflow).toContain('conclusion" == "skipped"');
    expect(releaseWorkflow).toContain("approve_child_publish_environment");
    expect(releaseWorkflow).toContain("Approve child release gate after parent release approval");
    expect(releaseWorkflow).toContain("openclaw_npm_resume_run_id");
    expect(releaseWorkflow).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-npm-resume-run.mjs"',
    );
    expect(releaseWorkflow).toContain('--run-id "${OPENCLAW_NPM_RESUME_RUN_ID}"');
    expect(releaseWorkflow).toContain("openclaw_npm_expected_workflow_ref=\"$(printf '%s'");
    expect(releaseWorkflow).toContain("openclaw_npm_expected_workflow_sha=\"$(printf '%s'");
    expect(releaseWorkflow).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-npm-postpublish-verify.ts"',
    );
    expect(releaseWorkflow).toContain(
      '"${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-npm-postpublish-verify.ts"',
    );
    expect(releaseWorkflow).toContain("--postpublish-verifier");
    expect(releaseWorkflow).toContain('"${verify_args[@]}"');
    expect(releaseWorkflow).toContain(
      "OpenClaw Release Publish must use trusted main workflow tooling",
    );
    expect(releaseInputGuard).toContain(
      '[[ "${WORKFLOW_REF}" != "refs/heads/main" && "${tideclaw_alpha_publish}" != "true" && "${sha_pinned_release_publish}" != "true" ]]',
    );
    expect(releaseInputGuard).toContain("refs/tags/release-publish/");
    expect(releaseInputGuard).not.toContain("refs/heads/release/");
    expect(releaseInputGuard).toContain(
      '"${RELEASE_TAG}" == *"-alpha."* && "${RELEASE_NPM_DIST_TAG}" == "alpha"',
    );
    expect(releaseWorkflow).toContain('--workflow-ref "${CHILD_WORKFLOW_REF}"');
    expect(releaseWorkflow).toContain('openclaw_npm_expected_workflow_ref="${GITHUB_REF}"');
    expect(releaseWorkflow).toContain(
      'openclaw_npm_expected_workflow_sha="${PARENT_WORKFLOW_SHA}"',
    );
    expect(releaseWorkflow).toContain(
      'OPENCLAW_NPM_EXPECTED_WORKFLOW_REF="${openclaw_npm_expected_workflow_ref}"',
    );
    expect(releaseWorkflow).toContain('if [[ "${PUBLISH_OPENCLAW_NPM}" == "true" ]]');
    expect(releaseWorkflow).toContain("--skip-github-release");
    expect(clawHubReleasePlanScript).toContain("--plugin-clawhub-bootstrap-run");
    expect(releaseWorkflow).toContain('verify_args+=(--plugins "${PLUGINS}")');
    expect(releaseWorkflow).toContain("openclaw-release-postpublish-evidence");
    const postpublishEvidenceUpload = workflowStep(
      workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish"),
      "Upload postpublish evidence",
    );
    expect(postpublishEvidenceUpload.if).toContain("always()");
    expect(postpublishEvidenceUpload.if).toContain("inputs.publish_openclaw_npm");
    expect(postpublishEvidenceUpload.with?.["if-no-files-found"]).toBe("error");
    expect(releaseWorkflow).toContain("Failed child job summary");
    expect(releaseWorkflow).toContain("Workflow completion waits for ClawHub");
    expect(releaseWorkflow).toContain("Workflow completion does not wait for ClawHub");
    expect(releaseWorkflow).toContain('[[ "${WAIT_FOR_CLAWHUB}" == "true" ]]');
    expect(releaseWorkflow).toContain(
      '[[ -n "${plugin_clawhub_bootstrap_run_id}" ]] && should_wait_for_plugin_ecosystem',
    );
    expect(clawHubReleasePlanScript).toContain("--skip-clawhub");
    expect(pluginNpmWorkflow).toContain("Validate release publish approval run");
    expect(clawHubWorkflow).toContain("Validate release publish approval run");
    expect(openclawNpmWorkflow).toContain("Validate release publish approval run");
    const pluginNpmPublishJob = workflowJob(PLUGIN_NPM_RELEASE_WORKFLOW, "publish_plugins_npm");
    const npmPackageVersionStep = workflowStep(
      pluginNpmPublishJob,
      "Check OIDC npm package version",
    );
    expect(npmPackageVersionStep).toMatchObject({
      id: "npm_package_version",
      if: "steps.publication_evidence.outputs.publish_route == 'npm-oidc'",
    });
    expect(npmPackageVersionStep.run).toContain("already_published=true");
    expect(workflowStep(pluginNpmPublishJob, "Publish with trusted publisher").if).toBe(
      "steps.publication_evidence.outputs.publish_route == 'npm-oidc' && steps.npm_package_version.outputs.already_published != 'true'",
    );
    expect(pluginNpmWorkflow).toContain("Direct Plugin NPM Release dispatch");
    expect(clawHubWorkflow).toContain("Direct Plugin ClawHub Release dispatch");
    expect(openclawNpmWorkflow).toContain("Direct OpenClaw npm publish");
    expect(pluginNpmWorkflow).toContain('GITHUB_ACTOR}" != "github-actions[bot]"');
    expect(clawHubWorkflow).toContain('GITHUB_ACTOR}" != "github-actions[bot]"');
    expect(openclawNpmWorkflow).toContain('GITHUB_ACTOR}" != "github-actions[bot]"');
    expect(pluginNpmWorkflow).toContain("Direct Plugin NPM Release recovery");
    expect(clawHubWorkflow).toContain("Direct Plugin ClawHub Release recovery");
    expect(openclawNpmWorkflow).toContain("Direct OpenClaw npm recovery");
    expect(pluginNpmWorkflow).toContain("validate-release-publish-approval.mjs");
    expect(clawHubWorkflow).toContain("validate-release-publish-approval.mjs");
    expect(openclawNpmWorkflow).toContain("validate-release-publish-approval.mjs");
    expect(approvalScript).toContain("must still be in_progress");
    expect(approvalScript).toContain("completed with success/failure");
    expect(pluginNpmWorkflow).toContain("environment: npm-release");
    expect(clawHubWorkflow.match(/environment: clawhub-plugin-release/g)?.length).toBe(1);
    expect(clawHubNewWorkflow).toContain("name: Plugin ClawHub New");
    expect(clawHubNewWorkflow).not.toContain("CLAWHUB_CLI_PACKAGE:");
    expect(clawHubNewWorkflow).not.toContain("CLAWHUB_REPOSITORY:");
    expect(clawHubNewWorkflow).not.toContain("CLAWHUB_REF:");
    expect(clawHubNewWorkflow).toContain("environment: clawhub-plugin-bootstrap");
    expect(clawHubNewWorkflow).toContain("secrets.CLAWHUB_TOKEN");
    expect(clawHubNewWorkflow).not.toContain(
      "uses: openclaw/clawhub/.github/workflows/package-publish.yml",
    );
    expect(clawHubNewWorkflow).not.toContain("clawhub_token:");
    expect(clawHubNewWorkflow).toContain("Validate pinned ClawHub trusted publisher CLI support");
    expect(clawHubNewWorkflow).toContain("Materialize locked ClawHub CLI");
    expect(clawHubNewWorkflow).toContain("scripts/materialize-clawhub-cli.sh");
    expect(clawHubNewWorkflow).not.toContain("npm exec");
    expect(clawHubNewWorkflow).not.toContain("npm install");
    expect(clawHubNewWorkflow).toContain("--clawhub-toolchain-integrity");
    expect(clawHubNewWorkflow).toContain("--clawhub-toolchain-sha256");
    expect(clawHubNewWorkflow).toContain("--clawhub-toolchain-version");
    expect(clawHubNewWorkflow).toContain(
      "CLAW-277 03 - Split OpenClaw plugin ClawHub publishing into OIDC release and token bootstrap workflows",
    );
    expect(clawHubNewWorkflow).toContain("Usage: clawhub package trusted-publisher set");
    expect(clawHubNewWorkflow).toContain("Write ClawHub token config");
    expect(clawHubNewWorkflow).toContain("CLAWHUB_CONFIG_PATH=${config_path}");
    expect(clawHubNewWorkflow).toContain(
      "CLAWHUB_REGISTRY is required for token-gated ClawHub bootstrap.",
    );
    expect(clawHubNewWorkflow).toContain(
      "CLAWHUB_TOKEN is required for token-gated ClawHub bootstrap.",
    );
    expect(clawHubNewWorkflow).toContain("JSON.stringify({ registry, token }, null, 2)");
    expect(clawHubNewWorkflow).toContain("Pack immutable ClawHub bootstrap artifacts");
    expect(clawHubNewWorkflow).toContain("Upload immutable ClawHub bootstrap artifact");
    expect(clawHubNewWorkflow).toContain("Validate immutable bootstrap handoff");
    expect(clawHubNewWorkflow).toContain("Upload immutable bootstrap validation evidence");
    expect(clawHubNewWorkflow).toContain(
      "Download and verify immutable ClawHub bootstrap artifact",
    );
    expect(clawHubNewWorkflow).toContain("WORKFLOW_HEAD_BRANCH: ${{ github.ref_name }}");
    expect(clawHubNewWorkflow).toContain("WORKFLOW_REF: ${{ github.ref }}");
    expect(clawHubNewWorkflow).toContain('--workflow-head-branch "${WORKFLOW_HEAD_BRANCH}"');
    expect(clawHubNewWorkflow).toContain('--workflow-ref "${WORKFLOW_REF}"');
    expect(clawHubNewWorkflow).toContain("Rehash immutable ClawHub bootstrap artifacts");
    expect(clawHubNewWorkflow).toContain("Download parent ClawHub bootstrap approval");
    expect(clawHubNewWorkflow).toContain("RELEASE_APPROVAL_KIND: clawhub-bootstrap");
    expect(clawHubNewWorkflow).toContain("gh attestation verify");
    expect(clawHubNewWorkflow).toContain(
      "actions/runs/${RELEASE_PUBLISH_RUN_ID}/attempts/${EXPECTED_RUN_ATTEMPT}",
    );
    expect(clawHubNewWorkflow).toContain('--source-digest "${EXPECTED_WORKFLOW_SHA}"');
    expect(clawHubNewWorkflow).toContain('git rev-parse "${RELEASE_TAG}^{commit}"');
    expect(clawHubNewWorkflow).toContain("refs/remotes/origin/release");
    expect(clawHubNewWorkflow).toContain("Require configure-only registry bytes to match target");
    expect(clawHubNewWorkflow).toContain(
      "Reconfirm configure-only registry bytes before credentials",
    );
    expect(clawHubNewWorkflow).toContain("--mode configure-only-preflight");
    expect(clawHubNewWorkflow).toContain("--validate-packed");
    expect(clawHubNewWorkflow).toContain("--publish-packed");
    expect(clawHubNewWorkflow).toContain(
      "GitHub Actions trusted publisher repair before OIDC migration",
    );
    expect(clawHubNewWorkflow).toContain("GitHub Actions immutable bootstrap retry");
    expect(clawHubNewWorkflow).toContain("configure-only");
    expect(clawHubNewWorkflow).toContain(
      "EXPECTED_WORKFLOW_BRANCH: ${{ inputs.release_publish_branch }}",
    );
    expect(clawHubNewWorkflow).toContain(
      "TRUSTED_PUBLISH_BRANCH: ${{ inputs.release_publish_branch }}",
    );
    expect(clawHubNewWorkflow).toContain("trusted-publisher set");
    expect(clawHubNewWorkflow).toContain("--workflow-filename plugin-clawhub-release.yml");
    expect(clawHubNewWorkflow).not.toContain("--environment clawhub-plugin-release");
    expect(clawHubNewWorkflow).not.toContain("Checkout ClawHub CLI source");
    expect(clawHubNewWorkflow).not.toContain("packages/clawhub/src/cli.ts");
    expect(clawHubNewWorkflow).toContain("Verify exact ClawHub registry artifact bytes");
    expect(clawHubNewWorkflow).toContain("verify-clawhub-published-artifact.mjs");
    expect(openclawNpmWorkflow).toContain("environment: npm-release");
    expect(releaseWorkflow).toContain("default: from-validation");
    expect(releaseWorkflow).toContain('--release-publish-branch "${PARENT_WORKFLOW_BRANCH}"');
    expect(releaseWorkflow).toContain('--release-publish-run-attempt "${GITHUB_RUN_ATTEMPT}"');
    expect(releaseWorkflow).toContain('--release-publish-run-id "${GITHUB_RUN_ID}"');
    expect(releaseWorkflow).toContain('--release-sha "${TARGET_SHA}"');
    expect(releaseWorkflow).toContain(
      '.verifierArgs | index("--plugin-clawhub-bootstrap-run") != null',
    );
    expect(releaseWorkflow).not.toContain(
      "jq -er \\\n                '.verifierArgs | index(\"--plugin-clawhub-bootstrap-run\") != null'",
    );
    expect(releaseWorkflow).toContain(
      '[[ -n "${bootstrap_plugins// }" && "${bootstrap_run_arg_present}" == "true" ]]',
    );
    expect(releaseWorkflow).toContain('--clawhub-bootstrap-plugins "${bootstrap_plugins}"');
    expect(releaseWorkflow).toContain("jq -r '.normal.ref' \"${clawhub_plan_path}\"");
    expect(releaseWorkflow).toContain("jq -r '.normal.workflow' \"${clawhub_plan_path}\"");
    expect(releaseWorkflow).toContain("jq -r '.bootstrap.ref' \"${clawhub_plan_path}\"");
    expect(releaseWorkflow).toContain("jq -r '.bootstrap.workflow' \"${clawhub_plan_path}\"");
    expect(releaseWorkflow).toContain('--clawhub-workflow-ref "${clawhub_workflow_ref}"');
    expect(releaseWorkflow).toContain(
      'if [[ "$EXPECTED_RELEASE_PROFILE" != "from-validation" && "$release_profile" != "$EXPECTED_RELEASE_PROFILE" ]]; then',
    );
    expect(releaseWorkflow).toContain(
      'echo "release_profile=$release_profile" >> "$GITHUB_OUTPUT"',
    );
    expect(releaseWorkflow).toContain(
      "has failed jobs before the workflow completed: https://github.com/${GITHUB_REPOSITORY}/actions/runs/${run_id}",
    );
    expect(releaseWorkflow.lastIndexOf("create_or_update_github_release")).toBeLessThan(
      releaseWorkflow.lastIndexOf("verify_published_release"),
    );
    expect(releaseWorkflow.lastIndexOf("verify_published_release")).toBeLessThan(
      releaseWorkflow.lastIndexOf("append_release_proof_to_github_release"),
    );
    expect(releaseWorkflow.lastIndexOf("append_release_proof_to_github_release")).toBeLessThan(
      releaseWorkflow.lastIndexOf("publish_github_release"),
    );
    expect(releaseWorkflow).toContain("finished with ${conclusion} in ${duration_label}");
  });

  it("bounds the npm registry tarball download used for release resume", () => {
    const publishRun =
      workflowStep(workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish"), "Dispatch publish workflows")
        .run ?? "";
    const resolvePublishState = shellFunctionSource(
      publishRun,
      "resolve_openclaw_npm_publish_state",
    );
    const registryDownload = resolvePublishState.match(
      /curl -fsSL[\s\S]*?"\$\{published_tarball_url\}"/u,
    )?.[0];

    expect(registryDownload).toContain("--connect-timeout 10");
    expect(registryDownload).toContain("--max-time 120");
    expect(registryDownload).toContain("--retry 3");
    expect(registryDownload).toContain("--retry-max-time 180");
    expect(registryDownload).toContain('-o "${published_tarball_path}"');
  });

  it("fails closed when child environment identity or approval mutation fails", () => {
    const publishRun =
      workflowStep(workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish"), "Dispatch publish workflows")
        .run ?? "";
    const verifyChild = shellFunctionSource(publishRun, "verify_child_run_sha");
    const approvePending = shellFunctionSource(publishRun, "approve_pending_deployments");
    const approveChild = shellFunctionSource(publishRun, "approve_child_publish_environment");
    const waitForRun = shellFunctionSource(publishRun, "wait_for_run");
    const expectedSha = "a".repeat(40);

    const mutationFailure = spawnSync(
      "bash",
      [
        "-c",
        `
set -uo pipefail
GITHUB_REPOSITORY=openclaw/openclaw
gh() {
  if [[ "$1" == "run" && "$2" == "view" ]]; then
    printf '%s\\n' '{"headSha":"${expectedSha}","url":"https://example.invalid/run/123"}'
    return 0
  fi
  if [[ "$1" == "api" && "$2" == "-X" && "$3" == "GET" ]]; then
    printf '%s\\n' '[{"environment":{"id":7,"name":"clawhub-plugin-bootstrap"},"current_user_can_approve":true}]'
    return 0
  fi
  if [[ "$1" == "api" && "$2" == "-X" && "$3" == "POST" ]]; then
    return 42
  fi
  return 99
}
${verifyChild}
${approvePending}
status=0
approve_pending_deployments plugin-clawhub-new.yml 123 "${expectedSha}" || status=$?
[[ "$status" -eq 2 ]]
`,
      ],
      { encoding: "utf8" },
    );
    expect(mutationFailure.status, mutationFailure.stderr).toBe(0);

    const mismatchedApprovedSha = spawnSync(
      "bash",
      [
        "-c",
        `
set -uo pipefail
GITHUB_REPOSITORY=openclaw/openclaw
GITHUB_STEP_SUMMARY=/dev/null
gh() {
  if [[ "$1" == "run" && "$2" == "view" ]]; then
    printf '%s\\n' '{"headSha":"${"b".repeat(40)}","url":"https://example.invalid/run/123"}'
    return 0
  fi
  if [[ "$1" == "run" && "$2" == "cancel" ]]; then
    return 0
  fi
  return 99
}
print_failed_run_summary() { :; }
${verifyChild}
${approvePending}
${approveChild}
status=0
approve_child_publish_environment plugin-clawhub-new.yml 123 "${expectedSha}" || status=$?
[[ "$status" -eq 2 ]]
`,
      ],
      { encoding: "utf8" },
    );
    expect(mismatchedApprovedSha.status, mismatchedApprovedSha.stderr).toBe(0);

    const mismatchedWaitSha = spawnSync(
      "bash",
      [
        "-c",
        `
set -uo pipefail
GITHUB_REPOSITORY=openclaw/openclaw
gh() {
  if [[ "$1" == "run" && "$2" == "view" ]]; then
    printf '%s\\n' '{"headSha":"${"b".repeat(40)}","url":"https://example.invalid/run/123"}'
    return 0
  fi
  if [[ "$1" == "run" && "$2" == "cancel" ]]; then
    return 0
  fi
  return 99
}
${verifyChild}
${waitForRun}
status=0
wait_for_run plugin-clawhub-new.yml 123 "${expectedSha}" || status=$?
[[ "$status" -eq 1 ]]
`,
      ],
      { encoding: "utf8" },
    );
    expect(mismatchedWaitSha.status, mismatchedWaitSha.stderr).toBe(0);
  });

  it("keeps release workflow setup and timeout budgets bounded", () => {
    const fullRelease = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const releaseChecks = readWorkflow(RELEASE_CHECKS_WORKFLOW);
    const crossOs = readWorkflow(".github/workflows/openclaw-cross-os-release-checks-reusable.yml");
    const liveE2e = readWorkflow(LIVE_E2E_WORKFLOW);
    const releaseWorkflowPaths = [
      FULL_RELEASE_VALIDATION_WORKFLOW,
      RELEASE_CHECKS_WORKFLOW,
      RELEASE_TELEGRAM_QA_WORKFLOW,
      ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
      LIVE_E2E_WORKFLOW,
      NPM_TELEGRAM_WORKFLOW,
      ".github/workflows/openclaw-release-publish.yml",
      ".github/workflows/android-release.yml",
      ".github/workflows/openclaw-npm-release.yml",
      ".github/workflows/macos-release.yml",
      ".github/workflows/plugin-clawhub-release.yml",
      PACKAGE_ACCEPTANCE_WORKFLOW,
      PLUGIN_NPM_RELEASE_WORKFLOW,
    ];

    for (const workflowPath of releaseWorkflowPaths) {
      const workflow = readWorkflow(workflowPath);
      expect(workflow.env?.NODE_VERSION, workflowPath).toBe("24.15.0");
      expect(workflow.env?.PNPM_VERSION, workflowPath).toBeUndefined();
    }

    expect(fullRelease.jobs?.release_checks?.["timeout-minutes"]).toBe(
      "${{ inputs.release_profile != 'beta' && 240 || 60 }}",
    );
    expect(fullRelease.jobs?.prepare_release_package).toBeUndefined();
    expect(releaseChecks.jobs?.prepare_release_package?.["timeout-minutes"]).toBe(15);
    expect(
      workflowStep(
        workflowJob(RELEASE_CHECKS_WORKFLOW, "prepare_release_package"),
        "Setup Node environment",
      ).with?.["install-deps"],
    ).toBe("true");
    expect(crossOs.jobs?.cross_os_release_checks?.["timeout-minutes"]).toBe(60);
    expect(liveE2e.jobs?.validate_release_live_cache?.["timeout-minutes"]).toBe(20);
    expect(readFileSync(LIVE_E2E_WORKFLOW, "utf8")).toContain(
      "timeout --foreground --kill-after=30s 8m pnpm test:live:cache",
    );
    expect(readFileSync(LIVE_E2E_WORKFLOW, "utf8")).toContain("live-cache attempt ${attempt}/2");
  });

  it("executes shared release candidate identity validation with its JSON input", () => {
    const selectedSha = "a".repeat(40);
    const candidate = {
      packageArtifactName: "docker-e2e-package-123-1",
      packageArtifactId: "123",
      packageArtifactDigest: "b".repeat(64),
      packageArtifactRunId: "456",
      packageArtifactRunAttempt: "1",
      packageFileName: "openclaw-current.tgz",
      packageSourceSha: selectedSha,
      packageSha256: "c".repeat(64),
      packageVersion: "2026.7.2",
      imageArtifactName: "docker-e2e-shared-images-123-1",
      imageArtifactId: "789",
      imageArtifactDigest: "d".repeat(64),
      imageArtifactRunId: "456",
      imageArtifactRunAttempt: "1",
      imageArchiveSha256: "e".repeat(64),
    };
    const validation = workflowStep(
      workflowJob(RELEASE_CHECKS_WORKFLOW, "prepare_release_package"),
      "Validate shared release candidate identity",
    ).run;
    expect(validation).toBeDefined();

    const valid = spawnSync("bash", ["-c", validation ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_ARTIFACT_JSON: JSON.stringify(candidate),
        SELECTED_SHA: selectedSha,
      },
    });
    expect(valid.status, valid.stderr).toBe(0);

    const mismatched = spawnSync("bash", ["-c", validation ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_ARTIFACT_JSON: JSON.stringify(candidate),
        SELECTED_SHA: "f".repeat(40),
      },
    });
    expect(mismatched.status).not.toBe(0);
  });

  it("keeps release history checks blobless", () => {
    const fullHistoryCheckouts: Array<[string, string, string]> = [
      [RELEASE_PUBLISH_WORKFLOW, "resolve_release_target", "Checkout release tag"],
      [
        RELEASE_CHECKS_WORKFLOW,
        "resolve_target",
        "Checkout selected ref for reachability fallback",
      ],
      [RELEASE_CHECKS_WORKFLOW, "prepare_release_package", "Checkout trusted workflow ref"],
      [PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package", "Checkout package workflow ref"],
      [PLUGIN_NPM_RELEASE_WORKFLOW, "preview_plugins_npm", "Checkout"],
      [PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "preview_plugins_clawhub", "Checkout"],
      [OPENCLAW_NPM_RELEASE_WORKFLOW, "preflight_openclaw_npm", "Checkout"],
      [OPENCLAW_NPM_RELEASE_WORKFLOW, "validate_publish_request", "Checkout"],
      [
        ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
        "prepare",
        "Checkout public source ref",
      ],
    ];

    for (const [workflowPath, jobName, stepName] of fullHistoryCheckouts) {
      expect(
        workflowStep(workflowJob(workflowPath, jobName), stepName).with,
        workflowPath,
      ).toMatchObject({
        "fetch-depth": 0,
        filter: "blob:none",
      });
    }

    const metadataOnlyCheckouts: Array<[string, string, string]> = [
      [RELEASE_PUBLISH_WORKFLOW, "resolve_release_target", "Checkout release tag"],
      [
        RELEASE_CHECKS_WORKFLOW,
        "resolve_target",
        "Checkout selected ref for reachability fallback",
      ],
    ];
    for (const [workflowPath, jobName, stepName] of metadataOnlyCheckouts) {
      expect(workflowStep(workflowJob(workflowPath, jobName), stepName).with).toMatchObject({
        "sparse-checkout": "package.json",
        "sparse-checkout-cone-mode": false,
      });
    }

    const clawHubPackJob = workflowJob(
      PLUGIN_CLAWHUB_RELEASE_WORKFLOW,
      "pack_plugins_clawhub_artifacts",
    );
    const clawHubPackTargetGuard = workflowStep(clawHubPackJob, "Validate target revision");
    expect(clawHubPackTargetGuard.env?.TARGET_SHA).toBe(
      "${{ needs.preview_plugins_clawhub.outputs.ref_revision }}",
    );
    expect(clawHubPackTargetGuard.run).toContain('[[ ! "${TARGET_SHA}" =~ ^[a-f0-9]{40}$ ]]');
    expect(workflowStep(clawHubPackJob, "Checkout").with).toMatchObject({
      ref: "${{ needs.preview_plugins_clawhub.outputs.ref_revision }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(clawHubPackJob.steps?.map((step) => step.name)).not.toContain(
      "Checkout target revision",
    );
  });

  it("validates the macOS release handoff before the GitHub release page exists", () => {
    const macosRelease = readWorkflow(".github/workflows/macos-release.yml");
    const validateJob = workflowJob(
      ".github/workflows/macos-release.yml",
      "validate_macos_release_request",
    );
    const stepNames = validateJob.steps?.map((step) => step.name) ?? [];

    expect(stepNames).not.toContain("Ensure matching GitHub release exists");
    expect(macosRelease.jobs?.validate_macos_release_request).toBeDefined();
  });

  it("keeps every tracked repository skill visible to Git-aware syncs", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    const skillFiles = execFileSync("git", ["ls-files", ".agents/skills/*/SKILL.md"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    const skillDirs = skillFiles.map((path) => path.split("/").slice(0, 3).join("/"));

    for (const skillDir of skillDirs) {
      expect(gitignore).toContain(`!${skillDir}/`);
      expect(gitignore).toContain(`!${skillDir}/**`);
    }
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      encoding: "utf8",
      input: `${skillFiles.join("\n")}\n`,
    });
    expect(ignored.status).toBe(1);
    expect(ignored.stdout).toBe("");
    expect(ignored.stderr).toBe("");
  });

  it("keeps tracked sync metadata and QA Mantis sources visible to remote full syncs", () => {
    for (const path of [
      ".github/release/clawhub-cli/package-lock.json",
      ".gitignore",
      "apps/android/.gitignore",
      "extensions/qa-lab/src/mantis/cli.ts",
    ]) {
      const result = spawnSync("git", ["check-ignore", "--no-index", path], {
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });
});
