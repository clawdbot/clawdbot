import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

const coveredAppServerPatterns = [
  "extensions/codex/src/app-server/attempt-*.test.ts",
  "extensions/codex/src/app-server/attempt-context.test.ts",
  "extensions/codex/src/app-server/attempt-diagnostics.test.ts",
  "extensions/codex/src/app-server/attempt-results.test.ts",
  "extensions/codex/src/app-server/attempt-steering.test.ts",
  "extensions/codex/src/app-server/run-attempt*.test.ts",
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
];

export function createExtensionCodexAppServerSupportVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(["extensions/codex/src/app-server/**/*.test.ts"], {
    dir: "extensions",
    env,
    exclude: coveredAppServerPatterns,
    fileParallelism: false,
    name: "extension-codex-app-server-support",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  });
}

export default createExtensionCodexAppServerSupportVitestConfig();
