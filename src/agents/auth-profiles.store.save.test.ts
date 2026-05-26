import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { legacyOAuthSidecarTestUtils } from "./auth-profiles/legacy-oauth-sidecar.js";
import { resolveAuthStatePath, resolveAuthStorePath } from "./auth-profiles/paths.js";
import { getRuntimeAuthProfileStoreSnapshot } from "./auth-profiles/runtime-snapshots.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreForLocalUpdate,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const externalAuthMocks = vi.hoisted(() => ({
  listRuntimeExternalAuthProfiles: vi.fn((params?: { store?: unknown }) => {
    const store = params?.store as { profiles?: Record<string, unknown> } | undefined;
    return Object.entries(store?.profiles ?? {})
      .filter(([, credential]) => (credential as { type?: string }).type === "oauth")
      .map(([profileId, credential]) => ({
        profileId,
        credential,
        persistence: externalAuthMocks.shouldPersistExternalAuthProfile({ profileId })
          ? "persisted"
          : "runtime-only",
      }));
  }),
  overlayExternalAuthProfiles: vi.fn((store: unknown) => store),
  shouldPersistExternalAuthProfile: vi.fn((_params?: { profileId?: string }) => true),
}));

vi.mock("./auth-profiles/external-auth.js", () => ({
  listRuntimeExternalAuthProfiles: externalAuthMocks.listRuntimeExternalAuthProfiles,
  overlayExternalAuthProfiles: externalAuthMocks.overlayExternalAuthProfiles,
  shouldPersistExternalAuthProfile: externalAuthMocks.shouldPersistExternalAuthProfile,
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
  it("resolves external auth profiles once per save", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-once-"));
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:one": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-one",
          refresh: "refresh-one",
          expires: Date.now() + 60_000,
        },
        "openai-codex:two": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-two",
          refresh: "refresh-two",
          expires: Date.now() + 60_000,
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai",
        },
      },
    };

    try {
      externalAuthMocks.listRuntimeExternalAuthProfiles.mockClear();

      saveAuthProfileStore(store, agentDir);

      expect(externalAuthMocks.listRuntimeExternalAuthProfiles).toHaveBeenCalledTimes(1);
      expect(externalAuthMocks.listRuntimeExternalAuthProfiles.mock.calls[0]?.[0]).toMatchObject({
        store,
        agentDir,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    externalAuthMocks.listRuntimeExternalAuthProfiles.mockClear();
    externalAuthMocks.overlayExternalAuthProfiles.mockImplementation((store) => store);
    externalAuthMocks.shouldPersistExternalAuthProfile.mockReturnValue(true);
  });

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

  it("keeps runtime-only external cli oauth profiles in active runtime snapshots", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-external-"));
    const externalProfileId = "anthropic:claude-cli";
    const localAnthropicProfileId = "anthropic:local";
    const localProfileId = "openai:default";
    externalAuthMocks.shouldPersistExternalAuthProfile.mockImplementation(
      (params?: { profileId?: string }) => params?.profileId !== externalProfileId,
    );

    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              [externalProfileId]: {
                type: "oauth",
                provider: "anthropic",
                access: "stale-external-access",
                refresh: "stale-external-refresh",
                expires: 1,
              },
            },
          },
        },
      ]);

      const runtimeStore: AuthProfileStore = {
        version: 1,
        runtimeExternalProfileIds: [externalProfileId],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          [externalProfileId]: {
            type: "oauth",
            provider: "anthropic",
            access: "external-access",
            refresh: "external-refresh",
            expires: 2,
          },
          [localProfileId]: {
            type: "api_key",
            provider: "openai",
            key: "sk-local",
          },
          [localAnthropicProfileId]: {
            type: "api_key",
            provider: "anthropic",
            key: "sk-anthropic-local",
          },
        },
        order: {
          anthropic: [externalProfileId],
          openai: [localProfileId],
        },
        lastGood: {
          anthropic: externalProfileId,
          openai: localProfileId,
        },
        usageStats: {
          [externalProfileId]: {
            lastUsed: 123,
          },
          [localProfileId]: {
            lastUsed: 456,
          },
        },
      };
      externalAuthMocks.overlayExternalAuthProfiles.mockImplementation((store) => {
        const base = store as AuthProfileStore;
        const externalUsage = base.usageStats?.[externalProfileId] ?? { lastUsed: 123 };
        return {
          ...base,
          profiles: {
            ...base.profiles,
            [externalProfileId]: runtimeStore.profiles[externalProfileId],
          },
          order: {
            ...base.order,
            anthropic: [externalProfileId],
          },
          lastGood: {
            ...base.lastGood,
            anthropic: externalProfileId,
          },
          usageStats: {
            ...base.usageStats,
            [externalProfileId]: externalUsage,
          },
          runtimeExternalProfileIds: [externalProfileId],
          runtimeExternalProfileIdsAuthoritative: true,
        };
      });

      saveAuthProfileStore(runtimeStore, agentDir);

      const persisted = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, unknown>;
      };
      expect(persisted.profiles[externalProfileId]).toBeUndefined();
      expectProfileFields(persisted.profiles[localProfileId], {
        type: "api_key",
        provider: "openai",
        key: "sk-local",
      });

      const persistedState = JSON.parse(
        await fs.readFile(resolveAuthStatePath(agentDir), "utf8"),
      ) as {
        order?: Record<string, string[]>;
        lastGood?: Record<string, string>;
        usageStats?: Record<string, unknown>;
      };
      expect(persistedState.order?.anthropic).toBeUndefined();
      expect(persistedState.lastGood?.anthropic).toBeUndefined();
      expect(persistedState.usageStats?.[externalProfileId]).toBeUndefined();
      expect(persistedState.order?.openai).toEqual([localProfileId]);

      const runtime = ensureAuthProfileStore(agentDir);
      expectProfileFields(runtime.profiles[externalProfileId], {
        type: "oauth",
        provider: "anthropic",
        access: "external-access",
        refresh: "external-refresh",
      });
      expect(runtime.order?.anthropic).toEqual([externalProfileId]);
      expect(runtime.lastGood?.anthropic).toBe(externalProfileId);
      expect(runtime.usageStats?.[externalProfileId]?.lastUsed).toBe(123);

      const runtimeWithoutExternal = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      expect(runtimeWithoutExternal.profiles[externalProfileId]).toBeUndefined();
      expect(runtimeWithoutExternal.order?.anthropic).toBeUndefined();
      expect(runtimeWithoutExternal.lastGood?.anthropic).toBeUndefined();
      expect(runtimeWithoutExternal.usageStats?.[externalProfileId]).toBeUndefined();

      saveAuthProfileStore(
        {
          ...runtimeStore,
          profiles: {
            ...runtimeStore.profiles,
            [externalProfileId]: {
              type: "oauth",
              provider: "anthropic",
              access: "refreshed-external-access",
              refresh: "refreshed-external-refresh",
              expires: 3,
            },
          },
          usageStats: {
            ...runtimeStore.usageStats,
            [externalProfileId]: {
              lastUsed: 789,
            },
          },
        },
        agentDir,
      );
      const snapshotAfterRuntimeBackedSave = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expectProfileFields(snapshotAfterRuntimeBackedSave?.profiles[externalProfileId], {
        type: "oauth",
        provider: "anthropic",
        access: "refreshed-external-access",
        refresh: "refreshed-external-refresh",
      });
      expect(snapshotAfterRuntimeBackedSave?.usageStats?.[externalProfileId]?.lastUsed).toBe(789);

      saveAuthProfileStore(runtimeWithoutExternal, agentDir);
      const persistedAfterDiskBackedSave = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
      };
      expect(persistedAfterDiskBackedSave.profiles[externalProfileId]).toBeUndefined();
      const snapshotAfterDiskBackedSave = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(snapshotAfterDiskBackedSave?.runtimeExternalProfileIds).toEqual([externalProfileId]);
      expect(snapshotAfterDiskBackedSave?.runtimeExternalProfileIdsAuthoritative).toBe(true);
      expectProfileFields(snapshotAfterDiskBackedSave?.profiles[externalProfileId], {
        type: "oauth",
        provider: "anthropic",
        access: "refreshed-external-access",
        refresh: "refreshed-external-refresh",
      });
      expectProfileFields(snapshotAfterDiskBackedSave?.profiles[localProfileId], {
        type: "api_key",
        provider: "openai",
        key: "sk-local",
      });
      expect(snapshotAfterDiskBackedSave?.order?.anthropic).toEqual([externalProfileId]);
      expect(snapshotAfterDiskBackedSave?.lastGood?.anthropic).toBe(externalProfileId);
      expect(snapshotAfterDiskBackedSave?.usageStats?.[externalProfileId]?.lastUsed).toBe(789);
      const ensuredRuntime = ensureAuthProfileStore(agentDir);
      expectProfileFields(ensuredRuntime.profiles[localProfileId], {
        type: "api_key",
        provider: "openai",
        key: "sk-local",
      });
      expect(ensuredRuntime.order?.anthropic).toEqual([externalProfileId]);
      expect(ensuredRuntime.lastGood?.anthropic).toBe(externalProfileId);
      expect(ensuredRuntime.usageStats?.[externalProfileId]?.lastUsed).toBe(789);

      saveAuthProfileStore(
        {
          ...runtimeWithoutExternal,
          order: {
            ...runtimeWithoutExternal.order,
            anthropic: [localAnthropicProfileId],
          },
          lastGood: {
            ...runtimeWithoutExternal.lastGood,
            anthropic: localAnthropicProfileId,
          },
        },
        agentDir,
      );
      const snapshotAfterExplicitOrderSave = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expectProfileFields(snapshotAfterExplicitOrderSave?.profiles[externalProfileId], {
        type: "oauth",
        provider: "anthropic",
        access: "refreshed-external-access",
        refresh: "refreshed-external-refresh",
      });
      expect(snapshotAfterExplicitOrderSave?.order?.anthropic).toEqual([localAnthropicProfileId]);
      expect(snapshotAfterExplicitOrderSave?.lastGood?.anthropic).toBe(localAnthropicProfileId);

      saveAuthProfileStore(
        {
          ...runtimeWithoutExternal,
          runtimeExternalProfileIds: [],
          runtimeExternalProfileIdsAuthoritative: true,
        },
        agentDir,
      );
      const snapshotAfterAuthoritativeRemoval = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(snapshotAfterAuthoritativeRemoval?.runtimeExternalProfileIds).toEqual([]);
      expect(snapshotAfterAuthoritativeRemoval?.runtimeExternalProfileIdsAuthoritative).toBe(true);
      expect(snapshotAfterAuthoritativeRemoval?.profiles[externalProfileId]).toBeUndefined();
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("preserves unrelated runtime-only external profiles after scoped runtime saves", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-scoped-"));
    const scopedProfileId = "anthropic:claude-cli";
    const unrelatedProfileId = "minimax:minimax-cli";
    externalAuthMocks.shouldPersistExternalAuthProfile.mockReturnValue(false);

    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            runtimeExternalProfileIds: [scopedProfileId, unrelatedProfileId],
            runtimeExternalProfileIdsAuthoritative: true,
            profiles: {
              [scopedProfileId]: {
                type: "oauth",
                provider: "anthropic",
                access: "old-scoped-access",
                refresh: "old-scoped-refresh",
                expires: 1,
              },
              [unrelatedProfileId]: {
                type: "oauth",
                provider: "minimax-portal",
                access: "unrelated-access",
                refresh: "unrelated-refresh",
                expires: 2,
              },
            },
            order: {
              anthropic: [scopedProfileId],
              "minimax-portal": [unrelatedProfileId],
            },
            lastGood: {
              anthropic: scopedProfileId,
              "minimax-portal": unrelatedProfileId,
            },
            usageStats: {
              [scopedProfileId]: { lastUsed: 10 },
              [unrelatedProfileId]: { lastUsed: 20 },
            },
          },
        },
      ]);

      saveAuthProfileStore(
        {
          version: 1,
          runtimeExternalProfileIds: [scopedProfileId],
          profiles: {
            [scopedProfileId]: {
              type: "oauth",
              provider: "anthropic",
              access: "new-scoped-access",
              refresh: "new-scoped-refresh",
              expires: 3,
            },
          },
          order: {
            anthropic: [scopedProfileId],
          },
          usageStats: {
            [scopedProfileId]: { lastUsed: 30 },
          },
        },
        agentDir,
      );

      const snapshot = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(snapshot?.runtimeExternalProfileIds).toEqual([scopedProfileId, unrelatedProfileId]);
      expect(snapshot?.runtimeExternalProfileIdsAuthoritative).toBe(true);
      expectProfileFields(snapshot?.profiles[scopedProfileId], {
        type: "oauth",
        provider: "anthropic",
        access: "new-scoped-access",
        refresh: "new-scoped-refresh",
      });
      expectProfileFields(snapshot?.profiles[unrelatedProfileId], {
        type: "oauth",
        provider: "minimax-portal",
        access: "unrelated-access",
        refresh: "unrelated-refresh",
      });
      expect(snapshot?.usageStats?.[scopedProfileId]?.lastUsed).toBe(30);
      expect(snapshot?.usageStats?.[unrelatedProfileId]?.lastUsed).toBe(20);
      expect(snapshot?.order?.anthropic).toEqual([scopedProfileId]);
      expect(snapshot?.order?.["minimax-portal"]).toEqual([unrelatedProfileId]);
      const scopedRead = ensureAuthProfileStore(agentDir, {
        externalCliProviderIds: ["anthropic"],
      });
      expect(scopedRead.profiles[unrelatedProfileId]).toBeUndefined();

      saveAuthProfileStore(
        {
          version: 1,
          runtimeExternalProfileIds: [scopedProfileId],
          profiles: {
            [scopedProfileId]: {
              type: "oauth",
              provider: "anthropic",
              access: "newer-scoped-access",
              refresh: "newer-scoped-refresh",
              expires: 4,
            },
            [unrelatedProfileId]: {
              type: "oauth",
              provider: "minimax-portal",
              access: "unrelated-access",
              refresh: "unrelated-refresh",
              expires: 2,
            },
          },
          order: {
            anthropic: [scopedProfileId],
            "minimax-portal": [unrelatedProfileId],
          },
        },
        agentDir,
      );

      const snapshotAfterProfileCarryingScopedSave = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(snapshotAfterProfileCarryingScopedSave?.runtimeExternalProfileIds).toEqual([
        scopedProfileId,
        unrelatedProfileId,
      ]);
      expect(snapshotAfterProfileCarryingScopedSave?.runtimeExternalProfileIdsAuthoritative).toBe(
        true,
      );
      const runtimeWithoutExternal = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      expect(runtimeWithoutExternal.profiles[unrelatedProfileId]).toBeUndefined();
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not persist profiles already marked runtime-only external", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-runtime-only-"));
    const profileId = "anthropic:claude-cli";

    try {
      const store: AuthProfileStore = {
        version: 1,
        runtimeExternalProfileIds: [profileId],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "anthropic",
            access: "external-access",
            refresh: "external-refresh",
            expires: 1,
          },
        },
        order: {
          anthropic: [profileId],
        },
        lastGood: {
          anthropic: profileId,
        },
        usageStats: {
          [profileId]: { lastUsed: 10 },
        },
      };
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);

      saveAuthProfileStore(store, agentDir);

      const authProfiles = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
      };
      expect(authProfiles.profiles[profileId]).toBeUndefined();

      const snapshot = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(snapshot?.runtimeExternalProfileIds).toEqual([profileId]);
      expect(snapshot?.profiles[profileId]).toMatchObject({
        type: "oauth",
        provider: "anthropic",
        access: "external-access",
        refresh: "external-refresh",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not persist runtime-only external profiles without an installed snapshot", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-unsnapshotted-"));
    const profileId = "openai-codex:default";

    try {
      saveAuthProfileStore(
        {
          version: 1,
          runtimeExternalProfileIds: [profileId],
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "runtime-access",
              refresh: "runtime-refresh",
              expires: 1,
            },
          },
        },
        agentDir,
      );

      const authProfiles = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
      };
      expect(authProfiles.profiles[profileId]).toBeUndefined();
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("returns active runtime-only external profiles on unscoped reads", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-read-runtime-only-"));
    const profileId = "openai-codex:default";

    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            runtimeExternalProfileIds: [profileId],
            runtimeExternalProfileIdsAuthoritative: true,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "runtime-access",
                refresh: "runtime-refresh",
                expires: 1,
              },
            },
            usageStats: {
              [profileId]: { lastUsed: 10 },
            },
          },
        },
      ]);

      const store = ensureAuthProfileStore(agentDir);

      expect(store.runtimeExternalProfileIds).toEqual([profileId]);
      expectProfileFields(store.profiles[profileId], {
        type: "oauth",
        provider: "openai-codex",
        access: "runtime-access",
        refresh: "runtime-refresh",
      });
      expect(store.usageStats?.[profileId]?.lastUsed).toBe(10);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not resurrect runtime-only profiles after authoritative empty overlays", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-read-removed-"));
    const profileId = "anthropic:claude-cli";
    externalAuthMocks.overlayExternalAuthProfiles.mockImplementation((store) => ({
      ...(store as AuthProfileStore),
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    }));

    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            runtimeExternalProfileIds: [profileId],
            runtimeExternalProfileIdsAuthoritative: true,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "anthropic",
                access: "runtime-access",
                refresh: "runtime-refresh",
                expires: 1,
              },
            },
          },
        },
      ]);

      const store = ensureAuthProfileStore(agentDir);

      expect(store.runtimeExternalProfileIds).toEqual([]);
      expect(store.runtimeExternalProfileIdsAuthoritative).toBe(true);
      expect(store.profiles[profileId]).toBeUndefined();
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("persists refreshed runtime-only external OAuth credentials", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-refreshed-"));
    const profileId = "anthropic:claude-cli";

    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            runtimeExternalProfileIds: [profileId],
            runtimeExternalProfileIdsAuthoritative: true,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "anthropic",
                access: "external-access",
                refresh: "external-refresh",
                expires: 1,
              },
            },
          },
        },
      ]);

      saveAuthProfileStore(
        {
          version: 1,
          runtimeExternalProfileIds: [profileId],
          runtimeExternalProfileIdsAuthoritative: true,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "anthropic",
              access: "refreshed-access",
              refresh: "refreshed-refresh",
              expires: 2,
            },
          },
        },
        agentDir,
      );

      const authProfiles = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
      };
      expectProfileFields(authProfiles.profiles[profileId], {
        type: "oauth",
        provider: "anthropic",
        access: "refreshed-access",
        refresh: "refreshed-refresh",
      });

      const activeRuntime = getRuntimeAuthProfileStoreSnapshot(agentDir);
      if (!activeRuntime) {
        throw new Error("expected active runtime auth snapshot");
      }
      saveAuthProfileStore(
        {
          ...activeRuntime,
          usageStats: {
            [profileId]: { lastUsed: 20 },
          },
        },
        agentDir,
      );

      const authProfilesAfterUsageSave = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
      };
      expectProfileFields(authProfilesAfterUsageSave.profiles[profileId], {
        type: "oauth",
        provider: "anthropic",
        access: "refreshed-access",
        refresh: "refreshed-refresh",
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

  it("keeps local replacements for old runtime-only profile ids visible", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-replace-"));
    const profileId = "anthropic:claude-cli";

    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            runtimeExternalProfileIds: [profileId],
            runtimeExternalProfileIdsAuthoritative: true,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "anthropic",
                access: "external-access",
                refresh: "external-refresh",
                expires: 1,
              },
            },
          },
        },
      ]);

      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "anthropic",
              key: "sk-local",
            },
          },
        },
        agentDir,
      );

      const snapshot = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(snapshot?.runtimeExternalProfileIds).toEqual([]);
      expect(snapshot?.runtimeExternalProfileIdsAuthoritative).toBe(true);
      expect(snapshot?.profiles[profileId]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-local",
      });

      const runtimeWithoutExternal = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      expect(runtimeWithoutExternal.profiles[profileId]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-local",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears non-authoritative runtime-only metadata after local replacements", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-replace-scoped-"));
    const profileId = "anthropic:claude-cli";

    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            runtimeExternalProfileIds: [profileId],
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "anthropic",
                access: "external-access",
                refresh: "external-refresh",
                expires: 1,
              },
            },
          },
        },
      ]);

      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "anthropic",
              key: "sk-local",
            },
          },
        },
        agentDir,
      );

      const snapshot = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(snapshot?.runtimeExternalProfileIds).toBeUndefined();
      expect(snapshot?.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
      expect(snapshot?.profiles[profileId]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-local",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
