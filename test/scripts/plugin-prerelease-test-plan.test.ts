import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findLaneByName } from "../../scripts/lib/docker-e2e-plan.mjs";
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
      "bundled-channel-deps-compat",
      "plugins-offline",
      "plugins",
      "kitchen-sink-plugin",
      "plugin-update",
      "config-reload",
      "gateway-network",
      "mcp-channels",
      "cron-mcp-cleanup",
      "bundled-plugin-install-uninstall-0",
      "bundled-plugin-install-uninstall-1",
      "bundled-plugin-install-uninstall-2",
      "bundled-plugin-install-uninstall-3",
      "bundled-plugin-install-uninstall-4",
      "bundled-plugin-install-uninstall-5",
      "bundled-plugin-install-uninstall-6",
      "bundled-plugin-install-uninstall-7",
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
    expect(script).toContain("npm:@openclaw/kitchen-sink@beta");
    expect(script).toContain("clawhub:openclaw-kitchen-sink@latest");
    expect(script).toContain("clawhub:openclaw-kitchen-sink@beta");
    expect(script).toContain("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh");
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_SPEC"');
    expect(sweepScript).toContain('plugins uninstall "$KITCHEN_SINK_SPEC" --force');
    expect(sweepScript).toContain("run_failure_scenario");
    expect(assertionsScript).toContain("record.source !== source");
    expect(assertionsScript).toContain("record.clawhubPackage !== packageName");
    expect(assertionsScript).toContain("expectedErrorMessages");
    expect(script).toContain("docker stats --no-stream");
    expect(sweepScript).toContain("scan_logs_for_unexpected_errors");
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
