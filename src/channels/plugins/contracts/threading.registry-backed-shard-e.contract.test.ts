// Threading registry shard E tests cover thread binding contracts against registry-backed fixtures.
import { installThreadingContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installThreadingContractRegistryShard({ shardIndex: 4, shardCount: 8 });
