import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
}));

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

      expect(ensureAuthProfileStore(agentDir).profiles["anthropic:default"]).toMatchObject({
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

      expect(ensureAuthProfileStore(agentDir).profiles["anthropic:default"]).toMatchObject({
        access: "access-2",
        refresh: "refresh-2",
      });

      const persisted = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, { access?: string; refresh?: string }>;
      };
      expect(persisted.profiles["anthropic:default"]).toMatchObject({
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
      expect(authProfiles.profiles["anthropic:default"]).toBeDefined();
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
      expect(localUpdateStore.profiles["openai-codex:default"]).toMatchObject({
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
      expect(child.profiles["openai:default"]).toMatchObject({
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

      expect(ensureAuthProfileStore(childAgentDir).profiles["openai-codex:default"]).toMatchObject({
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
      expect(localUpdateStore.profiles["openai-codex:default"]).toMatchObject({
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
      expect(child.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
      });
      expect(child.profiles["openai-codex:default"]).toBeUndefined();
      expect(ensureAuthProfileStore(childAgentDir).profiles["openai-codex:default"]).toMatchObject({
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
      expect(runtime.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
      });
      expect(runtime.profiles["openai-codex:default"]).toMatchObject({
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

      expect(ensureAuthProfileStore(childAgentDir).profiles["openai-codex:default"]).toMatchObject({
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
