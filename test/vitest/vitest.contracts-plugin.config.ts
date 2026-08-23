// Vitest contracts plugin config wires the contracts plugin test shard.
import { createContractsVitestConfig, pluginContractPatterns } from "./vitest.contracts-shared.ts";

export default createContractsVitestConfig(pluginContractPatterns, process.env, process.argv, {
  name: "contracts-plugin",
});
