import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../plugins/provider-external-auth.types.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "./auth-profiles.js";
import { AUTH_STORE_VERSION, log } from "./auth-profiles/constants.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.hoisted(() =>
  vi.fn<() => ProviderExternalAuthProfile[]>(() => []),
);

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => {
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) {
      return null;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")) as {
        tokens?: {
          access_token?: unknown;
          refresh_token?: unknown;
          account_id?: unknown;
        };
      };
      const access = raw.tokens?.access_token;
      const refresh = raw.tokens?.refresh_token;
      if (typeof access !== "string" || typeof refresh !== "string") {
        return null;
      }
      return {
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh,
        expires: Date.now() + 60 * 60 * 1000,
        accountId: typeof raw.tokens?.account_id === "string" ? raw.tokens.account_id : undefined,
      };
    } catch {
      return null;
    }
  },
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: vi.fn(),
  writeCodexCliCredentials: vi.fn(() => false),
}));

describe("ensureAuthProfileStore", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
  });

  function withTempAgentDir<T>(prefix: string, run: (agentDir: string) => T): T {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      return run(agentDir);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }

  function writeAuthProfileStore(agentDir: string, profiles: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify({ version: AUTH_STORE_VERSION, profiles }, null, 2)}\n`,
      "utf8",
    );
  }

  function loadAuthProfile(agentDir: string, profileId: string): AuthProfileCredential {
    clearRuntimeAuthProfileStoreSnapshots();
    const store = ensureAuthProfileStore(agentDir);
    const profile = store.profiles[profileId];
    expect(profile).toBeDefined();
    return profile;
  }

  function restoreEnvValue(name: string, previous: string | undefined): void {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }

  function restoreAgentDirEnv(params: {
    previousAgentDir: string | undefined;
    previousPiAgentDir: string | undefined;
  }): void {
    restoreEnvValue("OPENCLAW_AGENT_DIR", params.previousAgentDir);
    restoreEnvValue("PI_CODING_AGENT_DIR", params.previousPiAgentDir);
  }

  function expectApiKeyProfile(
    profile: AuthProfileCredential,
  ): Extract<AuthProfileCredential, { type: "api_key" }> {
    expect(profile.type).toBe("api_key");
    if (profile.type !== "api_key") {
      throw new Error(`Expected api_key profile, got ${profile.type}`);
    }
    return profile;
  }

  function expectTokenProfile(
    profile: AuthProfileCredential,
  ): Extract<AuthProfileCredential, { type: "token" }> {
    expect(profile.type).toBe("token");
    if (profile.type !== "token") {
      throw new Error(`Expected token profile, got ${profile.type}`);
    }
    return profile;
  }

  it("migrates legacy auth.json and deletes it (PR #368)", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profiles-"));
    try {
      const legacyPath = path.join(agentDir, "auth.json");
      fs.writeFileSync(
        legacyPath,
        `${JSON.stringify(
          {
            anthropic: {
              type: "oauth",
              provider: "anthropic",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        type: "oauth",
        provider: "anthropic",
      });

      const migratedPath = path.join(agentDir, "auth-profiles.json");
      expect(fs.existsSync(migratedPath)).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);

      // idempotent
      const store2 = ensureAuthProfileStore(agentDir);
      expect(store2.profiles["anthropic:default"]).toBeDefined();
      expect(fs.existsSync(legacyPath)).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("merges main auth profiles into agent store and keeps agent overrides", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-merge-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const mainDir = path.join(root, "main-agent");
      const agentDir = path.join(root, "agent-x");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      process.env.OPENCLAW_AGENT_DIR = mainDir;
      process.env.PI_CODING_AGENT_DIR = mainDir;

      const mainStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "main-key",
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "main-anthropic-key",
          },
        },
      };
      fs.writeFileSync(
        path.join(mainDir, "auth-profiles.json"),
        `${JSON.stringify(mainStore, null, 2)}\n`,
        "utf8",
      );

      const agentStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "agent-key",
          },
        },
      };
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(agentStore, null, 2)}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "main-anthropic-key",
      });
      expect(store.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "agent-key",
      });
    } finally {
      restoreAgentDirEnv({ previousAgentDir, previousPiAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the main agent's newer OAuth profile when an agent still has a stale default profile", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const mainDir = path.join(root, "main-agent");
      const agentDir = path.join(root, "agent-x");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      process.env.OPENCLAW_AGENT_DIR = mainDir;
      process.env.PI_CODING_AGENT_DIR = mainDir;

      const freshProfileId = "openai-codex:user@example.com";
      const staleProfileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              email: "user@example.com",
            },
          },
          order: {
            "openai-codex": [freshProfileId],
          },
          lastGood: {
            "openai-codex": freshProfileId,
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-identity-access",
              refresh: "stale-identity-refresh",
              expires: Date.now() - 30 * 60 * 1000,
              email: "user@example.com",
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() - 60 * 60 * 1000,
              accountId: "acct-from-old-codex-auth",
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
          lastGood: {
            "openai-codex": staleProfileId,
          },
          usageStats: {
            [staleProfileId]: {
              lastUsed: Date.now() - 30_000,
              errorCount: 3,
            },
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(store.profiles[freshProfileId]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "main-access",
        refresh: "main-refresh",
      });
      expect(store.profiles[staleProfileId]).toBeUndefined();
      expect(store.order?.["openai-codex"]).toEqual([freshProfileId]);
      expect(store.lastGood?.["openai-codex"]).toBe(freshProfileId);
      expect(store.usageStats?.[staleProfileId]).toBeUndefined();

      const persistedAgentStore = JSON.parse(
        fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"),
      ) as { profiles: Record<string, unknown> };
      expect(persistedAgentStore.profiles[staleProfileId]).toBeDefined();
    } finally {
      restoreAgentDirEnv({ previousAgentDir, previousPiAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a newer agent replacement credential while repairing stale default references", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-newer-agent-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const mainDir = path.join(root, "main-agent");
      const agentDir = path.join(root, "agent-x");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      process.env.OPENCLAW_AGENT_DIR = mainDir;
      process.env.PI_CODING_AGENT_DIR = mainDir;

      const freshProfileId = "openai-codex:user@example.com";
      const staleProfileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "older-main-access",
              refresh: "older-main-refresh",
              expires: Date.now() + 30 * 60 * 1000,
              email: "user@example.com",
            },
          },
          order: {
            "openai-codex": [freshProfileId],
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "newer-agent-access",
              refresh: "newer-agent-refresh",
              expires: Date.now() + 90 * 60 * 1000,
              email: "user@example.com",
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() - 60 * 60 * 1000,
              email: "user@example.com",
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
          lastGood: {
            "openai-codex": staleProfileId,
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(store.profiles[freshProfileId]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "newer-agent-access",
        refresh: "newer-agent-refresh",
      });
      expect(store.profiles[staleProfileId]).toBeUndefined();
      expect(store.order?.["openai-codex"]).toEqual([freshProfileId]);
      expect(store.lastGood?.["openai-codex"]).toBe(freshProfileId);
    } finally {
      restoreAgentDirEnv({ previousAgentDir, previousPiAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a valid main default OAuth profile while replacing a stale agent override", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-base-default-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const mainDir = path.join(root, "main-agent");
      const agentDir = path.join(root, "agent-x");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      process.env.OPENCLAW_AGENT_DIR = mainDir;
      process.env.PI_CODING_AGENT_DIR = mainDir;

      const freshProfileId = "openai-codex:user@example.com";
      const defaultProfileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              email: "user@example.com",
            },
            [defaultProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "main-default-access",
              refresh: "main-default-refresh",
              expires: Date.now() + 45 * 60 * 1000,
            },
          },
          order: {
            "openai-codex": [freshProfileId, defaultProfileId],
          },
          usageStats: {
            [defaultProfileId]: {
              lastUsed: 123,
            },
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [defaultProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-agent-default-access",
              refresh: "stale-agent-default-refresh",
              expires: Date.now() - 60 * 60 * 1000,
            },
          },
          order: {
            "openai-codex": [defaultProfileId],
          },
          usageStats: {
            [defaultProfileId]: {
              lastUsed: 999,
              errorCount: 2,
            },
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(store.order?.["openai-codex"]).toEqual([freshProfileId]);
      expect(store.profiles[defaultProfileId]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "main-default-access",
      });
      expect(store.usageStats?.[defaultProfileId]).toMatchObject({
        lastUsed: 123,
      });
    } finally {
      restoreAgentDirEnv({ previousAgentDir, previousPiAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a stale default OAuth profile when the main profile belongs to a different identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-mismatch-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const mainDir = path.join(root, "main-agent");
      const agentDir = path.join(root, "agent-x");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      process.env.OPENCLAW_AGENT_DIR = mainDir;
      process.env.PI_CODING_AGENT_DIR = mainDir;

      const freshProfileId = "openai-codex:user@example.com";
      const staleProfileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              email: "user@example.com",
            },
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "other-access",
              refresh: "other-refresh",
              expires: Date.now() - 60 * 60 * 1000,
              email: "other@example.com",
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
          lastGood: {
            "openai-codex": staleProfileId,
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(store.profiles[freshProfileId]).toBeDefined();
      expect(store.profiles[staleProfileId]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "other-access",
      });
      expect(store.order?.["openai-codex"]).toEqual([staleProfileId]);
      expect(store.lastGood?.["openai-codex"]).toBe(staleProfileId);
    } finally {
      restoreAgentDirEnv({ previousAgentDir, previousPiAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "mode/apiKey aliases map to type/key",
      profile: {
        provider: "anthropic",
        mode: "api_key",
        apiKey: "sk-ant-alias", // pragma: allowlist secret
      },
      expected: {
        type: "api_key",
        key: "sk-ant-alias",
      },
    },
    {
      name: "canonical type overrides conflicting mode alias",
      profile: {
        provider: "anthropic",
        type: "api_key",
        mode: "token",
        key: "sk-ant-canonical",
      },
      expected: {
        type: "api_key",
        key: "sk-ant-canonical",
      },
    },
    {
      name: "canonical key overrides conflicting apiKey alias",
      profile: {
        provider: "anthropic",
        type: "api_key",
        key: "sk-ant-canonical",
        apiKey: "sk-ant-alias", // pragma: allowlist secret
      },
      expected: {
        type: "api_key",
        key: "sk-ant-canonical",
      },
    },
    {
      name: "canonical profile shape remains unchanged",
      profile: {
        provider: "anthropic",
        type: "api_key",
        key: "sk-ant-direct",
      },
      expected: {
        type: "api_key",
        key: "sk-ant-direct",
      },
    },
  ] as const)(
    "normalizes auth-profiles credential aliases with canonical-field precedence: $name",
    ({ name, profile, expected }) => {
      withTempAgentDir("openclaw-auth-alias-", (agentDir) => {
        const storeData = {
          version: AUTH_STORE_VERSION,
          profiles: {
            "anthropic:work": profile,
          },
        };
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(storeData, null, 2)}\n`,
          "utf8",
        );

        const store = ensureAuthProfileStore(agentDir);
        expect(store.profiles["anthropic:work"], name).toMatchObject(expected);
      });
    },
  );

  it("normalizes mode/apiKey aliases while migrating legacy auth.json", () => {
    withTempAgentDir("openclaw-auth-legacy-alias-", (agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "auth.json"),
        `${JSON.stringify(
          {
            anthropic: {
              provider: "anthropic",
              mode: "api_key",
              apiKey: "sk-ant-legacy", // pragma: allowlist secret
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-legacy",
      });
    });
  });

  it("merges legacy oauth.json into auth-profiles.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oauth-migrate-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const agentDir = path.join(root, "agent");
      const oauthDir = path.join(root, "credentials");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(oauthDir, { recursive: true });
      fs.writeFileSync(
        path.join(oauthDir, "oauth.json"),
        `${JSON.stringify(
          {
            "openai-codex": {
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              accountId: "acct_123",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.env.OPENCLAW_STATE_DIR = root;
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      clearRuntimeAuthProfileStoreSnapshots();

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["openai-codex:default"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
      });

      const persisted = JSON.parse(
        fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
      };
      expect(persisted.profiles["openai-codex:default"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      restoreEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
      restoreAgentDirEnv({ previousAgentDir, previousPiAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes provider-managed runtime auth without persisting copied tokens", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-external-auth-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const agentDir = path.join(root, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
        {
          profileId: "demo-provider:external",
          credential: {
            type: "oauth",
            provider: "demo-provider",
            access: "external-access-token",
            refresh: "external-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "acct_123",
          },
          persistence: "runtime-only",
        },
      ]);

      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      clearRuntimeAuthProfileStoreSnapshots();

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["demo-provider:external"]).toMatchObject({
        type: "oauth",
        provider: "demo-provider",
        access: "external-access-token",
        refresh: "external-refresh-token",
      });

      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      restoreAgentDirEnv({ previousAgentDir, previousPiAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write inherited auth stores during secrets runtime reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secrets-runtime-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      const stateDir = path.join(root, ".openclaw");
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      const workerAgentDir = path.join(stateDir, "agents", "worker", "agent");
      const workerStorePath = path.join(workerAgentDir, "auth-profiles.json");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(mainAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      process.env.OPENCLAW_STATE_DIR = stateDir;
      clearRuntimeAuthProfileStoreSnapshots();

      const store = loadAuthProfileStoreForRuntime(workerAgentDir, { readOnly: true });

      expect(store.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
      });
      expect(fs.existsSync(workerStorePath)).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      restoreEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("logs one warning with aggregated reasons for rejected auth-profiles entries", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      withTempAgentDir("openclaw-auth-invalid-", (agentDir) => {
        const invalidStore = {
          version: AUTH_STORE_VERSION,
          profiles: {
            "anthropic:missing-type": {
              provider: "anthropic",
            },
            "openai:missing-provider": {
              type: "api_key",
              key: "sk-openai",
            },
            "qwen:not-object": "broken",
          },
        };
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(invalidStore, null, 2)}\n`,
          "utf8",
        );
        const store = ensureAuthProfileStore(agentDir);
        expect(store.profiles).toEqual({});
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "ignored invalid auth profile entries during store load",
          {
            source: "auth-profiles.json",
            dropped: 3,
            reasons: {
              invalid_type: 1,
              missing_provider: 1,
              non_object: 1,
            },
            keys: ["anthropic:missing-type", "openai:missing-provider", "qwen:not-object"],
          },
        );
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "migrates SecretRef object in `key` to `keyRef` and clears `key`",
      prefix: "openclaw-nonstr-key-ref-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
      },
    },
    {
      name: "deletes non-string non-SecretRef `key` without setting keyRef",
      prefix: "openclaw-nonstr-key-num-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: 12345,
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toBeUndefined();
      },
    },
    {
      name: "does not overwrite existing `keyRef` when `key` contains a SecretRef",
      prefix: "openclaw-nonstr-key-dup-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: { source: "env", provider: "default", id: "WRONG_VAR" },
        keyRef: { source: "env", provider: "default", id: "CORRECT_VAR" },
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          source: "env",
          provider: "default",
          id: "CORRECT_VAR",
        });
      },
    },
    {
      name: "overwrites malformed `keyRef` with migrated ref from `key`",
      prefix: "openclaw-nonstr-key-malformed-ref-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        keyRef: null,
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
      },
    },
    {
      name: "preserves valid string `key` values unchanged",
      prefix: "openclaw-str-key-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: "sk-valid-plaintext-key",
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBe("sk-valid-plaintext-key");
      },
    },
    {
      name: "migrates SecretRef object in `token` to `tokenRef` and clears `token`",
      prefix: "openclaw-nonstr-token-ref-",
      profileId: "anthropic:default",
      profile: {
        type: "token",
        provider: "anthropic",
        token: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
      },
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBeUndefined();
        expect(token.tokenRef).toEqual({
          source: "env",
          provider: "default",
          id: "ANTHROPIC_TOKEN",
        });
      },
    },
    {
      name: "deletes non-string non-SecretRef `token` without setting tokenRef",
      prefix: "openclaw-nonstr-token-num-",
      profileId: "anthropic:default",
      profile: {
        type: "token",
        provider: "anthropic",
        token: 99999,
      },
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBeUndefined();
        expect(token.tokenRef).toBeUndefined();
      },
    },
    {
      name: "preserves valid string `token` values unchanged",
      prefix: "openclaw-str-token-",
      profileId: "anthropic:default",
      profile: {
        type: "token",
        provider: "anthropic",
        token: "tok-valid-plaintext",
      },
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBe("tok-valid-plaintext");
      },
    },
  ] as const)(
    "normalizes secret-backed auth profile fields during store load: $name (#58861)",
    (testCase) => {
      withTempAgentDir(testCase.prefix, (agentDir) => {
        writeAuthProfileStore(agentDir, { [testCase.profileId]: testCase.profile });
        const profile = loadAuthProfile(agentDir, testCase.profileId);
        testCase.assert(profile);
      });
    },
  );
});
