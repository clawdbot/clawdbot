// Surface registry shard H tests cover exposed channel plugin surfaces against registry fixtures.
import { installSurfaceContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installSurfaceContractRegistryShard({ shardIndex: 7, shardCount: 8 });
