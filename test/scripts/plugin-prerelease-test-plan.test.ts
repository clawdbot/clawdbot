// Plugin Prerelease Test Plan tests cover plugin prerelease test plan script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findLaneByName } from "../../scripts/lib/docker-e2e-plan.mts";
import { BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS } from "../../scripts/lib/docker-e2e-scenarios.mts";
import {
  PLUGIN_PRERELEASE_REQUIRED_SURFACES,
  assertPluginPrereleaseTestPlanComplete,
  createPluginPrereleaseTestPlan,
} from "../../scripts/lib/plugin-prerelease-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CHECKOUT_V6 = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowMatrixEntry = {
  check_name?: string;
};

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

function readFullReleaseValidationWorkflow() {
  return parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
}

function readPluginPrereleaseWorkflow() {
  return parse(readFileSync(".github/workflows/plugin-prerelease.yml", "utf8"));
}

function getDockerLane(name: string) {
  const lane = findLaneByName(name);
  if (!lane) {
    throw new Error(`Missing Docker E2E lane ${name}`);
  }
  return lane;
}

function runFrozenTargetNodeExclusionValidation(params: {
  fullReleaseValidation: boolean;
  patternsJson: string;
}) {
  const workflow = readPluginPrereleaseWorkflow();
  const validationStep = workflow.jobs.preflight.steps.find(
    (step: WorkflowStep) => step.name === "Validate frozen-target Node exclusions",
  );
  if (!validationStep?.run) {
    throw new Error("Missing frozen-target Node exclusion validation step");
  }

  const root = tempDirs.make("openclaw-plugin-prerelease-excludes-");
  const outputPath = join(root, "github-output");
  const result = spawnSync("bash", ["-c", validationStep.run], {
    encoding: "utf8",
    env: {
      FULL_RELEASE_VALIDATION: String(params.fullReleaseValidation),
      GITHUB_OUTPUT: outputPath,
      NODE_TEST_EXCLUDE_PATTERNS_JSON: params.patternsJson,
      PATH: process.env.PATH,
    },
  });
  return {
    ...result,
    output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
  };
}

