// Plugin registry shard H tests cover channel plugin contracts against registry-backed fixtures.
import { installPluginContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installPluginContractRegistryShard({ shardIndex: 7, shardCount: 8 });
