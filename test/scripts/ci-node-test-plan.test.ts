import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import fg from "fast-glob";
import { describe, expect, it } from "vitest";
import { createNodeTestShards } from "../../scripts/lib/ci-node-test-plan.mjs";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, sortRepoPaths, toRepoPath } from "../../src/test-utils/repo-files.js";
import { commandsLightTestFiles } from "../vitest/vitest.commands-light-paths.mjs";
import { createPluginsVitestConfig } from "../vitest/vitest.plugins.config.ts";

type VitestTestConfig = {
  dir?: string;
  exclude?: string[];
  include?: string[];
};

type VitestConfig = {
  test?: VitestTestConfig;
};

const PLUGIN_PRERELEASE_NPM_SPEC_TEST = "src/plugins/install.npm-spec.test.ts";
const PLUGIN_NPM_INSTALL_SECURITY_SCAN_TEST =
  "src/plugins/npm-install-security-scan.release.test.ts";
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const GATEWAY_SERVER_BACKED_HTTP_TESTS = new Set([
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
]);

const GATEWAY_SERVER_EXCLUDED_TESTS = new Set([
  "src/gateway/gateway.test.ts",
  "src/gateway/server.startup-matrix-migration.integration.test.ts",
  "src/gateway/sessions-history-http.test.ts",
]);

function listTestFiles(rootDir: string): string[] {
  const gitFiles = listGitTrackedFiles({ pathspecs: rootDir });
  expect(gitFiles).not.toBeNull();
  if (gitFiles) {
    return gitFiles.filter((line) => line.endsWith(".test.ts"));
  }

  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(toRepoPath(path));
      }
    }
  };

  visit(rootDir);
  return sortRepoPaths(files);
}

function listMatchedTestFiles(config: VitestConfig): string[] {
  const testConfig = config.test ?? {};
  const cwd = testConfig.dir ? resolve(testConfig.dir) : process.cwd();
  return fg
    .sync(testConfig.include ?? [], {
      absolute: false,
      cwd,
      dot: false,
      ignore: testConfig.exclude ?? [],
    })
    .map((file) => toRepoPath(relative(process.cwd(), resolve(cwd, file))))
    .toSorted((a, b) => a.localeCompare(b));
}

function isGatewayServerTestFile(file: string): boolean {
  return (
    file.startsWith("src/gateway/") &&
    !file.startsWith("src/gateway/server-methods/") &&
    !GATEWAY_SERVER_EXCLUDED_TESTS.has(file) &&
    (file.includes("server") || GATEWAY_SERVER_BACKED_HTTP_TESTS.has(file))
  );
}

