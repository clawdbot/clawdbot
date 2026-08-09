// Vitest extension browser config wires the extension browser test shard.
import { browserExtensionTestRoots } from "./vitest.extension-browser-paths.mjs";
import { createExtensionVitestConfig } from "./vitest.extension-config.ts";

export function createExtensionBrowserVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("browser", browserExtensionTestRoots, env);
}

export default createExtensionBrowserVitestConfig();
