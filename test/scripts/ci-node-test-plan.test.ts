import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import fg from "fast-glob";
import { describe, expect, it } from "vitest";
import { createNodeTestShards } from "../../scripts/lib/ci-node-test-plan.mjs";
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
        files.push(path.replaceAll("\\", "/"));
      }
    }
  };

  visit(rootDir);
  return files.toSorted((a, b) => a.localeCompare(b));
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
    .map((file) => relative(process.cwd(), resolve(cwd, file)).replaceAll("\\", "/"))
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
  it("combines the small core unit shards to reduce CI runner fanout", () => {
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
          "test/vitest/vitest.unit-support.config.ts",
        ],
        requiresDist: false,
        shardName: "core-unit-fast-support",
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
        configs: [
          "test/vitest/vitest.infra.config.ts",
          "test/vitest/vitest.hooks.config.ts",
          "test/vitest/vitest.secrets.config.ts",
          "test/vitest/vitest.logging.config.ts",
          "test/vitest/vitest.process.config.ts",
          "test/vitest/vitest.runtime-config.config.ts",
        ],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra",
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
        runner: undefined,
        shardName: "core-runtime-media-ui",
      },
      {
        configs: [
          "test/vitest/vitest.acp.config.ts",
          "test/vitest/vitest.cron.config.ts",
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
        runner: undefined,
        shardName: "core-runtime-shared",
      },
    ]);
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
    const agentShard = shards.find((shard) => shard.shardName === "agentic-agents");
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
      "agentic-control-plane-runtime",
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
    });
    expect(commandSupportShard).toEqual({
      checkName: "checks-node-agentic-command-support",
      shardName: "agentic-command-support",
      configs: [
        "test/vitest/vitest.commands-light.config.ts",
        "test/vitest/vitest.daemon.config.ts",
      ],
      requiresDist: false,
    });
    expect(commandShards.map((shard) => shard.shardName)).toEqual([
      "agentic-commands-agent-channel",
      "agentic-commands-doctor",
      "agentic-commands-doctor-shared",
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
        shardName: shard.shardName,
      })),
    );
    const commandShardFiles = commandShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expectedCommandFiles = listTestFiles("src/commands")
      .filter((file) => !commandsLightTestFiles.includes(file))
      .toSorted((a, b) => a.localeCompare(b));
    expect(commandShardFiles).toEqual(expectedCommandFiles);
    expect(new Set(commandShardFiles).size).toBe(commandShardFiles.length);
    expect(agentShard).toEqual({
      checkName: "checks-node-agentic-agents",
      shardName: "agentic-agents",
      configs: [
        "test/vitest/vitest.agents-core.config.ts",
        "test/vitest/vitest.agents-pi-embedded.config.ts",
        "test/vitest/vitest.agents-support.config.ts",
        "test/vitest/vitest.agents-tools.config.ts",
      ],
      requiresDist: false,
    });
    expect(pluginSdkShard).toEqual({
      checkName: "checks-node-agentic-plugin-sdk",
      shardName: "agentic-plugin-sdk",
      configs: [
        "test/vitest/vitest.plugin-sdk-light.config.ts",
        "test/vitest/vitest.plugin-sdk.config.ts",
      ],
      requiresDist: false,
    });
    expect(gatewayCoreShard).toEqual({
      checkName: "checks-node-agentic-gateway-core",
      shardName: "agentic-gateway-core",
      configs: [
        "test/vitest/vitest.gateway-core.config.ts",
        "test/vitest/vitest.gateway-client.config.ts",
      ],
      requiresDist: false,
    });
    expect(gatewayMethodsShard).toEqual({
      checkName: "checks-node-agentic-gateway-methods",
      shardName: "agentic-gateway-methods",
      configs: ["test/vitest/vitest.gateway-methods.config.ts"],
      requiresDist: false,
    });
    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      shardName: "agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      requiresDist: false,
    });
  });

  it("keeps plugin prerelease npm install coverage on the release-only agentic plugin shard", () => {
    const pluginsShard = createNodeTestShards().find(
      (shard) => shard.shardName === "agentic-plugins",
    );

    expect(pluginsShard).toMatchObject({
      checkName: "checks-node-agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      requiresDist: false,
      shardName: "agentic-plugins",
    });
    expect(listMatchedTestFiles(createPluginsVitestConfig({}))).toContain(
      PLUGIN_PRERELEASE_NPM_SPEC_TEST,
    );
  });

  it("keeps expensive plugin shards release-only when normal CI asks for the cheaper plan", () => {
    const shards = createNodeTestShards({ includeReleaseOnlyPluginShards: false });

    expect(shards.some((shard) => shard.shardName === "agentic-plugins")).toBe(false);
    expect(shards.some((shard) => shard.shardName === "agentic-gateway-core")).toBe(true);
    expect(shards.some((shard) => shard.shardName === "agentic-gateway-methods")).toBe(true);
    expect(shards.some((shard) => shard.shardName === "agentic-plugin-sdk")).toBe(true);
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
