/** Tests inline secret refs discovered from runtime auth stores. */
import { describe, expect, it } from "vitest";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
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

  it("skips refs on auth profiles that are not eligible for their configured provider", async () => {
    const profileId = "openai:mismatched";
    const tokenProfileId = "github-copilot:mismatched";
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        auth: {
          profiles: {
            [profileId]: { provider: "anthropic", mode: "api_key" },
            [tokenProfileId]: { provider: "anthropic", mode: "token" },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          [profileId]: {
            type: "api_key",
            provider: "openai",
            key: "unused",
            keyRef: { source: "env", provider: "default", id: "MISSING_MISMATCHED_KEY" },
          },
          [tokenProfileId]: {
            type: "token",
            provider: "github-copilot",
            token: "unused",
            tokenRef: { source: "env", provider: "default", id: "MISSING_MISMATCHED_TOKEN" },
          },
        }),
    });

    expect(snapshot.degradedOwners).toEqual([]);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: `/tmp/openclaw-agent-main.auth-profiles.${profileId}.key`,
        }),
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: `/tmp/openclaw-agent-main.auth-profiles.${tokenProfileId}.token`,
        }),
      ]),
    );
    expect(snapshot.authStores[0]?.store.profiles[profileId]).toHaveProperty("key", undefined);
    expect(snapshot.authStores[0]?.store.profiles[tokenProfileId]).toHaveProperty(
      "token",
      undefined,
    );
  });

  it("isolates a failed profile ref while materializing an eligible sibling profile", async () => {
    const agentDir = "/tmp/openclaw-agent-profile-isolation";
    const coldProfileId = "openai:cold";
    const healthyProfileId = "anthropic:healthy";
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: { ANTHROPIC_PROFILE_KEY: "anthropic-runtime-key" },
      agentDirs: [agentDir],
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          [coldProfileId]: {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "MISSING_OPENAI_PROFILE_KEY" },
          },
          [healthyProfileId]: {
            type: "api_key",
            provider: "anthropic",
            keyRef: { source: "env", provider: "default", id: "ANTHROPIC_PROFILE_KEY" },
          },
        }),
    });

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "account",
        ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId: coldProfileId }),
        state: "unavailable",
      },
    ]);
    const profiles = snapshot.authStores[0]?.store.profiles;
    expect(profiles?.[coldProfileId]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "MISSING_OPENAI_PROFILE_KEY" },
    });
    expect(profiles?.[healthyProfileId]).toMatchObject({ key: "anthropic-runtime-key" });
  });
});
