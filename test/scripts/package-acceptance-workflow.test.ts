// Package Acceptance Workflow tests cover package acceptance workflow script behavior.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
const RELEASE_PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const ANDROID_RELEASE_WORKFLOW = ".github/workflows/android-release.yml";
const STABLE_MAIN_CLOSEOUT_WORKFLOW = ".github/workflows/openclaw-stable-main-closeout.yml";
const WINDOWS_NODE_RELEASE_WORKFLOW = ".github/workflows/windows-node-release.yml";
const FULL_RELEASE_VALIDATION_WORKFLOW = ".github/workflows/full-release-validation.yml";
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

type WorkflowStep = {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
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
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean | string;
  };
  env?: Record<string, string>;
  if?: string;
  name?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "runs-on"?: string;
  strategy?: {
    matrix?: {
      include?: WorkflowMatrixEntry[];
    };
  };
  "timeout-minutes"?: number | string;
  steps?: WorkflowStep[];
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
      DOCKER_RESULT: "success",
      PACKAGE_INTEGRITY_RESULT: "success",
      PACKAGE_TELEGRAM_RESULT: params.telegramResult,
      PATH: process.env.PATH,
      RESOLVE_RESULT: "success",
      TELEGRAM_ENABLED: String(params.telegramEnabled),
    },
  });
}

