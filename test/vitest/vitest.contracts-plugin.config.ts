// Vitest contracts plugin config wires the contracts plugin test shard.
import { createContractsVitestConfig, pluginContractPatterns } from "./vitest.contracts-shared.ts";

export function createContractsPluginVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  return createContractsVitestConfig(pluginContractPatterns, env, argv, {
    name: "contracts-plugin",
  });
}

export default createContractsPluginVitestConfig();
