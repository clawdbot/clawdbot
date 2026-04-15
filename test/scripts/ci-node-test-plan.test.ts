import { describe, expect, it } from "vitest";
import { createNodeTestShards } from "../../scripts/lib/ci-node-test-plan.mjs";

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

    expect(requiresDistShardNames).toEqual([
      "core-support-boundary",
      "core-runtime",
      "agentic-agents-plugins",
    ]);
  });

  it("splits the agentic lane into control-plane, commands, and agent/plugin shards", () => {
    const shards = createNodeTestShards();
    const controlPlaneShard = shards.find((shard) => shard.shardName === "agentic-control-plane");
    const commandsShard = shards.find((shard) => shard.shardName === "agentic-commands");
    const agentPluginShard = shards.find((shard) => shard.shardName === "agentic-agents-plugins");

    expect(controlPlaneShard).toEqual({
      checkName: "checks-node-agentic-control-plane",
      shardName: "agentic-control-plane",
      configs: [
        "test/vitest/vitest.gateway-core.config.ts",
        "test/vitest/vitest.gateway-client.config.ts",
        "test/vitest/vitest.gateway-methods.config.ts",
        "test/vitest/vitest.gateway-server.config.ts",
        "test/vitest/vitest.daemon.config.ts",
      ],
      requiresDist: false,
    });
    expect(commandsShard).toEqual({
      checkName: "checks-node-agentic-commands",
      shardName: "agentic-commands",
      configs: [
        "test/vitest/vitest.cli.config.ts",
        "test/vitest/vitest.commands-light.config.ts",
        "test/vitest/vitest.commands.config.ts",
      ],
      requiresDist: false,
    });
    expect(agentPluginShard).toEqual({
      checkName: "checks-node-agentic-agents-plugins",
      shardName: "agentic-agents-plugins",
      configs: [
        "test/vitest/vitest.agents.config.ts",
        "test/vitest/vitest.plugin-sdk-light.config.ts",
        "test/vitest/vitest.plugin-sdk.config.ts",
        "test/vitest/vitest.plugins.config.ts",
      ],
      requiresDist: true,
    });
  });
});
