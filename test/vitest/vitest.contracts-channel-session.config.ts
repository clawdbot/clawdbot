// Vitest contracts channel session config wires the contracts channel session test shard.
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
