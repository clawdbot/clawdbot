// Auth storage tests cover the provider-keyed SDK facade over canonical SQLite auth profiles.
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AuthStorage as PublicAuthStorage,
  ModelRegistry as PublicModelRegistry,
} from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerOAuthMocks = vi.hoisted(() => ({
  login: vi.fn(),
  resolveCredential: vi.fn(),
}));

vi.mock("../../plugins/provider-runtime.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.runtime.js")>(
    "../../plugins/provider-runtime.runtime.js",
  );
  return {
    ...actual,
    loginProviderOAuthWithPlugin: providerOAuthMocks.login,
    resolveProviderOAuthCredentialWithPlugin: providerOAuthMocks.resolveCredential,
  };
});
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { clearAuthProfileMigrationDiagnostics } from "../auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../auth-profiles/runtime-snapshots.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import {
  AuthStorage,
  FileAuthStorageBackend,
  OAuthProviderConfiguredUnavailableError,
  type AuthStorageBackend,
} from "./auth-storage.js";

describe("SQLite auth storage", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    providerOAuthMocks.login.mockReset();
    providerOAuthMocks.login.mockResolvedValue({ status: "unowned" });
    providerOAuthMocks.resolveCredential.mockReset();
    providerOAuthMocks.resolveCredential.mockResolvedValue({ status: "unowned" });
  });

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

  it("dispatches callback-based login to the owning provider plugin", async () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    const callbacks = {
      onAuth: vi.fn(),
      onPrompt: vi.fn(async () => ""),
    };
    providerOAuthMocks.login.mockResolvedValueOnce({
      status: "available",
      credentials: {
        access: "fake-access",
        refresh: "fake-refresh",
        expires: Date.now() + 60_000,
      },
    });

    await storage.login("plugin-oauth", callbacks);

    expect(providerOAuthMocks.login).toHaveBeenCalledWith({
      provider: "plugin-oauth",
      context: callbacks,
    });
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["plugin-oauth:default"]).toMatchObject(
      {
        type: "oauth",
        provider: "plugin-oauth",
        access: "fake-access",
        refresh: "fake-refresh",
      },
    );
  });

  it("returns a typed actionable error when an owned OAuth plugin is unavailable", async () => {
    const storage = AuthStorage.forAgent(makeAgentDir());
    providerOAuthMocks.login.mockResolvedValueOnce({ status: "configured-unavailable" });

    const login = storage.login("plugin-oauth", {
      onAuth: vi.fn(),
      onPrompt: vi.fn(async () => ""),
    });
    await expect(login).rejects.toMatchObject({
      name: "OAuthProviderConfiguredUnavailableError",
      code: "OAUTH_PROVIDER_CONFIGURED_UNAVAILABLE",
      state: "configured-unavailable",
      providerId: "plugin-oauth",
    });
    await expect(login).rejects.toBeInstanceOf(OAuthProviderConfiguredUnavailableError);
  });

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

  it("blocks environment fallback after a canonical store becomes unreadable", async () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: "invalid-profile-map" }, agentDir);
    vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow("is unreadable");
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

    await expect(storage.getApiKey("test-oauth")).rejects.toThrow("is unreadable");
    expect(storage.drainErrors().some((error) => error.message.includes("is unreadable"))).toBe(
      true,
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
  });

  it("does not commit a refresh when a legacy source appears during the provider call", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "test-oauth:default": {
            type: "oauth",
            provider: "test-oauth",
            access: "not-a-real",
            refresh: "not-a-real",
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
        fs.writeFileSync(path.join(agentDir, "auth.json"), '{"legacy":true}\n', "utf8");
        return {
          access: "not-a-real",
          refresh: "not-a-real",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    });

    // The store already owns this profile, so a retired file appearing mid-call is
    // leftover bytes: discarding a completed refresh over it would strand the agent
    // on an expired token. Doctor never overwrites a usable stored credential.
    await expect(storage.getApiKey("test-oauth")).resolves.toBe("not-a-real");
    expect(
      loadPersistedAuthProfileStore(agentDir)?.profiles["test-oauth:default"],
    ).not.toMatchObject({ expires: 1 });
  });

  it("keeps stored OAuth identity fields through the published agent sessions SDK", async () => {
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
            accountId: "fake-account-id",
            email: "fake-user@example.com",
            subscriptionType: "max",
            rateLimitTier: "default_max_20x",
          },
        },
      },
      agentDir,
    );
    const storage = PublicAuthStorage.forAgent(agentDir);
    PublicModelRegistry.inMemory(storage).registerProvider("test-oauth", {
      oauth: {
        name: "Test OAuth",
        async login() {
          throw new Error("not used");
        },
        async refreshToken() {
          return {
            access: "fake-fresh-access",
            refresh: "fake-rotated-refresh",
            expires: Date.now() + 60_000,
          };
        },
        getApiKey(credentials: { access: string }) {
          return credentials.access;
        },
      },
    });

    await expect(storage.getApiKey("test-oauth")).resolves.toBe("fake-fresh-access");
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["test-oauth:default"]).toMatchObject({
      type: "oauth",
      provider: "test-oauth",
      access: "fake-fresh-access",
      refresh: "fake-rotated-refresh",
      accountId: "fake-account-id",
      email: "fake-user@example.com",
      subscriptionType: "max",
      rateLimitTier: "default_max_20x",
    });
    expect(storage.get("test-oauth")).toMatchObject({
      accountId: "fake-account-id",
      email: "fake-user@example.com",
    });
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

  it("fails closed instead of ignoring credentials at a deprecated custom path", () => {
    const agentDir = makeAgentDir();
    const customPath = path.join(agentDir, "plugin-credentials.json");
    fs.writeFileSync(customPath, '{"openai":{"key":"not-a-real"}}\n', "utf8");

    expect(() => AuthStorage.create(customPath)).toThrow(
      expect.objectContaining({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" }),
    );
    expect(() => new FileAuthStorageBackend(customPath)).toThrow(
      expect.objectContaining({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" }),
    );
    expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
  });

  it("keeps FileAuthStorageBackend as a deprecated fail-closed SQLite adapter", async () => {
    const agentDir = makeAgentDir();
    const legacyPath = path.join(agentDir, "auth.json");
    const storage = AuthStorage.fromStorage(new FileAuthStorageBackend(legacyPath));
    storage.set("openai", { type: "api_key", key: "fake-openai-key" });

    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "fake-openai-key",
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
    fs.writeFileSync(legacyPath, '{"openai":{"key":"fake-late"}}\n');
    // Never read the retired file, but keep serving the migrated store beside it.
    await expect(storage.getApiKey("openai")).resolves.toBe("fake-openai-key");
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("blocks ambient fallback when the compatibility backend cannot materialize SQLite refs", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_STORED_KEY" },
          },
        },
      },
      agentDir,
    );
    vi.stubEnv("OPENAI_API_KEY", "fake-ambient-key");

    const storage = AuthStorage.fromStorage(
      new FileAuthStorageBackend(path.join(agentDir, "auth.json")),
    );

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires the active secrets runtime to materialize SecretRef credentials",
    );
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

  it("does not reuse a materialized value after its persisted SecretRef changes", async () => {
    const agentDir = makeAgentDir();
    const originalRef = { source: "env" as const, provider: "default", id: "QA_AUTH_REF_OLD" };
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", keyRef: originalRef },
        },
      },
      agentDir,
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
              keyRef: originalRef,
              key: "not-a-real",
            },
          },
        },
      },
    ]);
    const storage = AuthStorage.forAgent(agentDir);
    expect(await storage.getApiKey("openai")).toBe("not-a-real");

    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "QA_AUTH_REF_NEW" },
          },
        },
      },
      agentDir,
    );
    clearRuntimeAuthProfileStoreSnapshots();
    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires the active secrets runtime to materialize SecretRef credentials",
    );
  });

  it("does not reuse prepared materialization when the current snapshot is unresolved", async () => {
    const agentDir = makeAgentDir();
    const keyRef = { source: "env" as const, provider: "default", id: "QA_AUTH_REF" };
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", keyRef },
        },
      },
      agentDir,
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
              key: "not-a-real",
            },
          },
        },
      },
    ]);
    const storage = AuthStorage.forAgent(agentDir);
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", keyRef },
          },
        },
      },
    ]);

    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires the active secrets runtime to materialize SecretRef credentials",
    );
  });

  it("preserves state-only SQLite rows when adding credentials", () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStateRaw(
      {
        version: 1,
        order: { openai: ["openai:default"] },
        lastGood: { openai: "openai:default" },
        usageStats: { "openai:default": { cooldownUntil: 1_900_000_000_000 } },
      },
      agentDir,
    );

    AuthStorage.forAgent(agentDir).set("anthropic", {
      type: "api_key",
      key: "not-a-real",
    });

    expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic" },
      },
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
      usageStats: { "openai:default": { cooldownUntil: 1_900_000_000_000 } },
    });
  });

  it("fails closed before environment fallback when legacy credentials are pending", () => {
    const agentDir = makeAgentDir();
    fs.writeFileSync(path.join(agentDir, "auth.json"), '{"openai":{"key":"fake"}}\n');

    expect(() => AuthStorage.forAgent(agentDir)).toThrow("requires legacy credential migration");
  });

  it("fails closed when a legacy credential source appears after construction", async () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    fs.writeFileSync(path.join(agentDir, "auth.json"), '{"openai":{"key":"fake-late"}}\n');

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires legacy credential migration",
    );
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

  it("fails closed for an identityless SQLite peer until the owner commits its rotation", async () => {
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
    ).resolves.toEqual(["fake-fresh-access", undefined]);
    expect(refreshCalls).toBe(1);
    expect(maxActiveRefreshes).toBe(1);
    await expect(right.getApiKey("test-oauth")).resolves.toBe("fake-fresh-access");
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