describe("scripts/lib/ci-node-test-plan.mjs", () => {
  it("creates split shards without walking test roots", () => {
    const payload = expectNoNodeFsScans<{
      includePatterns: number;
      shards: number;
    }>(`
      const { createNodeTestShards } = await import("./scripts/lib/ci-node-test-plan.mjs");
      const shards = createNodeTestShards();
      return {
        includePatterns: shards.reduce(
          (total, shard) => total + (shard.includePatterns?.length ?? 0),
          0,
        ),
        shards: shards.length,
      };
    `);
    expect(payload.shards).toBeGreaterThan(0);
    expect(payload.includePatterns).toBeGreaterThan(0);
  });

  it("splits the slow core unit shards while keeping paired source/security coverage", () => {
    const coreUnitShards = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("core-unit-"))
      .map((shard) => ({
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        shardName: shard.shardName,
      }));

    expect(coreUnitShards).toEqual([
      {
        configs: [
          "test/vitest/vitest.unit-fast.config.ts",
          "test/vitest/vitest.unit-fast-fake-timers.config.ts",
        ],
        requiresDist: false,
        shardName: "core-unit-fast",
      },
      {
        configs: [
          "test/vitest/vitest.unit-src.config.ts",
          "test/vitest/vitest.unit-security.config.ts",
        ],
        requiresDist: false,
        shardName: "core-unit-src-security",
      },
      {
        configs: ["test/vitest/vitest.unit-ui.config.ts"],
        requiresDist: false,
        shardName: "core-unit-ui",
      },
      {
        configs: ["test/vitest/vitest.unit-support.config.ts"],
        requiresDist: false,
        shardName: "core-unit-support",
      },
    ]);
  });

  it("names the node shard checks as core test lanes", () => {
    const shards = createNodeTestShards();

    expect(shards).not.toHaveLength(0);
    expect(shards.map((shard) => shard.checkName)).toEqual(
      shards.map((shard) =>
        shard.shardName.startsWith("core-unit-")
          ? `checks-node-core-${shard.shardName.slice("core-unit-".length)}`
          : `checks-node-${shard.shardName}`,
      ),
    );
  });

  it("keeps extension, bundled, contracts, and channels configs out of the core node lane", () => {
    const configs = createNodeTestShards().flatMap((shard) => shard.configs);

    expect(configs).not.toContain("test/vitest/vitest.channels.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.contracts.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.bundled.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.extension-telegram.config.ts");
  });

  it("marks only dist-dependent shards for built artifact restore", () => {
    const requiresDistShardNames = createNodeTestShards()
      .filter((shard) => shard.requiresDist)
      .map((shard) => shard.shardName);

    expect(requiresDistShardNames).toEqual(["core-support-boundary"]);
  });

  it("assigns Blacksmith runners to every core node shard", () => {
    const shards = createNodeTestShards();

    expect(shards).not.toHaveLength(0);
    expect(shards.every((shard) => shard.runner?.startsWith("blacksmith-"))).toBe(true);
  });

  it("splits core runtime configs into smaller source-only shards", () => {
    const runtimeShards = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("core-runtime-"))
      .map((shard) => ({
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        runner: shard.runner,
        shardName: shard.shardName,
      }));

    expect(runtimeShards).toEqual([
      {
        configs: ["test/vitest/vitest.hooks.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-hooks",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-approval-exec",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-channel-plugin",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-cli-ui",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-device",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-diagnostics-state",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-core-utils",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-env-auth",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-events-runtime",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-file-safety",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-files-commands",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-lock-argv",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-processes",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-watch",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-heartbeat-core",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-heartbeat-runner",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-dedupe-disk",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-os",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-values",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-net-install",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-network-node",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-network-platform",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-outbound-actions",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-outbound-core",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-provider-push",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-repo-tooling",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-storage-state",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-system-runtime",
      },
      {
        configs: ["test/vitest/vitest.secrets.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-secrets",
      },
      {
        configs: [
          "test/vitest/vitest.logging.config.ts",
          "test/vitest/vitest.process.config.ts",
          "test/vitest/vitest.runtime-config.config.ts",
        ],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-process",
      },
      {
        configs: [
          "test/vitest/vitest.media.config.ts",
          "test/vitest/vitest.media-understanding.config.ts",
          "test/vitest/vitest.tui.config.ts",
          "test/vitest/vitest.ui.config.ts",
          "test/vitest/vitest.wizard.config.ts",
        ],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui",
      },
      {
        configs: [
          "test/vitest/vitest.acp.config.ts",
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-shared",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-core",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-isolated-agent",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-service",
      },
    ]);
  });

  it("covers every infra test exactly once across core runtime infra shards", () => {
    const infraShards = createNodeTestShards().filter((shard) =>
      shard.shardName.startsWith("core-runtime-infra-"),
    );
    const actual = infraShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(infraShards.map((shard) => shard.shardName)).toEqual([
      "core-runtime-infra-approval-exec",
      "core-runtime-infra-channel-plugin",
      "core-runtime-infra-cli-ui",
      "core-runtime-infra-device",
      "core-runtime-infra-diagnostics-state",
      "core-runtime-infra-core-utils",
      "core-runtime-infra-env-auth",
      "core-runtime-infra-events-runtime",
      "core-runtime-infra-file-safety",
      "core-runtime-infra-files-commands",
      "core-runtime-infra-gateway-lock-argv",
      "core-runtime-infra-gateway-processes",
      "core-runtime-infra-gateway-watch",
      "core-runtime-infra-heartbeat-core",
      "core-runtime-infra-heartbeat-runner",
      "core-runtime-infra-misc-dedupe-disk",
      "core-runtime-infra-misc-os",
      "core-runtime-infra-misc-values",
      "core-runtime-infra-net-install",
      "core-runtime-infra-network-node",
      "core-runtime-infra-network-platform",
      "core-runtime-infra-outbound-actions",
      "core-runtime-infra-outbound-core",
      "core-runtime-infra-provider-push",
      "core-runtime-infra-repo-tooling",
      "core-runtime-infra-storage-state",
      "core-runtime-infra-system-runtime",
      "core-runtime-infra-process",
    ]);
    expect(actual).toEqual(listTestFiles("src/infra"));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("covers every cron test exactly once across core runtime cron shards", () => {
    const cronShards = createNodeTestShards().filter((shard) =>
      shard.shardName.startsWith("core-runtime-cron-"),
    );
    const actual = cronShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(cronShards.map((shard) => shard.shardName)).toEqual([
      "core-runtime-cron-core",
      "core-runtime-cron-isolated-agent",
      "core-runtime-cron-service",
    ]);
    expect(actual).toEqual(listTestFiles("src/cron"));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("splits the agentic lane into control-plane, command, agent, gateway, SDK, and plugin shards", () => {
    const shards = createNodeTestShards();
    const controlPlaneShards = shards.filter((shard) =>
      shard.shardName.startsWith("agentic-control-plane-"),
    );
    const cliShard = shards.find((shard) => shard.shardName === "agentic-cli");
    const commandSupportShard = shards.find(
      (shard) => shard.shardName === "agentic-command-support",
    );
    const commandShards = shards.filter((shard) => shard.shardName.startsWith("agentic-commands-"));
    const agentShards = shards.filter((shard) => shard.shardName.startsWith("agentic-agents-"));
    const gatewayCoreShard = shards.find((shard) => shard.shardName === "agentic-gateway-core");
    const gatewayMethodsShard = shards.find(
      (shard) => shard.shardName === "agentic-gateway-methods",
    );
    const pluginSdkShard = shards.find((shard) => shard.shardName === "agentic-plugin-sdk");
    const pluginsShard = shards.find((shard) => shard.shardName === "agentic-plugins");

    expect(controlPlaneShards.map((shard) => shard.shardName)).toEqual([
      "agentic-control-plane-agent-chat",
      "agentic-control-plane-auth-node",
      "agentic-control-plane-http-models",
      "agentic-control-plane-http-plugin-ws",
      "agentic-control-plane-runtime",
      "agentic-control-plane-runtime-config",
      "agentic-control-plane-runtime-cron",
      "agentic-control-plane-runtime-events",
      "agentic-control-plane-runtime-network",
      "agentic-control-plane-runtime-server",
      "agentic-control-plane-runtime-shared-token",
      "agentic-control-plane-runtime-state",
      "agentic-control-plane-runtime-ui-tools",
      "agentic-control-plane-startup-config",
      "agentic-control-plane-startup-core",
      "agentic-control-plane-startup-health-runtime",
      "agentic-control-plane-startup-restart-close",
    ]);
    expect(controlPlaneShards).toEqual(
      controlPlaneShards.map((shard) => ({
        checkName: `checks-node-${shard.shardName}`,
        configs: ["test/vitest/vitest.gateway-server.config.ts"],
        includePatterns: shard.includePatterns,
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: shard.shardName,
      })),
    );
    const controlPlaneShardFiles = controlPlaneShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expectedControlPlaneFiles = listTestFiles("src/gateway")
      .filter(isGatewayServerTestFile)
      .toSorted((a, b) => a.localeCompare(b));
    expect(controlPlaneShardFiles).toEqual(expectedControlPlaneFiles);
    expect(new Set(controlPlaneShardFiles).size).toBe(controlPlaneShardFiles.length);
    expect(cliShard).toEqual({
      checkName: "checks-node-agentic-cli",
      shardName: "agentic-cli",
      configs: ["test/vitest/vitest.cli.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(commandSupportShard).toEqual({
      checkName: "checks-node-agentic-command-support",
      shardName: "agentic-command-support",
      configs: [
        "test/vitest/vitest.commands-light.config.ts",
        "test/vitest/vitest.daemon.config.ts",
      ],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(commandShards.map((shard) => shard.shardName)).toEqual([
      "agentic-commands-agent-channel",
      "agentic-commands-doctor",
      "agentic-commands-doctor-auth",
      "agentic-commands-doctor-config-state",
      "agentic-commands-doctor-device",
      "agentic-commands-doctor-gateway",
      "agentic-commands-doctor-platform",
      "agentic-commands-doctor-plugins-tools",
      "agentic-commands-doctor-sessions-cron",
      "agentic-commands-doctor-shared",
      "agentic-commands-doctor-whatsapp",
      "agentic-commands-doctor-workspace",
      "agentic-commands-models",
      "agentic-commands-onboard-config",
      "agentic-commands-status-tools",
    ]);
    expect(commandShards).toEqual(
      commandShards.map((shard) => ({
        checkName: `checks-node-${shard.shardName}`,
        configs: ["test/vitest/vitest.commands.config.ts"],
        includePatterns: shard.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: shard.shardName,
      })),
    );
    expect(
      commandShards.find((shard) => shard.shardName === "agentic-commands-doctor-auth")
        ?.includePatterns,
    ).toContain("src/commands/oauth-tls-preflight.doctor.test.ts");
    const commandShardFiles = commandShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expectedCommandFiles = listTestFiles("src/commands")
      .filter((file) => !commandsLightTestFiles.includes(file) && !file.endsWith(".e2e.test.ts"))
      .toSorted((a, b) => a.localeCompare(b));
    expect(commandShardFiles).toEqual(expectedCommandFiles);
    expect(new Set(commandShardFiles).size).toBe(commandShardFiles.length);
    expect(agentShards).toEqual([
      {
        checkName: "checks-node-agentic-agents-core-auth",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[0]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-auth",
      },
      {
        checkName: "checks-node-agentic-agents-core-models",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[1]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-models",
      },
      {
        checkName: "checks-node-agentic-agents-core-tools",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[2]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-tools",
      },
      {
        checkName: "checks-node-agentic-agents-core-subagents",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[3]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-subagents",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[4]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner",
      },
      {
        checkName: "checks-node-agentic-agents-core-runtime",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[5]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runtime",
      },
      {
        checkName: "checks-node-agentic-agents-embedded",
        configs: ["test/vitest/vitest.agents-embedded-agent.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-embedded",
      },
      {
        checkName: "checks-node-agentic-agents-support",
        configs: ["test/vitest/vitest.agents-support.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-support",
      },
      {
        checkName: "checks-node-agentic-agents-tools",
        configs: ["test/vitest/vitest.agents-tools.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-tools",
      },
    ]);
    expect(pluginSdkShard).toEqual({
      checkName: "checks-node-agentic-plugin-sdk",
      shardName: "agentic-plugin-sdk",
      configs: [
        "test/vitest/vitest.plugin-sdk-light.config.ts",
        "test/vitest/vitest.plugin-sdk.config.ts",
      ],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(gatewayCoreShard).toEqual({
      checkName: "checks-node-agentic-gateway-core",
      shardName: "agentic-gateway-core",
      configs: [
        "test/vitest/vitest.gateway-core.config.ts",
        "test/vitest/vitest.gateway-client.config.ts",
      ],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(gatewayMethodsShard).toEqual({
      checkName: "checks-node-agentic-gateway-methods",
      shardName: "agentic-gateway-methods",
      configs: ["test/vitest/vitest.gateway-methods.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      shardName: "agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
  });

  it("keeps plugin prerelease npm install coverage on the release-only agentic plugin shard", () => {
    const pluginsShard = createNodeTestShards().find(
      (shard) => shard.shardName === "agentic-plugins",
    );

    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
      shardName: "agentic-plugins",
    });
    expect(listMatchedTestFiles(createPluginsVitestConfig({}))).toContain(
      PLUGIN_PRERELEASE_NPM_SPEC_TEST,
    );
    expect(listMatchedTestFiles(createPluginsVitestConfig({}))).toContain(
      PLUGIN_NPM_INSTALL_SECURITY_SCAN_TEST,
    );
  });

  it("covers every flat agents-core test exactly once across split shards", () => {
    const actual = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("agentic-agents-core-"))
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expected = listTestFiles("src/agents")
      .filter((file) => !relative("src/agents", file).includes("/"))
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps expensive plugin shards release-only when normal CI asks for the cheaper plan", () => {
    const shards = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const shardNames = shards.map((shard) => shard.shardName);

    expect(shardNames).not.toContain("agentic-plugins");
    expect(shardNames).toContain("agentic-gateway-core");
    expect(shardNames).toContain("agentic-gateway-methods");
    expect(shardNames).toContain("agentic-plugin-sdk");
  });

  it("splits auto-reply into balanced core/top-level and reply subtree shards", () => {
    const shards = createNodeTestShards();
    const autoReplyShards = shards
      .filter((shard) => shard.shardName.startsWith("auto-reply"))
      .map((shard) => ({
        checkName: shard.checkName,
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        shardName: shard.shardName,
      }));

    expect(autoReplyShards).toEqual([
      {
        checkName: "checks-node-auto-reply-core-top-level",
        configs: [
          "test/vitest/vitest.auto-reply-core.config.ts",
          "test/vitest/vitest.auto-reply-top-level.config.ts",
        ],
        requiresDist: false,
        shardName: "auto-reply-core-top-level",
      },
      {
        checkName: "checks-node-auto-reply-reply-agent-runner",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-agent-runner",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch",
      },
      {
        checkName: "checks-node-auto-reply-reply-session",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-session",
      },
      {
        checkName: "checks-node-auto-reply-reply-state-routing",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-state-routing",
      },
    ]);
  });

  it("covers every auto-reply reply test exactly once across split shards", () => {
    const actual = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("auto-reply-reply-"))
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(listTestFiles("src/auto-reply/reply"));
    expect(new Set(actual).size).toBe(actual.length);
  });
});
