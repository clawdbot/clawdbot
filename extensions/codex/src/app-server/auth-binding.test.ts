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
