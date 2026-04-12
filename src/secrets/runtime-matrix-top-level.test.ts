import { describe, expect, it } from "vitest";
import "./runtime-matrix.test-support.ts";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot matrix access token", () => {
  it("resolves top-level Matrix accessToken refs even when named accounts exist", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          matrix: {
            accessToken: {
              source: "env",
              provider: "default",
              id: "MATRIX_ACCESS_TOKEN",
            },
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      }),
      env: {
        MATRIX_ACCESS_TOKEN: "default-matrix-token",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.channels?.matrix?.accessToken).toBe("default-matrix-token");
  });
});
