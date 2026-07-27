import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let writePersistedAuthProfileStoreRaw: typeof import("../agents/auth-profiles/sqlite.js").writePersistedAuthProfileStoreRaw;
let resolveApiKeyForProvider: typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
let closeOpenClawAgentDatabasesForTest: typeof import("../state/openclaw-agent-db.js").closeOpenClawAgentDatabasesForTest;
let activateSecretsRuntimeSnapshot: typeof import("./runtime.js").activateSecretsRuntimeSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("auth profile migration isolation", () => {
  const roots: string[] = [];

  beforeEach(async () => {
    // This shard is non-isolated, so load the singleton-backed runtime and auth helpers
    // from one fresh graph after neighboring tests reset the module cache.
    vi.resetModules();
    ({
      activateSecretsRuntimeSnapshot,
      clearSecretsRuntimeSnapshot,
      prepareSecretsRuntimeSnapshot,
    } = await import("./runtime.js"));
    ({ writePersistedAuthProfileStoreRaw } = await import("../agents/auth-profiles/sqlite.js"));
    ({ resolveApiKeyForProvider } = await import("../agents/model-auth.js"));
    ({ closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js"));
    clearSecretsRuntimeSnapshot();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    clearSecretsRuntimeSnapshot();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates one legacy owner and blocks env fallback without affecting a healthy agent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-migration-isolation-"));
    roots.push(root);
    const legacyAgentDir = path.join(root, "agents", "legacy", "agent");
    const healthyAgentDir = path.join(root, "agents", "healthy", "agent");
    await fs.mkdir(legacyAgentDir, { recursive: true });
    await fs.mkdir(healthyAgentDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyAgentDir, "auth.json"),
      `${JSON.stringify({ openai: { type: "api_key", key: "fake-legacy-key" } })}\n`,
    );
    writePersistedAuthProfileStoreRaw(
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
      healthyAgentDir,
    );
    vi.stubEnv("OPENAI_API_KEY", "fake-env-fallback-key");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {},
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
      resolveApiKeyForProvider({ provider: "openai", agentDir: legacyAgentDir }),
    ).rejects.toMatchObject({
      code: "AUTH_PROFILE_MIGRATION_REQUIRED",
      action: "openclaw doctor --fix",
      sourceKinds: ["legacy-auth"],
    });
    await expect(
      resolveApiKeyForProvider({
        provider: "openai",
        agentDir: healthyAgentDir,
        profileId: "openai:default",
        lockedProfile: true,
        store: snapshot.authStores.find((entry) => entry.agentDir === healthyAgentDir)?.store,
      }),
    ).resolves.toMatchObject({ apiKey: "fake-healthy-key" });
  });
});
