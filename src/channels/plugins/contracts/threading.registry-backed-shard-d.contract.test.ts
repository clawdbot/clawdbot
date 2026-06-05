// Threading registry shard D tests cover thread binding contracts against registry-backed fixtures.
import { installThreadingContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installThreadingContractRegistryShard({ shardIndex: 3, shardCount: 8 });
