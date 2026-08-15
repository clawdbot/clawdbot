// Vitest contracts channel surface config wires the contracts channel surface test shard.
import {
  channelSurfaceContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export function createContractsChannelSurfaceVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  return createContractsVitestConfig(channelSurfaceContractPatterns, env, argv, {
    name: "contracts-channel-surface",
  });
}

export default createContractsChannelSurfaceVitestConfig();
