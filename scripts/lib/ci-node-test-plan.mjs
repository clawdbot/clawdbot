import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";

const EXCLUDED_FULL_SUITE_SHARDS = new Set([
  "test/vitest/vitest.full-core-contracts.config.ts",
  "test/vitest/vitest.full-core-bundled.config.ts",
  "test/vitest/vitest.full-extensions.config.ts",
]);

const EXCLUDED_PROJECT_CONFIGS = new Set(["test/vitest/vitest.channels.config.ts"]);
const SPLIT_NODE_SHARDS = new Map([
  [
    "agentic",
    [
      {
        shardName: "agentic-control-plane",
        configs: [
          "test/vitest/vitest.gateway-core.config.ts",
          "test/vitest/vitest.gateway-client.config.ts",
          "test/vitest/vitest.gateway-methods.config.ts",
          "test/vitest/vitest.gateway-server.config.ts",
          "test/vitest/vitest.daemon.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-commands",
        configs: [
          "test/vitest/vitest.cli.config.ts",
          "test/vitest/vitest.commands-light.config.ts",
          "test/vitest/vitest.commands.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-plugins",
        configs: [
          "test/vitest/vitest.agents.config.ts",
          "test/vitest/vitest.plugin-sdk-light.config.ts",
          "test/vitest/vitest.plugin-sdk.config.ts",
          "test/vitest/vitest.plugins.config.ts",
        ],
        requiresDist: true,
      },
    ],
  ],
]);
const DIST_DEPENDENT_NODE_SHARD_NAMES = new Set(["core-support-boundary", "core-runtime"]);

function formatNodeTestShardCheckName(shardName) {
  const normalizedShardName = shardName.startsWith("core-unit-")
    ? `core-${shardName.slice("core-unit-".length)}`
    : shardName;
  return `checks-node-${normalizedShardName}`;
}

export function createNodeTestShards() {
  return fullSuiteVitestShards.flatMap((shard) => {
    if (EXCLUDED_FULL_SUITE_SHARDS.has(shard.config)) {
      return [];
    }

    const configs = shard.projects.filter((config) => !EXCLUDED_PROJECT_CONFIGS.has(config));
    if (configs.length === 0) {
      return [];
    }

    const splitShards = SPLIT_NODE_SHARDS.get(shard.name);
    if (splitShards) {
      return splitShards.flatMap((splitShard) => {
        const splitConfigs = splitShard.configs.filter((config) => configs.includes(config));
        if (splitConfigs.length === 0) {
          return [];
        }

        return [
          {
            checkName: formatNodeTestShardCheckName(splitShard.shardName),
            shardName: splitShard.shardName,
            configs: splitConfigs,
            requiresDist: splitShard.requiresDist,
          },
        ];
      });
    }

    return [
      {
        checkName: formatNodeTestShardCheckName(shard.name),
        shardName: shard.name,
        configs,
        requiresDist: DIST_DEPENDENT_NODE_SHARD_NAMES.has(shard.name),
      },
    ];
  });
}
