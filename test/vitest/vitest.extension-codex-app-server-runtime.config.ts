// Vitest extension codex app server runtime config wires the extension codex app server runtime test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionCodexAppServerRuntimeVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    [
      "extensions/codex/src/app-server/app-server-policy.test.ts",
      "extensions/codex/src/app-server/auth-bridge.test.ts",
      "extensions/codex/src/app-server/auth-profile-runtime-contract.test.ts",
      "extensions/codex/src/app-server/client.test.ts",
      "extensions/codex/src/app-server/compact.test.ts",
      "extensions/codex/src/app-server/config.test.ts",
      "extensions/codex/src/app-server/managed-binary.test.ts",
      "extensions/codex/src/app-server/models.test.ts",
      "extensions/codex/src/app-server/session-binding.test.ts",
      "extensions/codex/src/app-server/shared-client.test.ts",
      "extensions/codex/src/app-server/startup-binding.test.ts",
      "extensions/codex/src/app-server/thread-lifecycle*.test.ts",
      "extensions/codex/src/app-server/transport-*.test.ts",
    ],
    {
      dir: "extensions",
      env,
      fileParallelism: false,
      name: "extension-codex-app-server-runtime",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionCodexAppServerRuntimeVitestConfig();
