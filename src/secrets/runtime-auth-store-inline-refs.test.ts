import { describe, expect, it } from "vitest";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot inline auth-store refs", () => {
  it("normalizes inline SecretRef object on token to tokenRef", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({ models: {}, secrets: {} }),
      env: { MY_TOKEN: "resolved-token-value" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:inline-token": {
            type: "token",
            provider: "custom",
            token: { source: "env", provider: "default", id: "MY_TOKEN" } as unknown as string,
          },
        }),
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:inline-token"] as Record<
      string,
      unknown
    >;
    expect(profile.tokenRef).toEqual({ source: "env", provider: "default", id: "MY_TOKEN" });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.token).toBe("resolved-token-value");
  });

  it("normalizes inline SecretRef object on key to keyRef", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({ models: {}, secrets: {} }),
      env: { MY_KEY: "resolved-key-value" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:inline-key": {
            type: "api_key",
            provider: "custom",
            key: { source: "env", provider: "default", id: "MY_KEY" } as unknown as string,
          },
        }),
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:inline-key"] as Record<
      string,
      unknown
    >;
    expect(profile.keyRef).toEqual({ source: "env", provider: "default", id: "MY_KEY" });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.key).toBe("resolved-key-value");
  });

  it("keeps explicit keyRef when inline key SecretRef is also present", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({ models: {}, secrets: {} }),
      env: {
        PRIMARY_KEY: "primary-key-value",
        SHADOW_KEY: "shadow-key-value",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:explicit-keyref": {
            type: "api_key",
            provider: "custom",
            keyRef: { source: "env", provider: "default", id: "PRIMARY_KEY" },
            key: { source: "env", provider: "default", id: "SHADOW_KEY" } as unknown as string,
          },
        }),
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:explicit-keyref"] as Record<
      string,
      unknown
    >;
    expect(profile.keyRef).toEqual({ source: "env", provider: "default", id: "PRIMARY_KEY" });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.key).toBe("primary-key-value");
  });
});
