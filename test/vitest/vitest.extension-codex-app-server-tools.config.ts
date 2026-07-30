// Vitest extension codex app server tools config wires the extension codex app server tools test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

function createExtensionCodexAppServerToolsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    [
      "extensions/codex/src/app-server/approval-bridge.test.ts",
      "extensions/codex/src/app-server/computer-use.test.ts",
      "extensions/codex/src/app-server/dynamic-tool*.test.ts",
      "extensions/codex/src/app-server/dynamic-tools.test.ts",
      "extensions/codex/src/app-server/elicitation-bridge.test.ts",
      "extensions/codex/src/app-server/native-execution-policy.test.ts",
      "extensions/codex/src/app-server/native-hook-relay.test.ts",
      "extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts",
      "extensions/codex/src/app-server/request.test.ts",
      "extensions/codex/src/app-server/sandbox-exec-server*.test.ts",
      "extensions/codex/src/app-server/schema-normalization-runtime-contract.test.ts",
      "extensions/codex/src/app-server/user-input-bridge.test.ts",
    ],
    {
      dir: "extensions",
      env,
      fileParallelism: false,
      name: "extension-codex-app-server-tools",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionCodexAppServerToolsVitestConfig();
