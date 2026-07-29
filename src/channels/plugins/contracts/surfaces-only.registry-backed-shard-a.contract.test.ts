// Surface registry shard A tests cover exposed channel plugin surfaces against registry fixtures.
import { installSurfaceContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installSurfaceContractRegistryShard({ shardIndex: 0, shardCount: 8 });
