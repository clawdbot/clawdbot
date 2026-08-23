// Vitest contracts channel session config wires the contracts channel session test shard.
import {
  channelSessionContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export function createContractsChannelSessionVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  return createContractsVitestConfig(channelSessionContractPatterns, env, argv, {
    name: "contracts-channel-session",
  });
}

export default createContractsChannelSessionVitestConfig();
