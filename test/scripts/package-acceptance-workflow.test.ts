// Package Acceptance Workflow tests cover package acceptance workflow script behavior.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PACKAGE_ACCEPTANCE_WORKFLOW = ".github/workflows/package-acceptance.yml";
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const NPM_TELEGRAM_WORKFLOW = ".github/workflows/npm-telegram-beta-e2e.yml";
const PACKAGE_JSON = "package.json";
const SETUP_PNPM_STORE_CACHE_ACTION = ".github/actions/setup-pnpm-store-cache/action.yml";
const DOCKER_E2E_PLAN_ACTION = ".github/actions/docker-e2e-plan/action.yml";
const RELEASE_CHECKS_WORKFLOW = ".github/workflows/openclaw-release-checks.yml";
const RELEASE_PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const FULL_RELEASE_VALIDATION_WORKFLOW = ".github/workflows/full-release-validation.yml";
const QA_LIVE_TRANSPORTS_WORKFLOW = ".github/workflows/qa-live-transports-convex.yml";
const UPDATE_MIGRATION_WORKFLOW = ".github/workflows/update-migration.yml";
const CI_CHECK_TESTBOX_WORKFLOW = ".github/workflows/ci-check-testbox.yml";
const CRABBOX_HYDRATE_WORKFLOW = ".github/workflows/crabbox-hydrate.yml";
const CRABBOX_CONFIG = ".crabbox.yaml";
const SCHEDULED_LIVE_CHECKS_WORKFLOW = ".github/workflows/openclaw-scheduled-live-checks.yml";
const TUI_PTY_WORKFLOW = ".github/workflows/tui-pty.yml";
const CI_HYDRATE_LIVE_AUTH_SCRIPT = "scripts/ci-hydrate-live-auth.sh";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";

