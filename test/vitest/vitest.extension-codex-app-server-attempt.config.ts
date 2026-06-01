import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionCodexAppServerAttemptVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(["extensions/codex/src/app-server/run-attempt.test.ts"], {
    dir: "extensions",
    env,
    fileParallelism: false,
    name: "extension-codex-app-server-attempt",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  });
}

export default createExtensionCodexAppServerAttemptVitestConfig();
