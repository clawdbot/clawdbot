import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HELPER_PATH = "scripts/lib/docker-build.sh";
const DOCKER_ALL_SCHEDULER_PATH = "scripts/test-docker-all.mjs";
const DOCKER_E2E_IMAGE_HELPER_PATH = "scripts/lib/docker-e2e-image.sh";
const DOCKER_E2E_SCENARIOS_PATH = "scripts/lib/docker-e2e-scenarios.mjs";
const INSTALL_E2E_RUNNER_PATH = "scripts/docker/install-sh-e2e/run.sh";
const LIVE_CLI_BACKEND_DOCKER_PATH = "scripts/test-live-cli-backend-docker.sh";
const LIVE_BUILD_DOCKER_PATH = "scripts/test-live-build-docker.sh";
const OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH = "scripts/e2e/openai-web-search-minimal-docker.sh";
const OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH =
  "scripts/e2e/lib/openai-web-search-minimal/scenario.sh";
const OPENAI_WEB_SEARCH_MINIMAL_CLIENT_PATH =
  "scripts/e2e/lib/openai-web-search-minimal/client.mjs";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_E2E_PATH =
  "scripts/e2e/bundled-plugin-install-uninstall-docker.sh";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_SWEEP_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_PROBE_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_RUNTIME_SMOKE_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs";
const PLUGINS_DOCKER_E2E_PATH = "scripts/e2e/plugins-docker.sh";
const PLUGINS_DOCKER_SWEEP_PATH = "scripts/e2e/lib/plugins/sweep.sh";
const PLUGINS_DOCKER_MARKETPLACE_PATH = "scripts/e2e/lib/plugins/marketplace.sh";
const PLUGINS_DOCKER_CLAWHUB_PATH = "scripts/e2e/lib/plugins/clawhub.sh";
const PLUGINS_DOCKER_ASSERTIONS_PATH = "scripts/e2e/lib/plugins/assertions.mjs";
const PLUGINS_DOCKER_NPM_REGISTRY_PATH = "scripts/e2e/lib/plugins/npm-registry-server.mjs";
const PLUGIN_UPDATE_DOCKER_E2E_PATH = "scripts/e2e/plugin-update-unchanged-docker.sh";
const PLUGIN_UPDATE_SCENARIO_PATH = "scripts/e2e/lib/plugin-update/unchanged-scenario.sh";
const PLUGIN_UPDATE_PROBE_PATH = "scripts/e2e/lib/plugin-update/probe.mjs";
const DOCTOR_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/doctor-install-switch-docker.sh";
const DOCTOR_SWITCH_SCENARIO_PATH = "scripts/e2e/lib/doctor-install-switch/scenario.sh";
const PACKAGE_COMPAT_PATH = "scripts/e2e/lib/package-compat.mjs";
const UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/update-channel-switch-docker.sh";
const UPDATE_CHANNEL_SWITCH_ASSERTIONS_PATH =
  "scripts/e2e/lib/update-channel-switch/assertions.mjs";
const CENTRALIZED_BUILD_SCRIPTS = [
  "scripts/docker/setup.sh",
  "scripts/e2e/browser-cdp-snapshot-docker.sh",
  "scripts/e2e/qr-import-docker.sh",
  "scripts/lib/docker-e2e-image.sh",
  "scripts/sandbox-browser-setup.sh",
  "scripts/sandbox-common-setup.sh",
  "scripts/sandbox-setup.sh",
  "scripts/test-cleanup-docker.sh",
  "scripts/test-install-sh-docker.sh",
  "scripts/test-install-sh-e2e-docker.sh",
  "scripts/test-live-build-docker.sh",
] as const;

