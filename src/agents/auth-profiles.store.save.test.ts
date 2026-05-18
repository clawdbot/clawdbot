import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { legacyOAuthSidecarTestUtils } from "./auth-profiles/legacy-oauth-sidecar.js";
import { resolveAuthStatePath, resolveAuthStorePath } from "./auth-profiles/paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreForLocalUpdate,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

vi.mock("./auth-profiles/external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
  syncPersistedExternalCliAuthProfiles: <T>(store: T) => store,
}));

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectProfileFields(profile: unknown, expected: Record<string, unknown>): void {
  const actual = requireRecord(profile, "auth profile");
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

describe("saveAuthProfileStore", () => {
  it("strips plaintext when keyRef/tokenRef are present", async () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-runtime-value",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            token: "gh-runtime-token",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-anthropic-plain",
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const parsed = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<
          string,
          { key?: string; keyRef?: unknown; token?: string; tokenRef?: unknown }
        >;
      };

      expect(parsed.profiles["openai:default"]?.key).toBeUndefined();
      expect(parsed.profiles["openai:default"]?.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      });

      expect(parsed.profiles["github-copilot:default"]?.token).toBeUndefined();
      expect(parsed.profiles["github-copilot:default"]?.tokenRef).toEqual({
        source: "env",
        provider: "default",
        id: "GITHUB_TOKEN",
      });

      expect(parsed.profiles["anthropic:default"]?.key).toBe("sk-anthropic-plain");
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("preserves legacy oauthRef only as doctor migration metadata during saves", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-oauth-ref-"));
    const authPath = resolveAuthStorePath(agentDir);
    const oauthRef = {
      source: "openclaw-credentials",
      provider: "openai-codex",
      id: "0123456789abcdef0123456789abcdef",
    };
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                expires: Date.now() + 60_000,
                oauthRef,
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const legacyRuntimeStore = {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            expires: Date.now() + 60_000,
          },
        },
      } as unknown as AuthProfileStore;

      saveAuthProfileStore(legacyRuntimeStore, agentDir);

      let parsed = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      expect(parsed.profiles["openai-codex:default"]?.oauthRef).toEqual(oauthRef);
      expect(ensureAuthProfileStore(agentDir).profiles["openai-codex:default"]).not.toHaveProperty(
        "oauthRef",
      );

      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "new-access-token",
              refresh: "new-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        agentDir,
      );

      parsed = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      expect(parsed.profiles["openai-codex:default"]).not.toHaveProperty("oauthRef");
      expect(parsed.profiles["openai-codex:default"]?.access).toBe("new-access-token");
      expect(parsed.profiles["openai-codex:default"]?.refresh).toBe("new-refresh-token");
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps rehydrated legacy oauthRef sidecar tokens runtime-only during ordinary saves", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-oauth-ref-"));
    const authPath = resolveAuthStorePath(agentDir);
    const previousOAuthDir = process.env.OPENCLAW_OAUTH_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    process.env.OPENCLAW_OAUTH_DIR = path.join(agentDir, "credentials");
    process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = "legacy-seed";
    const oauthRef = {
      source: "openclaw-credentials" as const,
      provider: "openai-codex" as const,
      id: "0123456789abcdef0123456789abcdef",
    };
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                expires: Date.now() + 60_000,
                oauthRef,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const sidecarPath = path.join(resolveOAuthDir(), "auth-profiles", `${oauthRef.id}.json`);
      await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
      await fs.writeFile(
        sidecarPath,
        `${JSON.stringify(
          {
            version: 1,
            profileId: "openai-codex:default",
            provider: "openai-codex",
            encrypted: legacyOAuthSidecarTestUtils.encryptLegacyOAuthMaterial({
              ref: oauthRef,
              profileId: "openai-codex:default",
              provider: "openai-codex",
              seed: "legacy-seed",
              material: {
                access: "legacy-access-token",
                refresh: "legacy-refresh-token",
              },
            }),
          },
          null,
          2,
        )}\n`,
      );

      const runtimeStore = ensureAuthProfileStore(agentDir);
      expectProfileFields(runtimeStore.profiles["openai-codex:default"], {
        access: "legacy-access-token",
        refresh: "legacy-refresh-token",
      });

      delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      const clonedRuntimeStore = JSON.parse(JSON.stringify(runtimeStore)) as AuthProfileStore;
      saveAuthProfileStore(clonedRuntimeStore, agentDir);

      const parsed = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      expect(parsed.profiles["openai-codex:default"]?.oauthRef).toEqual(oauthRef);
      expect(parsed.profiles["openai-codex:default"]).not.toHaveProperty("access");
      expect(parsed.profiles["openai-codex:default"]).not.toHaveProperty("refresh");
    } finally {
      if (previousOAuthDir === undefined) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = previousOAuthDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("writes refreshed legacy sidecar tokens inline when they replace runtime sidecar material", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-oauth-ref-"));
    const authPath = resolveAuthStorePath(agentDir);
    const previousOAuthDir = process.env.OPENCLAW_OAUTH_DIR;
    process.env.OPENCLAW_OAUTH_DIR = path.join(agentDir, "credentials");
    const profileId = "openai-codex:default";
    const oauthRef = {
      source: "openclaw-credentials",
      provider: "openai-codex",
      id: "0123456789abcdef0123456789abcdef",
    };
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                expires: Date.now() + 60_000,
                oauthRef,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const sidecarPath = path.join(resolveOAuthDir(), "auth-profiles", `${oauthRef.id}.json`);
      await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
      await fs.writeFile(
        sidecarPath,
        `${JSON.stringify(
          {
            version: 1,
            profileId,
            provider: "openai-codex",
            access: "legacy-access-token",
            refresh: "legacy-refresh-token",
          },
          null,
          2,
        )}\n`,
      );

      const runtimeStore = ensureAuthProfileStore(agentDir);
      const refreshedStore: AuthProfileStore = {
        ...runtimeStore,
        profiles: {
          ...runtimeStore.profiles,
          [profileId]: {
            ...runtimeStore.profiles[profileId],
            access: "refreshed-access-token",
            refresh: "refreshed-refresh-token",
          } as AuthProfileStore["profiles"][string],
        },
      };
      saveAuthProfileStore(refreshedStore, agentDir);

      const parsed = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      expect(parsed.profiles[profileId]).not.toHaveProperty("oauthRef");
      expect(parsed.profiles[profileId]?.access).toBe("refreshed-access-token");
      expect(parsed.profiles[profileId]?.refresh).toBe("refreshed-refresh-token");
    } finally {
      if (previousOAuthDir === undefined) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = previousOAuthDir;
      }
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes the runtime snapshot when a saved store rotates oauth tokens", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-runtime-"));
    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "anthropic:default": {
                type: "oauth",
                provider: "anthropic",
                access: "access-1",
                refresh: "refresh-1",
                expires: 1,
              },
            },
          },
        },
      ]);

      expectProfileFields(ensureAuthProfileStore(agentDir).profiles["anthropic:default"], {
        access: "access-1",
        refresh: "refresh-1",
      });

      const rotatedStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "oauth",
            provider: "anthropic",
            access: "access-2",
            refresh: "refresh-2",
            expires: 2,
          },
        },
      };

      saveAuthProfileStore(rotatedStore, agentDir);

      expectProfileFields(ensureAuthProfileStore(agentDir).profiles["anthropic:default"], {
        access: "access-2",
        refresh: "refresh-2",
      });

      const persisted = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, { access?: string; refresh?: string }>;
      };
      expectProfileFields(persisted.profiles["anthropic:default"], {
        access: "access-2",
        refresh: "refresh-2",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("writes runtime scheduling state to auth-state.json only", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-state-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-anthropic-plain",
          },
        },
        order: {
          anthropic: ["anthropic:default"],
        },
        lastGood: {
          anthropic: "anthropic:default",
        },
        usageStats: {
          "anthropic:default": {
            lastUsed: 123,
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const authProfiles = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
        order?: unknown;
        lastGood?: unknown;
        usageStats?: unknown;
      };
      expect(authProfiles.profiles["anthropic:default"]).toEqual({
        type: "api_key",
        provider: "anthropic",
        key: "sk-anthropic-plain",
      });
      expect(authProfiles.order).toBeUndefined();
      expect(authProfiles.lastGood).toBeUndefined();
      expect(authProfiles.usageStats).toBeUndefined();

      const authState = JSON.parse(await fs.readFile(resolveAuthStatePath(agentDir), "utf8")) as {
        order?: Record<string, string[]>;
        lastGood?: Record<string, string>;
        usageStats?: Record<string, { lastUsed?: number }>;
      };
      expect(authState.order?.anthropic).toEqual(["anthropic:default"]);
      expect(authState.lastGood?.anthropic).toBe("anthropic:default");
      expect(authState.usageStats?.["anthropic:default"]?.lastUsed).toBe(123);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not persist unchanged inherited main OAuth when saving secondary local updates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-inherited-"));
    const stateDir = path.join(root, ".openclaw");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const childAuthPath = resolveAuthStorePath(childAgentDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    try {
      saveAuthProfileStore({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "main-access-token",
            refresh: "main-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      });

      const localUpdateStore = ensureAuthProfileStoreForLocalUpdate(childAgentDir);
      expectProfileFields(localUpdateStore.profiles["openai-codex:default"], {
        type: "oauth",
        refresh: "main-refresh-token",
      });
      localUpdateStore.profiles["openai:default"] = {
        type: "api_key",
        provider: "openai",
        key: "sk-child-local",
      };

      saveAuthProfileStore(localUpdateStore, childAgentDir, {
        filterExternalAuthProfiles: false,
      });

      const child = JSON.parse(await fs.readFile(childAuthPath, "utf8")) as {
        profiles: Record<string, unknown>;
      };
      expectProfileFields(child.profiles["openai:default"], {
        type: "api_key",
        provider: "openai",
      });
      expect(child.profiles["openai-codex:default"]).toBeUndefined();

      saveAuthProfileStore({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "main-refreshed-access-token",
            refresh: "main-refreshed-refresh-token",
            expires: Date.now() + 120_000,
          },
        },
      });

      expectProfileFields(ensureAuthProfileStore(childAgentDir).profiles["openai-codex:default"], {
        type: "oauth",
        access: "main-refreshed-access-token",
        refresh: "main-refreshed-refresh-token",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist stale inherited main OAuth after main refreshes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-stale-inherited-"));
    const stateDir = path.join(root, ".openclaw");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const childAuthPath = resolveAuthStorePath(childAgentDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    try {
      saveAuthProfileStore({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "main-old-access-token",
            refresh: "main-old-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "acct-shared",
            email: "codex@example.test",
          },
        },
      });

      const localUpdateStore = ensureAuthProfileStoreForLocalUpdate(childAgentDir);
      expectProfileFields(localUpdateStore.profiles["openai-codex:default"], {
        type: "oauth",
        refresh: "main-old-refresh-token",
      });

      saveAuthProfileStore({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "main-refreshed-access-token",
            refresh: "main-refreshed-refresh-token",
            expires: Date.now() + 120_000,
            accountId: "acct-shared",
            email: "codex@example.test",
          },
        },
      });

      localUpdateStore.profiles["openai:default"] = {
        type: "api_key",
        provider: "openai",
        key: "sk-child-local",
      };
      saveAuthProfileStore(localUpdateStore, childAgentDir, {
        filterExternalAuthProfiles: false,
      });

      const child = JSON.parse(await fs.readFile(childAuthPath, "utf8")) as {
        profiles: Record<string, unknown>;
      };
      expectProfileFields(child.profiles["openai:default"], {
        type: "api_key",
        provider: "openai",
      });
      expect(child.profiles["openai-codex:default"]).toBeUndefined();
      expectProfileFields(ensureAuthProfileStore(childAgentDir).profiles["openai-codex:default"], {
        type: "oauth",
        access: "main-refreshed-access-token",
        refresh: "main-refreshed-refresh-token",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves inherited main OAuth in active secondary runtime snapshots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-snapshot-"));
    const stateDir = path.join(root, ".openclaw");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const childAuthPath = resolveAuthStorePath(childAgentDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    try {
      saveAuthProfileStore({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "main-access-token",
            refresh: "main-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      });

      const localUpdateStore = ensureAuthProfileStoreForLocalUpdate(childAgentDir);
      localUpdateStore.profiles["openai:default"] = {
        type: "api_key",
        provider: "openai",
        key: "sk-child-local",
      };
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: childAgentDir,
          store: localUpdateStore,
        },
      ]);

      saveAuthProfileStore(localUpdateStore, childAgentDir, {
        filterExternalAuthProfiles: false,
      });

      const child = JSON.parse(await fs.readFile(childAuthPath, "utf8")) as {
        profiles: Record<string, unknown>;
      };
      expect(child.profiles["openai-codex:default"]).toBeUndefined();

      const runtime = ensureAuthProfileStore(childAgentDir);
      expectProfileFields(runtime.profiles["openai:default"], {
        type: "api_key",
        provider: "openai",
      });
      expectProfileFields(runtime.profiles["openai-codex:default"], {
        type: "oauth",
        access: "main-access-token",
        refresh: "main-refresh-token",
      });

      saveAuthProfileStore({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "main-refreshed-access-token",
            refresh: "main-refreshed-refresh-token",
            expires: Date.now() + 120_000,
          },
        },
      });

      expectProfileFields(ensureAuthProfileStore(childAgentDir).profiles["openai-codex:default"], {
        type: "oauth",
        access: "main-refreshed-access-token",
        refresh: "main-refreshed-refresh-token",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