describe("scripts/lib/plugin-prerelease-test-plan.mts", () => {
  it("covers every pre-release plugin skill surface in the plugin prerelease plan", () => {
    const plan = assertPluginPrereleaseTestPlanComplete();

    expect(plan.surfaces).toEqual(
      [...PLUGIN_PRERELEASE_REQUIRED_SURFACES].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("runs the package and Docker product lanes through the existing scheduler", () => {
    const plan = createPluginPrereleaseTestPlan();
    const channelLaneScript = readFileSync(
      "scripts/e2e/npm-onboard-channel-agent-docker.sh",
      "utf8",
    );

    expect(plan.dockerLanes).toEqual([
      "npm-onboard-channel-agent",
      "npm-onboard-discord-candidate-channel-agent",
      "npm-onboard-slack-candidate-channel-agent",
      "doctor-switch",
      "update-channel-switch",
      "plugins-offline",
      "plugins",
      "kitchen-sink-plugin",
      "kitchen-sink-rpc",
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
      expect(getDockerLane(lane).name).toBe(lane);
    }
    expect(channelLaneScript).toContain("OPENCLAW_NPM_ONBOARD_USE_SOURCE_PLUGIN_PACKAGE");
    expect(channelLaneScript).toContain("bash scripts/plugin-npm-publish.sh --pack");
    expect(channelLaneScript).toContain("OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1");
    expect(channelLaneScript).toContain("npm-pack:$container_package");
    const candidateLane = getDockerLane("npm-onboard-discord-candidate-channel-agent");
    expect(candidateLane.command).toContain("OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR");
    expect(candidateLane.command).toContain(
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}"',
    );
  });

  it("keeps live-ish coverage outside provider-backed Docker lanes", () => {
    const plan = createPluginPrereleaseTestPlan();

    expect(plan.dockerLanes).not.toContain("openai-web-search-minimal");
    expect(plan.dockerLanes.some((lane) => lane.startsWith("live-"))).toBe(false);
    expect(plan.staticChecks[2]).toEqual({
      check: "live-ish-availability",
      checkName: "checks-plugin-prerelease-live-ish-availability",
      command: "node --import tsx scripts/plugin-prerelease-liveish-matrix.mts",
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
    const lane = getDockerLane("kitchen-sink-plugin");
    const script = readFileSync("scripts/e2e/kitchen-sink-plugin-docker.sh", "utf8");
    const sweepScript = readFileSync("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh", "utf8");
    const assertionsScript = readFileSync(
      "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs",
      "utf8",
    );

    expect(lane).toEqual({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:kitchen-sink-plugin",
      e2eImageKind: "functional",
      live: false,
      name: "kitchen-sink-plugin",
      resources: ["npm"],
      retryPatterns: [],
      retries: 0,
      stateScenario: "empty",
      weight: 3,
    });
    expect(script).toContain("npm:@openclaw/kitchen-sink@latest");
    expect(script).toContain("npm-latest-conformance");
    expect(script).toContain("npm-latest-adversarial");
    expect(script).toContain("npm:@openclaw/kitchen-sink@beta");
    expect(script).toContain("clawhub:@openclaw/kitchen-sink@latest");
    expect(script).toContain("clawhub:@openclaw/kitchen-sink@beta");
    expect(script).toContain("OPENCLAW_KITCHEN_SINK_PLUGIN_MAX_MEMORY_MIB");
    expect(script).toContain(
      "npm-to-clawhub|clawhub:@openclaw/kitchen-sink@latest|openclaw-kitchen-sink-fixture|clawhub|success|basic||${KITCHEN_SINK_NPM_SPEC}",
    );
    expect(script).toContain("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh");
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_SPEC" --force');
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_PREINSTALL_SPEC" --force');
    expect(sweepScript).toContain("assert-cutover-preinstalled");
    expect(sweepScript).toContain('install_args+=("--force")');
    expect(sweepScript).toContain("KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain("OPENCLAW_KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain('plugins uninstall "$KITCHEN_SINK_SPEC" --force');
    const successScenario = sweepScript.slice(
      sweepScript.indexOf("run_success_scenario()"),
      sweepScript.indexOf("run_failure_scenario()"),
    );
    expect(successScenario.indexOf('plugins install "${install_args[@]}" --force')).toBeLessThan(
      successScenario.indexOf("configure_kitchen_sink_runtime"),
    );
    expect(successScenario.indexOf("configure_kitchen_sink_runtime")).toBeLessThan(
      successScenario.indexOf('plugins enable "$KITCHEN_SINK_ID"'),
    );
    expect(successScenario).toContain('plugins inspect "$KITCHEN_SINK_ID" --runtime --json');
    expect(successScenario).toContain("plugins inspect --all --runtime --json");
    expect(sweepScript).toContain("run_failure_scenario");
    expect(assertionsScript).toContain("assertCutoverPreinstalled");
    expect(assertionsScript).toContain("record.source !== source");
    expect(assertionsScript).toContain("record.clawhubPackage !== packageName");
    expect(assertionsScript).toContain("record.clawpackSha256");
    expect(assertionsScript).toContain("record.artifactKind");
    expect(assertionsScript).toContain("record.npmIntegrity");
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(assertionsScript).toContain("expectedErrorMessages");
    expect(assertionsScript).toContain(
      'const INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES = new Set(["full", "adversarial"]);',
    );
    expect(assertionsScript).toContain("!INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES.has(surfaceMode)");
    expect(readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8")).toContain(
      'from "openclaw/plugin-sdk/plugin-entry"',
    );
    expect(readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8")).toContain(
      "X-ClawHub-Artifact-Sha256",
    );
    expect(script).toContain("docker_e2e_sample_stats_until_exit");
    expect(script).toContain("scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs");
    expect(sweepScript).toContain("scan_logs_for_unexpected_errors");
  });

  it("keeps kitchen-sink RPC coverage package-backed and resource-guarded", () => {
    const lane = getDockerLane("kitchen-sink-rpc");
    const script = readFileSync("scripts/e2e/kitchen-sink-rpc-docker.sh", "utf8");
    const walkScript = readFileSync("scripts/e2e/kitchen-sink-rpc-walk.mts", "utf8");

    expect(lane).toMatchObject({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:kitchen-sink-rpc",
      e2eImageKind: "functional",
      live: false,
      name: "kitchen-sink-rpc",
      resources: ["service", "npm"],
      retryPatterns: [],
      retries: 0,
      stateScenario: "empty",
      timeoutMs: 1_500_000,
      weight: 3,
    });
    expect(script).toContain("OPENCLAW_ENTRY=/app/openclaw.mjs");
    expect(script).toContain("OPENCLAW_KITCHEN_SINK_COMMAND_MAX_RSS_MIB");
    expect(script).toContain("docker_e2e_sample_stats_until_exit");
    expect(script).toContain("scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs");
    expect(script).toContain(
      "openclaw_e2e_run_script_entrypoint scripts/e2e/kitchen-sink-rpc-walk",
    );
    expect(walkScript).toContain("commands.list");
    expect(walkScript).toContain("tools.invoke");
    expect(walkScript).toContain("tts.providers");
    expect(walkScript).toContain("plugins.uiDescriptors");
    expect(walkScript).toContain("loadCallGatewayModule(options.runner)");
    expect(walkScript).toContain("usesBuiltOpenClawEntry(runner)");
    expect(walkScript).toContain('"gateway"');
    expect(walkScript).toContain('"call"');
    expect(walkScript).not.toContain("src/gateway/call.ts");
    expect(walkScript).toContain("^call(?:\\.runtime)?");
  });

  it("keeps the generic plugin Docker lane as an external install contract canary", () => {
    const lane = getDockerLane("plugins");
    const sweepScript = readFileSync("scripts/e2e/lib/plugins/sweep.sh", "utf8");
    const clawhubScript = readFileSync("scripts/e2e/lib/plugins/clawhub.sh", "utf8");
    const assertionsScript = readFileSync("scripts/e2e/lib/plugins/assertions.mjs", "utf8");
    const fixtureServer = readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8");
    const prereleasePlan = createPluginPrereleaseTestPlan();

    expect(lane).toEqual({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins",
      e2eImageKind: "functional",
      live: false,
      name: "plugins",
      resources: ["npm", "service"],
      retryPatterns: [],
      retries: 0,
      stateScenario: "empty",
      weight: 6,
    });
    expect(prereleasePlan.surfaces).toContain("external-install-boundary");
    expect(sweepScript).toContain("run_plugins_clawhub_scenario");
    expect(clawhubScript).toContain('plugins install "$CLAWHUB_PLUGIN_SPEC"');
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(assertionsScript).toContain('node_modules", "openclaw');
    expect(fixtureServer).toContain('"is-number": "7.0.0"');
    expect(fixtureServer).toContain('openclaw: ">=2026.4.11"');
    expect(fixtureServer).toContain("/versions/${fixture.version}/artifact");
  });

  it("validates frozen-target Node omissions as exact full-release-only plugin test paths", () => {
    const defaultResult = runFrozenTargetNodeExclusionValidation({
      fullReleaseValidation: false,
      patternsJson: "[]",
    });
    expect(defaultResult.status, defaultResult.stderr).toBe(0);
    expect(defaultResult.output).toBe("patterns_json=[]\n");

    const validPatterns = [
      "src/plugins/example.test.ts",
      "src/plugins/runtime/example.runtime.test.ts",
    ];
    const fullReleaseResult = runFrozenTargetNodeExclusionValidation({
      fullReleaseValidation: true,
      patternsJson: JSON.stringify(validPatterns),
    });
    expect(fullReleaseResult.status, fullReleaseResult.stderr).toBe(0);
    expect(fullReleaseResult.output).toBe(`patterns_json=${JSON.stringify(validPatterns)}\n`);

    for (const patternsJson of ["", "{}", "null", '"src/plugins/example.test.ts"']) {
      const result = runFrozenTargetNodeExclusionValidation({
        fullReleaseValidation: true,
        patternsJson,
      });
      expect(result.status, `${patternsJson}\n${result.stderr}`).not.toBe(0);
    }

    for (const patternsJson of [JSON.stringify(["src/plugins/example.test.ts"]), " [ ] "]) {
      const result = runFrozenTargetNodeExclusionValidation({
        fullReleaseValidation: false,
        patternsJson,
      });
      expect(result.status, `${patternsJson}\n${result.stderr}`).not.toBe(0);
    }

    for (const patternsJson of [
      JSON.stringify([""]),
      JSON.stringify([42]),
      JSON.stringify(["/src/plugins/example.test.ts"]),
      JSON.stringify(["C:\\src\\plugins\\example.test.ts"]),
      JSON.stringify(["../src/plugins/example.test.ts"]),
      JSON.stringify(["./src/plugins/example.test.ts"]),
      JSON.stringify(["src/plugins/../example.test.ts"]),
      JSON.stringify(["src/plugins//example.test.ts"]),
      JSON.stringify(["src/agents/example.test.ts"]),
      JSON.stringify(["src/plugins/example.ts"]),
      JSON.stringify(["src/plugins/*.test.ts"]),
      JSON.stringify(["src/plugins/example?.test.ts"]),
      JSON.stringify(["src/plugins/[example].test.ts"]),
      JSON.stringify(["src/plugins/example.test.ts", "src/plugins/example.test.ts"]),
    ]) {
      const result = runFrozenTargetNodeExclusionValidation({
        fullReleaseValidation: true,
        patternsJson,
      });
      expect(result.status, `${patternsJson}\n${result.stderr}`).not.toBe(0);
    }
  });

  it("keeps frozen-target fixture ownership and Node omissions explicit in release evidence", () => {
    const pluginWorkflow = readPluginPrereleaseWorkflow();
    const pluginSource = readFileSync(".github/workflows/plugin-prerelease.yml", "utf8");
    const preflight = pluginWorkflow.jobs.preflight;
    const nodeShard = pluginWorkflow.jobs["plugin-prerelease-node-shard"];
    const trustedCheckout = nodeShard.steps.find(
      (step: WorkflowStep) => step.name === "Checkout trusted npm security inventory",
    );
    const installInventory = nodeShard.steps.find(
      (step: WorkflowStep) => step.name === "Install trusted npm security inventory",
    );
    const runNodeShard = nodeShard.steps.find(
      (step: WorkflowStep) => step.name === "Run release-only plugin Node shard",
    );
    const releaseWorkflow = readFullReleaseValidationWorkflow();
    const releaseSource = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    const targetSummary = releaseWorkflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.name === "Summarize target",
    );
    const pluginDispatch = releaseWorkflow.jobs.plugin_prerelease.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch plugin prerelease",
    );
    const evidenceReuse = releaseWorkflow.jobs.evidence_reuse.steps.find(
      (step: WorkflowStep) => step.name === "Find reusable validation evidence",
    );
    const manifest = releaseWorkflow.jobs.summary.steps.find(
      (step: WorkflowStep) => step.name === "Write release validation manifest",
    );

    expect(pluginWorkflow.on.workflow_dispatch.inputs.node_test_exclude_patterns_json).toEqual({
      default: "[]",
      description:
        "Full Release Validation-only exact plugin test paths omitted for a frozen target",
      required: false,
      type: "string",
    });
    expect(preflight.outputs.node_test_exclude_patterns_json).toBe(
      "${{ steps.node_test_exclusions.outputs.patterns_json }}",
    );
    expect(trustedCheckout).toMatchObject({
      if: "inputs.full_release_validation",
      uses: CHECKOUT_V6,
      with: {
        "persist-credentials": false,
        ref: "${{ github.sha }}",
        path: ".plugin-prerelease-trusted",
        "sparse-checkout": "src/plugins/npm-install-security-scan.release.test.ts",
        "sparse-checkout-cone-mode": false,
      },
    });
    expect(installInventory?.run).toContain(
      '"$trusted_checkout/src/plugins/npm-install-security-scan.release.test.ts"',
    );
    expect(installInventory?.run).toContain(
      "src/plugins/npm-install-security-scan.release.test.ts",
    );
    expect(installInventory?.run).toContain('rm -rf -- "$trusted_checkout"');
    expect(runNodeShard?.env?.NODE_TEST_EXCLUDE_PATTERNS_JSON).toBe(
      "${{ needs.preflight.outputs.node_test_exclude_patterns_json }}",
    );
    expect(runNodeShard?.run).toContain('process.env.NODE_TEST_EXCLUDE_PATTERNS_JSON ?? "[]"');
    expect(runNodeShard?.run).toContain('pattern.slice("src/plugins/".length)');
    expect(runNodeShard?.run).toContain("`--exclude=${pattern.slice");
    expect(runNodeShard?.run).toContain('["test", "--", ...configs, "--", ...excludeArgs]');
    expect(pluginSource).not.toContain("runtime-llm.runtime.test.ts");

    expect(
      releaseWorkflow.on.workflow_dispatch.inputs.plugin_prerelease_node_exclude_patterns_json,
    ).toEqual({
      default: "[]",
      description:
        "Exact Plugin Prerelease Node test paths omitted only for frozen-target validation",
      required: false,
      type: "string",
    });
    expect(targetSummary?.env?.PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON).toBe(
      "${{ inputs.plugin_prerelease_node_exclude_patterns_json }}",
    );
    expect(targetSummary?.run).toContain("- Plugin prerelease Node exclusions:");
    expect(pluginDispatch?.env?.PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON).toBe(
      "${{ inputs.plugin_prerelease_node_exclude_patterns_json }}",
    );
    expect(pluginDispatch?.run).toContain(
      '-f node_test_exclude_patterns_json="$PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON"',
    );
    expect(pluginDispatch?.run).toContain("- Frozen-target Node test omissions:");
    expect(evidenceReuse?.env?.PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON).toBe(
      "${{ inputs.plugin_prerelease_node_exclude_patterns_json }}",
    );
    expect(evidenceReuse?.run).toContain(
      "pluginPrereleaseNodeExcludePatternsJson: $pluginPrereleaseNodeExcludePatternsJson",
    );
    expect(manifest?.env?.PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON).toBe(
      "${{ inputs.plugin_prerelease_node_exclude_patterns_json }}",
    );
    expect(manifest?.run).toContain(
      "pluginPrereleaseNodeExcludePatternsJson: $pluginPrereleaseNodeExcludePatternsJson",
    );
    expect(releaseSource).not.toContain("runtime-llm.runtime.test.ts");
  });

  it("wires the full plugin prerelease plan into its release workflow", () => {
    const workflow = readCiWorkflow();
    const preflight = workflow.jobs.preflight;
    const pluginWorkflow = readPluginPrereleaseWorkflow();
    const pluginPreflight = pluginWorkflow.jobs.preflight;
    const staticShard = pluginWorkflow.jobs["plugin-prerelease-static-shard"];
    const nodeShard = pluginWorkflow.jobs["plugin-prerelease-node-shard"];
    const extensionShard = pluginWorkflow.jobs["plugin-prerelease-extension-shard"];
    const inspector = pluginWorkflow.jobs["plugin-prerelease-inspector"];
    const dockerSuite = pluginWorkflow.jobs["plugin-prerelease-docker-suite"];
    const suite = pluginWorkflow.jobs["plugin-prerelease-suite"];
    const releaseWorkflow = readFullReleaseValidationWorkflow();
    const releaseWorkflowSource = readFileSync(
      ".github/workflows/full-release-validation.yml",
      "utf8",
    );
    const manifestScript = preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    ).run;
    const manifestEnv = preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    ).env;
    const pluginManifestScript = pluginPreflight.steps.find(
      (step: WorkflowStep) => step.name === "Build plugin prerelease manifest",
    ).run;
    const pluginManifestEnv = pluginPreflight.steps.find(
      (step: WorkflowStep) => step.name === "Build plugin prerelease manifest",
    ).env;
    const normalCiScript = releaseWorkflow.jobs.normal_ci.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch CI",
    ).run;
    const pluginPrereleaseScript = releaseWorkflow.jobs.plugin_prerelease.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch plugin prerelease",
    ).run;
    const releaseChecksStep = releaseWorkflow.jobs.release_checks.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch release checks",
    );
    const releaseChecksScript = releaseChecksStep.run;
    const buildDistStep = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Build dist",
    );

    expect(workflow.jobs["plugin-prerelease-static-shard"]).toBeUndefined();
    expect(workflow.jobs["plugin-prerelease-inspector"]).toBeUndefined();
    expect(workflow.jobs["plugin-prerelease-docker-suite"]).toBeUndefined();
    expect(workflow.jobs["plugin-prerelease-suite"]).toBeUndefined();
    expect(workflow.jobs["checks-node-extensions-shard"]).toBeUndefined();
    expect(preflight.outputs).not.toHaveProperty("run_plugin_prerelease_suite");
    expect(preflight.outputs).not.toHaveProperty("run_checks_node_extensions");
    expect(buildDistStep.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=8192" });
    expect(staticShard).toEqual({
      if: "needs.preflight.outputs.run_plugin_prerelease_static == 'true'",
      name: "${{ matrix.check_name }}",
      needs: ["preflight"],
      permissions: {
        contents: "read",
      },
      "runs-on":
        "${{ github.event_name == 'workflow_dispatch' && 'ubuntu-24.04' || 'blacksmith-8vcpu-ubuntu-2404' }}",
      steps: [
        {
          name: "Checkout",
          uses: CHECKOUT_V6,
          with: {
            "fetch-depth": 1,
            "fetch-tags": false,
            "persist-credentials": false,
            ref: "${{ needs.preflight.outputs.checkout_revision }}",
            submodules: false,
          },
        },
        {
          name: "Setup Node environment",
          uses: "./.github/actions/setup-node-env",
          with: {
            "cache-mode": "restore",
            "install-bun": "false",
          },
        },
        {
          env: {
            PLUGIN_PRERELEASE_COMMAND: "${{ matrix.command }}",
            PLUGIN_PRERELEASE_TASK: "${{ matrix.task }}",
          },
          name: "Run plugin prerelease static shard",
          run: [
            "set -euo pipefail",
            'echo "Running ${PLUGIN_PRERELEASE_TASK}: ${PLUGIN_PRERELEASE_COMMAND}"',
            'bash -c "$PLUGIN_PRERELEASE_COMMAND"',
            "",
          ].join("\n"),
          shell: "bash",
        },
      ],
      strategy: {
        "fail-fast": false,
        matrix: "${{ fromJson(needs.preflight.outputs.plugin_prerelease_static_matrix) }}",
      },
      "timeout-minutes": 45,
    });
    expect(workflow.on.workflow_dispatch.inputs.full_release_validation).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.include_android).toEqual({
      default: false,
      description: "Run Android lanes for this manual CI dispatch.",
      required: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_dispatch.inputs.historical_target_tag).toEqual({
      default: "",
      description: "Semver release tag authorizing compatibility fallbacks for its exact commit",
      required: false,
      type: "string",
    });
    expect(workflow.on.workflow_dispatch.inputs.release_candidate_ref).toEqual({
      default: "",
      description:
        "Canonical release branch authorizing compatibility fallbacks for its exact head",
      required: false,
      type: "string",
    });
    expect(workflow.on.workflow_dispatch.inputs.target_context_ref).toEqual({
      default: "",
      description:
        "Canonical release branch context authorizing compatibility fallbacks for an exact-SHA target",
      required: false,
      type: "string",
    });
    expect(manifestEnv).toEqual({
      OPENCLAW_CI_CHANGED_PATHS_JSON:
        "${{ steps.changed_scope.outputs.changed_paths_json || 'null' }}",
      OPENCLAW_CI_CHECKOUT_REVISION: "${{ steps.checkout_ref.outputs.sha }}",
      OPENCLAW_CI_DOCS_CHANGED:
        "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.docs_scope.outputs.docs_changed }}",
      OPENCLAW_CI_DOCS_ONLY:
        "${{ github.event_name == 'workflow_dispatch' && 'false' || steps.docs_scope.outputs.docs_only }}",
      OPENCLAW_CI_EVENT_NAME: "${{ github.event_name }}",
      OPENCLAW_CI_HISTORICAL_TARGET: "${{ steps.historical_target.outputs.eligible || 'false' }}",
      OPENCLAW_CI_RELEASE_GATE: "${{ inputs.release_gate && 'true' || 'false' }}",
      OPENCLAW_CI_RELEASE_CANDIDATE_TARGET:
        "${{ steps.release_candidate_target.outputs.eligible || 'false' }}",
      OPENCLAW_CI_TARGET_CONTEXT_TARGET:
        "${{ steps.target_context_target.outputs.eligible || 'false' }}",
      OPENCLAW_CI_REPOSITORY: "${{ github.repository }}",
      OPENCLAW_CI_RUNNER_BACKEND:
        "${{ (github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)) && 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND }}",
      OPENCLAW_CI_RUN_ANDROID:
        "${{ github.event_name == 'workflow_dispatch' && (inputs.release_gate || inputs.include_android) && 'true' || steps.changed_scope.outputs.run_android || 'false' }}",
      OPENCLAW_CI_RUN_CONTROL_UI_I18N:
        "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.changed_scope.outputs.run_control_ui_i18n || 'false' }}",
      OPENCLAW_CI_RUN_IOS_BUILD:
        "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.run_ios_build || 'false' }}",
      OPENCLAW_CI_RUN_MACOS:
        "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.run_macos || 'false' }}",
      OPENCLAW_CI_RUN_NATIVE_I18N:
        "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.changed_scope.outputs.run_native_i18n || 'false' }}",
      OPENCLAW_CI_RUN_NODE:
        "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.changed_scope.outputs.run_node || 'false' }}",
      OPENCLAW_CI_RUN_NODE_FAST_CI_ROUTING:
        "${{ github.event_name == 'workflow_dispatch' && 'false' || steps.changed_scope.outputs.run_node_fast_ci_routing || 'false' }}",
      OPENCLAW_CI_RUN_NODE_FAST_ONLY:
        "${{ github.event_name == 'workflow_dispatch' && 'false' || steps.changed_scope.outputs.run_node_fast_only || 'false' }}",
      OPENCLAW_CI_RUN_NODE_FAST_PLUGIN_CONTRACTS:
        "${{ github.event_name == 'workflow_dispatch' && 'false' || steps.changed_scope.outputs.run_node_fast_plugin_contracts || 'false' }}",
      OPENCLAW_CI_RUN_SKILLS_PYTHON:
        "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.changed_scope.outputs.run_skills_python || 'false' }}",
      OPENCLAW_CI_RUN_UI_TESTS:
        "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.changed_scope.outputs.run_ui_tests || 'false' }}",
      OPENCLAW_CI_RUN_WINDOWS:
        "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.changed_scope.outputs.run_windows || 'false' }}",
      OPENCLAW_CI_WORKFLOW_REVISION: "${{ github.sha }}",
    });
    expect(manifestEnv).not.toHaveProperty("OPENCLAW_CI_FULL_RELEASE_VALIDATION");
    expect(manifestScript).toContain("includeReleaseOnlyPluginShards: false");
    expect(manifestScript).not.toContain("plugin-prerelease-test-plan.mts");
    expect(
      workflow.jobs["check-shard"].strategy.matrix.include.find(
        (entry: WorkflowMatrixEntry) => entry.check_name === "check-dependencies",
      ),
    ).toEqual({
      check_name: "check-dependencies",
      task: "dependencies",
      // Concurrent Knip scans need cores and memory headroom.
      runner: "blacksmith-32vcpu-ubuntu-2404",
    });
    expect(
      workflow.jobs["check-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run check shard",
      ).run,
    ).toContain("pnpm deadcode:ci");
    expect(normalCiScript).toContain('args+=(-f historical_target_tag="$TARGET_REF")');
    expect(normalCiScript).toContain('args+=(-f historical_target_tag="$TARGET_CONTEXT_REF")');
    expect(normalCiScript).toContain('args+=(-f target_context_ref="$TARGET_CONTEXT_REF")');
    expect(normalCiScript).not.toContain('args+=(-f release_candidate_ref="$TARGET_CONTEXT_REF")');
    expect(releaseChecksStep.env?.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
    expect(releaseChecksScript).toContain('-f ref="$TARGET_SHA"');
    expect(releaseChecksScript).toContain('-f target_context_ref="$TARGET_CONTEXT_REF"');
    expect(releaseChecksScript).toContain("args+=(-f allow_frozen_target_scenario_omissions=true)");
    expect(releaseWorkflowSource).toContain('--arg targetContextRef "$TARGET_CONTEXT_REF"');
    expect(releaseWorkflowSource).toContain("targetContextRef: $targetContextRef");
    expect(normalCiScript).toContain('dispatch_child ci.yml "$dispatch_run_name" "${args[@]}"');
    const normalCiDispatchCase = normalCiScript.match(/^\s*ci\)\n([\s\S]*?)^\s*;;$/mu)?.[1];
    expect(normalCiDispatchCase).toContain('dispatch_child ci.yml "$dispatch_run_name"');
    expect(normalCiDispatchCase).not.toContain("full_release_validation=true");
    expect(pluginPrereleaseScript).toContain(
      'args=(-f target_ref="$TARGET_SHA" -f expected_sha="$TARGET_SHA" -f full_release_validation=true -f dispatch_id="$dispatch_id" -f node_test_exclude_patterns_json="$PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON")',
    );
    expect(pluginPrereleaseScript).toContain(
      'args+=(-f candidate_artifact_json="$CANDIDATE_ARTIFACT_JSON")',
    );
    expect(pluginPrereleaseScript).toContain(
      'dispatch_child plugin-prerelease.yml "$dispatch_run_name" "${args[@]}"',
    );
    expect(pluginManifestScript).toContain("await import(");
    expect(pluginManifestScript).toContain('"./scripts/lib/plugin-prerelease-test-plan.mts"');
    expect(pluginManifestScript).toContain('"./scripts/lib/extension-test-plan.mts"');
    expect(pluginManifestScript).toContain('"./scripts/lib/ci-node-test-plan.mts"');
    expect(pluginManifestScript).toContain("const { createNodeTestShards } = await import");
    expect(pluginManifestScript).not.toContain("createNodeTestShardBundles");
    expect(pluginManifestScript).not.toContain("compactMode");
    expect(pluginManifestScript).not.toContain("runnerBackend");
    expect(pluginManifestScript).toContain('shard.shardName === "agentic-plugins"');
    expect(pluginManifestScript).toContain(
      "Plugin prerelease plan unavailable in target ref; skipping static and Docker plugin prerelease lanes.",
    );
    const pluginNodeShardScript = pluginWorkflow.jobs["plugin-prerelease-node-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run release-only plugin Node shard",
    ).run;
    expect(pluginNodeShardScript).toContain(
      'spawnSync("pnpm", ["test", "--", ...configs, "--", ...excludeArgs]',
    );
    expect(pluginNodeShardScript).not.toContain("scripts/test-projects.mts");
    expect(pluginWorkflow.on.workflow_dispatch.inputs.target_ref).toEqual({
      default: "main",
      description: "Branch, tag, or full commit SHA to validate",
      required: false,
      type: "string",
    });
    expect(pluginWorkflow.on.workflow_dispatch.inputs.full_release_validation).toEqual({
      default: false,
      description: "Enable release-only Docker prerelease lanes from Full Release Validation",
      required: false,
      type: "boolean",
    });
    expect(pluginWorkflow.on.workflow_dispatch.inputs.dispatch_id).toEqual({
      description: "Optional parent workflow dispatch identifier",
      required: false,
      default: "",
      type: "string",
    });
    expect(pluginManifestEnv).toEqual({
      EXPECTED_SHA: "${{ inputs.expected_sha }}",
      FULL_RELEASE_VALIDATION: "${{ inputs.full_release_validation && 'true' || 'false' }}",
    });
    expect(pluginManifestScript).toContain(
      'const fullReleaseValidation = process.env.FULL_RELEASE_VALIDATION === "true";',
    );
    expect(pluginManifestScript).toContain(
      "const runDocker = fullReleaseValidation && dockerLanes.length > 0;",
    );
    expect(pluginPreflight.outputs).toEqual({
      checkout_revision: "${{ steps.manifest.outputs.checkout_revision }}",
      plugin_prerelease_docker_lanes:
        "${{ steps.manifest.outputs.plugin_prerelease_docker_lanes }}",
      plugin_prerelease_extension_matrix:
        "${{ steps.manifest.outputs.plugin_prerelease_extension_matrix }}",
      plugin_prerelease_node_matrix: "${{ steps.manifest.outputs.plugin_prerelease_node_matrix }}",
      node_test_exclude_patterns_json: "${{ steps.node_test_exclusions.outputs.patterns_json }}",
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
      extensionShard.steps.find((step: WorkflowStep) => step.name === "Run extension shard").run,
    ).toContain("--retry=1");
    expect(inspector.name).toBe("plugin-prerelease-inspector");
    expect(inspector.needs).toEqual(["preflight"]);
    expect(inspector.if).toBe("needs.preflight.outputs.run_plugin_prerelease_suite == 'true'");
    expect(inspector["continue-on-error"]).toBe(true);
    expect(inspector["runs-on"]).toBe("ubuntu-24.04");
    expect(inspector["timeout-minutes"]).toBe(30);
    expect(
      inspector.steps.find((step: WorkflowStep) => step.name === "Setup Node environment").with,
    ).toEqual({
      "cache-mode": "restore",
      "install-bun": "false",
    });
    const inspectorRun = inspector.steps.find(
      (step: WorkflowStep) => step.name === "Run plugin inspector advisory sweep",
    );
    expect(inspectorRun.env).toEqual({
      OPENCLAW_PLUGIN_INSPECTOR_ROOT: ".artifacts/plugin-inspector",
      OPENCLAW_PLUGIN_INSPECTOR_VERSION: "0.3.21",
    });
    expect(inspectorRun.run).toContain("extensions/");
    expect(inspectorRun.run).toContain(
      'npm exec --yes "@openclaw/plugin-inspector@${OPENCLAW_PLUGIN_INSPECTOR_VERSION}" -- ci',
    );
    expect(inspectorRun.run).toContain("This job is informational");
    expect(
      inspector.steps.find(
        (step: WorkflowStep) => step.name === "Upload plugin inspector advisory artifacts",
      ),
    ).toEqual({
      if: "always()",
      name: "Upload plugin inspector advisory artifacts",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        "if-no-files-found": "warn",
        name: "plugin-inspector-advisory",
        path: ".artifacts/plugin-inspector/**",
      },
    });
    expect(
      staticShard.steps.find(
        (step: WorkflowStep) => step.name === "Run plugin prerelease static shard",
      ).run,
    ).toContain('bash -c "$PLUGIN_PRERELEASE_COMMAND"');
    expect(dockerSuite).toMatchObject({
      if: "${{ inputs.full_release_validation && needs.preflight.outputs.run_plugin_prerelease_docker == 'true' }}",
      name: "plugin-prerelease-docker-suite",
      needs: ["preflight"],
      permissions: {
        actions: "read",
        contents: "read",
        packages: "read",
        "pull-requests": "read",
      },
      uses: "./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      with: {
        docker_lanes: "${{ needs.preflight.outputs.plugin_prerelease_docker_lanes }}",
        include_live_suites: false,
        include_openwebui: false,
        include_release_path_suites: false,
        include_repo_e2e: false,
        live_models_only: false,
        allow_unreleased_changelog: true,
        ref: "${{ needs.preflight.outputs.checkout_revision }}",
        shared_image_artifact_namespace: "plugin-prerelease",
        shared_image_policy: "no-push-artifact",
        targeted_docker_lane_group_size: 2,
      },
    });
    expect(dockerSuite.secrets).toBeUndefined();
    expect(suite.needs).toEqual([
      "preflight",
      "plugin-prerelease-static-shard",
      "plugin-prerelease-node-shard",
      "plugin-prerelease-extension-shard",
      "plugin-prerelease-inspector",
      "plugin-prerelease-docker-suite",
    ]);
    expect(
      suite.steps.find((step: WorkflowStep) => step.name === "Verify plugin prerelease suite").run,
    ).toContain("plugin-prerelease-inspector advisory result");
  });

  it("keeps exact release tuples independent without cancelling adopted children", () => {
    const releaseChecksWorkflow = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    );
    const fullReleaseWorkflow = readFullReleaseValidationWorkflow();

    expect(releaseChecksWorkflow.concurrency).toEqual({
      group:
        "openclaw-release-checks-${{ inputs.expected_sha || inputs.ref }}-${{ github.sha }}-${{ inputs.rerun_group }}",
      "cancel-in-progress": "${{ startsWith(github.ref, 'refs/heads/tideclaw/alpha/') }}",
    });
    expect(fullReleaseWorkflow.concurrency).toEqual({
      group:
        "full-release-validation-${{ inputs.expected_sha || inputs.ref }}-${{ github.sha }}-${{ inputs.rerun_group }}",
      "cancel-in-progress": false,
    });
    expect(fullReleaseWorkflow.on.workflow_dispatch.inputs.expected_sha).toEqual({
      description: "Optional full Validation SHA that ref must resolve to",
      required: false,
      default: "",
      type: "string",
    });
    const resolveTargetStep = fullReleaseWorkflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.name === "Resolve target SHA",
    );
    const targetSummaryStep = fullReleaseWorkflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.name === "Summarize target",
    );
    expect(resolveTargetStep.env?.EXPECTED_SHA).toBe("${{ inputs.expected_sha }}");
    expect(resolveTargetStep.run).toContain('--expected-sha "$EXPECTED_SHA"');
    expect(targetSummaryStep.run).toContain("- Validation SHA:");
    expect(targetSummaryStep.run).not.toContain("- Code SHA:");
    expect(releaseChecksWorkflow.jobs.resolve_target["runs-on"]).toBe("ubuntu-24.04");
    expect(releaseChecksWorkflow.jobs.prepare_release_package["runs-on"]).toBe("ubuntu-24.04");
    expect(releaseChecksWorkflow.jobs.summary["runs-on"]).toBe("ubuntu-24.04");
    for (const jobName of [
      "resolve_target",
      "docker_runtime_assets_preflight",
      "normal_ci",
      "plugin_prerelease",
      "npm_telegram",
      "summary",
    ]) {
      expect(fullReleaseWorkflow.jobs[jobName]["runs-on"]).toBe("ubuntu-24.04");
    }
    expect(fullReleaseWorkflow.jobs.release_checks["runs-on"]).toBe("blacksmith-4vcpu-ubuntu-2404");
    expect(fullReleaseWorkflow.jobs.performance["runs-on"]).toBe("blacksmith-4vcpu-ubuntu-2404");
    expect(fullReleaseWorkflow.jobs.normal_ci["timeout-minutes"]).toBe(15);
    expect(fullReleaseWorkflow.jobs.normal_ci.needs).toEqual(["resolve_target", "evidence_reuse"]);
    expect(fullReleaseWorkflow.jobs.normal_ci.if).toContain(
      "needs.resolve_target.result == 'success'",
    );
    expect(fullReleaseWorkflow.jobs.normal_ci.if).toContain(
      "needs.evidence_reuse.outputs.reuse != 'true'",
    );
    expect(fullReleaseWorkflow.jobs.docker_runtime_assets_preflight.if).toBe(
      "${{ always() && github.run_attempt == 1 && needs.resolve_target.result == 'success' && inputs.rerun_group == 'all' && needs.evidence_reuse.outputs.reuse != 'true' }}",
    );
    expect(fullReleaseWorkflow.jobs.docker_runtime_assets_preflight["timeout-minutes"]).toBe(20);
    const dockerPreflightStep = fullReleaseWorkflow.jobs.docker_runtime_assets_preflight.steps.find(
      (step: WorkflowStep) => step.name === "Verify Docker runtime-assets prune path",
    );
    expect(dockerPreflightStep).toBeDefined();
    expect(dockerPreflightStep?.run).toContain("docker build");
    expect(dockerPreflightStep?.run).toContain("--target runtime-assets");
    expect(dockerPreflightStep?.run).toContain("timeout --kill-after=30s 15m docker build");
    expect(dockerPreflightStep?.run).toContain(
      '--build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,codex"',
    );
    expect(
      fullReleaseWorkflow.jobs.docker_runtime_assets_preflight.steps.some(
        (step: WorkflowStep) => step.name === "Build and smoke test final Docker runtime image",
      ),
    ).toBe(false);
    for (const jobName of ["plugin_prerelease", "release_checks", "npm_telegram", "performance"]) {
      expect(fullReleaseWorkflow.jobs[jobName]["timeout-minutes"], jobName).toBe(15);
    }
    const fullReleaseSource = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    expect(fullReleaseWorkflow.on.workflow_dispatch.inputs.fail_fast).toEqual({
      description:
        "Cancel only an exact active child after its first blocking job; false drains all children to completion",
      required: false,
      default: false,
      type: "boolean",
    });
    for (const [jobName, kind] of [
      ["normal_ci", "ci"],
      ["plugin_prerelease", "plugin-prerelease"],
      ["release_checks", "release-checks"],
      ["npm_telegram", "npm-telegram"],
    ] as const) {
      const dispatch: WorkflowStep = fullReleaseWorkflow.jobs[jobName].steps[0];
      expect(dispatch.env?.CHILD_WORKFLOW_KIND).toBe(kind);
      if (jobName === "release_checks") {
        expect(dispatch.env?.FAIL_FAST).toBe("${{ inputs.fail_fast }}");
        expect(dispatch.run).toContain('-f fail_fast="$FAIL_FAST"');
      } else {
        expect(dispatch.env).not.toHaveProperty("FAIL_FAST");
      }
    }
    expect(fullReleaseWorkflow.jobs.performance.steps[0].env).not.toHaveProperty("FAIL_FAST");
    expect(fullReleaseSource).toContain('-f fail_fast="$FAIL_FAST"');
    expect(fullReleaseSource).not.toContain(
      "has failed child jobs before the workflow completed; cancelling the remaining run.",
    );
    expect(fullReleaseSource).not.toContain("trap cancel_child");
    expect(fullReleaseSource).not.toContain("cancel_child_on_failure");
    expect(fullReleaseSource).not.toContain("exit_on_parent_signal");
    expect(fullReleaseSource).not.toContain("disable_child_cleanup");
    expect(fullReleaseSource).not.toContain("cancel_child");
    expect(fullReleaseSource).toContain(
      'if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]; then',
    );
    expect(releaseChecksWorkflow.on.workflow_dispatch.inputs.fail_fast).toEqual({
      description: "Stop the Matrix QA lane after its first failed check or scenario",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(releaseChecksWorkflow.jobs.qa_live_release_checks.with.fail_fast).toBe(
      "${{ fromJSON(needs.resolve_target.outputs.fail_fast) }}",
    );
    const qaLiveSource = readFileSync(".github/workflows/qa-live-transports-convex.yml", "utf8");
    expect(qaLiveSource).toContain('if [[ "$FAIL_FAST" == "true" ]]');
  });

  it("allows Unreleased notes only for current-tree release checks", () => {
    const workflow = parse(readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"));
    const fullReleaseWorkflow = readFullReleaseValidationWorkflow();
    const resolveTarget = workflow.jobs.resolve_target;
    const captureInputs = resolveTarget.steps.find(
      (step: WorkflowStep) => step.name === "Capture selected inputs",
    );
    const currentTreeAllowance =
      "${{ needs.resolve_target.outputs.allow_unreleased_changelog == 'true' }}";

    expect(workflow.on.workflow_dispatch.inputs.allow_unreleased_changelog).toEqual({
      default: false,
      description: "Allow explicitly opted-in current-tree packaging to use Unreleased notes",
      required: false,
      type: "boolean",
    });
    expect(resolveTarget.outputs.allow_unreleased_changelog).toBe(
      "${{ steps.inputs.outputs.allow_unreleased_changelog }}",
    );
    expect(captureInputs?.run).toContain('RELEASE_REF_INPUT" == "main"');
    expect(captureInputs?.run).toContain('RELEASE_REF_INPUT" == "refs/heads/main"');
    expect(captureInputs?.run).toContain("release/[0-9]{4}");
    expect(captureInputs?.run).toContain("extended-stable/[0-9]{4}");
    expect(captureInputs?.run).toContain("tideclaw/alpha/");
    expect(captureInputs?.run).toContain("refs/tags/");
    expect(captureInputs?.run).toContain("RELEASE_ALLOW_UNRELEASED_CHANGELOG_INPUT");
    expect(captureInputs?.run).toContain("allow_unreleased_changelog=false");
    const explicitOptIn = captureInputs?.run.indexOf('"$allow_unreleased_changelog" == "true"');
    const releaseRefGuard = captureInputs?.run.indexOf(
      '"$RELEASE_REF_INPUT" =~ ^(refs/heads/)?(release/',
    );
    expect(explicitOptIn).toBeGreaterThanOrEqual(0);
    expect(releaseRefGuard).toBeGreaterThan(explicitOptIn ?? -1);
    expect(workflow.jobs.install_smoke_release_checks.with.allow_unreleased_changelog).toBe(
      currentTreeAllowance,
    );
    expect(workflow.jobs.live_repo_e2e_release_checks.with.allow_unreleased_changelog).toBe(
      currentTreeAllowance,
    );
    expect(workflow.jobs.docker_e2e_release_checks.with.allow_unreleased_changelog).toBe(
      currentTreeAllowance,
    );
    const fullReleaseAllowance =
      "${{ inputs.allow_unreleased_changelog || (inputs.target_context_ref == '' && (inputs.ref == 'main' || inputs.ref == 'refs/heads/main')) }}";
    const summarizeTarget = fullReleaseWorkflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.name === "Summarize target",
    );
    const releaseChecksDispatch = fullReleaseWorkflow.jobs.release_checks.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch release checks",
    );
    expect(summarizeTarget?.env?.ALLOW_UNRELEASED_CHANGELOG).toBe(fullReleaseAllowance);
    expect(releaseChecksDispatch?.env?.ALLOW_UNRELEASED_CHANGELOG).toBe(fullReleaseAllowance);
  });

  it("keeps runtime tool coverage blocking in release checks", () => {
    const releaseChecksSource = readFileSync(
      ".github/workflows/openclaw-release-checks.yml",
      "utf8",
    );
    const releaseChecksWorkflow = parse(releaseChecksSource);
    const runtimeToolCoverage = releaseChecksWorkflow.jobs.runtime_tool_coverage_release_checks;

    expect(runtimeToolCoverage["continue-on-error"]).toBeUndefined();
    expect(runtimeToolCoverage.needs).toEqual([
      "resolve_target",
      "qa_lab_runtime_parity_release_checks",
    ]);
    expect(runtimeToolCoverage.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Enforce core runtime tool coverage",
          run: expect.stringContaining("pnpm openclaw qa coverage"),
        }),
      ]),
    );
    expect(runtimeToolCoverage.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Enforce core runtime tool coverage",
          run: expect.stringContaining(
            "--summary .artifacts/qa-e2e/runtime-pair-core/qa-suite-summary.json",
          ),
        }),
      ]),
    );
    expect(releaseChecksWorkflow.jobs.summary.needs).toContain(
      "runtime_tool_coverage_release_checks",
    );
    const verifyStep = releaseChecksWorkflow.jobs.summary.steps.find(
      (step: { name?: string }) => step.name === "Verify release check results",
    );
    expect(verifyStep.env.RUNTIME_TOOL_COVERAGE_RELEASE_CHECKS_RESULT).toBe(
      "${{ needs.runtime_tool_coverage_release_checks.result }}",
    );
    expect(verifyStep.run).toContain(
      '"runtime_tool_coverage_release_checks=${RUNTIME_TOOL_COVERAGE_RELEASE_CHECKS_RESULT}"',
    );
  });

  it("keeps the live-ish availability check redacted", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/plugin-prerelease-liveish-matrix.mts"],
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
