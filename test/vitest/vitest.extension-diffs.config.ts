import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension diffs config wires the extension diffs test shard.
import { diffsExtensionTestRoots } from "./vitest.extension-diffs-paths.mjs";

export function createExtensionDiffsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("diffs", diffsExtensionTestRoots, env);
}

export default createExtensionDiffsVitestConfig();
