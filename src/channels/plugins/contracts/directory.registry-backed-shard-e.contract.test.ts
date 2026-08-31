// Directory registry shard E tests cover directory channel contracts against registry-backed fixtures.
import { installDirectoryContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installDirectoryContractRegistryShard({ shardIndex: 4, shardCount: 8 });
