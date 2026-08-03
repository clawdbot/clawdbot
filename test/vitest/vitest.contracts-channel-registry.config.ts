// Vitest contracts channel registry config wires the contracts channel registry test shard.
import {
  channelRegistryContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export default createContractsVitestConfig(
  channelRegistryContractPatterns,
  process.env,
  process.argv,
  {
    name: "contracts-channel-registry",
  },
);
