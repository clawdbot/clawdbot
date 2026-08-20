import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension zalo config wires the extension zalo test shard.
import { zaloExtensionTestRoots } from "./vitest.extension-zalo-paths.mjs";

export function createExtensionZaloVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("zalo", zaloExtensionTestRoots, env);
}

export default createExtensionZaloVitestConfig();
