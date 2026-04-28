import { installThreadingContractRegistryShard } from "./test-helpers/registry-backed-contract-shards.js";

installThreadingContractRegistryShard({ shardIndex: 1, shardCount: 8 });
