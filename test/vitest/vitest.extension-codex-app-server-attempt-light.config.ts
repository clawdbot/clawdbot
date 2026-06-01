import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionCodexAppServerAttemptLightVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    [
      "extensions/codex/src/app-server/attempt-client-cleanup.test.ts",
      "extensions/codex/src/app-server/attempt-diagnostics.test.ts",
      "extensions/codex/src/app-server/attempt-steering.test.ts",
    ],
    {
      dir: "extensions",
      env,
      fileParallelism: false,
      name: "extension-codex-app-server-attempt-light",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionCodexAppServerAttemptLightVitestConfig();
