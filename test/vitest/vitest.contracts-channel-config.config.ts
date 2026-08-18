// Vitest contracts channel config config wires the contracts channel config test shard.
import {
  channelConfigContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export function createContractsChannelConfigVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  return createContractsVitestConfig(channelConfigContractPatterns, env, argv, {
    name: "contracts-channel-config",
  });
}

export default createContractsChannelConfigVitestConfig();
