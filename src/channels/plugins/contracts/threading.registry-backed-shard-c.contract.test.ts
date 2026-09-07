// Threading registry shard C tests cover thread binding contracts against registry-backed fixtures.
import { installThreadingContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installThreadingContractRegistryShard({ shardIndex: 2, shardCount: 8 });
