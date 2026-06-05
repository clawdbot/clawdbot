// Vitest full core unit ui config wires the full core unit ui test shard.
import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";
import { fullSuiteVitestShards } from "./vitest.test-shards.mjs";

export default createProjectShardVitestConfig(
  fullSuiteVitestShards.find(
    (shard) => shard.config === "test/vitest/vitest.full-core-unit-ui.config.ts",
  )?.projects ?? [],
);
