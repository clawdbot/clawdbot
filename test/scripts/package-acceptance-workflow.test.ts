// Package Acceptance Workflow tests cover package acceptance workflow script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildFullReleaseCandidateBinding } from "../../scripts/full-release-candidate-contract.mjs";
import { FULL_RELEASE_WAIT_TIMEOUT_MINUTES } from "../../scripts/full-release-validation-at-sha.mts";
import { createReleaseWorkflowMatrixPlan } from "../../scripts/plan-release-workflow-matrix.mjs";
import {
  fullReleaseCandidateArtifact,
  fullReleaseCandidateManifestFixture,
} from "../helpers/full-release-candidate.js";
import {
  pluginPrereleaseTimeoutComponents,
  releaseTimeoutForProfile as timeoutForProfile,
  releaseWorkflowJobNeeds as jobNeeds,
} from "../helpers/release-workflow-timeouts.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const PACKAGE_ACCEPTANCE_WORKFLOW = ".github/workflows/package-acceptance.yml";
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const INSTALL_SMOKE_REUSABLE_WORKFLOW = ".github/workflows/install-smoke-reusable.yml";
const CROSS_OS_RELEASE_CHECKS_REUSABLE_WORKFLOW =
  ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
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
const MANTIS_WEB_UI_CHAT_PROOF_WORKFLOW = ".github/workflows/mantis-web-ui-chat-proof.yml";
const PACKAGE_JSON = "package.json";
const SETUP_PNPM_STORE_CACHE_ACTION = ".github/actions/setup-pnpm-store-cache/action.yml";
const SETUP_RELEASE_HARNESS_ACTION = ".github/actions/setup-release-harness/action.yml";
const RELEASE_CHECKS_WORKFLOW = ".github/workflows/openclaw-release-checks.yml";
const RELEASE_TELEGRAM_QA_WORKFLOW = ".github/workflows/openclaw-release-telegram-qa.yml";
const RELEASE_PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const PLUGIN_PRERELEASE_WORKFLOW = ".github/workflows/plugin-prerelease.yml";
const OPENCLAW_NPM_RELEASE_WORKFLOW = ".github/workflows/openclaw-npm-release.yml";
const OPENCLAW_NPM_PREFLIGHT_WORKFLOW = ".github/workflows/openclaw-npm-preflight.yml";
const PLUGIN_CLAWHUB_RELEASE_WORKFLOW = ".github/workflows/plugin-clawhub-release.yml";
const PLUGIN_NPM_RELEASE_WORKFLOW = ".github/workflows/plugin-npm-release.yml";
const ANDROID_RELEASE_WORKFLOW = ".github/workflows/android-release.yml";
const STABLE_MAIN_CLOSEOUT_WORKFLOW = ".github/workflows/openclaw-stable-main-closeout.yml";
const WINDOWS_NODE_RELEASE_WORKFLOW = ".github/workflows/windows-node-release.yml";
const FULL_RELEASE_VALIDATION_WORKFLOW = ".github/workflows/full-release-validation.yml";
const FULL_RELEASE_CANDIDATE_WORKFLOW = ".github/workflows/full-release-candidate.yml";
const FULL_RELEASE_ARTIFACTS_WORKFLOW = ".github/workflows/full-release-artifacts.yml";
const ACTIONS_CACHE_V6 = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const PERFORMANCE_WORKFLOW = ".github/workflows/openclaw-performance.yml";
const FULL_RELEASE_CHILD_DISPATCHES = [
  {
    jobName: "normal_ci",
    kind: "ci",
    nonceSuffix: "-ci",
    runName: "CI",
    stepName: "Dispatch CI",
    workflow: "ci.yml",
  },
  {
    jobName: "plugin_prerelease_independent",
    kind: "plugin-prerelease",
    nonceSuffix: "-plugin-prerelease-independent",
    runName: "Plugin Prerelease",
    stepName: "Dispatch plugin prerelease independent phase",
    workflow: "plugin-prerelease.yml",
  },
  {
    jobName: "plugin_prerelease_candidate",
    kind: "plugin-prerelease",
    nonceSuffix: "-plugin-prerelease-candidate",
    runName: "Plugin Prerelease",
    stepName: "Dispatch plugin prerelease candidate phase",
    workflow: "plugin-prerelease.yml",
  },
  {
    jobName: "release_checks_independent",
    kind: "release-checks",
    nonceSuffix: "-release-checks-independent",
    runName: "OpenClaw Release Checks",
    stepName: "Dispatch release checks independent phase",
    workflow: "openclaw-release-checks.yml",
  },
  {
    jobName: "release_checks_candidate",
    kind: "release-checks",
    nonceSuffix: "-release-checks-candidate",
    runName: "OpenClaw Release Checks",
    stepName: "Dispatch release checks candidate phase",
    workflow: "openclaw-release-checks.yml",
  },
  {
    jobName: "npm_telegram",
    kind: "npm-telegram",
    nonceSuffix: "-npm-telegram",
    runName: "NPM Telegram Beta E2E",
    stepName: "Dispatch npm Telegram E2E",
    workflow: "npm-telegram-beta-e2e.yml",
  },
  {
    jobName: "performance",
    kind: "performance",
    nonceSuffix: "",
    runName: "OpenClaw Performance",
    stepName: "Dispatch OpenClaw Performance",
    workflow: "openclaw-performance.yml",
  },
  {
    jobName: "prepare_npm_package",
    kind: "artifact-npm",
    nonceSuffix: "-artifacts-npm",
    runName: "Full Release Artifacts",
    stepName: "Dispatch immutable npm artifact producer",
    workflow: "full-release-artifacts.yml",
  },
  {
    jobName: "prepare_docker_release",
    kind: "artifact-docker",
    nonceSuffix: "-artifacts-docker",
    runName: "Full Release Artifacts",
    stepName: "Dispatch immutable Docker artifact producer",
    workflow: "full-release-artifacts.yml",
  },
  {
    jobName: "candidate_acquisition",
    kind: "artifact-candidate",
    nonceSuffix: "-artifacts-candidate",
    runName: "Full Release Artifacts",
    stepName: "Dispatch immutable validation candidate producer",
    workflow: "full-release-artifacts.yml",
  },
] as const;
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
const RELEASE_CHECK_ARTIFACT_RESOLVER = "scripts/github/resolve-release-check-artifacts.sh";
const RELEASE_FILTER_VALIDATOR = "scripts/github/validate-release-suite-filters.sh";
const VERIFY_PROVIDER_SECRETS_SCRIPT =
  ".agents/skills/release-openclaw-ci/scripts/verify-provider-secrets.mjs";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const SETUP_NODE_V6 = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const DOWNLOAD_ARTIFACT_V8 = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const RUN_TESTBOX_WITH_FAILURE_REPORTING =
  "steipete/run-testbox@2b6b1be536ec7f3c73757fedf5460a27ab4856b4";
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
  "working-directory"?: string;
};

type WorkflowMatrixEntry = {
  advisory?: boolean;
  chunk_id?: string;
  command?: string;
  profiles?: string;
  suite_group?: string;
  suite_id?: string;
  timeout_minutes?: number;
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
    matrix?: {
      include?: WorkflowMatrixEntry[];
      lane?: string;
      profile?: string[];
      shard?: number[];
    };
  };
  secrets?: string | Record<string, string>;
  "timeout-minutes"?: number | string;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type Workflow = {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean | string;
    queue?: string;
  };
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    schedule?: Array<{ cron?: string }>;
    workflow_call?: {
      inputs?: Record<string, unknown>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, unknown>;
    };
  };
  permissions?: Record<string, string>;
};

const parsedWorkflows = new Map<string, Workflow>();

function readWorkflow(path: string): Workflow {
  const cachedWorkflow = parsedWorkflows.get(path);
  if (cachedWorkflow) {
    return cachedWorkflow;
  }
  const workflow = parse(readFileSync(path, "utf8")) as Workflow;
  parsedWorkflows.set(path, workflow);
  return workflow;
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

function releasePublishOrchestration(job: WorkflowJob): WorkflowStep {
  const dispatch = workflowStep(job, "Dispatch publish workflows");
  const phases = job.steps?.filter((step) =>
    [
      "Dispatch publish workflows",
      "Start core npm publication",
      "Complete publish workflows",
    ].includes(step.name ?? ""),
  );
  const functions = readFileSync("scripts/lib/release-publish-children.sh", "utf8");
  return { ...dispatch, run: [functions, ...(phases ?? []).map((step) => step.run)].join("\n") };
}

function createReleasePublishFixture(
  overrides: Record<string, string> = {},
  { functions = "", mockEvidence = true } = {},
) {
  const root = tempDirs.make("release-publish-phases-");
  const eventsPath = join(root, "events");
  const outputPath = join(root, "output");
  const helperDir = join(root, ".release-harness/scripts/lib");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(eventsPath, "");
  writeFileSync(outputPath, "");
  writeFileSync(
    join(helperDir, "release-publish-children.sh"),
    `${readFileSync("scripts/lib/release-publish-children.sh", "utf8")}
record() { printf '%s\\n' "$*" >> "$PUBLISH_EVENTS"; }
verify_release_tag_target() { record verify-tag; }
resolve_clawhub_release_plan() { :; }
create_or_update_github_release() { record draft; }
dispatch_workflow() { record "dispatch:$*"; printf '404\\n'; }
wait_for_run() {
  record "wait:$1:\${4:-terminal}:\${5:-true}"
  if [[ -n "\${6:-}" ]]; then record "approval-environment:$6"; fi
  local result=0
  case "$1" in
    plugin-npm-release.yml) result="\${MOCK_PLUGIN_NPM_RESULT:-0}" ;;
    openclaw-npm-release.yml)
      if [[ -n "\${4:-}" ]]; then result="\${MOCK_CORE_START_RESULT:-0}";
      else result="\${MOCK_CORE_RESULT:-0}"; fi ;;
    plugin-clawhub-release.yml) result="\${MOCK_CLAWHUB_RESULT:-0}" ;;
    plugin-clawhub-new.yml) result="\${MOCK_BOOTSTRAP_RESULT:-0}" ;;
  esac
  if [[ -f "$RUNNER_TEMP/cancelled-$2" ]]; then result=1; fi
  record "finished:$1:\${result}"
  return "$result"
}
gh() {
  if [[ "$1 $2" != "run cancel" ]]; then return 99; fi
  record "cancel:$*"
  touch "$RUNNER_TEMP/cancelled-\${!#}"
}
promote_android_release_asset() { record android; }
promote_windows_release_assets() { record windows; }
verify_published_release() {
  record "verify:$clawhub_failed:bootstrap=$plugin_clawhub_bootstrap_completed:workflow=$openclaw_npm_expected_workflow_ref"
}
${mockEvidence ? "upload_dependency_evidence_release_asset() { record dependency-evidence; }" : ""}
upload_release_evidence_assets() { record release-evidence; }
${mockEvidence ? "append_release_proof_to_github_release() { record proof; }" : ""}
${functions}
`,
  );
  const outputs = () =>
    Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  return {
    root,
    events: () => readFileSync(eventsPath, "utf8").trim().split("\n"),
    outputs,
    record: (event: string) => writeFileSync(eventsPath, `${event}\n`, { flag: "a" }),
    summary: () => readFileSync(join(root, "summary"), "utf8"),
    run: (step: WorkflowStep, env: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", ["-c", step.run ?? ""], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: root,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ID: "44",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_REF: "refs/heads/main",
          PUBLISH_EVENTS: eventsPath,
          TARGET_SHA: "a".repeat(40),
          CHILD_WORKFLOW_REF: "main",
          PARENT_WORKFLOW_SHA: "d".repeat(40),
          PARENT_WORKFLOW_BRANCH: "main",
          PARENT_WORKFLOW_FULL_REF: "refs/heads/main",
          RELEASE_TAG: "v2026.9.1-beta.1",
          RELEASE_NPM_DIST_TAG: "beta",
          PREFLIGHT_RUN_ID: "55",
          RELEASE_EVIDENCE_MODE: "full-release-validation",
          FULL_RELEASE_VALIDATION_RUN_ID: "66",
          FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "3",
          PLUGIN_SDK_API_ACKNOWLEDGEMENT: "",
          PUBLISH_OPENCLAW_NPM: "true",
          WAIT_FOR_CLAWHUB: "true",
          CHILD_PLUGIN_NPM_RUN_ID: "101",
          CHILD_PLUGIN_CLAWHUB_RUN_ID: "202",
          CHILD_PLUGIN_CLAWHUB_BOOTSTRAP_RUN_ID: "303",
          CHILD_BOOTSTRAP_WORKFLOW_SHA: "d".repeat(40),
          CHILD_OPENCLAW_NPM_ALREADY_PUBLISHED: "false",
          CHILD_OPENCLAW_NPM_EXPECTED_WORKFLOW_REF: "refs/heads/main",
          CHILD_OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA: "d".repeat(40),
          CHILD_OPENCLAW_NPM_RUN_ID: outputs().openclaw_npm_run_id ?? "",
          CORE_START_OUTCOME: "success",
          CLAWHUB_AUTHORIZATION_OUTCOME: "success",
          CLAWHUB_RECEIPT_OUTCOME: "success",
          ...overrides,
          ...env,
        },
      }),
  };
}

function workflowStepById(job: WorkflowJob, stepId: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(`Expected workflow step ID ${stepId}`);
  }
  return step;
}

function evaluatedJobTimeouts(path: string, jobName: string, job: WorkflowJob): number[] {
  const timeout = job["timeout-minutes"];
  if (typeof timeout === "number") {
    return [timeout];
  }
  if (timeout?.includes("inputs.release_")) {
    return (["beta", "stable", "full"] as const).map((profile) =>
      timeoutForProfile(timeout, profile),
    );
  }
  if (timeout === "${{ matrix.group.timeout_minutes || 60 }}") {
    return [60, 90];
  }
  if (timeout !== "${{ matrix.timeout_minutes }}") {
    throw new Error(`Unsupported timeout for ${path}:${jobName}: ${String(timeout)}`);
  }

  const matrix = (job.strategy as { matrix?: unknown } | undefined)?.matrix;
  if (matrix && typeof matrix === "object" && "include" in matrix) {
    const include = (matrix as { include?: WorkflowMatrixEntry[] }).include;
    if (!Array.isArray(include) || include.length === 0) {
      throw new Error(`Missing static timeout matrix for ${path}:${jobName}`);
    }
    return include.map((entry) => {
      if (typeof entry.timeout_minutes !== "number") {
        throw new Error(`Missing matrix timeout for ${path}:${jobName}`);
      }
      return entry.timeout_minutes;
    });
  }

  if (path === LIVE_E2E_WORKFLOW && jobName === "validate_docker_e2e") {
    return (["beta", "stable", "full"] as const).flatMap((releaseProfile) =>
      createReleaseWorkflowMatrixPlan({
        includeReleasePathSuites: true,
        releaseProfile,
      }).dockerE2e.matrix.include.map((entry: WorkflowMatrixEntry) => {
        if (typeof entry.timeout_minutes !== "number") {
          throw new Error(`Missing planned timeout for ${releaseProfile}:${entry.chunk_id}`);
        }
        return entry.timeout_minutes;
      }),
    );
  }

  throw new Error(`Missing matrix timeout evaluator for ${path}:${jobName}`);
}

function pluginPrereleaseTimeoutFloor(
  pluginPrerelease: Workflow,
  liveE2e: Workflow,
  profile: "beta" | "stable" | "full",
): number {
  const components = pluginPrereleaseTimeoutComponents({ pluginPrerelease, liveE2e, profile });
  return Object.values(components).reduce((total, value) => total + value, 0);
}

function runFullReleaseInputValidation(
  releaseProfile: string,
  skipTelegram: string,
  options: {
    telegramWaiver?: string;
    version?: string;
    rerunGroup?: string;
    liveSuiteFilter?: string;
  } = {},
) {
  const step = workflowStep(
    workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "resolve_target"),
    "Validate release inputs",
  );
  const workdir = tempDirs.make("full-release-input-validation-");
  mkdirSync(resolve(workdir, "target"));
  writeFileSync(
    resolve(workdir, "target", "package.json"),
    JSON.stringify({ version: options.version ?? "2026.8.1" }),
    "utf8",
  );
  symlinkSync(process.cwd(), resolve(workdir, "workflow"), "dir");
  return spawnSync("bash", ["-c", step.run ?? ""], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: resolve(workdir, "output"),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      RELEASE_PROFILE: releaseProfile,
      SKIP_PACKAGE_TELEGRAM_E2E: skipTelegram,
      TELEGRAM_WAIVER: options.telegramWaiver ?? "",
      RERUN_GROUP: options.rerunGroup ?? "all",
      LIVE_SUITE_FILTER: options.liveSuiteFilter ?? "",
      TARGET_CONTEXT_REF: "",
      TARGET_REF: "main",
    },
  });
}

function runFullReleaseTargetIdentityValidation(params: {
  anonymousGitUnavailable?: boolean;
  apiError?: "base" | "context" | "comparison";
  baseTagSha?: string;
  comparisonStatus?: string;
  remoteSha?: string;
  targetContextRef?: string;
  targetRef: string;
  version: string;
  releaseProfile?: string;
  runReleaseSoak?: string;
  rerunGroup?: string;
  crossOsSuiteFilter?: string;
}) {
  const step = workflowStep(
    workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "resolve_target"),
    "Validate release inputs",
  );
  const workdir = tempDirs.make("full-release-target-identity-");
  const fakeBin = resolve(workdir, "bin");
  mkdirSync(fakeBin);
  mkdirSync(resolve(workdir, "target"));
  symlinkSync(process.cwd(), resolve(workdir, "workflow"), "dir");
  writeFileSync(
    resolve(workdir, "target", "package.json"),
    `${JSON.stringify({ version: params.version })}\n`,
    "utf8",
  );
  writeFileSync(
    resolve(fakeBin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"ls-remote"* ]]; then
  if [[ "$FAKE_ANONYMOUS_GIT_UNAVAILABLE" == "true" ]]; then
    echo 'fatal: could not read Username for https://github.com: terminal prompts disabled' >&2
    exit 128
  fi
  ref="\${!#}"
  if [[ "$ref" == "refs/tags/v$FAKE_PACKAGE_VERSION" || "$ref" == "refs/tags/v$FAKE_PACKAGE_VERSION^{}" ]]; then
    printf '%s\\t%s\\n' "$FAKE_BASE_SHA" "$ref"
  else
    printf '%s\\t%s\\n' "$FAKE_REMOTE_SHA" "$FAKE_REMOTE_REF"
  fi
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(fakeBin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${GH_TOKEN:-}" == "test-token" ]] || exit 4
[[ "$1" == "api" ]] || exit 64
shift
if [[ "$1" == "--method" && "$2" == "GET" ]]; then shift 2; fi
[[ "$#" == 3 && "$2" == "--jq" ]] || exit 64
case "$1" in
  "$FAKE_BASE_ENDPOINT") kind=base; value="$FAKE_BASE_SHA"; query=.sha ;;
  "$FAKE_CONTEXT_ENDPOINT") kind=context; value="$FAKE_REMOTE_SHA"; query=.sha ;;
  "$FAKE_COMPARISON_ENDPOINT") kind=comparison; value="$FAKE_COMPARISON_STATUS"; query=.status ;;
  *) echo "Unexpected GitHub API endpoint: $1" >&2; exit 64 ;;
esac
[[ "$3" == "$query" ]] || exit 64
if [[ "$FAKE_API_ERROR" == "$kind" ]]; then
  echo 'gh: Service Unavailable (HTTP 503)' >&2
  exit 1
fi
printf '%s\\n' "$value"
`,
    { mode: 0o755 },
  );
  const targetSha = params.targetRef.match(/^[a-f0-9]{40}$/u)?.[0] ?? "a".repeat(40);
  const normalizedContextRef = (params.targetContextRef ?? params.targetRef)
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/tags\//u, "");
  const remoteRef = normalizedContextRef.startsWith("v")
    ? `refs/tags/${normalizedContextRef}`
    : `refs/heads/${normalizedContextRef}`;
  const remoteSha = params.remoteSha ?? targetSha;
  const commitEndpoint = (ref: string) =>
    `repos/openclaw/openclaw/commits/${encodeURIComponent(ref)}`;
  const outputPath = resolve(workdir, "output");
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      FAKE_ANONYMOUS_GIT_UNAVAILABLE: String(params.anonymousGitUnavailable ?? false),
      FAKE_API_ERROR: params.apiError ?? "",
      FAKE_BASE_ENDPOINT: commitEndpoint(`refs/tags/v${params.version}`),
      FAKE_CONTEXT_ENDPOINT: commitEndpoint(remoteRef),
      FAKE_COMPARISON_ENDPOINT: `repos/openclaw/openclaw/compare/${targetSha}...${remoteSha}`,
      FAKE_COMPARISON_STATUS: params.comparisonStatus ?? "ahead",
      FAKE_REMOTE_REF: remoteRef,
      FAKE_REMOTE_SHA: remoteSha,
      FAKE_BASE_SHA: params.baseTagSha ?? params.remoteSha ?? targetSha,
      FAKE_PACKAGE_VERSION: params.version,
      GH_TOKEN: step.env?.GH_TOKEN === "${{ github.token }}" ? "test-token" : "",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_OUTPUT: outputPath,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RELEASE_PROFILE: params.releaseProfile ?? "beta",
      RUN_RELEASE_SOAK: params.runReleaseSoak ?? "false",
      RERUN_GROUP: params.rerunGroup ?? "all",
      CROSS_OS_SUITE_FILTER: params.crossOsSuiteFilter ?? "",
      SKIP_PACKAGE_TELEGRAM_E2E: "false",
      TARGET_CONTEXT_REF: params.targetContextRef ?? "",
      TARGET_REF: params.targetRef,
      TARGET_SHA: targetSha,
    },
  });
  return { ...result, output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "" };
}

function runReleaseChecksInputValidation(
  releaseProfile: string,
  skipTelegram: string,
  rerunGroup = "all",
  runReleaseSoak = "false",
  liveSuiteFilter = "",
  options: {
    candidateArtifactJson?: string;
    telegramWaiver?: string;
    version?: string;
    packageAcceptancePackageSpec?: string;
    phase?: "all" | "candidate" | "independent";
    releasePackageSpec?: string;
    runMaturityScorecard?: string;
  } = {},
) {
  const step = workflowStep(
    workflowJob(RELEASE_CHECKS_WORKFLOW, "resolve_target"),
    "Capture selected inputs",
  );
  const workdir = tempDirs.make("release-checks-input-validation-");
  const outputPath = resolve(workdir, "github-output");
  mkdirSync(resolve(workdir, "waiver-target"));
  writeFileSync(
    resolve(workdir, "waiver-target", "package.json"),
    JSON.stringify({ version: options.version ?? "2026.8.1" }),
    "utf8",
  );
  symlinkSync(process.cwd(), resolve(workdir, "workflow"), "dir");
  const stepEnv = Object.fromEntries(Object.keys(step.env ?? {}).map((name) => [name, ""]));
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...stepEnv,
      CANDIDATE_ARTIFACT_JSON_INPUT: options.candidateArtifactJson ?? "",
      GITHUB_OUTPUT: outputPath,
      PATH: process.env.PATH,
      RELEASE_FAIL_FAST_INPUT: "false",
      RELEASE_FILTER_VALIDATOR: resolve(RELEASE_FILTER_VALIDATOR),
      RELEASE_LIVE_SUITE_FILTER_INPUT: liveSuiteFilter,
      RELEASE_MODE_INPUT: "both",
      RELEASE_PACKAGE_ACCEPTANCE_PACKAGE_SPEC_INPUT: options.packageAcceptancePackageSpec ?? "",
      RELEASE_PACKAGE_SPEC_INPUT: options.releasePackageSpec ?? "",
      RELEASE_PHASE_INPUT: options.phase ?? "all",
      RELEASE_PROFILE_INPUT: releaseProfile,
      RELEASE_PROVIDER_INPUT: "openai",
      RELEASE_QA_DISCORD_LIVE_CI_ENABLED: "false",
      RELEASE_QA_SLACK_LIVE_CI_ENABLED: "false",
      RELEASE_QA_WHATSAPP_LIVE_CI_ENABLED: "false",
      RELEASE_REF_INPUT: "main",
      RELEASE_RERUN_GROUP_INPUT: rerunGroup,
      RELEASE_RUN_MATURITY_SCORECARD_INPUT: options.runMaturityScorecard ?? "false",
      RELEASE_RUN_RELEASE_SOAK_INPUT: runReleaseSoak,
      RELEASE_SKIP_PACKAGE_TELEGRAM_E2E_INPUT: skipTelegram,
      TELEGRAM_WAIVER: options.telegramWaiver ?? "",
    },
  });
  return { outputPath, result };
}

function releaseCandidateArtifactJson(selectedSha = "a".repeat(40), packagePublished = false) {
  return JSON.stringify({
    packagePublished,
    packageArtifactName: "docker-e2e-package-123-1",
    packageArtifactId: "456",
    packageArtifactDigest: "b".repeat(64),
    packageArtifactRunId: "123",
    packageArtifactRunAttempt: "1",
    packageFileName: "openclaw-current.tgz",
    packageSourceSha: selectedSha,
    packageSha256: "c".repeat(64),
    packageVersion: "2026.8.1",
    imageArtifactName: "docker-e2e-shared-images-123-1",
    imageArtifactId: "789",
    imageArtifactDigest: "d".repeat(64),
    imageArtifactRunId: "123",
    imageArtifactRunAttempt: "1",
    imageArchiveSha256: "e".repeat(64),
  });
}

function runReleaseChecksShellStep(
  stepName: string,
  env: Record<string, string>,
  workdir = tempDirs.make("release-checks-shell-step-"),
) {
  const step = workflowStep(workflowJob(RELEASE_CHECKS_WORKFLOW, "resolve_target"), stepName);
  const outputPath = resolve(workdir, "github-output");
  writeFileSync(outputPath, "", "utf8");
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_OUTPUT: outputPath,
      PATH: process.env.PATH,
    },
  });
  return { output: readFileSync(outputPath, "utf8"), result };
}

function runCandidateAcquisitionStep(
  stepName: string,
  env: Record<string, string>,
  workdir = tempDirs.make("candidate-acquisition-step-"),
) {
  const step = workflowStep(
    workflowJob(FULL_RELEASE_CANDIDATE_WORKFLOW, "resolve_candidate"),
    stepName,
  );
  const outputPath = resolve(workdir, "github-output");
  writeFileSync(outputPath, "", "utf8");
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...env, GITHUB_OUTPUT: outputPath, PATH: process.env.PATH, RUNNER_TEMP: workdir },
  });
  const output = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return { output, result };
}

function runFullReleaseCandidateRequest(packagePublished: boolean) {
  const step = workflowStep(
    workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image"),
    "Build full release candidate request",
  );
  const workdir = tempDirs.make("full-release-candidate-request-");
  const harnessRoot = resolve(workdir, ".release-harness");
  const outputPath = resolve(workdir, "github-output");
  mkdirSync(harnessRoot);
  symlinkSync(resolve("scripts"), resolve(harnessRoot, "scripts"), "dir");
  writeFileSync(outputPath, "", "utf8");
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "false",
      ALLOW_UNRELEASED_CHANGELOG: "false",
      GITHUB_OUTPUT: outputPath,
      NODE_OPTIONS: "--preserve-symlinks-main",
      PACKAGE_PUBLISHED: String(packagePublished),
      PATH: process.env.PATH,
      RELEASE_PROFILE: "beta",
      RELEASE_SOAK: "false",
      RUNNER_TEMP: workdir,
      SHARED_IMAGE_POLICY: "no-push-artifact",
      TARGET_REPOSITORY: "openclaw/openclaw",
      TARGET_SHA: "a".repeat(40),
      TOOLING_SHA: "b".repeat(40),
      UPGRADE_SURVIVOR_BASELINE: "openclaw@latest",
      UPGRADE_SURVIVOR_BASELINES: "",
      UPGRADE_SURVIVOR_SCENARIOS: "",
    },
  });
  const output = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return { output, result };
}

function createReleaseChecksContextFixture() {
  const root = tempDirs.make("release-checks-context-repo-");
  const repo = resolve(root, "context-source");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "--initial-branch=release/2026.8.1");
  git("config", "user.name", "OpenClaw Test");
  git("config", "user.email", "openclaw-test@example.com");
  writeFileSync(resolve(repo, "package.json"), '{"version":1}\n', "utf8");
  git("add", "package.json");
  git("commit", "-qm", "candidate");
  const candidateSha = git("rev-parse", "HEAD");
  writeFileSync(resolve(repo, "package.json"), '{"version":2}\n', "utf8");
  git("commit", "-qam", "branch advance");
  const branchHeadSha = git("rev-parse", "HEAD");
  git("tag", "-a", "v2026.8.1", "-m", "release", branchHeadSha);
  const tree = git("rev-parse", "HEAD^{tree}");
  const unrelatedSha = git("commit-tree", tree, "-m", "unrelated root");
  return { branchHeadSha, candidateSha, repoUrl: pathToFileURL(repo).href, unrelatedSha };
}

function runFullReleaseTargetSummary(
  rerunGroup: string,
  skipTelegram: string,
  overrides: Record<string, string> = {},
) {
  const step = workflowStep(
    workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "resolve_target"),
    "Summarize target",
  );
  const workdir = tempDirs.make("full-release-target-summary-");
  const summaryPath = resolve(workdir, "github-summary");
  const stepEnv = Object.fromEntries(Object.keys(step.env ?? {}).map((name) => [name, ""]));
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    encoding: "utf8",
    env: {
      ...stepEnv,
      GITHUB_STEP_SUMMARY: summaryPath,
      PATH: process.env.PATH,
      RELEASE_PROFILE: "beta",
      RERUN_GROUP: rerunGroup,
      SKIP_PACKAGE_TELEGRAM_E2E: skipTelegram,
      TARGET_REF: "main",
      TARGET_SHA: "a".repeat(40),
      ...overrides,
    },
  });
  const summary = result.status === 0 ? readFileSync(summaryPath, "utf8") : "";
  return { result, summary };
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

function runFocusedLiveSuiteValidation(suiteId: string, overrides: Record<string, string> = {}) {
  const step = workflowStep(
    workflowJob(LIVE_E2E_WORKFLOW, "validate_live_suite_filter"),
    "Validate focused live suite filter",
  );
  return spawnSync("bash", ["-c", step.run ?? ""], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LIVE_SUITE_FILTER: suiteId,
      RELEASE_TEST_PROFILE: "full",
      INCLUDE_REPO_E2E: "true",
      INCLUDE_LIVE_SUITES: "true",
      LIVE_MODELS_ONLY: "false",
      LIVE_MODEL_PROVIDERS: "",
      ...overrides,
    },
  });
}

function expectTextToIncludeAll(text: string | undefined, snippets: string[]): void {
  if (text === undefined) {
    throw new Error("Expected text to be defined before checking snippets");
  }
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

function runFullReleaseChildDispatch(
  child: (typeof FULL_RELEASE_CHILD_DISPATCHES)[number],
  overrides: Record<string, string> = {},
) {
  const job = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, child.jobName);
  const step = workflowStep(job, child.stepName);
  const script = step.run;
  if (!script) {
    throw new Error(`Expected full release child dispatch script for ${child.jobName}`);
  }

  const workdir = tempDirs.make("full-release-child-dispatch-");
  const ghPath = resolve(workdir, "gh");
  const sleepPath = resolve(workdir, "sleep");
  const callsPath = resolve(workdir, "gh-calls.jsonl");
  const statusPath = resolve(workdir, "status-polls");
  writeFileSync(callsPath, "");
  writeFileSync(
    ghPath,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.MOCK_GH_CALLS, JSON.stringify({
  args,
  childWorkflowRef: env.CHILD_WORKFLOW_REF,
  dispatchRunName: env.DISPATCH_RUN_NAME,
}) + "\\n");
const jobs = JSON.parse(env.MOCK_GH_JOBS);
const conclusion = env.MOCK_GH_CONCLUSION;
const url = "https://github.com/openclaw/openclaw/actions/runs/101";
function nextRunObservation() {
  const statuses = JSON.parse(env.MOCK_GH_STATUSES);
  const titles = JSON.parse(env.MOCK_GH_RUN_TITLES);
  let index = 0;
  try { index = Number(fs.readFileSync(env.MOCK_GH_STATUS_POLLS, "utf8")); } catch {}
  fs.writeFileSync(env.MOCK_GH_STATUS_POLLS, String(index + 1));
  return {
    status: statuses[Math.min(index, statuses.length - 1)],
    title: titles.length > 0
      ? titles[Math.min(index, titles.length - 1)]
      : env.MOCK_GH_RUN_TITLE,
  };
}
if (args[0] === "workflow" && args[1] === "run") {
  if (env.MOCK_GH_DISPATCH_ERROR) {
    console.error(env.MOCK_GH_DISPATCH_ERROR);
    process.exit(1);
  }
  console.log(env.MOCK_GH_DISPATCH_OUTPUT);
} else if (args[0] === "api" && args.some((value) => value.includes("/commits/"))) {
  console.log(env.MOCK_GH_CURRENT_SHA);
} else if (args[0] === "api" && args.some((value) => value.includes("/actions/workflows/") && value.endsWith("/runs"))) {
  console.log(env.MOCK_GH_MATCHES);
} else if (args[0] === "api" && args.some((value) => value.includes("/actions/workflows/"))) {
  console.log(env.MOCK_GH_WORKFLOW_ID);
} else if (args[0] === "api" && args.some((value) => value.includes("/jobs?"))) {
  if (env.MOCK_GH_JOBS_ERROR) {
    console.error(env.MOCK_GH_JOBS_ERROR);
    process.exit(1);
  }
  jobs.forEach((job) => console.log(JSON.stringify(job)));
} else if (args[0] === "api" && args.some((value) => value.includes("/actions/runs/"))) {
  if (env.MOCK_GH_STATUS_ERROR && fs.existsSync(env.MOCK_GH_STATUS_POLLS)) {
    console.error(env.MOCK_GH_STATUS_ERROR);
    process.exit(1);
  }
  const observation = nextRunObservation();
  console.log(JSON.stringify({
    conclusion,
    display_title: observation.title,
    event: env.MOCK_GH_RUN_EVENT,
    head_branch: env.MOCK_GH_RUN_HEAD_BRANCH,
    head_sha: env.MOCK_GH_CHILD_SHA,
    html_url: url,
    id: Number(env.MOCK_GH_RUN_ID),
    path: env.MOCK_GH_RUN_PATH,
    run_attempt: Number(env.MOCK_GH_RUN_ATTEMPT),
    status: observation.status,
    workflow_id: Number(env.MOCK_GH_RUN_WORKFLOW_ID),
  }));
} else if (args[0] === "run" && args[1] === "view") {
  const field = args[args.indexOf("--json") + 1];
  if (field === "status" && env.MOCK_GH_STATUS_ERROR) {
    console.error(env.MOCK_GH_STATUS_ERROR);
    process.exit(1);
  }
  if (field === "jobs") {
    if (env.MOCK_GH_JOBS_ERROR) {
      console.error(env.MOCK_GH_JOBS_ERROR);
      process.exit(1);
    }
    const query = args[args.indexOf("--jq") + 1];
    if (query.startsWith("[.jobs")) {
      console.log(JSON.stringify(jobs.filter((job) => job.status === "completed" && job.conclusion !== "success" && job.conclusion !== "skipped")));
    } else {
      jobs.forEach((job) => console.log(JSON.stringify(job)));
    }
  } else {
    const status = field === "status" ? nextRunObservation().status : undefined;
    console.log({
      conclusion,
      headSha: env.MOCK_GH_CHILD_SHA,
      status,
      url,
    }[field]);
  }
} else if (args[0] !== "run" || args[1] !== "cancel") {
  console.error("Unexpected mock gh invocation: " + JSON.stringify(args));
  process.exit(2);
}
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(
    sleepPath,
    `#!/bin/sh
if [ -n "\${MOCK_SLEEP_SIGNAL:-}" ] && [ ! -e "\${MOCK_SLEEP_SIGNAL_SENT}" ]; then
  : > "\${MOCK_SLEEP_SIGNAL_SENT}"
  kill -"\${MOCK_SLEEP_SIGNAL}" "$PPID"
fi
exit 0
`,
  );
  chmodSync(sleepPath, 0o755);

  const parentSha = "a".repeat(40);
  const defaultJobs = [
    {
      conclusion: "success",
      html_url: "https://github.com/openclaw/openclaw/actions/runs/101/job/201",
      name: "Verify release checks",
      status: "completed",
      url: "https://github.com/openclaw/openclaw/actions/runs/101/job/201",
    },
  ];
  const stepValues: Record<string, string> = {
    ALLOW_UNRELEASED_CHANGELOG: "false",
    ARTIFACT_STAGE: child.kind.replace("artifact-", ""),
    ARTIFACT_DISPATCH_ID: `full-release-validation-77-2-${child.kind}`,
    CANDIDATE_ARTIFACT_JSON: "",
    CANDIDATE_REQUEST_JSON: '{"targetSha":"' + "b".repeat(40) + '"}',
    CHILD_WORKFLOW_KIND: child.kind,
    CHILD_WORKFLOW_REF: "main",
    CI_RELEASE_SCOPE: "full",
    CODEX_PLUGIN_SPEC: "",
    CROSS_OS_SUITE_FILTER: "",
    FAIL_FAST: "false",
    GH_TOKEN: "fixture-token",
    LIVE_SUITE_FILTER: "",
    MODE: "both",
    NPM_DIST_TAG: "beta",
    PACKAGE_ACCEPTANCE_PACKAGE_SPEC: "",
    PACKAGE_SPEC: "openclaw@beta",
    PARENT_WORKFLOW_SHA: parentSha,
    PREFLIGHT_PHASE: "all",
    PREPARED_NPM_BUNDLE_JSON: '{"schema":"openclaw.prepared-npm-bundle/v1"}',
    PHASE: child.jobName.endsWith("_candidate") ? "candidate" : "independent",
    PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON: "[]",
    PROVIDER: "openai",
    PROVIDER_MODE: "mock-openai",
    RELEASE_PACKAGE_SPEC: "",
    RELEASE_PROFILE: "stable",
    RELEASE_TAG: "v2026.8.1",
    RELEASE_CANDIDATE_BRANCH: "",
    RERUN_GROUP: "all",
    RUN_RELEASE_SOAK: "false",
    SCENARIO: "",
    SKIP_PACKAGE_TELEGRAM_E2E: "false",
    TELEGRAM_WAIVER: "",
    TARGET_CONTEXT_REF: "",
    TARGET_REF: "main",
    TARGET_SHA: "b".repeat(40),
  };
  const stepEnv = Object.fromEntries(
    Object.keys({ ...job.env, ...step.env }).map((name) => {
      const value = stepValues[name];
      if (value === undefined) {
        throw new Error(`Missing child dispatch fixture value for ${child.jobName}.${name}`);
      }
      return [name, value];
    }),
  );
  const result = spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...stepEnv,
      GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN:
        readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW).env
          ?.GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN ?? "HTTP 5[0-9][0-9]",
      GITHUB_OUTPUT: resolve(workdir, "github-output"),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "77",
      GITHUB_STEP_SUMMARY: resolve(workdir, "github-summary"),
      MOCK_GH_CALLS: callsPath,
      MOCK_GH_CHILD_SHA: parentSha,
      MOCK_GH_CONCLUSION: "success",
      MOCK_GH_CURRENT_SHA: parentSha,
      MOCK_GH_DISPATCH_OUTPUT: "Created workflow_dispatch event.",
      MOCK_GH_JOBS: JSON.stringify(defaultJobs),
      MOCK_GH_MATCHES: "[101]",
      MOCK_GH_RUN_EVENT: "workflow_dispatch",
      MOCK_GH_RUN_HEAD_BRANCH:
        overrides.MOCK_GH_RUN_HEAD_BRANCH ??
        overrides.CHILD_WORKFLOW_REF ??
        stepEnv.CHILD_WORKFLOW_REF,
      MOCK_GH_RUN_ID: "101",
      MOCK_GH_RUN_PATH: `.github/workflows/${child.workflow}`,
      MOCK_GH_RUN_ATTEMPT: "1",
      MOCK_GH_RUN_TITLE: `${child.runName} full-release-validation-77-2${child.nonceSuffix}`,
      MOCK_GH_RUN_TITLES: "[]",
      MOCK_GH_RUN_WORKFLOW_ID: "789",
      MOCK_GH_STATUSES: '["completed"]',
      MOCK_GH_STATUS_POLLS: statusPath,
      MOCK_GH_WORKFLOW_ID: "789",
      MOCK_SLEEP_SIGNAL_SENT: resolve(workdir, "sleep-signal-sent"),
      PATH: `${workdir}:${process.env.PATH}`,
      ...overrides,
    },
    timeout: 10_000,
  });
  const calls = readFileSync(callsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          args: string[];
          childWorkflowRef: string;
          dispatchRunName?: string;
        },
    );
  return { calls, result };
}

function fullReleaseChild(kind: string) {
  const child = FULL_RELEASE_CHILD_DISPATCHES.find((candidate) => candidate.kind === kind);
  if (!child) {
    throw new Error(`Expected full release child ${kind}`);
  }
  return child;
}

function runPackageAcceptanceSummary(params: {
  advisory?: boolean;
  dockerArtifactResult?: string;
  dockerRegistryResult?: string;
  npm12InstallResult?: string;
  suiteProfile?: string;
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
      NPM_12_INSTALL_RESULT: params.npm12InstallResult ?? "success",
      PACKAGE_TELEGRAM_RESULT: params.telegramResult,
      PATH: process.env.PATH,
      RESOLVE_RESULT: "success",
      SUITE_PROFILE: params.suiteProfile ?? "package",
      TELEGRAM_ADVISORY: String(params.telegramAdvisory ?? false),
      TELEGRAM_ENABLED: String(params.telegramEnabled),
    },
  });
}

function runPackageAcceptanceProfile(params: {
  dockerLanes?: string;
  suiteProfile: string;
  telegramMode?: string;
  telegramScenarios?: string;
}) {
  const job = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package");
  const script = workflowStep(job, "Select acceptance profile").run;
  if (!script) {
    throw new Error("Expected package acceptance profile script");
  }
  const workdir = tempDirs.make("package-acceptance-profile-");
  const outputPath = resolve(workdir, "github-output");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      CUSTOM_DOCKER_LANES: params.dockerLanes ?? "",
      GITHUB_OUTPUT: outputPath,
      PACKAGE_ARTIFACT_NAME: "package-under-test",
      PATH: process.env.PATH,
      SOURCE: "ref",
      SUITE_PROFILE: params.suiteProfile,
      TELEGRAM_MODE: params.telegramMode ?? "none",
      TELEGRAM_SCENARIOS: params.telegramScenarios ?? "",
    },
  });
  const outputs =
    result.status === 0
      ? Object.fromEntries(
          readFileSync(outputPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        )
      : {};
  return { outputs, result };
}

function runPackageAcceptanceRegistryInputValidation(params: {
  candidateArtifactJson?: string;
  prepublishPluginRegistryJson?: string;
}) {
  const job = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package");
  const script = workflowStep(job, "Validate prerelease plugin registry input").run;
  if (!script) {
    throw new Error("Expected package acceptance registry input validation script");
  }
  const workdir = tempDirs.make("package-acceptance-registry-input-");
  const outputPath = resolve(workdir, "github-output");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      CANDIDATE_ARTIFACT_JSON: params.candidateArtifactJson ?? "",
      GITHUB_OUTPUT: outputPath,
      PATH: process.env.PATH,
      PREPUBLISH_PLUGIN_REGISTRY_JSON: params.prepublishPluginRegistryJson ?? "",
    },
  });
  const output = result.status === 0 ? readFileSync(outputPath, "utf8") : "";
  return { output, result };
}

function packageAcceptanceRegistryTuple(overrides: Record<string, string> = {}) {
  return {
    prepublishPluginRegistryArtifactName: "docker-e2e-prepublish-plugin-registry-123-2",
    prepublishPluginRegistryArtifactId: "456",
    prepublishPluginRegistryArtifactDigest: "a".repeat(64),
    prepublishPluginRegistryArtifactRunId: "123",
    prepublishPluginRegistryArtifactRunAttempt: "2",
    prepublishPluginRegistryManifestSha256: "b".repeat(64),
    ...overrides,
  };
}

function runPackageAcceptanceResolveScript(params: {
  candidateArtifactJson?: string;
  prepublishPluginRegistryJson?: string;
  source: "artifact" | "npm" | "ref" | "trusted-url" | "url";
  telegramMode: "mock-openai" | "none";
}) {
  const job = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package");
  const script = workflowStep(job, "Resolve package candidate").run;
  if (!script) {
    throw new Error("Expected package acceptance resolve script");
  }
  const workdir = tempDirs.make("package-acceptance-resolve-");
  const binDir = resolve(workdir, "bin");
  const capturePath = resolve(workdir, "node-args");
  const outputPath = resolve(workdir, "github-output");
  const artifactDir = resolve(workdir, ".artifacts/package-candidate-input");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  const nodePath = resolve(binDir, "node");
  const artifactPath = resolve(artifactDir, "openclaw-current.tgz");
  const artifactBody = "package acceptance artifact";
  writeFileSync(artifactPath, artifactBody);
  writeFileSync(
    nodePath,
    `#!/bin/sh
printf "%s\\n" "$@" > "$CAPTURE_PATH"
if [ "$SOURCE" = "artifact" ]; then
  mkdir -p .artifacts/docker-e2e-package
  printf '{"name":"openclaw","sha256":"%s","packageSourceSha":"%s","version":"%s"}\\n' \
    "$PACKAGE_SHA256" "$PACKAGE_SOURCE_SHA" "$PACKAGE_VERSION" \
    > .artifacts/docker-e2e-package/package-candidate.json
fi
`,
  );
  chmodSync(nodePath, 0o755);
  const result = spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      CAPTURE_PATH: capturePath,
      GITHUB_OUTPUT: outputPath,
      OPENCLAW_TRUSTED_PACKAGE_TOKEN: "",
      PACKAGE_FILE_NAME: "openclaw-current.tgz",
      PACKAGE_REF: "HEAD",
      PACKAGE_SHA256: createHash("sha256").update(artifactBody).digest("hex"),
      PACKAGE_SOURCE_SHA: "a".repeat(40),
      PACKAGE_SPEC: "openclaw@beta",
      PACKAGE_URL: "https://example.invalid/openclaw.tgz",
      PACKAGE_VERSION: "2026.8.26",
      PATH: `${binDir}:${process.env.PATH}`,
      PREPUBLISH_PLUGIN_REGISTRY_JSON: params.prepublishPluginRegistryJson ?? "",
      PUBLISHED_ARTIFACT: String(
        JSON.parse(params.candidateArtifactJson ?? "{}").packagePublished === true,
      ),
      SOURCE: params.source,
      TELEGRAM_MODE: params.telegramMode,
      TRUSTED_SOURCE_ID: "",
    },
  });
  const args = result.status === 0 ? readFileSync(capturePath, "utf8") : "";
  return { args, result };
}

function runPackageAcceptanceBaselineStep(params: {
  candidateArtifactJson?: string;
  candidateVersion: string;
  fallbackBaseline?: string;
  source: "artifact" | "npm" | "ref";
  targetContextRef?: string;
}) {
  const job = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package");
  const script = workflowStep(job, "Resolve published upgrade survivor baselines").run;
  if (!script) {
    throw new Error("Expected package acceptance baseline script");
  }
  const executableScript = script.replace(
    "node scripts/lib/release-upgrade-baseline.mjs",
    `node ${JSON.stringify(resolve("scripts/lib/release-upgrade-baseline.mjs"))}`,
  );
  const workdir = tempDirs.make("package-acceptance-baseline-");
  const binDir = resolve(workdir, "bin");
  const outputPath = resolve(workdir, "github-output");
  const npmLog = resolve(workdir, "npm.log");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(resolve("node_modules"), resolve(workdir, "node_modules"), "dir");
  symlinkSync(resolve("scripts"), resolve(workdir, "scripts"), "dir");
  writeFileSync(
    resolve(binDir, "npm"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$NPM_LOG"
if [ "$1 $2 $3" = "view openclaw versions" ]; then
  printf '%s\n' '["2026.7.1","2026.7.1-2","2026.8.1","2026.9.1"]'
elif [ "$1 $2" = "view openclaw@latest" ]; then
  printf '%s\n' '2026.9.1'
else
  exit 64
fi
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", executableScript], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      CANDIDATE_VERSION: params.candidateVersion,
      CANDIDATE_PUBLISHED: String(
        params.source === "npm" ||
          JSON.parse(params.candidateArtifactJson ?? "{}").packagePublished === true,
      ),
      FALLBACK_BASELINE: params.fallbackBaseline ?? "openclaw@latest",
      GH_TOKEN: "",
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      NPM_LOG: npmLog,
      PATH: `${binDir}:${process.env.PATH}`,
      REQUESTED_BASELINES: "",
      RUNNER_TEMP: workdir,
      TARGET_CONTEXT_REF: params.targetContextRef ?? "",
    },
  });
  return {
    npmCalls: existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n") : [],
    output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    result,
  };
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
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_DIGEST: "",
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_ID: "",
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_NAME: "",
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_RUN_ATTEMPT: "",
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_RUN_ID: "",
      PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: "",
      PROVIDER_MODE: "mock-openai",
      ...overrides,
    },
  });
}

function runNpmTelegramArtifactValidation(params: {
  currentRunId: string;
  producerRunId: string;
  producerStatus: "completed" | "in_progress" | "pending" | "queued" | "requested" | "waiting";
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
  const binDir = tempDirs.make("release-publish-input-gh-");
  writeFileSync(join(binDir, "gh"), '#!/bin/sh\nprintf "%s\\n" "$WORKFLOW_SHA"\n', {
    mode: 0o755,
  });
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "1",
      FULL_RELEASE_VALIDATION_RUN_ID: "222",
      OPENCLAW_NPM_RESUME_RUN_ID: "",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${binDir}:${process.env.PATH}`,
      PLUGINS: "",
      PLUGIN_PUBLISH_SCOPE: "all-publishable",
      PREFLIGHT_RUN_ID: "111",
      PUBLISH_DOCKER_ONLY: "false",
      PUBLISH_OPENCLAW_NPM: "true",
      RELEASE_NPM_DIST_TAG: "beta",
      RELEASE_PROFILE: "beta",
      RELEASE_TAG: "v2026.7.1-beta.3",
      WINDOWS_NODE_INSTALLER_DIGESTS: "",
      WINDOWS_NODE_TAG: "",
      WORKFLOW_REF: `refs/tags/release-publish/${"a".repeat(12)}-123`,
      WORKFLOW_SHA: "a".repeat(40),
      ...overrides,
    },
  });
}

function runReleasePublishChildWorkflowRef(overrides: Record<string, string> = {}) {
  const script = readFileSync("scripts/lib/release-publish-children.sh", "utf8");
  const resolveChildRef = shellFunctionSource(script, "resolve_child_workflow_ref");
  return spawnSync(
    "bash",
    [
      "-c",
      `gh() { echo unexpected-github-lookup >&2; return 64; }\n${resolveChildRef}\nresolve_child_workflow_ref "$WORKFLOW_FULL_REF"`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        WORKFLOW_FULL_REF: "refs/heads/main",
        ...overrides,
      },
    },
  );
}

function runOpenClawNpmTrustedRefGuard(overrides: Record<string, string>) {
  const job = workflowJob(OPENCLAW_NPM_RELEASE_WORKFLOW, "validate_publish_request");
  const script = workflowStep(job, "Require trusted workflow ref for publish").run;
  if (!script) {
    throw new Error("Expected OpenClaw npm trusted ref guard");
  }
  const binDir = tempDirs.make("openclaw-npm-trusted-ref-");
  const ghPath = `${binDir}/gh`;
  const gitPath = `${binDir}/git`;
  const timeoutPath = `${binDir}/timeout`;
  writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' "\${MOCK_REMOTE_TAG_SHA}"\n`);
  chmodSync(ghPath, 0o755);
  writeFileSync(
    gitPath,
    `#!/bin/sh\nif [ "$1" = "fetch" ]; then exit 0; fi\nif [ "$1" = "merge-base" ]; then [ "\${MOCK_WORKFLOW_ANCESTOR}" = "true" ]; exit $?; fi\nexit 2\n`,
  );
  chmodSync(gitPath, 0o755);
  writeFileSync(
    timeoutPath,
    `#!/bin/sh\n[ "$1" = "--signal=TERM" ] && [ "$2" = "--kill-after=10s" ] && [ "$3" = "120s" ] || exit 2\nshift 3\nexec "$@"\n`,
  );
  chmodSync(timeoutPath, 0o755);
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      GITHUB_REPOSITORY: "openclaw/openclaw",
      MOCK_REMOTE_TAG_SHA: "a".repeat(40),
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

function runPluginNpmPreflightToolingGuard(overrides: Record<string, string>) {
  const job = workflowJob(PLUGIN_NPM_RELEASE_WORKFLOW, "preview_plugins_npm");
  const script = workflowStep(job, "Verify trusted preflight tooling identity").run;
  if (!script) {
    throw new Error("Expected plugin npm preflight tooling identity guard");
  }
  const workdir = tempDirs.make("plugin-npm-preflight-tooling-");
  const binDir = resolve(workdir, "bin");
  const toolingDir = resolve(workdir, ".release-tooling/scripts");
  const toolingLibDir = resolve(toolingDir, "lib");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(toolingLibDir, { recursive: true });
  writeFileSync(
    resolve(toolingDir, "release-tooling-identity.mjs"),
    readFileSync(resolve(REPO_ROOT, "scripts/release-tooling-identity.mjs")),
  );
  writeFileSync(
    resolve(toolingLibDir, "record-shared.mjs"),
    readFileSync(resolve(REPO_ROOT, "scripts/lib/record-shared.mjs")),
  );
  writeFileSync(
    resolve(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "api" ]] || exit 64
case "$2" in
  */git/ref/tags/*)
    [[ "$MOCK_TAG_MISSING" != "true" ]] || exit 1
    jq -cn \
      --arg ref "$MOCK_TAG_FULL_REF" \
      --arg sha "$MOCK_TAG_SHA" \
      --arg type "$MOCK_TAG_TYPE" \
      '{ref: $ref, object: {sha: $sha, type: $type}}'
    ;;
  */compare/*)
    jq -cn --arg status "$MOCK_COMPARE_STATUS" '{status: $status}'
    ;;
  *)
    exit 64
    ;;
esac
`,
    { mode: 0o755 },
  );
  return spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      GITHUB_REPOSITORY: "openclaw/openclaw",
      MOCK_COMPARE_STATUS: "identical",
      MOCK_TAG_FULL_REF: "",
      MOCK_TAG_MISSING: "false",
      MOCK_TAG_SHA: "",
      MOCK_TAG_TYPE: "commit",
      PATH: `${binDir}:${process.env.PATH}`,
      ...overrides,
    },
  });
}

type ProtectedPreflightConsumerParams = {
  currentRef: string;
  currentWorkflowSha: string;
  fullReleasePreflight?: boolean;
  independentProducer?: boolean;
  fullReleaseRunId?: string;
  fullReleaseRunAttempt?: string;
  npmDistTag?: string;
  expectedExtendedStableBranch?: string;
  toolingAncestor?: boolean;
  liveTagSha?: string;
  preflightHeadBranch: string;
  preflightHeadSha: string;
  producerBranches?: unknown[];
  producerTagSha?: string;
  producerTagType?: string;
  mainComparisonStatus?: string;
  publisherComparisonStatus?: string;
};

function writePreflightConsumerTooling(toolingDir: string) {
  mkdirSync(resolve(toolingDir, "lib"), { recursive: true });
  for (const source of [
    "npm-preflight-tooling-identity.mjs",
    "npm-prepared-bundle.mjs",
    "openclaw-npm-extended-stable-release.mjs",
    "release-tooling-identity.mjs",
    "lib/actions-artifact-archive.mjs",
    "lib/npm-core-release-packages.json",
    "lib/record-shared.mjs",
    "lib/release-version.mjs",
  ]) {
    copyFileSync(resolve(REPO_ROOT, "scripts", source), resolve(toolingDir, source));
  }
}

const PREFLIGHT_PRODUCER_GH_CASES = `
case "$2" in
  */actions/runs/*/attempts/*/jobs*)
    printf '%s\\n' "$MOCK_QUALIFIED_JOBS"
    exit 0
    ;;
  */actions/runs/*/attempts/*)
    printf '%s\\n' "$MOCK_QUALIFIED_RUN"
    exit 0
    ;;
  */actions/artifacts/555)
    printf '%s\\n' "$MOCK_QUALIFIED_ARTIFACT"
    exit 0
    ;;
  */contents/scripts/*)
    source="\${2#*/contents/scripts/}"
    source="\${source%%\\?*}"
    base64 < "$MOCK_REPO_ROOT/scripts/$source"
    exit 0
    ;;
  */git/ref/tags/*)
    if [[ "$*" == *"--jq .object"* ]]; then
      printf '%s\\n' "$MOCK_REMOTE_TAG_SHA"
    else
      printf '%s\\n' "$MOCK_PRODUCER_TAG"
    fi
    exit 0
    ;;
  */git/matching-refs/heads/*)
    printf '%s\\n' "$MOCK_PRODUCER_BRANCHES"
    exit 0
    ;;
  */compare/*)
    if [[ "$2" == *"...main" ]]; then
      printf '{"status":"%s"}\\n' "$MOCK_MAIN_COMPARISON"
    else
      printf '{"status":"%s"}\\n' "$MOCK_PUBLISHER_COMPARISON"
    fi
    exit 0
    ;;
esac
`;

function preflightProducerFixtureEnv(params: ProtectedPreflightConsumerParams) {
  return {
    MOCK_REPO_ROOT: REPO_ROOT,
    MOCK_PRODUCER_TAG: JSON.stringify({
      ref: `refs/tags/${params.preflightHeadBranch}`,
      object: {
        sha: params.producerTagSha ?? params.preflightHeadSha,
        type: params.producerTagType ?? "commit",
      },
    }),
    MOCK_PRODUCER_BRANCHES: JSON.stringify(params.producerBranches ?? []),
    MOCK_MAIN_COMPARISON: params.mainComparisonStatus ?? "ahead",
    MOCK_PUBLISHER_COMPARISON: params.publisherComparisonStatus ?? "ahead",
  };
}

async function qualifiedPreflightConsumerFixture(
  workdir: string,
  params: ProtectedPreflightConsumerParams,
) {
  if (!params.fullReleasePreflight) {
    return {};
  }
  const runId = params.independentProducer ? "333" : "111";
  const workflowPath = params.independentProducer
    ? FULL_RELEASE_ARTIFACTS_WORKFLOW
    : FULL_RELEASE_VALIDATION_WORKFLOW;
  const fullRef = `refs/${params.preflightHeadBranch.startsWith("release-publish/") ? "tags" : "heads"}/${params.preflightHeadBranch}`;
  const producer = {
    repository: "openclaw/openclaw",
    workflowRef: `openclaw/openclaw/${workflowPath}@${fullRef}`,
    workflowSha: params.preflightHeadSha,
    runId,
    runAttempt: "1",
    jobId: "999",
    jobName: "Prepare release npm artifacts / Qualify prepared npm package",
    producerWorkflowPath: OPENCLAW_NPM_PREFLIGHT_WORKFLOW,
  };
  const manifest = Buffer.from(
    JSON.stringify({ version: 3, releaseSha: "d".repeat(40), producer }),
  );
  const zip = new JSZip();
  zip.file("preflight-manifest.json", manifest);
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
  });
  const artifact = {
    id: "555",
    name: "openclaw-npm-preflight-v2026.8.1-beta.3",
    digest: createHash("sha256").update(archive).digest("hex"),
    runId,
    runAttempt: "1",
  };
  const fullManifest = {
    workflowName: "Full Release Validation",
    runId: "111",
    runAttempt: params.independentProducer ? "3" : "1",
    workflowFullRef: fullRef,
    targetSha: "d".repeat(40),
    workflowSha: params.preflightHeadSha,
    publicationArtifacts: {
      npmPreflight: {
        schema: "openclaw.qualified-npm-preflight/v1",
        source: { sha: "d".repeat(40) },
        producer,
        artifact,
        manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      },
    },
  };
  for (const directory of ["runner/full-release-validation-manifest", "full-release-validation"]) {
    mkdirSync(resolve(workdir, directory), { recursive: true });
    writeFileSync(
      resolve(workdir, directory, "full-release-validation-manifest.json"),
      JSON.stringify(fullManifest),
    );
  }
  const artifactMetadata = {
    ...artifact,
    id: 555,
    digest: `sha256:${artifact.digest}`,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-10-01T00:00:00Z",
    workflow_run: { id: Number(runId), head_sha: params.preflightHeadSha },
  };
  const archivePath = resolve(workdir, "qualified.zip");
  writeFileSync(archivePath, archive);
  const preload = resolve(workdir, "artifact-fetch.mjs");
  writeFileSync(
    preload,
    `import { readFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  if (url === 'https://api.github.com/repos/openclaw/openclaw/actions/artifacts/555') return Response.json(JSON.parse(process.env.MOCK_QUALIFIED_ARTIFACT));
  if (url === 'https://api.github.com/repos/openclaw/openclaw/actions/artifacts/555/zip') return new Response(new Uint8Array(readFileSync(process.env.MOCK_QUALIFIED_ARCHIVE)));
  throw new Error('Unexpected fixture network request: ' + url);
};\n`,
  );
  return {
    GH_TOKEN: "test-artifact-token",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    MOCK_QUALIFIED_ARCHIVE: archivePath,
    MOCK_QUALIFIED_ARTIFACT: JSON.stringify(artifactMetadata),
    MOCK_QUALIFIED_RUN: JSON.stringify({
      id: Number(runId),
      run_attempt: 1,
      path: workflowPath,
      head_sha: params.preflightHeadSha,
      head_branch: params.preflightHeadBranch,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      repository: { full_name: "openclaw/openclaw" },
      head_repository: { full_name: "openclaw/openclaw" },
    }),
    MOCK_QUALIFIED_JOBS: JSON.stringify({
      total_count: 1,
      jobs: [
        {
          id: 999,
          name: producer.jobName,
          run_id: Number(runId),
          run_attempt: 1,
          head_sha: params.preflightHeadSha,
          status: "completed",
          conclusion: "success",
        },
      ],
    }),
  };
}

async function runReleasePublishPreflightConsumerGuard(params: ProtectedPreflightConsumerParams) {
  const job = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
  const script = workflowStep(job, "Download OpenClaw npm preflight manifest").run;
  if (!script) {
    throw new Error("Expected release publish preflight consumer guard");
  }
  const workdir = tempDirs.make("release-publish-preflight-consumer-");
  const binDir = resolve(workdir, "bin");
  const runnerTemp = resolve(workdir, "runner");
  mkdirSync(binDir);
  mkdirSync(runnerTemp);
  const qualificationEnv = await qualifiedPreflightConsumerFixture(workdir, params);
  writePreflightConsumerTooling(resolve(workdir, ".release-validation-tooling/scripts"));
  writeFileSync(
    resolve(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "run" && "$2" == "download" ]]; then
  exit 0
fi
if [[ "$1" == "api" ]]; then
  ${PREFLIGHT_PRODUCER_GH_CASES}
  printf '%s\\n' "$MOCK_PREFLIGHT_RUN"
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...preflightProducerFixtureEnv(params),
      ...qualificationEnv,
      EXPECTED_SHA: "d".repeat(40),
      GITHUB_OUTPUT: resolve(workdir, "github-output"),
      GITHUB_REF: params.currentRef,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_WORKSPACE: workdir,
      FULL_RELEASE_VALIDATION_RUN_ID:
        params.fullReleaseRunId ?? (params.fullReleasePreflight ? "111" : "222"),
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT:
        params.fullReleaseRunAttempt ?? (params.independentProducer ? "3" : "1"),
      MOCK_PREFLIGHT_RUN: JSON.stringify({
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        head_branch: params.preflightHeadBranch,
        head_sha: params.preflightHeadSha,
        path: params.fullReleasePreflight
          ? ".github/workflows/full-release-validation.yml"
          : ".github/workflows/openclaw-npm-release.yml",
        run_attempt: 1,
      }),
      PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH}`,
      PREFLIGHT_RUN_ID: "111",
      RELEASE_NPM_DIST_TAG: params.npmDistTag ?? "beta",
      RELEASE_TAG: "v2026.8.1-beta.3",
      RUNNER_TEMP: runnerTemp,
      WORKFLOW_SHA: params.currentWorkflowSha,
    },
  });
  return { ...result, outputPath: resolve(workdir, "github-output") };
}

async function runOpenClawNpmPreflightConsumerGuard(params: ProtectedPreflightConsumerParams) {
  const job = workflowJob(OPENCLAW_NPM_RELEASE_WORKFLOW, "publish_openclaw_npm");
  const script = workflowStep(job, "Verify preflight run metadata").run;
  if (!script) {
    throw new Error("Expected OpenClaw npm preflight consumer guard");
  }
  const workdir = tempDirs.make("openclaw-npm-preflight-consumer-");
  const binDir = resolve(workdir, "bin");
  mkdirSync(binDir);
  const qualificationEnv = await qualifiedPreflightConsumerFixture(workdir, params);
  const toolingDir = resolve(workdir, "trusted-workflow/scripts");
  writePreflightConsumerTooling(toolingDir);
  writeFileSync(
    resolve(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "run" && "$2" == "view" ]]; then
  printf '%s\\n' "$MOCK_PREFLIGHT_RUN"
  exit 0
fi
if [[ "$1" == "api" ]]; then
  ${PREFLIGHT_PRODUCER_GH_CASES}
  printf '%s\\n' "$MOCK_PREFLIGHT_METADATA"
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(binDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "rev-parse HEAD" ]]; then
  printf '%s\\n' "$MOCK_RELEASE_SHA"
  exit 0
fi
if [[ "$*" == *"merge-base --is-ancestor"* ]]; then
  [[ "$MOCK_TOOLING_ANCESTOR" == "true" ]]
  exit
fi
if [[ "$*" == *"cat-file -e"* || "$*" == *" fetch "* ]]; then
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  return spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...preflightProducerFixtureEnv(params),
      ...qualificationEnv,
      EXPECTED_EXTENDED_STABLE_BRANCH: params.expectedExtendedStableBranch ?? "",
      FULL_RELEASE_VALIDATION_RUN_ID:
        params.fullReleaseRunId ?? (params.fullReleasePreflight ? "111" : "222"),
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT:
        params.fullReleaseRunAttempt ?? (params.independentProducer ? "3" : "1"),
      GITHUB_OUTPUT: resolve(workdir, "github-output"),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      MOCK_PREFLIGHT_RUN: JSON.stringify({
        databaseId: 111,
        attempt: 1,
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        headBranch: params.preflightHeadBranch,
        headSha: params.preflightHeadSha,
        url: "https://github.com/openclaw/openclaw/actions/runs/111",
        workflowName: params.fullReleasePreflight
          ? "Full Release Validation"
          : "OpenClaw NPM Release",
      }),
      MOCK_PREFLIGHT_METADATA: JSON.stringify({
        run_attempt: 1,
        path: params.fullReleasePreflight
          ? ".github/workflows/full-release-validation.yml"
          : ".github/workflows/openclaw-npm-release.yml",
      }),
      MOCK_TOOLING_ANCESTOR: String(params.toolingAncestor !== false),
      MOCK_RELEASE_SHA: "d".repeat(40),
      MOCK_REMOTE_TAG_SHA: params.liveTagSha ?? params.currentWorkflowSha,
      PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH}`,
      PREFLIGHT_RUN_ID: "111",
      RELEASE_NPM_DIST_TAG: params.npmDistTag ?? "beta",
      RUN_KIND: "preflight",
      WORKFLOW_REF: params.currentRef,
      WORKFLOW_SHA: params.currentWorkflowSha,
    },
  });
}

type ReleaseCheckArtifact = {
  expired: boolean;
  id: number;
  name: string;
  workflow_run: { id: number };
};

type ReleaseCheckArtifactPair = {
  job: string;
  payloadBase: string;
  statusBase: string;
  variant?: string;
};

type ResolvedReleaseCheckArtifact = {
  job: string;
  payload_id: number;
  payload_name: string;
  producer_attempt: number;
  run_id: string;
  status_id: number;
  status_name: string;
  target_sha: string;
  variant: string;
};

function releaseCheckArtifact(params: {
  expired?: boolean;
  id: number;
  name: string;
  runId?: string;
}): ReleaseCheckArtifact {
  return {
    expired: params.expired ?? false,
    id: params.id,
    name: params.name,
    workflow_run: { id: Number(params.runId ?? "123456") },
  };
}

function runReleaseCheckArtifactResolve(params: {
  artifacts: ReleaseCheckArtifact[];
  consumerAttempt: string;
  pairs: ReleaseCheckArtifactPair[];
  runId?: string;
  targetSha?: string;
}) {
  const workdir = tempDirs.make("release-check-artifact-resolver-");
  const binDir = resolve(workdir, "bin");
  mkdirSync(binDir, { recursive: true });
  const ghPath = resolve(binDir, "gh");
  writeFileSync(ghPath, "#!/bin/sh\nprintf '%s\\n' \"$MOCK_ARTIFACT_RESPONSE\"\n");
  chmodSync(ghPath, 0o755);
  const runId = params.runId ?? "123456";
  const targetSha = params.targetSha ?? "a".repeat(40);
  const selectionFile = resolve(workdir, "selection.json");
  const githubOutput = resolve(workdir, "github-output");
  const args = [
    resolve(REPO_ROOT, RELEASE_CHECK_ARTIFACT_RESOLVER),
    "resolve",
    "--repository",
    "openclaw/openclaw",
    "--run-id",
    runId,
    "--consumer-attempt",
    params.consumerAttempt,
    "--target-sha",
    targetSha,
  ];
  for (const pair of params.pairs) {
    args.push(
      "--pair",
      [pair.job, pair.variant ?? "", pair.statusBase, pair.payloadBase].join("|"),
    );
  }
  args.push("--selection-file", selectionFile, "--github-output", githubOutput);
  const result = spawnSync("bash", args, {
    cwd: workdir,
    encoding: "utf8",
    env: {
      MOCK_ARTIFACT_RESPONSE: JSON.stringify({ artifacts: params.artifacts }),
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });
  const selection =
    result.status === 0
      ? (JSON.parse(readFileSync(selectionFile, "utf8")) as ResolvedReleaseCheckArtifact[])
      : [];
  return { result, selection, selectionFile, targetSha, workdir };
}

function releaseCheckStatusText(
  selection: ResolvedReleaseCheckArtifact,
  status: "cancelled" | "failure" | "skipped" | "success" = "success",
): string {
  return [
    `run_id=${selection.run_id}`,
    `run_attempt=${selection.producer_attempt}`,
    `target_sha=${selection.target_sha}`,
    `job=${selection.job}`,
    `variant=${selection.variant}`,
    `status=${status}`,
    "job_status=success",
    "step_outcomes=success",
    "",
  ].join("\n");
}

function runReleaseCheckArtifactValidation(params: {
  selection: ResolvedReleaseCheckArtifact[];
  statusText?: (selection: ResolvedReleaseCheckArtifact) => string;
}) {
  const workdir = tempDirs.make("release-check-artifact-validation-");
  const selectionFile = resolve(workdir, "selection.json");
  const statusDir = resolve(workdir, "statuses");
  const validatedFile = resolve(workdir, "validated.json");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(selectionFile, JSON.stringify(params.selection));
  for (const selection of params.selection) {
    const variant = selection.variant ? `-${selection.variant}` : "";
    writeFileSync(
      resolve(
        statusDir,
        `${selection.job}${variant}-${selection.run_id}-${selection.producer_attempt}.env`,
      ),
      params.statusText?.(selection) ?? releaseCheckStatusText(selection),
    );
  }
  const result = spawnSync(
    "bash",
    [
      resolve(REPO_ROOT, RELEASE_CHECK_ARTIFACT_RESOLVER),
      "validate",
      "--selection-file",
      selectionFile,
      "--status-dir",
      statusDir,
      "--validated-file",
      validatedFile,
    ],
    {
      cwd: workdir,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    },
  );
  const validated =
    result.status === 0
      ? (JSON.parse(readFileSync(validatedFile, "utf8")) as Array<
          ResolvedReleaseCheckArtifact & { status: string }
        >)
      : [];
  return { result, validated };
}

function runReleaseChecksSummary(params: {
  currentAttempt: string;
  currentResult: "cancelled" | "failure" | "skipped" | "success";
  discordResult?: "failure" | "skipped" | "success";
  phase?: "all" | "candidate" | "independent";
  resolveResult?: "failure" | "success";
  resultOverrides?: Record<string, "cancelled" | "failure" | "skipped" | "success">;
  telegramSelected?: boolean;
  telegramIdentityVerified?: boolean;
  validatedStatuses?: Array<{ job: string; status: string; variant: string }>;
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
  const selectionDir = resolve(workdir, ".artifacts/release-check-selection");
  mkdirSync(selectionDir, { recursive: true });
  writeFileSync(
    resolve(selectionDir, "advisory-evidence-validated.json"),
    JSON.stringify(params.validatedStatuses ?? []),
  );
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
      QA_LIVE_BUZZ_RELEASE_CHECKS_RESULT: "skipped",
      QA_LIVE_DISCORD_RELEASE_CHECKS_RESULT: params.discordResult ?? "skipped",
      QA_LIVE_RELEASE_CHECKS_RESULT: "skipped",
      QA_LIVE_SLACK_RELEASE_CHECKS_RESULT: "skipped",
      QA_LIVE_TELEGRAM_RELEASE_CHECKS_RESULT: params.currentResult,
      QA_LIVE_TELEGRAM_SELECTED: String(params.telegramSelected ?? true),
      QA_LIVE_TELEGRAM_IDENTITY_VERIFIED: String(params.telegramIdentityVerified ?? true),
      QA_LIVE_WHATSAPP_RELEASE_CHECKS_RESULT: "skipped",
      RELEASE_CHECK_RUN_ATTEMPT: params.currentAttempt,
      RELEASE_CHECK_RUN_ID: runId,
      RELEASE_CHECK_TARGET_SHA: targetSha,
      RELEASE_PHASE: params.phase ?? "all",
      RESOLVE_ADVISORY_EVIDENCE_OUTCOME: "success",
      RESOLVE_TARGET_RESULT: params.resolveResult ?? "success",
      RUNTIME_TOOL_COVERAGE_RELEASE_CHECKS_RESULT: "skipped",
      VALIDATE_ADVISORY_STATUSES_OUTCOME: "success",
      WORKFLOW_REF: params.workflowRef ?? "refs/heads/release/2026.7.1",
      ...params.resultOverrides,
    },
  });
}

describe("package acceptance workflow", () => {
  it("forwards Plugin SDK acknowledgement through the canonical publish dispatch", () => {
    const workflow = readWorkflow(RELEASE_PUBLISH_WORKFLOW);
    const input = workflow.on?.workflow_dispatch?.inputs?.plugin_sdk_api_acknowledgement;
    const resolveJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const downloadPreflight = workflowStep(resolveJob, "Download OpenClaw npm preflight manifest");
    const validateEvidence = workflowStep(resolveJob, "Validate OpenClaw npm preflight manifest");
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const dispatch = releasePublishOrchestration(publishJob);

    expect(readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8")).toContain(
      "group: openclaw-release-publish-${{ inputs.npm_dist_tag }}",
    );

    expect(input).toEqual({
      default: "",
      description:
        "8-character digest from the Plugin SDK API diff report when the release changes the SDK",
      required: false,
      type: "string",
    });
    expect(dispatch.env?.PLUGIN_SDK_API_ACKNOWLEDGEMENT).toBe(
      "${{ inputs.plugin_sdk_api_acknowledgement }}",
    );
    expect(validateEvidence.env?.PLUGIN_SDK_API_ACKNOWLEDGEMENT).toBe(
      "${{ inputs.plugin_sdk_api_acknowledgement }}",
    );
    expect(validateEvidence.env?.PLUGIN_SDK_API_VALIDATOR).toContain(
      "plugin-sdk-api-release-evidence.mjs",
    );
    expect(validateEvidence.run).toContain('node "$PLUGIN_SDK_API_VALIDATOR"');
    expect(validateEvidence.run).toContain('--acknowledge "$PLUGIN_SDK_API_ACKNOWLEDGEMENT"');
    expect(validateEvidence.run).toContain('npm view "openclaw@${RELEASE_NPM_DIST_TAG}" version');
    expect(validateEvidence.run).toContain('--current-selector-ref "$current_selector_ref"');
    expect(validateEvidence.run).toContain('--current-selector-sha "$current_selector_sha"');
    expect(validateEvidence.run).toContain("Immutable Plugin SDK API evidence artifact is missing");
    expect(validateEvidence.run).toContain("cmp -s <(jq -S '.pluginSdkApi'");
    expect(downloadPreflight.run).toContain('preflight_conclusion" != "success"');
    expect(downloadPreflight.run).toContain(
      'expected_extended_stable_branch="extended-stable/${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.33"',
    );
    expect(downloadPreflight.run).toContain(
      'preflight_path" != ".github/workflows/openclaw-npm-release.yml"',
    );
    expect(validateEvidence.run).toContain(
      'git merge-base --is-ancestor "$PREFLIGHT_WORKFLOW_SHA" "$WORKFLOW_SHA"',
    );
    expect(validateEvidence.run).toContain('"$PREFLIGHT_WORKFLOW_SHA" == "$EXPECTED_SHA"');
    expect(validateEvidence.run).toContain('--workflow-sha "$PREFLIGHT_WORKFLOW_SHA"');
    expect(publishJob.needs).toEqual(["resolve_release_target"]);
    expect(dispatch.run).toContain(
      '-f plugin_sdk_api_acknowledgement="${PLUGIN_SDK_API_ACKNOWLEDGEMENT}"',
    );
    expect(dispatch.run).toContain('--trusted-workflow-ref "${PARENT_WORKFLOW_BRANCH}"');
    expect(dispatch.run).toContain('--trusted-workflow-full-ref "${GITHUB_REF}"');
  });

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

  it.each([
    { scope: "all-publishable", core: "true", plugins: "" },
    { scope: "all-publishable", core: "false", plugins: "" },
    { scope: "selected", core: "false", plugins: "@openclaw/meta" },
  ])("rejects main before publishing children (scope=$scope, core=$core)", (mode) => {
    const result = runReleasePublishInputValidation({
      WORKFLOW_REF: "refs/heads/main",
      PLUGIN_PUBLISH_SCOPE: mode.scope,
      PUBLISH_OPENCLAW_NPM: mode.core,
      PLUGINS: mode.plugins,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("git tag release-publish/");
    expect(result.stderr).toContain("git push origin refs/tags/");
    expect(result.stderr).toContain("gh workflow run openclaw-release-publish.yml --ref");
  });

  it("retains the matching Tideclaw alpha parent route", () => {
    const result = runReleasePublishInputValidation({
      WORKFLOW_REF: "refs/heads/tideclaw/alpha/2026-09-03-1200Z",
      RELEASE_TAG: "v2026.9.1-alpha.1",
      RELEASE_NPM_DIST_TAG: "alpha",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("allows Docker-only recovery for beta, stable, and extended-stable releases", () => {
    for (const release of [
      { distTag: "beta", tag: "v2026.8.1-beta.2" },
      { distTag: "extended-stable", tag: "v2026.7.33" },
      { distTag: "latest", tag: "v2026.8.1" },
      { distTag: "latest", tag: "v2026.12.32-1" },
    ]) {
      const result = runReleasePublishInputValidation({
        WORKFLOW_REF: "refs/heads/main",
        PUBLISH_DOCKER_ONLY: "true",
        PUBLISH_OPENCLAW_NPM: "false",
        RELEASE_NPM_DIST_TAG: release.distTag,
        RELEASE_TAG: release.tag,
      });
      expect(result.status, result.stderr).toBe(0);
    }

    for (const tag of [
      "v2026.8.1-alpha.1",
      "v2026.8.1-beta.1",
      "v2026.7.33",
      "v2026.7.33-1",
      "v2026.13.1",
      "v2026.08.1",
      "v2026.8.01",
      "v2026.8.1-0",
    ]) {
      const result = runReleasePublishInputValidation({
        PUBLISH_DOCKER_ONLY: "true",
        PUBLISH_OPENCLAW_NPM: "false",
        RELEASE_NPM_DIST_TAG: "latest",
        RELEASE_TAG: tag,
      });
      expect(result.status, tag).toBe(1);
    }
    const rejectedInputs: Record<string, string>[] = [
      { PUBLISH_OPENCLAW_NPM: "true" },
      { PREFLIGHT_RUN_ID: "" },
      { FULL_RELEASE_VALIDATION_RUN_ID: "", FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "" },
      { RELEASE_NPM_DIST_TAG: "alpha", RELEASE_TAG: "v2026.8.1-alpha.1" },
    ];
    for (const overrides of rejectedInputs) {
      expect(
        runReleasePublishInputValidation({
          PUBLISH_DOCKER_ONLY: "true",
          PUBLISH_OPENCLAW_NPM: "false",
          RELEASE_NPM_DIST_TAG: "latest",
          RELEASE_TAG: "v2026.8.1",
          ...overrides,
        }).status,
      ).toBe(1);
    }

    const workflow = readWorkflow(RELEASE_PUBLISH_WORKFLOW);
    const input = workflow.on?.workflow_dispatch?.inputs?.publish_docker_only as
      | { description?: string }
      | undefined;
    const verifyJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "verify_core_npm_registry");
    const verifyStep = workflowStep(
      verifyJob,
      "Verify exact npm and selector readback matches preflight bytes",
    );
    expect(input?.description).toContain("beta, stable, or extended-stable");
    expect(verifyStep.env?.RELEASE_NPM_DIST_TAG).toBe("${{ inputs.npm_dist_tag }}");
    expect(verifyStep.run).toContain('npm view "openclaw@${RELEASE_NPM_DIST_TAG}" version');
    expect(verifyStep.run).not.toContain("npm view openclaw@extended-stable version");
  });

  it("accepts only exact protected SHA-pinned release publish tags", () => {
    const workflowSha = "a".repeat(40);
    const binDir = tempDirs.make("release-publish-gh-");
    const ghPath = `${binDir}/gh`;
    writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' "\${MOCK_REMOTE_TAG_SHA}"\n`);
    chmodSync(ghPath, 0o755);
    const pinnedEnv = {
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${binDir}:${process.env.PATH}`,
      WORKFLOW_REF: `refs/tags/release-publish/${workflowSha.slice(0, 12)}-123`,
      WORKFLOW_SHA: workflowSha,
    };

    const valid = runReleasePublishInputValidation({
      ...pinnedEnv,
      MOCK_REMOTE_TAG_SHA: workflowSha,
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

    const moved = runReleasePublishInputValidation({
      ...pinnedEnv,
      MOCK_REMOTE_TAG_SHA: "c".repeat(40),
    });
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain(
      "SHA-pinned release publish tag does not resolve to workflow SHA",
    );
  });

  it("keeps publish children on the parent's protected tag or Tideclaw branch", () => {
    const workflowSha = "a".repeat(40);
    const workflowRef = `release-publish/${workflowSha.slice(0, 12)}-123`;

    const main = runReleasePublishChildWorkflowRef();
    expect(main.status, main.stderr).toBe(1);
    expect(main.stderr).toContain("protected release-publish tag");
    expect(main.stderr).not.toContain("unexpected-github-lookup");

    const protectedTag = runReleasePublishChildWorkflowRef({
      WORKFLOW_FULL_REF: `refs/tags/${workflowRef}`,
    });
    expect(protectedTag.status, protectedTag.stderr).toBe(0);
    expect(protectedTag.stdout.trim()).toBe(workflowRef);

    const alphaRef = "tideclaw/alpha/2026-08-28-1400Z";
    const alpha = runReleasePublishChildWorkflowRef({
      WORKFLOW_FULL_REF: `refs/heads/${alphaRef}`,
    });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.stdout.trim()).toBe(alphaRef);

    const plan = workflowStep(
      workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish"),
      "Resolve ClawHub release plan",
    );
    expect(plan.env?.PARENT_WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    expectTextToIncludeAll(plan.run, [
      'source "${GITHUB_WORKSPACE}/.release-harness/scripts/lib/release-publish-children.sh"',
      'resolve_child_workflow_ref "${WORKFLOW_FULL_REF}"',
      'if [[ "${WORKFLOW_FULL_REF}" == refs/heads/tideclaw/alpha/* ]]',
      'BOOTSTRAP_WORKFLOW_REF="main"',
      'gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
      'BOOTSTRAP_WORKFLOW_REF="${CHILD_WORKFLOW_REF}"',
    ]);
  });

  it.each([
    { state: "requested", blocked: true },
    { state: "action_required", blocked: true },
    { state: "waiting", blocked: true },
    { state: "pending", blocked: true },
    { state: "queued", blocked: true },
    { state: "in_progress", blocked: true },
    { state: "completed", blocked: false },
    { state: "waiting", otherRef: true, blocked: false },
    { state: "waiting", dryRun: true, blocked: false },
    { state: "unavailable", blocked: true },
  ])(
    "prevents a ClawHub dispatch from queuing behind $state (otherRef=$otherRef, dryRun=$dryRun)",
    ({ state, otherRef, dryRun, blocked }) => {
      const root = tempDirs.make("clawhub-dispatch-collision-");
      const dispatchPath = join(root, "dispatch.json");
      const workflowRef = "release-publish/aaaaaaaaaaaa-123";
      const workflowSha = "a".repeat(40);
      const runUrl = "https://github.com/openclaw/openclaw/actions/runs/91";
      writeFileSync(
        join(root, "gh"),
        `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'run' && args[1] === 'list') {
  if (${JSON.stringify(state)} === 'unavailable') process.exit(42);
  const matches = args[args.indexOf('--status') + 1] === ${JSON.stringify(state)} &&
    args[args.indexOf('--branch') + 1] === ${JSON.stringify(otherRef ? "release-publish/bbbbbbbbbbbb-456" : workflowRef)};
  console.log(JSON.stringify(matches ? [{ databaseId: 91, status: ${JSON.stringify(state)}, url: ${JSON.stringify(runUrl)} }] : []));
} else if (args[0] === 'run' && args[1] === 'view') {
  console.log(JSON.stringify({ headSha: ${JSON.stringify(workflowSha)}, url: 'https://github.com/openclaw/openclaw/actions/runs/92' }));
} else if (args[0] === 'api' && args.some(arg => arg.includes('/commits/'))) {
  console.log(${JSON.stringify(workflowSha)});
} else if (args[0] === 'api' && args.some(arg => arg.endsWith('/dispatches'))) {
  writeFileSync(${JSON.stringify(dispatchPath)}, readFileSync(0, 'utf8'));
  console.log(JSON.stringify({ workflow_run_id: 92, html_url: 'https://github.com/openclaw/openclaw/actions/runs/92' }));
} else throw new Error('Unexpected GitHub operation: ' + JSON.stringify(args));
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "$HELPER_SCRIPT"
dispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" plugin-clawhub-release.yml -f ref="$TARGET_SHA" -f dry_run="$DRY_RUN"
`,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${root}:${process.env.PATH}`,
            HELPER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
            GITHUB_REF: `refs/tags/${workflowRef}`,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_STEP_SUMMARY: join(root, "summary"),
            WORKFLOW_REF: workflowRef,
            PARENT_WORKFLOW_SHA: workflowSha,
            TARGET_SHA: "b".repeat(40),
            DRY_RUN: String(dryRun ?? false),
          },
        },
      );
      expect(existsSync(dispatchPath)).toBe(!blocked);
      if (blocked) {
        expect(result.status).not.toBe(0);
        if (state !== "unavailable") {
          expect(result.stderr).toContain(runUrl);
          expect(result.stderr).toContain("pending_deployments");
          expect(result.stderr).toContain("state=rejected");
          expect(result.stderr).toContain("wait");
        }
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("92");
      }
    },
  );

  it("allows protected SHA-pinned tooling tags through the core npm publish guard", () => {
    const workflowSha = "a".repeat(40);
    const protectedRef = `refs/tags/release-publish/${workflowSha.slice(0, 12)}-123`;

    const valid = runOpenClawNpmTrustedRefGuard({
      WORKFLOW_REF: protectedRef,
      WORKFLOW_SHA: workflowSha,
      MOCK_REMOTE_TAG_SHA: workflowSha,
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

    const moved = runOpenClawNpmTrustedRefGuard({
      MOCK_REMOTE_TAG_SHA: "c".repeat(40),
      WORKFLOW_REF: protectedRef,
      WORKFLOW_SHA: workflowSha,
    });
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain(
      "SHA-pinned release-publish tag does not resolve to the OpenClaw npm workflow SHA",
    );
  });

  it.each([
    [PLUGIN_NPM_RELEASE_WORKFLOW, "preview_plugins_npm", "Resolve plugin release plan"],
    [PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "preview_plugins_clawhub", "Resolve plugin release plan"],
    [RELEASE_PUBLISH_WORKFLOW, "publish", "Resolve ClawHub release plan"],
    [
      ".github/workflows/plugin-clawhub-new.yml",
      "resolve_bootstrap_plan",
      "Resolve plugin bootstrap plan",
    ],
  ])("keeps plugin freshness warnings visible without blocking %s", (workflow, job, step) => {
    const root = tempDirs.make("plugin-plan-warnings-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), '#!/bin/sh\ncat "$MOCK_PLUGIN_PLAN"\n', { mode: 0o755 });
    const parentPlan = workflow === RELEASE_PUBLISH_WORKFLOW;
    if (parentPlan) {
      const helperDir = join(root, ".release-harness/scripts/lib");
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(
        join(helperDir, "release-publish-children.sh"),
        "resolve_child_workflow_ref() { printf '%s\\n' \"release-publish/aaaaaaaaaaaa-1\"; }\n",
      );
    }
    const plugin = {
      packageName: "@openclaw/example",
      packageDir: "extensions/example",
      version: "2026.9.1",
      channel: "stable",
      publishTag: "latest",
    };
    const warning =
      '@openclaw/example@2026.9.1: example-runtime pinned "1.2.3", npm latest is "1.2.4".';
    const planPath = join(root, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        all: [plugin],
        candidates: [plugin],
        bootstrapCandidates: [plugin],
        missingTrustedPublisher: [],
        skippedPublished: [],
        warnings: [warning],
        bootstrap: { shouldDispatch: false },
      }),
    );
    const script = workflowStep(workflowJob(workflow, job), step).run;
    if (!script) {
      throw new Error(`Missing plugin plan step in ${workflow}`);
    }
    const summaryPath = join(root, "summary.md");
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        MOCK_PLUGIN_PLAN: planPath,
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_WORKSPACE: root,
        RUNNER_TEMP: root,
        GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        WORKFLOW_FULL_REF: "refs/heads/main",
        PARENT_WORKFLOW_BRANCH: "main",
        PARENT_WORKFLOW_FULL_REF: "refs/heads/main",
        RELEASE_TAG: "v2026.9.1",
        TARGET_SHA: "b".repeat(40),
        PLUGIN_PUBLISH_SCOPE: "all-publishable",
        PLUGINS: "",
        PUBLISH_SCOPE: "all-publishable",
        RELEASE_PLUGINS: plugin.packageName,
        BASE_REF: "",
        NPM_DIST_TAG: "default",
        PREFLIGHT_ONLY: "false",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(summaryPath, "utf8")).toBe(`- Warning: ${warning}\n`);
    expect(result.stdout).toContain(plugin.packageName);
    expect(readFileSync(join(root, "output"), "utf8")).toContain(
      parentPlan ? "bootstrap_should_dispatch=false" : "candidate_count=1",
    );
  });

  it("runs plugin npm preflight trust from the exact workflow tooling checkout", () => {
    const job = workflowJob(PLUGIN_NPM_RELEASE_WORKFLOW, "preview_plugins_npm");
    const checkout = workflowStep(job, "Checkout trusted planning tooling");
    const identity = workflowStep(job, "Verify trusted preflight tooling identity");
    const target = workflowStep(job, "Validate ref is on a trusted publish branch");

    expect(checkout.if).toBeUndefined();
    expect(checkout.with).toMatchObject({
      "fetch-depth": 1,
      path: ".release-tooling",
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
    });
    expect(checkout.with?.["sparse-checkout"]).toBeUndefined();
    for (const [name, script] of [
      ["Validate publishable plugin metadata", "plugin-npm-release-check.ts"],
      ["Resolve plugin release plan", "plugin-npm-release-plan.ts"],
    ] as const) {
      const planner = workflowStep(job, name);
      expect(planner.run).toContain(`node --import tsx .release-tooling/scripts/${script}`);
      expect(planner.env?.TSX_TSCONFIG_PATH).toBe(
        "${{ github.workspace }}/.release-tooling/tsconfig.json",
      );
      expect(planner["working-directory"]).toBeUndefined();
    }
    expect(identity.if).toBe("github.event_name == 'workflow_dispatch' && inputs.preflight_only");
    expect(identity.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      WORKFLOW_FULL_REF: "${{ github.ref }}",
      WORKFLOW_REF: "${{ github.ref_name }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(identity.run).toContain(
      "node .release-tooling/scripts/release-tooling-identity.mjs verify",
    );
    expect(target.run).not.toContain('WORKFLOW_REF}" != "refs/heads/main');
    expect(target.run).not.toContain('git merge-base --is-ancestor "${WORKFLOW_SHA}" origin/main');
  });

  it("accepts only the live exact lightweight protected tag for plugin npm preflight", () => {
    const workflowSha = "a".repeat(40);
    const workflowRef = `release-publish/${workflowSha.slice(0, 12)}-123`;
    const workflowFullRef = `refs/tags/${workflowRef}`;
    const baseEnv = {
      MOCK_TAG_FULL_REF: workflowFullRef,
      MOCK_TAG_SHA: workflowSha,
      WORKFLOW_FULL_REF: workflowFullRef,
      WORKFLOW_REF: workflowRef,
      WORKFLOW_SHA: workflowSha,
    };

    const valid = runPluginNpmPreflightToolingGuard(baseEnv);
    expect(valid.status, valid.stderr).toBe(0);

    for (const rejected of [
      {
        name: "moved tag",
        env: { ...baseEnv, MOCK_TAG_SHA: "b".repeat(40) },
        error: "missing, moved, annotated, or bound to the wrong SHA",
      },
      {
        name: "annotated tag",
        env: { ...baseEnv, MOCK_TAG_TYPE: "tag" },
        error: "missing, moved, annotated, or bound to the wrong SHA",
      },
      {
        name: "wrong SHA prefix",
        env: {
          ...baseEnv,
          MOCK_TAG_FULL_REF: `refs/tags/release-publish/${"b".repeat(12)}-123`,
          WORKFLOW_FULL_REF: `refs/tags/release-publish/${"b".repeat(12)}-123`,
          WORKFLOW_REF: `release-publish/${"b".repeat(12)}-123`,
        },
        error: "SHA prefix does not match",
      },
      {
        name: "same-name branch",
        env: { ...baseEnv, WORKFLOW_FULL_REF: `refs/heads/${workflowRef}` },
        error: "exact tag full ref",
      },
    ]) {
      const result = runPluginNpmPreflightToolingGuard(rejected.env);
      expect(result.status, rejected.name).toBe(1);
      expect(result.stderr, rejected.name).toContain(rejected.error);
    }
  });

  it.each([
    ["aggregate", runReleasePublishPreflightConsumerGuard],
    ["core npm", runOpenClawNpmPreflightConsumerGuard],
  ] as const)(
    "binds %s historical preflight consumption to independent producer provenance",
    async (_name, run) => {
      const producerSha = "a".repeat(40);
      const producerTag = `release-publish/${producerSha.slice(0, 12)}-123`;
      const publisherSha = "b".repeat(40);
      const params = {
        currentRef: `refs/tags/release-publish/${publisherSha.slice(0, 12)}-456`,
        currentWorkflowSha: publisherSha,
        preflightHeadBranch: producerTag,
        preflightHeadSha: producerSha,
      };
      const valid = await run(params);
      expect(valid.status, valid.stderr).toBe(0);

      for (const rejected of [
        { preflightHeadBranch: `${producerTag}-wrong` },
        { preflightHeadSha: "c".repeat(40) },
        { producerTagSha: "c".repeat(40) },
        { producerTagType: "tag" },
        { producerBranches: [{ ref: `refs/heads/${producerTag}` }] },
        { mainComparisonStatus: "diverged" },
        { publisherComparisonStatus: "behind" },
      ]) {
        const result = await run({ ...params, ...rejected });
        expect(result.status, JSON.stringify(rejected)).toBe(1);
        expect(result.stderr).toMatch(/protected|reachable/u);
      }
    },
  );

  it("rejects a protected tooling tag moved after request validation and environment approval", async () => {
    const workflowSha = "a".repeat(40);
    const workflowTag = `release-publish/${workflowSha.slice(0, 12)}-123`;
    const protectedRef = `refs/tags/${workflowTag}`;
    const predecessor = runOpenClawNpmTrustedRefGuard({
      MOCK_REMOTE_TAG_SHA: workflowSha,
      WORKFLOW_REF: protectedRef,
      WORKFLOW_SHA: workflowSha,
    });
    expect(predecessor.status, predecessor.stderr).toBe(0);

    const consumer = await runOpenClawNpmPreflightConsumerGuard({
      currentRef: protectedRef,
      currentWorkflowSha: workflowSha,
      liveTagSha: "b".repeat(40),
      preflightHeadBranch: workflowTag,
      preflightHeadSha: workflowSha,
    });
    expect(consumer.status).toBe(1);
    expect(consumer.stderr).toContain(
      "Protected release-publish tag moved after npm-release approval",
    );
  });

  it.each([
    ["aggregate", runReleasePublishPreflightConsumerGuard, false],
    ["core npm", runOpenClawNpmPreflightConsumerGuard, false],
    ["aggregate with independent producer", runReleasePublishPreflightConsumerGuard, true],
    ["core npm with independent producer", runOpenClawNpmPreflightConsumerGuard, true],
  ] as const)(
    "admits only the exact selected FRV producer in %s publication",
    async (_name, run, independentProducer) => {
      const params = {
        currentRef: "refs/heads/main",
        currentWorkflowSha: "b".repeat(40),
        fullReleasePreflight: true,
        independentProducer,
        preflightHeadBranch: `release-ci/${"a".repeat(12)}-111`,
        preflightHeadSha: "a".repeat(40),
      };
      const accepted = await run(params);
      expect(accepted.status, accepted.stderr).toBe(0);
      for (const rejected of [
        { fullReleaseRunId: "222" },
        { fullReleaseRunAttempt: "2" },
        { fullReleasePreflight: false },
      ]) {
        const result = await run({ ...params, ...rejected });
        expect(result.status, JSON.stringify(rejected)).toBe(1);
      }
    },
  );

  it.each([false, true])(
    "keeps FRV tooling ancestry mandatory for extended-stable npm publication (independent=%s)",
    async (independentProducer) => {
      const params = {
        currentRef: "refs/heads/main",
        currentWorkflowSha: "b".repeat(40),
        fullReleasePreflight: true,
        independentProducer,
        npmDistTag: "extended-stable",
        expectedExtendedStableBranch: "extended-stable/2026.6.33",
        preflightHeadBranch: `release-ci/${"a".repeat(12)}-111`,
        preflightHeadSha: "a".repeat(40),
      };
      const accepted = await runOpenClawNpmPreflightConsumerGuard(params);
      expect(accepted.status, accepted.stderr).toBe(0);
      for (const preflightHeadBranch of [
        params.preflightHeadBranch,
        params.expectedExtendedStableBranch,
      ]) {
        const rejected = await runOpenClawNpmPreflightConsumerGuard({
          ...params,
          preflightHeadBranch,
          toolingAncestor: false,
        });
        expect(rejected.status, rejected.stderr).toBe(1);
        expect(rejected.stderr).toContain("trusted publish workflow lineage");
      }
    },
  );

  it.each([
    {
      name: "standalone FRV",
      fullReleasePreflight: true,
      independentProducer: true,
      version: "2026.8.1",
    },
    {
      name: "direct FRV",
      fullReleasePreflight: true,
      independentProducer: false,
      version: "2026.9.1",
    },
    {
      name: "historical NPM",
      fullReleasePreflight: false,
      independentProducer: false,
      version: "2026.8.1-beta.3",
    },
  ])("carries the $name artifact owner without replacing publication authority", async (mode) => {
    const producerRunId = mode.independentProducer ? "333" : "111";
    const fullReleaseRunId = mode.fullReleasePreflight ? "111" : "222";
    const resolved = await runReleasePublishPreflightConsumerGuard({
      ...mode,
      currentRef: "refs/heads/main",
      currentWorkflowSha: "b".repeat(40),
      preflightHeadBranch: "main",
      preflightHeadSha: "a".repeat(40),
    });
    expect(resolved.status, resolved.stderr).toBe(0);
    const stepOutputs = Object.fromEntries(
      readFileSync(resolved.outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    const target = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const expressions: Record<string, string> = {
      "${{ inputs.preflight_run_id }}": "111",
      "${{ inputs.full_release_validation_run_id }}": fullReleaseRunId,
    };
    for (const [name, value] of Object.entries(target.outputs ?? {})) {
      const field = value.match(/^\$\{\{ steps\.preflight_artifact\.outputs\.(\w+) \}\}$/u)?.[1];
      if (field) {
        expressions[`\${{ needs.resolve_release_target.outputs.${name} }}`] = stepOutputs[field];
      }
    }
    const publish = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const stepEnv = (step: WorkflowStep) =>
      Object.fromEntries(
        Object.entries({ ...publish.env, ...step.env })
          .filter(([, value]) => value in expressions)
          .map(([key, value]) => [key, expressions[value]]),
      );
    const fixture = createReleasePublishFixture(
      {
        EXPECTED_PRODUCER_RUN_ID: producerRunId,
        RELEASE_TAG: `v${mode.version}`,
        TARGET_SHA: "d".repeat(40),
        OPENCLAW_NPM_RESUME_RUN_ID: "777",
        NPM_TELEGRAM_RUN_ID: "",
      },
      {
        mockEvidence: false,
        functions: `
gh() {
  if [[ "$1 $2" == "run download" ]]; then
    record "download:$3"
    if [[ "$3" != "$EXPECTED_PRODUCER_RUN_ID" ]]; then
      echo "artifact belongs to $EXPECTED_PRODUCER_RUN_ID, not $3" >&2
      return 41
    fi
    shift 3
    local destination=""
    while (( $# )); do
      if [[ "$1" == "--dir" ]]; then destination="$2"; shift; fi
      shift
    done
    cp "$RUNNER_TEMP/preflight-manifest.json" "$destination/"
    cp -R "$RUNNER_TEMP/dependency-evidence" "$destination/"
  elif [[ "$1 $2" == "release edit" ]]; then
    record notes
  else return 99; fi
}
npm() { printf '%s\\n' 'https://example.invalid/openclaw.tgz'; }
curl() {
  while [[ "$1" != "-o" ]]; do shift; done
  cp "$RUNNER_TEMP/registry.tgz" "$2"
}
node() {
  if [[ "\${3:-}" == "$GITHUB_WORKSPACE/.release-harness/scripts/openclaw-npm-resume-run.mts" ]]; then
    printf '%s\\n' '{"url":"https://example.invalid/runs/777","workflowRef":"refs/tags/release-publish-verified","workflowSha":"${"a".repeat(40)}"}'
  else command node "$@"; fi
}
zip() { cat > "$3"; }
attach_or_verify_release_asset() { record "asset:$(cat "$1")"; }
write_clawhub_runtime_state() { printf '%s\\n' '{"proofLines":{"normal":"normal","bootstrap":"bootstrap"}}' > "$1"; }
render_github_release_notes() { cp "$2" "$1"; printf '%s\\n' '{"verificationIncluded":true}' > "$3"; }
`,
      },
    );
    const tarball = Buffer.from("published candidate bytes");
    writeFileSync(join(fixture.root, "registry.tgz"), tarball);
    writeFileSync(
      join(fixture.root, "preflight-manifest.json"),
      JSON.stringify({
        releaseSha: "d".repeat(40),
        tarballSha256: createHash("sha256").update(tarball).digest("hex"),
      }),
    );
    mkdirSync(join(fixture.root, "dependency-evidence"));
    writeFileSync(join(fixture.root, "dependency-evidence/report.json"), "{}");
    writeFileSync(
      join(fixture.root, "release-postpublish-evidence.json"),
      JSON.stringify({
        openclawNpmTarball: "https://example.invalid/openclaw.tgz",
        openclawNpmIntegrity: "sha512-fixture",
        ...(mode.fullReleasePreflight ? { telegramWaiver: `${mode.version}-owner-approved` } : {}),
      }),
    );
    const resume = fixture.run(
      {
        run: 'set -euo pipefail; source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"; resolve_openclaw_npm_publish_state; [[ "$openclaw_npm_already_published" == true ]]',
      },
      stepEnv(workflowStep(publish, "Dispatch publish workflows")),
    );
    expect.soft(resume.status, resume.stderr).toBe(0);
    const evidence = fixture.run(
      {
        run: 'set -euo pipefail; source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"; upload_dependency_evidence_release_asset',
      },
      stepEnv(workflowStep(publish, "Complete publish workflows")),
    );
    expect.soft(evidence.status, evidence.stderr).toBe(0);
    expect.soft(fixture.events()).toContain("asset:dependency-evidence/report.json");

    const core = workflowStep(publish, "Start core npm publication");
    const dispatched = fixture.run(core, stepEnv(core));
    expect(dispatched.status, dispatched.stderr).toBe(0);
    const dispatch = fixture.events().find((event) => event.startsWith("dispatch:"));
    expect(dispatch).toContain("-f preflight_run_id=111");
    expect(dispatch).toContain(`-f full_release_validation_run_id=${fullReleaseRunId}`);

    const proof = fixture.run(
      {
        run: 'set -euo pipefail; source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"; plugin_npm_run_id=101; openclaw_npm_run_id=404; windows_node_run_id=""; android_release_note=""; append_release_proof_to_github_release',
      },
      {
        ...stepEnv(workflowStep(publish, "Complete publish workflows")),
        POSTPUBLISH_EVIDENCE_DIR: fixture.root,
      },
    );
    expect(proof.status, proof.stderr).toBe(0);
    const proofText = readFileSync(join(fixture.root, "release-verification.md"), "utf8");
    expect(proofText).toContain(
      mode.fullReleasePreflight
        ? `Telegram integration checks: waived by the release owner for ${mode.version} (source QA, Package Acceptance, published-package E2E); not run.`
        : "npm Telegram beta E2E: not supplied",
    );
    expect
      .soft(proofText)
      .toContain(
        `- npm preflight: https://github.com/openclaw/openclaw/actions/runs/${producerRunId}`,
      );
    expect(proofText).toContain(
      `- full release validation: https://github.com/openclaw/openclaw/actions/runs/${fullReleaseRunId}`,
    );
  });

  it("uses the canonical tooling identity verifier for token-bootstrap evidence", () => {
    const publishJob = workflowJob(PLUGIN_NPM_RELEASE_WORKFLOW, "publish_plugins_npm");
    const evidenceStep = workflowStep(publishJob, "Resolve immutable npm publication artifact");

    expect(evidenceStep.env?.RELEASE_PUBLISH_RUN_ID).toBe("${{ inputs.release_publish_run_id }}");
    expect(evidenceStep.env?.RELEASE_PUBLISH_RUN_ATTEMPT).toBe(
      "${{ inputs.release_publish_run_attempt }}",
    );
    expect(evidenceStep.env?.RELEASE_PUBLISH_REF).toBe("${{ inputs.release_publish_branch }}");
    expect(evidenceStep.env?.RELEASE_PUBLISH_FULL_REF).toBe(
      "${{ inputs.release_publish_full_ref }}",
    );
    expect(evidenceStep.env?.RELEASE_PUBLISH_PARENT_STATE_POLICY).toBe(
      "${{ inputs.release_publish_run_id != '' && (github.actor == 'github-actions[bot]' && 'active-or-failure' || 'manual-recovery') || '' }}",
    );
    expect(evidenceStep.run).toContain("node scripts/release-tooling-identity.mjs verify");
    expect(evidenceStep.run).toContain('--workflow-ref "$WORKFLOW_HEAD_BRANCH"');
    expect(evidenceStep.run).toContain('--workflow-full-ref "$WORKFLOW_REF"');
    expect(evidenceStep.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(evidenceStep.run).toContain('--release-publish-run-id "$RELEASE_PUBLISH_RUN_ID"');
    expect(evidenceStep.run).toContain(
      '--release-publish-run-attempt "$RELEASE_PUBLISH_RUN_ATTEMPT"',
    );
    expect(evidenceStep.run).toContain('--release-publish-ref "$RELEASE_PUBLISH_REF"');
    expect(evidenceStep.run).toContain('--release-publish-full-ref "$RELEASE_PUBLISH_FULL_REF"');
    expect(evidenceStep.run).toContain(
      '--release-publish-parent-state-policy "$RELEASE_PUBLISH_PARENT_STATE_POLICY"',
    );
    expect(evidenceStep.run).not.toContain("--allow-prevalidated-ref");
  });

  it("revalidates protected tooling immediately before every core and plugin npm publish", () => {
    const corePublish = workflowStep(
      workflowJob(OPENCLAW_NPM_RELEASE_WORKFLOW, "publish_openclaw_npm"),
      "Publish",
    );
    expect(corePublish.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_PUBLISH_PARENT_STATE_POLICY:
        "${{ inputs.release_publish_run_id != '' && (github.actor == 'github-actions[bot]' && 'active' || 'manual-recovery') || '' }}",
      RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
      RELEASE_PUBLISH_REF: "${{ inputs.release_publish_branch }}",
      RELEASE_PUBLISH_FULL_REF: "${{ inputs.release_publish_full_ref }}",
      WORKFLOW_FULL_REF: "${{ github.ref }}",
      WORKFLOW_REF: "${{ github.ref_name }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(corePublish.run).toContain(
      "node trusted-workflow/scripts/release-tooling-identity.mjs verify",
    );
    expect(corePublish.run).toContain("--allow-prevalidated-ref");
    expect(corePublish.run).toContain(
      '--release-publish-run-attempt "$RELEASE_PUBLISH_RUN_ATTEMPT"',
    );
    expect(corePublish.run).toContain('--release-publish-ref "$RELEASE_PUBLISH_REF"');
    expect(corePublish.run).toContain('--release-publish-full-ref "$RELEASE_PUBLISH_FULL_REF"');
    expect(corePublish.run).toContain(
      '--release-publish-parent-state-policy "$RELEASE_PUBLISH_PARENT_STATE_POLICY"',
    );
    expect(corePublish.run).toMatch(
      /verify_release_tooling_identity\s+bash scripts\/openclaw-npm-publish\.sh --publish "\.\/\$\{tarball_path\}"/u,
    );
    expect(corePublish.run).toMatch(
      /verify_release_tooling_identity\s+bash scripts\/openclaw-npm-publish\.sh --publish "\$\{publish_target\}"/u,
    );

    const pluginPublishJob = workflowJob(PLUGIN_NPM_RELEASE_WORKFLOW, "publish_plugins_npm");
    const oidcPublish = workflowStep(pluginPublishJob, "Publish with trusted publisher");
    expect(oidcPublish.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      OPENCLAW_RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      OPENCLAW_RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
      OPENCLAW_RELEASE_PUBLISH_REF: "${{ inputs.release_publish_branch }}",
      OPENCLAW_RELEASE_PUBLISH_FULL_REF: "${{ inputs.release_publish_full_ref }}",
      OPENCLAW_RELEASE_PUBLISH_PARENT_STATE_POLICY:
        "${{ inputs.release_publish_run_id != '' && (github.actor == 'github-actions[bot]' && 'active-or-failure' || 'manual-recovery') || '' }}",
      OPENCLAW_RELEASE_TOOLING_FULL_REF: "${{ github.ref }}",
      OPENCLAW_RELEASE_TOOLING_REF: "${{ github.ref_name }}",
      OPENCLAW_RELEASE_TOOLING_REPOSITORY: "${{ github.repository }}",
      OPENCLAW_RELEASE_TOOLING_SHA: "${{ github.workflow_sha }}",
    });

    expect(oidcPublish.env).toMatchObject({
      TARBALL_PATH: "${{ steps.publication_evidence.outputs.tarball_path }}",
      PUBLISH_TAG: "${{ steps.publication_evidence.outputs.publish_tag }}",
    });
    expect(oidcPublish.run).toContain("node scripts/release-tooling-identity.mjs verify");
    expect(oidcPublish.run).toContain(
      '--release-publish-parent-state-policy "$OPENCLAW_RELEASE_PUBLISH_PARENT_STATE_POLICY"',
    );
    expect(oidcPublish.run).not.toContain("plugin-npm-publish.sh");

    const bootstrapPublish = workflowStep(pluginPublishJob, "Publish approved bootstrap tarball");
    expect(bootstrapPublish.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_PUBLISH_PARENT_STATE_POLICY:
        "${{ inputs.release_publish_run_id != '' && (github.actor == 'github-actions[bot]' && 'active-or-failure' || 'manual-recovery') || '' }}",
      RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
      RELEASE_PUBLISH_REF: "${{ inputs.release_publish_branch }}",
      RELEASE_PUBLISH_FULL_REF: "${{ inputs.release_publish_full_ref }}",
      WORKFLOW_FULL_REF: "${{ github.ref }}",
      WORKFLOW_REF: "${{ github.ref_name }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    const identityIndex =
      bootstrapPublish.run?.indexOf("node scripts/release-tooling-identity.mjs verify") ?? -1;
    const publishIndex = bootstrapPublish.run?.indexOf('npm publish "$TARBALL_PATH"') ?? -1;
    expect(identityIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(identityIndex);
    expect(bootstrapPublish.run?.slice(identityIndex, publishIndex)).not.toContain("npm view");
    expect(bootstrapPublish.run).toContain(
      '--release-publish-parent-state-policy "$RELEASE_PUBLISH_PARENT_STATE_POLICY"',
    );
    expect(bootstrapPublish.run).toContain('--release-publish-ref "$RELEASE_PUBLISH_REF"');
    expect(bootstrapPublish.run).toContain(
      '--release-publish-full-ref "$RELEASE_PUBLISH_FULL_REF"',
    );

    const oidcCheck = workflowStep(pluginPublishJob, "Check OIDC npm package version");
    expect(oidcCheck.run).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version');
    expect(oidcCheck.run).toContain("already_published=true");
    expect(oidcPublish.if).toContain(
      "steps.npm_package_version.outputs.already_published != 'true'",
    );
    const oidcReadback = workflowStep(pluginPublishJob, "Verify OIDC published runtime");
    expect(oidcReadback.if).toBe("steps.publication_evidence.outputs.publish_route == 'npm-oidc'");

    const pluginWrapper = readFileSync("scripts/plugin-npm-publish.sh", "utf8");
    expect(pluginWrapper).toContain('--release-publish-ref "${OPENCLAW_RELEASE_PUBLISH_REF:-}"');
    expect(pluginWrapper).toContain(
      '--release-publish-full-ref "${OPENCLAW_RELEASE_PUBLISH_FULL_REF:-}"',
    );
    expect(pluginWrapper).toContain(
      '--release-publish-parent-state-policy "${OPENCLAW_RELEASE_PUBLISH_PARENT_STATE_POLICY:-}"',
    );
    const distTagIndex = pluginWrapper.indexOf(
      'npm dist-tag add "${package_name}@${package_version}"',
    );
    const distTagIdentityIndex = pluginWrapper.lastIndexOf(
      "verify_release_tooling_identity",
      distTagIndex,
    );
    expect(distTagIdentityIndex).toBeGreaterThan(-1);
    expect(distTagIndex).toBeGreaterThan(distTagIdentityIndex);
  });

  it("binds release evidence validation to the exact trusted workflow ref", () => {
    for (const [workflowPath, jobName, stepName] of [
      [
        RELEASE_PUBLISH_WORKFLOW,
        "resolve_release_target",
        "Validate full release validation manifest",
      ],
      [
        OPENCLAW_NPM_RELEASE_WORKFLOW,
        "publish_openclaw_npm",
        "Verify full release validation evidence",
      ],
    ] as const) {
      const step = workflowStep(workflowJob(workflowPath, jobName), stepName);
      expect(step.env).toMatchObject({
        TRUSTED_WORKFLOW_FULL_REF: "${{ github.ref }}",
        TRUSTED_WORKFLOW_REF: "${{ github.ref_name }}",
        TRUSTED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      });
      expect(step.run).toContain("^refs/tags/release-publish/[a-f0-9]{12}-[1-9][0-9]*$");
      expect(step.run).toContain('trusted_publisher_ref="refs/tags/${TRUSTED_WORKFLOW_REF}"');
      expect(step.run).toContain('git rev-parse "${trusted_publisher_ref}^{commit}")" != "${');
      expect(step.run).toContain('"+refs/heads/main:${trusted_main_ref}"');
      expect(step.run).toContain('TRUSTED_MAIN_REF="${trusted_main_ref}"');
      expect(step.run).toContain('--trusted-workflow-ref "$TRUSTED_WORKFLOW_REF"');
      expect(step.run).toContain('--trusted-workflow-full-ref "$TRUSTED_WORKFLOW_FULL_REF"');
      expect(step.run).toContain('--trusted-workflow-sha "$TRUSTED_WORKFLOW_SHA"');
      expect(step.run).toContain('--verifier-source-sha "$');
    }
  });

  it("starts and approves core npm before the ClawHub receipt and bootstrap barriers", () => {
    const fixture = createReleasePublishFixture();
    const job = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    for (const step of job.steps ?? []) {
      if (step.name === "Authorize exact ClawHub package transactions") {
        fixture.record("authorize-clawhub");
      } else if (step.name === "Upload immutable ClawHub parent authorization") {
        fixture.record("upload-receipt");
      } else if (
        step.name === "Start core npm publication" ||
        step.name === "Complete publish workflows"
      ) {
        const result = fixture.run(step);
        expect(result.status, result.stderr).toBe(0);
      }
    }
    const events = fixture.events();
    const dispatchIndex = events.findIndex((event) =>
      event.startsWith("dispatch:openclaw-npm-release.yml"),
    );
    const receiptIndex = events.indexOf("authorize-clawhub");
    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex).toBeLessThan(receiptIndex);
    const draftIndex = events.indexOf("draft");
    expect(draftIndex).toBeGreaterThanOrEqual(0);
    expect(events).not.toContain("windows");
    expect(events).not.toContain("android");
    expect(dispatchIndex).toBeGreaterThan(draftIndex);
    const gateIndex = events.indexOf("wait:openclaw-npm-release.yml:publish_openclaw_npm:true");
    expect(gateIndex).toBeGreaterThan(dispatchIndex);
    expect(gateIndex).toBeLessThan(receiptIndex);
    expect(events).toContain("approval-environment:npm-release");
    expect(events.indexOf("wait:plugin-clawhub-new.yml:terminal:true")).toBeGreaterThan(
      dispatchIndex,
    );
    expect(events[dispatchIndex]).toContain("-f release_publish_run_id=44");
    expect(events[dispatchIndex]).toContain("-f release_publish_run_attempt=2");
    expect(events[dispatchIndex]).toContain("-f release_publish_full_ref=refs/heads/main");
    expect(events[dispatchIndex]).toContain("-f full_release_validation_run_attempt=3");
    expect(events).toContain("verify:0:bootstrap=true:workflow=refs/heads/main");
  });

  it.each([
    {
      failure: "receipt preparation",
      env: { CLAWHUB_AUTHORIZATION_OUTCOME: "failure", CLAWHUB_RECEIPT_OUTCOME: "skipped" },
      bootstrapCompleted: false,
      approvesClawHub: false,
    },
    {
      failure: "receipt upload",
      env: { CLAWHUB_RECEIPT_OUTCOME: "failure" },
      bootstrapCompleted: false,
      approvesClawHub: false,
    },
    {
      failure: "bootstrap publication",
      env: { MOCK_BOOTSTRAP_RESULT: "1" },
      bootstrapCompleted: false,
      approvesClawHub: true,
    },
    {
      failure: "normal ClawHub publication",
      env: { MOCK_CLAWHUB_RESULT: "1" },
      bootstrapCompleted: true,
      approvesClawHub: true,
    },
  ])(
    "collects core evidence after $failure fails",
    ({ env, bootstrapCompleted, approvesClawHub }) => {
      const fixture = createReleasePublishFixture();
      const job = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
      const start = fixture.run(workflowStep(job, "Start core npm publication"));
      expect(start.status, start.stderr).toBe(0);
      const completed = fixture.run(workflowStep(job, "Complete publish workflows"), env);
      expect(completed.status, completed.stderr).toBe(1);
      const events = fixture.events();
      expect(events).toContain("wait:openclaw-npm-release.yml:terminal:false");
      const approval = String(approvesClawHub);
      expect(events).toContain(`wait:plugin-clawhub-release.yml:terminal:${approval}`);
      expect(events).toContain(`wait:plugin-clawhub-new.yml:terminal:${approval}`);
      const verification = `verify:1:bootstrap=${bootstrapCompleted}:workflow=refs/heads/main`;
      expect(events.indexOf(verification)).toBeGreaterThan(
        events.lastIndexOf("finished:openclaw-npm-release.yml:0"),
      );
      expect(events).toContain("release-evidence");
      expect(events).not.toContain("windows");
      expect(fixture.summary()).toContain("left as draft");
    },
  );

  it.each(["plugin", "core"] as const)(
    "collects failed %s npm publication without repeating approval",
    (failedPublisher) => {
      const fixture = createReleasePublishFixture({
        MOCK_PLUGIN_NPM_RESULT: failedPublisher === "plugin" ? "1" : "0",
        MOCK_CORE_START_RESULT: failedPublisher === "core" ? "1" : "0",
        MOCK_CORE_RESULT: "1",
      });
      const job = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
      const start = fixture.run(workflowStep(job, "Start core npm publication"));
      expect(start.status, start.stderr).toBe(1);
      if (failedPublisher === "plugin") {
        expect(fixture.outputs().plugin_npm_completed).toBeUndefined();
        expect(fixture.events().some((event) => event.startsWith("dispatch:"))).toBe(false);
        expect(fixture.events().filter((event) => event.startsWith("cancel:"))).toHaveLength(2);
      } else {
        expect(fixture.outputs()).toMatchObject({
          plugin_npm_completed: "true",
          openclaw_npm_run_id: "404",
        });
        const completed = fixture.run(workflowStep(job, "Complete publish workflows"), {
          CORE_START_OUTCOME: "failure",
          CLAWHUB_AUTHORIZATION_OUTCOME: "skipped",
          CLAWHUB_RECEIPT_OUTCOME: "skipped",
        });
        expect(completed.status, completed.stderr).toBe(1);
        expect(fixture.events()).toContain("cancel:run cancel --repo openclaw/openclaw 404");
        expect(fixture.events()).toContain("wait:openclaw-npm-release.yml:terminal:false");
        expect(fixture.events().some((event) => event.startsWith("verify:"))).toBe(false);
      }
    },
  );

  it.each([false, true])("preserves detached ClawHub and npm resume=%s", (resume) => {
    const fixture = createReleasePublishFixture({
      WAIT_FOR_CLAWHUB: "false",
      CHILD_OPENCLAW_NPM_ALREADY_PUBLISHED: String(resume),
      CHILD_OPENCLAW_NPM_EXPECTED_WORKFLOW_REF: "refs/tags/release-publish/aaaaaaaaaaaa-42",
    });
    const job = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    for (const stepName of ["Start core npm publication", "Complete publish workflows"]) {
      const result = fixture.run(workflowStep(job, stepName));
      expect(result.status, result.stderr).toBe(0);
    }
    const events = fixture.events();
    expect(events.some((event) => event.startsWith("wait:plugin-clawhub"))).toBe(false);
    expect(events.some((event) => event.startsWith("dispatch:"))).toBe(!resume);
    expect(events).toContain(
      "verify:0:bootstrap=false:workflow=refs/tags/release-publish/aaaaaaaaaaaa-42",
    );
  });

  it("fetches release diagnostics only for completed failed jobs", () => {
    const root = tempDirs.make("release-failed-job-summary-");
    const jobsPath = join(root, "jobs.json");
    const callsPath = join(root, "log-requests");
    writeFileSync(callsPath, "");
    writeFileSync(
      jobsPath,
      JSON.stringify({
        jobs: [
          { databaseId: 101, name: "failed", status: "completed", conclusion: "failure" },
          { databaseId: 102, name: "cancelled", status: "completed", conclusion: "cancelled" },
          { databaseId: 103, name: "passed", status: "completed", conclusion: "success" },
          { databaseId: 104, name: "skipped", status: "completed", conclusion: "skipped" },
          { databaseId: 105, name: "running", status: "in_progress", conclusion: "" },
          { databaseId: 106, name: "queued", status: "queued", conclusion: "" },
        ],
      }),
    );
    const source = readFileSync("scripts/lib/release-publish-children.sh", "utf8");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
gh() {
  if [[ "$*" == *"--json jobs"* ]]; then
    local query
    for query; do :; done
    jq "$query" "$JOBS_FILE"
    return
  fi
  while (( $# )); do
    if [[ "$1" == "--job" ]]; then
      printf '%s\\n' "$2" >> "$LOG_REQUESTS"
      return
    fi
    shift
  done
  return 1
}
${shellFunctionSource(source, "print_failed_run_summary")}
print_failed_run_summary 404
`,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          JOBS_FILE: jobsPath,
          LOG_REQUESTS: callsPath,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, "utf8")).toBe("101\n102\n");
  });

  it.each([
    { mode: "lagged", exit: 0, approvals: 1 },
    { mode: "approved-queued", exit: 0, approvals: 1 },
    { mode: "unrelated-environment", exit: 1, approvals: 0 },
    { mode: "manual", exit: 0, approvals: 0 },
    { mode: "duplicate", exit: 1, approvals: 0 },
    { mode: "wrong-sha", exit: 1, approvals: 0 },
    { mode: "changed-sha-after-approval", exit: 1, approvals: 1 },
    { mode: "approval-failed", exit: 1, approvals: 1 },
    { mode: "passive", exit: 0, approvals: 0 },
  ])("observes the core publication gate: $mode", ({ mode, exit, approvals }) => {
    const root = tempDirs.make("release-publish-wait-");
    const calls = join(root, "calls");
    writeFileSync(calls, "");
    const source = readFileSync("scripts/lib/release-publish-children.sh", "utf8");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
iteration=0
gh() {
  if [[ "$1 $2" == "run cancel" ]]; then return 0; fi
  if [[ "$1 $2" == "run view" ]]; then
    if [[ "$*" == *"--json headSha,url"* ]]; then
      local sha="$EXPECTED_SHA"
      if [[ "$MODE" == "wrong-sha" || ( "$MODE" == "changed-sha-after-approval" && -f "$APPROVED" ) ]]; then
        sha="${"b".repeat(40)}"
      fi
      printf '{"headSha":"%s","url":"https://example.invalid/run/404"}\\n' "$sha"
    elif [[ "$*" == *"--json status,url,updatedAt"* ]]; then
      local state=in_progress
      if [[ ( "$MODE" == "passive" || "$MODE" == "unrelated-environment" ) && "$iteration" -gt 0 ]]; then state=completed; fi
      printf '{"status":"%s","url":"https://example.invalid/run/404","updatedAt":"2026-09-01T00:00:00Z"}\\n' "$state"
    elif [[ "$*" == *"--json jobs"* ]]; then
      local jobs
      if [[ "$MODE" == "duplicate" ]]; then
        jobs='[{"name":"publish_openclaw_npm","status":"in_progress"},{"name":"publish_openclaw_npm","status":"in_progress"}]'
      elif [[ "$MODE" == "manual" || ( -f "$APPROVED" && "$MODE" != "approved-queued" ) ]]; then
        jobs='[{"name":"publish_openclaw_npm","status":"in_progress"}]'
      else
        jobs='[{"name":"publish_openclaw_npm","status":"queued"}]'
      fi
      printf '{"jobs":%s}\\n' "$jobs" | jq -c "\${!#}"
    else
      local conclusion=success
      if [[ "$MODE" == "unrelated-environment" ]]; then conclusion=cancelled; fi
      printf '{"conclusion":"%s","url":"https://example.invalid/run/404","createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:01Z"}\\n' "$conclusion"
    fi
  elif [[ "$1 $2 $3" == "api -X GET" ]]; then
    if [[ "$MODE" == "lagged" && "$iteration" -eq 0 ]]; then printf '[]\\n';
    elif [[ "$MODE" == "unrelated-environment" ]]; then printf '[{"environment":{"id":8,"name":"other-release"},"current_user_can_approve":true}]\\n';
    else printf '[{"environment":{"id":7,"name":"npm-release"},"current_user_can_approve":true}]\\n'; fi
  elif [[ "$1 $2 $3" == "api -X POST" ]]; then
    printf 'approval\\n' >> "$CALLS"
    if [[ "$MODE" == "approval-failed" ]]; then return 42; fi
    touch "$APPROVED"
  else return 99; fi
}
sleep() { iteration=$((iteration + 1)); if [[ "$iteration" -gt 3 ]]; then exit 91; fi; }
print_pending_deployments() { :; }
print_failed_run_summary() { :; }
${shellFunctionSource(source, "verify_child_run_sha")}
${shellFunctionSource(source, "approve_pending_deployments")}
${shellFunctionSource(source, "wait_for_run")}
wait_for_run openclaw-npm-release.yml 404 "$EXPECTED_SHA" "$STARTED_JOB" "$APPROVE_ENVIRONMENTS" "$APPROVED_ENVIRONMENT"
`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          MODE: mode,
          EXPECTED_SHA: "a".repeat(40),
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          APPROVED: join(root, "approved"),
          CALLS: calls,
          STARTED_JOB: mode === "passive" ? "" : "publish_openclaw_npm",
          APPROVE_ENVIRONMENTS: String(mode !== "passive"),
          APPROVED_ENVIRONMENT: mode === "passive" ? "" : "npm-release",
        },
      },
    );
    expect(result.status, result.stderr || result.stdout).toBe(exit);
    expect(readFileSync(calls, "utf8").split("\n").filter(Boolean)).toHaveLength(approvals);
  });

  it.each(["2026.9.1\nsha=" + "b".repeat(40), "", "v2026.9.1", "2026.13.1", "2026.9"])(
    "rejects an Android pin that is not an exact version before writing outputs (%j)",
    (pin) => {
      const target = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
      const ref = workflowStep(target, "Resolve checked-out release ref");
      const root = tempDirs.make("release-android-pin-reject-");
      mkdirSync(join(root, "apps/android"), { recursive: true });
      writeFileSync(join(root, "apps/android/version.json"), JSON.stringify({ version: pin }));
      writeFileSync(join(root, "git"), `#!/bin/sh\nprintf '%s\\n' '${"a".repeat(40)}'\n`, {
        mode: 0o755,
      });
      const result = spawnSync("bash", ["-c", ref.run ?? ""], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env.PATH}`,
          RELEASE_TAG: "v2026.9.1",
          PUBLISH_OPENCLAW_NPM: "true",
          PUBLISH_DOCKER_ONLY: "false",
          GITHUB_OUTPUT: join(root, "output"),
          GITHUB_STEP_SUMMARY: join(root, "summary"),
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("exact YYYY.M.PATCH Android version");
      // A rejected pin must not reach GITHUB_OUTPUT at all, so it can never add output records.
      expect(existsSync(join(root, "output"))).toBe(false);
    },
  );

  it.each([
    { tag: "v2026.9.1", pin: "2026.7.4", native: false },
    { tag: "v2026.9.1", pin: "2026.9.1", native: true },
    { tag: "v2026.9.1-1", pin: "2026.9.1", native: true },
    { tag: "v2026.9.1-1", pin: "2026.7.4", native: false },
    { tag: "v2026.9.1-beta.1", pin: "2026.9.1", native: false },
    { tag: "v2026.9.1-alpha.1", pin: "2026.9.1", native: false },
  ])("admits Android only when $tag pins its native train ($pin)", ({ tag, pin, native }) => {
    const target = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const ref = workflowStep(target, "Resolve checked-out release ref");
    const root = tempDirs.make("release-android-pin-");
    mkdirSync(join(root, "apps/android"), { recursive: true });
    writeFileSync(join(root, "apps/android/version.json"), JSON.stringify({ version: pin }));
    writeFileSync(join(root, "git"), `#!/bin/sh\nprintf '%s\\n' '${"a".repeat(40)}'\n`, {
      mode: 0o755,
    });
    const summaryPath = join(root, "summary");
    writeFileSync(summaryPath, "");
    const result = spawnSync("bash", ["-c", ref.run ?? ""], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${root}:${process.env.PATH}`,
        RELEASE_TAG: tag,
        PUBLISH_OPENCLAW_NPM: "true",
        PUBLISH_DOCKER_ONLY: "false",
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const stepOutputs = Object.fromEntries(
      readFileSync(join(root, "output"), "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const outputs: Record<string, string> = { coverage_policy: "npm-stable-v1" };
    for (const [name, expression] of Object.entries(target.outputs ?? {})) {
      const field = expression.match(/^\$\{\{ steps\.ref\.outputs\.(\w+) \}\}$/u)?.[1];
      if (field) {
        outputs[name] = stepOutputs[field] ?? "";
      }
    }
    const inputs = { tag, publish_openclaw_npm: true, publish_docker_only: false };
    const needs = {
      resolve_release_target: { result: "success", outputs },
      publish: { result: "success" },
      qualify_android_native: { outputs: { qualified: "true" } },
    };
    const admitted = (jobName: string) =>
      runInNewContext(workflowJob(RELEASE_PUBLISH_WORKFLOW, jobName).if?.slice(3, -2) ?? "false", {
        inputs,
        needs,
        always: () => true,
        cancelled: () => false,
        contains: (value: string, needle: string) => value.includes(needle),
      });
    expect(admitted("qualify_android_native")).toBe(native);
    expect(admitted("publish_android")).toBe(native);
    // Broader evidence can omit the extra native CI, but never bypass the pin.
    outputs.coverage_policy = "";
    expect(admitted("publish_android")).toBe(native);
    outputs.coverage_policy = "npm-stable-v1";
    needs.qualify_android_native.outputs.qualified = "";
    expect(admitted("publish_android")).toBe(false);
    inputs.publish_openclaw_npm = false;
    expect(admitted("qualify_android_native")).toBe(false);
    expect(admitted("publish_android")).toBe(false);
    expect(outputs.android_pin_version).toBe(pin);
    expect(workflowStep(target, "Checkout release tag").with?.["sparse-checkout"]).toContain(
      "apps/android/version.json",
    );

    if (tag.includes("alpha") || tag.includes("beta") || native) {
      return;
    }
    const note = `- Android APK: skipped — apps/android/version.json is ${pin}, release train is 2026.9.1; run the shared mobile cutter (scripts/mobile-release-version.ts --prepare) before the next tag.`;
    expect(readFileSync(summaryPath, "utf8")).toContain(note);
    expect(outputs.android_release_note).toBe(note);
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    expect(publishJob.env?.ANDROID_RELEASE_NOTE).toBe(
      "${{ needs.resolve_release_target.outputs.android_release_note }}",
    );
    const fixture = createReleasePublishFixture(
      {
        RELEASE_TAG: tag,
        ANDROID_RELEASE_NOTE: outputs.android_release_note ?? "",
        CHILD_OPENCLAW_NPM_ALREADY_PUBLISHED: "true",
      },
      { functions: 'append_release_proof_to_github_release() { record "$android_release_note"; }' },
    );
    const completed = fixture.run(workflowStep(publishJob, "Complete publish workflows"));
    expect(completed.status, completed.stderr).toBe(0);
    expect(fixture.events()).toContain(note);
  });

  it("resolves broad release evidence and exact-binds every publish child", () => {
    const resolveJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const publishOrchestration = releasePublishOrchestration(publishJob);

    for (const stepName of [
      "Download OpenClaw npm preflight manifest",
      "Resolve full release validation run",
      "Download full release validation manifest",
      "Validate OpenClaw npm preflight manifest",
      "Validate full release validation manifest",
    ]) {
      expect(workflowStep(resolveJob, stepName).if).toContain(
        "inputs.plugin_publish_scope == 'all-publishable'",
      );
    }
    expect(
      workflowStep(resolveJob, "Checkout trusted release validation tooling").with,
    ).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
      "sparse-checkout": "scripts",
    });
    for (const stepName of [
      "Write Android release approval",
      "Attest Android release approval",
      "Upload Android release approval",
    ]) {
      const androidJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish_android");
      expect(workflowStep(androidJob, stepName)).toBeDefined();
      expect(androidJob.if).toContain("inputs.publish_openclaw_npm");
    }
    const nativeJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "qualify_android_native");
    const androidJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish_android");
    expect(nativeJob.needs).toEqual(["resolve_release_target"]);
    expect(nativeJob.if).toContain("coverage_policy == 'npm-stable-v1'");
    expect(androidJob.needs).toEqual([
      "resolve_release_target",
      "publish",
      "qualify_android_native",
    ]);
    expect(androidJob.if).toContain("needs.qualify_android_native.outputs.qualified == 'true'");
    expect(publishJob.needs).toEqual(["resolve_release_target"]);
    expect(workflowJob(RELEASE_PUBLISH_WORKFLOW, "finalize_github_release").needs).toEqual([
      "publish",
      "publish_docker",
    ]);
    expect(nativeJob["continue-on-error"]).toBe(true);
    expect(androidJob["continue-on-error"]).toBe(true);

    expect(publishOrchestration.env?.PARENT_WORKFLOW_SHA).toBe("${{ github.sha }}");
    expect(publishOrchestration.env?.PARENT_WORKFLOW_BRANCH).toBe("${{ github.ref_name }}");
    expect(publishOrchestration.env?.PARENT_WORKFLOW_FULL_REF).toBe("${{ github.ref }}");
    expect(publishOrchestration.env?.CHILD_WORKFLOW_REF).toBe(
      "${{ steps.clawhub_plan.outputs.child_workflow_ref }}",
    );
    expect(readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8")).toContain(
      "public verification follows terminal parent success",
    );
    expectTextToIncludeAll(publishOrchestration.run, [
      'gh api "repos/${GITHUB_REPOSITORY}/commits/${encoded_workflow_ref}"',
      'if [[ "$resolved_workflow_sha" != "$expected_sha" ]]',
      'verify_child_run_sha "$workflow" "$run_id" "$expected_sha" || return 1',
      'approve_pending_deployments "${workflow}" "${run_id}" "${expected_sha}"',
      'dispatch_workflow_at_ref "${RELEASE_TAG}" "${TARGET_SHA}" android-release.yml',
      'wait_for_run plugin-npm-release.yml "${plugin_npm_run_id}" "${PARENT_WORKFLOW_SHA}"',
      'wait_for_run_background openclaw-npm-release.yml "${openclaw_npm_run_id}" "${PARENT_WORKFLOW_SHA}"',
      '-f release_publish_branch="${PARENT_WORKFLOW_BRANCH}"',
      '-f release_publish_full_ref="${PARENT_WORKFLOW_FULL_REF}"',
      "plugin-clawhub-release.yml: detached; approval and publish not awaited",
      "plugin-clawhub-new.yml: detached; approvals and bootstrap not awaited",
    ]);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "dispatches qualified Android without awaiting it (dispatch failure: %s, existing assets: %s)",
    (dispatchFailure, assetsVerified) => {
      const script = readFileSync("scripts/lib/release-publish-children.sh", "utf8");
      const root = tempDirs.make("android-detached-publish-");
      const summaryPath = join(root, "summary");
      writeFileSync(summaryPath, "");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
is_android_release() { return 0; }
verify_android_release_asset_contract() { return ${assetsVerified ? 0 : 1}; }
dispatch_workflow_at_ref() { ${dispatchFailure ? "return 1" : "echo 456"}; }
wait_for_run() { echo unexpected-android-wait >&2; return 1; }
${shellFunctionSource(script, "promote_android_release_asset")}
native_failed=0
promote_android_release_asset || native_failed=$?
printf 'native_failed=%s\\n' "$native_failed"
`,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            RUNNER_TEMP: root,
            GITHUB_STEP_SUMMARY: summaryPath,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "2",
            RELEASE_TAG: "v2026.8.1",
            TARGET_SHA: "a".repeat(40),
            PARENT_WORKFLOW_BRANCH: "main",
            PARENT_WORKFLOW_FULL_REF: "refs/heads/main",
            PARENT_WORKFLOW_SHA: "d".repeat(40),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `native_failed=${dispatchFailure && !assetsVerified ? 1 : 0}`,
      );
      expect(result.stderr).not.toContain("unexpected-android-wait");
      const summary = readFileSync(summaryPath, "utf8");
      if (assetsVerified) {
        expect(summary).toContain("previously published assets verified");
        expect(summary).toContain("releases/download/v2026.8.1/OpenClaw-Android.apk");
        expect(summary).not.toContain("actions/runs/456");
      } else if (dispatchFailure) {
        expect(summary).not.toContain("actions/runs/456");
      } else {
        expect(summary).toContain("completion not awaited");
        expect(summary).toContain("https://github.com/openclaw/openclaw/actions/runs/456");
      }
    },
  );

  it.each([
    "success",
    "rerun-before-approval",
    "rerun-at-dispatch",
    "moved-protected-tag",
    "failed",
    "rerun",
    "other-source",
    "other-ref",
    "other-workflow",
    "other-repository",
    "other-tooling",
  ])("binds native qualification through Android approval and dispatch: %s", (mode) => {
    const root = tempDirs.make("android-native-qualification-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, ".release-harness"));
    symlinkSync(resolve("scripts"), join(root, ".release-harness/scripts"), "dir");
    const targetSha = "a".repeat(40);
    const workflowSha = "d".repeat(40);
    const workflowRef = `release-publish/${workflowSha.slice(0, 12)}-123`;
    const dispatchId = `release-native-android-123-2-${targetSha}`;
    const run = {
      id: 91,
      run_attempt: mode === "rerun" ? 2 : 1,
      event: "workflow_dispatch",
      path: mode === "other-workflow" ? ".github/workflows/other.yml" : ".github/workflows/ci.yml",
      display_title: `CI ${mode === "other-source" ? dispatchId.replace(targetSha, "b".repeat(40)) : dispatchId}`,
      head_branch: mode === "other-ref" ? "main" : workflowRef,
      head_sha: mode === "other-tooling" ? "c".repeat(40) : workflowSha,
      repository: {
        full_name: mode === "other-repository" ? "example/other" : "openclaw/openclaw",
      },
      actor: { login: "github-actions[bot]" },
      triggering_actor: { login: "github-actions[bot]" },
      status: "completed",
      conclusion: mode === "failed" ? "failure" : "success",
    };
    const dispatchPath = join(root, "dispatch.json");
    const androidDispatchPath = join(root, "android-dispatch.json");
    const nativeRunPath = join(root, "native-run.json");
    writeFileSync(nativeRunPath, JSON.stringify(run));
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'api' && args.some(arg => arg.endsWith('/workflows/ci.yml/dispatches'))) {
  writeFileSync(${JSON.stringify(dispatchPath)}, readFileSync(0, 'utf8'));
  console.log(JSON.stringify({ workflow_run_id: 91, html_url: 'https://github.com/openclaw/openclaw/actions/runs/91' }));
} else if (args[0] === 'api' && args.some(arg => arg.endsWith('/workflows/android-release.yml/dispatches'))) {
  writeFileSync(${JSON.stringify(androidDispatchPath)}, readFileSync(0, 'utf8'));
  console.log(JSON.stringify({ workflow_run_id: 92, html_url: 'https://github.com/openclaw/openclaw/actions/runs/92' }));
} else if (args[0] === 'api' && args.some(arg => arg.includes('/commits/'))) {
  const endpoint = args.find(arg => arg.includes('/commits/'));
  if (endpoint.endsWith('/v2026.8.1')) {
    if (${mode === "rerun-at-dispatch"}) {
      const run = JSON.parse(readFileSync(${JSON.stringify(nativeRunPath)}, 'utf8'));
      writeFileSync(${JSON.stringify(nativeRunPath)}, JSON.stringify({ ...run, run_attempt: 2, status: 'queued', conclusion: null }));
    }
    console.log(${JSON.stringify(targetSha)});
  } else {
    console.log(endpoint.endsWith('/main') || ${mode === "moved-protected-tag"} ? ${JSON.stringify("e".repeat(40))} : ${JSON.stringify(workflowSha)});
  }
} else if (args[0] === 'api' && args[1].endsWith('/actions/runs/91')) {
  console.log(readFileSync(${JSON.stringify(nativeRunPath)}, 'utf8'));
} else if (args[0] === 'run' && args[1] === 'view') {
  if (args.includes('jobs')) process.exit(0);
  const run = JSON.parse(readFileSync(${JSON.stringify(nativeRunPath)}, 'utf8'));
  console.log(JSON.stringify({
    headSha: args.includes('92') ? ${JSON.stringify(targetSha)} : run.head_sha,
    status: run.status, conclusion: run.conclusion,
    createdAt: '2026-08-30T10:00:00Z', updatedAt: '2026-08-30T10:01:00Z',
    url: 'https://github.com/openclaw/openclaw/actions/runs/91',
  }));
} else throw new Error('Unexpected GitHub operation: ' + JSON.stringify(args));
`,
    );
    chmodSync(gh, 0o755);
    const nativeJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "qualify_android_native");
    const approvalJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish_android");
    const dispatch = workflowStep(nativeJob, "Dispatch and await exact-source native CI");
    const proof = workflowStep(nativeJob, "Verify exact native CI qualification");
    const approval = workflowStep(approvalJob, "Write Android release approval");
    expect(nativeJob.outputs).toMatchObject({
      workflow_ref: "${{ steps.dispatch.outputs.workflow_ref }}",
    });
    expect(proof.env?.NATIVE_CI_WORKFLOW_REF).toBe("${{ steps.dispatch.outputs.workflow_ref }}");
    expect(approval.env?.NATIVE_CI_WORKFLOW_REF).toBe(
      "${{ needs.qualify_android_native.outputs.workflow_ref }}",
    );
    const outputPath = join(root, "output");
    writeFileSync(outputPath, "");
    const rerunBeforeApproval =
      mode === "rerun-before-approval"
        ? `
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(nativeRunPath)};
const run = JSON.parse(readFileSync(path, 'utf8'));
writeFileSync(path, JSON.stringify({ ...run, run_attempt: 2, status: 'queued', conclusion: null }));
NODE
`
        : "";
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          dispatch.run,
          proof.run,
          rerunBeforeApproval,
          approval.run,
          'dispatch_workflow_at_ref "$RELEASE_TAG" "$TARGET_SHA" android-release.yml -f tag="$RELEASE_TAG"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: root,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_REF: `refs/tags/${workflowRef}`,
          WORKFLOW_FULL_REF: `refs/tags/${workflowRef}`,
          PARENT_WORKFLOW_SHA: workflowSha,
          TARGET_SHA: targetSha,
          RELEASE_TAG: "v2026.8.1",
          RELEASE_COVERAGE_POLICY: "npm-stable-v1",
          NATIVE_CI_RUN_ID: "91",
          NATIVE_CI_WORKFLOW_REF: workflowRef,
          NATIVE_CI_WORKFLOW_SHA: workflowSha,
          RELEASE_PUBLISH_BRANCH: "main",
          RELEASE_PUBLISH_FULL_REF: "refs/heads/main",
          RELEASE_PUBLISH_WORKFLOW_SHA: workflowSha,
          RELEASE_PUBLISH_RUN_ATTEMPT: "2",
          RELEASE_PUBLISH_RUN_ID: "123",
        },
      },
    );
    if (mode === "moved-protected-tag") {
      expect(existsSync(dispatchPath)).toBe(false);
      expect(result.stderr).toContain("refusing dispatch");
    } else {
      expect(JSON.parse(readFileSync(dispatchPath, "utf8"))).toEqual({
        ref: workflowRef,
        inputs: {
          target_ref: targetSha,
          historical_target_tag: "v2026.8.1",
          include_android: "true",
          release_scope: "full",
          dispatch_id: dispatchId,
        },
      });
      if (mode === "other-tooling") {
        expect(readFileSync(outputPath, "utf8")).toBe("");
        expect(result.stderr).toContain("used workflow SHA");
      } else {
        expect(readFileSync(outputPath, "utf8")).toContain(`workflow_ref=${workflowRef}`);
      }
    }
    const approvalPath = join(root, "android-release-approval/approval.json");
    const approved = mode === "success" || mode === "rerun-at-dispatch";
    const qualified = approved || mode === "rerun-before-approval";
    expect(existsSync(approvalPath)).toBe(approved);
    if (approved) {
      expect(JSON.parse(readFileSync(approvalPath, "utf8"))).toEqual({
        version: 3,
        repository: "openclaw/openclaw",
        workflow: "OpenClaw Release Publish",
        parentRunId: "123",
        parentRunAttempt: 2,
        workflowBranch: "main",
        workflowFullRef: "refs/heads/main",
        parentWorkflowSha: workflowSha,
        releaseTag: "v2026.8.1",
        targetSha,
        nativeCi: { runId: "91", runAttempt: 1, workflowRef },
      });
    }
    expect(existsSync(androidDispatchPath)).toBe(mode === "success");
    expect(readFileSync(outputPath, "utf8").includes("qualified=true")).toBe(qualified);
    expect(result.status === 0, result.stderr).toBe(mode === "success");
    if (mode === "rerun-before-approval" || mode === "rerun-at-dispatch") {
      expect(result.stderr).toContain("exact completed successful native CI attempt");
    }
  });

  it("requires native-bound approval support only for Android qualification", () => {
    const job = workflowJob(RELEASE_PUBLISH_WORKFLOW, "qualify_android_native");
    const step = workflowStep(job, "Verify Android approval consumer capability");
    const root = tempDirs.make("android-frozen-approval-consumer-");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("remote", "add", "origin", root);
    git(
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "legacy consumer",
    );
    const legacySource = git("rev-parse", "HEAD");
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/android-native-ci.mjs"), "export {};\n");
    git("add", "scripts/android-native-ci.mjs");
    git(
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.com",
      "commit",
      "-qm",
      "native-bound consumer",
    );
    const supportedSource = git("rev-parse", "HEAD");
    for (const source of [legacySource, supportedSource]) {
      const result = spawnSync("bash", ["-c", step.run ?? ""], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, EXPECTED_SHA: source },
      });
      expect(result.status === 0, result.stderr).toBe(source === supportedSource);
    }
  });

  it("compares dependency evidence zip contents independently of archive timestamps", () => {
    const orchestration = releasePublishOrchestration(
      workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish"),
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

  it.each([
    {
      label: "current Docker publication",
      docker: "current",
      conclusion: "success",
      npm: true,
      ok: true,
    },
    {
      label: "historical Docker publication",
      docker: "historical",
      conclusion: "success",
      npm: true,
      ok: true,
    },
    {
      label: "failed Docker publication",
      docker: "current",
      conclusion: "failure",
      npm: true,
      ok: false,
    },
    {
      label: "missing Docker publication",
      docker: "missing",
      conclusion: "success",
      npm: true,
      ok: false,
    },
    {
      label: "ambiguous Docker publication",
      docker: "both",
      conclusion: "success",
      npm: true,
      ok: false,
    },
    {
      label: "missing npm publication",
      docker: "current",
      conclusion: "success",
      npm: false,
      ok: false,
    },
  ])(
    "checks $label for failed-parent closeout without app evidence",
    ({ docker, conclusion, npm, ok }) => {
      const evidenceStep = workflowStep(
        workflowJob(STABLE_MAIN_CLOSEOUT_WORKFLOW, "verify"),
        "Verify release workflow evidence",
      );
      const script = evidenceStep.run?.match(
        /node --input-type=module - "\$RUNNER_TEMP\/release-publish-run.json" <<'NODE'\n([\s\S]*?)\nNODE/u,
      )?.[1];
      expect(script).toBeDefined();
      const root = tempDirs.make("stable-closeout-recovery-");
      const runPath = join(root, "run.json");
      const jobs = npm ? [{ name: "Publish plugins, then OpenClaw", conclusion: "success" }] : [];
      if (docker === "current" || docker === "both") {
        jobs.push({ name: "Publish Docker images / Publish prepared Docker images", conclusion });
      }
      if (docker === "historical" || docker === "both") {
        jobs.push({
          name: "Publish Docker images / Verify attestations and promote channel",
          conclusion,
        });
      }
      writeFileSync(
        runPath,
        JSON.stringify({
          workflowName: "OpenClaw Release Publish",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "failure",
          jobs,
        }),
      );
      const result = spawnSync(process.execPath, ["--input-type=module", "-", runPath], {
        input: script,
        encoding: "utf8",
        env: { ...process.env, ALLOW_FAILED_PUBLISH_RECOVERY: "true" },
      });
      expect(result.status, result.stderr).toBe(ok ? 0 : 1);
      if (ok) {
        expect(result.stdout).toContain("apps may be pending");
      } else {
        expect(result.stderr).toContain("requires one successful publication job");
      }
    },
  );

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
    expect(
      workflowStep(
        workflowJob(STABLE_MAIN_CLOSEOUT_WORKFLOW, "verify"),
        "Checkout trusted closeout tooling",
      ).with,
    ).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: ".closeout-tooling",
      "persist-credentials": false,
    });
    expect(workflow).toContain("node .closeout-tooling/scripts/verify-stable-main-closeout.mjs");
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
    expect(workflow).toContain('--allow-failed-publish-recovery "$ALLOW_FAILED_PUBLISH_RECOVERY"');
    expect(workflow).toContain('"Publish Docker images / Publish prepared Docker images"');
    expect(workflow).toContain(
      'existing_manifest_args=(--existing-manifest "$CLOSEOUT_DIR/$closeout_asset"',
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
      "if: ${{ inputs.cache-mode != 'off' && runner.os != 'Windows' }}",
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

    const setupReleaseHarnessAction = readFileSync(SETUP_RELEASE_HARNESS_ACTION, "utf8");
    const setupHarnessPackageManagerIndex = setupReleaseHarnessAction.indexOf(
      "Setup trusted release harness package manager",
    );
    const installHarnessDependenciesIndex = setupReleaseHarnessAction.indexOf(
      "Install trusted release harness dependencies",
    );
    expect(setupHarnessPackageManagerIndex).toBeGreaterThan(-1);
    expect(installHarnessDependenciesIndex).toBeGreaterThan(setupHarnessPackageManagerIndex);
    expect(setupReleaseHarnessAction).toContain(
      "uses: ./.release-harness/.github/actions/setup-pnpm-store-cache",
    );
    expect(setupReleaseHarnessAction).toContain(
      "package-manager-file: .release-harness/package.json",
    );
    expect(setupReleaseHarnessAction).toContain("working-directory: .release-harness");
    expect(setupReleaseHarnessAction).toContain(
      "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
    );

    const setupNodeAction = readFileSync(".github/actions/setup-node-env/action.yml", "utf8");
    expect(setupNodeAction).toContain("Normalize container toolcache");
    expect(setupNodeAction).toContain("ln -s /__t /opt/hostedtoolcache");

    for (const workflowPath of workflowPaths()) {
      const workflowText = readFileSync(workflowPath, "utf8");
      expect(workflowText, workflowPath).not.toContain("PNPM_VERSION");
      expect(workflowText, workflowPath).not.toContain("pnpm-version:");
      expect(workflowText, workflowPath).not.toContain("pnpm/action-setup");
    }
  });

  it("retries pnpm store path resolution after a transient executable download failure", () => {
    const action = parse(readFileSync(SETUP_PNPM_STORE_CACHE_ACTION, "utf8")) as {
      runs: { steps: WorkflowStep[] };
    };
    const step = action.runs.steps.find(
      (candidate) => candidate.name === "Resolve pnpm store path",
    );
    expect(step?.run).toBeDefined();

    const root = tempDirs.make("pnpm-store-path-retry-");
    const binDir = join(root, "bin");
    const attemptsPath = join(root, "attempts");
    const sleepPath = join(root, "sleeps");
    const outputPath = join(root, "output");
    const storePath = join(root, "store");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "pnpm"),
      `#!/bin/sh
attempts=$(cat "$MOCK_ATTEMPTS" 2>/dev/null || printf 0)
attempts=$((attempts + 1))
printf '%s' "$attempts" > "$MOCK_ATTEMPTS"
if [ "$attempts" -lt 3 ]; then
  printf 'transient pnpm download failure\\n' >&2
  exit 1
fi
printf '%s\\n' "$MOCK_STORE_PATH"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(binDir, "sleep"),
      `#!/bin/sh
printf '%s\\n' "$1" >> "$MOCK_SLEEPS"
`,
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", step?.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        MOCK_ATTEMPTS: attemptsPath,
        MOCK_SLEEPS: sleepPath,
        MOCK_STORE_PATH: storePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(attemptsPath, "utf8")).toBe("3");
    expect(readFileSync(sleepPath, "utf8")).toBe("5\n10\n");
    expect(readFileSync(outputPath, "utf8")).toContain(`path=${storePath}`);
  });

  it("runs trusted npm preflight pnpm commands from the tooling checkout", () => {
    const root = tempDirs.make("npm-preflight-tooling-pnpm-");
    const toolingDir = join(root, ".artifacts/plugin-sdk-release-tooling");
    const binDir = join(root, "bin");
    const logPath = join(root, "pnpm-cwds.log");
    mkdirSync(toolingDir, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, packageManager: "pnpm@11.2.2" }),
    );
    writeFileSync(
      join(toolingDir, "package.json"),
      JSON.stringify({ private: true, packageManager: "pnpm@12.1.0" }),
    );
    const pnpmPath = join(binDir, "pnpm");
    writeFileSync(
      pnpmPath,
      `#!/bin/sh
set -eu
package_manager="$(node -p 'require("./package.json").packageManager')"
printf '%s\\t%s\\n' "$PWD" "$package_manager" >> "$PNPM_CWD_LOG"
test "$package_manager" = "pnpm@12.1.0"
`,
    );
    chmodSync(pnpmPath, 0o755);

    const sdkStep = workflowStep(
      workflowJob(OPENCLAW_NPM_PREFLIGHT_WORKFLOW, "check_sdk_npm"),
      "Verify Plugin SDK API changes",
    );
    const sdkCommandBlock = (sdkStep.run ?? "").match(
      /\(\n\s+cd "\$tooling_dir"\n\s+pnpm install --frozen-lockfile --ignore-scripts --filter openclaw\n\s+pnpm run plugin-sdk:api:diff -- "\$\{diff_args\[@\]\}"\n\s*\)/u,
    )?.[0];
    expect(sdkCommandBlock).toBeDefined();
    const installSteps = ["check_dependencies_npm", "check_contents_npm"].map((jobName) =>
      workflowStep(
        workflowJob(OPENCLAW_NPM_PREFLIGHT_WORKFLOW, jobName),
        "Install trusted qualification dependencies",
      ),
    );

    for (const { trustedPnpmCommand, cwd } of [
      { trustedPnpmCommand: sdkCommandBlock ?? "", cwd: root },
      ...installSteps.map((step) => ({
        trustedPnpmCommand: step.run ?? "",
        cwd: resolve(root, step["working-directory"] ?? "."),
      })),
    ]) {
      const result = spawnSync("bash", ["-c", trustedPnpmCommand], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_WORKSPACE: root,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          PNPM_CWD_LOG: logPath,
          tooling_dir: toolingDir,
        },
      });
      expect(result.status, result.stderr).toBe(0);
    }

    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual(
      Array.from({ length: 4 }, () => `${toolingDir}\tpnpm@12.1.0`),
    );
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
    expect(workflowText).not.toContain('PNPM_CONFIG_STORE_DIR: "/var/cache/crabbox/pnpm/store"');
    expect(hydratePnpm.run).toContain('preferred_pnpm_store="/var/cache/crabbox/pnpm/store"');
    expect(hydratePnpm.run).toContain('mkdir -p "$preferred_pnpm_store" 2>/dev/null');
    expect(hydratePnpm.run).toContain('[ -w "$preferred_pnpm_store" ]');
    expect(hydratePnpm.run).toContain(
      'pnpm_cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/openclaw/pnpm"',
    );
    expect(hydratePnpm.run).toContain('pnpm_install_root="$pnpm_cache_root/install"');
    expect(hydratePnpm.run).toContain('export PNPM_CONFIG_STORE_DIR="$pnpm_cache_root/store"');
    expect(hydratePnpm.run).toContain(
      'export PNPM_CONFIG_MODULES_DIR="$pnpm_install_root/node_modules"',
    );
    expect(hydratePnpm.run).toContain('export PNPM_CONFIG_PACKAGE_IMPORT_METHOD="hardlink"');
    expect(hydratePnpm.run).toContain(
      'export PNPM_CONFIG_VIRTUAL_STORE_DIR="$pnpm_install_root/virtual-store"',
    );
    expect(hydratePnpm.run).toContain('echo "PNPM_CONFIG_STORE_DIR=$PNPM_CONFIG_STORE_DIR"');
    expect(hydratePnpm.run).toContain('echo "PNPM_CONFIG_MODULES_DIR=$PNPM_CONFIG_MODULES_DIR"');
    expect(hydratePnpm.run).toContain('echo "CRABBOX_PNPM_MODULES_DIR=$PNPM_CONFIG_MODULES_DIR"');
    expect(hydratePnpm.run).toContain(
      'echo "PNPM_CONFIG_PACKAGE_IMPORT_METHOD=${PNPM_CONFIG_PACKAGE_IMPORT_METHOD:-}"',
    );
    expect(hydratePnpm.run).toContain(
      'echo "PNPM_CONFIG_VIRTUAL_STORE_DIR=$PNPM_CONFIG_VIRTUAL_STORE_DIR"',
    );
    expect(hydratePnpm.run).toContain('} >> "$GITHUB_ENV"');
    expect(hydratePnpm.run).toContain("prepare_crabbox_pnpm_dirs");
    expect(hydratePnpm.run).toContain(
      'case "${PNPM_CONFIG_MODULES_DIR:?}" in "$pnpm_install_root"/*)',
    );
    expect(hydratePnpm.run).toContain(
      'case "${PNPM_CONFIG_VIRTUAL_STORE_DIR:?}" in "$pnpm_install_root"/*)',
    );
    expect(hydratePnpm.run).toContain('rm -rf -- "$pnpm_install_root"');
    expect(hydratePnpm.run).toContain('mkdir -p "$pnpm_install_root" "$PNPM_CONFIG_STORE_DIR"');
    expect(hydratePnpm.run).toContain(
      'mkdir -p "$PNPM_CONFIG_MODULES_DIR" "$PNPM_CONFIG_VIRTUAL_STORE_DIR"',
    );
    expect(hydratePnpm.run).toContain(
      '"$(stat -c %d "$PNPM_CONFIG_STORE_DIR")" != "$(stat -c %d "$PNPM_CONFIG_MODULES_DIR")"',
    );
    expect(hydratePnpm.run).toContain(
      "Fallback pnpm store and modules directories must share a filesystem",
    );
    expect(hydratePnpm.run).toContain(
      "append_pnpm_option_arg PNPM_CONFIG_PACKAGE_IMPORT_METHOD package-import-method",
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
    const ensureDocker = workflowStep(hydrate, "Ensure Docker is running");
    expect(ensureDocker.if).toBeUndefined();
    expect(ensureDocker.env).toEqual({
      CRABBOX_JOB: "${{ inputs.crabbox_job }}",
    });
    expect(ensureDocker.run).toContain("docker_required=false");
    expect(ensureDocker.run).toContain('if [ "${CRABBOX_JOB:-hydrate}" = "hydrate-docker" ]; then');
    expect(ensureDocker.run).toContain("other marker names do not");
    expect(ensureDocker.run).toContain('if [ "$docker_required" = true ]; then');
    expect(ensureDocker.run).toContain(
      "Docker is unavailable for ${CRABBOX_JOB:-hydrate}; route this workload to a Docker-capable provider",
    );
    expect(ensureDocker.run).toContain(
      "Docker is unavailable; standard hydration will continue without Docker",
    );
    expect(ensureDocker.run).toContain(
      'echo "OPENCLAW_CRABBOX_DOCKER_AVAILABLE=0" >> "$GITHUB_ENV"',
    );
    expect(ensureDocker.run).toContain(
      'echo "OPENCLAW_CRABBOX_DOCKER_AVAILABLE=1" >> "$GITHUB_ENV"',
    );
    expect(workflowStep(hydrate, "Ensure SSH is available").if).toBeUndefined();
    expect(workflowStep(hydrate, "Hydrate provider env helper").if).toBeUndefined();
    const markCrabboxReady = workflowStep(hydrate, "Mark Crabbox ready").run;
    expect(markCrabboxReady).toContain("COREPACK_HOME");
    expect(markCrabboxReady).toContain("OPENCLAW_CRABBOX_DOCKER_AVAILABLE");
    expect(markCrabboxReady).toContain("CRABBOX_PNPM_MODULES_DIR");
    expect(markCrabboxReady).toContain("PNPM_CONFIG_PACKAGE_IMPORT_METHOD");
    expect(markCrabboxReady).not.toContain("PNPM_CONFIG_MODULES_DIR");
    expect(markCrabboxReady).not.toContain("PNPM_CONFIG_VIRTUAL_STORE_DIR");
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
    expect(hydrateWindowsPnpm.run).toContain('"--ignore-scripts"');
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
    const markWindowsCrabboxReady = workflowStep(hydrateWindowsDaemon, "Mark Crabbox ready").run;
    expect(markWindowsCrabboxReady).toContain('"NODE_BIN"');
    expect(markWindowsCrabboxReady).toContain('"PNPM_HOME"');
    expect(markWindowsCrabboxReady).toContain('"CRABBOX_PNPM_MODULES_DIR"');
    expect(markWindowsCrabboxReady).not.toContain('"PNPM_CONFIG_MODULES_DIR"');
    expect(markWindowsCrabboxReady).not.toContain('"PNPM_CONFIG_VIRTUAL_STORE_DIR"');
    expect(markWindowsCrabboxReady).toContain('"PATH"');
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
    const markHydrateGithubReady = workflowStep(hydrateGithub, "Mark Crabbox ready").run;
    expect(markHydrateGithubReady).toContain("OPENCLAW_CRABBOX_DOCKER_AVAILABLE");
    expect(markHydrateGithubReady).toContain("PNPM_CONFIG_PACKAGE_IMPORT_METHOD");
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
    expect(workflow).toContain("scripts/resolve-openclaw-package-candidate.mts");
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
    const npm12Job = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "npm_12_install_sh");
    expect(jobNeeds(npm12Job)).toEqual(["resolve_package", "package_integrity"]);
    expect(npm12Job.permissions).toEqual({ actions: "read", contents: "read" });
    const npm12Step = workflowStep(npm12Job, "Run install.sh with npm 12");
    expect(npm12Step.run).toContain("npm@12.0.2");
    expect(npm12Step.run).toContain("bash scripts/install.sh");
    expect(npm12Step.run).toContain("scripts/docker/install-sh-common/version-parse.sh");
    expect(npm12Step.run).toContain("extract_openclaw_semver");
    expect(npm12Step.run).toContain(".openclaw-lifecycle-pending");
    expect(JSON.stringify(npm12Job)).not.toContain("secrets.");
  });

  it("binds npm 12 installation to the supplied prerelease dependency artifact", () => {
    const job = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "npm_12_install_sh");
    const validate = workflowStep(job, "Validate prerelease plugin registry artifact identity");
    const download = workflowStep(job, "Download prerelease plugin registry artifact");
    const install = workflowStep(job, "Run install.sh with npm 12");
    const tuple = "needs.resolve_package.outputs.prepublish_plugin_registry_json";
    const field = (name: string) =>
      `\${{ fromJSON(${tuple} || '{}').prepublishPluginRegistry${name} || '' }}`;

    expect(validate.if).toBe(`${tuple} != ''`);
    expect(validate.env).toMatchObject({
      ARTIFACT_DIGEST: field("ArtifactDigest"),
      ARTIFACT_ID: field("ArtifactId"),
      ARTIFACT_NAME: field("ArtifactName"),
      ARTIFACT_RUN_ATTEMPT: field("ArtifactRunAttempt"),
      ARTIFACT_RUN_ID: field("ArtifactRunId"),
    });
    expect(validate.run).toContain('verify-upload "Prerelease plugin registry"');
    expect(download.if).toBe(validate.if);
    expect(download.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    expect(download.with).toMatchObject({
      "artifact-ids": field("ArtifactId"),
      "run-id": field("ArtifactRunId"),
      path: ".artifacts/prepublish-plugin-registry",
    });
    expect(install.env).toMatchObject({
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: "${{ needs.resolve_package.outputs.package_source_sha }}",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:
        "${{ needs.resolve_package.outputs.package_version }}",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: `\${{ ${tuple} != '' && format('{0}/.artifacts/prepublish-plugin-registry', github.workspace) || '' }}`,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: field("ManifestSha256"),
    });
    expect(install.run).toMatch(
      /bash scripts\/e2e\/lib\/prepublish-plugin-registry\.sh\s*\\\s*bash scripts\/install\.sh/u,
    );
    const steps = job.steps ?? [];
    expect(steps.indexOf(validate)).toBeLessThan(steps.indexOf(download));
    expect(steps.indexOf(download)).toBeLessThan(steps.indexOf(install));
  });

  it("keeps ref packaging independent of workflow-checkout dependencies", () => {
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");
    const resolveJob = workflow.slice(
      workflow.indexOf("  resolve_package:"),
      workflow.indexOf("  package_integrity:"),
    );

    expect(resolveJob).toContain("scripts/resolve-openclaw-package-candidate.mts");
    expect(resolveJob).not.toContain("pnpm install");
  });

  it("offers bounded product profiles and can run Telegram against the resolved artifact", () => {
    const parsedWorkflow = readWorkflow(PACKAGE_ACCEPTANCE_WORKFLOW);
    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");
    const npmTelegramWorkflow = readFileSync(NPM_TELEGRAM_WORKFLOW, "utf8");
    const packageTelegram = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "package_telegram");
    const dockerAcceptance = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "docker_acceptance");
    const dockerAcceptanceRegistry = workflowJob(
      PACKAGE_ACCEPTANCE_WORKFLOW,
      "docker_acceptance_registry",
    );
    const npm12Install = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "npm_12_install_sh");
    const npmTelegram = workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e");
    const buildPrivateQa = workflowStep(npmTelegram, "Build private QA harness runtime");

    expect(workflow).toContain("suite_profile:");
    expect(parsedWorkflow.on?.workflow_dispatch?.inputs?.suite_profile).toMatchObject({
      default: "package",
      description: "Acceptance profile: smoke, package, telegram, product, full, or custom",
      options: ["smoke", "package", "telegram", "product", "full", "custom"],
    });
    const dispatchInputs = parsedWorkflow.on?.workflow_dispatch?.inputs;
    const callInputs = parsedWorkflow.on?.workflow_call?.inputs;
    expect(dispatchInputs?.prepublish_plugin_registry_json).toBeUndefined();
    expect(dispatchInputs?.advisory).toEqual(callInputs?.advisory);
    expect(callInputs?.advisory).toEqual({
      description: "Treat acceptance failures as advisory for the caller",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(Object.keys(dispatchInputs ?? {})).toHaveLength(25);
    expect(parsedWorkflow.on?.workflow_dispatch?.inputs?.telegram_advisory).toBeUndefined();
    expect(parsedWorkflow.on?.workflow_call?.inputs?.suite_profile).toMatchObject({
      default: "package",
      description: "Acceptance profile: smoke, package, telegram, product, full, or custom",
    });
    expect(workflow).toContain("published_upgrade_survivor_baseline:");
    expect(workflow).toContain("published_upgrade_survivor_baselines:");
    expect(workflow).toContain("last-stable-4");
    expect(workflow).toContain("all-since-2026.4.23");
    expect(workflow).toContain("published_upgrade_survivor_scenarios:");
    expect(workflow).toContain("scripts/resolve-upgrade-survivor-baselines.mts");
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
    expect(packageTelegram.with?.scenario).toBe(
      "${{ needs.resolve_package.outputs.telegram_scenarios }}",
    );
    expect(packageTelegram.with?.advisory).toBe(
      "${{ inputs.advisory || inputs.telegram_advisory || false }}",
    );
    expect(packageTelegram.with).not.toHaveProperty("allow_older_binary_destructive_actions");
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
    expect(packageTelegram.with?.harness_ref).toBe("${{ inputs.workflow_ref }}");
    expect(packageTelegram.with?.package_source_sha).toBe(
      "${{ needs.resolve_package.outputs.package_source_sha }}",
    );
    const registryInputs = {
      prepublish_plugin_registry_artifact_name:
        "${{ fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactName || '' }}",
      prepublish_plugin_registry_artifact_id:
        "${{ fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactId || '' }}",
      prepublish_plugin_registry_artifact_digest:
        "${{ fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactDigest || '' }}",
      prepublish_plugin_registry_artifact_run_id:
        "${{ fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactRunId || '' }}",
      prepublish_plugin_registry_artifact_run_attempt:
        "${{ fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactRunAttempt || '' }}",
      prepublish_plugin_registry_manifest_sha256:
        "${{ fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryManifestSha256 || '' }}",
    };
    expect(packageTelegram.with).toMatchObject(registryInputs);
    const registryInputSchema = Object.fromEntries(
      Object.keys(registryInputs).map((name) => [
        name,
        expect.objectContaining({ default: "", required: false, type: "string" }),
      ]),
    );
    const npmTelegramInputs = readWorkflow(NPM_TELEGRAM_WORKFLOW).on;
    expect(npmTelegramInputs?.workflow_call?.inputs).toMatchObject(registryInputSchema);
    expect(npmTelegramInputs?.workflow_dispatch?.inputs).toMatchObject(registryInputSchema);
    expect(npmTelegramWorkflow).toContain(
      "Artifact-backed Telegram E2E requires the complete prerelease plugin registry tuple.",
    );
    expect(npmTelegramWorkflow).toContain(
      "Prerelease plugin registry inputs require an artifact-backed OpenClaw package.",
    );
    expect(npmTelegramWorkflow).toContain(
      'expected_registry_suffix="-${PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_RUN_ID}-${PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_RUN_ATTEMPT}"',
    );
    expect(npmTelegramWorkflow).toContain(
      '"docker-e2e-prepublish-plugin-registry${expected_registry_suffix}" | \\\n' +
        '                "package-acceptance-telegram-plugin-registry${expected_registry_suffix}"',
    );
    expect(npmTelegramWorkflow).not.toContain(
      "Prerelease plugin registry and package artifacts must come from the same workflow run attempt.",
    );
    expect(npmTelegramWorkflow).toContain('verify-upload "Prerelease plugin registry"');
    expect(npmTelegramWorkflow).toContain("Download prerelease plugin registry artifact");
    expect(npmTelegramWorkflow).toContain("--required-packages-json '[\"@openclaw/codex\"]'");
    expect(packageTelegram.secrets).toEqual({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_CONVEX_SECRET_CI: "${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
      OPENCLAW_QA_CONVEX_SITE_URL: "${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    });
    expect(dockerAcceptance.with?.ref).toBe(
      "${{ needs.resolve_package.outputs.package_source_sha || inputs.workflow_ref }}",
    );
    expect(dockerAcceptance.with?.advisory).toBe("${{ inputs.advisory || false }}");
    expect(dockerAcceptanceRegistry.with?.advisory).toBe("${{ inputs.advisory || false }}");
    expect(dockerAcceptance.with?.prepublish_plugin_registry_artifact_name).toContain(
      "startsWith(",
    );
    expect(dockerAcceptance.with?.prepublish_plugin_registry_artifact_name).toContain(
      "'docker-e2e-prepublish-plugin-registry-'",
    );
    expect(packageTelegram.with?.prepublish_plugin_registry_artifact_name).not.toContain(
      "startsWith(",
    );
    expect(npm12Install.if).toBe("inputs.suite_profile != 'telegram'");
    expect(dockerAcceptance.if).toBe(
      "inputs.suite_profile != 'telegram' && inputs.shared_image_policy == 'no-push-artifact'",
    );
    expect(dockerAcceptanceRegistry.if).toBe(
      "inputs.suite_profile != 'telegram' && inputs.shared_image_policy == 'existing-only'",
    );
    expect(parsedWorkflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
      "pull-requests": "read",
    });
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("packages: write");
    expect(workflow).not.toContain("id-token: write");
    expect(buildPrivateQa.env).toMatchObject({
      NODE_OPTIONS: "--max-old-space-size=8192",
      OPENCLAW_BUILD_PRIVATE_QA: "1",
    });
    expectTextToIncludeAll(buildPrivateQa.run, [
      "pnpm build qaRuntime",
      "test -f dist/plugin-sdk/qa-runtime.js",
      "test -f dist/extensions/qa-lab/runtime-api.js",
    ]);
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

  it("normalizes one closed prerelease registry tuple before child workflows", () => {
    const tuple = packageAcceptanceRegistryTuple();
    const direct = runPackageAcceptanceRegistryInputValidation({
      prepublishPluginRegistryJson: JSON.stringify(tuple),
    });
    expect(direct.result.status, direct.result.stderr).toBe(0);
    expect(direct.output).toContain(`json=${JSON.stringify(tuple)}\n`);

    const candidate = runPackageAcceptanceRegistryInputValidation({
      candidateArtifactJson: JSON.stringify({
        imageArtifactName: "image-123-2",
        ...tuple,
      }),
    });
    expect(candidate.result.status, candidate.result.stderr).toBe(0);
    expect(candidate.output).toContain(`json=${JSON.stringify(tuple)}\n`);

    const identical = runPackageAcceptanceRegistryInputValidation({
      candidateArtifactJson: JSON.stringify(tuple),
      prepublishPluginRegistryJson: JSON.stringify(tuple),
    });
    expect(identical.result.status, identical.result.stderr).toBe(0);
    expect(identical.output).toContain(`json=${JSON.stringify(tuple)}\n`);
  });

  it("rejects partial or ambiguous prerelease registry tuples before child workflows", () => {
    const tuple = packageAcceptanceRegistryTuple();
    const partial = runPackageAcceptanceRegistryInputValidation({
      prepublishPluginRegistryJson: JSON.stringify({
        prepublishPluginRegistryArtifactId: tuple.prepublishPluginRegistryArtifactId,
      }),
    });
    expect(partial.result.status).toBe(1);
    expect(partial.result.stderr).toContain(
      "Prerelease plugin registry JSON must contain one complete immutable tuple.",
    );

    const ambiguous = runPackageAcceptanceRegistryInputValidation({
      candidateArtifactJson: JSON.stringify(tuple),
      prepublishPluginRegistryJson: JSON.stringify(
        packageAcceptanceRegistryTuple({
          prepublishPluginRegistryArtifactId: "789",
        }),
      ),
    });
    expect(ambiguous.result.status).toBe(1);
    expect(ambiguous.result.stderr).toContain("Prerelease plugin registry inputs disagree.");
  });

  it("generates a Telegram-only registry only for direct ref or artifact candidates", () => {
    for (const source of ["ref", "artifact"] as const) {
      const generated = runPackageAcceptanceResolveScript({
        source,
        telegramMode: "mock-openai",
      });
      expect(generated.result.status, generated.result.stderr).toBe(0);
      expect(generated.args).toContain("--plugin-registry-output-dir\n");
      expect(generated.args).toContain(".artifacts/package-acceptance-telegram-plugin-registry\n");
      expect(generated.args).toContain('--required-plugin-packages-json\n["@openclaw/codex"]\n');
    }

    for (const source of ["npm", "url", "trusted-url"] as const) {
      const skipped = runPackageAcceptanceResolveScript({
        source,
        telegramMode: "mock-openai",
      });
      expect(skipped.result.status, skipped.result.stderr).toBe(0);
      expect(skipped.args).not.toContain("--plugin-registry-output-dir");
    }

    const telegramDisabled = runPackageAcceptanceResolveScript({
      source: "ref",
      telegramMode: "none",
    });
    expect(telegramDisabled.result.status, telegramDisabled.result.stderr).toBe(0);
    expect(telegramDisabled.args).not.toContain("--plugin-registry-output-dir");

    const publishedArtifact = runPackageAcceptanceResolveScript({
      candidateArtifactJson: releaseCandidateArtifactJson("a".repeat(40), true),
      source: "artifact",
      telegramMode: "mock-openai",
    });
    expect(publishedArtifact.result.status, publishedArtifact.result.stderr).toBe(0);
    expect(publishedArtifact.args).not.toContain("--plugin-registry-output-dir");
  });

  it("derives the default baseline from the resolved candidate, not a moving latest tag", () => {
    const result = runPackageAcceptanceBaselineStep({
      candidateVersion: "2026.8.1",
      source: "npm",
    });

    expect(result.result.status, result.result.stderr).toBe(0);
    expect(result.output).toContain("baseline=openclaw@2026.7.1-2\n");
    expect(result.npmCalls).toHaveLength(1);
    expect(result.npmCalls[0]).toContain("view openclaw versions");
    expect(result.npmCalls[0]).not.toContain("openclaw@latest");
  });

  it("reuses a propagated artifact baseline without resolving npm metadata again", () => {
    const result = runPackageAcceptanceBaselineStep({
      candidateVersion: "2026.8.1",
      fallbackBaseline: "openclaw@2026.7.1-2",
      source: "artifact",
    });

    expect(result.result.status, result.result.stderr).toBe(0);
    expect(result.output).toContain("baseline=openclaw@2026.7.1-2\n");
    expect(result.npmCalls).toEqual([]);
  });

  it("reuses a supplied registry and keeps generated artifact names distinct from Docker", () => {
    const tuple = packageAcceptanceRegistryTuple();
    const reused = runPackageAcceptanceResolveScript({
      prepublishPluginRegistryJson: JSON.stringify(tuple),
      source: "ref",
      telegramMode: "mock-openai",
    });
    expect(reused.result.status, reused.result.stderr).toBe(0);
    expect(reused.args).not.toContain("--plugin-registry-output-dir");

    const workflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");
    expect(workflow).toContain(
      "package-acceptance-telegram-plugin-registry-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain('"docker-e2e-prepublish-plugin-registry-" +');
  });

  it.each(["package", "product"])(
    "schedules updater first-hop compatibility in the %s acceptance profile",
    (suiteProfile) => {
      const { outputs, result } = runPackageAcceptanceProfile({ suiteProfile });

      expect(result.status, result.stderr).toBe(0);
      expect((outputs.docker_lanes ?? "").split(/\s+/u)).toContain("update-first-hop-compat");
    },
  );

  it("selects one normalized Telegram scenario without enabling broad acceptance lanes", () => {
    const { outputs, result } = runPackageAcceptanceProfile({
      suiteProfile: "telegram",
      telegramMode: "mock-openai",
      telegramScenarios: "  telegram-commands-command  ",
    });

    expect(result.status).toBe(0);
    expect(outputs).toMatchObject({
      docker_lanes: "",
      include_live_suites: "false",
      include_openwebui: "false",
      include_release_path_suites: "false",
      telegram_enabled: "true",
      telegram_mode: "mock-openai",
      telegram_scenarios: "telegram-commands-command",
    });
  });

  it.each([
    {
      expected: "telegram_mode must not be none",
      telegramMode: "none",
      telegramScenarios: "telegram-commands-command",
    },
    {
      expected: "telegram_scenarios must contain exactly one scenario",
      telegramMode: "mock-openai",
      telegramScenarios: "",
    },
    {
      expected: "telegram_scenarios must contain exactly one scenario",
      telegramMode: "mock-openai",
      telegramScenarios: "telegram-help-command, telegram-commands-command",
    },
  ])(
    "rejects an invalid Telegram-only profile: $expected",
    ({ expected, telegramMode, telegramScenarios }) => {
      const { result } = runPackageAcceptanceProfile({
        suiteProfile: "telegram",
        telegramMode,
        telegramScenarios,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
    },
  );

  it("requires full release child workflows to run at the parent workflow SHA", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const releaseChecksWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const performanceJob = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "performance"),
      "Dispatch OpenClaw Performance",
    ).run;

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
    expect(releaseChecksWorkflow.match(/run: pnpm build qaRuntime/gu)).toHaveLength(6);
    expect(releaseChecksWorkflow).not.toContain(
      "node --import tsx scripts/build-all.mts qaRuntime",
    );
    expect(releaseChecksWorkflow).toContain(
      "codex_plugin_spec: ${{ needs.resolve_target.outputs.codex_plugin_spec }}",
    );
    expect(workflow).toContain("full-release-validation-state.mjs verify");
    expect(workflow).toContain(
      'gh_with_retry api "repos/${GITHUB_REPOSITORY}/commits/${encoded_workflow_ref}" --jq .sha',
    );
    expect(workflow).toContain(
      "Child workflow ref ${CHILD_WORKFLOW_REF} moved to ${current_workflow_sha}, expected ${PARENT_WORKFLOW_SHA}; refusing dispatch.",
    );
    expect(workflow).toContain('if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]; then');
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
      "full-release-decision-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain(
      "full-release-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(releaseChecksWorkflow).toContain("refs/heads/release-ci/[0-9a-f]{12}-[0-9]+");
    expect(releaseChecksWorkflow).toContain(
      "source: ${{ needs.resolve_target.outputs.package_acceptance_package_spec != '' && 'npm' || 'artifact' }}",
    );
    expect(releaseChecksWorkflow).toContain(
      "package_spec: ${{ needs.resolve_target.outputs.package_acceptance_package_spec || 'openclaw@beta' }}",
    );
  });

  it("keeps performance evidence advisory for beta releases", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const performanceStep = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "performance"),
      "Dispatch OpenClaw Performance",
    );
    const summaryStep = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary"),
      "Verify exact release state artifacts",
    );

    expect(performanceStep.env?.RELEASE_PROFILE).toBe("${{ inputs.release_profile }}");
    expectTextToIncludeAll(performanceStep.run, [
      "fail_on_regression=true",
      'if [[ "$RELEASE_PROFILE" == "beta" ]]',
      "fail_on_regression=false",
      '-f fail_on_regression="$fail_on_regression"',
      "Release impact: advisory",
    ]);
    expect(summaryStep.env?.RELEASE_PROFILE).toBe("${{ inputs.release_profile }}");
    expect(summaryStep.run).toBe("node scripts/full-release-validation-state.mjs verify");
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

  it("dispatches exact child identities without owning child completion", () => {
    const dispatchScripts = FULL_RELEASE_CHILD_DISPATCHES.map((child) => {
      const job = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, child.jobName);
      const step = workflowStep(job, child.stepName);
      expect(step.env?.CHILD_WORKFLOW_KIND ?? job.env?.CHILD_WORKFLOW_KIND).toBe(child.kind);
      if (child.kind.startsWith("artifact-")) {
        expect(step.if).toBe("github.run_attempt == 1");
      } else {
        expect(job["timeout-minutes"]).toBe(15);
        expect(job.outputs).toMatchObject({
          run_attempt: "${{ steps.dispatch.outputs.run_attempt }}",
          run_id: "${{ steps.dispatch.outputs.run_id }}",
          url: "${{ steps.dispatch.outputs.url }}",
        });
      }
      return step.run ?? "";
    });
    expect(new Set(dispatchScripts).size).toBe(1);
    for (const script of dispatchScripts) {
      expect(script.match(/gh workflow run/gu)).toHaveLength(1);
      expectTextToIncludeAll(script, [
        "The dispatch POST is one-shot",
        'validate_child_run "$run_id"',
        'child_run_attempt="$(jq -r \'.run_attempt // ""\' <<< "$run_json")"',
        'echo "run_id=${run_id}" >> "$GITHUB_OUTPUT"',
        'echo "run_attempt=${child_run_attempt}" >> "$GITHUB_OUTPUT"',
        'echo "url=${url}" >> "$GITHUB_OUTPUT"',
      ]);
      expect(script).not.toContain("while true");
      expect(script).not.toContain("gh run cancel");
      expect(script).not.toContain("fail_fast_failed_jobs");
    }
  });

  it.each(FULL_RELEASE_CHILD_DISPATCHES)(
    "adopts and validates the exact $jobName run without waiting for terminal status",
    (child) => {
      const { calls, result } = runFullReleaseChildDispatch(child, {
        MOCK_GH_DISPATCH_OUTPUT: "https://github.com/openclaw/openclaw/actions/runs/101",
        MOCK_GH_STATUSES: '["in_progress"]',
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(calls.filter(({ args }) => args[0] === "workflow")).toHaveLength(1);
      expect(calls.filter(({ args }) => args[0] === "run" && args[1] === "cancel")).toHaveLength(0);
      expect(result.stdout).toContain("Dispatched");
    },
  );

  it.each([
    { exactTitleAt: 2, label: "inside the former window" },
    { exactTitleAt: 13, label: "after the former window" },
  ])("adopts a returned child whose title converges $label", ({ exactTitleAt }) => {
    const child = fullReleaseChild("artifact-docker");
    const expectedTitle = `${child.runName} full-release-validation-77-2${child.nonceSuffix}`;
    const titles = Array.from({ length: exactTitleAt }, (_, index) =>
      index + 1 === exactTitleAt ? expectedTitle : child.runName,
    );

    const { calls, result } = runFullReleaseChildDispatch(child, {
      MOCK_GH_DISPATCH_OUTPUT: "https://github.com/openclaw/openclaw/actions/runs/101",
      MOCK_GH_RUN_TITLES: JSON.stringify(titles),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(calls.filter(({ args }) => args[0] === "workflow")).toHaveLength(1);
    expect(
      calls.filter(({ args }) => args.some((value) => value.endsWith("/runs/101"))),
    ).toHaveLength(exactTitleAt);
  });

  it("bounds title convergence without reposting the dispatch", () => {
    const child = fullReleaseChild("artifact-docker");
    const { calls, result } = runFullReleaseChildDispatch(child, {
      MOCK_GH_DISPATCH_OUTPUT: "https://github.com/openclaw/openclaw/actions/runs/101",
      MOCK_GH_RUN_TITLES: JSON.stringify([child.runName]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run never became readable with display title");
    expect(calls.filter(({ args }) => args[0] === "workflow")).toHaveLength(1);
    expect(
      calls.filter(({ args }) => args.some((value) => value.endsWith("/runs/101"))),
    ).toHaveLength(60);
  });

  it("refuses an immutable child mismatch immediately without reposting", () => {
    const { calls, result } = runFullReleaseChildDispatch(FULL_RELEASE_CHILD_DISPATCHES[0], {
      MOCK_GH_DISPATCH_OUTPUT: "https://github.com/openclaw/openclaw/actions/runs/101",
      MOCK_GH_RUN_EVENT: "push",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to adopt unvalidated");
    expect(calls.filter(({ args }) => args[0] === "workflow")).toHaveLength(1);
    expect(
      calls.filter(({ args }) => args.some((value) => value.endsWith("/runs/101"))),
    ).toHaveLength(1);
  });

  it.each([
    ["full", "v2026.8.1", "", "historical_target_tag=v2026.8.1"],
    ["npm-beta", "refs/tags/v2026.8.1-beta.3", "", "historical_target_tag=v2026.8.1-beta.3"],
    ["npm-stable", "v2026.8.1", "", "historical_target_tag=v2026.8.1"],
    ["npm-stable", "main", "release/2026.8.1-1", "target_context_ref=release/2026.8.1-1"],
    ["full", "main", "release/2026.8.1", "target_context_ref=release/2026.8.1"],
    ["full", "main", "release/2026.8.1-1", "target_context_ref=release/2026.8.1-1"],
    ["npm-beta", "main", "refs/heads/release/2026.8.1", "target_context_ref=release/2026.8.1"],
    ["full", "main", "v2026.8.1", "historical_target_tag=v2026.8.1"],
    ["full", "main", "v2026.8.1-1", "historical_target_tag=v2026.8.1-1"],
    ["npm-beta", "main", "refs/tags/v2026.8.1-beta.3", "historical_target_tag=v2026.8.1-beta.3"],
  ])(
    "dispatches %s CI scope for target=%s context=%s",
    (scope, targetRef, targetContextRef, contextInput) => {
      const { calls, result } = runFullReleaseChildDispatch(FULL_RELEASE_CHILD_DISPATCHES[0], {
        CI_RELEASE_SCOPE: scope,
        TARGET_CONTEXT_REF: targetContextRef,
        TARGET_REF: targetRef,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const dispatches = calls.filter(({ args }) => args[0] === "workflow");
      expect(dispatches).toHaveLength(1);
      const args = dispatches[0]!.args;
      expect(args).toEqual(
        expect.arrayContaining([
          `target_ref=${"b".repeat(40)}`,
          `release_scope=${scope}`,
          `include_android=${scope === "full"}`,
        ]),
      );
      expect(
        args.filter((arg) => /^(historical_target_tag|target_context_ref)=/u.test(arg)),
      ).toEqual([contextInput]);
      expect(args.some((arg) => arg.startsWith("release_candidate_ref="))).toBe(false);
    },
  );

  it("recovers one ambiguous dispatch by exact name without reposting", () => {
    const { calls, result } = runFullReleaseChildDispatch(FULL_RELEASE_CHILD_DISPATCHES[0], {
      MOCK_GH_DISPATCH_ERROR: "HTTP 500: Failed to run workflow dispatch",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(calls.filter(({ args }) => args[0] === "workflow")).toHaveLength(1);
    expect(calls.some(({ args }) => args.includes("-X"))).toBe(true);
    expect(result.stderr).toContain("adopted exact run 101");
  });

  it("keeps dispatch provenance failures separate from cancellation policy", () => {
    const moved = runFullReleaseChildDispatch(FULL_RELEASE_CHILD_DISPATCHES[0], {
      MOCK_GH_CURRENT_SHA: "c".repeat(40),
    });
    expect(moved.result.status).toBe(1);
    expect(moved.result.stderr).toContain("refusing dispatch");
    expect(moved.calls.filter(({ args }) => args[0] === "workflow")).toHaveLength(0);

    const mismatched = runFullReleaseChildDispatch(FULL_RELEASE_CHILD_DISPATCHES[0], {
      MOCK_GH_CHILD_SHA: "c".repeat(40),
      MOCK_GH_DISPATCH_OUTPUT: "https://github.com/openclaw/openclaw/actions/runs/101",
    });
    expect(mismatched.result.status).toBe(1);
    expect(mismatched.result.stderr).toContain("expected parent workflow SHA");
    expect(
      mismatched.calls.filter(({ args }) => args.some((value) => value.endsWith("/runs/101"))),
    ).toHaveLength(1);
    expect(
      mismatched.calls.filter(({ args }) => args[0] === "run" && args[1] === "cancel"),
    ).toHaveLength(0);
  });

  it("runs Release Decision and Diagnostic Drain in parallel from exact child tuples", () => {
    const executionPlan = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "release_execution_plan");
    const decision = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "release_decision");
    const drain = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "diagnostic_drain");
    const summary = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary");
    const decisionStep = workflowStep(decision, "Evaluate release decision");
    const drainStep = workflowStep(drain, "Drain child diagnostics");
    const decisionUpload = workflowStep(decision, "Upload release decision");
    const drainUpload = workflowStep(drain, "Upload diagnostic drain manifest");
    const planStep = workflowStep(executionPlan, "Seal immutable release execution plan");
    const planCache = workflowStep(executionPlan, "Cache immutable release execution plan");
    const planRestore = workflowStep(
      executionPlan,
      "Restore immutable release execution plan artifact",
    );
    const planUpload = workflowStep(executionPlan, "Upload immutable release execution plan");
    const manifestStep = workflowStep(summary, "Write release validation manifest");
    const selectState = workflowStep(summary, "Select newest compatible release state artifacts");
    const decisionDownloads = workflowStep(summary, "Download release decision attempts");
    const drainDownloads = workflowStep(summary, "Download diagnostic drain attempts");

    expect(decision.needs).toEqual(["resolve_target", "release_execution_plan"]);
    expect(drain.needs).toEqual(["resolve_target", "release_execution_plan"]);
    expect(decision.if).toBe("always()");
    expect(drain.if).toBe("always()");
    expect(decisionStep.run).toBe(drainStep.run);
    expect(decisionStep.env).toMatchObject({
      FAIL_FAST: "${{ inputs.fail_fast }}",
      FULL_RELEASE_STATE_MODE: "decision",
    });
    expect(drainStep.env).toMatchObject({
      FAIL_FAST: "false",
      FULL_RELEASE_STATE_MODE: "drain",
    });
    expectTextToIncludeAll(decisionStep.run, [
      'node scripts/full-release-validation-state.mjs "$FULL_RELEASE_STATE_MODE"',
    ]);
    expect(planStep.run).toContain("FULL_RELEASE_PLAN_INPUTS_JSON");
    expect(planStep.env).toMatchObject({
      CANDIDATE_EVIDENCE_JSON: "${{ needs.candidate_acquisition.outputs.binding_json }}",
      CANDIDATE_REQUEST_JSON: "${{ needs.resolve_target.outputs.candidate_request_json }}",
      EVIDENCE_CHANGED_PATHS: "${{ needs.evidence_reuse.outputs.changed_paths || '[]' }}",
      EVIDENCE_RUN_ID: "${{ needs.evidence_reuse.outputs.evidence_run_id }}",
      TRUSTED_WORKFLOW_JSON: "${{ needs.resolve_target.outputs.trusted_workflow_json }}",
    });
    expect(planStep.env).not.toHaveProperty("EVIDENCE_MANIFEST");
    expect(planStep.run).not.toContain("EVIDENCE_MANIFEST");
    expect(planStep.run).toContain('--arg evidenceRunId "$EVIDENCE_RUN_ID"');
    expect(planStep.run).toContain(
      '--argjson candidateEvidence "${CANDIDATE_EVIDENCE_JSON:-null}"',
    );
    expect(planStep.run).toContain('--argjson candidateRequestInput "$CANDIDATE_REQUEST_JSON"');
    expect(planStep.run).toContain("candidateRequestInput: $candidateRequestInput");
    expect(planStep.run).not.toContain("candidateRequestInput: {");
    expect(planStep.run).toContain('--argjson trustedWorkflow "$TRUSTED_WORKFLOW_JSON"');
    expect(planCache.uses).toBe(ACTIONS_CACHE_V6);
    expect(planCache["continue-on-error"]).toBe(true);
    expect(planCache.with).toMatchObject({
      key: "full-release-execution-plan-v1-${{ github.run_id }}",
    });
    expect(planCache.with).not.toHaveProperty("fail-on-cache-miss");
    expect(planRestore.if).toBe(
      "${{ always() && github.run_attempt != 1 && steps.plan_cache.outputs.cache-hit != 'true' }}",
    );
    expect(planRestore.with).toMatchObject({
      "github-token": "${{ github.token }}",
      name: "full-release-execution-plan-${{ github.run_id }}",
      "run-id": "${{ github.run_id }}",
    });
    expect(planUpload.if).toBe("always()");
    expect(planUpload.with?.name).toBe("full-release-execution-plan-${{ github.run_id }}");
    expect(manifestStep.env).not.toHaveProperty("EVIDENCE_MANIFEST");
    expect(manifestStep.run).not.toContain("needs.evidence_reuse.outputs");
    expect(decisionUpload.with?.name).toBe(
      "full-release-decision-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(drainUpload.with?.name).toBe(
      "full-release-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(decisionDownloads.with).toMatchObject({
      path: "${{ runner.temp }}/full-release-decision-attempts",
      pattern: "full-release-decision-${{ github.run_id }}-*",
    });
    expect(drainDownloads.with).toMatchObject({
      path: "${{ runner.temp }}/full-release-diagnostic-attempts",
      pattern: "full-release-diagnostics-${{ github.run_id }}-*",
    });
    expect(selectState.run).toBe("node scripts/full-release-validation-state.mjs select");
    expect(summary.needs).toEqual(expect.arrayContaining(["release_decision", "diagnostic_drain"]));
    for (const jobId of [
      "docker_runtime_assets_preflight",
      "normal_ci",
      "plugin_prerelease_independent",
      "plugin_prerelease_candidate",
      "release_checks_independent",
      "release_checks_candidate",
      "npm_telegram",
      "performance",
    ]) {
      expect(String(workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, jobId).if)).toContain(
        "github.run_attempt == 1",
      );
    }
  });

  it("builds a rerun-all manifest from sealed plan A instead of retry-B job outputs", () => {
    const summary = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary");
    const manifest = workflowStep(summary, "Write release validation manifest");
    const evidenceDispatch = workflowStep(summary, "Request release evidence update");

    expect(manifest.env).not.toHaveProperty("TARGET_SHA");
    expect(manifest.env).not.toHaveProperty("NORMAL_CI_RUN_ID");
    expect(manifest.env).not.toHaveProperty("EVIDENCE_REUSE");
    expect(manifest.run).not.toContain("needs.evidence_reuse.outputs");
    expect(evidenceDispatch.run).toContain(
      'EVIDENCE_REUSE="$(jq -r \'.evidenceReuse.requested\' "$RELEASE_EXECUTION_PLAN_PATH")"',
    );
    expect(evidenceDispatch.env).not.toHaveProperty("EVIDENCE_REUSE");
  });

  it("pins every Full Release Validation artifact download to the canonical action", () => {
    const workflow = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const downloadSteps = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).filter((step) => step.uses?.startsWith("actions/download-artifact@")),
    );

    expect(downloadSteps).toHaveLength(6);
    for (const step of downloadSteps) {
      expect(step.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    }
  });

  it("keeps update migration manual with optional historical replays", () => {
    const workflow = readFileSync(UPDATE_MIGRATION_WORKFLOW, "utf8");
    const packageWorkflow = readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8");
    const job = workflowJob(UPDATE_MIGRATION_WORKFLOW, "update_migration");

    expect(workflow).toContain("name: Update Migration");
    expect(workflow).toContain("uses: ./.github/workflows/package-acceptance.yml");
    expect(workflow).toContain("source: ref");
    expect(workflow).toContain("suite_profile: custom");
    expect(workflow).toContain("docker_lanes: update-migration");
    expect(
      readWorkflow(UPDATE_MIGRATION_WORKFLOW).on?.workflow_dispatch?.inputs?.baselines,
    ).toMatchObject({
      default: "",
      required: false,
    });
    expect(
      readWorkflow(UPDATE_MIGRATION_WORKFLOW).on?.workflow_dispatch?.inputs,
    ).not.toHaveProperty("allow_frozen_target_scenario_omissions");
    expect(workflow).toContain("default: plugin-deps-cleanup");
    expect(workflow).not.toMatch(/\n {2}schedule:/u);
    expect(job.with).toMatchObject({
      workflow_ref: "${{ inputs.workflow_ref }}",
      package_ref: "${{ inputs.package_ref }}",
      published_upgrade_survivor_baselines: "${{ inputs.baselines }}",
      published_upgrade_survivor_scenarios: "${{ inputs.scenarios }}",
    });
    expect(job.with).not.toHaveProperty("allow_frozen_target_scenario_omissions");
    expect(workflow).toContain("telegram_mode: none");
    expect(workflow).toContain("secrets: inherit");
    expect(packageWorkflow).toContain("published-upgrade-survivor/update-migration");
  });
});

describe("package artifact reuse", () => {
  it("binds package acceptance input artifacts to the complete producer tuple", () => {
    const resolvePackage = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package");
    expect(workflowStep(resolvePackage, "Setup Node environment").with).toMatchObject({
      "install-deps": "true",
    });
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
    const resolveStep = workflowStep(resolvePackage, "Resolve package candidate");
    expect(resolveStep.env).toMatchObject({
      PACKAGE_FILE_NAME: "${{ inputs.package_file_name }}",
      PACKAGE_SHA256: "${{ inputs.package_sha256 }}",
      PACKAGE_SOURCE_SHA: "${{ inputs.package_source_sha }}",
      PACKAGE_VERSION: "${{ inputs.package_version }}",
    });
    expectTextToIncludeAll(resolveStep.run, [
      'artifact_tarball="${artifact_dir}/${PACKAGE_FILE_NAME}"',
      "Selected artifact package SHA-256 differs from package_sha256.",
      "Resolved package identity differs from the declared immutable tuple.",
    ]);

    const packageIntegrity = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "package_integrity");
    expect(
      workflowStep(packageIntegrity, "Setup package validation dependencies").with,
    ).toMatchObject({
      "install-deps": "true",
    });
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
      jobs?: Record<string, WorkflowJob>;
      on?: { workflow_call?: { inputs?: Record<string, unknown> } };
    };
    const packageJson = readFileSync(PACKAGE_JSON, "utf8");
    const scheduler = readFileSync("scripts/test-docker-all.mts", "utf8");
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
    expect(workflow).toContain(
      "needs.validate_selected_ref.outputs.package_artifact_present == 'true'",
    );
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
    expect(parsedWorkflow.on?.workflow_call?.inputs).toHaveProperty(
      "enable_prepublish_plugin_registry",
    );
    expect(workflow).toContain("Pack prerelease plugin registry artifact");
    expect(workflow).toContain("Validate prerelease plugin registry artifact");
    expect(workflow).toContain("Download targeted prerelease plugin registry artifact");
    expect(workflow).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR");
    expect(workflow).toContain("prepublishPluginRegistryManifestSha256");
    expect(
      workflowStep(
        workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image"),
        "Pack prerelease plugin registry artifact",
      ).id,
    ).toBe("create_prepublish_plugin_registry");
    expect(
      workflowStep(
        workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image"),
        "Validate prerelease plugin registry artifact",
      ).env?.EXPECTED_MANIFEST_SHA256,
    ).toBe(
      "${{ steps.create_prepublish_plugin_registry.outputs.manifest_sha256 || inputs.prepublish_plugin_registry_manifest_sha256 }}",
    );
    expect(
      workflowStep(
        workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image"),
        "Pack prerelease plugin registry artifact",
      ).if,
    ).toBe(
      "steps.plan.outputs.needs_package == '1' && (inputs.prepared_npm_bundle_json != '' || (inputs.enable_prepublish_plugin_registry && steps.plan.outputs.needs_prepublish_plugin_registry == '1')) && inputs.prepublish_plugin_registry_artifact_id == ''",
    );
    expect(
      workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image").outputs
        ?.prepublish_plugin_registry_artifact_id,
    ).toContain("steps.prepublish_plugin_registry.outputs.manifest_sha256 != ''");
    for (const jobId of ["validate_docker_e2e", "validate_docker_lanes"]) {
      const job = workflowJob(LIVE_E2E_WORKFLOW, jobId);
      const registrySteps = (job.steps ?? []).filter((step) =>
        /^(Validate|Download) .*prerelease plugin registry/u.test(step.name ?? ""),
      );
      expect(registrySteps).toHaveLength(3);
      for (const step of registrySteps) {
        expect(step.if).toBe(
          "steps.plan.outputs.needs_package == '1' && needs.prepare_docker_e2e_image.outputs.prepublish_plugin_registry_artifact_id != ''",
        );
      }
      expect(registrySteps.at(-1)?.env?.REQUIRED_PACKAGES_JSON).toBe(
        "${{ steps.plan.outputs.required_prepublish_plugin_packages }}",
      );
      const runStep = (job.steps ?? []).find((step) =>
        step.run?.includes("export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR="),
      );
      expect(runStep).toBeDefined();
      expect(`${runStep?.run}\n${JSON.stringify(runStep?.env)}`).toContain(
        "steps.plan.outputs.needs_package",
      );
      expect(`${runStep?.run}\n${JSON.stringify(runStep?.env)}`).not.toContain(
        "steps.plan.outputs.needs_prepublish_plugin_registry",
      );
    }
    expect(workflow).toContain("bash .release-harness/scripts/ci-docker-pull-retry.sh");
    const setupHarnessStepName = "Setup trusted release harness";
    const harnessJobCases = [
      {
        jobId: "validate_docker_e2e",
        planStepName: "Plan Docker E2E chunk",
        setupIf: "contains(matrix.profiles, inputs.release_test_profile)",
      },
      {
        jobId: "validate_docker_lanes",
        planStepName: "Plan targeted Docker E2E lanes",
        setupIf: undefined,
      },
      {
        jobId: "validate_docker_openwebui",
        planStepName: "Plan Open WebUI Docker E2E chunk",
        setupIf: undefined,
      },
      {
        jobId: "prepare_docker_e2e_image",
        planStepName: "Plan Docker E2E images",
        setupIf: undefined,
      },
    ] as const;
    const typedHarnessJobIds = Object.entries(parsedWorkflow.jobs ?? {})
      .filter(([, job]) =>
        (job.steps ?? []).some(
          (step) =>
            step.run?.includes("node .release-harness/scripts/test-docker-all.mjs") ||
            step.run?.includes("node .release-harness/scripts/docker-e2e.mjs"),
        ),
      )
      .map(([jobId]) => jobId)
      .toSorted();
    expect(typedHarnessJobIds).toEqual(harnessJobCases.map(({ jobId }) => jobId).toSorted());

    for (const { jobId, planStepName, setupIf } of harnessJobCases) {
      const harnessJob = workflowJob(LIVE_E2E_WORKFLOW, jobId);
      const harnessJobSteps = harnessJob.steps ?? [];
      const harnessJobStepNames = harnessJobSteps.map((step) => step.name);
      const checkoutIndex = harnessJobStepNames.indexOf("Checkout trusted release harness");
      const setupIndex = harnessJobStepNames.indexOf(setupHarnessStepName);
      const typedHarnessIndex = harnessJobSteps.findIndex(
        (step) =>
          step.run?.includes("node .release-harness/scripts/test-docker-all.mjs") ||
          step.run?.includes("node .release-harness/scripts/docker-e2e.mjs"),
      );
      expect(harnessJobStepNames.filter((name) => name === setupHarnessStepName)).toHaveLength(1);
      expect(checkoutIndex).toBeGreaterThan(-1);
      expect(setupIndex).toBeGreaterThan(checkoutIndex);
      expect(typedHarnessIndex).toBeGreaterThan(setupIndex);
      expect(workflowStep(harnessJob, planStepName)).toBeDefined();
      const setupHarnessStep = workflowStep(harnessJob, setupHarnessStepName);
      expect(setupHarnessStep).toMatchObject({
        uses: "./.release-harness/.github/actions/setup-release-harness",
        with: { "node-version": "${{ env.NODE_VERSION }}" },
      });
      expect(setupHarnessStep.if).toBe(setupIf);
    }

    const prepareDockerImage = workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image");
    const prepareDockerImageStepNames = (prepareDockerImage.steps ?? []).map((step) => step.name);
    const planStepName = "Plan Docker E2E images";
    const setupCandidateStepName = "Setup Node environment";
    expect(
      prepareDockerImageStepNames.filter((name) => name === setupCandidateStepName),
    ).toHaveLength(1);
    expect(prepareDockerImageStepNames.indexOf(setupCandidateStepName)).toBeGreaterThan(
      prepareDockerImageStepNames.indexOf(planStepName),
    );
    expect(workflowStep(prepareDockerImage, setupCandidateStepName)).toMatchObject({
      if: "(steps.plan.outputs.needs_package == '1' && steps.package_source.outputs.required == 'true') || (inputs.enable_prepublish_plugin_registry && steps.plan.outputs.needs_prepublish_plugin_registry == '1' && inputs.prepublish_plugin_registry_artifact_id == '')",
      uses: "./.github/actions/setup-node-env",
    });
    expect(workflowStep(prepareDockerImage, planStepName).env).toEqual({
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
    expect(publishedUpgradeSurvivor).toContain("write_update_restart_service_env");
    expect(publishedUpgradeSurvivor).toContain("GATEWAY_AUTH_TOKEN_REF=%s");
    expect(publishedUpgradeSurvivor).toContain("OPENCLAW_CLAWHUB_URL=%s");
    expect(publishedUpgradeSurvivor).toContain("assert-no-requests");
    expect(publishedUpgradeSurvivor).toContain(
      "env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw",
    );
    expect(publishedUpgradeSurvivor).toContain("phase prepare-update-restart-probe");
    expect(publishedUpgradeSurvivor).toContain("openclaw@(alpha|beta|latest|");
    expect(publishedUpgradeSurvivor).toContain("configure_watchos_tls_fixture");
    expect(publishedUpgradeSurvivor).toContain('"publicUrl":"wss://localhost:18789"');
    expect(publishedUpgradeSurvivor).toContain('export NODE_EXTRA_CA_CERTS="$WATCH_TLS_CA_CERT"');
    expect(publishedUpgradeSurvivor).not.toContain(
      "--base-url http://127.0.0.1:18789/api/nodes/watch",
    );
    expect(publishedUpgradeSurvivor).toContain(
      "source scripts/e2e/lib/upgrade-survivor/plugin-dependency-fixtures.sh",
    );
    expect(publishedUpgradeSurvivor).toContain("probe_gateway_endpoint");
    const preDoctorCleanupIndex = publishedUpgradeSurvivor.indexOf(
      "run_plugin_fixture_phase assert-package-local-dependency-cleanup assert_legacy_plugin_dependency_debris_cleaned",
    );
    const doctorIndex = publishedUpgradeSurvivor.indexOf("phase doctor run_doctor");
    const postDoctorCleanupIndex = publishedUpgradeSurvivor.indexOf(
      "run_plugin_fixture_phase assert-legacy-plugin-dependency-debris-cleaned assert_legacy_plugin_dependency_debris_cleaned",
    );
    expect(preDoctorCleanupIndex).toBeGreaterThan(-1);
    expect(doctorIndex).toBeGreaterThan(preDoctorCleanupIndex);
    expect(postDoctorCleanupIndex).toBeGreaterThan(doctorIndex);
    expect(publishedUpgradeSurvivor.indexOf("phase seed-source-only-plugin-shadow")).toBeLessThan(
      publishedUpgradeSurvivor.indexOf("phase assert-baseline"),
    );
    expect(publishedUpgradeSurvivor).toContain('"id": "opik-openclaw"');
    expect(publishedUpgradeSurvivor).toContain('"configSchema": {');
    expect(
      publishedUpgradeSurvivor.indexOf('validate_baseline_package_spec "$baseline_spec"'),
    ).toBeLessThan(
      publishedUpgradeSurvivor.indexOf('npm install -g --prefix "$npm_config_prefix"'),
    );
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
    expect(workflow).toContain('--build-context "openclaw_package=$package_context"');
    expect(workflow).toContain('cache=(--cache-from "$BARE_IMAGE_REF")');
    expect(workflow).not.toContain('docker push "$CACHE_IMAGE_REF"');
    expect(workflow).toContain("uses: useblacksmith/setup-docker-builder@");
    expect(workflow).toContain("uses: useblacksmith/build-push-action@");
    expect(workflow).not.toContain("cache-from: type=gha,scope=docker-e2e");
    expect(workflow).not.toContain("cache-to: type=gha,mode=max,scope=docker-e2e");
  });

  it("qualifies prepared publication bytes without serializing source, package, and Docker preparation", () => {
    const prepare = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "prepare_npm_package");
    const docker = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "prepare_docker_release");
    const qualify = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "qualify_npm_package");
    const candidate = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "candidate_acquisition");
    for (const job of [prepare, docker]) {
      expect(jobNeeds(job)).toEqual(["resolve_target"]);
    }
    expect(jobNeeds(qualify)).toEqual(["resolve_target", "prepare_npm_package"]);
    expect(qualify.env?.ARTIFACT_RUN_ID).toBe("${{ needs.prepare_npm_package.outputs.run_id }}");
    expect(workflowStepById(prepare, "bundle").env?.ARTIFACT_OUTPUT).toBe("raw");
    expect(qualify.env?.ARTIFACT_OUTPUT).toBe("receipt");
    for (const job of [prepare, docker, candidate]) {
      expect(job.if).not.toContain("github.run_attempt == 1");
      expect(workflowStepById(job, "dispatch").if).toBe("github.run_attempt == 1");
      expect(workflowStepById(job, "producer").run).toBe(
        "node scripts/full-release-artifacts.mjs resolve",
      );
      expect(workflowStepById(job, "bundle").env?.ARTIFACT_RUN_ID).toBe(
        "${{ steps.producer.outputs.run_id }}",
      );
    }
    const producer = readWorkflow(FULL_RELEASE_ARTIFACTS_WORKFLOW);
    const upload = workflowStep(
      workflowJob(FULL_RELEASE_ARTIFACTS_WORKFLOW, "admit"),
      "Preserve immutable artifact dispatch",
    );
    expect(upload.with?.overwrite).not.toBe(true);
    expect(upload.with?.path).toBe("${{ steps.request.outputs.directory }}/dispatch.json");
    expect(producer.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
      "pull-requests": "read",
    });
    expect(jobNeeds(workflowJob(FULL_RELEASE_ARTIFACTS_WORKFLOW, "npm"))).toEqual(["admit"]);
    expect(workflowJob(FULL_RELEASE_ARTIFACTS_WORKFLOW, "npm").with?.preflight_phase).toBe(
      "${{ inputs.preflight_phase }}",
    );
    expect(workflowJob(FULL_RELEASE_ARTIFACTS_WORKFLOW, "docker").uses).toBe(
      "./.github/workflows/docker-release-prepare.yml",
    );
    const gate = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary"),
      "Require qualified publication artifacts",
    );
    const env = {
      ...process.env,
      NPM_PREPARE_RESULT: "success",
      NPM_QUALIFY_RESULT: "success",
      QUALIFIED_NPM_BUNDLE_JSON: "{}",
      DOCKER_PREPARE_RESULT: "success",
      PREPARED_DOCKER_MANIFEST_SHA256: "a".repeat(64),
      TARGET_VERSION: "2026.8.1",
    };
    for (const targetVersion of ["2026.8.1", "2026.8.1-1", "2026.8.1-beta.1", "2026.8.33"]) {
      const releaseEnv = { ...env, TARGET_VERSION: targetVersion };
      expect(spawnSync("bash", ["-c", gate.run ?? ""], { env: releaseEnv }).status).toBe(0);
      for (const failure of [
        { NPM_PREPARE_RESULT: "failure" },
        { NPM_QUALIFY_RESULT: "failure" },
        { DOCKER_PREPARE_RESULT: "failure" },
        { DOCKER_PREPARE_RESULT: "skipped" },
        { PREPARED_DOCKER_MANIFEST_SHA256: "" },
      ]) {
        expect(
          spawnSync("bash", ["-c", gate.run ?? ""], {
            env: { ...releaseEnv, ...failure },
          }).status,
        ).not.toBe(0);
      }
    }
    const alphaEnv = {
      ...env,
      TARGET_VERSION: "2026.8.1-alpha.1",
      DOCKER_PREPARE_RESULT: "skipped",
      PREPARED_DOCKER_MANIFEST_SHA256: "",
    };
    expect(spawnSync("bash", ["-c", gate.run ?? ""], { env: alphaEnv }).status).toBe(0);
    expect(
      spawnSync("bash", ["-c", gate.run ?? ""], {
        env: { ...alphaEnv, NPM_QUALIFY_RESULT: "failure" },
      }).status,
    ).not.toBe(0);
  });

  it("prepares one immutable candidate for release validation children", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const reusableWorkflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const candidateWorkflow = readWorkflow(FULL_RELEASE_CANDIDATE_WORKFLOW);
    const acquisition = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "candidate_acquisition");
    const discovery = workflowJob(FULL_RELEASE_CANDIDATE_WORKFLOW, "discover");
    const prepare = workflowJob(FULL_RELEASE_CANDIDATE_WORKFLOW, "prepare");
    const candidateBinding = workflowJob(FULL_RELEASE_CANDIDATE_WORKFLOW, "resolve_candidate");
    const summary = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary");
    const producer = workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image");
    const binder = workflowJob(LIVE_E2E_WORKFLOW, "bind_full_release_candidate_evidence");
    const producerIdentity = workflowStepById(producer, "producer_identity");
    const request = workflowStep(producer, "Build full release candidate request");
    const legacyTuple = workflowStep(producer, "Emit immutable release candidate tuple");
    const workflowRevision = workflowStepById(binder, "workflow");
    const evidence = workflowStepById(binder, "candidate_evidence");
    const upload = workflowStepById(binder, "upload_candidate_evidence");
    const binding = workflowStep(binder, "Bind full release candidate evidence");
    const pluginDispatch = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "plugin_prerelease_candidate"),
      "Dispatch plugin prerelease candidate phase",
    );
    const releaseDispatch = workflowStep(
      workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "release_checks_candidate"),
      "Dispatch release checks candidate phase",
    );
    const pluginDocker = workflowJob(PLUGIN_PRERELEASE_WORKFLOW, "plugin-prerelease-docker-suite");

    expect(candidateWorkflow.jobs).not.toHaveProperty("finalize");
    expect(candidateWorkflow.concurrency).toEqual({
      group: "full-release-candidate-${{ inputs.request_sha256 }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    for (const checkout of [
      workflowStep(discovery, "Checkout trusted candidate discovery"),
      workflowStep(candidateBinding, "Checkout candidate binding authority"),
      workflowStep(summary, "Checkout release state verifier"),
    ]) {
      expect(checkout.with?.["sparse-checkout"]).toBe("scripts");
    }
    expect(discovery.outputs?.state).toBe("${{ steps.discover.outputs.state }}");
    expect(workflowStep(discovery, "Discover trusted release candidate").run).toContain(
      "full-release-candidate-reuse.mjs discover",
    );
    expect(jobNeeds(prepare)).toEqual(["discover"]);
    expect(prepare.if).toContain("needs.discover.outputs.state == 'miss'");
    expect(prepare.if).not.toContain("outputs.reused != 'true'");
    expect(jobNeeds(candidateBinding)).toEqual(["discover", "prepare"]);
    expect(workflowStep(candidateBinding, "Resolve candidate binding").run).toContain(
      "full-release-candidate-reuse.mjs resolve",
    );
    expect(candidateBinding.if).toBe("always()");
    const resultStep = workflowStep(candidateBinding, "Record candidate acquisition result");
    expect(resultStep.if).toBe("always()");
    expect(resultStep.env?.RESOLVE_RESULT).toBe("${{ steps.resolve.outcome }}");
    expect(resultStep.env?.JOB_STATUS).toBe("${{ job.status }}");
    expect(candidateBinding.outputs?.state).toBe("${{ steps.result.outputs.state }}");
    expect(workflowStep(candidateBinding, "Enforce candidate acquisition").if).toBe("always()");
    expect(workflowStep(candidateBinding, "Record candidate acquisition result").run).toContain(
      "state=unavailable",
    );
    expect(workflowStep(candidateBinding, "Enforce candidate acquisition").run).toContain(
      'if [[ "$STATE" == "ready" ]]',
    );
    expect(upload.with?.overwrite).toBe(false);
    expect(acquisition.env).toMatchObject({
      TARGET_SHA: "${{ needs.resolve_target.outputs.sha }}",
      CANDIDATE_REQUEST_JSON: "${{ needs.resolve_target.outputs.candidate_request_json }}",
      PREPARED_NPM_BUNDLE_JSON: "${{ needs.prepare_npm_package.outputs.prepared_bundle_json }}",
    });
    expect(
      workflowStep(
        workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "resolve_target"),
        "Build canonical release candidate request",
      ).env,
    ).toMatchObject({
      PACKAGE_PUBLISHED: "${{ inputs.release_package_spec != '' }}",
    });
    expect(
      workflowStep(
        workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "resolve_target"),
        "Build canonical release candidate request",
      ).run,
    ).toContain('--argjson packagePublished "$PACKAGE_PUBLISHED"');
    expect(workflowJob(FULL_RELEASE_ARTIFACTS_WORKFLOW, "candidate").uses).toBe(
      "./.github/workflows/full-release-candidate.yml",
    );
    expect(prepare.uses).toBe("./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
    expect(prepare.with).toMatchObject({
      enable_prepublish_plugin_registry: true,
      emit_candidate_evidence: true,
      package_published: "${{ fromJSON(inputs.request_json).packagePublished }}",
      prepare_only: true,
      release_soak: "${{ fromJSON(inputs.request_json).releaseSoak }}",
      shared_image_policy: "${{ fromJSON(inputs.request_json).sharedImagePolicy }}",
    });
    expect(
      readWorkflow(LIVE_E2E_WORKFLOW).on?.workflow_call?.inputs?.package_published,
    ).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
    expect(request.env?.PACKAGE_PUBLISHED).toBe("${{ inputs.package_published }}");
    expect(request.run).toContain('--argjson packagePublished "$PACKAGE_PUBLISHED"');
    expect(prepare.with?.published_upgrade_survivor_scenarios).toBe(
      "${{ join(fromJSON(inputs.request_json).upgradeSurvivorScenarios, ',') }}",
    );
    expect(prepare.with?.allow_frozen_target_scenario_omissions).toBe(
      "${{ fromJSON(inputs.request_json).allowFrozenTargetScenarioOmissions }}",
    );
    expect(pluginDispatch.run).toContain(
      'args+=(-f candidate_artifact_json="$CANDIDATE_ARTIFACT_JSON")',
    );
    expect(releaseDispatch.run).toContain(
      'args+=(-f candidate_artifact_json="$CANDIDATE_ARTIFACT_JSON")',
    );
    expect(releaseDispatch.env?.CANDIDATE_ARTIFACT_JSON).toBe(
      "${{ needs.resolve_target.outputs.release_candidate_artifact_required == 'true' && needs.candidate_acquisition.outputs.candidate_artifact_json || '' }}",
    );
    expect(pluginDocker.with).toMatchObject({
      prepublish_plugin_registry_artifact_digest:
        "${{ fromJSON(inputs.candidate_artifact_json || '{}').prepublishPluginRegistryArtifactDigest || '' }}",
      prepublish_plugin_registry_artifact_id:
        "${{ fromJSON(inputs.candidate_artifact_json || '{}').prepublishPluginRegistryArtifactId || '' }}",
      prepublish_plugin_registry_artifact_name:
        "${{ fromJSON(inputs.candidate_artifact_json || '{}').prepublishPluginRegistryArtifactName || '' }}",
      prepublish_plugin_registry_artifact_run_attempt:
        "${{ fromJSON(inputs.candidate_artifact_json || '{}').prepublishPluginRegistryArtifactRunAttempt || '' }}",
      prepublish_plugin_registry_artifact_run_id:
        "${{ fromJSON(inputs.candidate_artifact_json || '{}').prepublishPluginRegistryArtifactRunId || '' }}",
      prepublish_plugin_registry_manifest_sha256:
        "${{ fromJSON(inputs.candidate_artifact_json || '{}').prepublishPluginRegistryManifestSha256 || '' }}",
    });
    expect(workflow).toContain("candidateAcquisitionResult: $candidateAcquisitionResult");
    expect(request.run).toContain("full-release-candidate-contract.mjs request");
    expect(evidence.run).toContain("full-release-candidate-contract.mjs manifest");
    expect(evidence.run).toContain("verify-full-release-producer-job.mjs");
    expect(evidence.run).toContain('--job-id "$PRODUCER_JOB_ID"');
    expect(evidence.run).toContain('--job-name "$PRODUCER_JOB_NAME"');
    expect(evidence.run).toContain('--run-id "$PRODUCER_RUN_ID"');
    expect(evidence.run).toContain('--run-attempt "$PRODUCER_RUN_ATTEMPT"');
    expect(evidence.run).toContain("publisher: {");
    expect(evidence.run).toContain("requiredPrepublishPluginPackages");
    expect(evidence.run).toContain('verify-upload "$label"');
    expect(binding.run).toContain("full-release-candidate-contract.mjs binding");
    expect(binding.run).toContain("for attempt in 1 2 3");
    expect(upload.with).toMatchObject({
      name: "full-release-candidate-v2-${{ needs.prepare_docker_e2e_image.outputs.candidate_request_sha256 }}",
      "retention-days": 7,
    });
    expect(workflowRevision.env).toMatchObject({
      EXPECTED_WORKFLOW_PATH: ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      JOB_CONTEXT: "${{ toJSON(job) }}",
      RUN_ATTEMPT: "${{ github.run_attempt }}",
      RUN_ID: "${{ github.run_id }}",
    });
    expect(workflowRevision.run).toContain("job.check_run_id");
    expect(workflowRevision.run).toContain("job.workflow_file_path");
    expect(workflowRevision.run).toContain("actions/jobs/${jobId}");
    expect(producer.outputs).toMatchObject({
      candidate_artifact_json: "${{ steps.candidate_manifest.outputs.json }}",
      candidate_request_json: "${{ steps.candidate_request.outputs.json }}",
      candidate_request_sha256: "${{ steps.candidate_request.outputs.sha256 }}",
      plan_sha256: "${{ steps.plan.outputs.plan_sha256 }}",
      producer_job_id: "${{ steps.producer_identity.outputs.job_id }}",
      producer_job_name: "${{ steps.producer_identity.outputs.job_name }}",
      producer_run_attempt: "${{ steps.producer_identity.outputs.run_attempt }}",
      producer_run_id: "${{ steps.producer_identity.outputs.run_id }}",
      producer_workflow_path: "${{ steps.producer_identity.outputs.workflow_path }}",
      producer_workflow_repository: "${{ steps.producer_identity.outputs.workflow_repository }}",
      producer_workflow_sha: "${{ steps.producer_identity.outputs.workflow_sha }}",
    });
    expect(producer.outputs).not.toHaveProperty("candidate_evidence_json");
    expect(binder).toMatchObject({
      if: "inputs.emit_candidate_evidence && needs.prepare_docker_e2e_image.result == 'success'",
      needs: ["validate_selected_ref", "prepare_docker_e2e_image"],
      outputs: {
        candidate_evidence_json: "${{ steps.candidate_binding.outputs.json }}",
      },
      permissions: {
        actions: "read",
        contents: "read",
      },
    });
    expect(evidence.env).toMatchObject({
      CANDIDATE_ARTIFACT_JSON:
        "${{ needs.prepare_docker_e2e_image.outputs.candidate_artifact_json }}",
      CANDIDATE_REQUEST_JSON:
        "${{ needs.prepare_docker_e2e_image.outputs.candidate_request_json }}",
      CANDIDATE_REQUEST_SHA256:
        "${{ needs.prepare_docker_e2e_image.outputs.candidate_request_sha256 }}",
      PLAN_SHA256: "${{ needs.prepare_docker_e2e_image.outputs.plan_sha256 }}",
      PRODUCER_JOB_ID: "${{ needs.prepare_docker_e2e_image.outputs.producer_job_id }}",
      PRODUCER_JOB_NAME: "${{ needs.prepare_docker_e2e_image.outputs.producer_job_name }}",
      PRODUCER_RUN_ATTEMPT: "${{ needs.prepare_docker_e2e_image.outputs.producer_run_attempt }}",
      PRODUCER_RUN_ID: "${{ needs.prepare_docker_e2e_image.outputs.producer_run_id }}",
      PRODUCER_WORKFLOW_PATH:
        "${{ needs.prepare_docker_e2e_image.outputs.producer_workflow_path }}",
      PRODUCER_WORKFLOW_REPOSITORY:
        "${{ needs.prepare_docker_e2e_image.outputs.producer_workflow_repository }}",
      PRODUCER_WORKFLOW_SHA: "${{ needs.prepare_docker_e2e_image.outputs.producer_workflow_sha }}",
      PUBLISHER_JOB_ID: "${{ steps.workflow.outputs.job_id }}",
      PUBLISHER_JOB_NAME: "${{ steps.workflow.outputs.job_name }}",
      PUBLISHER_RUN_ATTEMPT: "${{ steps.workflow.outputs.run_attempt }}",
      PUBLISHER_RUN_ID: "${{ steps.workflow.outputs.run_id }}",
      PUBLISHER_WORKFLOW_PATH: "${{ steps.workflow.outputs.workflow_path }}",
      PUBLISHER_WORKFLOW_REPOSITORY: "${{ steps.workflow.outputs.repository }}",
      PUBLISHER_WORKFLOW_SHA: "${{ steps.workflow.outputs.sha }}",
      REQUIRED_PACKAGES_JSON:
        "${{ needs.prepare_docker_e2e_image.outputs.required_prepublish_plugin_packages }}",
    });
    const checkoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
    const producerSteps = producer.steps ?? [];
    const binderSteps = binder.steps ?? [];
    const producerCheckouts = producerSteps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const binderCheckouts = binderSteps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const binderSetup = binderSteps.find(
      (step) => step.uses === "./.release-harness/.github/actions/setup-release-harness",
    );
    expect(producerCheckouts.map(({ uses, with: inputs }) => ({ inputs, uses }))).toEqual([
      {
        inputs: {
          ref: "${{ needs.validate_selected_ref.outputs.selected_sha }}",
          "fetch-depth": 1,
          "persist-credentials": false,
        },
        uses: checkoutAction,
      },
      {
        inputs: {
          repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
          ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
          "fetch-depth": 1,
          path: ".release-harness",
          "persist-credentials": false,
        },
        uses: checkoutAction,
      },
    ]);
    expect(binderCheckouts.map(({ uses, with: inputs }) => ({ inputs, uses }))).toEqual([
      {
        inputs: {
          repository: "openclaw/openclaw",
          ref: "main",
          "fetch-depth": 1,
          path: ".release-harness",
          "persist-credentials": false,
        },
        uses: checkoutAction,
      },
    ]);
    expect(producerSteps.indexOf(producerIdentity)).toBeLessThan(
      producerSteps.indexOf(producerCheckouts[0]!),
    );
    expect(workflowRevision.env).toEqual({
      EXPECTED_WORKFLOW_PATH: ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      EXPECTED_WORKFLOW_REPOSITORY: "${{ github.repository }}",
      GH_TOKEN: "${{ github.token }}",
      HARNESS_PATH: ".release-harness",
      JOB_CONTEXT: "${{ toJSON(job) }}",
      RUN_ATTEMPT: "${{ github.run_attempt }}",
      RUN_ID: "${{ github.run_id }}",
    });
    expect(workflowRevision.run).toContain('repository !== "openclaw/openclaw"');
    expect(workflowRevision.run).toContain("job.workflow_repository !== repository");
    expect(workflowRevision.run).toContain("job.workflow_sha");
    expect(workflowRevision.run).toContain('"fetch"');
    expect(workflowRevision.run).toContain('"checkout", "--detach", job.workflow_sha');
    expect(binderSetup).toBeDefined();
    expect(binderSteps.indexOf(workflowRevision)).toBeLessThan(binderSteps.indexOf(binderSetup!));
    expect(binderSteps.indexOf(workflowRevision)).toBeLessThan(binderSteps.indexOf(evidence));
    expect(binderSteps.indexOf(workflowRevision)).toBeLessThan(binderSteps.indexOf(upload));
    expect(producerIdentity.env).toMatchObject({
      JOB_CONTEXT: "${{ toJSON(job) }}",
      TOOLING_REPOSITORY: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
      TOOLING_SHA: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
    });
    expect(producerIdentity.run).toContain('.status == "in_progress"');
    expect(producerIdentity.run).toContain("(.run_attempt | tostring) == $run_attempt");
    expect(reusableWorkflow).toContain(
      "value: ${{ jobs.bind_full_release_candidate_evidence.outputs.candidate_evidence_json }}",
    );
    expect(legacyTuple.run).not.toContain("candidate_request");
    expect(legacyTuple.run).not.toContain("expiresAt");
  });

  it.each(["fresh", "reused"])(
    "resolves and admits a %s candidate without a second job",
    (source) => {
      const manifest = fullReleaseCandidateManifestFixture();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      for (const artifact of [
        manifest.package.artifact,
        manifest.prepublishPluginRegistry.artifact,
        manifest.sharedImage.artifact,
      ]) {
        artifact.expiresAt = expiresAt;
      }
      const binding = buildFullReleaseCandidateBinding({
        manifest,
        artifact: fullReleaseCandidateArtifact(
          `full-release-candidate-v2-${manifest.requestSha256}`,
          { expiresAt },
        ),
      });
      const resolved = runCandidateAcquisitionStep("Resolve candidate binding", {
        CANDIDATE_REQUEST_JSON: JSON.stringify(manifest.request),
        EXPECTED_PACKAGE_SHA256: binding.package.packageSha256,
        DISCOVERY_STATE: source === "fresh" ? "miss" : "hit",
        FRESH_CANDIDATE_BINDING_JSON: source === "fresh" ? JSON.stringify(binding) : "",
        REUSED_CANDIDATE_BINDING_JSON: source === "reused" ? JSON.stringify(binding) : "",
      });
      expect(resolved.result.status, resolved.result.stderr).toBe(0);
      const recorded = runCandidateAcquisitionStep("Record candidate acquisition result", {
        JOB_STATUS: "success",
        DISCOVERY_RESULT: "success",
        DISCOVERY_STATE: source === "fresh" ? "miss" : "hit",
        PREPARE_RESULT: source === "fresh" ? "success" : "skipped",
        RESOLVE_RESULT: "success",
        RESOLVED_STATE: resolved.output.state ?? "",
        RESOLVED_SOURCE: resolved.output.source ?? "",
        BINDING_JSON: resolved.output.binding_json ?? "",
        CANDIDATE_ARTIFACT_JSON: resolved.output.candidate_artifact_json ?? "",
      });
      expect(recorded.result.status, recorded.result.stderr).toBe(0);
      expect(recorded.output).toEqual(resolved.output);
      expect(JSON.parse(recorded.output.binding_json ?? "")).toEqual(binding);
      expect(recorded.output.source).toBe(source);
      expect(JSON.parse(recorded.output.candidate_artifact_json ?? "")).toMatchObject({
        packageArtifactId: binding.package.artifact.id,
        packageSha256: binding.package.packageSha256,
        imageArtifactId: binding.sharedImage.artifact.id,
        prepublishPluginRegistryArtifactId: binding.prepublishPluginRegistry.artifact.id,
      });
      expect(
        runCandidateAcquisitionStep("Enforce candidate acquisition", {
          STATE: recorded.output.state ?? "",
        }).result.status,
      ).toBe(0);
    },
  );

  it.each([
    ["discovery failure", { DISCOVERY_RESULT: "failure" }],
    ["unavailable discovery", { DISCOVERY_STATE: "unavailable" }],
    ["prepare failure", { PREPARE_RESULT: "failure" }],
    ["prepare cancellation", { PREPARE_RESULT: "cancelled" }],
    ["checkout failure", { JOB_STATUS: "failure", RESOLVE_RESULT: "skipped" }],
    ["resolution failure", { JOB_STATUS: "failure", RESOLVE_RESULT: "failure" }],
    ["resolution cancellation", { JOB_STATUS: "cancelled", RESOLVE_RESULT: "cancelled" }],
    ["cancellation after resolution", { JOB_STATUS: "cancelled" }],
    ["missing resolution", { RESOLVE_RESULT: "" }],
  ] satisfies Array<[string, Record<string, string>]>)(
    "keeps candidate acquisition unavailable after %s",
    (_label, failure) => {
      const recorded = runCandidateAcquisitionStep("Record candidate acquisition result", {
        JOB_STATUS: "success",
        DISCOVERY_RESULT: "success",
        DISCOVERY_STATE: "hit",
        PREPARE_RESULT: "skipped",
        RESOLVE_RESULT: "success",
        RESOLVED_STATE: "ready",
        RESOLVED_SOURCE: "reused",
        BINDING_JSON: "must-not-forward",
        CANDIDATE_ARTIFACT_JSON: "must-not-forward",
        ...failure,
      });
      expect(recorded.result.status, recorded.result.stderr).toBe(0);
      expect(recorded.output).toEqual({
        state: "unavailable",
        source: "",
        binding_json: "",
        candidate_artifact_json: "",
      });
      expect(
        runCandidateAcquisitionStep("Enforce candidate acquisition", {
          STATE: recorded.output.state ?? "",
        }).result.status,
      ).toBe(1);
    },
  );

  it("rejects malformed candidate resolution and missing terminal output", () => {
    const resolved = runCandidateAcquisitionStep("Resolve candidate binding", {
      CANDIDATE_REQUEST_JSON: "{}",
      DISCOVERY_STATE: "miss",
      FRESH_CANDIDATE_BINDING_JSON: "",
      REUSED_CANDIDATE_BINDING_JSON: "",
    });
    expect(resolved.result.status).toBe(1);
    expect(resolved.result.stderr).toContain("exactly one fresh or reused");
    expect(resolved.output).toEqual({});
    expect(
      runCandidateAcquisitionStep("Enforce candidate acquisition", { STATE: "" }).result.status,
    ).toBe(1);
  });

  it("separates daily live checks from the secretless weekly upgrade survivors", () => {
    const workflow = readWorkflow(SCHEDULED_LIVE_CHECKS_WORKFLOW);
    const daily = workflowJob(SCHEDULED_LIVE_CHECKS_WORKFLOW, "live_and_openwebui_checks");
    const weekly = workflowJob(SCHEDULED_LIVE_CHECKS_WORKFLOW, "weekly_upgrade_survivors");

    expect(workflow.on?.schedule).toEqual([{ cron: "23 4 * * *" }, { cron: "41 6 * * 1" }]);
    expect(daily.if).toBe(
      "github.event_name == 'workflow_dispatch' || github.event.schedule == '23 4 * * *'",
    );
    expect(daily.with).toMatchObject({
      enable_prepublish_plugin_registry: true,
      ref: "${{ github.sha }}",
    });
    expect(weekly.if).toBe(
      "github.event_name == 'schedule' && github.event.schedule == '41 6 * * 1'",
    );
    expect(weekly.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
      "pull-requests": "read",
    });
    expect(weekly.with).toMatchObject({
      ref: "${{ github.sha }}",
      include_repo_e2e: false,
      include_release_path_suites: false,
      include_openwebui: false,
      include_live_suites: false,
      allow_unreleased_changelog: true,
      docker_lanes: "update-migration",
      published_upgrade_survivor_baselines: "2026.7.1 2026.8.1",
      published_upgrade_survivor_scenarios: "mobile-pairing-reconnect watchos-direct-node",
      shared_image_artifact_namespace: "scheduled-upgrade-survivors",
      shared_image_policy: "no-push-artifact",
    });
    expect(weekly.secrets).toBeUndefined();
    expect(weekly.with).not.toHaveProperty("docker_e2e_bare_image");
    expect(weekly.with).not.toHaveProperty("docker_e2e_functional_image");
    expect(weekly.with).not.toHaveProperty("allow_frozen_target_scenario_omissions");
    expect(readWorkflow(UPDATE_MIGRATION_WORKFLOW).on?.schedule).toBeUndefined();
  });

  it.each([false, true])(
    "reconstructs packagePublished=%s in the produced candidate request",
    (packagePublished) => {
      const { output, result } = runFullReleaseCandidateRequest(packagePublished);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(output.json ?? "{}")).toMatchObject({ packagePublished });
    },
  );

  it("gives memory extension shards enough CPU without lowering their planner cost", () => {
    const workflow = readFileSync(PLUGIN_PRERELEASE_WORKFLOW, "utf8");

    expect(workflow).toContain('extensionId.startsWith("memory-")');
    expect(workflow).toContain('"blacksmith-16vcpu-ubuntu-2404"');
    expect(workflow).toContain("vitest_max_workers:");
    expect(workflow).toContain("OPENCLAW_VITEST_MAX_WORKERS: ${{ matrix.vitest_max_workers }}");
    expect(readFileSync("scripts/lib/extension-test-plan.mts", "utf8")).toContain(
      '"test/vitest/vitest.extension-memory.config.ts": 1',
    );
  });

  it.each(["beta", "minimum", "stable", "full"])(
    "accepts every runnable focused live suite for the %s profile",
    (profile) => {
      const suiteIds = new Set(["openshell-e2e", "live-cache", "docker-live-models"]);
      for (const jobName of [
        "validate_live_provider_suites",
        "validate_live_docker_provider_suites",
        "validate_live_media_provider_suites",
      ]) {
        const entries = workflowJob(LIVE_E2E_WORKFLOW, jobName).strategy?.matrix?.include;
        expect(entries?.length, jobName).toBeGreaterThan(0);
        for (const entry of entries ?? []) {
          if (!entry.profiles?.split(/\s+/u).includes(profile)) {
            continue;
          }
          for (const suiteId of [entry.suite_id, entry.suite_group]) {
            if (suiteId) {
              suiteIds.add(suiteId);
            }
          }
        }
      }

      for (const suiteId of suiteIds) {
        const result = runFocusedLiveSuiteValidation(suiteId, { RELEASE_TEST_PROFILE: profile });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`Focused live suite filter is valid: ${suiteId}`);
      }
    },
  );

  it("accepts the OpenCode Go aggregate for its stable smoke lane", () => {
    const result = runFocusedLiveSuiteValidation("native-live-src-gateway-profiles-opencode-go", {
      RELEASE_TEST_PROFILE: "stable",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each<{ suiteId: string; env?: Record<string, string> }>([
    { suiteId: "native-live-src-gateway-profiles-opencode-go-unknown" },
    { suiteId: "native-live-extensions-media-video-e" },
    { suiteId: "unknown-live-suite" },
    {
      suiteId: "native-live-src-gateway-profiles-opencode-go-kimi",
      env: { RELEASE_TEST_PROFILE: "stable" },
    },
    {
      suiteId: "native-live-extensions-media-video-a",
      env: { RELEASE_TEST_PROFILE: "beta" },
    },
    {
      suiteId: "native-live-src-gateway-profiles-opencode-go-kimi",
      env: { INCLUDE_LIVE_SUITES: "false" },
    },
    {
      suiteId: "native-live-extensions-media-video-a",
      env: { LIVE_MODELS_ONLY: "true" },
    },
    { suiteId: "openshell-e2e", env: { INCLUDE_REPO_E2E: "false" } },
    { suiteId: "docker-live-models", env: { INCLUDE_LIVE_SUITES: "false" } },
  ])("rejects unavailable focused suite $suiteId with $env", ({ suiteId, env }) => {
    const result = runFocusedLiveSuiteValidation(suiteId, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `live_suite_filter '${suiteId}' does not match any runnable suite`,
    );
  });

  it("shards broad native live tests instead of one serial live-all job", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const retryHelper = readFileSync("scripts/ci-live-command-retry.sh", "utf8");

    expect(workflow).not.toContain("suite_id: live-all");
    expect(workflow).not.toContain("command: pnpm test:live\n");
    expect(workflow).toContain("suite_id: native-live-src-agents");
    expect(workflow).toContain("Checkout trusted live shard harness");
    expect(
      workflowMatrixEntry(
        LIVE_E2E_WORKFLOW,
        "validate_live_provider_suites",
        "native-live-src-agents",
      ),
    ).toMatchObject({
      command:
        "OPENCLAW_LIVE_OPENAI_COMPACTION=1 OPENCLAW_LIVE_OPENAI_COMPACTION_FULL=0 node .release-harness/scripts/test-live-shard.mjs native-live-src-agents",
      profiles: "stable full",
    });
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
    expect(workflow).toContain("suite_id: live-cli-cache-docker");
    expect(workflow).toContain("OPENCLAW_LIVE_CLI_BACKEND_CACHE_PROBE=1");
    expect(workflow).not.toContain("OPENCLAW_LIVE_CLI_BACKEND_USE_CI_SAFE_CODEX_CONFIG=1");
    expect(workflow).not.toContain('service_tier=\\"fast\\"');
    expect(workflow).not.toContain("OPENCLAW_LIVE_CLI_BACKEND_ARGS=");
    expect(workflow).not.toContain("OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS=");
    expect(workflow).not.toContain(
      'OPENCLAW_LIVE_CLI_BACKEND_ARGS=["exec","--json","--color","never","--sandbox","danger-full-access","--skip-git-repo-check"]',
    );
    expect(workflow).toContain("bash .release-harness/scripts/ci-live-command-retry.sh");
    expect(workflow).toContain("use_github_hosted_runners:");
    for (const [jobName, runner] of [
      ["validate_special_e2e", "blacksmith-32vcpu-ubuntu-2404"],
      ["validate_live_provider_suites", "blacksmith-8vcpu-ubuntu-2404"],
    ] as const) {
      expect(workflowJob(LIVE_E2E_WORKFLOW, jobName)["runs-on"]).toBe(
        `\${{ inputs.use_github_hosted_runners && 'ubuntu-24.04' || '${runner}' }}`,
      );
    }
    for (const jobName of ["build", "test"]) {
      expect(
        workflowJob(".github/workflows/openclaw-repo-e2e-reusable.yml", jobName)["runs-on"],
      ).toBe(
        "${{ inputs.use_github_hosted_runners && 'ubuntu-24.04' || 'blacksmith-32vcpu-ubuntu-2404' }}",
      );
    }
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
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_MODELS=anthropic/claude-opus-5");
    expect(workflow).toContain("anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5");
    expect(workflow).toMatch(
      /suite_id: native-live-src-gateway-profiles-fireworks[\s\S]*?advisory: true/u,
    );
    expect(workflow).toMatch(
      /suite_id: native-live-src-gateway-profiles-openai[\s\S]*?timeout_minutes: 60[\s\S]*?profiles: beta minimum stable full/u,
    );
    expect(workflow).toContain(
      "command: OPENCLAW_LIVE_GATEWAY_SETUP_TIMEOUT_MS=300000 OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.6-luna OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=180000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
    );
    expect(workflow).toContain(
      "OPENCLAW_LIVE_GATEWAY_MODELS=google/gemini-3.1-pro-preview node .release-harness/scripts/test-live-shard.mjs native-live-src-gateway-profiles",
    );
    expect(workflow).toContain(
      "OPENCLAW_LIVE_GATEWAY_MODELS=minimax/MiniMax-M3,minimax-portal/MiniMax-M3 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2",
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
    const scenarios = readFileSync("scripts/lib/docker-e2e-scenarios.mts", "utf8");
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
      "command: OPENCLAW_LIVE_GATEWAY_PROVIDERS=minimax,minimax-portal OPENCLAW_LIVE_GATEWAY_MODELS=minimax/MiniMax-M3,minimax-portal/MiniMax-M3 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2",
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
      expect(script).toContain("DOCKER_RUN_ARGS+=(--rm -t \\");
      expect(script).not.toContain("DOCKER_RUN_ARGS=(docker run --rm -t \\");
    }
    expect(liveDockerAuth).toContain("openclaw_live_prepare_bind_dir_for_container_user");
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
    for (const [file, helper] of [
      ["scripts/test-live-cli-backend-docker.sh", "openclaw_live_prepare_cli_backend"],
      ["scripts/test-live-acp-bind-docker.sh", "openclaw_live_run_setup_command"],
      ["scripts/test-live-codex-harness-docker.sh", "openclaw_live_run_setup_command"],
    ] as const) {
      const script = readFileSync(file, "utf8");
      expect(script).toContain(helper);
      expect(script).not.toContain('timeout --kill-after=30s "${OPENCLAW_LIVE_');
    }
    expect(stage).toContain("elif command -v gtimeout >/dev/null 2>&1; then");
    expect(stage).toContain('if "$timeout_bin" --kill-after=1s 1s true');
    expect(stage).toContain('"$timeout_bin" --kill-after=30s "${timeout_seconds}s" "$@"');
    expect(stage).toContain(
      'echo "timeout command not found; cannot bound ${label} after ${timeout_seconds}s"',
    );
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
      '"$docker_package" "$OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS"',
    );
    expect(stage).toContain('"live CLI backend setup"');
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_ACP_BIND_DOCKER_RUN_TIMEOUT:-2700s",
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      'ACP_SETUP_TIMEOUT_SECONDS="$(openclaw_live_read_positive_int_env OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS 180)"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      '"${OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS:?missing live ACP bind setup timeout seconds}"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      '-e OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS="$ACP_SETUP_TIMEOUT_SECONDS"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      '-e OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON="${OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON:-}"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      '"live ACP bind setup"',
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
      '"${OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS:?missing live Codex harness setup timeout seconds}"',
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      '-e OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS="$CODEX_HARNESS_SETUP_TIMEOUT_SECONDS"',
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      '"live Codex harness setup"',
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
      "DEEPSEEK_API_KEY",
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
    for (const workflowPath of [LIVE_E2E_WORKFLOW, PACKAGE_ACCEPTANCE_WORKFLOW]) {
      expect(readWorkflow(workflowPath).on?.workflow_call).toMatchObject({
        secrets: { DEEPSEEK_API_KEY: { required: false } },
      });
    }
    for (const [jobName, job] of Object.entries(readWorkflow(LIVE_E2E_WORKFLOW).jobs ?? {})) {
      if (job.steps?.some((step) => step.run === `bash ${CI_HYDRATE_LIVE_AUTH_SCRIPT}`)) {
        expect(job.env?.DEEPSEEK_API_KEY, jobName).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
      }
    }
    for (const workflowPath of [RELEASE_CHECKS_WORKFLOW, PACKAGE_ACCEPTANCE_WORKFLOW]) {
      for (const [jobName, job] of Object.entries(readWorkflow(workflowPath).jobs ?? {})) {
        if (
          job.uses === `./${LIVE_E2E_WORKFLOW}` ||
          job.uses === `./${PACKAGE_ACCEPTANCE_WORKFLOW}`
        ) {
          expect(job.secrets, `${workflowPath}:${jobName}`).toMatchObject({
            DEEPSEEK_API_KEY: "${{ secrets.DEEPSEEK_API_KEY }}",
          });
        }
      }
    }
    expect(
      workflowJob(SCHEDULED_LIVE_CHECKS_WORKFLOW, "live_and_openwebui_checks").secrets,
    ).toMatchObject({
      DEEPSEEK_API_KEY: "${{ secrets.DEEPSEEK_API_KEY }}",
    });
    expect(
      workflowJob(SCHEDULED_LIVE_CHECKS_WORKFLOW, "weekly_upgrade_survivors").secrets,
    ).toBeUndefined();
    const hydrationHome = tempDirs.make("live-auth-hydration-");
    const hydrated = spawnSync(
      "bash",
      [
        "-euc",
        `bash "$1" "$2"
unset DEEPSEEK_API_KEY DEEPINFRA_API_KEY
source "$2"
printf '%s\\n' "$DEEPSEEK_API_KEY" "$DEEPINFRA_API_KEY"`,
        "hydrate-live-auth",
        CI_HYDRATE_LIVE_AUTH_SCRIPT,
        resolve(hydrationHome, "live.profile"),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: hydrationHome,
          DEEPSEEK_API_KEY: "deepseek-sentinel",
          DEEPINFRA_API_KEY: "deepinfra-sentinel",
        },
      },
    );
    expect(hydrated.status, hydrated.stderr).toBe(0);
    expect(hydrated.stdout).toBe("deepseek-sentinel\ndeepinfra-sentinel\n");
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
    const setupNodeStep = workflowStep(checkTestboxJob, "Setup Node environment");
    const runTestboxStep = workflowStep(checkTestboxJob, "Run Testbox");
    const closeTestboxSshStep = workflowStep(checkTestboxJob, "Close Testbox SSH sessions");
    const setupNodeWith = setupNodeStep.with ?? {};
    const checkTestboxSteps = checkTestboxJob.steps ?? [];
    const runArmTestboxStep = workflowStep(
      workflowJob(CI_CHECK_ARM_TESTBOX_WORKFLOW, "check-arm"),
      "Run Testbox",
    );
    const runBuildArtifactsTestboxStep = workflowStep(
      workflowJob(CI_BUILD_ARTIFACTS_TESTBOX_WORKFLOW, "build-artifacts"),
      "Run Testbox",
    );
    const windowsTestboxJob = workflowJob(WINDOWS_BLACKSMITH_TESTBOX_WORKFLOW, "windows");
    const runWindowsTestboxStep = workflowStep(windowsTestboxJob, "Run Testbox");
    const windowsTestboxActionMarker = workflowStep(windowsTestboxJob, "Testbox action marker");

    expect(workflow).not.toContain('PNPM_CONFIG_STORE_DIR: "/tmp/openclaw-pnpm-store"');
    expect(workflow).not.toContain("PNPM_CONFIG_MODULES_DIR");
    expect(workflow).not.toContain("PNPM_CONFIG_VIRTUAL_STORE_DIR");
    expect(setupNodeWith).not.toHaveProperty("dependency-cache");
    expect(setupNodeWith).not.toHaveProperty("sticky-disk");
    expect(setupNodeWith["cache-mode"]).toBe("restore");
    expect(checkTestboxJob["timeout-minutes"]).toBe(
      "${{ fromJSON(inputs.timeout_minutes || '120') }}",
    );
    for (const step of [runTestboxStep, runArmTestboxStep, runBuildArtifactsTestboxStep]) {
      expect(step.uses).toBe(RUN_TESTBOX_WITH_FAILURE_REPORTING);
    }
    expect(windowsTestboxActionMarker.uses).toBe(
      "useblacksmith/run-testbox@3f60ff9ceb2c10c3feefa87dc0c6490cffae059d",
    );
    expect(windowsTestboxActionMarker.if).toBe("${{ false }}");
    expect(runTestboxStep.if).toBe("github.event_name == 'workflow_dispatch' && always()");
    expect(closeTestboxSshStep.if).toBe("github.event_name == 'workflow_dispatch' && always()");
    expect(closeTestboxSshStep.run).toContain(
      `sudo sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }'`,
    );
    expect(closeTestboxSshStep.run).toContain(
      'ss -K state established \\\n  "( sport = :${runner_ssh_local_port} )"',
    );
    expect(checkTestboxSteps.indexOf(closeTestboxSshStep)).toBe(
      checkTestboxSteps.indexOf(runTestboxStep) + 1,
    );
    expect(runArmTestboxStep.if).toBe("always()");
    expect(runBuildArtifactsTestboxStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && always()",
    );
    expect(runWindowsTestboxStep.if).toBe("always()");
    expect(runWindowsTestboxStep.env?.JOB_STATUS).toBe("${{ job.status }}");
    expect(runWindowsTestboxStep.env?.NATIVE_SSH_USER).toBe(
      "${{ steps.prepare_windows.outputs.ssh_user }}",
    );
    expect(runWindowsTestboxStep.run).toContain("${NATIVE_SSH_USER}@${runner_host}");
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

  it("forwards optional RTT scenario selection from manual and reusable Telegram inputs", () => {
    const workflow = readWorkflow(NPM_TELEGRAM_WORKFLOW);
    const expectedInput = {
      default: "",
      description: "Optional Telegram QA scenario id for repeated RTT sampling",
      required: false,
      type: "string",
    };

    expect(workflow.on?.workflow_dispatch?.inputs?.rtt_scenario).toEqual(expectedInput);
    expect(workflow.on?.workflow_call?.inputs?.rtt_scenario).toEqual(expectedInput);
    expect(
      workflowStep(
        workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e"),
        "Run package Telegram E2E",
      ).env?.OPENCLAW_NPM_TELEGRAM_RTT_CHECKS,
    ).toBe("${{ inputs.rtt_scenario }}");
  });

  it("requires explicit approval for historical package destructive actions", () => {
    const workflow = readWorkflow(NPM_TELEGRAM_WORKFLOW);
    const expectedInput = {
      default: false,
      description:
        "Allow destructive actions for intentional historical downgrade or recovery proof",
      required: false,
      type: "boolean",
    };

    expect(workflow.on?.workflow_dispatch?.inputs?.allow_older_binary_destructive_actions).toEqual(
      expectedInput,
    );
    expect(workflow.on?.workflow_call?.inputs?.allow_older_binary_destructive_actions).toEqual(
      expectedInput,
    );
    expect(
      workflowStep(
        workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e"),
        "Run package Telegram E2E",
      ).env?.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS,
    ).toBe("${{ inputs.allow_older_binary_destructive_actions && '1' || '' }}");
  });

  it.each(["stable", "full"])(
    "rejects Package Acceptance Telegram deferral for direct %s release checks",
    (releaseProfile) => {
      const { result } = runReleaseChecksInputValidation(releaseProfile, "true");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "skip_package_telegram_e2e is allowed only for release_profile=beta.",
      );
    },
  );

  it.each(["stable", "full"])(
    "rejects Package Acceptance Telegram deferral for umbrella %s validation",
    (releaseProfile) => {
      const result = runFullReleaseInputValidation(releaseProfile, "true");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "skip_package_telegram_e2e is allowed only for release_profile=beta.",
      );
    },
  );

  it.each([
    ["stable", "2026.8.1"],
    ["full", "2026.8.1"],
    ["stable", "2026.9.1"],
    ["full", "2026.9.1"],
  ])("waives only Telegram integration lanes for approved %s %s", (profile, version) => {
    const options = { telegramWaiver: `${version}-owner-approved`, version };
    const direct = runReleaseChecksInputValidation(profile, "false", "all", "false", "", options);
    const umbrella = runFullReleaseInputValidation(profile, "false", options);
    expect(direct.result.status, direct.result.stderr).toBe(0);
    expect(umbrella.status, umbrella.stderr).toBe(0);
    const output = readFileSync(direct.outputPath, "utf8");
    expect(output).toContain(`telegram_waiver=${version}-owner-approved`);
    expect(output).toContain("qa_live_telegram_enabled=false");
    expect(output).toContain("run_release_soak=true");
    expect(output).toContain("skip_package_telegram_e2e=false");
  });

  it.each([
    { version: "2026.8.2" },
    { version: "2026.8.1-beta.3" },
    { telegramWaiver: "true" },
    { telegramWaiver: "2026.9.1-owner-approved" },
    { telegramWaiver: "2026.8.1-owner-approval" },
    { version: "2026.9.1-beta.1", telegramWaiver: "2026.9.1-beta.1-owner-approved" },
    { version: "2026.10.1", telegramWaiver: "2026.10.1-owner-approved" },
    { rerunGroup: "npm-telegram" },
    { liveSuiteFilter: "qa-telegram" },
    { rerunGroup: "qa-live", liveSuiteFilter: "qa-live" },
    { rerunGroup: "qa-live", liveSuiteFilter: "qa-live-all" },
    { rerunGroup: "qa-live", liveSuiteFilter: "qa-all" },
    { rerunGroup: "qa-live", liveSuiteFilter: "qa-live-non-slack" },
    { rerunGroup: "qa-live", liveSuiteFilter: "qa-non-slack" },
    { rerunGroup: "qa-live", liveSuiteFilter: "non-slack" },
    { rerunGroup: "qa-live", liveSuiteFilter: "no-slack" },
    { rerunGroup: "qa-live", liveSuiteFilter: "without-slack" },
  ])("rejects a conflicting Telegram waiver request: %j", (override) => {
    const options = { telegramWaiver: "2026.8.1-owner-approved", ...override };
    const umbrella = runFullReleaseInputValidation("stable", "false", options);
    const direct = runReleaseChecksInputValidation(
      "stable",
      "false",
      options.rerunGroup ?? "all",
      "false",
      options.liveSuiteFilter ?? "",
      options,
    );
    expect(umbrella.status).not.toBe(0);
    expect(direct.result.status).not.toBe(0);
    expect(umbrella.stderr).toContain("Telegram waiver");
    expect(direct.result.stderr).toContain("Telegram waiver");
  });

  it("allows Package Acceptance Telegram deferral only for beta validation", () => {
    const direct = runReleaseChecksInputValidation("beta", "true");
    const umbrella = runFullReleaseInputValidation("beta", "true");

    expect(direct.result.status, direct.result.stderr).toBe(0);
    expect(readFileSync(direct.outputPath, "utf8")).toContain("skip_package_telegram_e2e=true");
    expect(umbrella.status, umbrella.stderr).toBe(0);
  });

  it.each([
    { label: "canonical beta", scope: "npm-beta" },
    { label: "Linux-only beta", crossOsSuiteFilter: "ubuntu", scope: "npm-beta" },
    { label: "beta soak", runReleaseSoak: "true", scope: "full" },
    { label: "focused beta CI", rerunGroup: "ci", scope: "full" },
    { label: "stable profile", releaseProfile: "stable", scope: "full" },
    { label: "stable version", version: "2026.8.1", scope: "full" },
    { label: "main beta profile", targetRef: "main", scope: "full" },
    {
      label: "canonical stable with Windows omitted",
      crossOsSuiteFilter: "ubuntu,macos",
      releaseProfile: "stable",
      version: "2026.8.1",
      runReleaseSoak: "true",
      scope: "npm-stable",
    },
    {
      label: "stable correction",
      releaseProfile: "stable",
      targetRef: "v2026.8.1-1",
      version: "2026.8.1",
      runReleaseSoak: "true",
      scope: "npm-stable",
    },
    {
      label: "extended stable",
      releaseProfile: "stable",
      targetRef: "extended-stable/2026.8.33",
      version: "2026.8.33",
      runReleaseSoak: "true",
      scope: "full",
    },
    {
      label: "full stable",
      releaseProfile: "full",
      version: "2026.8.1",
      runReleaseSoak: "true",
      scope: "full",
    },
    {
      label: "main stable",
      releaseProfile: "stable",
      targetRef: "main",
      version: "2026.8.1",
      runReleaseSoak: "true",
      scope: "full",
    },
  ])(
    "resolves $label qualification scope before dispatch",
    ({ label: _label, scope, ...overrides }) => {
      const result = runFullReleaseTargetIdentityValidation({
        targetRef: "release/2026.8.1",
        version: "2026.8.1-beta.3",
        ...overrides,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toContain(`ci_release_scope=${scope}\n`);
      expect(result.output).toContain(`coverage_policy=${scope === "full" ? "" : `${scope}-v1`}\n`);
      expect(result.output).toContain(
        `skip_package_telegram_e2e=${overrides.runReleaseSoak === "true" || overrides.rerunGroup === "ci" || overrides.releaseProfile === "stable" ? "false" : "true"}\n`,
      );
    },
  );

  it.each([
    ["beta", "2026.8.1-beta.3", "false"],
    ["stable", "2026.8.1", "true"],
  ])(
    "rejects %s qualification when the cross-OS selection omits Linux coverage",
    (releaseProfile, version, runReleaseSoak) => {
      const result = runFullReleaseTargetIdentityValidation({
        targetRef: "release/2026.8.1",
        releaseProfile,
        version,
        runReleaseSoak,
        crossOsSuiteFilter: "windows,macos,ubuntu/packaged-fresh",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Linux");
      expect(result.output).not.toContain("coverage_policy=");
    },
  );

  it.each([
    ["release/2026.8.1", "2026.8.1"],
    ["release/2026.8.1", "2026.8.1-beta.3"],
    ["extended-stable/2026.7.33", "2026.7.33"],
    ["extended-stable/2026.7.33", "2026.7.35"],
    ["v2026.8.1", "2026.8.1"],
    ["v2026.8.1-alpha.2", "2026.8.1-alpha.2"],
    ["v2026.8.1-beta.3", "2026.8.1-beta.3"],
  ])("accepts direct Full Release Validation identity %s at package %s", (targetRef, version) => {
    const result = runFullReleaseTargetIdentityValidation({ targetRef, version });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["release/2026.8.1", "2026.8.2", "does not belong to release branch"],
    ["release/2026.8.1", "2026.8.1-alpha.2", "expected 2026.8.1 or a beta prerelease"],
    ["extended-stable/2026.7.33", "2026.7.32", "PATCH >= 33"],
    ["extended-stable/2026.7.33", "2026.8.35", "does not belong to extended-stable branch"],
    ["extended-stable/2026.7.33", "2026.7.35-beta.1", "does not belong to extended-stable branch"],
    ["v2026.8.1", "2026.8.1-beta.1", "does not match release tag"],
    ["v2026.8.1-alpha.2", "2026.8.1-alpha.3", "does not match release tag"],
  ])(
    "rejects direct Full Release Validation identity %s at package %s",
    (targetRef, version, error) => {
      const result = runFullReleaseTargetIdentityValidation({ targetRef, version });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
    },
  );

  it("validates an exact-SHA helper target against its canonical release context", () => {
    const accepted = runFullReleaseTargetIdentityValidation({
      targetContextRef: "release/2026.8.1",
      targetRef: "a".repeat(40),
      version: "2026.8.1-beta.3",
    });
    const rejected = runFullReleaseTargetIdentityValidation({
      targetContextRef: "release/2026.8.1",
      targetRef: "a".repeat(40),
      version: "2026.8.1-alpha.3",
    });

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("expected 2026.8.1 or a beta prerelease");
  });

  it.each([
    {
      label: "branch head",
      targetContextRef: "refs/heads/release/2026.8.1",
      comparisonStatus: "identical",
    },
    {
      label: "branch ancestor",
      targetContextRef: "release/2026.8.1",
      remoteSha: "b".repeat(40),
      comparisonStatus: "ahead",
    },
    { label: "release tag commit", targetContextRef: "refs/tags/v2026.8.1" },
    { label: "correction base commit", targetContextRef: "release/2026.8.1-1" },
  ])("validates $label through authenticated refs when anonymous Git is unavailable", (entry) => {
    const { label: _label, ...identity } = entry;
    const result = runFullReleaseTargetIdentityValidation({
      ...identity,
      anonymousGitUnavailable: true,
      targetRef: "a".repeat(40),
      version: "2026.8.1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("ci_release_scope=full\n");
  });

  it.each([
    { apiError: "context", targetContextRef: "release/2026.8.1" },
    { apiError: "comparison", targetContextRef: "release/2026.8.1" },
    { apiError: "base", targetContextRef: "release/2026.8.1-1" },
  ] as const)("fails closed on a $apiError API error", ({ apiError, targetContextRef }) => {
    const result = runFullReleaseTargetIdentityValidation({
      anonymousGitUnavailable: true,
      apiError,
      targetContextRef,
      targetRef: "a".repeat(40),
      version: "2026.8.1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HTTP 503");
    expect(result.output).not.toContain("ci_release_scope=");
  });

  it.each(["refs/tags/release/2026.8.1", "refs/heads/v2026.8.1", "release-ci/2026.8.1"])(
    "rejects the wrong release context namespace %s before ref lookup",
    (targetContextRef) => {
      const result = runFullReleaseTargetIdentityValidation({
        anonymousGitUnavailable: true,
        targetContextRef,
        targetRef: "a".repeat(40),
        version: "2026.8.1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must be a canonical OpenClaw release branch or tag");
      expect(result.output).not.toContain("ci_release_scope=");
    },
  );

  it("validates an exact-SHA extended-stable successor against its canonical branch", () => {
    const result = runFullReleaseTargetIdentityValidation({
      targetContextRef: "extended-stable/2026.6.33",
      targetRef: "a".repeat(40),
      version: "2026.6.35",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["release/2026.8.1-1", "2026.8.1"],
    ["refs/heads/release/2026.8.1-1", "2026.8.1-1"],
    ["v2026.8.1-1", "2026.8.1"],
  ])("preserves the correction publication tag for %s with package %s", (context, version) => {
    const result = runFullReleaseTargetIdentityValidation({
      targetContextRef: context,
      targetRef: "a".repeat(40),
      version,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("release_tag=v2026.8.1-1\n");
    expect(result.output).toContain(`target_version=${version}\n`);
  });

  it.each(["", "b".repeat(40)])(
    "rejects a correction with unproven base source %s",
    (baseTagSha) => {
      const result = runFullReleaseTargetIdentityValidation({
        baseTagSha,
        targetContextRef: "release/2026.8.1-1",
        targetRef: "a".repeat(40),
        version: "2026.8.1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must match base release tag");
    },
  );

  it.each([
    {
      context: "refs/heads/extended-stable/2026.6.33",
      version: "2026.6.35",
      distTag: "extended-stable",
      branch: "extended-stable/2026.6.33",
    },
    {
      context: "refs/tags/v2026.6.35",
      version: "2026.6.35",
      distTag: "extended-stable",
      branch: "extended-stable/2026.6.33",
    },
    { context: "v2026.8.1-alpha.2", version: "2026.8.1-alpha.2", distTag: "alpha", branch: "" },
    {
      context: "refs/heads/release/2026.8.1",
      version: "2026.8.1-beta.3",
      distTag: "beta",
      branch: "",
    },
    { context: "v2026.8.1", version: "2026.8.1", distTag: "beta", branch: "" },
  ])(
    "records the npm publication channel for $context",
    ({ context, version, distTag, branch }) => {
      const result = runFullReleaseTargetIdentityValidation({
        targetContextRef: context,
        targetRef: "a".repeat(40),
        version,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toContain(`npm_dist_tag=${distTag}\n`);
      expect(result.output).toContain(`release_candidate_branch=${branch}\n`);
    },
  );

  it("rejects exact-SHA release contexts outside the named branch or tag", () => {
    const divergedBranch = runFullReleaseTargetIdentityValidation({
      comparisonStatus: "diverged",
      remoteSha: "b".repeat(40),
      targetContextRef: "release/2026.8.1",
      targetRef: "a".repeat(40),
      version: "2026.8.1-beta.3",
    });
    const mismatchedTag = runFullReleaseTargetIdentityValidation({
      remoteSha: "b".repeat(40),
      targetContextRef: "v2026.8.1-alpha.2",
      targetRef: "a".repeat(40),
      version: "2026.8.1-alpha.2",
    });

    expect(divergedBranch.status).toBe(1);
    expect(divergedBranch.stderr).toContain("is not reachable from release context branch");
    expect(mismatchedTag.status).toBe(1);
    expect(mismatchedTag.stderr).toContain("does not match release tag");
  });

  it.each(["stable", "full"])(
    "preserves normal %s validation when Telegram deferral is false",
    (releaseProfile) => {
      const direct = runReleaseChecksInputValidation(releaseProfile, "false");
      const umbrella = runFullReleaseInputValidation(releaseProfile, "false");

      expect(direct.result.status, direct.result.stderr).toBe(0);
      expect(readFileSync(direct.outputPath, "utf8")).toContain("skip_package_telegram_e2e=false");
      expect(umbrella.status, umbrella.stderr).toBe(0);
    },
  );

  it("declares isolated release-check phases in dispatch and concurrency", () => {
    const workflow = readWorkflow(RELEASE_CHECKS_WORKFLOW);

    expect(workflow.on?.workflow_dispatch?.inputs?.phase).toEqual({
      default: "all",
      description: "Release check phase to run",
      options: ["all", "independent", "candidate"],
      required: false,
      type: "choice",
    });
    expect(workflow.concurrency).toEqual({
      group:
        "openclaw-release-checks-${{ inputs.expected_sha || inputs.ref }}-${{ github.sha }}-${{ inputs.rerun_group }}-${{ inputs.phase }}-${{ inputs.release_profile == 'minimum' && 'beta' || inputs.release_profile }}-${{ inputs.run_release_soak || inputs.release_profile == 'stable' || inputs.release_profile == 'full' }}",
      "cancel-in-progress": "${{ startsWith(github.ref, 'refs/heads/tideclaw/alpha/') }}",
    });
  });

  it.each([
    {
      expected: {
        cross_os_scheduled: "true",
        docker_required: "true",
        install_smoke_scheduled: "true",
        live_e2e_scheduled: "true",
        package_acceptance_scheduled: "true",
        package_required: "true",
        qa_live_scheduled: "true",
        qa_parity_scheduled: "true",
        run_maturity_scorecard: "true",
      },
      phase: "all",
    },
    {
      expected: {
        cross_os_scheduled: "false",
        docker_required: "false",
        install_smoke_scheduled: "true",
        live_e2e_scheduled: "true",
        package_acceptance_scheduled: "false",
        package_required: "false",
        qa_live_scheduled: "true",
        qa_parity_scheduled: "true",
        run_maturity_scorecard: "true",
      },
      phase: "independent",
    },
    {
      expected: {
        cross_os_scheduled: "true",
        docker_required: "true",
        install_smoke_scheduled: "false",
        live_e2e_scheduled: "false",
        package_acceptance_scheduled: "true",
        package_required: "true",
        qa_live_scheduled: "false",
        qa_parity_scheduled: "false",
        run_maturity_scorecard: "false",
      },
      phase: "candidate",
    },
  ] as const)("routes only the $phase release-check phase", ({ expected, phase }) => {
    const { outputPath, result } = runReleaseChecksInputValidation(
      "stable",
      "false",
      "all",
      "false",
      "",
      {
        candidateArtifactJson: releaseCandidateArtifactJson(),
        phase,
        runMaturityScorecard: "true",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain(`phase=${phase}\n`);
    for (const [lane, scheduled] of Object.entries(expected)) {
      expect(output).toContain(`${lane}=${scheduled}\n`);
    }
  });

  it("fails closed when a candidate phase would rebuild an FRV artifact", () => {
    const missing = runReleaseChecksInputValidation("beta", "false", "package", "false", "", {
      phase: "candidate",
    });
    const publishedAcceptance = runReleaseChecksInputValidation(
      "beta",
      "false",
      "package",
      "false",
      "",
      {
        packageAcceptancePackageSpec: "openclaw@beta",
        phase: "candidate",
      },
    );
    const publishedCrossOs = runReleaseChecksInputValidation(
      "beta",
      "false",
      "cross-os",
      "false",
      "",
      {
        phase: "candidate",
        releasePackageSpec: "openclaw@beta",
      },
    );
    const conflictingPublishedRelease = runReleaseChecksInputValidation(
      "beta",
      "false",
      "all",
      "false",
      "",
      {
        candidateArtifactJson: releaseCandidateArtifactJson(),
        phase: "candidate",
        releasePackageSpec: "openclaw@beta",
      },
    );
    const missingProvenance = runReleaseChecksInputValidation("beta", "false", "all", "false", "", {
      candidateArtifactJson: JSON.stringify({
        ...JSON.parse(releaseCandidateArtifactJson()),
        packagePublished: undefined,
      }),
      phase: "candidate",
    });
    const malformedProvenance = runReleaseChecksInputValidation(
      "beta",
      "false",
      "all",
      "false",
      "",
      {
        candidateArtifactJson: releaseCandidateArtifactJson().replace(
          '"packagePublished":false',
          '"packagePublished":"false"',
        ),
        phase: "candidate",
      },
    );

    expect(missing.result.status).toBe(1);
    expect(missing.result.stderr).toContain(
      "phase=candidate requires candidate_artifact_json unless every selected package path uses a published package spec.",
    );
    expect(publishedAcceptance.result.status, publishedAcceptance.result.stderr).toBe(0);
    expect(publishedCrossOs.result.status, publishedCrossOs.result.stderr).toBe(0);
    expect(conflictingPublishedRelease.result.status).toBe(1);
    expect(conflictingPublishedRelease.result.stderr).toContain(
      "candidate_artifact_json cannot be combined with release_package_spec.",
    );
    expect(missingProvenance.result.status).not.toBe(0);
    expect(malformedProvenance.result.status).not.toBe(0);
  });

  it("uses a candidate for release lanes with a separate Package Acceptance override", () => {
    const { outputPath, result } = runReleaseChecksInputValidation(
      "stable",
      "false",
      "all",
      "false",
      "",
      {
        candidateArtifactJson: releaseCandidateArtifactJson(),
        packageAcceptancePackageSpec: "openclaw@next",
        phase: "candidate",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("package_mode=artifact\n");
    expect(output).toContain("package_acceptance_package_spec=openclaw@next\n");
    expect(output).toContain("cross_os_scheduled=true\n");
    expect(output).toContain("docker_required=true\n");
    expect(output).toContain("package_acceptance_scheduled=true\n");
  });

  it("preserves published provenance when an immutable candidate is reused", () => {
    const { outputPath, result } = runReleaseChecksInputValidation(
      "stable",
      "false",
      "all",
      "false",
      "",
      {
        candidateArtifactJson: releaseCandidateArtifactJson("a".repeat(40), true),
        phase: "candidate",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("package_mode=artifact\n");
    expect(output).toContain("candidate_published=true\n");
  });

  it.each([
    ["beta", "all", "false", "false", "false"],
    ["beta", "all", "true", "true", "true"],
    ["stable", "all", "false", "true", "true"],
    ["full", "all", "false", "true", "true"],
    ["beta", "qa", "false", "false", "true"],
    ["beta", "qa-live", "false", "false", "true"],
  ])(
    "normalizes QA-live scheduling for profile=%s group=%s soak=%s",
    (releaseProfile, rerunGroup, runReleaseSoak, expectedSoak, expectedScheduled) => {
      const { outputPath, result } = runReleaseChecksInputValidation(
        releaseProfile,
        "false",
        rerunGroup,
        runReleaseSoak,
      );

      expect(result.status, result.stderr).toBe(0);
      const output = readFileSync(outputPath, "utf8");
      expect(output).toContain(`run_release_soak=${expectedSoak}\n`);
      expect(output).toContain(`qa_live_scheduled=${expectedScheduled}\n`);
    },
  );

  it("schedules only the selected QA-live lane for a QA-group filter", () => {
    const { outputPath, result } = runReleaseChecksInputValidation(
      "beta",
      "false",
      "qa",
      "false",
      "qa-live-telegram",
    );

    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("qa_live_scheduled=true\n");
    expect(output).toContain("qa_live_telegram_enabled=true\n");
    for (const lane of ["matrix", "buzz", "discord", "whatsapp", "slack"]) {
      expect(output).toContain(`qa_live_${lane}_enabled=false\n`);
    }
  });

  it("keeps a focused repo-live filter within the live-E2E group", () => {
    const { outputPath, result } = runReleaseChecksInputValidation(
      "beta",
      "false",
      "live-e2e",
      "false",
      "repo-e2e",
    );

    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("qa_live_scheduled=false\n");
    expect(output).toContain("repo_live_suite_filter=repo-e2e\n");
    expect(output).toContain("package_required=false\n");
    expect(output).toContain("docker_required=false\n");
  });

  it("rejects a QA-live filter for an unrelated rerun group", () => {
    const { result } = runReleaseChecksInputValidation(
      "beta",
      "false",
      "install-smoke",
      "false",
      "qa-live-telegram",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "QA live_suite_filter selectors require rerun_group=qa or qa-live",
    );
  });

  it.each([
    {
      label: "deferred Package Acceptance",
      rerunGroup: "package",
      skipTelegram: "true",
      overrides: {},
      expected: "Package Telegram E2E: deferred by `skip_package_telegram_e2e`",
    },
    {
      label: "unrelated CI group",
      rerunGroup: "ci",
      skipTelegram: "true",
      overrides: {},
      expected: "Package Telegram E2E: skipped by rerun group",
    },
    {
      label: "selected Package Acceptance",
      rerunGroup: "package",
      skipTelegram: "false",
      overrides: {},
      expected: "Package Telegram E2E: OpenClaw Release Checks Package Acceptance",
    },
    {
      label: "focused Telegram without a package",
      rerunGroup: "npm-telegram",
      skipTelegram: "false",
      overrides: {},
      expected:
        "Package Telegram E2E: focused rerun requires `release_package_spec` or `npm_telegram_package_spec`",
    },
    ...["RELEASE_PACKAGE_SPEC", "NPM_TELEGRAM_PACKAGE_SPEC"].map((input) => ({
      label: `published package from ${input}`,
      rerunGroup: "npm-telegram",
      skipTelegram: "false",
      overrides: { [input]: "openclaw@2026.8.1-beta.3" },
      expected: "Published-package Telegram E2E: `openclaw@2026.8.1-beta.3`",
    })),
  ])(
    "summarizes Telegram package outcome for $label",
    ({ rerunGroup, skipTelegram, expected, overrides }) => {
      const { result, summary } = runFullReleaseTargetSummary(rerunGroup, skipTelegram, overrides);
      expect(result.status, result.stderr).toBe(0);
      expect(
        summary
          .split("\n")
          .filter((line) => /^- (Published-package|Package) Telegram E2E:/u.test(line)),
      ).toEqual([`- ${expected}`]);
    },
  );

  it("includes package acceptance in release checks", () => {
    const workflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const filterValidator = readFileSync(RELEASE_FILTER_VALIDATOR, "utf8");
    const packageAcceptanceWorkflow = parse(readFileSync(PACKAGE_ACCEPTANCE_WORKFLOW, "utf8")) as {
      on?: {
        workflow_call?: { inputs?: Record<string, unknown> };
      };
    };
    const packageAcceptanceJob = workflowJob(
      RELEASE_CHECKS_WORKFLOW,
      "package_acceptance_release_checks",
    );
    const releaseChecksTargetSummary = workflowStep(
      workflowJob(RELEASE_CHECKS_WORKFLOW, "resolve_target"),
      "Summarize validated ref",
    );
    const packageAcceptanceResolve = workflowStep(
      workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package"),
      "Resolve package candidate",
    );
    const packageAcceptanceBaseline = workflowStep(
      workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package"),
      "Resolve published upgrade survivor baselines",
    );
    const dockerAcceptanceJob = workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "docker_acceptance");

    expect(workflow).toContain("package_acceptance_release_checks:");
    expect(packageAcceptanceWorkflow.on?.workflow_call?.inputs).toHaveProperty(
      "allow_frozen_target_scenario_omissions",
    );
    expect(packageAcceptanceWorkflow.on?.workflow_call?.inputs).not.toHaveProperty(
      "published_artifact",
    );
    expect(packageAcceptanceJob.with).toMatchObject({
      allow_frozen_target_scenario_omissions:
        "${{ inputs.allow_frozen_target_scenario_omissions }}",
      artifact_digest: "${{ needs.prepare_release_package.outputs.artifact_digest }}",
      artifact_id: "${{ needs.prepare_release_package.outputs.artifact_id }}",
      artifact_name: "${{ needs.prepare_release_package.outputs.artifact_name }}",
      artifact_run_attempt: "${{ needs.prepare_release_package.outputs.artifact_run_attempt }}",
      artifact_run_id: "${{ needs.prepare_release_package.outputs.artifact_run_id }}",
      package_file_name: "${{ needs.prepare_release_package.outputs.package_file_name }}",
      package_sha256:
        "${{ needs.resolve_target.outputs.package_acceptance_package_spec == '' && needs.prepare_release_package.outputs.package_sha256 || '' }}",
      package_source_sha: "${{ needs.prepare_release_package.outputs.source_sha }}",
      package_version: "${{ needs.prepare_release_package.outputs.package_version }}",
      prepublish_plugin_registry_json:
        "${{ needs.resolve_target.outputs.package_acceptance_package_spec == '' && needs.prepare_release_package.outputs.prepublish_plugin_registry_json || '' }}",
      suite_profile: "custom",
      target_context_ref:
        "${{ needs.resolve_target.outputs.package_acceptance_package_spec == '' && inputs.target_context_ref || '' }}",
      published_upgrade_survivor_baseline:
        "${{ needs.resolve_target.outputs.package_acceptance_package_spec == '' && format('openclaw@{0}', needs.prepare_release_package.outputs.upgrade_baseline) || 'openclaw@latest' }}",
    });
    expect(packageAcceptanceJob.with?.candidate_artifact_json).toBe(
      "${{ needs.resolve_target.outputs.package_acceptance_package_spec == '' && needs.prepare_release_package.outputs.candidate_artifact_json || '' }}",
    );
    expect(packageAcceptanceResolve.env?.PUBLISHED_ARTIFACT).toBe(
      "${{ fromJSON(inputs.candidate_artifact_json || '{}').packagePublished == true }}",
    );
    expect(packageAcceptanceBaseline.env).toMatchObject({
      CANDIDATE_PUBLISHED:
        "${{ inputs.source == 'npm' || fromJSON(inputs.candidate_artifact_json || '{}').packagePublished == true }}",
      CANDIDATE_VERSION: "${{ steps.resolve.outputs.package_version }}",
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
    });
    expect(releaseChecksTargetSummary.env).toMatchObject({
      SKIP_PACKAGE_TELEGRAM_E2E: "${{ steps.inputs.outputs.skip_package_telegram_e2e }}",
    });
    expect(releaseChecksTargetSummary.run).toContain("Package Acceptance Telegram E2E deferred:");
    expect(dockerAcceptanceJob.with).toMatchObject({
      allow_frozen_target_scenario_omissions:
        "${{ inputs.allow_frozen_target_scenario_omissions || false }}",
      enable_prepublish_plugin_registry:
        "${{ contains(fromJSON('[\"artifact\",\"ref\"]'), inputs.source) && fromJSON(inputs.candidate_artifact_json || '{}').packagePublished != true }}",
      prepublish_plugin_registry_manifest_sha256:
        "${{ startsWith(fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactName || '', 'docker-e2e-prepublish-plugin-registry-') && fromJSON(needs.resolve_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryManifestSha256 || '' }}",
    });
    expect(workflow).toContain(
      "candidate_artifact_json cannot be combined with release_package_spec.",
    );
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
      "source: ${{ needs.resolve_target.outputs.package_acceptance_package_spec != '' && 'npm' || 'artifact' }}",
    );
    expect(workflow).toContain(
      "package_spec: ${{ needs.resolve_target.outputs.package_acceptance_package_spec || 'openclaw@beta' }}",
    );
    expect(workflow).toContain(".artifacts/docker-e2e-package/package-candidate.json");
    expect(workflow).toContain(
      "artifact_name: ${{ needs.prepare_release_package.outputs.artifact_name }}",
    );
    expect(workflow).toContain(
      "package_sha256: ${{ needs.resolve_target.outputs.package_acceptance_package_spec == '' && needs.prepare_release_package.outputs.package_sha256 || '' }}",
    );
    expect(workflow).toContain("suite_profile: custom");
    expect(String(packageAcceptanceJob.with?.docker_lanes ?? "").split(/\s+/u)).toEqual([
      "release-typed-onboarding",
      "doctor-switch",
      "update-channel-switch",
      "skill-install",
      "update-corrupt-plugin",
      "upgrade-survivor",
      "update-first-hop-compat",
      "published-upgrade-survivor",
      "root-managed-vps-upgrade",
      "update-restart-auth",
      "plugins-offline",
      "plugin-update",
      "plugin-binding-command-escape",
    ]);
    expect(packageAcceptanceJob.with?.published_upgrade_survivor_baselines).toBeUndefined();
    expect(workflow).toContain(
      "published_upgrade_survivor_scenarios: ${{ needs.resolve_target.outputs.run_release_soak == 'true' && 'reported-issues' || '' }}",
    );
    expect(readWorkflow(RELEASE_CHECKS_WORKFLOW).on?.workflow_dispatch?.inputs).toMatchObject({
      skip_package_telegram_e2e: {
        default: false,
        type: "boolean",
      },
    });
    expect(packageAcceptanceJob.with).toMatchObject({
      telegram_mode:
        "${{ (needs.resolve_target.outputs.telegram_waiver != '' || needs.resolve_target.outputs.skip_package_telegram_e2e == 'true') && 'none' || 'mock-openai' }}",
    });
    expect(packageAcceptanceJob.with).toMatchObject({
      telegram_advisory: true,
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
    expect(workflow).toContain(
      "RELEASE_FILTER_VALIDATOR: workflow/scripts/github/validate-release-suite-filters.sh",
    );
    expect(workflow).toContain('source "$RELEASE_FILTER_VALIDATOR"');
    expect(filterValidator).toContain('repo_filter_tokens+=("$token")');
    expect(filterValidator).toContain(
      'RELEASE_FILTER_REPO_LIVE_SUITE_FILTER="$(IFS=,; printf \'%s\' "${repo_filter_tokens[*]-}")"',
    );
    expect(workflow).toContain("cross_os_suite_filter:");
    expect(workflow).toContain("advisory: false");
    expect(workflow).toContain(
      "suite_filter: ${{ needs.resolve_target.outputs.cross_os_suite_filter }}",
    );
    expect(workflow).toContain(
      "live_suite_filter: ${{ needs.resolve_target.outputs.repo_live_suite_filter }}",
    );
    expect(workflow).toContain("if: needs.resolve_target.outputs.package_required == 'true'");
    expect(workflow).toContain("if: needs.resolve_target.outputs.docker_required == 'true'");
    expect(workflow).toContain(
      'if [[ "$release_profile" == "stable" || "$release_profile" == "full" ]]; then\n            run_release_soak=true',
    );
    expect(workflow).toContain("forced on for release_profile=stable and full");
    expect(workflow).toContain("- live-e2e");
    expect(workflow).toContain("- qa-live");
    expect(workflow).toContain("disabled_required_lanes=()");
    expect(filterValidator).toContain(
      "QA live_suite_filter selectors require rerun_group=qa or qa-live",
    );
    expect(filterValidator).toContain(
      "Repo live_suite_filter selectors require rerun_group=live-e2e",
    );
    expect(filterValidator).toContain("cross_os_suite_filter requires rerun_group=all or cross-os");
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
    expect(releaseJob.secrets).toEqual({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_CONVEX_SECRET_CI: "${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
      OPENCLAW_QA_CONVEX_SITE_URL: "${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    });
    expect(releaseJob.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(releaseJob.if).toBe(
      "needs.resolve_target.outputs.qa_live_scheduled == 'true' && needs.resolve_target.outputs.qa_live_matrix_enabled == 'true'",
    );
    expect(releaseJob.with).toMatchObject({
      expected_sha: "${{ needs.resolve_target.outputs.revision }}",
      fail_fast: "${{ fromJSON(needs.resolve_target.outputs.fail_fast) }}",
      run_matrix: true,
    });
    for (const lane of ["mock_parity", "buzz", "telegram", "discord", "whatsapp", "slack"]) {
      expect(releaseJob.with?.[`run_${lane}`]).toBeUndefined();
    }
    const manualScenarioGuard =
      "(github.event_name != 'workflow_dispatch' || inputs.scenario == '')";
    expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_mock_parity").if).toBe(
      `(inputs.expected_sha == '' || inputs.run_mock_parity) && ${manualScenarioGuard}`,
    );
    expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_matrix").if).toBe(
      `(inputs.expected_sha == '' || inputs.run_matrix) && ${manualScenarioGuard}`,
    );
    expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_telegram").if).toBe(
      "inputs.expected_sha == '' || inputs.run_telegram",
    );
    for (const channel of ["discord", "whatsapp", "slack"]) {
      expect(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, `run_live_${channel}`).if).toBe(
        `(inputs.expected_sha == '' || inputs.run_${channel}) && ${manualScenarioGuard}`,
      );
    }
    expect(releaseWorkflow).not.toContain("qa_live_matrix_release_checks");
    expect(releaseWorkflow).not.toContain("Run QA Lab live Matrix lane");
    expect(releaseWorkflow).not.toContain("pnpm openclaw qa matrix");
    expect(qaWorkflow).toContain("pnpm openclaw qa matrix");
    expect(qaWorkflow).toContain('if [[ "$FAIL_FAST" == "true" ]]');
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
    expect(matrixJob["timeout-minutes"]).toBe(90);
    expect(workflowStep(matrixJob, "Run Matrix live lane").run).toContain(
      "--provider-mode mock-openai",
    );
    const matrixSpecificInputs = Object.keys(
      readWorkflow(QA_LIVE_TRANSPORTS_WORKFLOW).on?.workflow_call?.inputs ?? {},
    ).filter((input) => input.startsWith("matrix_"));
    expect(matrixSpecificInputs).toEqual([]);
    expect(workflowStep(matrixJob, "Upload Matrix QA artifacts").with?.name).toBe(
      "${{ inputs.expected_sha != '' && format('release-qa-live-matrix-{0}', inputs.expected_sha) || format('qa-live-matrix-{0}-{1}', github.run_id, github.run_attempt) }}",
    );
    expect(matrixJob["continue-on-error"]).toBeUndefined();
    expect(matrixJob.strategy).toBeUndefined();
    expect(workflowStep(matrixJob, "Run Matrix live lane").env).toEqual({
      FAIL_FAST: "${{ inputs.fail_fast }}",
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_LIVE_OPENAI_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_REDACT_PUBLIC_METADATA: "1",
    });
    expect(releaseTelegramWorkflow).toContain(
      'echo "Telegram live lane failed on attempt ${attempt}; retrying once..." >&2',
    );
  });

  it("routes release Buzz through the QA Lab selector", () => {
    const releaseJob = workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_live_buzz_release_checks");

    expect(releaseJob.uses).toBe("./.github/workflows/qa-live-transports-convex.yml");
    expect(releaseJob.secrets).toEqual({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_CONVEX_SECRET_CI: "${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
      OPENCLAW_QA_CONVEX_SITE_URL: "${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    });
    expect(releaseJob.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(releaseJob.if).toBe(
      "needs.resolve_target.outputs.qa_live_scheduled == 'true' && needs.resolve_target.outputs.qa_live_buzz_enabled == 'true'",
    );
    expect(releaseJob.with).toMatchObject({
      buzz_scenario: "channel-canary,channel-mention-gating",
      expected_sha: "${{ needs.resolve_target.outputs.revision }}",
      run_buzz: true,
    });
    const buzzJob = workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_buzz");
    expect(buzzJob.if).toBe("inputs.run_buzz");
    const resolveBuzz = workflowStep(buzzJob, "Resolve Buzz QA runner");
    expect(resolveBuzz.run).toContain('runner?.commandName === "buzz"');
    expect(resolveBuzz.run).toContain("selected ref does not declare the Buzz QA runner");
    expect(workflowStep(buzzJob, "Validate required Buzz QA credential env").if).toBe(
      "steps.resolve_buzz.outputs.available == 'true'",
    );
    expect(workflowStep(buzzJob, "Build private QA runtime").if).toBe(
      "steps.resolve_buzz.outputs.available == 'true'",
    );
    expect(workflowStep(buzzJob, "Run Buzz live lane").if).toBe(
      "steps.resolve_buzz.outputs.available == 'true'",
    );
    expect(workflowStep(buzzJob, "Upload Buzz QA artifacts").with?.name).toBe(
      "${{ inputs.expected_sha != '' && format('release-qa-live-buzz-{0}-{1}', inputs.expected_sha, github.run_attempt) || format('qa-live-buzz-{0}-{1}', github.run_id, github.run_attempt) }}",
    );
    expect(workflowStep(buzzJob, "Upload Buzz QA artifacts").with?.path).toBe(
      "${{ steps.resolve_buzz.outputs.output_dir }}",
    );
    const requireBuzz = workflowStep(buzzJob, "Require requested Buzz QA runner");
    expect(requireBuzz.if).toBe(
      "always() && inputs.expected_sha == '' && steps.resolve_buzz.outcome == 'success' && steps.resolve_buzz.outputs.available != 'true'",
    );
    expect(requireBuzz.run).toContain(
      "The selected ref does not declare the requested Buzz QA runner.",
    );
    expect(requireBuzz.run).toContain("exit 1");
  });

  it("runs QA-live on soak or explicit QA groups, not beta all by default", () => {
    const workflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const resolveTarget = workflowJob(RELEASE_CHECKS_WORKFLOW, "resolve_target");
    const liveJobs = [
      ["qa_live_release_checks", "qa_live_matrix_enabled"],
      ["qa_live_buzz_release_checks", "qa_live_buzz_enabled"],
      ["qa_live_telegram_release_checks", "qa_live_telegram_enabled"],
      ["qa_live_discord_release_checks", "qa_live_discord_enabled"],
      ["qa_live_whatsapp_release_checks", "qa_live_whatsapp_enabled"],
      ["qa_live_slack_release_checks", "qa_live_slack_enabled"],
    ] as const;
    const selection = "needs.resolve_target.outputs.qa_live_scheduled == 'true'";

    expect(resolveTarget.outputs?.qa_live_scheduled).toBe(
      "${{ steps.inputs.outputs.qa_live_scheduled }}",
    );

    for (const [jobName, enabledOutput] of liveJobs) {
      expect(workflowJob(RELEASE_CHECKS_WORKFLOW, jobName).if).toBe(
        `${selection} && needs.resolve_target.outputs.${enabledOutput} == 'true'`,
      );
    }

    const verifyStep = workflowStep(
      workflowJob(RELEASE_CHECKS_WORKFLOW, "summary"),
      "Verify release check results",
    );
    expect(verifyStep.env?.QA_LIVE_TELEGRAM_SELECTED).toBe(
      `\${{ ${selection} && needs.resolve_target.outputs.qa_live_telegram_enabled == 'true' }}`,
    );
    const kickoffSummary = workflowStep(resolveTarget, "Summarize validated ref");
    expect(kickoffSummary.env?.QA_LIVE_SCHEDULED).toBe(
      "${{ steps.inputs.outputs.qa_live_scheduled }}",
    );
    expect(kickoffSummary.run).toContain("- QA-live scheduled:");
    expect(kickoffSummary.run).toContain("- QA-live lane eligibility:");
    expect(kickoffSummary.run).not.toContain("- QA live lanes:");
    expect(workflow).not.toContain('contains(fromJSON(\'["qa","qa-live"]\')');
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
      ["run_live_buzz", "Upload Buzz QA artifacts", "always()"],
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

  it("overlays only trusted Anthropic mock tooling for frozen-target QA parity", () => {
    const resolveTarget = workflowJob(RELEASE_CHECKS_WORKFLOW, "resolve_target");
    const contextValidation = workflowStep(resolveTarget, "Validate trusted QA tooling context");
    const eligibility = workflowStep(resolveTarget, "Validate trusted QA tooling eligibility");
    const resolveStepNames = resolveTarget.steps?.map((step) => step.name) ?? [];
    const job = workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_lab_parity_lane_release_checks");
    const trustedCheckout = workflowStep(job, "Checkout trusted QA Anthropic mock tooling");
    const installTooling = workflowStep(job, "Install trusted QA Anthropic mock tooling");
    const stepNames = job.steps?.map((step) => step.name) ?? [];
    const targetSha = "a".repeat(40);
    const eligibilityCondition =
      "needs.resolve_target.outputs.trusted_qa_tooling_eligible == 'true'";

    expect(resolveTarget.outputs?.trusted_qa_tooling_eligible).toBe(
      "${{ steps.trusted_qa_tooling.outputs.eligible }}",
    );
    expect(contextValidation.if).toBe("inputs.target_context_ref != ''");
    expect(
      resolveTarget.steps?.find((step) => step.name === "Checkout trusted QA tooling context"),
    ).toBeUndefined();
    expect(eligibility.if).toBe("steps.trusted_qa_context.outputs.fetch_ref != ''");
    expect(resolveStepNames.indexOf("Validate trusted QA tooling context")).toBeLessThan(
      resolveStepNames.indexOf("Validate trusted QA tooling eligibility"),
    );
    expect(eligibility.env?.TRUSTED_REPOSITORY_URL).toBe(
      "https://github.com/${{ github.repository }}.git",
    );
    expect(eligibility.run).toContain('context_repo="$(mktemp -d)"');
    expect(eligibility.run).toContain("git init --bare --quiet");
    expect(eligibility.run).toContain("--filter=blob:none");
    expect(eligibility.run).toContain("FETCH_HEAD^{commit}");
    expect(eligibility.run).not.toContain("git checkout");
    expect(eligibility.run).not.toContain("git worktree");

    for (const contextRef of [
      "release/2026.8.1",
      "release/2026.8.1-1",
      "refs/heads/extended-stable/2026.8.33",
      "v2026.8.1",
      "refs/tags/v2026.8.1-1",
      "refs/tags/v2026.8.1-alpha.2",
      "v2026.8.1-beta.3",
    ]) {
      const { output, result } = runReleaseChecksShellStep("Validate trusted QA tooling context", {
        TARGET_CONTEXT_REF: contextRef,
        TARGET_REF: targetSha,
      });
      expect(result.status, `${contextRef}: ${result.stderr}`).toBe(0);
      expect(output, contextRef).toContain(
        `normalized_ref=${contextRef.replace(/^refs\/(heads|tags)\//u, "")}\n`,
      );
    }

    for (const contextRef of [
      "main",
      "release-ci/2026.8.1-frozen",
      "release/2026.8",
      "v2026.8.1-rc.1",
      "refs/heads/refs/tags/v2026.8.1",
    ]) {
      const { result } = runReleaseChecksShellStep("Validate trusted QA tooling context", {
        TARGET_CONTEXT_REF: contextRef,
        TARGET_REF: targetSha,
      });
      expect(result.status, contextRef).toBe(1);
      expect(result.stderr).toContain(
        "target_context_ref must be a canonical OpenClaw release branch or tag.",
      );
    }

    for (const targetRef of ["release/2026.8.1", "a".repeat(39)]) {
      const { result } = runReleaseChecksShellStep("Validate trusted QA tooling context", {
        TARGET_CONTEXT_REF: "release/2026.8.1",
        TARGET_REF: targetRef,
      });
      expect(result.status, targetRef).toBe(1);
      expect(result.stderr).toContain(
        "target_context_ref requires ref to be a full 40-character commit SHA.",
      );
    }

    const fixture = createReleaseChecksContextFixture();
    const relationshipCases = [
      ["tag", "refs/tags/v2026.8.1", fixture.branchHeadSha, 0, ""],
      ["tag", "refs/tags/v2026.8.1", fixture.candidateSha, 1, "does not match target"],
      ["branch", "refs/heads/release/2026.8.1", fixture.branchHeadSha, 0, ""],
      ["branch", "refs/heads/release/2026.8.1", fixture.candidateSha, 0, ""],
      [
        "branch",
        "refs/heads/release/2026.8.1",
        fixture.unrelatedSha,
        1,
        "is not reachable from branch",
      ],
      [
        "tag",
        "refs/tags/v2026.8.1-beta.99",
        fixture.branchHeadSha,
        1,
        "Failed to fetch trusted QA tooling context",
      ],
    ] as const;
    for (const [contextKind, fetchRef, targetRef, expectedStatus, error] of relationshipCases) {
      const { output, result } = runReleaseChecksShellStep(
        "Validate trusted QA tooling eligibility",
        {
          CONTEXT_KIND: contextKind,
          CONTEXT_FETCH_REF: fetchRef,
          CONTEXT_REF: fetchRef.replace(/^refs\/(heads|tags)\//u, ""),
          TARGET_REF: targetRef,
          TRUSTED_REPOSITORY_URL: fixture.repoUrl,
        },
      );
      expect(result.status, `${contextKind} ${targetRef}: ${result.stderr}`).toBe(expectedStatus);
      expect(output).toBe(expectedStatus === 0 ? "eligible=true\n" : "");
      if (error) {
        expect(result.stderr).toContain(error);
      }
    }

    expect(trustedCheckout).toMatchObject({
      if: eligibilityCondition,
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        "persist-credentials": false,
        ref: "${{ github.workflow_sha }}",
        path: ".release-qa-tooling-trusted",
        "sparse-checkout": "extensions/qa-lab/src/providers/mock-openai/mock-anthropic-wire.ts",
        "sparse-checkout-cone-mode": false,
      },
    });
    expect(installTooling.if).toBe(eligibilityCondition);
    expect(installTooling.run).toContain("trap 'rm -rf -- \"$trusted_checkout\"' EXIT");
    const installLines = (installTooling.run ?? "").split("\n").map((line) => line.trim());
    const sourceArgument =
      '"$trusted_checkout/extensions/qa-lab/src/providers/mock-openai/mock-anthropic-wire.ts" \\';
    const sourceArgumentIndex = installLines.indexOf(sourceArgument);
    expect(sourceArgumentIndex).toBeGreaterThanOrEqual(0);
    expect(installLines[sourceArgumentIndex + 1]).toBe(
      "extensions/qa-lab/src/providers/mock-openai/mock-anthropic-wire.ts",
    );
    expect(installTooling.run).toContain('rm -rf -- "$trusted_checkout"');
    expect(stepNames.indexOf("Checkout selected ref")).toBeLessThan(
      stepNames.indexOf("Checkout trusted QA Anthropic mock tooling"),
    );
    expect(stepNames.indexOf("Install trusted QA Anthropic mock tooling")).toBeLessThan(
      stepNames.indexOf("Setup Node environment"),
    );
    expect(stepNames.indexOf("Install trusted QA Anthropic mock tooling")).toBeLessThan(
      stepNames.indexOf("Build private QA runtime"),
    );
  });

  it("runs the core gateway restart pair on its pinned live model", () => {
    const job = workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_runtime_token_efficiency");
    const credentialStep = workflowStep(job, "Validate required QA credential env");
    const runStep = workflowStep(job, "Run pinned GPT-5.4 gateway restart runtime pair");
    const stepNames = job.steps?.map((step) => step.name) ?? [];

    expect(credentialStep.run).toContain('if [[ -z "${OPENAI_API_KEY:-}" ]]');
    expect(credentialStep.run).toContain("exit 1");
    expect(runStep.run).toContain("--provider-mode live-frontier");
    expect(runStep.run).toContain("--scenario gateway-restart-multi-live");
    expect(runStep.run).toContain("--model openai/gpt-5.4");
    expect(runStep.run).toContain("--alt-model openai/gpt-5.4");
    expect(runStep.run).toContain("--runtime-pair openclaw,codex");
    expect(runStep.run).toContain(
      "steps.run_lane.outputs.output_dir }}/gateway-restart-gpt-5.4-runtime-pair",
    );
    expect(runStep.run).not.toContain("--allow-failures");
    expect(stepNames.indexOf("Run pinned GPT-5.4 gateway restart runtime pair")).toBeLessThan(
      stepNames.indexOf("Generate live runtime token-efficiency report"),
    );
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
    expect(runtimePairRun).toContain("--runtime-parity-tier standard");
    expect(runtimePairRun).toContain("--runtime-parity-tier soak");
    expect(runtimePairRun).toContain("Frozen candidate cannot select runtime-pair lane");
    expect(workflowStep(laneJob, "Run runtime-pair lane")["continue-on-error"]).toBe(true);
    const runtimePairValidation = workflowStep(laneJob, "Validate runtime-pair lane").run;
    expect(runtimePairValidation).toContain("validator_args+=(--require-explicit-gap)");
    expect(runtimePairValidation).toContain('--target-sha "$RELEASE_CHECK_TARGET_SHA"');
    expect(runtimePairValidation).toContain('--lane "$RUNTIME_PAIR_LANE"');
    expect(runtimePairValidation).toContain(
      'node --import tsx trusted-suite-validator/scripts/validate-qa-runtime-pair-summary.mts "${validator_args[@]}"',
    );
    const coreRestartRun = workflowStep(laneJob, "Run OpenClaw core restart proof").run;
    expect(coreRestartRun).toContain("--scenario gateway-restart-inflight-run");
    expect(coreRestartRun).toContain('--output-dir ".artifacts/qa-e2e/openclaw-core-restart"');
    const trustedValidatorCheckout = workflowStep(
      laneJob,
      "Checkout trusted validator after candidate suite",
    );
    expect(trustedValidatorCheckout.with).toMatchObject({
      ref: "${{ github.sha }}",
      path: "trusted-suite-validator",
      "persist-credentials": false,
    });
    const runtimePairStepNames = (laneJob.steps ?? []).map((step) => step.name);
    expect(runtimePairStepNames.indexOf("Run runtime-pair lane")).toBeLessThan(
      runtimePairStepNames.indexOf("Checkout trusted validator after candidate suite"),
    );
    expect(workflowStep(laneJob, "Generate runtime-pair lane report")["continue-on-error"]).toBe(
      true,
    );
    const runtimePairReport = workflowStep(laneJob, "Validate runtime-pair lane report").run;
    expect(runtimePairReport).toContain(
      '--report-summary "$report_dir/qa-runtime-parity-summary.json"',
    );
    expect(runtimePairReport).toContain(
      '--report-markdown "$report_dir/qa-runtime-parity-report.md"',
    );
    expect(runtimePairReport).toContain("validator_args+=(--require-explicit-gap)");
    expect(runtimePairReport).toContain(
      "node --import tsx trusted-report-validator/scripts/validate-qa-runtime-pair-summary.mts",
    );
    expect(runtimePairStepNames.indexOf("Generate runtime-pair lane report")).toBeLessThan(
      runtimePairStepNames.indexOf("Checkout trusted validator after candidate report"),
    );
    const recordedOutcomes = workflowStep(laneJob, "Record runtime-pair lane status").env?.[
      "RELEASE_CHECK_STEP_OUTCOMES"
    ];
    expect(recordedOutcomes).toContain("steps.runtime_parity_validation.outcome");
    expect(recordedOutcomes).toContain("steps.generate_runtime_parity_report.outcome");
    expect(recordedOutcomes).not.toContain("steps.candidate_runtime_pair.outcome");
    expect(recordedOutcomes).not.toContain("steps.candidate_runtime_parity_report.outcome");
    expect(workflowStep(laneJob, "Upload runtime-pair lane artifacts").with?.name).toContain(
      "${{ matrix.lane }}",
    );
    expect(collectorJob.needs).toEqual([
      "resolve_target",
      "qa_lab_runtime_pair_lane_release_checks",
    ]);
    expect(collectorJob.name).toBe("Verify QA Lab runtime-pair lanes");
    expect(workflowStep(collectorJob, "Resolve runtime-pair lane artifacts").run).toContain(
      "qa_lab_runtime_pair_lane_release_checks|core",
    );
    expect(workflowStep(collectorJob, "Resolve runtime-pair lane artifacts").run).toContain(
      "qa_lab_runtime_pair_lane_release_checks|soak",
    );
    expect(workflowStep(collectorJob, "Download runtime-pair lane artifacts").with).toMatchObject({
      "artifact-ids": "${{ steps.resolve_runtime_pair_artifacts.outputs.payload_ids }}",
      "merge-multiple": true,
    });
    expect(workflowStep(collectorJob, "Download runtime-pair lane artifacts").if).toBe(
      "always() && steps.resolve_runtime_pair_artifacts.outcome == 'success'",
    );
    expect(workflowStep(collectorJob, "Download runtime-pair lane statuses").if).toBe(
      "always() && steps.resolve_runtime_pair_artifacts.outcome == 'success'",
    );
    expect(workflowStep(collectorJob, "Verify runtime-pair lane statuses").run).toContain(
      "resolve-release-check-artifacts.sh validate",
    );
    expect(workflowStep(collectorJob, "Upload runtime parity artifacts").with?.name).toBe(
      "release-qa-runtime-parity-${{ needs.resolve_target.outputs.revision }}-${{ github.run_id }}-${{ github.run_attempt }}",
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

  it("pins Mantis installer and worktree ownership without changing retrieval or install contracts", () => {
    const cases = [
      [MANTIS_DISCORD_STATUS_REACTIONS_WORKFLOW, "run_status_reactions", 2],
      [MANTIS_DISCORD_THREAD_ATTACHMENT_WORKFLOW, "run_thread_attachment", 2],
      [MANTIS_SLACK_DESKTOP_SMOKE_WORKFLOW, "run_slack_desktop", 1],
      [MANTIS_WEB_UI_CHAT_PROOF_WORKFLOW, "run_web_ui_chat", 1],
    ] as const;
    const owner = 'python3 -I -S "$CI_GIT_OWNER"';
    let clones = 0;
    let worktrees = 0;

    for (const [workflowPath, jobName, count] of cases) {
      const job = workflowJob(workflowPath, jobName);
      const initialSteps = [
        "Checkout harness ref",
        ...(jobName === "run_web_ui_chat" ? ["Allocate invocation evidence directory"] : []),
        "Prepare Git owner",
        "Setup Node environment",
      ];
      expect(
        job.steps?.slice(0, initialSteps.length).map(({ name }) => name),
        workflowPath,
      ).toEqual(initialSteps);
      expect(job.steps?.filter(({ name }) => name === "Prepare Git owner")).toEqual([
        {
          name: "Prepare Git owner",
          uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
        },
      ]);
      const prepare =
        workflowStep(
          job,
          count === 2 ? "Prepare baseline and candidate worktrees" : "Prepare candidate worktree",
        ).run ?? "";
      const calls = prepare
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes(" worktree add "));
      expect(calls, workflowPath).toEqual([
        ...(count === 2
          ? [
              `${owner} --checkout-git 0 worktree add --detach "$worktree_root/baseline" "$${jobName === "run_status_reactions" ? "BASELINE_SHA" : "CANDIDATE_SHA"}"`,
            ]
          : []),
        `${owner} --checkout-git 0 worktree add --detach "$worktree_root/candidate" "$CANDIDATE_SHA"`,
      ]);
      worktrees += calls.length;
      expect(prepare.startsWith("set -euo pipefail\n")).toBe(true);
      if (count === 2) {
        expect(prepare).toContain('pnpm --dir "$lane_dir" install --frozen-lockfile');
        expect(prepare).toContain('pnpm --dir "$lane_dir" build');
      } else {
        expect(prepare).toContain(
          'pnpm --dir "$worktree_root/candidate" install --frozen-lockfile --prefer-offline',
        );
        expect(prepare.includes('pnpm --dir "$worktree_root/candidate" build')).toBe(
          jobName === "run_slack_desktop",
        );
      }
      if (jobName === "run_web_ui_chat") {
        continue;
      }
      const install = workflowStep(job, "Install Crabbox CLI").run ?? "";
      const gitCalls = install
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("$CI_GIT_OWNER"));
      const slack = jobName === "run_slack_desktop";
      expect(gitCalls, workflowPath).toEqual(
        slack
          ? [
              `${owner} --git 0 init "$install_dir/src"`,
              `${owner} --checkout-git 0 remote add origin https://github.com/openclaw/crabbox.git`,
              `${owner} --checkout-git 120 fetch --depth 1 origin "$CRABBOX_REF"`,
              `${owner} --checkout-git 0 checkout --detach FETCH_HEAD`,
            ]
          : [
              `${owner} --git 120 clone --depth 1 https://github.com/openclaw/crabbox.git "$install_dir/src"`,
            ],
      );
      clones += gitCalls.filter((line) => line.includes("--git 120 clone")).length;
      expect(install.startsWith("set -euo pipefail\n")).toBe(true);
      expect(install).not.toMatch(/\b(?:for|while|until|timeout)\b|\$\?|\|\|/u);
      expect(install).toContain(
        'go build -C "$install_dir/src" -o "$HOME/.local/bin/crabbox" ./cmd/crabbox\necho "$HOME/.local/bin" >> "$GITHUB_PATH"\n"$HOME/.local/bin/crabbox" --version\n',
      );
      if (slack) {
        expect(readWorkflow(workflowPath).env?.CRABBOX_REF).toBe("main");
        expect(install).toContain('cd "$install_dir/src"');
        expect(install).toContain(
          '"$HOME/.local/bin/crabbox" warmup --help > "$install_dir/warmup-help.txt" 2>&1\ngrep -q -- "-desktop" "$install_dir/warmup-help.txt"\n"$HOME/.local/bin/crabbox" media preview --help >/dev/null',
        );
      } else {
        expect(install).toContain(
          '"$HOME/.local/bin/crabbox" warmup --help 2>&1 | grep -q -- "-desktop"',
        );
      }
    }
    expect(clones).toBe(2);
    expect(worktrees).toBe(6);
    for (const workflowPath of workflowPaths().filter((file) => file.includes("/mantis-"))) {
      expect(readFileSync(workflowPath, "utf8"), workflowPath).not.toMatch(
        /\btimeout\b[^\n]*\bgit\b|\bgit\s+(?:-C\s+\S+\s+)?(?:clone|fetch|worktree\s+add)\b/u,
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

  it("isolates Open WebUI release coverage with lean runtime setup", () => {
    const job = workflowJob(LIVE_E2E_WORKFLOW, "validate_docker_openwebui");
    const setupNode = workflowStep(job, "Setup Node environment");

    expect(job.if).toBe(
      "inputs.include_openwebui && inputs.docker_lanes == '' && (inputs.release_test_profile == 'stable' || inputs.release_test_profile == 'full')",
    );
    expect(job.env?.OPENCLAW_DOCKER_ALL_RELEASE_PROFILE).toBe("${{ inputs.release_test_profile }}");
    expect(setupNode.with).toMatchObject({
      "cache-mode": "off",
      "install-bun": "false",
      "install-deps": "false",
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
      expectedOutput: "::error::npm_12_install_sh ended with failure",
      expectedStatus: 1,
      name: "rejects a failed npm 12 installer acceptance lane",
      params: {
        npm12InstallResult: "failure",
        telegramEnabled: false,
        telegramResult: "skipped",
      },
    },
    {
      expectedOutput: undefined,
      expectedStatus: 0,
      name: "accepts Telegram-only profile when broad lanes skip and Telegram succeeds",
      params: {
        dockerArtifactResult: "skipped",
        dockerRegistryResult: "skipped",
        npm12InstallResult: "skipped",
        suiteProfile: "telegram",
        telegramEnabled: true,
        telegramResult: "success",
      },
    },
    {
      expectedOutput: "::error::npm_12_install_sh ran for suite_profile=telegram",
      expectedStatus: 1,
      name: "rejects Telegram-only profile when npm 12 acceptance runs",
      params: {
        dockerArtifactResult: "skipped",
        dockerRegistryResult: "skipped",
        suiteProfile: "telegram",
        telegramEnabled: true,
        telegramResult: "success",
      },
    },
    {
      expectedOutput: "::error::Docker acceptance ran for suite_profile=telegram",
      expectedStatus: 1,
      name: "rejects Telegram-only profile when a Docker transport runs",
      params: {
        dockerRegistryResult: "skipped",
        npm12InstallResult: "skipped",
        suiteProfile: "telegram",
        telegramEnabled: true,
        telegramResult: "success",
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

  it("allows release callers to make only Telegram package acceptance advisory", () => {
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

  it.each(["failure", "skipped"] as const)(
    "reports a package Telegram %s even when no suite report exists",
    (outcome) => {
      const report = workflowStep(
        workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e"),
        "Summarize Telegram attempt",
      );
      expect(report.if).toBe("always()");
      const workdir = tempDirs.make("npm-telegram-attempt-summary-");
      const summary = resolve(workdir, "summary.md");
      const result = spawnSync("bash", ["-c", report.run ?? ""], {
        cwd: workdir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          ADVISORY: "true",
          GITHUB_STEP_SUMMARY: summary,
          LANE_OUTCOME: outcome,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`::warning::Package Telegram attempt: ${outcome}`);
      expect(readFileSync(summary, "utf8")).toContain(`Telegram attempt: ${outcome}`);
      expect(readFileSync(summary, "utf8")).not.toContain("passed");
    },
  );

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
    const workflowInputs = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW).on?.workflow_dispatch
      ?.inputs;
    const resolveTargetJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "resolve_target");
    const resolveTargetSteps = resolveTargetJob.steps ?? [];
    const evidenceReuseJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "evidence_reuse");
    const releaseChecksJob = workflowJob(
      FULL_RELEASE_VALIDATION_WORKFLOW,
      "release_checks_candidate",
    );
    const npmTelegramJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "npm_telegram");
    const performanceJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "performance");
    const summaryJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary");
    const targetSummaryStep = workflowStep(resolveTargetJob, "Summarize target");
    const targetManifestCheckout = workflowStep(
      resolveTargetJob,
      "Checkout target package manifest",
    );
    const toolingIdentity = workflowStep(resolveTargetJob, "Resolve trusted workflow identity");
    const releaseInputValidation = workflowStep(resolveTargetJob, "Validate release inputs");
    const evidenceReuseStep = workflowStep(evidenceReuseJob, "Find reusable validation evidence");
    const releaseChecksDispatchStep = workflowStep(
      releaseChecksJob,
      "Dispatch release checks candidate phase",
    );
    const dispatchStep = workflowStep(npmTelegramJob, "Dispatch npm Telegram E2E");
    const verificationStep = workflowStep(summaryJob, "Verify exact release state artifacts");
    const manifestStep = workflowStep(summaryJob, "Write release validation manifest");

    expect(workflowInputs).toMatchObject({
      skip_package_telegram_e2e: {
        default: false,
        type: "boolean",
      },
      trusted_workflow_json: {
        default: "",
        required: false,
        type: "string",
      },
    });
    expect(readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW).env).toMatchObject({
      RELEASE_ISOLATION_TOOLING_CONTRACT: "2",
    });
    expect(workflow).toContain("CHILD_WORKFLOW_REF: ${{ github.ref_name }}");
    expect(workflow).toContain('gh workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@" 2>&1');
    expect(targetManifestCheckout.with).toMatchObject({
      ref: "${{ steps.resolve.outputs.sha }}",
      path: "target",
      "sparse-checkout": "package.json",
      "sparse-checkout-cone-mode": false,
      "persist-credentials": false,
    });
    expect(resolveTargetSteps.indexOf(targetManifestCheckout)).toBeLessThan(
      resolveTargetSteps.indexOf(releaseInputValidation),
    );
    expect(resolveTargetJob.outputs?.trusted_workflow_json).toBe(
      "${{ steps.tooling_identity.outputs.json }}",
    );
    expect(toolingIdentity.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      REQUESTED_IDENTITY_JSON: "${{ inputs.trusted_workflow_json }}",
      WORKFLOW_CONTRACT: "${{ env.RELEASE_ISOLATION_TOOLING_CONTRACT }}",
      WORKFLOW_FULL_REF: "${{ github.ref }}",
      WORKFLOW_REF: "${{ github.ref_name }}",
      WORKFLOW_SHA: "${{ github.sha }}",
    });
    expectTextToIncludeAll(toolingIdentity.run, [
      "node workflow/scripts/release-tooling-identity.mjs resolve",
      '--workflow-contract "$WORKFLOW_CONTRACT"',
      '--requested-identity-json "$REQUESTED_IDENTITY_JSON"',
      'echo "json=${identity}"',
    ]);
    expectTextToIncludeAll(releaseInputValidation.run, [
      'target_version="$(jq -er',
      "is not reachable from release context branch",
      "does not match release tag",
      "target_context_ref must be a canonical OpenClaw release branch or tag.",
    ]);
    expect(npmTelegramJob.name).toBe("Run package Telegram E2E");
    expect(npmTelegramJob.needs).toEqual(["resolve_target", "evidence_reuse"]);
    expect(npmTelegramJob["timeout-minutes"]).toBe(15);
    expect(performanceJob["timeout-minutes"]).toBe(15);
    expect(npmTelegramJob.if).toContain(
      'contains(fromJSON(\'["all","npm-telegram"]\'), inputs.rerun_group)',
    );
    expect(npmTelegramJob.if).toContain("needs.evidence_reuse.outputs.reuse != 'true'");
    expect(evidenceReuseStep.env).toMatchObject({
      ALLOW_UNRELEASED_CHANGELOG:
        "${{ inputs.allow_unreleased_changelog || (inputs.target_context_ref == '' && (inputs.ref == 'main' || inputs.ref == 'refs/heads/main')) }}",
      NPM_TELEGRAM_PACKAGE_SPEC: "${{ inputs.npm_telegram_package_spec }}",
      NPM_TELEGRAM_PROVIDER_MODE: "${{ inputs.npm_telegram_provider_mode }}",
      NPM_TELEGRAM_SCENARIO: "${{ inputs.npm_telegram_scenario }}",
      SKIP_PACKAGE_TELEGRAM_E2E: "${{ needs.resolve_target.outputs.skip_package_telegram_e2e }}",
      TRUSTED_WORKFLOW_JSON: "${{ needs.resolve_target.outputs.trusted_workflow_json }}",
    });
    expectTextToIncludeAll(evidenceReuseStep.run, [
      "npmTelegramPackageSpec: $npmTelegramPackageSpec",
      "npmTelegramProviderMode: $npmTelegramProviderMode",
      "npmTelegramScenario: $npmTelegramScenario",
      "skipPackageTelegramE2e: $skipPackageTelegramE2e",
      "allowUnreleasedChangelog: $allowUnreleasedChangelog",
      'trusted_workflow_ref="$(jq -er',
      'trusted_workflow_full_ref="$(jq -er',
      'trusted_workflow_sha="$(jq -er',
      '--trusted-workflow-ref "$trusted_workflow_ref"',
      '--trusted-workflow-full-ref "$trusted_workflow_full_ref"',
      '--trusted-workflow-sha "$trusted_workflow_sha"',
    ]);
    expect(targetSummaryStep.env).toMatchObject({
      SKIP_PACKAGE_TELEGRAM_E2E: "${{ steps.release_inputs.outputs.skip_package_telegram_e2e }}",
    });
    expectTextToIncludeAll(targetSummaryStep.run, [
      "Validation SHA:",
      "Frozen tuple:",
      "Package Acceptance Telegram E2E deferred:",
      "Package Telegram E2E: deferred by \\`skip_package_telegram_e2e\\`",
    ]);
    expect(releaseChecksDispatchStep.env).toMatchObject({
      SKIP_PACKAGE_TELEGRAM_E2E: "${{ needs.resolve_target.outputs.skip_package_telegram_e2e }}",
    });
    expect(releaseChecksDispatchStep.run).toContain(
      '-f skip_package_telegram_e2e="$SKIP_PACKAGE_TELEGRAM_E2E"',
    );
    expect(dispatchStep.env).toEqual({
      CHILD_WORKFLOW_KIND: "npm-telegram",
      CHILD_WORKFLOW_REF: "${{ github.ref_name }}",
      GH_TOKEN: "${{ github.token }}",
      PACKAGE_SPEC: "${{ inputs.npm_telegram_package_spec || inputs.release_package_spec }}",
      PARENT_WORKFLOW_SHA: "${{ github.sha }}",
      PROVIDER_MODE: "${{ inputs.npm_telegram_provider_mode }}",
      SCENARIO: "${{ inputs.npm_telegram_scenario }}",
      TARGET_SHA: "${{ needs.resolve_target.outputs.sha }}",
    });
    expect(manifestStep.env).toMatchObject({
      ALLOW_UNRELEASED_CHANGELOG:
        "${{ inputs.allow_unreleased_changelog || (inputs.target_context_ref == '' && (inputs.ref == 'main' || inputs.ref == 'refs/heads/main')) }}",
      TARGET_REF:
        "${{ startsWith(github.ref, 'refs/heads/release-ci/') && needs.resolve_target.outputs.sha || inputs.ref }}",
      NPM_TELEGRAM_PACKAGE_SPEC: "${{ inputs.npm_telegram_package_spec }}",
      NPM_TELEGRAM_PROVIDER_MODE: "${{ inputs.npm_telegram_provider_mode }}",
      NPM_TELEGRAM_SCENARIO: "${{ inputs.npm_telegram_scenario }}",
      SKIP_PACKAGE_TELEGRAM_E2E: "${{ needs.resolve_target.outputs.skip_package_telegram_e2e }}",
    });
    expectTextToIncludeAll(manifestStep.run, [
      "npmTelegramPackageSpec: $npmTelegramPackageSpec",
      "npmTelegramProviderMode: $npmTelegramProviderMode",
      "npmTelegramScenario: $npmTelegramScenario",
      "skipPackageTelegramE2e: $skipPackageTelegramE2e",
      "allowUnreleasedChangelog: $allowUnreleasedChangelog",
    ]);
    expect(verificationStep.env).toMatchObject({
      RELEASE_PROFILE: "${{ inputs.release_profile }}",
      RERUN_GROUP: "${{ inputs.rerun_group }}",
    });
    expect(verificationStep.run).toBe("node scripts/full-release-validation-state.mjs verify");
    expectTextToIncludeAll(dispatchStep.run, [
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-npm-telegram"',
      'dispatch_output="$(gh workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@" 2>&1)"',
      'dispatch_child npm-telegram-beta-e2e.yml "$dispatch_run_name" "${args[@]}"',
      ".display_title == env.DISPATCH_RUN_NAME and .head_branch == env.CHILD_WORKFLOW_REF",
      "The dispatch was not retried to avoid creating a duplicate child.",
      'if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]; then',
      'echo "run_attempt=${child_run_attempt}" >> "$GITHUB_OUTPUT"',
      '-f harness_ref="$TARGET_SHA"',
      'args=(-f package_spec="$PACKAGE_SPEC"',
      'args+=(-f scenario="$SCENARIO")',
    ]);
    expect(dispatchStep.run).not.toContain("package_artifact");
    expect(dispatchStep.run).not.toContain("allow_older_binary_destructive_actions");
    expectTextToIncludeAll(workflow, [
      '-f rerun_group="$RERUN_GROUP"',
      'args+=(-f live_suite_filter="$LIVE_SUITE_FILTER")',
      'args+=(-f cross_os_suite_filter="$CROSS_OS_SUITE_FILTER")',
      "cancel-in-progress: false",
      "FULL_RELEASE_PLAN_INPUTS_JSON",
      "full-release-validation-policy.mjs",
      "full-release-validation-state.mjs verify",
      'FAIL_FAST: "false"',
      "NORMAL_CI_RESULT: ${{ needs.normal_ci.result }}",
    ]);
    expect(workflow).not.toContain("force-cancel");
    expect(workflow).not.toContain("workflow_ref:");
    expect(workflow).not.toContain("inputs.workflow_ref");
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
      '.status == "pending" or .status == "queued" or .status == "requested" or .status == "waiting" or .status == "in_progress"',
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

  it("accepts active artifacts while GitHub still reports the workflow as pending", () => {
    const result = runNpmTelegramArtifactValidation({
      currentRunId: "123",
      producerConclusion: null,
      producerRunId: "123",
      producerStatus: "pending",
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

  it("accepts direct package artifacts and validates an optional registry tuple", () => {
    const packageTuple = {
      PACKAGE_ARTIFACT_DIGEST: "a".repeat(64),
      PACKAGE_ARTIFACT_ID: "123",
      PACKAGE_ARTIFACT_NAME: "package-under-test",
      PACKAGE_ARTIFACT_RUN_ATTEMPT: "2",
      PACKAGE_ARTIFACT_RUN_ID: "456",
      PACKAGE_FILE_NAME: "openclaw-2026.8.1.tgz",
      PACKAGE_SHA256: "b".repeat(64),
      PACKAGE_SOURCE_SHA: "c".repeat(40),
      PACKAGE_VERSION: "2026.8.1",
    };
    const registryTuple = {
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_DIGEST: "d".repeat(64),
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_ID: "789",
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_NAME: "docker-e2e-prepublish-plugin-registry-123-1",
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_RUN_ATTEMPT: "1",
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_RUN_ID: "123",
      PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: "e".repeat(64),
    };

    expect(runNpmTelegramInputValidation(packageTuple).status).toBe(0);
    expect(runNpmTelegramInputValidation({ ...packageTuple, ...registryTuple }).status).toBe(0);
    expect(
      runNpmTelegramInputValidation({
        ...packageTuple,
        ...registryTuple,
        PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_NAME:
          "package-acceptance-telegram-plugin-registry-123-1",
      }).status,
    ).toBe(0);

    const partial = runNpmTelegramInputValidation({
      ...packageTuple,
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_ID: "789",
    });
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain(
      "Artifact-backed Telegram E2E requires the complete prerelease plugin registry tuple.",
    );

    const wrongName = runNpmTelegramInputValidation({
      ...packageTuple,
      ...registryTuple,
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_NAME: "wrong-name",
    });
    expect(wrongName.status).toBe(1);
    expect(wrongName.stderr).toContain(
      "Prerelease plugin registry artifact name does not match its producer run.",
    );
  });

  it("rejects prerelease plugin registry inputs without a package artifact", () => {
    const result = runNpmTelegramInputValidation({
      PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_ID: "789",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Prerelease plugin registry inputs require an artifact-backed OpenClaw package.",
    );
  });

  it("uses bounded Convex lease waits instead of GitHub concurrency for CI Telegram consumers", () => {
    const telegramJobs = [
      [NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e", "Run package Telegram E2E", undefined],
      [RELEASE_TELEGRAM_QA_WORKFLOW, "run_telegram", "Run Telegram live lane", undefined],
      [QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_telegram", "Run Telegram live lane", "1800000"],
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

    expectTextToIncludeAll(liveE2eWorkflow, [
      "OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=180000",
      "OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
    ]);
  });

  describe("release check artifact resolver", () => {
    const runId = "123456";
    const targetSha = "a".repeat(40);
    const pair = (job: string, variant: string, slug: string): ReleaseCheckArtifactPair => ({
      job,
      payloadBase: `release-payload-${slug}-${targetSha}-${runId}`,
      statusBase: `release-status-${slug}-${targetSha}-${runId}`,
      variant,
    });
    const artifactsFor = (
      artifactPair: ReleaseCheckArtifactPair,
      attempt: number,
      firstId: number,
      options: { expiredPayload?: boolean; expiredStatus?: boolean } = {},
    ): ReleaseCheckArtifact[] => [
      releaseCheckArtifact({
        expired: options.expiredStatus,
        id: firstId,
        name: `${artifactPair.statusBase}-${attempt}`,
        runId,
      }),
      releaseCheckArtifact({
        expired: options.expiredPayload,
        id: firstId + 1,
        name: `${artifactPair.payloadBase}-${attempt}`,
        runId,
      }),
    ];

    it.each([
      {
        artifacts: [1, 2].flatMap((attempt, index) =>
          artifactsFor(pair("qa_job", "candidate", "candidate"), attempt, index * 10 + 1),
        ),
        consumerAttempt: "2",
        expectedAttempt: 2,
        name: "selects the current producer attempt",
      },
      {
        artifacts: artifactsFor(pair("qa_job", "candidate", "candidate"), 1, 1),
        consumerAttempt: "2",
        expectedAttempt: 1,
        name: "carries attempt 1 into consumer attempt 2",
      },
      {
        artifacts: [2, 10].flatMap((attempt, index) =>
          artifactsFor(pair("qa_job", "candidate", "candidate"), attempt, index * 10 + 1),
        ),
        consumerAttempt: "10",
        expectedAttempt: 10,
        name: "orders producer attempts numerically",
      },
      {
        artifacts: [2, 3].flatMap((attempt, index) =>
          artifactsFor(pair("qa_job", "candidate", "candidate"), attempt, index * 10 + 1),
        ),
        consumerAttempt: "2",
        expectedAttempt: 2,
        name: "excludes future producer attempts",
      },
    ])("$name", ({ artifacts, consumerAttempt, expectedAttempt }) => {
      const result = runReleaseCheckArtifactResolve({
        artifacts,
        consumerAttempt,
        pairs: [pair("qa_job", "candidate", "candidate")],
        runId,
        targetSha,
      });

      expect(result.result.status, result.result.stderr).toBe(0);
      expect(result.selection).toHaveLength(1);
      expect(result.selection[0]?.producer_attempt).toBe(expectedAttempt);
    });

    it("selects candidate and baseline attempts independently", () => {
      const candidate = pair("qa_lab_parity_lane_release_checks", "candidate", "candidate");
      const baseline = pair("qa_lab_parity_lane_release_checks", "baseline", "baseline");
      const result = runReleaseCheckArtifactResolve({
        artifacts: [...artifactsFor(candidate, 1, 1), ...artifactsFor(baseline, 2, 11)],
        consumerAttempt: "2",
        pairs: [candidate, baseline],
        runId,
        targetSha,
      });

      expect(result.result.status, result.result.stderr).toBe(0);
      expect(
        Object.fromEntries(
          result.selection.map((selection) => [selection.variant, selection.producer_attempt]),
        ),
      ).toEqual({ baseline: 2, candidate: 1 });
    });

    it("selects core and soak attempts independently", () => {
      const core = pair("qa_lab_runtime_pair_lane_release_checks", "core", "core");
      const soak = pair("qa_lab_runtime_pair_lane_release_checks", "soak", "soak");
      const result = runReleaseCheckArtifactResolve({
        artifacts: [...artifactsFor(core, 2, 1), ...artifactsFor(soak, 1, 11)],
        consumerAttempt: "2",
        pairs: [core, soak],
        runId,
        targetSha,
      });

      expect(result.result.status, result.result.stderr).toBe(0);
      expect(
        Object.fromEntries(
          result.selection.map((selection) => [selection.variant, selection.producer_attempt]),
        ),
      ).toEqual({ core: 2, soak: 1 });
    });

    it("fails when the latest producer attempt has no complete pair", () => {
      const candidate = pair("qa_job", "candidate", "candidate");
      const result = runReleaseCheckArtifactResolve({
        artifacts: [
          ...artifactsFor(candidate, 1, 1),
          releaseCheckArtifact({
            id: 11,
            name: `${candidate.statusBase}-2`,
            runId,
          }),
        ],
        consumerAttempt: "2",
        pairs: [candidate],
        runId,
        targetSha,
      });

      expect(result.result.status).toBe(1);
      expect(result.result.stderr).toContain(
        `requires exactly one ${candidate.payloadBase}-2 artifact; found 0`,
      );
      expect(result.result.stderr.trimEnd()).toMatch(
        /\[resolve-release-check-artifacts\] FAILED \(exit 1\)$/u,
      );
    });

    it("fails on duplicate artifacts at the latest producer attempt", () => {
      const candidate = pair("qa_job", "candidate", "candidate");
      const artifacts = artifactsFor(candidate, 2, 1);
      artifacts.push(
        releaseCheckArtifact({
          id: 11,
          name: `${candidate.statusBase}-2`,
          runId,
        }),
      );
      const result = runReleaseCheckArtifactResolve({
        artifacts,
        consumerAttempt: "2",
        pairs: [candidate],
        runId,
        targetSha,
      });

      expect(result.result.status).toBe(1);
      expect(result.result.stderr).toContain(
        `requires exactly one ${candidate.statusBase}-2 artifact; found 2`,
      );
    });

    it.each([
      {
        artifacts: (candidate: ReleaseCheckArtifactPair) => [
          ...artifactsFor(candidate, 1, 1),
          releaseCheckArtifact({
            id: 11,
            name: `${candidate.statusBase}-broken`,
            runId,
          }),
        ],
        expected: "has malformed producer attempt",
        name: "malformed newer evidence",
      },
      {
        artifacts: (candidate: ReleaseCheckArtifactPair) => [
          ...artifactsFor(candidate, 1, 1),
          ...artifactsFor(candidate, 2, 11, { expiredPayload: true }),
        ],
        expected: "is expired or has invalid expiry metadata",
        name: "expired newer evidence",
      },
    ])("does not fall back past $name", ({ artifacts, expected }) => {
      const candidate = pair("qa_job", "candidate", "candidate");
      const result = runReleaseCheckArtifactResolve({
        artifacts: artifacts(candidate),
        consumerAttempt: "2",
        pairs: [candidate],
        runId,
        targetSha,
      });

      expect(result.result.status).toBe(1);
      expect(result.result.stderr).toContain(expected);
    });

    it.each([
      {
        mutate: (text: string) => text.replace("status=success", "status=success\nstatus=failure"),
        name: "duplicate status fields",
      },
      {
        mutate: (text: string) => text.replace("run_attempt=2", "run_attempt=bogus"),
        name: "malformed status metadata",
      },
    ])("rejects $name", ({ mutate }) => {
      const candidate = pair("qa_job", "candidate", "candidate");
      const resolved = runReleaseCheckArtifactResolve({
        artifacts: artifactsFor(candidate, 2, 1),
        consumerAttempt: "2",
        pairs: [candidate],
        runId,
        targetSha,
      });
      expect(resolved.result.status, resolved.result.stderr).toBe(0);

      const validated = runReleaseCheckArtifactValidation({
        selection: resolved.selection,
        statusText: (selection) => mutate(releaseCheckStatusText(selection)),
      });
      expect(validated.result.status).toBe(1);
    });

    it("sets runtime parity ready=false for validated non-success evidence", () => {
      const runtimePair = pair("qa_lab_runtime_parity_release_checks", "", "runtime-parity");
      const resolved = runReleaseCheckArtifactResolve({
        artifacts: artifactsFor(runtimePair, 2, 1),
        consumerAttempt: "2",
        pairs: [runtimePair],
        runId,
        targetSha,
      });
      expect(resolved.result.status, resolved.result.stderr).toBe(0);

      const workdir = tempDirs.make("runtime-parity-ready-");
      const trustedScript = resolve(
        workdir,
        "trusted-release-check-artifacts/scripts/github/resolve-release-check-artifacts.sh",
      );
      mkdirSync(resolve(trustedScript, ".."), { recursive: true });
      symlinkSync(resolve(REPO_ROOT, RELEASE_CHECK_ARTIFACT_RESOLVER), trustedScript);
      const selectionFile = resolve(workdir, "selection.json");
      writeFileSync(selectionFile, JSON.stringify(resolved.selection));
      const statusDir = resolve(workdir, ".artifacts/release-check-status");
      mkdirSync(statusDir, { recursive: true });
      const selection = resolved.selection[0]!;
      writeFileSync(
        resolve(
          statusDir,
          `${selection.job}-${selection.run_id}-${selection.producer_attempt}.env`,
        ),
        releaseCheckStatusText(selection, "failure"),
      );
      const outputFile = resolve(workdir, "github-output");
      const runtimeCoverage = workflowJob(
        RELEASE_CHECKS_WORKFLOW,
        "runtime_tool_coverage_release_checks",
      );
      const script = workflowStep(
        runtimeCoverage,
        "Verify runtime parity producer status",
      ).run?.replace(
        "${{ steps.resolve_runtime_parity_artifacts.outputs.selection_file }}",
        selectionFile,
      );
      expect(script).toBeTruthy();
      const result = spawnSync("bash", ["-c", script!], {
        cwd: workdir,
        encoding: "utf8",
        env: {
          GITHUB_OUTPUT: outputFile,
          PATH: process.env.PATH,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputFile, "utf8")).toContain("ready=false");
    });
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

    for (const [jobName, stepName] of [
      ["qa_lab_parity_lane_release_checks", "Upload parity lane artifacts"],
      ["qa_lab_parity_report_release_checks", "Upload parity artifacts"],
      ["qa_lab_runtime_pair_lane_release_checks", "Upload runtime-pair lane artifacts"],
      ["qa_lab_runtime_parity_release_checks", "Upload runtime parity artifacts"],
      ["qa_live_discord_release_checks", "Upload Discord QA artifacts"],
      ["qa_live_whatsapp_release_checks", "Upload WhatsApp QA artifacts"],
      ["qa_live_slack_release_checks", "Upload Slack QA artifacts"],
    ] as const) {
      const upload = workflowStep(workflowJob(RELEASE_CHECKS_WORKFLOW, jobName), stepName);
      expect(upload.with?.name, `${jobName}/${stepName}`).toContain(
        "${{ github.run_id }}-${{ github.run_attempt }}",
      );
    }

    for (const jobName of [
      "qa_lab_parity_report_release_checks",
      "qa_lab_runtime_parity_release_checks",
      "runtime_tool_coverage_release_checks",
      "summary",
    ]) {
      const checkout = workflowStep(
        workflowJob(RELEASE_CHECKS_WORKFLOW, jobName),
        "Checkout trusted release artifact resolver",
      );
      expect(checkout.with).toMatchObject({
        path: "trusted-release-check-artifacts",
        ref: "${{ github.sha }}",
        "sparse-checkout": RELEASE_CHECK_ARTIFACT_RESOLVER,
        "sparse-checkout-cone-mode": false,
      });
    }

    const telegramCaller = workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_live_telegram_release_checks");
    const telegramDispatch = workflowStep(telegramCaller, "Dispatch and await trusted Telegram QA");
    expect(telegramDispatch.run).toContain('workflow="openclaw-release-telegram-qa.yml"');
    expect(telegramDispatch.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(telegramDispatch.env).toMatchObject({
      PARENT_WORKFLOW_REF: "${{ github.ref_name }}",
      PARENT_WORKFLOW_SHA: "${{ github.sha }}",
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
    });
    expect(telegramDispatch.run).toContain('--ref "$PARENT_WORKFLOW_REF"');
    expect(telegramDispatch.run).toContain(
      '-f expected_trusted_workflow_sha="$PARENT_WORKFLOW_SHA"',
    );
    expect(telegramDispatch.run).toContain('-f target_context_ref="$TARGET_CONTEXT_REF"');
    expect(telegramDispatch.run).toContain('[[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]');
    expect(telegramDispatch.run).not.toContain("commits/main");
    expect(telegramDispatch.run).not.toContain("dispatch_attempt");
    expect(telegramCaller["continue-on-error"]).toBe(true);
    expect(telegramCaller.outputs?.identity_verified).toBe(
      "${{ steps.dispatch.outputs.identity_verified }}",
    );
    expect(telegramDispatch.run?.indexOf('echo "identity_verified=true"')).toBeGreaterThan(
      telegramDispatch.run?.indexOf('[[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]') ?? -1,
    );
    expect(telegramCaller["timeout-minutes"]).toBe(210);

    const telegramStatus = workflowJob(RELEASE_TELEGRAM_QA_WORKFLOW, "advisory_status");
    expect(telegramStatus["continue-on-error"]).toBeUndefined();
    const telegramRecord = workflowStep(telegramStatus, "Record advisory status");
    expect(telegramRecord.run?.trim()).toBe(
      "set -euo pipefail\nnode scripts/release-telegram-qa.mjs advisory-status",
    );
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
    expect(summary.permissions?.contents).toBe("read");
    const resolveStep = workflowStep(summary, "Resolve advisory evidence artifacts");
    expect(resolveStep["continue-on-error"]).toBe(true);
    expect(resolveStep.run).toContain(
      "trusted-release-check-artifacts/scripts/github/resolve-release-check-artifacts.sh",
    );
    expect(resolveStep.run).toContain('--consumer-attempt "$GITHUB_RUN_ATTEMPT"');
    expect(resolveStep.run).toContain("qa_lab_parity_lane_release_checks|candidate");
    expect(resolveStep.run).toContain("qa_lab_parity_lane_release_checks|baseline");
    const downloadStep = workflowStep(summary, "Download advisory status artifacts");
    expect(downloadStep["continue-on-error"]).toBe(true);
    expect(downloadStep.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    expect(downloadStep.with?.["artifact-ids"]).toBe(
      "${{ steps.resolve_advisory_evidence.outputs.status_ids }}",
    );
    expect(downloadStep.with?.["merge-multiple"]).toBe(true);
    expect(downloadStep.with?.pattern).toBeUndefined();

    const verifyStep = workflowStep(summary, "Verify release check results");
    expect(verifyStep.env).toMatchObject({
      QA_LIVE_BUZZ_RELEASE_CHECKS_RESULT: "${{ needs.qa_live_buzz_release_checks.result }}",
      QA_LIVE_TELEGRAM_RELEASE_CHECKS_RESULT:
        "${{ needs.qa_live_telegram_release_checks.outputs.conclusion || needs.qa_live_telegram_release_checks.result }}",
      QA_LIVE_RELEASE_CHECKS_RESULT: "${{ needs.qa_live_release_checks.result }}",
      RELEASE_CHECK_RUN_ATTEMPT: "${{ github.run_attempt }}",
      RELEASE_CHECK_RUN_ID: "${{ github.run_id }}",
      RELEASE_CHECK_TARGET_SHA: "${{ needs.resolve_target.outputs.revision }}",
      RESOLVE_ADVISORY_EVIDENCE_OUTCOME: "${{ steps.resolve_advisory_evidence.outcome }}",
      VALIDATE_ADVISORY_STATUSES_OUTCOME: "${{ steps.validate_advisory_statuses.outcome }}",
    });
    expectTextToIncludeAll(verifyStep.run, [
      "release_check_result()",
      "validated_status()",
      "advisory-evidence-validated.json",
      "missing or duplicate validated status",
      "Advisory evidence resolution or validation failed",
      'elif [[ "$fallback" != "success" && "$fallback" != "skipped" ]]; then',
      'elif [[ "$fallback" == "success" ]]; then',
      "advisory_status_override_allowed()",
      'if advisory_status_override_allowed "$name"; then',
      "::warning::${name} ended with ${result}; Tideclaw alpha treats non-package-safety release-check lanes as advisory.",
      "::error::${name} ended with ${result}",
      '"qa_live_release_checks=${QA_LIVE_RELEASE_CHECKS_RESULT}"',
      '"qa_live_buzz_release_checks=${QA_LIVE_BUZZ_RELEASE_CHECKS_RESULT}"',
    ]);
    expect(verifyStep.run).not.toContain("qa_live_matrix_release_checks");
    expect(verifyStep.run).not.toContain(
      "QA release-check lanes are advisory and do not block release validation.",
    );
    expect(verifyStep.run).not.toContain("expected_status_artifact_count");
    expect(verifyStep.run).not.toContain("actual_status_count");

    const runtimeCoverage = workflowJob(
      RELEASE_CHECKS_WORKFLOW,
      "runtime_tool_coverage_release_checks",
    );
    expect(workflowStep(runtimeCoverage, "Resolve runtime parity artifacts").run).toContain(
      "trusted-release-check-artifacts/scripts/github/resolve-release-check-artifacts.sh",
    );
    expect(
      workflowStep(runtimeCoverage, "Download runtime parity status").with?.["artifact-ids"],
    ).toBe("${{ steps.resolve_runtime_parity_artifacts.outputs.status_ids }}");
    expectTextToIncludeAll(
      workflowStep(runtimeCoverage, "Verify runtime parity producer status").run,
      ["resolve-release-check-artifacts.sh validate", "ready=false", "ready=true"],
    );
    expect(
      workflowStep(runtimeCoverage, "Download runtime parity artifacts").with?.["artifact-ids"],
    ).toBe("${{ steps.resolve_runtime_parity_artifacts.outputs.payload_ids }}");
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
      expected: [
        `::warning::qa_live_telegram_release_checks ended with ${currentResult}; Telegram release testing is best effort and does not block release validation.`,
      ],
      name: `reports a ${currentResult} selected Telegram child without blocking release`,
      params: { currentAttempt: "2", currentResult, telegramSelected: true },
      status: 0,
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
      expected: ["::error::Telegram dispatch identity was not verified"],
      name: "rejects an unverified Telegram child identity despite advisory execution",
      params: {
        currentAttempt: "2",
        currentResult: "failure",
        telegramIdentityVerified: false,
      },
      status: 1,
    },
    {
      emptyStderr: false,
      expected: [
        "qa_live_telegram_release_checks ended with failure",
        "::error::package_acceptance_release_checks ended with failure",
      ],
      name: "keeps package failures blocking alongside an advisory Telegram failure",
      params: {
        currentAttempt: "2",
        currentResult: "failure",
        resultOverrides: { PACKAGE_ACCEPTANCE_RELEASE_CHECKS_RESULT: "failure" },
      },
      status: 1,
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
      expected: [
        "qa_live_telegram_release_checks ended with cancelled",
        "Telegram release testing is best effort",
      ],
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

  it.each(["cancelled", "failure"] as const)(
    "does not mask a later %s advisory status with an older successful job result",
    (status) => {
      const result = runReleaseChecksSummary({
        currentAttempt: "2",
        currentResult: "skipped",
        discordResult: "success",
        telegramSelected: false,
        validatedStatuses: [
          {
            job: "qa_live_discord_release_checks",
            status,
            variant: "",
          },
        ],
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        `::error::qa_live_discord_release_checks ended with ${status}`,
      );
    },
  );

  it("validates only jobs owned by the selected release-check phase", () => {
    const independent = runReleaseChecksSummary({
      currentAttempt: "1",
      currentResult: "skipped",
      phase: "independent",
      resultOverrides: {
        CROSS_OS_RELEASE_CHECKS_RESULT: "failure",
        DOCKER_E2E_RELEASE_CHECKS_RESULT: "failure",
        PACKAGE_ACCEPTANCE_RELEASE_CHECKS_RESULT: "failure",
        PREPARE_RELEASE_PACKAGE_RESULT: "failure",
      },
      telegramSelected: false,
    });
    const candidate = runReleaseChecksSummary({
      currentAttempt: "1",
      currentResult: "failure",
      phase: "candidate",
      resultOverrides: {
        INSTALL_SMOKE_RELEASE_CHECKS_RESULT: "failure",
        LIVE_REPO_E2E_RELEASE_CHECKS_RESULT: "failure",
        MATURITY_SCORECARD_RELEASE_CHECKS_RESULT: "failure",
        QA_LAB_PARITY_LANE_RELEASE_CHECKS_RESULT: "failure",
        QA_LAB_PARITY_REPORT_RELEASE_CHECKS_RESULT: "failure",
        QA_LAB_RUNTIME_PARITY_RELEASE_CHECKS_RESULT: "failure",
        QA_LIVE_BUZZ_RELEASE_CHECKS_RESULT: "failure",
        QA_LIVE_DISCORD_RELEASE_CHECKS_RESULT: "failure",
        QA_LIVE_RELEASE_CHECKS_RESULT: "failure",
        QA_LIVE_SLACK_RELEASE_CHECKS_RESULT: "failure",
        QA_LIVE_WHATSAPP_RELEASE_CHECKS_RESULT: "failure",
        RUNTIME_TOOL_COVERAGE_RELEASE_CHECKS_RESULT: "failure",
      },
      telegramSelected: false,
    });
    const failedCandidate = runReleaseChecksSummary({
      currentAttempt: "1",
      currentResult: "skipped",
      phase: "candidate",
      resultOverrides: {
        DOCKER_E2E_RELEASE_CHECKS_RESULT: "failure",
      },
      telegramSelected: false,
    });

    expect(independent.status, independent.stderr).toBe(0);
    expect(candidate.status, candidate.stderr).toBe(0);
    expect(failedCandidate.status).toBe(1);
    expect(`${failedCandidate.stdout}\n${failedCandidate.stderr}`).toContain(
      "::error::docker_e2e_release_checks ended with failure",
    );
  });

  it("summarizes start delay separately from execution time in full validation", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const parsedWorkflow = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const summaryJob = parsedWorkflow.jobs?.summary;
    const manifestStep = workflowStep(summaryJob ?? {}, "Write release validation manifest");

    expect(workflow).toContain("Write release validation manifest");
    expect(workflow).toContain("PERFORMANCE_RUN_ID: ${{ needs.performance.outputs.run_id }}");
    expect(workflow).toContain("Upload release validation manifest");
    expect(workflow).toContain("Download diagnostic drain attempts");
    expect(workflow).toContain("full-release-validation-${{ github.run_id }}");
    expect(workflow).toContain("full-release-diagnostic-manifest.json");
    expect(workflow).not.toContain('gh run view "$run_id" --json createdAt,jobs');
    expect(manifestStep.env?.RELEASE_EXECUTION_PLAN_PATH).toContain(
      "full-release-execution-plan.json",
    );
    expect(manifestStep.env?.DIAGNOSTIC_DRAIN_PATH).toContain(
      "full-release-diagnostic-manifest.json",
    );
  });

  it("wires evidence attempts into the acceptance gate", () => {
    const releaseResolveJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const releaseRun = workflowStep(releaseResolveJob, "Resolve full release validation run");
    const releaseManifest = workflowStep(
      releaseResolveJob,
      "Download full release validation manifest",
    );
    const npmPublishJob = workflowJob(OPENCLAW_NPM_RELEASE_WORKFLOW, "publish_openclaw_npm");
    const npmRun = workflowStep(npmPublishJob, "Verify full release validation evidence");
    const npmManifest = workflowStep(npmPublishJob, "Download full release validation manifest");

    expect(releaseRun).toMatchObject({
      id: "full_run",
      env: {
        FULL_RELEASE_VALIDATION_RUN_ID: "${{ inputs.full_release_validation_run_id }}",
        FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "${{ inputs.full_release_validation_run_attempt }}",
      },
    });
    expect(releaseRun.run).toContain(
      'run_endpoint+="/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}"',
    );
    expect(releaseResolveJob.outputs?.full_release_validation_run_attempt).toBe(
      "${{ steps.full_run.outputs.attempt }}",
    );
    expect(releaseManifest.with).toMatchObject({
      name: "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ steps.full_run.outputs.attempt }}",
      "run-id": "${{ inputs.full_release_validation_run_id }}",
    });

    expect(npmRun.env).toMatchObject({
      FULL_RELEASE_VALIDATION_RUN_ID: "${{ inputs.full_release_validation_run_id }}",
      FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "${{ inputs.full_release_validation_run_attempt }}",
    });
    expect(npmRun.run).toContain(
      "actions/runs/${FULL_RELEASE_VALIDATION_RUN_ID}/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}",
    );
    expect(npmManifest.with).toMatchObject({
      name: "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ inputs.full_release_validation_run_attempt }}",
      "run-id": "${{ inputs.full_release_validation_run_id }}",
    });
  });

  it("keeps release publish artifacts and release-note ordering wired", () => {
    const resolveJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "resolve_release_target");
    const publishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const resolveFullRun = workflowStep(resolveJob, "Resolve full release validation run");
    const resolveDownload = workflowStep(resolveJob, "Download full release validation manifest");
    const trustedTooling = workflowStep(resolveJob, "Checkout trusted release validation tooling");
    const validateManifest = workflowStep(resolveJob, "Validate full release validation manifest");
    const publishDownload = workflowStep(publishJob, "Download full release validation manifest");
    const publishOrchestration = releasePublishOrchestration(publishJob);
    const npmPublishJob = workflowJob(OPENCLAW_NPM_RELEASE_WORKFLOW, "publish_openclaw_npm");
    const npmCheckout = workflowStep(npmPublishJob, "Checkout");
    const npmFullRun = workflowStep(npmPublishJob, "Verify full release validation evidence");
    const npmDownload = workflowStep(npmPublishJob, "Download full release validation manifest");
    const npmTarget = workflowStep(npmPublishJob, "Verify full release validation target");

    expect(resolveFullRun.id).toBe("full_run");
    expect(resolveFullRun.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ inputs.full_release_validation_run_attempt }}",
    );
    expect(resolveJob.outputs?.full_release_validation_run_attempt).toBe(
      "${{ steps.full_run.outputs.attempt }}",
    );
    expect(resolveDownload.with?.name).toBe(
      "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ steps.full_run.outputs.attempt }}",
    );
    expect(trustedTooling.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: ".release-validation-tooling",
      "persist-credentials": false,
      "sparse-checkout": "scripts",
    });
    expect(validateManifest.env).toMatchObject({
      RUN_JSON_FILE: "${{ runner.temp }}/full-release-validation-run.json",
      TRUSTED_WORKFLOW_FULL_REF: "${{ github.ref }}",
      TRUSTED_WORKFLOW_REF: "${{ github.ref_name }}",
      VALIDATOR_FILE:
        "${{ github.workspace }}/.release-validation-tooling/scripts/validate-full-release-validation-evidence.mjs",
      STRICT_VALIDATOR_FILE:
        "${{ github.workspace }}/.release-validation-tooling/scripts/release-ci-summary.mjs",
    });
    expect(validateManifest.run).toContain('MANIFEST_FILE="$manifest"');
    expect(validateManifest.run).toContain('node "$VALIDATOR_FILE" < "$RUN_JSON_FILE"');
    expect(publishDownload.with?.name).toBe(
      "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ needs.resolve_release_target.outputs.full_release_validation_run_attempt }}",
    );
    expect(publishOrchestration.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ needs.resolve_release_target.outputs.full_release_validation_run_attempt }}",
    );
    expect(publishOrchestration.run).toContain('"${target_sha}" != "${TARGET_SHA}"');
    expect(npmFullRun.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ inputs.full_release_validation_run_attempt }}",
    );
    expect(npmDownload.with?.name).toBe(
      "full-release-validation-${{ inputs.full_release_validation_run_id }}-${{ inputs.full_release_validation_run_attempt }}",
    );
    expect(npmTarget.env?.FULL_RELEASE_VALIDATION_RUN_ID).toBeUndefined();
    expect(npmTarget.run).not.toContain(
      "node scripts/openclaw-npm-extended-stable-release.mjs verify-manifest",
    );
    expect(npmCheckout.with?.["fetch-depth"]).toBe(
      "${{ inputs.release_evidence_mode == 'authorized-beta-focused-v1' && 0 || (inputs.preflight_run_id != '' && 1 || 0) }}",
    );

    const publishSteps = publishJob.steps ?? [];
    const setupIndex = publishSteps.findIndex((step) => step.name === "Setup Node environment");
    const notesIndex = publishSteps.findIndex(
      (step) => step.name === "Prepare GitHub release notes",
    );
    const dispatchIndex = publishSteps.findIndex(
      (step) => step.name === "Dispatch publish workflows",
    );
    expect(setupIndex).toBeGreaterThan(-1);
    expect(notesIndex).toBeGreaterThan(setupIndex);
    expect(publishSteps.some((step) => step.name === "Write Android release approval")).toBe(false);
    expect(workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish_android").needs).toContain("publish");
    expect(dispatchIndex).toBeGreaterThan(notesIndex);
    expect(publishSteps[notesIndex]?.if).toBe("${{ inputs.publish_openclaw_npm }}");

    const publishRun = publishOrchestration.run ?? "";
    const createReleaseIndex = publishRun.lastIndexOf("create_or_update_github_release");
    const verifyReleaseIndex = publishRun.lastIndexOf("verify_published_release");
    const appendProofIndex = publishRun.lastIndexOf("append_release_proof_to_github_release");
    const finalizeJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "finalize_github_release");
    const finalizeRelease = workflowStep(finalizeJob, "Publish the verified draft release");
    expect(createReleaseIndex).toBeGreaterThanOrEqual(0);
    expect(verifyReleaseIndex).toBeGreaterThan(createReleaseIndex);
    expect(appendProofIndex).toBeGreaterThan(verifyReleaseIndex);
    expect(finalizeJob.needs).toEqual(["publish", "publish_docker"]);
    expect(finalizeJob.if).toContain("needs.publish_docker.result == 'success'");
    expect(finalizeRelease.run).toContain('gh release edit "${RELEASE_TAG}"');
  });

  it("loads the strict release validator from the isolated trusted tooling bundle", () => {
    const root = tempDirs.make("release-validation-tooling-");
    mkdirSync(join(root, "lib", "cross-os-release-checks"), { recursive: true });
    for (const source of [
      "scripts/release-ci-summary.mjs",
      "scripts/full-release-validation-policy.mjs",
      "scripts/full-release-candidate-contract.mjs",
      "scripts/lib/canonical-json.mjs",
      "scripts/lib/cross-os-release-checks/suite-filter.mjs",
      "scripts/lib/plain-gh.mjs",
      "scripts/lib/release-context.mjs",
      "scripts/lib/release-version.mjs",
      "scripts/lib/record-shared.mjs",
      "scripts/lib/upgrade-survivor-policy.mjs",
    ]) {
      copyFileSync(source, join(root, source.replace(/^scripts\//u, "")));
    }
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(join(root, "release-ci-summary.mjs")).href)})`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    {
      name: "a separately versioned correction on its own branch",
      version: "2026.8.1-1",
      tag: "v2026.8.1-1",
      branch: "release/2026.8.1-1",
      accepted: true,
    },
    {
      name: "a same-source correction with only the base branch",
      version: "2026.8.1",
      tag: "v2026.8.1-1",
      branch: "release/2026.8.1",
      accepted: true,
    },
    {
      name: "a beta on its frozen release branch",
      version: "2026.8.1-beta.1",
      tag: "v2026.8.1-beta.1",
      branch: "release/2026.8.1",
      accepted: true,
    },
    {
      name: "a stable version on its frozen release branch",
      version: "2026.8.1",
      tag: "v2026.8.1",
      branch: "release/2026.8.1",
      accepted: true,
    },
    {
      name: "an alpha outside the workflow branch",
      version: "2026.8.1-alpha.1",
      tag: "v2026.8.1-alpha.1",
      branch: "release/2026.8.1",
      accepted: false,
    },
  ])("validates frozen npm release ancestry for $name", (scenario) => {
    const metadata = workflowStep(
      workflowJob(OPENCLAW_NPM_PREFLIGHT_WORKFLOW, "check_dependencies_npm"),
      "Validate release metadata",
    );
    const root = tempDirs.make("npm-preflight-release-ancestry-");
    const origin = join(root, "origin");
    const source = join(root, "source");
    mkdirSync(origin);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=openclaw-test@example.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd, encoding: "utf8" },
      ).trim();
    git(origin, "init", "-q", "--initial-branch=main");
    writeFileSync(join(origin, "package.json"), JSON.stringify({ version: "2026.8.1" }));
    git(origin, "add", "package.json");
    git(origin, "commit", "-qm", "main before release");
    git(origin, "switch", "-q", "-c", "release/2026.8.1");
    git(origin, "commit", "--allow-empty", "-qm", "frozen release");
    if (scenario.branch !== "release/2026.8.1") {
      git(origin, "switch", "-q", "-c", scenario.branch);
    }
    if (scenario.version !== "2026.8.1") {
      writeFileSync(join(origin, "package.json"), JSON.stringify({ version: scenario.version }));
      git(origin, "commit", "-qam", "versioned candidate");
    }
    git(origin, "tag", scenario.tag);
    if (scenario.version === "2026.8.1" && scenario.tag !== "v2026.8.1") {
      git(origin, "tag", "v2026.8.1");
    }
    git(origin, "switch", "-q", "main");
    git(origin, "commit", "--allow-empty", "-qm", "main advances independently");
    git(
      root,
      "clone",
      "-q",
      "--depth=1",
      "--branch",
      scenario.tag,
      pathToFileURL(origin).href,
      source,
    );
    const tooling = join(source, ".release-harness", "scripts", "lib");
    mkdirSync(tooling, { recursive: true });
    for (const name of ["release-context.mjs", "release-version.mjs"]) {
      copyFileSync(join(REPO_ROOT, "scripts", "lib", name), join(tooling, name));
    }
    const factsPath = join(root, "package-check-facts");
    // Use real shallow Git history; the package-check stand-in enforces the
    // same ancestry boundary without building or contacting a registry.
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          'timeout() { shift 3; "$@"; }',
          "pnpm() {",
          '  [[ "$*" == release:openclaw:npm:check ]]',
          '  printf "%s\\n" "$RELEASE_TAG" "$RELEASE_MAIN_REF" > "$PACKAGE_CHECK_FACTS"',
          '  git merge-base --is-ancestor "$RELEASE_SHA" "$RELEASE_MAIN_REF"',
          "}",
          metadata.run,
        ].join("\n"),
      ],
      {
        cwd: source,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: [dirname(process.execPath), process.env.PATH].join(":"),
          PACKAGE_CHECK_FACTS: factsPath,
          RELEASE_REF: scenario.tag,
          RELEASE_TAG: "",
          PREFLIGHT_ONLY: "true",
          WORKFLOW_REF_NAME: "main",
          OPENCLAW_NPM_PUBLISH_TAG: "beta",
          OPENCLAW_NPM_RELEASE_SKIP_PACK_CHECK: "1",
        },
      },
    );
    expect(result.status, result.stderr).toBe(scenario.accepted ? 0 : 1);
    if (scenario.accepted) {
      expect(readFileSync(factsPath, "utf8").trim().split("\n")).toEqual([
        scenario.tag,
        "refs/remotes/origin/" + scenario.branch,
      ]);
    } else {
      expect(result.stderr).toContain("Tagged commit is not reachable from main.");
      expect(existsSync(factsPath)).toBe(false);
    }
  });

  it("keeps optional Windows promotion downstream of published npm and GitHub releases", () => {
    const workflow = readWorkflow(RELEASE_PUBLISH_WORKFLOW);
    const publish = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const finalize = workflowJob(RELEASE_PUBLISH_WORKFLOW, "finalize_github_release");
    const windows = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish_windows");
    const dispatch = workflowStep(windows, "Dispatch detached Windows promotion");
    const child = workflowJob(WINDOWS_NODE_RELEASE_WORKFLOW, "promote_signed_windows_installers");

    for (const input of ["windows_node_tag", "windows_node_installer_digests"]) {
      expect(workflow.on?.workflow_dispatch?.inputs?.[input]).toMatchObject({ required: false });
    }
    expect(publish.needs).toEqual(["resolve_release_target"]);
    expect(finalize.needs).toEqual(["publish", "publish_docker"]);
    expect(windows.needs).toEqual(["resolve_release_target", "finalize_github_release"]);
    expect(windows["continue-on-error"]).toBe(true);
    expect(windows.if).toContain("needs.finalize_github_release.result == 'success'");
    expect(windows.if).toContain(
      "inputs.windows_node_tag != '' || inputs.windows_node_installer_digests != ''",
    );
    expect(dispatch.env).toMatchObject({
      WINDOWS_NODE_TAG: "${{ inputs.windows_node_tag }}",
      WINDOWS_NODE_INSTALLER_DIGESTS: "${{ inputs.windows_node_installer_digests }}",
      PARENT_WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(workflowStep(windows, "Record failed Windows dispatch").if).toBe("${{ failure() }}");
    expect(workflowStep(windows, "Upload Windows dispatch evidence").if).toBe("${{ always() }}");
    expect(workflowStep(child, "Record Windows promotion outcome").if).toBe("${{ always() }}");
    expect(workflowStep(child, "Upload Windows promotion evidence").if).toBe("${{ always() }}");
  });

  it.each([
    { scenario: "omitted", selected: false, hasDigests: false, dispatchFailure: false, exit: 0 },
    { scenario: "selected", selected: true, hasDigests: true, dispatchFailure: false, exit: 0 },
    {
      scenario: "dispatch failure",
      selected: true,
      hasDigests: true,
      dispatchFailure: true,
      exit: 1,
    },
    {
      scenario: "missing digests",
      selected: true,
      hasDigests: false,
      dispatchFailure: false,
      exit: 1,
    },
  ])(
    "dispatches optional Windows promotion without waiting: $scenario",
    ({ selected, hasDigests, dispatchFailure, exit }) => {
      const source = readFileSync("scripts/lib/release-publish-children.sh", "utf8");
      const root = tempDirs.make("windows-detached-publish-");
      const dispatchPath = join(root, "dispatch");
      const summaryPath = join(root, "summary");
      const workflowSha = "d".repeat(40);
      const workflowRef = `release-publish/${workflowSha.slice(0, 12)}-123`;
      const digests = JSON.stringify({
        "OpenClawCompanion-Setup-x64.exe": `sha256:${"a".repeat(64)}`,
        "OpenClawCompanion-Setup-arm64.exe": `sha256:${"b".repeat(64)}`,
      });
      writeFileSync(summaryPath, "");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
dispatch_workflow_at_ref() {
  printf '%s\\n' "$@" > "$DISPATCH_ARGS"
  ${dispatchFailure ? "return 1" : "echo 456"}
}
wait_for_run() { echo unexpected-windows-wait >&2; return 99; }
${shellFunctionSource(source, "is_stable_release")}
${shellFunctionSource(source, "dispatch_workflow")}
${shellFunctionSource(source, "promote_windows_release_assets")}
promote_windows_release_assets
`,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            DISPATCH_ARGS: dispatchPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            RELEASE_TAG: "v2026.9.1",
            CHILD_WORKFLOW_REF: workflowRef,
            PARENT_WORKFLOW_SHA: workflowSha,
            WINDOWS_NODE_TAG: selected ? "v0.6.3" : "",
            WINDOWS_NODE_INSTALLER_DIGESTS: hasDigests ? digests : "",
          },
        },
      );
      expect(result.status, result.stderr).toBe(exit);
      expect(result.stderr).not.toContain("unexpected-windows-wait");
      expect(existsSync(dispatchPath)).toBe(selected && hasDigests);
      if (selected && hasDigests) {
        expect(readFileSync(dispatchPath, "utf8").trim().split("\n")).toEqual([
          workflowRef,
          workflowSha,
          "windows-node-release.yml",
          "-f",
          "tag=v2026.9.1",
          "-f",
          "windows_node_tag=v0.6.3",
          "-f",
          `expected_installer_digests=${digests}`,
        ]);
      }
      expect(readFileSync(summaryPath, "utf8").includes("actions/runs/456")).toBe(
        selected && hasDigests && !dispatchFailure,
      );
    },
  );

  it("validates Windows signatures and pinned digests in the promotion owner", () => {
    const windowsWorkflow = readFileSync(WINDOWS_NODE_RELEASE_WORKFLOW, "utf8");
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
  });

  it("keeps the signed Android APK contract independent of core publication", () => {
    const releaseWorkflow = [
      readFileSync("scripts/lib/release-publish-children.sh", "utf8"),
      readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8"),
    ].join("\n");
    const androidWorkflow = readFileSync(ANDROID_RELEASE_WORKFLOW, "utf8");
    const androidDocs = readFileSync("docs/platforms/android.md", "utf8");
    const releaseDocs = readFileSync("docs/reference/RELEASING.md", "utf8");
    const approvalScript = readFileSync("scripts/validate-release-publish-approval.mjs", "utf8");
    const androidJob = workflowJob(ANDROID_RELEASE_WORKFLOW, "publish_signed_android_apk");
    const setupNode = workflowStep(androidJob, "Setup Node environment");
    const setupNodeAction = parse(
      readFileSync(".github/actions/setup-node-env/action.yml", "utf8"),
    );
    const androidSteps = androidJob.steps ?? [];

    expect(setupNode.uses).toBe("./.github/actions/setup-node-env");
    expect(setupNode.with?.["install-deps"] ?? setupNodeAction.inputs["install-deps"].default).toBe(
      "true",
    );
    expect(androidSteps.indexOf(setupNode)).toBeLessThan(
      androidSteps.indexOf(workflowStep(androidJob, "Create apps-signing read token")),
    );
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
    expect(androidWorkflow).toContain('--source-ref "${EXPECTED_WORKFLOW_FULL_REF}"');
    expect(androidWorkflow).toContain('--source-digest "${EXPECTED_WORKFLOW_SHA}"');
    expect(approvalScript).toContain(
      "Attested Android release approval does not match this run request.",
    );
    expect(androidWorkflow).toContain('--artifact", "third-party');
    expect(androidWorkflow).toContain("OpenClaw-Android.apk");
    expect(androidWorkflow).toContain("OpenClaw-Android-SHA256SUMS.txt");
    expect(androidWorkflow).toContain("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
    expect(androidWorkflow).toContain("--signer-workflow");
    expect(androidWorkflow).toContain('--source-ref "refs/tags/${RELEASE_TAG}"');
    expect(androidWorkflow).toContain("--deny-self-hosted-runners");
    expect(androidWorkflow).toContain("--verify-apk");
    expect(androidWorkflow).toContain('expected_source_ref="refs/tags/${RELEASE_TAG}"');
    expect(androidWorkflow).toContain("release_target_sha must be a full lowercase commit SHA");
    expect(approvalScript).toContain("no longer resolves to approved target");
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
    expect(approvalScript).toContain("tagName,isPrerelease,createdAt");
    expect(androidWorkflow).toContain(
      'build_timestamp="$(node scripts/validate-release-publish-approval.mjs)"',
    );
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

    expect(releaseWorkflow).toContain("finalize_github_release:");

    expect(androidDocs).toContain("github.com/openclaw/openclaw/releases");
    expect(androidDocs).not.toContain("releases/latest/download/OpenClaw-Android.apk");
    expect(androidDocs).toContain("gh attestation verify OpenClaw-Android.apk");
    expect(androidDocs).toContain('--source-ref "refs/tags/${release_tag}"');
    expect(releaseDocs).toContain("signed standalone Android APK");
  });

  it("rejects malformed Windows checksum manifest lines before using entries", () => {
    const verify =
      workflowStep(
        workflowJob(WINDOWS_NODE_RELEASE_WORKFLOW, "promote_signed_windows_installers"),
        "Verify promoted release asset contract",
      ).run ?? "";
    const validateIndex = verify.indexOf('throw "Invalid Windows SHA-256 manifest entry: $_"');
    const parseIndex = verify.indexOf("[PSCustomObject]@{");

    expect(validateIndex).toBeGreaterThan(-1);
    expect(parseIndex).toBeGreaterThan(validateIndex);
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

  it("publish requires the credentialed authorization path", () => {
    for (const [workflowPath, authorizationJobName, gatedJobName, expectedBranch] of [
      [
        PLUGIN_NPM_RELEASE_WORKFLOW,
        "validate_release_publish_approval",
        "publish_plugins_npm",
        "${{ inputs.release_publish_branch || github.ref_name }}",
      ],
      [
        PLUGIN_CLAWHUB_RELEASE_WORKFLOW,
        "validate_release_publish_approval",
        "pack_plugins_clawhub_artifacts",
        "${{ inputs.release_publish_branch || github.ref_name }}",
      ],
      [
        OPENCLAW_NPM_RELEASE_WORKFLOW,
        "validate_publish_request",
        "publish_openclaw_npm",
        "${{ inputs.release_publish_branch || github.ref_name }}",
      ],
      [
        ".github/workflows/plugin-clawhub-new.yml",
        "validate_release_publish_approval",
        "publish_bootstrap_plugins",
        "${{ inputs.release_publish_branch }}",
      ],
    ] as const) {
      const authorizationJob = workflowJob(workflowPath, authorizationJobName);
      const authorization = workflowStep(authorizationJob, "Validate release publish approval run");
      const gatedJob = workflowJob(workflowPath, gatedJobName);
      const needs = Array.isArray(gatedJob.needs) ? gatedJob.needs : [gatedJob.needs];
      expect(needs, workflowPath).toContain(authorizationJobName);
      expect(authorization.env, workflowPath).toMatchObject({
        EXPECTED_WORKFLOW_BRANCH: expectedBranch,
        RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
      });
      expectTextToIncludeAll(authorization.run, [
        '${GITHUB_ACTOR}" != "github-actions[bot]"',
        "validate-release-publish-approval.mjs",
      ]);
    }

    for (const workflowPath of [PLUGIN_NPM_RELEASE_WORKFLOW, OPENCLAW_NPM_RELEASE_WORKFLOW]) {
      const authorization = workflowStep(
        workflowJob(
          workflowPath,
          workflowPath === PLUGIN_NPM_RELEASE_WORKFLOW
            ? "validate_release_publish_approval"
            : "validate_publish_request",
        ),
        "Validate release publish approval run",
      );
      expectTextToIncludeAll(authorization.run, [
        'export EXPECTED_WORKFLOW_FULL_REF="refs/tags/${EXPECTED_WORKFLOW_BRANCH}"',
        'export EXPECTED_WORKFLOW_FULL_REF="refs/heads/${EXPECTED_WORKFLOW_BRANCH}"',
      ]);
      expect(
        readWorkflow(workflowPath).on?.workflow_dispatch?.inputs?.release_publish_branch,
      ).toBeDefined();
      expect(
        readWorkflow(workflowPath).on?.workflow_dispatch?.inputs?.release_publish_full_ref,
      ).toBeDefined();
    }

    for (const [workflowPath, publishJobName, environment] of [
      [PLUGIN_NPM_RELEASE_WORKFLOW, "publish_plugins_npm", "npm-release"],
      [OPENCLAW_NPM_RELEASE_WORKFLOW, "publish_openclaw_npm", "npm-release"],
      [
        ".github/workflows/plugin-clawhub-new.yml",
        "publish_bootstrap_plugins",
        "clawhub-plugin-bootstrap",
      ],
    ] as const) {
      expect(workflowJob(workflowPath, publishJobName).environment, workflowPath).toBe(environment);
    }

    const clawHubApproval = workflowJob(
      PLUGIN_CLAWHUB_RELEASE_WORKFLOW,
      "approve_plugins_clawhub_release",
    );
    const clawHubAuthorization = workflowStep(
      workflowJob(PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "validate_release_publish_approval"),
      "Validate release publish approval run",
    );
    const clawHubPublish = workflowJob(PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "publish_plugins_clawhub");
    expect(clawHubAuthorization.run).toContain("repository: .repository.full_name");
    expect(clawHubAuthorization.run).toContain(
      "actions/runs/${RELEASE_PUBLISH_RUN_ID}/attempts/${EXPECTED_RUN_ATTEMPT}",
    );
    expect(clawHubAuthorization.run).toContain("path,");
    expect(clawHubAuthorization.run).toContain("runAttempt: .run_attempt");
    expect(clawHubAuthorization.run).not.toContain("gh run view");
    expect(clawHubAuthorization.env).toMatchObject({
      EXPECTED_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      EXPECTED_WORKFLOW_FULL_REF: "${{ inputs.release_publish_full_ref }}",
      EXPECTED_WORKFLOW_SHA: "${{ inputs.release_publish_workflow_sha }}",
    });
    const clawHubInputs = readWorkflow(PLUGIN_CLAWHUB_RELEASE_WORKFLOW).on?.workflow_dispatch
      ?.inputs;
    expect(clawHubInputs?.release_tag).toBeDefined();
    expect(clawHubInputs?.release_publish_run_attempt).toBeDefined();
    expect(clawHubInputs?.release_publish_full_ref).toBeDefined();
    expect(clawHubInputs?.release_publish_workflow_sha).toBeDefined();
    expect(clawHubApproval.environment).toBe("clawhub-plugin-release");
    expect(clawHubPublish.needs).toContain("approve_plugins_clawhub_release");

    const bootstrapWorkflow = ".github/workflows/plugin-clawhub-new.yml";
    const authorizationJob = workflowJob(bootstrapWorkflow, "validate_release_publish_approval");
    const approvalDownload = workflowStep(
      authorizationJob,
      "Download parent ClawHub bootstrap approval",
    );
    const authorization = workflowStep(authorizationJob, "Validate release publish approval run");

    expect(authorizationJob.permissions).toMatchObject({
      actions: "read",
      attestations: "read",
      contents: "read",
    });
    expect(approvalDownload.with).toMatchObject({
      name: "clawhub-bootstrap-approval-${{ inputs.release_publish_run_id }}-${{ inputs.release_publish_run_attempt }}",
      "run-id": "${{ inputs.release_publish_run_id }}",
    });
    expect(authorization.env).toMatchObject({
      APPROVAL_PATH: "${{ runner.temp }}/clawhub-bootstrap-approval/approval.json",
      CHILD_WORKFLOW_SHA: "${{ github.sha }}",
      EXPECTED_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      EXPECTED_WORKFLOW_BRANCH: "${{ inputs.release_publish_branch }}",
      RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
      RELEASE_TARGET_SHA: "${{ needs.resolve_bootstrap_plan.outputs.ref_revision }}",
    });
    expectTextToIncludeAll(authorization.run, [
      '${GITHUB_ACTOR}" != "github-actions[bot]"',
      "actions/runs/${RELEASE_PUBLISH_RUN_ID}/attempts/${EXPECTED_RUN_ATTEMPT}",
      "repository: .repository.full_name",
      '--source-ref "${EXPECTED_WORKFLOW_REF}"',
      '--source-digest "${EXPECTED_WORKFLOW_SHA}"',
      "validate-release-publish-approval.mjs",
    ]);
  });

  it("keeps release publication ownership and artifact boundaries wired", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const releasePublishJob = workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish");
    const releaseSteps = releasePublishJob.steps ?? [];
    const clawHubApproval = workflowJob(
      PLUGIN_CLAWHUB_RELEASE_WORKFLOW,
      "approve_plugins_clawhub_release",
    );
    const clawHubPublish = workflowJob(PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "publish_plugins_clawhub");
    const clawHubBootstrapValidation = workflowJob(
      ".github/workflows/plugin-clawhub-new.yml",
      "validate_bootstrap_artifact",
    );
    const clawHubBootstrapPublish = workflowJob(
      ".github/workflows/plugin-clawhub-new.yml",
      "publish_bootstrap_plugins",
    );
    const postpublishEvidence = workflowStep(releasePublishJob, "Upload postpublish evidence");

    expect(packageJson.scripts).toMatchObject({
      "release:verify-beta": "node --import ./scripts/tsx.mjs scripts/release-verify-beta.ts",
      "release:candidate":
        "node --import ./scripts/tsx.mjs scripts/release-candidate-checklist.mts",
      "release:beta": "node --import ./scripts/tsx.mjs scripts/release-candidate-checklist.mts",
      "release:fast-pretag-check": "bash scripts/release-fast-pretag-check.sh",
    });
    expect(workflowStep(releasePublishJob, "Setup Node environment").with).toMatchObject({
      "install-bun": "false",
      "install-deps": "false",
    });
    expect(workflowStep(releasePublishJob, "Checkout trusted release tooling")).toBeDefined();
    expect(
      workflowStep(releasePublishJob, "Install trusted release tooling dependencies"),
    ).toBeDefined();
    expect(workflowStep(releasePublishJob, "Resolve ClawHub release plan")).toBeDefined();
    expect(releasePublishOrchestration(releasePublishJob)).toBeDefined();

    const dispatchIndexForReceipt = releaseSteps.findIndex(
      (step) => step.name === "Dispatch publish workflows",
    );
    const authorizeIndex = releaseSteps.findIndex(
      (step) => step.name === "Authorize exact ClawHub package transactions",
    );
    const receiptIndex = releaseSteps.findIndex(
      (step) => step.name === "Upload immutable ClawHub parent authorization",
    );
    const completionIndex = releaseSteps.findIndex(
      (step) => step.name === "Complete publish workflows",
    );
    expect(authorizeIndex).toBeGreaterThan(dispatchIndexForReceipt);
    expect(receiptIndex).toBeGreaterThan(authorizeIndex);
    expect(completionIndex).toBeGreaterThan(receiptIndex);
    expect(
      workflowStep(releasePublishJob, "Upload immutable ClawHub parent authorization").with?.[
        "if-no-files-found"
      ],
    ).toBe("error");
    expect(
      workflowJob(PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "seal_clawhub_transactions").needs,
    ).toContain("pack_plugins_clawhub_artifacts");
    expect(clawHubApproval.needs).toContain("seal_clawhub_transactions");
    expect(
      readWorkflow(PLUGIN_CLAWHUB_RELEASE_WORKFLOW).jobs?.verify_published_clawhub_package,
    ).toBeUndefined();
    expect(clawHubApproval.environment).toBe("clawhub-plugin-release");
    expect(clawHubPublish.needs).toEqual([
      "preview_plugins_clawhub",
      "pack_plugins_clawhub_artifacts",
      "seal_clawhub_transactions",
      "approve_plugins_clawhub_release",
    ]);
    expect(clawHubPublish.uses).toBe(
      "openclaw/clawhub/.github/workflows/package-publish.yml@d118f17fd366e5cdc3ad9c8abcea51941b97636f",
    );
    expect(clawHubPublish.permissions).toMatchObject({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(clawHubPublish.with?.trusted_tooling_identity_json).toBe(
      "${{ needs.seal_clawhub_transactions.outputs.identity }}",
    );
    expect(clawHubPublish.with?.wait_for_publication).toBe(false);
    const clawHubPreview = workflowJob(PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "preview_plugins_clawhub");
    expect(
      readWorkflow(PLUGIN_CLAWHUB_RELEASE_WORKFLOW).on?.workflow_dispatch?.inputs
        ?.release_publish_run_attempt,
    ).toBeDefined();
    expect(
      readWorkflow(PLUGIN_CLAWHUB_RELEASE_WORKFLOW).on?.workflow_dispatch?.inputs
        ?.release_publish_full_ref,
    ).toBeDefined();
    expect(
      readWorkflow(PLUGIN_CLAWHUB_RELEASE_WORKFLOW).on?.workflow_dispatch?.inputs
        ?.release_publish_workflow_sha,
    ).toBeDefined();
    expect(clawHubPreview.outputs?.trusted_tooling_identity_json).toBeUndefined();
    const publishOrchestration = releasePublishOrchestration(releasePublishJob);
    expect(publishOrchestration.env?.PARENT_WORKFLOW_FULL_REF).toBe("${{ github.ref }}");
    expect(publishOrchestration.run).toContain(
      'wait_for_run_background plugin-clawhub-release.yml "${plugin_clawhub_run_id}" "${PARENT_WORKFLOW_SHA}"',
    );
    expect(publishOrchestration.run).toContain("release_publish_full_ref");
    expect(clawHubBootstrapValidation.environment).toBe("clawhub-plugin-bootstrap");
    expect(clawHubBootstrapPublish.environment).toBe("clawhub-plugin-bootstrap");

    const bootstrapSteps = clawHubBootstrapPublish.steps ?? [];
    const bootstrapDownload = workflowStep(
      clawHubBootstrapPublish,
      "Download and verify immutable ClawHub bootstrap artifact",
    );
    const bootstrapRehash = workflowStep(
      clawHubBootstrapPublish,
      "Rehash immutable ClawHub bootstrap artifacts",
    );
    const bootstrapRegistry = workflowStep(
      clawHubBootstrapPublish,
      "Reconfirm configure-only registry bytes before credentials",
    );
    const bootstrapTag = workflowStep(
      clawHubBootstrapPublish,
      "Reconfirm release tag before credentials",
    );
    const bootstrapCredentials = workflowStep(
      clawHubBootstrapPublish,
      "Write ClawHub token config",
    );
    expect(bootstrapDownload.run).toContain("clawhub-bootstrap-artifact.mjs download");
    expect(bootstrapDownload.run).toContain('--target-sha "${TARGET_SHA}"');
    expect(bootstrapDownload.run).toContain('--workflow-sha "${WORKFLOW_SHA}"');
    expect(bootstrapTag.run).toContain('rev-parse "${RELEASE_TAG}^{commit}"');
    expect(bootstrapSteps.indexOf(bootstrapDownload)).toBeLessThan(
      bootstrapSteps.indexOf(bootstrapRehash),
    );
    expect(bootstrapSteps.indexOf(bootstrapRehash)).toBeLessThan(
      bootstrapSteps.indexOf(bootstrapRegistry),
    );
    expect(bootstrapSteps.indexOf(bootstrapRegistry)).toBeLessThan(
      bootstrapSteps.indexOf(bootstrapTag),
    );
    expect(bootstrapSteps.indexOf(bootstrapTag)).toBeLessThan(
      bootstrapSteps.indexOf(bootstrapCredentials),
    );

    expect(postpublishEvidence.if).toContain("always()");
    expect(postpublishEvidence.if).toContain("inputs.publish_openclaw_npm");
    expect(postpublishEvidence.with).toMatchObject({
      "if-no-files-found": "error",
      name: "openclaw-release-postpublish-evidence-${{ inputs.tag }}",
      path: "${{ runner.temp }}/openclaw-release-postpublish-evidence",
    });
    expect(postpublishEvidence.uses).toBe(UPLOAD_ARTIFACT_V7);

    const notesIndex = releaseSteps.findIndex(
      (step) => step.name === "Prepare GitHub release notes",
    );
    const dispatchIndex = releaseSteps.findIndex(
      (step) => step.name === "Dispatch publish workflows",
    );
    const evidenceIndex = releaseSteps.findIndex(
      (step) => step.name === "Upload postpublish evidence",
    );
    expect(notesIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(notesIndex);
    expect(evidenceIndex).toBeGreaterThan(dispatchIndex);

    const clawHubReleaseSource = readFileSync(PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "utf8");
    const clawHubBootstrapSource = readFileSync(".github/workflows/plugin-clawhub-new.yml", "utf8");
    expect(clawHubReleaseSource).not.toContain("secrets.CLAWHUB_TOKEN");
    expect(clawHubReleaseSource).not.toContain("clawhub_token:");
    expect(clawHubBootstrapSource).toContain("secrets.CLAWHUB_TOKEN");
  });

  it("bounds the npm registry tarball download used for release resume", () => {
    const publishRun =
      releasePublishOrchestration(workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish")).run ?? "";
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
      releasePublishOrchestration(workflowJob(RELEASE_PUBLISH_WORKFLOW, "publish")).run ?? "";
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

  it("keeps release workflow setup aligned", () => {
    const releaseChecks = readWorkflow(RELEASE_CHECKS_WORKFLOW);
    const installSmoke = readWorkflow(INSTALL_SMOKE_REUSABLE_WORKFLOW);
    const crossOs = readWorkflow(CROSS_OS_RELEASE_CHECKS_REUSABLE_WORKFLOW);
    const liveE2e = readWorkflow(LIVE_E2E_WORKFLOW);
    const qaLive = readWorkflow(QA_LIVE_TRANSPORTS_WORKFLOW);
    const releaseWorkflowPaths = [
      FULL_RELEASE_VALIDATION_WORKFLOW,
      RELEASE_CHECKS_WORKFLOW,
      RELEASE_TELEGRAM_QA_WORKFLOW,
      CROSS_OS_RELEASE_CHECKS_REUSABLE_WORKFLOW,
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
      expect(workflow.env?.NODE_VERSION, workflowPath).toBe("24.19.0");
      expect(workflow.env?.PNPM_VERSION, workflowPath).toBeUndefined();
    }

    expect(releaseChecks.jobs?.prepare_release_package?.["timeout-minutes"]).toBe(15);
    expect(
      workflowStep(
        workflowJob(RELEASE_CHECKS_WORKFLOW, "prepare_release_package"),
        "Setup Node environment",
      ).with?.["install-deps"],
    ).toBe("true");
    expect(installSmoke.jobs?.preflight?.["timeout-minutes"]).toBe(15);
    expect(installSmoke.jobs?.["install-smoke-fast"]?.["timeout-minutes"]).toBe(120);
    expect(installSmoke.jobs?.root_dockerfile_image?.["timeout-minutes"]).toBe(60);
    expect(installSmoke.jobs?.root_dockerfile_image_ready?.["timeout-minutes"]).toBe(5);
    expect(installSmoke.jobs?.qr_package_install_smoke?.["timeout-minutes"]).toBe(30);
    expect(installSmoke.jobs?.root_dockerfile_smokes?.["timeout-minutes"]).toBe(90);
    expect(installSmoke.jobs?.installer_smoke_update_image?.["timeout-minutes"]).toBe(45);
    expect(installSmoke.jobs?.installer_smoke_nonroot_image?.["timeout-minutes"]).toBe(45);
    expect(installSmoke.jobs?.installer_smoke_update?.["timeout-minutes"]).toBe(120);
    expect(installSmoke.jobs?.installer_smoke_nonroot?.["timeout-minutes"]).toBe(60);
    expect(installSmoke.jobs?.installer_smoke?.["timeout-minutes"]).toBe(5);
    expect(installSmoke.jobs?.bun_global_install_smoke?.["timeout-minutes"]).toBe(60);
    expect(installSmoke.jobs?.["docker-e2e-fast"]?.["timeout-minutes"]).toBe(12);
    expect(crossOs.jobs?.prepare?.["timeout-minutes"]).toBe(90);
    expect(crossOs.jobs?.cross_os_release_checks?.["timeout-minutes"]).toBe(60);
    expect(qaLive.jobs?.authorize_actor?.["timeout-minutes"]).toBe(10);
    expect(qaLive.jobs?.validate_selected_ref?.["timeout-minutes"]).toBe(30);
    expect(liveE2e.jobs?.validate_live_suite_filter?.["timeout-minutes"]).toBe(10);
    expect(liveE2e.jobs?.plan_release_workflow_matrices?.["timeout-minutes"]).toBe(10);
    expect(liveE2e.jobs?.validate_release_live_cache?.["timeout-minutes"]).toBe(20);
    expect(readFileSync(LIVE_E2E_WORKFLOW, "utf8")).toContain(
      "timeout --foreground --kill-after=30s 8m pnpm test:live:cache",
    );
    expect(readFileSync(LIVE_E2E_WORKFLOW, "utf8")).toContain("live-cache attempt ${attempt}/2");
  });

  it("keeps known bounded dominant child paths below the centralized drain owner", () => {
    const fullRelease = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const fullReleaseCandidate = readWorkflow(FULL_RELEASE_CANDIDATE_WORKFLOW);
    const pluginPrerelease = readWorkflow(PLUGIN_PRERELEASE_WORKFLOW);
    const liveE2e = readWorkflow(LIVE_E2E_WORKFLOW);
    const releaseChecks = readWorkflow(RELEASE_CHECKS_WORKFLOW);
    const installSmoke = readWorkflow(INSTALL_SMOKE_REUSABLE_WORKFLOW);
    const crossOs = readWorkflow(CROSS_OS_RELEASE_CHECKS_REUSABLE_WORKFLOW);
    const packageAcceptance = readWorkflow(PACKAGE_ACCEPTANCE_WORKFLOW);
    const qaLive = readWorkflow(QA_LIVE_TRANSPORTS_WORKFLOW);
    const profiles = ["beta", "stable", "full"] as const;
    const releaseDecisionTimeout = timeoutForProfile(
      fullRelease.jobs?.release_decision?.["timeout-minutes"],
      "beta",
    );
    const diagnosticDrainTimeout = timeoutForProfile(
      fullRelease.jobs?.diagnostic_drain?.["timeout-minutes"],
      "beta",
    );
    expect(releaseDecisionTimeout).toBe(720);
    expect(diagnosticDrainTimeout).toBe(720);
    for (const dispatchJob of [
      "normal_ci",
      "plugin_prerelease_independent",
      "plugin_prerelease_candidate",
      "release_checks_independent",
      "release_checks_candidate",
      "npm_telegram",
      "performance",
    ]) {
      expect(fullRelease.jobs?.[dispatchJob]?.["timeout-minutes"], dispatchJob).toBe(15);
    }

    const ciPreflight = workflowJob(CI_WORKFLOW, "preflight");
    const ciIos = workflowJob(CI_WORKFLOW, "ios-build");
    const ciGate = workflowJob(CI_WORKFLOW, "ci-gate");
    expect(jobNeeds(ciIos)).toEqual(["preflight"]);
    expect(jobNeeds(ciGate)).toEqual(expect.arrayContaining(["preflight", "ios-build"]));
    const ciPath = [
      timeoutForProfile(ciPreflight["timeout-minutes"], "beta"),
      timeoutForProfile(ciIos["timeout-minutes"], "beta"),
      timeoutForProfile(ciGate["timeout-minutes"], "beta"),
    ];
    expect(ciPath).toEqual([20, 150, 5]);
    const ciChildTimeout = ciPath.reduce((total, timeout) => total + timeout, 0);
    expect(ciChildTimeout).toBe(175);
    expect(ciChildTimeout).toBeLessThanOrEqual(diagnosticDrainTimeout);
    expect(diagnosticDrainTimeout - ciChildTimeout).toBeGreaterThanOrEqual(60);

    expect(liveE2e.jobs?.validate_selected_ref?.["timeout-minutes"]).toBe(30);
    const pluginChildTimeouts = Object.fromEntries(
      profiles.map((profile) => [
        profile,
        pluginPrereleaseTimeoutFloor(pluginPrerelease, liveE2e, profile),
      ]),
    ) as Record<(typeof profiles)[number], number>;
    expect(pluginChildTimeouts).toEqual({ beta: 170, stable: 170, full: 200 });
    for (const profile of profiles) {
      expect(
        diagnosticDrainTimeout - pluginChildTimeouts[profile],
        `plugin-prerelease:${profile}`,
      ).toBeGreaterThanOrEqual(60);
    }

    const releasePackageJob = workflowJob(
      RELEASE_CHECKS_WORKFLOW,
      "package_acceptance_release_checks",
    );
    expect(jobNeeds(workflowJob(RELEASE_CHECKS_WORKFLOW, "prepare_release_package"))).toEqual([
      "resolve_target",
    ]);
    expect(jobNeeds(releasePackageJob)).toEqual(["resolve_target", "prepare_release_package"]);
    expect(jobNeeds(workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "package_integrity"))).toEqual([
      "resolve_package",
    ]);
    expect(jobNeeds(workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "docker_acceptance"))).toEqual([
      "resolve_package",
      "package_integrity",
    ]);
    expect(jobNeeds(workflowJob(LIVE_E2E_WORKFLOW, "prepare_docker_e2e_image"))).toEqual([
      "validate_selected_ref",
    ]);
    expect(jobNeeds(workflowJob(LIVE_E2E_WORKFLOW, "validate_docker_lanes"))).toEqual(
      expect.arrayContaining(["validate_selected_ref", "prepare_docker_e2e_image"]),
    );
    expect(jobNeeds(workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "summary"))).toContain(
      "docker_acceptance",
    );
    expect(jobNeeds(workflowJob(PACKAGE_ACCEPTANCE_WORKFLOW, "summary"))).toContain(
      "npm_12_install_sh",
    );
    expect(jobNeeds(workflowJob(RELEASE_CHECKS_WORKFLOW, "summary"))).toContain(
      "package_acceptance_release_checks",
    );
    const releasePackagePaths = Object.fromEntries(
      profiles.map((profile) => [
        profile,
        [
          timeoutForProfile(releaseChecks.jobs?.resolve_target?.["timeout-minutes"], profile),
          timeoutForProfile(
            releaseChecks.jobs?.prepare_release_package?.["timeout-minutes"],
            profile,
          ),
          timeoutForProfile(packageAcceptance.jobs?.resolve_package?.["timeout-minutes"], profile),
          timeoutForProfile(
            packageAcceptance.jobs?.package_integrity?.["timeout-minutes"],
            profile,
          ),
          timeoutForProfile(liveE2e.jobs?.validate_selected_ref?.["timeout-minutes"], profile),
          timeoutForProfile(liveE2e.jobs?.prepare_docker_e2e_image?.["timeout-minutes"], profile),
          Math.max(
            ...evaluatedJobTimeouts(
              LIVE_E2E_WORKFLOW,
              "validate_docker_lanes",
              workflowJob(LIVE_E2E_WORKFLOW, "validate_docker_lanes"),
            ),
          ),
          timeoutForProfile(packageAcceptance.jobs?.summary?.["timeout-minutes"], profile),
          timeoutForProfile(releaseChecks.jobs?.summary?.["timeout-minutes"], profile),
        ],
      ]),
    ) as Record<(typeof profiles)[number], number[]>;
    expect(releasePackagePaths).toEqual({
      beta: [30, 15, 60, 10, 30, 60, 90, 5, 5],
      stable: [30, 15, 60, 10, 30, 60, 90, 5, 5],
      full: [30, 15, 60, 10, 30, 90, 90, 5, 5],
    });
    const releaseChecksParent = workflowJob(
      FULL_RELEASE_VALIDATION_WORKFLOW,
      "release_checks_candidate",
    );
    expect(releaseChecksParent["timeout-minutes"]).toBe(15);
    const releasePackageTimeouts = {
      beta: releasePackagePaths.beta.reduce((total, timeout) => total + timeout, 0),
      stable: releasePackagePaths.stable.reduce((total, timeout) => total + timeout, 0),
      full: releasePackagePaths.full.reduce((total, timeout) => total + timeout, 0),
    };
    expect(releasePackageTimeouts).toEqual({ beta: 305, stable: 305, full: 335 });
    for (const [profile, childTimeout] of Object.entries(releasePackageTimeouts)) {
      expect(childTimeout, `release-package:${profile}`).toBeLessThanOrEqual(
        diagnosticDrainTimeout,
      );
      expect(
        diagnosticDrainTimeout - childTimeout,
        `release-package:${profile}`,
      ).toBeGreaterThanOrEqual(60);
    }

    const releaseSummary = workflowJob(RELEASE_CHECKS_WORKFLOW, "summary");
    const releaseCrossOs = workflowJob(RELEASE_CHECKS_WORKFLOW, "cross_os_release_checks");
    expect(jobNeeds(releaseCrossOs)).toEqual(["resolve_target", "prepare_release_package"]);
    expect(jobNeeds(workflowJob(CROSS_OS_RELEASE_CHECKS_REUSABLE_WORKFLOW, "prepare"))).toEqual([]);
    expect(
      jobNeeds(workflowJob(CROSS_OS_RELEASE_CHECKS_REUSABLE_WORKFLOW, "cross_os_release_checks")),
    ).toEqual(["prepare"]);
    expect(jobNeeds(releaseSummary)).toContain("cross_os_release_checks");
    const releaseCrossOsPath = [
      timeoutForProfile(releaseChecks.jobs?.resolve_target?.["timeout-minutes"], "stable"),
      timeoutForProfile(releaseChecks.jobs?.prepare_release_package?.["timeout-minutes"], "stable"),
      timeoutForProfile(crossOs.jobs?.prepare?.["timeout-minutes"], "stable"),
      timeoutForProfile(crossOs.jobs?.cross_os_release_checks?.["timeout-minutes"], "stable"),
      timeoutForProfile(releaseChecks.jobs?.summary?.["timeout-minutes"], "stable"),
    ];
    expect(releaseCrossOsPath).toEqual([30, 15, 90, 60, 5]);

    const releaseInstall = workflowJob(RELEASE_CHECKS_WORKFLOW, "install_smoke_release_checks");
    expect(jobNeeds(releaseInstall)).toEqual(["resolve_target"]);
    expect(jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "root_dockerfile_image"))).toEqual(
      ["preflight"],
    );
    expect(
      jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "root_dockerfile_image_ready")),
    ).toEqual(["preflight", "root_dockerfile_image"]);
    expect(
      jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "installer_smoke_candidate_payload")),
    ).toEqual(["preflight"]);
    expect(
      jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "installer_smoke_update_image")),
    ).toEqual(["preflight"]);
    expect(
      jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "installer_smoke_nonroot_image")),
    ).toEqual(["preflight"]);
    expect(
      jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "installer_smoke_update")),
    ).toEqual(["preflight", "installer_smoke_candidate_payload", "installer_smoke_update_image"]);
    expect(
      jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "installer_smoke_nonroot")),
    ).toEqual(["preflight", "installer_smoke_candidate_payload", "installer_smoke_nonroot_image"]);
    expect(jobNeeds(workflowJob(INSTALL_SMOKE_REUSABLE_WORKFLOW, "installer_smoke"))).toEqual([
      "preflight",
      "root_dockerfile_image",
      "root_dockerfile_image_ready",
      "installer_smoke_candidate_payload",
      "installer_smoke_update_image",
      "installer_smoke_update",
      "installer_smoke_nonroot_image",
      "installer_smoke_nonroot",
    ]);
    expect(jobNeeds(releaseSummary)).toContain("install_smoke_release_checks");
    const releaseInstallPath = [
      timeoutForProfile(releaseChecks.jobs?.resolve_target?.["timeout-minutes"], "stable"),
      timeoutForProfile(installSmoke.jobs?.preflight?.["timeout-minutes"], "stable"),
      Math.max(
        timeoutForProfile(
          installSmoke.jobs?.installer_smoke_candidate_payload?.["timeout-minutes"],
          "stable",
        ),
        timeoutForProfile(
          installSmoke.jobs?.installer_smoke_update_image?.["timeout-minutes"],
          "stable",
        ),
      ),
      timeoutForProfile(installSmoke.jobs?.installer_smoke_update?.["timeout-minutes"], "stable"),
      timeoutForProfile(installSmoke.jobs?.installer_smoke?.["timeout-minutes"], "stable"),
      timeoutForProfile(releaseChecks.jobs?.summary?.["timeout-minutes"], "stable"),
    ];
    expect(releaseInstallPath).toEqual([30, 15, 75, 120, 5, 5]);
    const releaseInstallNonrootPath = [
      timeoutForProfile(releaseChecks.jobs?.resolve_target?.["timeout-minutes"], "stable"),
      timeoutForProfile(installSmoke.jobs?.preflight?.["timeout-minutes"], "stable"),
      Math.max(
        timeoutForProfile(
          installSmoke.jobs?.installer_smoke_candidate_payload?.["timeout-minutes"],
          "stable",
        ),
        timeoutForProfile(
          installSmoke.jobs?.installer_smoke_nonroot_image?.["timeout-minutes"],
          "stable",
        ),
      ),
      timeoutForProfile(installSmoke.jobs?.installer_smoke_nonroot?.["timeout-minutes"], "stable"),
      timeoutForProfile(installSmoke.jobs?.installer_smoke?.["timeout-minutes"], "stable"),
      timeoutForProfile(releaseChecks.jobs?.summary?.["timeout-minutes"], "stable"),
    ];
    expect(releaseInstallNonrootPath).toEqual([30, 15, 75, 60, 5, 5]);

    const releaseQaLive = workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_live_release_checks");
    expect(jobNeeds(releaseQaLive)).toEqual(["resolve_target"]);
    expect(jobNeeds(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "validate_selected_ref"))).toEqual([
      "authorize_actor",
    ]);
    expect(jobNeeds(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_matrix"))).toEqual([
      "authorize_actor",
      "validate_selected_ref",
    ]);
    expect(jobNeeds(releaseSummary)).toContain("qa_live_release_checks");
    const releaseQaLivePath = [
      timeoutForProfile(releaseChecks.jobs?.resolve_target?.["timeout-minutes"], "stable"),
      timeoutForProfile(qaLive.jobs?.authorize_actor?.["timeout-minutes"], "stable"),
      timeoutForProfile(qaLive.jobs?.validate_selected_ref?.["timeout-minutes"], "stable"),
      timeoutForProfile(qaLive.jobs?.run_live_matrix?.["timeout-minutes"], "stable"),
      timeoutForProfile(releaseChecks.jobs?.summary?.["timeout-minutes"], "stable"),
    ];
    expect(releaseQaLivePath).toEqual([30, 10, 30, 90, 5]);

    for (const [pathName, path] of [
      ["cross-os", releaseCrossOsPath],
      ["install", releaseInstallPath],
      ["qa-live", releaseQaLivePath],
    ] as const) {
      const childTimeout = path.reduce((total, timeout) => total + timeout, 0);
      expect(childTimeout, `release-checks:${pathName}`).toBeLessThanOrEqual(
        diagnosticDrainTimeout,
      );
      expect(
        diagnosticDrainTimeout - childTimeout,
        `release-checks:${pathName}`,
      ).toBeGreaterThanOrEqual(60);
    }
    expect(releaseCrossOsPath.reduce((total, timeout) => total + timeout, 0)).toBe(200);
    expect(releaseInstallPath.reduce((total, timeout) => total + timeout, 0)).toBe(250);
    expect(releaseInstallNonrootPath.reduce((total, timeout) => total + timeout, 0)).toBe(190);
    expect(releaseQaLivePath.reduce((total, timeout) => total + timeout, 0)).toBe(165);

    expect(
      jobNeeds(workflowJob(RELEASE_CHECKS_WORKFLOW, "qa_live_telegram_release_checks")),
    ).toEqual(["resolve_target"]);
    expect(jobNeeds(workflowJob(RELEASE_CHECKS_WORKFLOW, "summary"))).toContain(
      "qa_live_telegram_release_checks",
    );
    const releaseTelegramPath = [
      timeoutForProfile(releaseChecks.jobs?.resolve_target?.["timeout-minutes"], "beta"),
      timeoutForProfile(
        releaseChecks.jobs?.qa_live_telegram_release_checks?.["timeout-minutes"],
        "beta",
      ),
      timeoutForProfile(releaseChecks.jobs?.summary?.["timeout-minutes"], "beta"),
    ];
    expect(releaseTelegramPath).toEqual([30, 210, 5]);
    const releaseTelegramTimeout = releaseTelegramPath.reduce(
      (total, timeout) => total + timeout,
      0,
    );
    expect(releaseTelegramTimeout).toBe(245);
    expect(diagnosticDrainTimeout - releaseTelegramTimeout).toBeGreaterThanOrEqual(60);

    const npmTelegramChildTimeout = timeoutForProfile(
      workflowJob(NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e")["timeout-minutes"],
      "beta",
    );
    expect(npmTelegramChildTimeout).toBe(60);
    expect(diagnosticDrainTimeout - npmTelegramChildTimeout).toBeGreaterThanOrEqual(60);

    const performanceResolve = workflowJob(PERFORMANCE_WORKFLOW, "resolve_target");
    const performanceKova = workflowJob(PERFORMANCE_WORKFLOW, "kova");
    const performanceSource = workflowJob(PERFORMANCE_WORKFLOW, "source_performance");
    const performancePublish = workflowJob(PERFORMANCE_WORKFLOW, "publish");
    const performanceArtifactGuard = workflowJob(PERFORMANCE_WORKFLOW, "artifact_only_guard");
    expect(jobNeeds(performanceKova)).toEqual(["resolve_target"]);
    expect(jobNeeds(performanceSource)).toEqual(["resolve_target"]);
    expect(jobNeeds(performancePublish)).toEqual(["resolve_target", "kova", "source_performance"]);
    expect(jobNeeds(performanceArtifactGuard)).toEqual(["resolve_target", "kova", "publish"]);
    expect(performancePublish.if).toContain("inputs.publish_reports == true");
    expect(performanceArtifactGuard.if).toContain("inputs.publish_reports != true");
    expect(timeoutForProfile(performanceSource["timeout-minutes"], "beta")).toBeLessThanOrEqual(
      timeoutForProfile(performanceKova["timeout-minutes"], "beta"),
    );
    const performanceArtifactPath = [
      timeoutForProfile(performanceResolve["timeout-minutes"], "beta"),
      timeoutForProfile(performanceKova["timeout-minutes"], "beta"),
      timeoutForProfile(performanceArtifactGuard["timeout-minutes"], "beta"),
    ];
    const performancePublishPath = [
      timeoutForProfile(performanceResolve["timeout-minutes"], "beta"),
      timeoutForProfile(performanceKova["timeout-minutes"], "beta"),
      timeoutForProfile(performancePublish["timeout-minutes"], "beta"),
    ];
    expect(performanceArtifactPath).toEqual([10, 240, 5]);
    expect(performancePublishPath).toEqual([10, 240, 30]);
    expect(performanceArtifactPath.reduce((total, timeout) => total + timeout, 0)).toBe(255);
    expect(performancePublishPath.reduce((total, timeout) => total + timeout, 0)).toBe(280);
    const performanceParent = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "performance");
    expect(performanceParent["timeout-minutes"]).toBe(15);
    expect(workflowStep(performanceParent, "Dispatch OpenClaw Performance").run).toContain(
      "-f publish_reports=false",
    );
    for (const [pathName, path] of [
      ["artifact-only", performanceArtifactPath],
      ["publish", performancePublishPath],
    ] as const) {
      const childTimeout = path.reduce((total, timeout) => total + timeout, 0);
      expect(childTimeout, `performance:${pathName}`).toBeLessThanOrEqual(diagnosticDrainTimeout);
      expect(
        diagnosticDrainTimeout - childTimeout,
        `performance:${pathName}`,
      ).toBeGreaterThanOrEqual(60);
    }

    const candidateAcquisition = workflowJob(
      FULL_RELEASE_VALIDATION_WORKFLOW,
      "candidate_acquisition",
    );
    const candidatePrepare = workflowJob(FULL_RELEASE_CANDIDATE_WORKFLOW, "prepare");
    const candidateBinding = workflowJob(FULL_RELEASE_CANDIDATE_WORKFLOW, "resolve_candidate");
    expect(jobNeeds(workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "evidence_reuse"))).toEqual([
      "resolve_target",
    ]);
    expect(jobNeeds(candidateAcquisition)).toEqual([
      "resolve_target",
      "evidence_reuse",
      "prepare_npm_package",
    ]);
    expect(jobNeeds(candidatePrepare)).toEqual(["discover"]);
    expect(candidatePrepare.with?.prepare_only).toBe(true);
    expect(jobNeeds(candidateBinding)).toEqual(["discover", "prepare"]);
    expect(jobNeeds(releaseChecksParent)).toEqual([
      "resolve_target",
      "evidence_reuse",
      "candidate_acquisition",
    ]);
    expect(jobNeeds(workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "summary"))).toContain(
      "release_checks_candidate",
    );
    const fullParentPath = [
      timeoutForProfile(fullRelease.jobs?.resolve_target?.["timeout-minutes"], "full"),
      timeoutForProfile(fullRelease.jobs?.evidence_reuse?.["timeout-minutes"], "full"),
      timeoutForProfile(fullReleaseCandidate.jobs?.discover?.["timeout-minutes"], "full"),
      timeoutForProfile(liveE2e.jobs?.validate_selected_ref?.["timeout-minutes"], "full"),
      timeoutForProfile(liveE2e.jobs?.prepare_docker_e2e_image?.["timeout-minutes"], "full"),
      timeoutForProfile(
        liveE2e.jobs?.bind_full_release_candidate_evidence?.["timeout-minutes"],
        "full",
      ),
      timeoutForProfile(candidateBinding["timeout-minutes"], "full"),
      timeoutForProfile(releaseChecksParent["timeout-minutes"], "full"),
    ];
    expect(fullParentPath).toEqual([10, 10, 10, 30, 90, 15, 5, 15]);
    const fullParentTimeoutFloor = fullParentPath.reduce((total, timeout) => total + timeout, 0);
    expect(fullParentTimeoutFloor).toBe(185);
    expect(FULL_RELEASE_WAIT_TIMEOUT_MINUTES).toBe(diagnosticDrainTimeout);
  });

  it("bounds every direct job in nested release workflows", () => {
    const boundedWorkflowPaths = [
      RELEASE_CHECKS_WORKFLOW,
      INSTALL_SMOKE_REUSABLE_WORKFLOW,
      CROSS_OS_RELEASE_CHECKS_REUSABLE_WORKFLOW,
      LIVE_E2E_WORKFLOW,
      PACKAGE_ACCEPTANCE_WORKFLOW,
      QA_LIVE_TRANSPORTS_WORKFLOW,
      RELEASE_TELEGRAM_QA_WORKFLOW,
      NPM_TELEGRAM_WORKFLOW,
    ];

    for (const path of boundedWorkflowPaths) {
      const jobs = readWorkflow(path).jobs ?? {};
      expect(Object.keys(jobs).length, path).toBeGreaterThan(0);
      for (const [jobName, job] of Object.entries(jobs)) {
        if (job.uses) {
          // GitHub does not allow timeout-minutes on reusable-workflow caller jobs.
          expect(job["timeout-minutes"], `${path}:${jobName}`).toBeUndefined();
          continue;
        }

        const evaluatedTimeouts = evaluatedJobTimeouts(path, jobName, job);
        expect(evaluatedTimeouts.length, `${path}:${jobName}`).toBeGreaterThan(0);
        for (const timeout of evaluatedTimeouts) {
          expect(Number.isFinite(timeout), `${path}:${jobName}`).toBe(true);
          expect(timeout, `${path}:${jobName}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("pins every documented raw Full Release Validation caller to one exact SHA", () => {
    const nightly = readFileSync(".agents/skills/release-openclaw-nightly/SKILL.md", "utf8");
    const releaseCi = readFileSync(".agents/skills/release-openclaw-ci/SKILL.md", "utf8");
    const releaseCiNotes = readFileSync(
      ".agents/skills/release-openclaw-ci/references/release-ci-notes.md",
      "utf8",
    );
    const testing = readFileSync(".agents/skills/openclaw-testing/SKILL.md", "utf8");
    const parallels = readFileSync(".agents/skills/openclaw-parallels-smoke/SKILL.md", "utf8");
    const maintainer = readFileSync(RELEASE_MAINTAINER_SKILL, "utf8");
    const ciDocs = readFileSync("docs/ci.md", "utf8");
    const fullReleaseDocs = readFileSync("docs/reference/full-release-validation.md", "utf8");
    const releasingDocs = readFileSync("docs/reference/RELEASING.md", "utf8");

    expect(nightly).toContain('-f expected_sha="$SHA"');
    for (const text of [releaseCi, fullReleaseDocs, releasingDocs]) {
      expectTextToIncludeAll(text, [
        'RELEASE_SHA="$(git rev-parse HEAD)"',
        "-f ref=extended-stable/YYYY.M.33",
        '-f expected_sha="$RELEASE_SHA"',
      ]);
    }
    expectTextToIncludeAll(ciDocs, [
      'VALIDATION_SHA="<full-commit-sha>"',
      '-f ref="$VALIDATION_SHA"',
      '-f expected_sha="$VALIDATION_SHA"',
      'TOOLING_SHA="<recorded-full-main-ancestor-sha>"',
      'VALIDATION_SHA="<full-release-candidate-sha>"',
      "--target-ref release/YYYY.M.PATCH",
      '--workflow-sha "$TOOLING_SHA"',
    ]);
    for (const text of [releaseCi, releaseCiNotes, testing, parallels, ciDocs, maintainer]) {
      expect(text).toContain("Validation SHA + Tooling SHA");
    }
    expect(releaseCi).toContain("release lifecycle ledger: Code SHA, Release SHA, and Tooling SHA");
  });

  it("executes shared release candidate identity validation with its JSON input", () => {
    const selectedSha = "a".repeat(40);
    const candidate = {
      packagePublished: false,
      packageArtifactName: "docker-e2e-package-456-1",
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
    const binDir = resolve(tempDirs.make("release-candidate-validation-"), "bin");
    mkdirSync(binDir, { recursive: true });
    const ghPath = resolve(binDir, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != "api" ] || [ "$2" != "--method" ] || [ "$3" != "GET" ]; then
  exit 1
fi
case "$4" in
  */actions/artifacts/123)
    printf '%s\n' '{"id":123,"name":"docker-e2e-package-456-1","expired":false,"digest":"sha256:${"b".repeat(64)}","workflow_run":{"id":456}}'
    ;;
  */actions/artifacts/790)
    printf '%s\n' '{"id":790,"name":"docker-e2e-prepublish-plugin-registry-456-1","expired":false,"digest":"sha256:${"f".repeat(64)}","workflow_run":{"id":456}}'
    ;;
  */actions/runs/456/attempts/1)
    printf '%s\n' '{"id":456,"run_attempt":1}'
    ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(ghPath, 0o755);
    const validationEnv = {
      ...process.env,
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SELECTED_SHA: selectedSha,
    };

    const valid = spawnSync("bash", ["-c", validation ?? ""], {
      encoding: "utf8",
      env: {
        ...validationEnv,
        CANDIDATE_ARTIFACT_JSON: JSON.stringify(candidate),
      },
    });
    expect(valid.status, valid.stderr).toBe(0);

    const { packagePublished: _packagePublished, ...missingProvenance } = candidate;
    for (const invalid of [missingProvenance, { ...candidate, packagePublished: "false" }]) {
      const rejected = spawnSync("bash", ["-c", validation ?? ""], {
        encoding: "utf8",
        env: {
          ...validationEnv,
          CANDIDATE_ARTIFACT_JSON: JSON.stringify(invalid),
        },
      });
      expect(rejected.status).not.toBe(0);
    }

    const registryCandidate = {
      ...candidate,
      prepublishPluginRegistryArtifactName: "docker-e2e-prepublish-plugin-registry-456-1",
      prepublishPluginRegistryArtifactId: "790",
      prepublishPluginRegistryArtifactDigest: "f".repeat(64),
      prepublishPluginRegistryArtifactRunId: "456",
      prepublishPluginRegistryArtifactRunAttempt: "1",
      prepublishPluginRegistryManifestSha256: "1".repeat(64),
    };
    const validRegistry = spawnSync("bash", ["-c", validation ?? ""], {
      encoding: "utf8",
      env: {
        ...validationEnv,
        CANDIDATE_ARTIFACT_JSON: JSON.stringify(registryCandidate),
      },
    });
    expect(validRegistry.status, validRegistry.stderr).toBe(0);

    const partialRegistry = spawnSync("bash", ["-c", validation ?? ""], {
      encoding: "utf8",
      env: {
        ...validationEnv,
        CANDIDATE_ARTIFACT_JSON: JSON.stringify({
          ...candidate,
          prepublishPluginRegistryArtifactId: "790",
        }),
      },
    });
    expect(partialRegistry.status).not.toBe(0);

    const mismatchedRegistryName = spawnSync("bash", ["-c", validation ?? ""], {
      encoding: "utf8",
      env: {
        ...validationEnv,
        CANDIDATE_ARTIFACT_JSON: JSON.stringify({
          ...registryCandidate,
          prepublishPluginRegistryArtifactName: "docker-e2e-prepublish-plugin-registry-999-1",
        }),
      },
    });
    expect(mismatchedRegistryName.status).not.toBe(0);

    const mismatched = spawnSync("bash", ["-c", validation ?? ""], {
      encoding: "utf8",
      env: {
        ...validationEnv,
        CANDIDATE_ARTIFACT_JSON: JSON.stringify(candidate),
        SELECTED_SHA: "f".repeat(40),
      },
    });
    expect(mismatched.status).not.toBe(0);
  });

  it("normalizes fresh and reused release package candidate identity", () => {
    const output = workflowJob(RELEASE_CHECKS_WORKFLOW, "prepare_release_package").outputs
      ?.candidate_artifact_json;
    expect(output).toContain("needs.resolve_target.outputs.candidate_artifact_json || format");
    for (const field of [
      "packagePublished",
      "packageArtifactDigest",
      "packageArtifactId",
      "packageArtifactName",
      "packageArtifactRunAttempt",
      "packageArtifactRunId",
      "packageFileName",
      "packageSha256",
      "packageSourceSha",
      "packageVersion",
    ]) {
      expect(output).toContain(`"${field}"`);
    }
  });

  it("keeps release history checks blobless", () => {
    const fullHistoryCheckouts: Array<[string, string, string]> = [
      [LIVE_E2E_WORKFLOW, "validate_selected_ref", "Checkout workflow repository"],
      [
        RELEASE_CHECKS_WORKFLOW,
        "resolve_target",
        "Checkout selected ref for reachability fallback",
      ],
      [PACKAGE_ACCEPTANCE_WORKFLOW, "resolve_package", "Checkout package workflow ref"],
      [PLUGIN_NPM_RELEASE_WORKFLOW, "preview_plugins_npm", "Checkout"],
      [PLUGIN_CLAWHUB_RELEASE_WORKFLOW, "preview_plugins_clawhub", "Checkout"],
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

    const scopedHistoryCheckouts: Array<[string, string, string]> = [
      [OPENCLAW_NPM_RELEASE_WORKFLOW, "validate_publish_request", "Checkout"],
      [RELEASE_PUBLISH_WORKFLOW, "resolve_release_target", "Checkout release tag"],
      [OPENCLAW_NPM_PREFLIGHT_WORKFLOW, "check_openclaw_npm", "Checkout"],
      [OPENCLAW_NPM_PREFLIGHT_WORKFLOW, "prepare_openclaw_npm", "Checkout"],
      [OPENCLAW_NPM_PREFLIGHT_WORKFLOW, "verify_openclaw_npm", "Checkout"],
      [OPENCLAW_NPM_PREFLIGHT_WORKFLOW, "check_sdk_npm", "Checkout trusted Plugin SDK API tooling"],
    ];
    for (const [workflowPath, jobName, stepName] of scopedHistoryCheckouts) {
      expect(
        workflowStep(workflowJob(workflowPath, jobName), stepName).with,
        `${workflowPath}:${jobName}`,
      ).toMatchObject({
        "fetch-depth": 1,
        filter: "blob:none",
      });
    }

    const metadataOnlyCheckouts: Array<[string, string, string]> = [
      [LIVE_E2E_WORKFLOW, "validate_selected_ref", "Checkout workflow repository"],
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
    const buildControlUi = validateJob.steps?.find((step) => step.name === "Build Control UI");

    expect(stepNames).not.toContain("Ensure matching GitHub release exists");
    expect(macosRelease.jobs?.validate_macos_release_request).toBeDefined();
    expect(buildControlUi?.env?.OPENCLAW_CONTROL_UI_RELEASE_BUILD).toBe("1");
  });

  it("classifies fast pretag Control UI output as a release artifact", () => {
    const script = readFileSync("scripts/release-fast-pretag-check.sh", "utf8");

    expect(script).toContain("OPENCLAW_CONTROL_UI_RELEASE_BUILD=1 pnpm ui:build");
  });

  it("keeps every tracked repository skill visible to Git-aware syncs", () => {
    const skillFiles = execFileSync("git", ["ls-files", ".agents/skills/*/SKILL.md"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(skillFiles.length).toBeGreaterThan(0);
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      encoding: "utf8",
      input: `${skillFiles.join("\n")}\n`,
    });
    expect(ignored.status).toBe(1);
    expect(ignored.stdout).toBe("");
    expect(ignored.stderr).toBe("");
  });

  it("does not track generated node_modules entries", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ":(glob)**/node_modules/**"], {
      encoding: "utf8",
    });

    expect(tracked).toBe("");
  });

  it("keeps tracked sync metadata and QA Mantis sources visible to remote full syncs", () => {
    for (const path of [
      ".github/release/clawhub-cli/package-lock.json",
      ".gitignore",
      "apps/android/.gitignore",
      "docs/reference/templates/IDENTITY.md",
      "docs/reference/templates/USER.md",
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