type WorkflowStep = {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
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

function expectTextToIncludeAll(text: string | undefined, snippets: string[]): void {
  if (text === undefined) {
    throw new Error("Expected text to be defined before checking snippets");
  }
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

describe("package acceptance workflow", () => {
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
    expect(workflowStep(hydrate, "Setup Node.js").uses).toBe("actions/setup-node@v6");
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
    expect(workflowStep(hydrate, "Ensure Docker is running").if).toBeUndefined();
    expect(workflowStep(hydrate, "Ensure SSH is available").if).toBeUndefined();
    expect(workflowStep(hydrate, "Hydrate provider env helper").if).toBeUndefined();
    expect(workflowStep(hydrate, "Mark Crabbox ready").run).toContain("COREPACK_HOME");
    expect(workflowStep(hydrate, "Hydrate provider env helper").env).toBeUndefined();

    expect(hydrateWindowsDaemon.if).toBe("${{ inputs.crabbox_job == 'hydrate-windows-daemon' }}");
    expect(workflowStep(hydrateWindowsDaemon, "Setup Node.js").uses).toBe("actions/setup-node@v6");
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
    expect(workflowStep(hydrateGithub, "Hydrate provider env helper").env?.FACTORY_API_KEY).toBe(
      "${{ secrets.FACTORY_API_KEY }}",
    );
  });

  it("keeps default Crabbox capacity on the Azure credit-backed lane", () => {
    const crabboxConfig = parse(readFileSync(CRABBOX_CONFIG, "utf8")) as {
      aws?: { region?: string };
      capacity?: {
        availabilityZones?: string[];
        fallback?: string;
        market?: string;
        regions?: string[];
      };
      jobs?: {
        changed?: { command?: string; market?: string; shell?: boolean; type?: string };
        prewarm?: { market?: string; type?: string };
      };
      provider?: string;
      ssh?: { port?: string; user?: string };
    };

    expect(crabboxConfig.provider).toBe("azure");
    expect(crabboxConfig.capacity?.market).toBe("on-demand");
    expect(crabboxConfig.capacity?.fallback).toBeUndefined();
    expect(crabboxConfig.capacity?.regions).toBeUndefined();
    expect(crabboxConfig.capacity?.availabilityZones).toBeUndefined();
    expect(crabboxConfig.aws?.region).toBe("eu-west-1");
    expect(crabboxConfig.jobs?.prewarm?.market).toBe("on-demand");
    expect(crabboxConfig.jobs?.prewarm?.type).toBe("Standard_D4ads_v6");
    expect(crabboxConfig.jobs?.changed?.market).toBe("on-demand");
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
      '[[ "$CHILD_WORKFLOW_REF" == release-ci/* && -n "${TARGET_SHA// }" && "$head_sha" != "$TARGET_SHA" ]]',
    );
    expect(workflow).toContain(
      'gh_with_retry workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@"',
    );
    expect(workflow).toContain("child run used ${head_sha}, expected ${TARGET_SHA}");
    expect(workflow).toContain(
      "Dispatch Full Release Validation from a ref pinned to the target SHA",
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
    expect(pullHelper).toContain(
      'timeout --kill-after=30s "${timeout_seconds}s" docker pull "$image"',
    );
    expect(pullHelper).toContain("timeout --kill-after=1s 1s true >/dev/null 2>&1");
    expect(pullHelper).toContain('timeout "${timeout_seconds}s" docker pull "$image"');
    expect(pullHelper).toContain(
      "timeout command not found; cannot bound Docker pull after ${timeout_seconds}s",
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
    expect(workflow).toContain("inputs.live_suite_filter == 'live-gateway-advisory-docker'");
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
    expect(workflow).toContain("image: ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04");
    expect(workflow).toContain("ffmpeg -version | head -1");
    expect(workflow).toContain("ffprobe -version | head -1");
    expect(workflow).toContain("suite_id: native-live-extensions-media-audio");
    expect(workflow).toContain("suite_id: native-live-extensions-media-music-google");
    expect(workflow).toContain("suite_id: native-live-extensions-media-music-minimax");
    expect(workflow).toContain("suite_id: native-live-extensions-media-video");
    expect(workflow).toContain("suite_group: native-live-extensions-media-video");
    expect(workflow).toContain("OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS=google,minimax");
    expect(workflow).toContain("OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS=openai,openrouter,xai");
    expect(workflow).toContain("suite_group: native-live-src-gateway-profiles-opencode-go");
    expect(workflow).toContain("opencode-go/mimo-v2-omni");
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
      'timeout_value="${OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS:-180}s"',
    );
    expect(readFileSync("scripts/test-live-cli-backend-docker.sh", "utf8")).toContain(
      'echo "timeout command not found; cannot bound live CLI backend setup after ${timeout_value}"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_ACP_BIND_DOCKER_RUN_TIMEOUT:-2700s",
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS:-180",
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      'timeout_value="${OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS:-180}s"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      'echo "timeout command not found; cannot bound live ACP bind setup after ${timeout_value}"',
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      "run_setup_command npm install -g @anthropic-ai/claude-code",
    );
    expect(readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8")).toContain(
      "run_setup_command bash -lc 'curl -fsSL https://app.factory.ai/cli | sh'",
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_CODEX_HARNESS_DOCKER_RUN_TIMEOUT:-2100s",
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      "OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS:-180",
    );
    expect(readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8")).toContain(
      'timeout_value="${OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS:-180}s"',
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

    expect(hydrateScript).toContain("  FACTORY_API_KEY \\");
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
  });

  it("fails Testbox changed-check delegation when the remote command fails", () => {
    const workflow = readFileSync(CI_CHECK_TESTBOX_WORKFLOW, "utf8");
    const runTestboxStep = workflowJob(CI_CHECK_TESTBOX_WORKFLOW, "check").steps?.find(
      (step) => step.name === "Run Testbox",
    );

    expect(workflow).toContain('PNPM_CONFIG_STORE_DIR: "/tmp/openclaw-pnpm-store"');
    expect(workflow).not.toContain("PNPM_CONFIG_MODULES_DIR");
    expect(workflow).not.toContain("PNPM_CONFIG_VIRTUAL_STORE_DIR");
    expect(runTestboxStep?.uses).toContain("useblacksmith/run-testbox@");
    expect(runTestboxStep?.["continue-on-error"]).toBeUndefined();
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
    expect(workflow).toContain(
      "telegram_scenarios: telegram-help-command,telegram-commands-command,telegram-tools-compact-command,telegram-whoami-command,telegram-status-command,telegram-other-bot-command-gating,telegram-context-command,telegram-mentioned-message-reply,telegram-long-final-reuses-preview,telegram-mention-gating",
    );
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
    expect(workflow).toContain("- live-e2e");
    expect(workflow).toContain("- qa-live");
    expect(workflow).toContain("QA release-check lanes are advisory");
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
        `vars.OPENCLAW_RELEASE_QA_${channel}_LIVE_CI_ENABLED == 'true'`,
      );
      expect(qaWorkflow).not.toContain(`OPENCLAW_QA_${channel}_LIVE_CI_ENABLED`);
    }
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
    const preparePackageJob = workflowJob(
      FULL_RELEASE_VALIDATION_WORKFLOW,
      "prepare_release_package",
    );
    const npmTelegramJob = workflowJob(FULL_RELEASE_VALIDATION_WORKFLOW, "npm_telegram");
    const dispatchStep = workflowStep(npmTelegramJob, "Dispatch and monitor npm Telegram E2E");

    expect(workflow).toContain("CHILD_WORKFLOW_REF: ${{ github.ref_name }}");
    expect(workflow).toContain(
      'gh_with_retry workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@"',
    );
    expect(preparePackageJob.name).toBe("Prepare release package artifact");
    expect(preparePackageJob.needs).toEqual(["resolve_target", "docker_runtime_assets_preflight"]);
    expect(preparePackageJob.if).toContain("inputs.rerun_group == 'all'");
    expect(preparePackageJob.if).toContain("inputs.release_profile == 'full'");
    expect(preparePackageJob.if).toContain(
      "needs.docker_runtime_assets_preflight.result == 'success'",
    );
    expectTextToIncludeAll(
      workflowStep(preparePackageJob, "Resolve release package artifact").run,
      [
        "scripts/resolve-openclaw-package-candidate.mjs",
        "--source ref",
        '--package-ref "$PACKAGE_REF"',
        "release-package-under-test",
      ],
    );
    expect(npmTelegramJob.name).toBe("Run package Telegram E2E");
    expect(npmTelegramJob.needs).toEqual(["resolve_target", "prepare_release_package"]);
    expect(npmTelegramJob.if).toContain(
      "inputs.rerun_group == 'all' && inputs.release_profile == 'full'",
    );
    expect(dispatchStep.env).toEqual({
      CHILD_WORKFLOW_REF: "${{ github.ref_name }}",
      GH_TOKEN: "${{ github.token }}",
      PACKAGE_ARTIFACT_NAME: "${{ needs.prepare_release_package.outputs.artifact_name }}",
      PACKAGE_SPEC: "${{ inputs.npm_telegram_package_spec || inputs.release_package_spec }}",
      PREPARE_PACKAGE_RESULT: "${{ needs.prepare_release_package.result }}",
      PROVIDER_MODE: "${{ inputs.npm_telegram_provider_mode }}",
      SCENARIO: "${{ inputs.npm_telegram_scenario }}",
      TARGET_SHA: "${{ needs.resolve_target.outputs.sha }}",
    });
    expectTextToIncludeAll(dispatchStep.run, [
      'gh_with_retry workflow run npm-telegram-beta-e2e.yml --ref "$CHILD_WORKFLOW_REF" "${args[@]}"',
      'before_json="$(gh_with_retry run list --workflow npm-telegram-beta-e2e.yml',
      '-f harness_ref="$TARGET_SHA"',
      'args=(-f package_spec="${PACKAGE_SPEC:-openclaw@beta}"',
      'if [[ -z "${PACKAGE_SPEC// }" ]]; then',
      '-f package_artifact_name="$PACKAGE_ARTIFACT_NAME"',
      '-f package_artifact_run_id="${GITHUB_RUN_ID}"',
      '-f package_label="full-release-${TARGET_SHA:0:12}"',
      'args+=(-f scenario="$SCENARIO")',
    ]);
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
      "Package Telegram E2E: parent \\`release-package-under-test\\` artifact",
      "Package Telegram E2E: skipped unless \\`release_profile=full\\`, \\`release_package_spec\\`, or \\`npm_telegram_package_spec\\` is provided",
    ]);
    expect(releaseDocs).toContain(
      "Focused `npm-telegram` reruns require `release_package_spec` or",
    );
    expectTextToIncludeAll(fullReleaseDocs, [
      "pre-publish candidate",
      "cross_os_suite_filter",
      "QA release-check lanes are advisory",
      "silently skip that",
      "Telegram package lane",
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
      uses: "actions/download-artifact@v8",
      with: {
        name: "${{ inputs.package_artifact_name }}",
        path: ".artifacts/telegram-package-under-test",
      },
    });
    expect(releaseRunDownload).toEqual({
      if: "inputs.package_artifact_name != '' && inputs.package_artifact_run_id != ''",
      name: "Download package-under-test artifact from release run",
      uses: "actions/download-artifact@v8",
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
      'export OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ="${package_tgzs[0]}"',
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
    const qaWorkflow = readFileSync(QA_LIVE_TRANSPORTS_WORKFLOW, "utf8");
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
    ]) {
      expect(qaWorkflow).toMatch(
        new RegExp(`${jobName}:[\\s\\S]*?runs-on: blacksmith-8vcpu-ubuntu-2404`, "u"),
      );
    }
    expectTextToIncludeAll(liveE2eWorkflow, [
      "OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=180000",
      "OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=600000",
    ]);
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

    expect(workflow).toContain("timeout-minutes: 60");
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
    expect(workflow).toContain("Checkout release SHA");
    expect(workflow).toContain('git show "${TARGET_SHA}:CHANGELOG.md" > "${changelog_file}"');
    expect(workflow).toContain('$0 == "## Unreleased" { in_section = 1; next }');
    expect(workflow).toContain("Unreleased prerelease fallback");
    expect(workflow).not.toContain("gh api --repo");
    expect(workflow).not.toContain("timeout-minutes: 360");
  });

  it("keeps beta release verification and ClawHub publish repair hooks wired", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const releaseWorkflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const clawHubWorkflow = readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8");
    const pluginNpmWorkflow = readFileSync(".github/workflows/plugin-npm-release.yml", "utf8");
    const openclawNpmWorkflow = readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8");
    const approvalScript = readFileSync("scripts/validate-release-publish-approval.mjs", "utf8");

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
    expect(clawHubWorkflow).toContain("Verify published ClawHub package");
    expect(clawHubWorkflow).toContain("bun install failed while preparing ClawHub CLI; retrying");
    expect(clawHubWorkflow).toContain("max-parallel: 32");
    expect(releaseWorkflow).toContain("Plugin npm run ID");
    expect(releaseWorkflow).toContain("Plugin ClawHub run ID");
    expect(releaseWorkflow).toContain("OpenClaw npm run ID");
    expect(releaseWorkflow).toContain("npm_telegram_run_id");
    expect(releaseWorkflow).toContain('release_publish_run_id="${GITHUB_RUN_ID}"');
    expect(releaseWorkflow).toContain("append_release_proof_to_github_release");
    expect(releaseWorkflow).toContain("registry tarball");
    expect(releaseWorkflow).toContain("not awaited by this proof");
    expect(releaseWorkflow).toContain("wait_for_job_success");
    expect(releaseWorkflow).toContain("Validate release publish approval");
    expect(releaseWorkflow).toContain('conclusion" == "skipped"');
    expect(releaseWorkflow).toContain("approve_child_publish_environment");
    expect(releaseWorkflow).toContain("Approve child release gate after parent release approval");
    expect(releaseWorkflow).toContain("release:verify-beta");
    expect(releaseWorkflow).toContain('--workflow-ref "${CHILD_WORKFLOW_REF}"');
    expect(releaseWorkflow).toContain('verify_args+=(--plugins "${PLUGINS}")');
    expect(releaseWorkflow).toContain("openclaw-release-postpublish-evidence");
    expect(releaseWorkflow).toContain("Failed child job summary");
    expect(releaseWorkflow).toContain("Workflow completion waits for ClawHub");
    expect(releaseWorkflow).toContain("Workflow completion does not wait for ClawHub");
    expect(releaseWorkflow).toContain('[[ "${WAIT_FOR_CLAWHUB}" == "true" ]]');
    expect(releaseWorkflow).toContain("--skip-clawhub");
    expect(pluginNpmWorkflow).toContain("Validate release publish approval run");
    expect(clawHubWorkflow).toContain("Validate release publish approval run");
    expect(openclawNpmWorkflow).toContain("Validate release publish approval run");
    expect(pluginNpmWorkflow).toContain("Check npm package version");
    expect(pluginNpmWorkflow).toContain("already_published=true");
    expect(pluginNpmWorkflow).toContain(
      "steps.npm_package_version.outputs.already_published != 'true'",
    );
    expect(clawHubWorkflow).toContain("Check ClawHub package version");
    expect(clawHubWorkflow).toContain("already_published=true");
    expect(clawHubWorkflow).toContain(
      "steps.clawhub_package_version.outputs.already_published != 'true'",
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
    expect(clawHubWorkflow).toContain("environment: clawhub-plugin-release");
    expect(openclawNpmWorkflow).toContain("environment: npm-release");
    expect(releaseWorkflow).toContain("default: from-validation");
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
      releaseWorkflow.indexOf('if [[ -n "${clawhub_pid}" ]] && ! wait "${clawhub_pid}"'),
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
    expect(fullRelease.jobs?.prepare_release_package?.["timeout-minutes"]).toBe(15);
    expect(releaseChecks.jobs?.prepare_release_package?.["timeout-minutes"]).toBe(15);
    expect(crossOs.jobs?.cross_os_release_checks?.["timeout-minutes"]).toBe(60);
    expect(liveE2e.jobs?.validate_release_live_cache?.["timeout-minutes"]).toBe(20);
    expect(readFileSync(LIVE_E2E_WORKFLOW, "utf8")).toContain(
      "timeout --foreground --kill-after=30s 8m pnpm test:live:cache",
    );
    expect(readFileSync(LIVE_E2E_WORKFLOW, "utf8")).toContain("live-cache attempt ${attempt}/2");
  });

  it("kills timed TUI PTY workflow runs after the grace period", () => {
    const job = workflowJob(TUI_PTY_WORKFLOW, "tui-pty");
    const step = workflowStep(job, "Run TUI PTY tests");

    expect(job.env?.OPENCLAW_TUI_PTY_INCLUDE_LOCAL).toBe("1");
    expect(job["timeout-minutes"]).toBe(8);
    expect(step.run).toBe(
      "timeout --kill-after=30s 240s node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts",
    );
  });
});
