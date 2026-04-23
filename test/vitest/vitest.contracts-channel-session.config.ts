import {
  channelSessionContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export default createContractsVitestConfig(
  channelSessionContractPatterns,
  process.env,
  process.argv,
  {
    name: "contracts-channel-session",
  },
);
