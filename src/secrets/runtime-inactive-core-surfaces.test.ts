import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function expectWarningPaths(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
  expectedPaths: string[],
): void {
  const warningPaths = new Set(snapshot.warnings.map((warning) => warning.path));
  for (const expectedPath of expectedPaths) {
    expect(warningPaths.has(expectedPath)).toBe(true);
  }
}

describe("secrets runtime snapshot inactive core surfaces", () => {
  it("skips inactive core refs and emits diagnostics", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              enabled: false,
              remote: {
                apiKey: { source: "env", provider: "default", id: "DISABLED_MEMORY_API_KEY" },
              },
            },
          },
        },
        gateway: {
          auth: {
            mode: "token",
            password: { source: "env", provider: "default", id: "DISABLED_GATEWAY_PASSWORD" },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expectWarningPaths(snapshot, [
      "agents.defaults.memorySearch.remote.apiKey",
      "gateway.auth.password",
    ]);
  });
});
