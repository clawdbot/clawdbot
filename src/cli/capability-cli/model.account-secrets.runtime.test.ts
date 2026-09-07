import { afterEach, describe, expect, it } from "vitest";
import { resolveApiKeyForProfile } from "../../agents/auth-profiles/oauth.js";
import { activateSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "../../secrets/runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

afterEach(() => {
  clearSecretsRuntimeSnapshotState();
});

describe("local model account secret isolation contract", () => {
  it("keeps a healthy selected profile usable while a sibling SecretRef is unavailable", async () => {
    const agentDir = "/tmp/openclaw-model-run-account-isolation";
    const coldProfileId = "openai:cold";
    const healthyProfileId = "anthropic:healthy";
    const cfg = asConfig({});
    const store = loadAuthStoreWithProfiles({
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
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: cfg,
      env: { ANTHROPIC_PROFILE_KEY: "anthropic-runtime-key" },
      agentDirs: [agentDir],
      includeConfigRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      loadAuthStore: () => store,
    });
    activateSecretsRuntimeSnapshot(snapshot);

    await expect(
      resolveApiKeyForProfile({
        cfg,
        store,
        profileId: healthyProfileId,
        agentDir,
      }),
    ).resolves.toMatchObject({
      apiKey: "anthropic-runtime-key",
      provider: "anthropic",
    });

    await expect(
      resolveApiKeyForProfile({
        cfg,
        store,
        profileId: coldProfileId,
        agentDir,
      }),
    ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
  });
});
