// Vitest extension codex app server attempt support config wires the extension codex app server attempt support test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionCodexAppServerAttemptSupportVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    [
      "extensions/codex/src/app-server/attempt-context.test.ts",
      "extensions/codex/src/app-server/attempt-results.test.ts",
      "extensions/codex/src/app-server/attempt-startup.test.ts",
      "extensions/codex/src/app-server/attempt-timeouts.test.ts",
      "extensions/codex/src/app-server/attempt-turn-watches.test.ts",
    ],
    {
      dir: "extensions",
      env,
      fileParallelism: false,
      name: "extension-codex-app-server-attempt-support",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionCodexAppServerAttemptSupportVitestConfig();
