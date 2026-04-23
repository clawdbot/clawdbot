import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeTestShards } from "../../scripts/lib/ci-node-test-plan.mjs";

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

describe("scripts/lib/ci-node-test-plan.mjs", () => {
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
        shardName: "core-runtime-shared",
      },
    ]);
  });

  it("splits the agentic lane into control-plane, commands, agent, SDK, and plugin shards", () => {
    const shards = createNodeTestShards();
    const controlPlaneShard = shards.find((shard) => shard.shardName === "agentic-control-plane");
    const commandsShard = shards.find((shard) => shard.shardName === "agentic-commands");
    const agentShard = shards.find((shard) => shard.shardName === "agentic-agents");
    const pluginSdkShard = shards.find((shard) => shard.shardName === "agentic-plugin-sdk");
    const pluginsShard = shards.find((shard) => shard.shardName === "agentic-plugins");

    expect(controlPlaneShard).toEqual({
      checkName: "checks-node-agentic-control-plane",
      shardName: "agentic-control-plane",
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      requiresDist: false,
    });
    expect(commandsShard).toEqual({
      checkName: "checks-node-agentic-commands",
      shardName: "agentic-commands",
      configs: [
        "test/vitest/vitest.cli.config.ts",
        "test/vitest/vitest.commands-light.config.ts",
        "test/vitest/vitest.commands.config.ts",
        "test/vitest/vitest.daemon.config.ts",
      ],
      requiresDist: false,
    });
    expect(agentShard).toEqual({
      checkName: "checks-node-agentic-agents",
      shardName: "agentic-agents",
      configs: ["test/vitest/vitest.agents.config.ts"],
      requiresDist: false,
    });
    expect(pluginSdkShard).toEqual({
      checkName: "checks-node-agentic-plugin-sdk",
      shardName: "agentic-plugin-sdk",
      configs: [
        "test/vitest/vitest.gateway-core.config.ts",
        "test/vitest/vitest.gateway-client.config.ts",
        "test/vitest/vitest.gateway-methods.config.ts",
        "test/vitest/vitest.plugin-sdk-light.config.ts",
        "test/vitest/vitest.plugin-sdk.config.ts",
      ],
      requiresDist: false,
    });
    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      shardName: "agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      requiresDist: false,
    });
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
        checkName: "checks-node-auto-reply-reply-agent-dispatch",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-agent-dispatch",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands-state-routing",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands-state-routing",
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
