// Vitest extension codex config wires the extension codex test shard.
import { codexExtensionTestRoots } from "./vitest.extension-codex-paths.mjs";
import { createExtensionVitestConfig } from "./vitest.extension-config.ts";

function createExtensionCodexVitestConfig(env: Record<string, string | undefined> = process.env) {
  return createExtensionVitestConfig("codex", codexExtensionTestRoots, env, {
    fileParallelism: false,
  });
}

export default createExtensionCodexVitestConfig();
