// Surface registry shard D tests cover exposed channel plugin surfaces against registry fixtures.
import { installSurfaceContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installSurfaceContractRegistryShard({ shardIndex: 3, shardCount: 8 });
