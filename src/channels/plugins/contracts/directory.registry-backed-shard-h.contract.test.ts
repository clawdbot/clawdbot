// Directory registry shard H tests cover directory channel contracts against registry-backed fixtures.
import { installDirectoryContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installDirectoryContractRegistryShard({ shardIndex: 7, shardCount: 8 });
