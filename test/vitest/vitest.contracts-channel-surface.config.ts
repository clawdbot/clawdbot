// Vitest contracts channel surface config wires the contracts channel surface test shard.
import {
  channelSurfaceContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export default createContractsVitestConfig(
  channelSurfaceContractPatterns,
  process.env,
  process.argv,
  {
    name: "contracts-channel-surface",
  },
);