describe("docker build helper", () => {
  it("forces BuildKit for centralized Docker builds", () => {
    const helper = readFileSync(HELPER_PATH, "utf8");

    expect(helper).toContain("DOCKER_BUILDKIT=1");
    expect(helper).toContain("docker_build_exec()");
    expect(helper).toContain("docker_build_run()");
    expect(helper).toContain("docker buildx build --load");
    expect(helper).toContain("docker_build_transient_failure()");
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_RETRIES");
    expect(helper).toContain("frontend grpc server closed unexpectedly");
  });

  it("keeps shell-script Docker builds behind the helper", () => {
    for (const path of CENTRALIZED_BUILD_SCRIPTS) {
      const script = readFileSync(path, "utf8");

      expect(script, path).toMatch(/docker-build\.sh|docker-e2e-image\.sh/);
      expect(script, path).not.toMatch(/\bdocker build\b/);
      expect(script, path).not.toMatch(/run_logged\s+\S+\s+docker\s+build/);
    }
  });

  it("lets Testbox fall back to building when a reused Docker image is missing", () => {
    const helper = readFileSync(HELPER_PATH, "utf8");
    const e2eImageHelper = readFileSync(DOCKER_E2E_IMAGE_HELPER_PATH, "utf8");
    const liveBuild = readFileSync(LIVE_BUILD_DOCKER_PATH, "utf8");
    const liveCliBackend = readFileSync(LIVE_CLI_BACKEND_DOCKER_PATH, "utf8");

    expect(helper).toContain("docker_build_on_missing_enabled()");
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_ON_MISSING");
    expect(helper).toContain("OPENCLAW_TESTBOX");
    expect(e2eImageHelper).toContain("docker_build_on_missing_enabled");
    expect(e2eImageHelper).toContain("Docker image not available; building");
    expect(liveBuild).toContain("docker image inspect");
    expect(liveBuild).toContain("docker pull");
    expect(liveBuild).toContain("Live-test image not available; building");
    expect(liveCliBackend).toContain(
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"',
    );
    expect(liveCliBackend).not.toContain(
      'echo "==> Reuse live-test image: $LIVE_IMAGE_NAME (OPENCLAW_SKIP_DOCKER_BUILD=1)"',
    );
  });

  it("includes procps in the shared Docker E2E image for process watchdogs", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");

    expect(dockerfile).toContain("procps");
  });

  it("preserves pnpm lookup paths for scheduled Docker child lanes", () => {
    const scheduler = readFileSync(DOCKER_ALL_SCHEDULER_PATH, "utf8");

    expect(scheduler).toContain("env.PNPM_HOME");
    expect(scheduler).toContain("env.npm_execpath ? path.dirname(env.npm_execpath)");
    expect(scheduler).toContain("path.dirname(process.execPath)");
    expect(scheduler).toContain("env.PATH = [...new Set(pathEntries)].join(path.delimiter)");
    expect(scheduler).toContain("withResolvedPnpmCommand");
    expect(scheduler).toContain("OPENCLAW_DOCKER_ALL_PNPM_COMMAND");
  });

  it("runs release installer E2E against the npm beta tag", () => {
    const scenarios = readFileSync(DOCKER_E2E_SCENARIOS_PATH, "utf8");

    expect(scenarios).toContain(
      '"OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=openai OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-openai:local pnpm test:install:e2e"',
    );
    expect(scenarios).toContain(
      '"OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=anthropic OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-anthropic:local pnpm test:install:e2e"',
    );
  });

  it("times and parallelizes release installer E2E agent turns after gateway startup", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const wrapper = readFileSync("scripts/test-install-sh-e2e-docker.sh", "utf8");

    expect(runner).toContain(
      'AGENT_TURNS_PARALLEL="${OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL:-1}"',
    );
    expect(runner).toContain("time_phase");
    expect(runner).toContain("phase_mark_start");
    expect(runner).toContain("run_agent_turn_bg");
    expect(runner).toContain("wait_agent_turn_batch");
    expect(runner).toContain('run_agent_turn_bg "read proof"');
    expect(runner).toContain('run_agent_turn_bg "image write"');
    expect(runner).toContain('run_agent_turn_logged "read proof copy"');
    expect(wrapper).toContain("OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL");
  });

  it("keeps package acceptance plugin coverage offline-capable", () => {
    const scenarios = readFileSync(DOCKER_E2E_SCENARIOS_PATH, "utf8");

    expect(scenarios).toContain('"plugins-offline"');
    expect(scenarios).toContain("`bundled-plugin-install-uninstall-${index}`");
    expect(scenarios).toContain("pnpm test:docker:bundled-plugin-install-uninstall");
    expect(scenarios).toContain("OPENCLAW_PLUGINS_E2E_CLAWHUB=0");
  });

  it("allows plugin update smoke to tolerate config metadata migrations", () => {
    const runner = readFileSync(PLUGIN_UPDATE_DOCKER_E2E_PATH, "utf8");
    const scenario = readFileSync(PLUGIN_UPDATE_SCENARIO_PATH, "utf8");
    const probe = readFileSync(PLUGIN_UPDATE_PROBE_PATH, "utf8");

    expect(runner).toContain("scripts/e2e/lib/plugin-update/unchanged-scenario.sh");
    expect(probe).toContain("plugin install record changed unexpectedly");
    expect(probe).toContain("index.installRecords ?? index.records ?? config.plugins?.installs");
    expect(scenario).toContain("Config changed unexpectedly for modern package");
    expect(scenario).not.toContain("before_hash");
  });

  it("caps package acceptance legacy compatibility at 2026.4.25", () => {
    const doctorScenario = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");
    const updateChannel = readFileSync(UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH, "utf8");
    const pluginsSweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const pluginsMarketplace = readFileSync(PLUGINS_DOCKER_MARKETPLACE_PATH, "utf8");
    const pluginsClawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");
    const pluginsAssertions = readFileSync(PLUGINS_DOCKER_ASSERTIONS_PATH, "utf8");
    const pluginUpdateScenario = readFileSync(PLUGIN_UPDATE_SCENARIO_PATH, "utf8");
    const pluginUpdateProbe = readFileSync(PLUGIN_UPDATE_PROBE_PATH, "utf8");
    const updateChannelAssertions = readFileSync(UPDATE_CHANNEL_SWITCH_ASSERTIONS_PATH, "utf8");
    const packageCompat = readFileSync(PACKAGE_COMPAT_PATH, "utf8");
    const scripts = [
      doctorScenario,
      updateChannel,
      updateChannelAssertions,
      pluginsSweep,
      pluginsMarketplace,
      pluginsClawhub,
      pluginsAssertions,
      pluginUpdateScenario,
      pluginUpdateProbe,
    ];

    expect(readFileSync(DOCTOR_SWITCH_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/doctor-install-switch/scenario.sh",
    );
    expect(readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/plugins/sweep.sh",
    );
    expect(readFileSync(PLUGIN_UPDATE_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/plugin-update/unchanged-scenario.sh",
    );
    expect(packageCompat).toContain("day <= 25");
    expect(doctorScenario).toContain("scripts/e2e/lib/package-compat.mjs");
    expect(pluginsSweep).toContain("scripts/e2e/lib/package-compat.mjs");
    expect(pluginUpdateProbe).toContain("../package-compat.mjs");
    expect(scripts.join("\n")).toContain("OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT");
    expect(scripts.join("\n")).toContain(
      "Package $package_version must support gateway install --wrapper.",
    );
    expect(updateChannel).toContain("assert-config-channel dev");
    expect(updateChannelAssertions).toContain("expected persisted update.channel ${channel}");
    expect(pluginsAssertions).toContain("expected modern installRecords in installed plugin index");
  });

  it("keeps bundled plugin install/uninstall sweep chunkable", () => {
    const runner = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_E2E_PATH, "utf8");
    const sweep = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_SWEEP_PATH, "utf8");
    const probe = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_PROBE_PATH, "utf8");
    const runtimeSmoke = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_RUNTIME_SMOKE_PATH, "utf8");

    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL");
    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX");
    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS");
    expect(runner).toContain("scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh");
    expect(probe).toContain('"openclaw.plugin.json"');
    expect(runtimeSmoke).toContain("process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS");
    expect(runtimeSmoke).toContain("900000");
    expect(sweep).toContain("read -r plugin_id plugin_dir requires_config");
    expect(sweep).toContain('node "$OPENCLAW_ENTRY" plugins install "$plugin_id"');
    expect(sweep).toContain('node "$OPENCLAW_ENTRY" plugins uninstall "$plugin_id" --force');
    expect(sweep).toContain("assert-installed");
    expect(sweep).toContain("assert-uninstalled");
  });

  it("passes installer tag env to bash, not curl", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('curl -fsSL "$INSTALL_URL" | OPENCLAW_BETA=1 bash');
    expect(runner).toContain('curl -fsSL "$INSTALL_URL" | OPENCLAW_VERSION="$INSTALL_TAG" bash');
    expect(runner).not.toContain('OPENCLAW_BETA=1 curl -fsSL "$INSTALL_URL" | bash');
    expect(runner).not.toContain(
      'OPENCLAW_VERSION="$INSTALL_TAG" curl -fsSL "$INSTALL_URL" | bash',
    );
  });

  it("keeps installer E2E agent turns out of the interactive bootstrap ritual", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('rm -f "$workspace/BOOTSTRAP.md"');
    expect(runner.indexOf('rm -f "$workspace/BOOTSTRAP.md"')).toBeLessThan(
      runner.indexOf('phase_mark_start "Agent turns ($profile)"'),
    );
  });

  it("keeps installer E2E tool smokes in isolated sessions", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('SESSION_ID_PREFIX="e2e-tools-${profile}"');
    expect(runner).toContain('TURN1_SESSION_ID="${SESSION_ID_PREFIX}-read-proof"');
    expect(runner).toContain('TURN3_SESSION_ID="${SESSION_ID_PREFIX}-exec-hostname"');
    expect(runner).toContain('TURN4_SESSION_ID="${SESSION_ID_PREFIX}-image-write"');
  });

  it("keeps OpenAI web search smoke on one gateway agent connection", () => {
    const runner = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH, "utf8");
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");
    const client = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_CLIENT_PATH, "utf8");

    expect(runner).toContain("scripts/e2e/lib/openai-web-search-minimal/scenario.sh");
    expect(scenario).toContain("scripts/e2e/lib/openai-web-search-minimal/client.mjs");
    expect(client).toContain("const callGateway = await loadCallGateway();");
    expect(client).toContain('method: "agent"');
    expect(client).toContain("expectFinal: true");
    expect(client).toContain('scopes: ["operator.write"]');
    expect(client).not.toContain('"agent.wait"');
  });

  it("keeps ClawHub plugin Docker smoke hermetic by default", () => {
    const runner = readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8");
    const sweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const clawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");

    expect(runner).toContain("scripts/e2e/lib/plugins/sweep.sh");
    expect(sweep).toContain("scripts/e2e/lib/plugins/clawhub.sh");
    expect(clawhub).toContain("start_clawhub_fixture_server()");
    expect(clawhub).toContain('OPENCLAW_CLAWHUB_URL="http://127.0.0.1:');
    expect(clawhub).toContain("live ClawHub can rate-limit CI");
    expect(clawhub).toContain('[[ -z "${OPENCLAW_CLAWHUB_URL:-}" && -z "${CLAWHUB_URL:-}" ]]');
  });

  it("covers plugin install/update sources in the Docker plugin sweep", () => {
    const sweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const clawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");
    const assertions = readFileSync(PLUGINS_DOCKER_ASSERTIONS_PATH, "utf8");
    const npmRegistry = readFileSync(PLUGINS_DOCKER_NPM_REGISTRY_PATH, "utf8");

    expect(sweep).toContain('plugins install "$dir_plugin"');
    expect(sweep).toContain("plugins update demo-plugin-dir");
    expect(assertions).toContain('Skipping "demo-plugin-dir" (source: path).');

    expect(sweep).toContain("start_npm_fixture_registry");
    expect(sweep).toContain('plugins install "npm:@openclaw/demo-plugin-npm@0.0.1"');
    expect(sweep).toContain("plugins update demo-plugin-npm");
    expect(assertions).toContain("demo-plugin-npm is up to date (0.0.1).");
    expect(npmRegistry).toContain('"dist-tags": { latest: entry.version }');
    expect(npmRegistry).toContain("packageArgs.length % 3");

    expect(sweep).toContain('plugins install "git:$git_update_repo_url@main"');
    expect(sweep).toContain("plugins update demo-plugin-git-update");
    expect(assertions).toContain("demo.git.update.v2");

    expect(clawhub).toContain('plugins install "$CLAWHUB_PLUGIN_SPEC"');
    expect(clawhub).toContain('plugins update "$CLAWHUB_PLUGIN_ID"');
    expect(assertions).toContain("clawhub-updated");
  });
});
