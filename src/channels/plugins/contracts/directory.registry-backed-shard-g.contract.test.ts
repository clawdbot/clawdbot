// Directory registry shard G tests cover directory channel contracts against registry-backed fixtures.
import { installDirectoryContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installDirectoryContractRegistryShard({ shardIndex: 6, shardCount: 8 });
