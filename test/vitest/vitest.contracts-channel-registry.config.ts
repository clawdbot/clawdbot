// Vitest contracts channel registry config wires the contracts channel registry test shard.
import {
  channelRegistryContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export function createContractsChannelRegistryVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  return createContractsVitestConfig(channelRegistryContractPatterns, env, argv, {
    name: "contracts-channel-registry",
  });
}

export default createContractsChannelRegistryVitestConfig();
