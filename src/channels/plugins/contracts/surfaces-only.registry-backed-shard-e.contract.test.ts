// Surface registry shard E tests cover exposed channel plugin surfaces against registry fixtures.
import { installSurfaceContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installSurfaceContractRegistryShard({ shardIndex: 4, shardCount: 8 });
