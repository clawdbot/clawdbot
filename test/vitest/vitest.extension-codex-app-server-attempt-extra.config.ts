// Vitest extension codex app server attempt extra config wires the extension codex app server attempt extra test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionCodexAppServerAttemptExtraVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    [
      "extensions/codex/src/app-server/run-attempt-thread-cleanup.test.ts",
      "extensions/codex/src/app-server/run-attempt.context-engine.test.ts",
      "extensions/codex/src/app-server/run-attempt.dynamic-tools.test.ts",
      "extensions/codex/src/app-server/run-attempt.hooks.test.ts",
      "extensions/codex/src/app-server/run-attempt.native-hook-relay.test.ts",
      "extensions/codex/src/app-server/run-attempt.steering.test.ts",
      "extensions/codex/src/app-server/run-attempt.turn-watches.test.ts",
      "extensions/codex/src/app-server/run-attempt.usage-limits.test.ts",
      "extensions/codex/src/app-server/run-attempt.vision-tools.test.ts",
    ],
    {
      dir: "extensions",
      env,
      fileParallelism: false,
      name: "extension-codex-app-server-attempt-extra",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionCodexAppServerAttemptExtraVitestConfig();
