// Vitest extension active memory config wires the extension active memory test shard.
import { activeMemoryExtensionTestRoots } from "./vitest.extension-active-memory-paths.mjs";
import { createExtensionVitestConfig } from "./vitest.extension-config.ts";

function createExtensionActiveMemoryVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("active-memory", activeMemoryExtensionTestRoots, env);
}

export default createExtensionActiveMemoryVitestConfig();
