// Threading registry shard F tests cover thread binding contracts against registry-backed fixtures.
import { installThreadingContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installThreadingContractRegistryShard({ shardIndex: 5, shardCount: 8 });
