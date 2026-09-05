import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintCodexAppServerAuthBinding,
  prepareCodexAppServerAuthBinding,
} from "./auth-binding.js";

describe("Codex app-server auth binding", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
  });

  it.each([true, false])(
    "binds OAuth workspace identity with stored account ID=%s without token-refresh churn",
    async (storedAccountId) => {
      const profileId = "openai:work";
      const credential = (accountId: string, rotation: string) => ({
        type: "oauth" as const,
        provider: "openai",
        email: "user@example.com",
        ...(storedAccountId ? { accountId } : {}),
        access: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.${rotation}`,
        refresh: `fake-refresh-${rotation}`,
        expires: Date.now() + 60_000,
      });
      const store: AuthProfileStore = {
        version: 1,
        profiles: { [profileId]: credential("workspace-a", "first") },
      };
      const params = {
        authProfileId: profileId,
        authProfileStore: store,
        agentDir: "/tmp/codex-binding",
        config: {},
      };
      const prepared = await prepareCodexAppServerAuthBinding(params);
      const first = prepared?.fingerprint;
      expect(first).toEqual(expect.any(String));
      store.profiles[profileId] = credential("workspace-a", "rotated");
      expect(await fingerprintCodexAppServerAuthBinding(params)).toBe(first);
      store.profiles[profileId] = credential("workspace-b", "replacement");
      expect(await fingerprintCodexAppServerAuthBinding(params)).not.toBe(first);
      expect(
        await fingerprintCodexAppServerAuthBinding({
          ...params,
          authProfileStore: prepared!.authProfileStore,
        }),
      ).toBe(first);
    },
  );

  it("names a repair when a selected profile cannot resolve credentials", async () => {
    await expect(
      prepareCodexAppServerAuthBinding({
        authProfileId: "openai:missing-key",
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:missing-key": { type: "api_key", provider: "openai" },
          },
        },
        agentDir: "/tmp/codex-binding",
        config: {},
      }),
    ).rejects.toThrow(/could not resolve.*[Rr]epair/);
  });

  it("uses the materialized runtime SecretRef snapshot and fingerprints the executed store", async () => {
    const profileId = "openai:work";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
        },
      },
    };
    const params = {
      authProfileId: profileId,
      authProfileStore: store,
      agentDir: "/tmp/openclaw-codex-auth-binding",
      config: {
        auth: { profiles: { [profileId]: { provider: "openai", mode: "api_key" as const } } },
      },
    };
    const publishRuntimeKey = (key: string) => {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: params.agentDir,
          store: {
            version: 1,
            profiles: {
              [profileId]: {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
                key,
              },
            },
          },
        },
      ]);
    };
    publishRuntimeKey("work-key-a");

    const prepared = await prepareCodexAppServerAuthBinding(params);
    expect(prepared?.authProfileStore).not.toBe(store);
    expect(prepared?.authProfileStore.profiles[profileId]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "work-key-a",
    });
    expect(store.profiles[profileId]).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
    });
    expect(await fingerprintCodexAppServerAuthBinding(params)).toBe(prepared?.fingerprint);

    publishRuntimeKey("work-key-b");
    expect(await fingerprintCodexAppServerAuthBinding(params)).not.toBe(prepared?.fingerprint);
  });
});
