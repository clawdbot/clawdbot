// Vitest full core unit config wires the full core unit test shard.
import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";
import { fullSuiteVitestShards } from "./vitest.test-shards.mjs";

export default createProjectShardVitestConfig(fullSuiteVitestShards[0].projects);
