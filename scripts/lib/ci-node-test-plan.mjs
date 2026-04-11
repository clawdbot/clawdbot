import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";

const EXCLUDED_FULL_SUITE_SHARDS = new Set([
  "test/vitest/vitest.full-core-contracts.config.ts",
  "test/vitest/vitest.full-core-bundled.config.ts",
  "test/vitest/vitest.full-extensions.config.ts",
]);

const EXCLUDED_PROJECT_CONFIGS = new Set(["test/vitest/vitest.channels.config.ts"]);

export function createNodeTestShards() {
  return fullSuiteVitestShards.flatMap((shard) => {
    if (EXCLUDED_FULL_SUITE_SHARDS.has(shard.config)) {
      return [];
    }

    const configs = shard.projects.filter((config) => !EXCLUDED_PROJECT_CONFIGS.has(config));
    if (configs.length === 0) {
      return [];
    }

    return [
      {
        checkName: `checks-node-core-test-${shard.name}`,
        shardName: shard.name,
        configs,
      },
    ];
  });
}
