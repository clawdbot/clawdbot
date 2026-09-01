// Directory registry shard F tests cover directory channel contracts against registry-backed fixtures.
import { installDirectoryContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installDirectoryContractRegistryShard({ shardIndex: 5, shardCount: 8 });
