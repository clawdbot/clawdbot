// Auth storage tests cover the provider-keyed SDK facade over canonical SQLite auth profiles.
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { clearAuthProfileMigrationDiagnostics } from "../auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../auth-profiles/runtime-snapshots.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, FileAuthStorageBackend, type AuthStorageBackend } from "./auth-storage.js";

describe("SQLite auth storage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearAuthProfileMigrationDiagnostics();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeAgentDir(): string {
    const agentDir = fs.mkdtempSync(path.join(tmpdir(), "auth-sqlite-"));
    tempDirs.push(agentDir);
    return agentDir;
  }

  it("persists provider defaults in the canonical agent database", async () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    storage.set("anthropic", { type: "api_key", key: "fake-anthropic-key" });

    expect(await AuthStorage.forAgent(agentDir).getApiKey("anthropic")).toBe("fake-anthropic-key");
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["anthropic:default"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "fake-anthropic-key",
    });
    expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
  });

  it("merges synchronous writes from instances created on the same baseline", () => {
    const agentDir = makeAgentDir();
    const left = AuthStorage.forAgent(agentDir);
    const right = AuthStorage.forAgent(agentDir);

    left.set("openai", { type: "api_key", key: "fake-openai-key" });
    right.set("anthropic", { type: "api_key", key: "fake-anthropic-key" });

    expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toMatchObject({
      "openai:default": { key: "fake-openai-key" },
      "anthropic:default": { key: "fake-anthropic-key" },
    });
  });

  it("never overwrites a store that becomes unreadable before a synchronous write", () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);

    expect(() => storage.set("anthropic", { type: "api_key", key: "fake-new-key" })).toThrow(
      "is unreadable",
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
  });

  it("never overwrites a store that becomes unreadable during an OAuth refresh", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "test-oauth:default": {
            type: "oauth",
            provider: "test-oauth",
            access: "fake-expired-access",
            refresh: "fake-refresh",
            expires: 1,
          },
        },
      },
      agentDir,
    );
    const storage = AuthStorage.forAgent(agentDir);
    getAuthStorageOAuthProviderRegistry(storage).register({
      id: "test-oauth",
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      async refreshToken() {
        return {
          access: "fake-fresh-access",
          refresh: "fake-refresh",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    });
    const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);

    await expect(storage.getApiKey("test-oauth")).resolves.toBeUndefined();
    expect(storage.drainErrors().some((error) => error.message.includes("is unreadable"))).toBe(
      true,
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
  });

  it("keeps AuthStorage.create(path) as a named SQLite-backed deprecation", () => {
    const agentDir = makeAgentDir();
    const legacyPath = path.join(agentDir, "auth.json");
    const storage = AuthStorage.create(legacyPath);
    storage.set("openai", { type: "api_key", key: "fake-openai-key" });

    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "fake-openai-key",
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("keeps FileAuthStorageBackend as a deprecated SQLite-backed export", () => {
    const agentDir = makeAgentDir();
    const legacyPath = path.join(agentDir, "auth.json");
    const storage = AuthStorage.fromStorage(new FileAuthStorageBackend(legacyPath));
    storage.set("openai", { type: "api_key", key: "fake-openai-key" });

    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "fake-openai-key",
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("reads materialized SecretRefs without persisting their resolved value", async () => {
    const agentDir = makeAgentDir();
    const keyRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", keyRef },
          "xai:default": {
            type: "token",
            provider: "xai",
            tokenRef: { source: "env", provider: "default", id: "XAI_TOKEN" },
          },
        },
      },
      agentDir,
    );
    expect(() => AuthStorage.forAgent(agentDir)).toThrow(
      "requires the active secrets runtime to materialize SecretRef credentials",
    );
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              keyRef,
              key: "fake-materialized-key",
            },
            "xai:default": {
              type: "token",
              provider: "xai",
              tokenRef: { source: "env", provider: "default", id: "XAI_TOKEN" },
              token: "fake-materialized-token",
            },
          },
        },
      },
    ]);

    const storage = AuthStorage.forAgent(agentDir);
    expect(await storage.getApiKey("openai")).toBe("fake-materialized-key");
    expect(await storage.getApiKey("xai")).toBe("fake-materialized-token");
    storage.set("anthropic", { type: "api_key", key: "fake-anthropic-key" });

    const persisted = readPersistedAuthProfileStoreRaw(agentDir) as {
      profiles: Record<string, { key?: string; keyRef?: unknown }>;
    };
    expect(persisted).toMatchObject({
      profiles: {
        "openai:default": { keyRef },
      },
    });
    expect(persisted.profiles["openai:default"]?.key).toBeUndefined();
    storage.remove("openai");
    expect(
      (readPersistedAuthProfileStoreRaw(agentDir) as { profiles: Record<string, unknown> })
        .profiles["openai:default"],
    ).toBeUndefined();
  });

  it("fails closed before environment fallback when legacy credentials are pending", () => {
    const agentDir = makeAgentDir();
    fs.writeFileSync(path.join(agentDir, "auth.json"), '{"openai":{"key":"fake"}}\n');

    expect(() => AuthStorage.forAgent(agentDir)).toThrow("requires legacy credential migration");
  });

  it("ignores unresolved named profiles outside the provider-default facade", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:work": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "fake-anthropic-key",
          },
        },
      },
      agentDir,
    );

    await expect(AuthStorage.forAgent(agentDir).getApiKey("anthropic")).resolves.toBe(
      "fake-anthropic-key",
    );
  });

  it("serializes asynchronous OAuth refreshes across SQLite-backed instances", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "test-oauth:default": {
            type: "oauth",
            provider: "test-oauth",
            access: "fake-expired-access",
            refresh: "fake-refresh",
            expires: 1,
          },
        },
      },
      agentDir,
    );
    const left = AuthStorage.forAgent(agentDir);
    const right = AuthStorage.forAgent(agentDir);
    let refreshCalls = 0;
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const provider = {
      id: "test-oauth",
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      async refreshToken() {
        refreshCalls += 1;
        activeRefreshes += 1;
        maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        activeRefreshes -= 1;
        return {
          access: "fake-fresh-access",
          refresh: "fake-refresh",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    getAuthStorageOAuthProviderRegistry(left).register(provider);
    getAuthStorageOAuthProviderRegistry(right).register(provider);

    await expect(
      Promise.all([left.getApiKey("test-oauth"), right.getApiKey("test-oauth")]),
    ).resolves.toEqual(["fake-fresh-access", "fake-fresh-access"]);
    expect(refreshCalls).toBe(1);
    expect(maxActiveRefreshes).toBe(1);
  });

  it("falls back to environment auth when a stored token is expired", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "xai:default": {
            type: "token",
            provider: "xai",
            token: "fake-expired-token",
            expires: 1,
          },
        },
      },
      agentDir,
    );
    vi.stubEnv("XAI_API_KEY", "fake-environment-key");

    await expect(AuthStorage.forAgent(agentDir).getApiKey("xai")).resolves.toBe(
      "fake-environment-key",
    );
  });

  it("throws without changing memory when the durable write fails", () => {
    const writeError = new Error("simulated durable write failure");
    let persisted = "{}";
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          throw writeError;
        }
        return update.result;
      },
      withLockAsync: async (fn) => {
        const update = await fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
    };
    const storage = AuthStorage.fromStorage(backend);

    expect(() => storage.set("openai", { type: "api_key", key: "fake-token" })).toThrow(
      /simulated durable write failure/,
    );
    expect(storage.has("openai")).toBe(false);
  });
});