describe("package acceptance workflow", () => {
  it("verifies immutable postpublish evidence before stable closeout reads it", () => {
    const workflow = readFileSync(STABLE_MAIN_CLOSEOUT_WORKFLOW, "utf8");
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
    const ignoredWorkflow = readWorkflow(CRABBOX_HYDRATE_WORKFLOW);
    void ignoredWorkflow;
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
    expect(workflow).toContain('gh run download "$ARTIFACT_RUN_ID"');
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
    expect(workflow).toContain(
      "node scripts/check-openclaw-package-tarball.mjs .artifacts/docker-e2e-package/openclaw-current.tgz",
    );
    expect(workflow).toContain("needs: [resolve_package, package_integrity]");
    expect(workflow).toContain("package_integrity=${PACKAGE_INTEGRITY_RESULT}");
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
    expect(workflow).toContain(
      "published_upgrade_survivor_baseline: ${{ inputs.published_upgrade_survivor_baseline }}",
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

  it("requires pinned full release child workflows to run at the resolved target SHA", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const releaseChecksWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const performanceJob = workflow.slice(
      workflow.indexOf("  performance:\n"),
      workflow.indexOf("\n  summary:"),
    );

    expect(workflow).toContain("TARGET_SHA: ${{ needs.resolve_target.outputs.sha }}");
    expect(workflow).toContain("CHILD_WORKFLOW_REF: ${{ github.ref_name }}");
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
      '[[ ( "$CHILD_WORKFLOW_REF" == release-ci/* || "$CHILD_WORKFLOW_REF" =~ ^extended-stable/[0-9]{4}\\.([1-9]|1[0-2])\\.33$ ) && -n "${TARGET_SHA// }" && "$head_sha" != "$TARGET_SHA" ]]',
    );
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
    expect(workflow).toContain("child run used ${head_sha}, expected ${TARGET_SHA}");
    expect(workflow).toContain(
      "Dispatch Full Release Validation from a release-ci or extended-stable ref pinned to the target SHA",
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
    expect(retryCalls).toHaveLength(28);
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
  it("lets reusable Docker E2E consume an already resolved package artifact", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const packageJson = readFileSync(PACKAGE_JSON, "utf8");
    const scheduler = readFileSync("scripts/test-docker-all.mjs", "utf8");
    const publishedUpgradeSurvivor = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");

    expect(workflow).toContain("package_artifact_name:");
    expect(workflow).toContain("package_artifact_run_id:");
    expect(workflow).toContain("published_upgrade_survivor_baseline:");
    expect(workflow).toContain("published_upgrade_survivor_baselines:");
    expect(workflow).toContain("published_upgrade_survivor_scenarios:");
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
    expect(workflow).toContain("Download current-run OpenClaw Docker E2E package");
    expect(workflow).toContain("Download previous-run OpenClaw Docker E2E package");
    expect(workflow).toContain("inputs.package_artifact_name != ''");
    expect(workflow).toContain(
      'bare_image="${PROVIDED_BARE_IMAGE:-ghcr.io/${repository}-docker-e2e-bare:${image_tag}}"',
    );
    expect(workflow).toContain(
      'functional_image="${PROVIDED_FUNCTIONAL_IMAGE:-ghcr.io/${repository}-docker-e2e-functional:${image_tag}}"',
    );
    expect(workflow).toContain("name: ${{ inputs.package_artifact_name || 'docker-e2e-package' }}");
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
      "published_upgrade_survivor_baseline=${shellQuote(process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC)}",
    );
    expect(scheduler).toContain(
      "published_upgrade_survivor_baselines=${shellQuote(process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS)}",
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

  it("uses Blacksmith Docker build caching for prepared E2E images", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");

    expect(workflow).toContain("uses: useblacksmith/setup-docker-builder@");
    expect(workflow).toContain("uses: useblacksmith/build-push-action@");
    expect(workflow).not.toContain("cache-from: type=gha,scope=docker-e2e");
    expect(workflow).not.toContain("cache-to: type=gha,mode=max,scope=docker-e2e");
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
      "command: OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.5 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=180000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
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
    expect(workflow).not.toContain(
      "OPENCLAW_LIVE_GATEWAY_PROVIDERS=deepseek,opencode-go,openrouter,xai,zai",
    );
    expect(workflow).toContain("suite_id: live-gateway-anthropic-docker");
    expect(workflow).toContain("OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2");
    expect(workflow).toContain(
      "OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.5 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=1 OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=90000 OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
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

  it("runs Docker live harnesses from trusted helper scripts", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const scenarios = readFileSync("scripts/lib/docker-e2e-scenarios.mjs", "utf8");
    const scheduler = readFileSync("scripts/test-docker-all.mjs", "utf8");
    const harness = readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8");
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
      "command: OPENCLAW_LIVE_GATEWAY_THINKING=off OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MODELS=openai/gpt-5.5 OPENCLAW_LIVE_GATEWAY_MAX_MODELS=1",
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
      "OPENCLAW_LIVE_CODEX_HARNESS_DOCKER_RUN_TIMEOUT:-2100s",
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

    expect(workflow).toContain("package_acceptance_release_checks:");
    expect(workflow).toContain(
      "live_repo_e2e_release_checks:\n    name: Run repo/live E2E validation\n    needs: [resolve_target]",
    );
    expect(workflow).toContain(
      "docker_e2e_release_checks:\n    name: Run Docker release-path validation\n    needs: [resolve_target, prepare_release_package]",
    );
    expect(workflow).toContain("include_release_path_suites: false");
    expect(workflow).toContain("include_release_path_suites: true");
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
    expect(workflow).toContain("cross_os_suite_filter:");
    expect(workflow).toContain("advisory: false");
    expect(workflow).toContain(
      "suite_filter: ${{ needs.resolve_target.outputs.cross_os_suite_filter }}",
    );
    expect(workflow).toContain(
      "live_suite_filter: ${{ needs.resolve_target.outputs.live_suite_filter }}",
    );
    expect(workflow).toContain(
      "contains(fromJSON('[\"all\",\"cross-os\",\"package\"]'), needs.resolve_target.outputs.rerun_group) || (needs.resolve_target.outputs.rerun_group == 'live-e2e' && needs.resolve_target.outputs.live_suite_filter == '')",
    );
    expect(workflow).toContain(
      "(needs.resolve_target.outputs.rerun_group == 'live-e2e' || (needs.resolve_target.outputs.rerun_group == 'all' && needs.resolve_target.outputs.run_release_soak == 'true')) && needs.resolve_target.outputs.live_suite_filter == ''",
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

  it("detects Matrix fail-fast support for older release refs", () => {
    const releaseWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const qaWorkflow = readFileSync(".github/workflows/qa-live-transports-convex.yml", "utf8");

    expect(releaseWorkflow).toContain("matrix_args=(");
    expect(releaseWorkflow).toContain(
      'pnpm openclaw qa matrix --help 2>/dev/null | grep -F -q -- "--fail-fast"',
    );
    expect(releaseWorkflow).toContain("matrix_args+=(--fail-fast)");
    expect(releaseWorkflow).toContain(
      'pnpm openclaw qa matrix --output-dir "${attempt_output_dir}" "${matrix_args[@]}"',
    );
    expect(releaseWorkflow).toContain(
      'echo "Matrix live lane failed on attempt ${attempt}; retrying once..." >&2',
    );
    expect(releaseWorkflow).toContain(
      'echo "Telegram live lane failed on attempt ${attempt}; retrying once..." >&2',
    );
    expect(qaWorkflow).toContain(
      'pnpm openclaw qa matrix --help 2>/dev/null | grep -F -q -- "--fail-fast"',
    );
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
      ["run_mock_parity", "Upload parity artifacts"],
      ["run_live_runtime_token_efficiency", "Upload live runtime token-efficiency artifacts"],
      ["run_live_matrix", "Upload Matrix QA artifacts"],
      ["run_live_matrix_sharded", "Upload Matrix QA shard artifacts"],
      ["run_live_telegram", "Upload Telegram QA artifacts"],
      ["run_live_discord", "Upload Discord QA artifacts"],
      ["run_live_whatsapp", "Upload WhatsApp QA artifacts"],
      ["run_live_slack", "Upload Slack QA artifacts"],
    ];

    for (const [jobName, stepName] of cases) {
      const uploadStep = workflowStep(workflowJob(QA_LIVE_TRANSPORTS_WORKFLOW, jobName), stepName);

      expect(uploadStep.if, jobName).toBe("always()");
      expect(uploadStep.with?.["if-no-files-found"], jobName).toBe("error");
    }
  });

  it("requires release-check QA evidence artifacts when lanes run", () => {
    const cases = [
      ["qa_lab_parity_lane_release_checks", "Upload parity lane artifacts"],
      ["qa_lab_parity_report_release_checks", "Upload parity artifacts"],
      ["qa_lab_runtime_parity_release_checks", "Upload runtime parity artifacts"],
      ["qa_live_matrix_release_checks", "Upload Matrix QA artifacts"],
      ["qa_live_telegram_release_checks", "Upload Telegram QA artifacts"],
      ["qa_live_discord_release_checks", "Upload Discord QA artifacts"],
      ["qa_live_whatsapp_release_checks", "Upload WhatsApp QA artifacts"],
      ["qa_live_slack_release_checks", "Upload Slack QA artifacts"],
    ];

    for (const [jobName, stepName] of cases) {
      const uploadStep = workflowStep(workflowJob(RELEASE_CHECKS_WORKFLOW, jobName), stepName);

      expect(uploadStep.if, jobName).toBe("always()");
      expect(uploadStep.uses, jobName).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with?.["if-no-files-found"], jobName).toBe("error");
    }

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
    expect(workflow).toContain(
      "needs: [resolve_package, package_integrity, docker_acceptance, package_telegram]",
    );
    expect(workflow).toContain("PACKAGE_TELEGRAM_RESULT:");
    expect(workflow).toContain("package_telegram=${PACKAGE_TELEGRAM_RESULT}");
    expect(workflow).not.toContain("npm_telegram:");
  });

  it.each([
    { telegramEnabled: true, telegramResult: "success" },
    { telegramEnabled: false, telegramResult: "skipped" },
  ])(
    "accepts Telegram result $telegramResult when enabled=$telegramEnabled",
    ({ telegramEnabled, telegramResult }) => {
      const result = runPackageAcceptanceSummary({ telegramEnabled, telegramResult });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
  );

  it("rejects a skipped Telegram lane when package acceptance enabled it", () => {
    const result = runPackageAcceptanceSummary({
      telegramEnabled: true,
      telegramResult: "skipped",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("::error::package_telegram ended with skipped");
  });

  it("preserves advisory handling for an unexpectedly skipped Telegram lane", () => {
    const result = runPackageAcceptanceSummary({
      advisory: true,
      telegramEnabled: true,
      telegramResult: "skipped",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "::warning::package_telegram ended with skipped; package acceptance is advisory for this caller.",
    );
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
      PROVIDER_MODE: "${{ inputs.npm_telegram_provider_mode }}",
      SCENARIO: "${{ inputs.npm_telegram_scenario }}",
      TARGET_SHA: "${{ needs.resolve_target.outputs.sha }}",
    });
    expectTextToIncludeAll(dispatchStep.run, [
      'dispatch_id="full-release-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-npm-telegram"',
      'dispatch_output="$(gh workflow run npm-telegram-beta-e2e.yml --ref "$CHILD_WORKFLOW_REF" "${args[@]}" 2>&1)"',
      ".display_title == env.DISPATCH_RUN_NAME and .head_branch == env.CHILD_WORKFLOW_REF",
      "The dispatch was not retried to avoid creating a duplicate child.",
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
      "cancel-in-progress: ${{ (inputs.ref == 'main' && inputs.rerun_group == 'all') || startsWith(inputs.ref, 'tideclaw/alpha/') }}",
      "Verify release checks accepted Tideclaw alpha advisory lanes",
      "release_checks_advisory_only",
      "release_check_blocking_job",
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
    const runStep = workflowStep(job, "Run package Telegram E2E");

    expect(currentRunDownload).toEqual({
      if: "inputs.package_artifact_name != '' && inputs.package_artifact_run_id == ''",
      name: "Download package-under-test artifact",
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        name: "${{ inputs.package_artifact_name }}",
        path: ".artifacts/telegram-package-under-test",
      },
    });
    expect(releaseRunDownload).toEqual({
      if: "inputs.package_artifact_name != '' && inputs.package_artifact_run_id != ''",
      name: "Download package-under-test artifact from release run",
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        "github-token": "${{ github.token }}",
        name: "${{ inputs.package_artifact_name }}",
        path: ".artifacts/telegram-package-under-test",
        "run-id": "${{ inputs.package_artifact_run_id }}",
      },
    });
    expectTextToIncludeAll(validateStep.run, [
      'if [[ -z "${PACKAGE_ARTIFACT_NAME// }" ]]; then',
      "package_spec must be openclaw@alpha",
    ]);
    expectTextToIncludeAll(runStep.run, [
      'manifest="${package_dir}/preflight-manifest.json"',
      'candidate_manifest="${package_dir}/package-candidate.json"',
      'find "${package_dir}" -type f -name "*.tgz"',
      "package artifact manifest contains duplicate package metadata",
      "package artifact tarball set does not match preflight manifest",
      "package candidate manifest does not match the OpenClaw tarball",
      "package candidate digest mismatch",
      'export OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR="${package_dir}"',
      'export OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ="${package_tgz}"',
    ]);
  });

  it("lets CI Telegram consumers wait on Convex leases instead of GitHub concurrency", () => {
    const telegramJobs = [
      [NPM_TELEGRAM_WORKFLOW, "run_package_telegram_e2e", "Run package Telegram E2E"],
      [RELEASE_CHECKS_WORKFLOW, "qa_live_telegram_release_checks", "Run Telegram live lane"],
      [QA_LIVE_TRANSPORTS_WORKFLOW, "run_live_telegram", "Run Telegram live lane"],
      [
        ".github/workflows/mantis-telegram-live.yml",
        "run_telegram_live",
        "Run Telegram live scenario and capture desktop evidence",
      ],
    ] as const;

    for (const [workflowPath, jobName, stepName] of telegramJobs) {
      const job = workflowJob(workflowPath, jobName);
      expect(job.concurrency).toBeUndefined();
      const step = workflowStep(job, stepName);
      expect(step.env?.OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS).toBe("1800000");
    }
  });

  it("keeps release QA and repo E2E lanes off scarce 32-core runners", () => {
    const releaseChecksWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const liveE2eWorkflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");

    for (const jobName of [
      "qa_lab_parity_lane_release_checks",
      "qa_lab_parity_report_release_checks",
      "qa_live_matrix_release_checks",
      "qa_live_telegram_release_checks",
    ]) {
      expect(releaseChecksWorkflow).toMatch(
        new RegExp(`${jobName}:[\\s\\S]*?runs-on: ubuntu-24\\.04`, "u"),
      );
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
      "qa_live_matrix_release_checks",
      "qa_live_telegram_release_checks",
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
      expect(recordStep.env?.RELEASE_CHECK_STEP_OUTCOMES, jobName).toContain("upload_");

      const uploadStep = workflowStep(job, "Upload advisory status");
      expect(uploadStep.if, jobName).toBe("always()");
      expect(uploadStep.uses, jobName).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with?.name, jobName).toContain("release-check-status-");
      expect(uploadStep.with?.path, jobName).toMatch(
        /^\.artifacts\/release-check-status\/.+\.env$/u,
      );
      expect(uploadStep.with?.["if-no-files-found"], jobName).toBe("error");
    }

    const summary = workflowJob(RELEASE_CHECKS_WORKFLOW, "summary");
    expect(summary.permissions?.actions).toBe("read");
    const downloadStep = workflowStep(summary, "Download advisory status artifacts");
    expect(downloadStep["continue-on-error"]).toBe(true);
    expect(downloadStep.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    expect(downloadStep.with?.pattern).toBe("release-check-status-*");
    expect(downloadStep.with?.["merge-multiple"]).toBe(true);

    const verifyStep = workflowStep(summary, "Verify release check results");
    expectTextToIncludeAll(verifyStep.run, [
      "release_check_result()",
      'elif [[ "$fallback" != "success" && "$fallback" != "skipped" ]]; then',
      'elif [[ "$fallback" == "success" ]]; then',
      "advisory_status_override_allowed()",
      'if advisory_status_override_allowed "$name"; then',
      "::warning::${name} ended with ${result}; Tideclaw alpha treats non-package-safety release-check lanes as advisory.",
      "::error::${name} ended with ${result}",
    ]);
    expect(verifyStep.run).not.toContain(
      "QA release-check lanes are advisory and do not block release validation.",
    );
  });

  it("summarizes queue time separately from execution time in full validation", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");
    const parsedWorkflow = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const summaryJob = parsedWorkflow.jobs?.summary;
    const manifestStep = workflowStep(summaryJob ?? {}, "Write release validation manifest");

    expect(workflow).toContain("### Slowest jobs: ${label}");
    expect(workflow).toContain("### Longest queues: ${label}");
    expect(workflow).toContain("Write release validation manifest");
    expect(workflow).toContain("PERFORMANCE_RUN_ID: ${{ needs.performance.outputs.run_id }}");
    expect(workflow).toContain("Upload release validation manifest");
    expect(workflow).toContain("Failed child detail: ${label}");
    expect(workflow).toContain("actions/runs/${run_id}/artifacts?per_page=100");
    expect(workflow).toContain("full-release-validation-${{ github.run_id }}");
    expect(workflow).toContain("| Job | Result | Queue minutes | Run minutes |");
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
    const fullReleaseWorkflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");

    expect(workflow).toContain("timeout-minutes: 120");
    expect(workflow).toContain("environment: npm-release");
    expect(workflow).toContain("Download OpenClaw npm preflight manifest");
    expect(workflow).toContain("Validate OpenClaw npm preflight manifest");
    expect(workflow).toContain("Download full release validation manifest");
    expect(workflow).toContain("Validate full release validation manifest");
    expect(workflow).toContain("full_release_validation_run_id");
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
    expect(fullReleaseWorkflow).toContain(
      "needs.docker_runtime_assets_preflight.result == 'success'",
    );
    expect(npmWorkflow).toContain("full_release_validation_run_id");
    expect(npmWorkflow).toContain("release_publish_run_id");
    expect(npmWorkflow).toContain("Real publish requires full_release_validation_run_id");
    expect(npmWorkflow).toContain(
      "Workflow-dispatched real publish requires release_publish_run_id",
    );
    expect(npmWorkflow).toContain("tarballSha256");
    expect(npmWorkflow).toContain("dependencyTarballs");
    expect(npmWorkflow).toContain('packageName: "@openclaw/ai"');
    expect(npmWorkflow).toContain("AI_TARBALL_SHA256");
    expect(npmWorkflow).toContain("does not match openclaw");
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
    expect(publishSteps[notesIndex]?.run).toContain("scripts/prepare-github-release-notes.mjs");
    expect(workflow).toContain('git show "${TARGET_SHA}:CHANGELOG.md" > "${changelog_file}"');
    expect(workflow).not.toContain('awk -v version="${notes_version}"');
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

  it("gates stable GitHub publication on the Windows Hub release asset contract", () => {
    const releaseWorkflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const windowsWorkflow = readFileSync(WINDOWS_NODE_RELEASE_WORKFLOW, "utf8");
    const releaseDocs = readFileSync("docs/reference/RELEASING.md", "utf8");
    const releaseSkill = readFileSync(
      ".agents/skills/release-openclaw-maintainer/SKILL.md",
      "utf8",
    );

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
      "\n            if ! promote_windows_release_assets; then\n",
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
    expect(androidWorkflow).toContain("actions/attest@a1948c3f048ba23858d222213b7c278aabede763");
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
      'dispatch_workflow_at_ref "${RELEASE_TAG}" android-release.yml',
    );
    expect(releaseWorkflow).toContain('-f release_target_sha="${TARGET_SHA}"');
    expect(releaseWorkflow).toContain("verify_android_release_asset_contract");
    expect(releaseWorkflow).toContain("Android release APK digest does not match");
    expect(releaseWorkflow).toContain("Android APK asset contract: verified");

    const createDraftCall = releaseWorkflow.lastIndexOf(
      "\n            create_or_update_github_release\n",
    );
    const promoteAndroidCall = releaseWorkflow.lastIndexOf(
      "\n            if ! promote_android_release_asset; then\n",
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
    const pluginNpmWorkflow = readFileSync(".github/workflows/plugin-npm-release.yml", "utf8");
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
    expect(clawHubWorkflow).toContain("verify_published_clawhub_package:");
    expect(clawHubWorkflow).toContain("inputs.dry_run != true");
    expect(clawHubWorkflow).toContain("Verify published ClawHub package");
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
    expect(releaseWorkflow).toContain(
      "did not return an Actions run URL; refusing to guess from recent workflow_dispatch runs",
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
      "Waiting for plugin-clawhub-new.yml bootstrap to finish before continuing release publish.",
    );
    expect(releaseWorkflow).toContain("OpenClaw npm run ID");
    expect(releaseWorkflow).toContain("npm_telegram_run_id");
    expect(releaseWorkflow).toContain('release_publish_run_id="${GITHUB_RUN_ID}"');
    expect(releaseWorkflow).toContain("append_release_proof_to_github_release");
    expect(releaseWorkflow).toContain("appendGitHubReleaseVerification(body, section)");
    expect(releaseWorkflow).not.toContain("Release verification tail omitted");
    expect(releaseWorkflow).toContain("guard_existing_public_release");
    expect(releaseWorkflow).toContain(
      "already has a public GitHub release page without complete postpublish evidence",
    );
    expect(releaseWorkflow).toContain("registry tarball");
    expect(releaseWorkflow).toContain("openclawNpmTarball");
    expect(releaseWorkflow).not.toContain('npm view "openclaw@${release_version}" dist.tarball');
    expect(releaseWorkflow).toContain("release SHA");
    expect(clawHubReleasePlanScript).toContain("not awaited by this proof");
    expect(releaseWorkflow).toContain("wait_for_job_success");
    expect(releaseWorkflow).toContain("Validate release publish approval");
    expect(releaseWorkflow).toContain('conclusion" == "skipped"');
    expect(releaseWorkflow).toContain("approve_child_publish_environment");
    expect(releaseWorkflow).toContain("Approve child release gate after parent release approval");
    expect(releaseWorkflow).toContain("release:verify-beta");
    expect(releaseWorkflow).toContain('--workflow-ref "${CHILD_WORKFLOW_REF}"');
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
      '[[ -n "${plugin_clawhub_bootstrap_run_id}" && "${WAIT_FOR_CLAWHUB}" == "true" ]]',
    );
    expect(clawHubReleasePlanScript).toContain("--skip-clawhub");
    expect(pluginNpmWorkflow).toContain("Validate release publish approval run");
    expect(clawHubWorkflow).toContain("Validate release publish approval run");
    expect(openclawNpmWorkflow).toContain("Validate release publish approval run");
    expect(pluginNpmWorkflow).toContain("Check npm package version");
    expect(pluginNpmWorkflow).toContain("already_published=true");
    expect(pluginNpmWorkflow).toContain(
      "steps.npm_package_version.outputs.already_published != 'true'",
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
    expect(clawHubNewWorkflow).toContain('CLAWHUB_CLI_PACKAGE: "clawhub@0.23.1"');
    expect(clawHubNewWorkflow).not.toContain("CLAWHUB_REPOSITORY:");
    expect(clawHubNewWorkflow).not.toContain("CLAWHUB_REF:");
    expect(clawHubNewWorkflow).toContain("environment: clawhub-plugin-bootstrap");
    expect(clawHubNewWorkflow).toContain("secrets.CLAWHUB_TOKEN");
    expect(clawHubNewWorkflow).not.toContain(
      "uses: openclaw/clawhub/.github/workflows/package-publish.yml",
    );
    expect(clawHubNewWorkflow).not.toContain("clawhub_token:");
    expect(clawHubNewWorkflow).toContain("Validate pinned ClawHub trusted publisher CLI support");
    expect(clawHubNewWorkflow).toContain('npm exec --yes --package "${CLAWHUB_CLI_PACKAGE}"');
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
    expect(clawHubNewWorkflow).toContain("Publish ClawHub bootstrap package");
    expect(clawHubNewWorkflow).toContain("bash scripts/plugin-clawhub-publish.sh --publish");
    expect(clawHubNewWorkflow).toContain("bootstrapMode");
    expect(clawHubNewWorkflow).toContain("BOOTSTRAP_MODE: ${{ matrix.plugin.bootstrapMode }}");
    expect(clawHubNewWorkflow).toContain("requiresManualOverride");
    expect(clawHubNewWorkflow).toContain(
      'OPENCLAW_CLAWHUB_MANUAL_OVERRIDE_REASON="GitHub Actions trusted publisher repair before OIDC migration"',
    );
    expect(clawHubNewWorkflow).toContain("configure-only");
    expect(clawHubNewWorkflow).toContain(
      "version is already present on ClawHub; configuring trusted publisher only",
    );
    expect(clawHubNewWorkflow).toContain(
      "EXPECTED_WORKFLOW_BRANCH: ${{ inputs.release_publish_branch || github.ref_name }}",
    );
    expect(clawHubNewWorkflow).toContain(
      "TRUSTED_PUBLISH_BRANCH: ${{ inputs.release_publish_branch || github.ref_name }}",
    );
    expect(clawHubNewWorkflow).toContain('OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0"');
    expect(clawHubNewWorkflow).toContain("trusted-publisher set");
    expect(clawHubNewWorkflow).toContain("--workflow-filename plugin-clawhub-release.yml");
    expect(clawHubNewWorkflow).not.toContain("--environment clawhub-plugin-release");
    expect(clawHubNewWorkflow).toContain("trustedPublisher?.environment != null");
    expect(clawHubNewWorkflow).toContain("without an environment pin");
    expect(clawHubNewWorkflow).not.toContain("Checkout ClawHub CLI source");
    expect(clawHubNewWorkflow).not.toContain("packages/clawhub/src/cli.ts");
    expect(clawHubNewWorkflow).toContain("verify_bootstrap_clawhub_package:");
    expect(clawHubNewWorkflow).toContain("Verify bootstrap ClawHub package and trusted publisher");
    expect(clawHubNewWorkflow).toContain("/trusted-publisher");
    expect(clawHubNewWorkflow).toContain('trustedPublisher?.repository !== "openclaw/openclaw"');
    expect(openclawNpmWorkflow).toContain("environment: npm-release");
    expect(releaseWorkflow).toContain("default: from-validation");
    expect(releaseWorkflow).toContain('--release-publish-branch "${CHILD_WORKFLOW_REF}"');
    expect(releaseWorkflow).toContain('--release-publish-run-id "${GITHUB_RUN_ID}"');
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
    expect(releaseWorkflow.lastIndexOf("verify_published_release")).toBeLessThan(
      releaseWorkflow.lastIndexOf("create_or_update_github_release"),
    );
    expect(releaseWorkflow.lastIndexOf("create_or_update_github_release")).toBeLessThan(
      releaseWorkflow.lastIndexOf("append_release_proof_to_github_release"),
    );
    expect(releaseWorkflow).toContain("finished with ${conclusion} in ${duration_label}");
  });

  it("keeps release workflow setup and timeout budgets bounded", () => {
    const fullRelease = readWorkflow(FULL_RELEASE_VALIDATION_WORKFLOW);
    const releaseChecks = readWorkflow(RELEASE_CHECKS_WORKFLOW);
    const crossOs = readWorkflow(".github/workflows/openclaw-cross-os-release-checks-reusable.yml");
    const liveE2e = readWorkflow(LIVE_E2E_WORKFLOW);
    const releaseWorkflowPaths = [
      FULL_RELEASE_VALIDATION_WORKFLOW,
      RELEASE_CHECKS_WORKFLOW,
      ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
      LIVE_E2E_WORKFLOW,
      NPM_TELEGRAM_WORKFLOW,
      ".github/workflows/openclaw-release-publish.yml",
      ".github/workflows/android-release.yml",
      ".github/workflows/openclaw-npm-release.yml",
      ".github/workflows/macos-release.yml",
      ".github/workflows/plugin-clawhub-release.yml",
      PACKAGE_ACCEPTANCE_WORKFLOW,
      ".github/workflows/plugin-npm-release.yml",
    ];

    for (const workflowPath of releaseWorkflowPaths) {
      const workflow = readWorkflow(workflowPath);
      expect(workflow.env?.NODE_VERSION, workflowPath).toBe("24.15.0");
      expect(workflow.env?.PNPM_VERSION, workflowPath).toBeUndefined();
    }

    expect(fullRelease.jobs?.release_checks?.["timeout-minutes"]).toBe(
      "${{ inputs.release_profile != 'minimum' && 240 || 60 }}",
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
});
