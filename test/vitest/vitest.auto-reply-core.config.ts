// Vitest auto reply core config wires the auto reply core test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { autoReplyCoreTestExclude, autoReplyCoreTestInclude } from "./vitest.test-shards.mjs";

export function createAutoReplyCoreVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig([...autoReplyCoreTestInclude], {
    dir: "src/auto-reply",
    env,
    exclude: [...autoReplyCoreTestExclude],
    name: "auto-reply-core",
  });
}

export default createAutoReplyCoreVitestConfig();
