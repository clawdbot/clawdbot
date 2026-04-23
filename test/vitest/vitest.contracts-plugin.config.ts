import { createContractsVitestConfig, pluginContractPatterns } from "./vitest.contracts-shared.ts";

export default createContractsVitestConfig(pluginContractPatterns, process.env, process.argv, {
  name: "contracts-plugin",
});
