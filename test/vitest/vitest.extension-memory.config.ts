import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension memory config wires the extension memory test shard.
import { memoryExtensionTestRoots } from "./vitest.extension-memory-paths.mjs";

export function createExtensionMemoryVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("memory", memoryExtensionTestRoots, env, {
    isolate: true,
  });
}

export default createExtensionMemoryVitestConfig();
