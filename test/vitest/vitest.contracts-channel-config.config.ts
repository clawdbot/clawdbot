// Vitest contracts channel config config wires the contracts channel config test shard.
import {
  channelConfigContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export default createContractsVitestConfig(
  channelConfigContractPatterns,
  process.env,
  process.argv,
  {
    name: "contracts-channel-config",
  },
);
