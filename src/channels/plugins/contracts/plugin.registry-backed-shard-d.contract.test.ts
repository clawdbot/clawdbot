// Plugin registry shard D tests cover channel plugin contracts against registry-backed fixtures.
import { installPluginContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installPluginContractRegistryShard({ shardIndex: 3, shardCount: 8 });
