import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolveApiKeyForProviderCore: typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore;
let closeOpenClawAgentDatabasesForTest: typeof import("../state/openclaw-agent-db.js").closeOpenClawAgentDatabasesForTest;
let withOpenClawTestState: typeof import("../test-utils/openclaw-test-state.js").withOpenClawTestState;
let activateSecretsRuntimeSnapshot: typeof import("./runtime.js").activateSecretsRuntimeSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("auth profile migration isolation", () => {
  beforeEach(async () => {
    // This shard is non-isolated, so load the singleton-backed runtime and auth helpers
    // from one fresh graph after neighboring tests reset the module cache.
    vi.resetModules();
    ({
      activateSecretsRuntimeSnapshot,
      clearSecretsRuntimeSnapshot,
      prepareSecretsRuntimeSnapshot,
    } = await import("./runtime.js"));
    ({ resolveApiKeyForProviderCore } = await import("../agents/model-auth.js"));
    ({ closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js"));
    ({ withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js"));
    clearSecretsRuntimeSnapshot();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
  });

  it("isolates one legacy owner and blocks env fallback without affecting a healthy agent", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        label: "auth-migration-isolation",
        env: {
          OPENAI_API_KEY: "fake-env-fallback-key",
        },
      },
      async (state) => {
        const legacyAgentDir = state.agentDir("legacy");
        const healthyAgentDir = state.agentDir("healthy");
        await state.writeText(
          "agents/legacy/agent/auth.json",
          `${JSON.stringify({ openai: { type: "api_key", key: "fake-legacy-key" } })}\n`,
        );
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "fake-healthy-key",
              },
            },
          },
          "healthy",
        );

        const snapshot = await prepareSecretsRuntimeSnapshot({
          config: {},
          env: state.env,
          agentDirs: [legacyAgentDir, healthyAgentDir],
          includeConfigRefs: false,
          allowUnavailableSecretOwners: true,
          loadablePluginOrigins: new Map(),
        });
        expect(snapshot.degradedOwners).toEqual([
          expect.objectContaining({
            ownerKind: "route",
            reason: "auth profile migration required",
            paths: ["auth-profile-legacy:legacy-auth"],
          }),
        ]);
        activateSecretsRuntimeSnapshot(snapshot);

        await expect(
          resolveApiKeyForProviderCore({ provider: "openai", agentDir: legacyAgentDir }),
        ).rejects.toMatchObject({
          code: "AUTH_PROFILE_MIGRATION_REQUIRED",
          action: "openclaw doctor --fix",
          sourceKinds: ["legacy-auth"],
        });
        await expect(
          resolveApiKeyForProviderCore({
            provider: "openai",
            agentDir: healthyAgentDir,
            profileId: "openai:default",
            lockedProfile: true,
            store: snapshot.authStores.find((entry) => entry.agentDir === healthyAgentDir)?.store,
          }),
        ).resolves.toMatchObject({ apiKey: "fake-healthy-key" });
      },
    );
  });
});
