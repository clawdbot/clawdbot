import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

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

    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "agents.defaults.memorySearch.remote.apiKey",
        "gateway.auth.password",
      ]),
    );
  });
});
