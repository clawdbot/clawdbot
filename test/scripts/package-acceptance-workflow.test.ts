import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PACKAGE_ACCEPTANCE_WORKFLOW = ".github/workflows/package-acceptance.yml";
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const NPM_TELEGRAM_WORKFLOW = ".github/workflows/npm-telegram-beta-e2e.yml";
const PACKAGE_JSON = "package.json";
const RELEASE_CHECKS_WORKFLOW = ".github/workflows/openclaw-release-checks.yml";
const RELEASE_PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const FULL_RELEASE_VALIDATION_WORKFLOW = ".github/workflows/full-release-validation.yml";
const QA_LIVE_TRANSPORTS_WORKFLOW = ".github/workflows/qa-live-transports-convex.yml";
const UPDATE_MIGRATION_WORKFLOW = ".github/workflows/update-migration.yml";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
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
    expect(workflow).toContain("- artifact");
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
    expect(workflow).toContain("--json status,conclusion,url,attempt,headSha,jobs");
    expect(workflow).toContain(
      '[[ "$CHILD_WORKFLOW_REF" == release-ci/* && -n "${TARGET_SHA// }" && "$head_sha" != "$TARGET_SHA" ]]',
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

    expect(pullHelper).toContain("OPENCLAW_DOCKER_PULL_ATTEMPTS");
    expect(pullHelper).toContain("OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS");
    expect(pullHelper).toContain('timeout_seconds="${OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS:-180}"');
    expect(pullHelper).toContain(
      'retry_delay_seconds="${OPENCLAW_DOCKER_PULL_RETRY_DELAY_SECONDS:-5}"',
    );
    expect(pullHelper).toContain(
      'timeout --foreground --kill-after=30s "${timeout_seconds}s" docker pull "$image"',
    );
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
    expect(workflow).toMatch(
      /validate_repo_e2e:[\s\S]*?runs-on: \$\{\{ github\.event_name == 'workflow_call' && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
    );
    expect(workflow).toMatch(
      /validate_special_e2e:[\s\S]*?runs-on: \$\{\{ github\.event_name == 'workflow_call' && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
    );
    expect(workflow).toMatch(
      /validate_live_provider_suites:[\s\S]*?runs-on: \$\{\{ github\.event_name == 'workflow_call' && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
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
    expect(workflow).toContain("anthropic/claude-opus-4-7,anthropic/claude-opus-4-6");
    expect(workflow).toContain("anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5");
    expect(workflow).toMatch(
      /suite_id: native-live-src-gateway-profiles-fireworks[\s\S]*?advisory: true/u,
    );
    expect(workflow).toMatch(
      /suite_id: native-live-src-gateway-profiles-openai[\s\S]*?timeout_minutes: 60[\s\S]*?profiles: beta minimum stable full/u,
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
    expect(workflow).toContain("timeout --foreground --kill-after=30s 25m");
    expect(workflow).toContain("suite_id: native-live-extensions-a-k");
    expect(workflow).toContain("suite_id: native-live-extensions-l-n");
    expect(workflow).toContain("suite_id: native-live-extensions-moonshot");
    expect(workflow).toMatch(/suite_id: native-live-extensions-moonshot[\s\S]*?advisory: true/u);
    expect(workflow).toContain("OPENCLAW_LIVE_SUITE_ADVISORY: ${{ matrix.advisory }}");
    expect(workflow).toContain("Advisory live suite failed with exit code");
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
      /validate_live_media_provider_suites:[\s\S]*?runs-on: \$\{\{ github\.event_name == 'workflow_call' && 'ubuntu-24\.04' \|\| 'blacksmith-8vcpu-ubuntu-2404' \}\}/u,
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
  });

  it("runs Docker live harnesses from trusted helper scripts", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW, "utf8");
    const scenarios = readFileSync("scripts/lib/docker-e2e-scenarios.mjs", "utf8");
    const scheduler = readFileSync("scripts/test-docker-all.mjs", "utf8");
    const harness = readFileSync("scripts/test-live-codex-harness-docker.sh", "utf8");
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
      "command: OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai OPENCLAW_LIVE_GATEWAY_MAX_MODELS=2",
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
    expect(scenarios).toContain(
      "if [ -d .release-harness/scripts ]; then harness=.release-harness",
    );
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-models-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-gateway-models-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-cli-backend-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-acp-bind-docker\.sh"/u);
    expect(scenarios).toMatch(/liveDockerScriptCommand\(\s*"test-live-codex-harness-docker\.sh"/u);
    expect(scenarios).toMatch(
      /liveDockerScriptCommand\(\s*"test-live-subagent-announce-docker\.sh"/u,
    );
    expect(scheduler).toContain("function liveDockerHarnessScriptCommand");
    expect(scheduler).toContain('liveDockerHarnessScriptCommand("test-live-build-docker.sh")');
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
    for (const script of sharedLiveScripts) {
      expect(script).toContain('source "$TRUSTED_HARNESS_DIR/scripts/lib/live-docker-auth.sh"');
      expect(script).not.toContain('source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"');
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
    expect(build).toContain('ROOT_DIR="${OPENCLAW_LIVE_DOCKER_REPO_ROOT:-$SCRIPT_ROOT_DIR}"');
    expect(build).toContain('source "$SCRIPT_ROOT_DIR/scripts/lib/docker-build.sh"');
    expect(stage).toContain(
      'local scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"',
    );
    expect(stage).toContain('node --import tsx "$scripts_dir/live-docker-normalize-config.ts"');
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
      "docker_lanes: doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update",
    );
    expect(workflow).toContain(
      "published_upgrade_survivor_baselines: ${{ needs.resolve_target.outputs.run_release_soak == 'true' && 'last-stable-4 2026.4.23 2026.5.2 2026.4.15' || '' }}",
    );
    expect(workflow).toContain(
      "published_upgrade_survivor_scenarios: ${{ needs.resolve_target.outputs.run_release_soak == 'true' && 'reported-issues' || '' }}",
    );
    expect(workflow).toContain("telegram_mode: mock-openai");
    expect(workflow).toContain(
      "telegram_scenarios: telegram-help-command,telegram-commands-command,telegram-tools-compact-command,telegram-whoami-command,telegram-status-command,telegram-other-bot-command-gating,telegram-context-command,telegram-mentioned-message-reply,telegram-reply-chain-exact-marker,telegram-stream-final-single-message,telegram-long-final-reuses-preview,telegram-mention-gating",
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
    expect(workflow).toContain("needs: [resolve_package, docker_acceptance, package_telegram]");
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
    expect(workflow).toContain('gh workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@"');
    expect(preparePackageJob.name).toBe("Prepare release package artifact");
    expect(preparePackageJob.needs).toEqual(["resolve_target"]);
    expect(preparePackageJob.if).toContain("inputs.rerun_group == 'all'");
    expect(preparePackageJob.if).toContain("inputs.release_profile == 'full'");
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
      'gh workflow run npm-telegram-beta-e2e.yml --ref "$CHILD_WORKFLOW_REF" "${args[@]}"',
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
      "cancel-in-progress: ${{ inputs.ref == 'main' && inputs.rerun_group == 'all' }}",
      "gh run cancel",
      "NORMAL_CI_RESULT: ${{ needs.normal_ci.result }}",
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

  it("keeps release QA and repo E2E lanes off scarce 32-core runners", () => {
    const releaseChecksWorkflow = readFileSync(RELEASE_CHECKS_WORKFLOW, "utf8");
    const qaWorkflow = readFileSync(QA_LIVE_TRANSPORTS_WORKFLOW, "utf8");

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
  });

  it("summarizes queue time separately from execution time in full validation", () => {
    const workflow = readFileSync(FULL_RELEASE_VALIDATION_WORKFLOW, "utf8");

    expect(workflow).toContain("### Slowest jobs: ${label}");
    expect(workflow).toContain("### Longest queues: ${label}");
    expect(workflow).toContain("Write release validation manifest");
    expect(workflow).toContain("Upload release validation manifest");
    expect(workflow).toContain("Failed child detail: ${label}");
    expect(workflow).toContain("actions/runs/${run_id}/artifacts?per_page=100");
    expect(workflow).toContain("full-release-validation-${{ github.run_id }}");
    expect(workflow).toContain("| Job | Result | Queue minutes | Run minutes |");
    expect(workflow).toContain(
      'gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100"',
    );
    expect(workflow).toContain("(.started_at | ts) - (.created_at | ts)");
    expect(workflow).not.toContain('gh run view "$run_id" --json createdAt,jobs');
  });

  it("keeps release publish creation compatible with gh api and prerelease notes", () => {
    const workflow = readFileSync(RELEASE_PUBLISH_WORKFLOW, "utf8");
    const npmWorkflow = readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8");

    expect(workflow).toContain("timeout-minutes: 60");
    expect(workflow).toContain("Download OpenClaw npm preflight manifest");
    expect(workflow).toContain("Validate OpenClaw npm preflight manifest");
    expect(workflow).toContain("Download full release validation manifest");
    expect(workflow).toContain("Validate full release validation manifest");
    expect(workflow).toContain("full_release_validation_run_id");
    expect(workflow).toContain(
      "Full release validation must run rerun_group=all before npm publish",
    );
    expect(workflow).toContain("preflight-manifest.json");
    expect(npmWorkflow).toContain("preflight-manifest.json");
    expect(npmWorkflow).toContain("Verify full release validation run metadata");
    expect(npmWorkflow).toContain("Verify full release validation target");
    expect(npmWorkflow).toContain("full_release_validation_run_id");
    expect(npmWorkflow).toContain("Real publish requires full_release_validation_run_id");
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
    expect(releaseWorkflow).toContain("Approve release gate from OpenClaw Release Publish wrapper");
    expect(releaseWorkflow).toContain("release:verify-beta");
    expect(releaseWorkflow).toContain('--workflow-ref "${CHILD_WORKFLOW_REF}"');
    expect(releaseWorkflow).toContain('verify_args+=(--plugins "${PLUGINS}")');
    expect(releaseWorkflow).toContain("openclaw-release-postpublish-evidence");
    expect(releaseWorkflow).toContain("Failed child job summary");
    expect(releaseWorkflow).toContain("final verification waits for ClawHub");
    expect(releaseWorkflow).toContain(
      '[[ "${WAIT_FOR_CLAWHUB}" == "true" || "${PUBLISH_OPENCLAW_NPM}" == "true" ]]',
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
      if (workflow.env?.PNPM_VERSION !== undefined) {
        expect(workflow.env.PNPM_VERSION, workflowPath).toBe("11.0.8");
      }
    }

    expect(fullRelease.jobs?.release_checks?.["timeout-minutes"]).toBe(
      "${{ inputs.release_profile == 'full' && 240 || 60 }}",
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
});
