import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension qa config wires the extension qa test shard.
import { qaExtensionTestRoots } from "./vitest.extension-qa-paths.mjs";

export function createExtensionQaVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("qa", qaExtensionTestRoots, env);
}

export default createExtensionQaVitestConfig();
