import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
} from "./auth-profiles.js";
import { AUTH_STORE_VERSION, log } from "./auth-profiles/constants.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
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
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
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
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes Codex CLI auth without persisting copied tokens into auth-profiles.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-external-sync-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(root, "codex-home");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        `${JSON.stringify(
          {
            auth_mode: "chatgpt",
            tokens: {
              access_token: "codex-access-token",
              refresh_token: "codex-refresh-token",
              account_id: "acct_123",
            },
            last_refresh: "2026-03-01T00:00:00.000Z",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.env.CODEX_HOME = codexHome;
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      clearRuntimeAuthProfileStoreSnapshots();

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["openai-codex:default"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "codex-access-token",
        refresh: "codex-refresh-token",
      });

      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
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
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
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
