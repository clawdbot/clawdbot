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
