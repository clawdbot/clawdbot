// Surface registry shard G tests cover exposed channel plugin surfaces against registry fixtures.
import { installSurfaceContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installSurfaceContractRegistryShard({ shardIndex: 6, shardCount: 8 });
