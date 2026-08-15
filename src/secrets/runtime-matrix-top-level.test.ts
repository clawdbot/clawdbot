/** Tests Matrix top-level credential refs when named accounts also exist. */
import { describe, expect, it } from "vitest";
import "./runtime-matrix.test-support.ts";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot matrix access token", () => {
  it.each([
    { field: "accessToken", envId: "MATRIX_ACCOUNTLESS_ACCESS_TOKEN" },
    { field: "password", envId: "MATRIX_ACCOUNTLESS_PASSWORD" },
  ] as const)("resolves an accountless top-level Matrix $field ref", async ({ field, envId }) => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          matrix: {
            [field]: {
              source: "env",
              provider: "default",
              id: envId,
            },
          },
        },
      }),
      env: {
        [envId]: "resolved-credential",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.channels?.matrix?.[field]).toBe("resolved-credential");
  });

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
