// Vitest auto reply reply config wires the auto reply reply test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { autoReplyReplySubtreeTestInclude } from "./vitest.test-shards.mjs";

export function createAutoReplyReplyVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig([...autoReplyReplySubtreeTestInclude], {
    dir: "src/auto-reply",
    env,
    fileParallelism: false,
    name: "auto-reply-reply",
  });
}

export default createAutoReplyReplyVitestConfig();
