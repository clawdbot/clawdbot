import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension media config wires the extension media test shard.
import { mediaExtensionTestRoots } from "./vitest.extension-media-paths.mjs";

export function createExtensionMediaVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("media", mediaExtensionTestRoots, env);
}

export default createExtensionMediaVitestConfig();
