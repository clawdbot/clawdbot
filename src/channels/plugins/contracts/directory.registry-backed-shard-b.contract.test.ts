// Directory registry shard B tests cover directory channel contracts against registry-backed fixtures.
import { installDirectoryContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installDirectoryContractRegistryShard({ shardIndex: 1, shardCount: 8 });
