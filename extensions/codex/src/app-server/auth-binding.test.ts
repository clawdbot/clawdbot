import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintCodexAppServerAuthBinding,
  prepareCodexAppServerAuthBinding,
} from "./auth-binding.js";

describe("Codex app-server auth binding", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("materializes a SecretRef once and fingerprints the executed store", async () => {
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
    vi.stubEnv("OPENAI_WORK_KEY", "work-key-a");

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

    vi.stubEnv("OPENAI_WORK_KEY", "work-key-b");
    expect(await fingerprintCodexAppServerAuthBinding(params)).not.toBe(prepared?.fingerprint);
  });
});
