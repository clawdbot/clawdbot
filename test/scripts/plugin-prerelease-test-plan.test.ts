import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findLaneByName } from "../../scripts/lib/docker-e2e-plan.mjs";
import { BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS } from "../../scripts/lib/docker-e2e-scenarios.mjs";
import {
  PLUGIN_PRERELEASE_REQUIRED_SURFACES,
  assertPluginPrereleaseTestPlanComplete,
  createPluginPrereleaseTestPlan,
} from "../../scripts/lib/plugin-prerelease-test-plan.mjs";

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

function readFullReleaseValidationWorkflow() {
  return parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
}

function readPluginPrereleaseWorkflow() {
  return parse(readFileSync(".github/workflows/plugin-prerelease.yml", "utf8"));
}

describe("scripts/lib/plugin-prerelease-test-plan.mjs", () => {
  it("covers every pre-release plugin skill surface in the plugin prerelease plan", () => {
    const plan = assertPluginPrereleaseTestPlanComplete();

    expect(plan.surfaces).toEqual(
      [...PLUGIN_PRERELEASE_REQUIRED_SURFACES].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("runs the package and Docker product lanes through the existing scheduler", () => {
    const plan = createPluginPrereleaseTestPlan();

    expect(plan.dockerLanes).toEqual([
      "npm-onboard-channel-agent",
      "doctor-switch",
      "update-channel-switch",
      "plugins-offline",
      "plugins",
      "kitchen-sink-plugin",
      "plugin-update",
      "config-reload",
      "gateway-network",
      "mcp-channels",
      "cron-mcp-cleanup",
      ...Array.from(
        { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
        (_, index) => `bundled-plugin-install-uninstall-${index}`,
      ),
    ]);

    for (const lane of plan.dockerLanes) {
      expect(findLaneByName(lane), lane).toBeTruthy();
    }
  });

  it("keeps live-ish coverage outside provider-backed Docker lanes", () => {
    const plan = createPluginPrereleaseTestPlan();

    expect(plan.dockerLanes).not.toContain("openai-web-search-minimal");
    expect(plan.dockerLanes.some((lane) => lane.startsWith("live-"))).toBe(false);
    expect(plan.staticChecks).toContainEqual({
      check: "live-ish-availability",
      checkName: "checks-plugin-prerelease-live-ish-availability",
      command: "node scripts/plugin-prerelease-liveish-matrix.mjs",
      surfaces: ["live-ish-availability"],
    });
  });

  it("keeps SDK/package boundary checks inside the plugin prerelease suite", () => {
    const plan = createPluginPrereleaseTestPlan();

    expect(plan.staticChecks.map((check) => check.checkName)).toEqual([
      "checks-plugin-prerelease-package-boundary-compile",
      "checks-plugin-prerelease-package-boundary-canary",
      "checks-plugin-prerelease-live-ish-availability",
    ]);
  });

  it("uses kitchen-sink npm and ClawHub scenarios as the registry install canary", () => {
    const lane = findLaneByName("kitchen-sink-plugin");
    const script = readFileSync("scripts/e2e/kitchen-sink-plugin-docker.sh", "utf8");
    const sweepScript = readFileSync("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh", "utf8");
    const assertionsScript = readFileSync(
      "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs",
      "utf8",
    );

    expect(lane).toEqual(
      expect.objectContaining({
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:kitchen-sink-plugin",
        e2eImageKind: "functional",
        name: "kitchen-sink-plugin",
        resources: expect.arrayContaining(["npm"]),
        stateScenario: "empty",
      }),
    );
    expect(script).toContain("npm:@openclaw/kitchen-sink@latest");
    expect(script).toContain("npm-latest-conformance");
    expect(script).toContain("npm-latest-adversarial");
    expect(script).toContain("npm:@openclaw/kitchen-sink@beta");
    expect(script).toContain("clawhub:openclaw-kitchen-sink@latest");
    expect(script).toContain("clawhub:openclaw-kitchen-sink@beta");
    expect(script).toContain("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh");
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_SPEC"');
    expect(sweepScript).toContain("KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain("OPENCLAW_KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain('plugins uninstall "$KITCHEN_SINK_SPEC" --force');
    const successScenario = sweepScript.slice(
      sweepScript.indexOf("run_success_scenario()"),
      sweepScript.indexOf("run_failure_scenario()"),
    );
    expect(successScenario.indexOf('plugins install "$KITCHEN_SINK_SPEC"')).toBeLessThan(
      successScenario.indexOf("configure_kitchen_sink_runtime"),
    );
    expect(successScenario.indexOf("configure_kitchen_sink_runtime")).toBeLessThan(
      successScenario.indexOf('plugins enable "$KITCHEN_SINK_ID"'),
    );
    expect(successScenario).toContain('plugins inspect "$KITCHEN_SINK_ID" --runtime --json');
    expect(successScenario).toContain("plugins inspect --all --runtime --json");
    expect(sweepScript).toContain("run_failure_scenario");
    expect(assertionsScript).toContain("record.source !== source");
    expect(assertionsScript).toContain("record.clawhubPackage !== packageName");
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(assertionsScript).toContain("expectedErrorMessages");
    expect(assertionsScript).toContain(
      'const INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES = new Set(["full", "conformance", "adversarial"]);',
    );
    expect(assertionsScript).toContain("!INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES.has(surfaceMode)");
    expect(readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8")).toContain(
      'from "openclaw/plugin-sdk/plugin-entry"',
    );
    expect(script).toContain("docker stats --no-stream");
    expect(sweepScript).toContain("scan_logs_for_unexpected_errors");
  });

  it("keeps the generic plugin Docker lane as an external install contract canary", () => {
    const lane = findLaneByName("plugins");
    const sweepScript = readFileSync("scripts/e2e/lib/plugins/sweep.sh", "utf8");
    const clawhubScript = readFileSync("scripts/e2e/lib/plugins/clawhub.sh", "utf8");
    const assertionsScript = readFileSync("scripts/e2e/lib/plugins/assertions.mjs", "utf8");
    const fixtureServer = readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8");
    const prereleasePlan = createPluginPrereleaseTestPlan();

    expect(lane).toEqual(
      expect.objectContaining({
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins",
        name: "plugins",
        resources: expect.arrayContaining(["npm"]),
        stateScenario: "empty",
      }),
    );
    expect(prereleasePlan.surfaces).toContain("external-install-boundary");
    expect(sweepScript).toContain("run_plugins_clawhub_scenario");
    expect(clawhubScript).toContain('plugins install "$CLAWHUB_PLUGIN_SPEC"');
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(assertionsScript).toContain('node_modules", "openclaw');
    expect(fixtureServer).toContain('"is-number": "7.0.0"');
    expect(fixtureServer).toContain('openclaw: ">=2026.4.11"');
  });

  it("wires the full plugin prerelease plan into its release workflow", () => {
    const workflow = readCiWorkflow();
    const preflight = workflow.jobs.preflight;
    const pluginWorkflow = readPluginPrereleaseWorkflow();
    const pluginPreflight = pluginWorkflow.jobs.preflight;
    const staticShard = pluginWorkflow.jobs["plugin-prerelease-static-shard"];
    const nodeShard = pluginWorkflow.jobs["plugin-prerelease-node-shard"];
    const extensionShard = pluginWorkflow.jobs["plugin-prerelease-extension-shard"];
    const dockerSuite = pluginWorkflow.jobs["plugin-prerelease-docker-suite"];
    const suite = pluginWorkflow.jobs["plugin-prerelease-suite"];
    const releaseWorkflow = readFullReleaseValidationWorkflow();
    const manifestScript = preflight.steps.find((step) => step.name === "Build CI manifest").run;
    const manifestEnv = preflight.steps.find((step) => step.name === "Build CI manifest").env;
    const pluginManifestScript = pluginPreflight.steps.find(
      (step) => step.name === "Build plugin prerelease manifest",
    ).run;
    const pluginManifestEnv = pluginPreflight.steps.find(
      (step) => step.name === "Build plugin prerelease manifest",
    ).env;
    const normalCiScript = releaseWorkflow.jobs.normal_ci.steps.find(
      (step) => step.name === "Dispatch and monitor CI",
    ).run;
    const pluginPrereleaseScript = releaseWorkflow.jobs.plugin_prerelease.steps.find(
      (step) => step.name === "Dispatch and monitor plugin prerelease",
    ).run;

    expect(workflow.jobs["plugin-prerelease-static-shard"]).toBeUndefined();
    expect(workflow.jobs["plugin-prerelease-docker-suite"]).toBeUndefined();
    expect(workflow.jobs["plugin-prerelease-suite"]).toBeUndefined();
    expect(workflow.jobs["checks-node-extensions-shard"]).toBeUndefined();
    expect(preflight.outputs).not.toHaveProperty("run_plugin_prerelease_suite");
    expect(preflight.outputs).not.toHaveProperty("run_checks_node_extensions");
    expect(staticShard).toMatchObject({
      name: "${{ matrix.check_name }}",
      "runs-on": "blacksmith-8vcpu-ubuntu-2404",
    });
    expect(workflow.on.workflow_dispatch.inputs.full_release_validation).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.include_android).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(manifestEnv).toMatchObject({
      OPENCLAW_CI_RUN_ANDROID:
        "${{ github.event_name == 'workflow_dispatch' && inputs.include_android && 'true' || steps.changed_scope.outputs.run_android || 'false' }}",
    });
    expect(manifestEnv).not.toHaveProperty("OPENCLAW_CI_FULL_RELEASE_VALIDATION");
    expect(manifestScript).toContain("includeReleaseOnlyPluginShards: false");
    expect(manifestScript).not.toContain("plugin-prerelease-test-plan.mjs");
    expect(workflow.jobs["check-shard"].strategy.matrix.include).toContainEqual({
      check_name: "check-dependencies",
      task: "dependencies",
      runner: "ubuntu-24.04",
    });
    expect(
      workflow.jobs["check-shard"].steps.find((step) => step.name === "Run check shard").run,
    ).toContain("pnpm deadcode:ci");
    expect(normalCiScript).toContain(
      'dispatch_and_wait ci.yml -f target_ref="$TARGET_SHA" -f include_android=true',
    );
    expect(normalCiScript).not.toContain("full_release_validation=true");
    expect(pluginPrereleaseScript).toContain(
      'dispatch_and_wait plugin-prerelease.yml -f target_ref="$TARGET_SHA" -f expected_sha="$TARGET_SHA" -f full_release_validation=true',
    );
    expect(pluginManifestScript).toContain("await import(");
    expect(pluginManifestScript).toContain('"./scripts/lib/plugin-prerelease-test-plan.mjs"');
    expect(pluginManifestScript).toContain('"./scripts/lib/extension-test-plan.mjs"');
    expect(pluginManifestScript).toContain('"./scripts/lib/ci-node-test-plan.mjs"');
    expect(pluginManifestScript).toContain('shard.shardName === "agentic-plugins"');
    expect(pluginManifestScript).toContain(
      "Plugin prerelease plan unavailable in target ref; skipping static and Docker plugin prerelease lanes.",
    );
    expect(pluginWorkflow.on.workflow_dispatch.inputs.target_ref).toMatchObject({
      default: "main",
      type: "string",
    });
    expect(pluginWorkflow.on.workflow_dispatch.inputs.full_release_validation).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(pluginManifestEnv).toMatchObject({
      FULL_RELEASE_VALIDATION: "${{ inputs.full_release_validation && 'true' || 'false' }}",
    });
    expect(pluginManifestScript).toContain(
      'const fullReleaseValidation = process.env.FULL_RELEASE_VALIDATION === "true";',
    );
    expect(pluginManifestScript).toContain(
      "const runDocker = fullReleaseValidation && dockerLanes.length > 0;",
    );
    expect(pluginPreflight.outputs).toMatchObject({
      checkout_revision: "${{ steps.manifest.outputs.checkout_revision }}",
      plugin_prerelease_docker_lanes:
        "${{ steps.manifest.outputs.plugin_prerelease_docker_lanes }}",
      plugin_prerelease_extension_matrix:
        "${{ steps.manifest.outputs.plugin_prerelease_extension_matrix }}",
      plugin_prerelease_node_matrix: "${{ steps.manifest.outputs.plugin_prerelease_node_matrix }}",
      plugin_prerelease_static_matrix:
        "${{ steps.manifest.outputs.plugin_prerelease_static_matrix }}",
      run_plugin_prerelease_docker: "${{ steps.manifest.outputs.run_plugin_prerelease_docker }}",
      run_plugin_prerelease_extensions:
        "${{ steps.manifest.outputs.run_plugin_prerelease_extensions }}",
      run_plugin_prerelease_node: "${{ steps.manifest.outputs.run_plugin_prerelease_node }}",
      run_plugin_prerelease_static: "${{ steps.manifest.outputs.run_plugin_prerelease_static }}",
      run_plugin_prerelease_suite: "${{ steps.manifest.outputs.run_plugin_prerelease_suite }}",
    });
    expect(staticShard.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.plugin_prerelease_static_matrix) }}",
    );
    expect(nodeShard.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.plugin_prerelease_node_matrix) }}",
    );
    expect(extensionShard.if).toBe(
      "needs.preflight.outputs.run_plugin_prerelease_extensions == 'true'",
    );
    expect(extensionShard.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.plugin_prerelease_extension_matrix) }}",
    );
    expect(
      staticShard.steps.find((step) => step.name === "Run plugin prerelease static shard").run,
    ).toContain('bash -c "$PLUGIN_PRERELEASE_COMMAND"');
    expect(dockerSuite).toMatchObject({
      if: "${{ inputs.full_release_validation && needs.preflight.outputs.run_plugin_prerelease_docker == 'true' }}",
      needs: ["preflight"],
      uses: "./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      with: {
        docker_lanes: "${{ needs.preflight.outputs.plugin_prerelease_docker_lanes }}",
        include_live_suites: false,
        include_openwebui: false,
        include_release_path_suites: false,
        include_repo_e2e: false,
        live_models_only: false,
        ref: "${{ needs.preflight.outputs.checkout_revision }}",
        targeted_docker_lane_group_size: 4,
      },
    });
    expect(dockerSuite.secrets).toBeUndefined();
    expect(suite.needs).toEqual([
      "preflight",
      "plugin-prerelease-static-shard",
      "plugin-prerelease-node-shard",
      "plugin-prerelease-extension-shard",
      "plugin-prerelease-docker-suite",
    ]);
  });

  it("keeps release-check reruns independent while cancelling superseded umbrella runs", () => {
    const releaseChecksWorkflow = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    );
    const fullReleaseWorkflow = readFullReleaseValidationWorkflow();

    expect(releaseChecksWorkflow.concurrency).toEqual({
      group:
        "openclaw-release-checks-${{ inputs.expected_sha || inputs.ref }}-${{ inputs.rerun_group }}",
      "cancel-in-progress": false,
    });
    expect(fullReleaseWorkflow.concurrency).toEqual({
      group: "full-release-validation-${{ inputs.ref }}-${{ inputs.rerun_group }}",
      "cancel-in-progress": "${{ inputs.ref == 'main' && inputs.rerun_group == 'all' }}",
    });
    expect(releaseChecksWorkflow.jobs.resolve_target["runs-on"]).toBe("ubuntu-24.04");
    expect(releaseChecksWorkflow.jobs.prepare_release_package["runs-on"]).toBe("ubuntu-24.04");
    expect(releaseChecksWorkflow.jobs.summary["runs-on"]).toBe("ubuntu-24.04");
    for (const jobName of [
      "resolve_target",
      "normal_ci",
      "plugin_prerelease",
      "release_checks",
      "npm_telegram",
      "summary",
    ]) {
      expect(fullReleaseWorkflow.jobs[jobName]["runs-on"]).toBe("ubuntu-24.04");
    }
  });

  it("keeps the live-ish availability check redacted", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/plugin-prerelease-liveish-matrix.mjs"],
      {
        encoding: "utf8",
        env: {
          DISCORD_TOKEN: "discord-token-should-not-print",
          OPENAI_API_KEY: "openai-token-should-not-print",
        },
      },
    );

    expect(output).toContain("provider-openai: present (OPENAI_API_KEY, OPENAI_BASE_URL)");
    expect(output).toContain("channel-discord: present (DISCORD_TOKEN, OPENCLAW_DISCORD_TOKEN)");
    expect(output).not.toContain("openai-token-should-not-print");
    expect(output).not.toContain("discord-token-should-not-print");
  });
});
