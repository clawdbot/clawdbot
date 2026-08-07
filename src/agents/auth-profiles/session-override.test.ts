/**
 * Session auth-profile override rotation tests.
 * Exercises provider compatibility, cooldown handling, and persisted override
 * updates without loading the real auth store implementation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  patchSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  clearSessionAuthProfileOverride,
  resolveSessionAuthProfileOverride,
} from "./session-override.js";
import type { AuthProfileStore } from "./types.js";

const authStoreMocks = vi.hoisted(() => {
  const normalizeProvider = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const state: { hasSource: boolean; store: AuthProfileStore } = {
    hasSource: false,
    store: { version: 1, profiles: {} },
  };
  return {
    state,
    ensureAuthProfileStore: vi.fn(() => state.store),
    hasAnyAuthProfileStoreSource: vi.fn(() => state.hasSource),
    isProfileInCooldown: vi.fn((_store: AuthProfileStore, _profileId: string) => false),
    reset() {
      state.hasSource = false;
      state.store = { version: 1, profiles: {} };
    },
    resolveAuthProfileOrder: vi.fn(
      ({
        cfg,
        store,
        provider,
      }: {
        cfg?: OpenClawConfig;
        store: AuthProfileStore;
        provider: string;
      }) => {
        const providerKey = normalizeProvider(provider);
        const ordered = Object.entries(store.order ?? {}).find(
          ([key]) => normalizeProvider(key) === providerKey,
        )?.[1];
        if (ordered) {
          return ordered;
        }
        const configured = Object.entries(cfg?.auth?.profiles ?? {})
          .filter(([profileId, profile]) => {
            if (normalizeProvider(profile.provider) !== providerKey) {
              return false;
            }
            const stored = store.profiles[profileId];
            return !stored || normalizeProvider(stored.provider) === providerKey;
          })
          .map(([profileId]) => profileId);
        if (configured.length > 0) {
          return configured;
        }
        return Object.entries(store.profiles)
          .filter(([, profile]) => normalizeProvider(profile.provider) === providerKey)
          .map(([profileId]) => profileId);
      },
    ),
  };
});

vi.mock("./store.js", () => ({
  ensureAuthProfileStore: authStoreMocks.ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource: authStoreMocks.hasAnyAuthProfileStoreSource,
}));

vi.mock("./order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    cfg: _cfg,
    provider,
    credential,
  }: {
    cfg?: OpenClawConfig;
    provider: string;
    credential: { type: string; provider: string };
  }) => {
    const normalizeProvider = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const providerKey = normalizeProvider(provider);
    const credentialProviderKey = normalizeProvider(credential.provider);
    return (
      credentialProviderKey === providerKey ||
      (providerKey === "openaicodex" &&
        credentialProviderKey === "openai" &&
        credential.type === "api_key")
    );
  },
  isConfiguredAwsSdkAuthProfileForProvider: ({
    cfg,
    provider,
    profileId,
  }: {
    cfg?: OpenClawConfig;
    provider: string;
    profileId: string;
  }) => {
    const normalizeProvider = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const profile = cfg?.auth?.profiles?.[profileId];
    return (
      profile?.mode === "aws-sdk" &&
      normalizeProvider(profile.provider) === normalizeProvider(provider)
    );
  },
  resolveAuthProfileOrder: authStoreMocks.resolveAuthProfileOrder,
}));

vi.mock("./usage.js", () => ({
  isProfileInCooldown: authStoreMocks.isProfileInCooldown,
}));

async function withAuthState<T>(run: (state: OpenClawTestState) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-auth-",
    },
    run,
  );
}

function createAuthStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
  };
}

function createAuthStoreWithProfiles(params: {
  profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  order?: Record<string, string[]>;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: params.profiles,
    ...(params.order ? { order: params.order } : {}),
  };
}

const TEST_PRIMARY_PROFILE_ID = "openai:primary@example.test";
const TEST_SECONDARY_PROFILE_ID = "openai:secondary@example.test";

async function prepareCooldownAuthState(
  state: OpenClawTestState,
  options: {
    profileIds?: string[];
    usageStats?: AuthProfileStore["usageStats"];
  } = {},
): Promise<string> {
  const agentDir = state.agentDir();
  await fs.mkdir(agentDir, { recursive: true });
  authStoreMocks.state.hasSource = true;
  const profileIds = options.profileIds ?? [TEST_PRIMARY_PROFILE_ID];
  authStoreMocks.state.store = {
    ...createAuthStoreWithProfiles({
      profiles: Object.fromEntries(
        profileIds.map((profileId) => [
          profileId,
          { type: "api_key" as const, provider: "openai", key: "sk-test" },
        ]),
      ),
      order: { openai: profileIds },
    }),
    ...(options.usageStats ? { usageStats: options.usageStats } : {}),
  };
  authStoreMocks.isProfileInCooldown.mockReturnValue(true);
  return agentDir;
}

async function resolveOpenAiSession(params: {
  agentDir: string;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<string | undefined> {
  return await resolveSessionAuthProfileOverride({
    cfg: {} as OpenClawConfig,
    provider: "openai",
    ...params,
    sessionKey: params.sessionKey ?? "agent:main:main",
    isNewSession: false,
  });
}

function createAutomaticSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: 1,
    authProfileOverride: TEST_PRIMARY_PROFILE_ID,
    authProfileOverrideSource: "auto",
    ...overrides,
  };
}

describe("resolveSessionAuthProfileOverride", () => {
  afterEach(() => {
    authStoreMocks.reset();
    vi.clearAllMocks();
  });

  it("returns early when no auth sources exist", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openrouter",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      expect(authStoreMocks.ensureAuthProfileStore).not.toHaveBeenCalled();
      try {
        await fs.access(`${agentDir}/auth-profiles.json`);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
        return;
      }
      throw new Error("Expected auth-profiles.json to be absent");
    });
  });

  it("keeps user override when provider alias differs", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStore();

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "z.ai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });

  it("keeps config-only aws-sdk user overrides", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = false;
      authStoreMocks.state.store = { version: 1, profiles: {} };

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                auth: "aws-sdk",
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                models: [],
              },
            },
          },
          auth: {
            profiles: {
              "amazon-bedrock:default": {
                provider: "amazon-bedrock",
                mode: "aws-sdk",
              },
            },
          },
        } as OpenClawConfig,
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("amazon-bedrock:default");
      expect(sessionEntry.authProfileOverride).toBe("amazon-bedrock:default");
    });
  });

  it("clears aws-sdk config override when stored profile drifted to another provider", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          "amazon-bedrock:default": {
            type: "api_key",
            provider: "openrouter",
            key: "sk-drifted",
          },
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                auth: "aws-sdk",
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                models: [],
              },
            },
          },
          auth: {
            profiles: {
              "amazon-bedrock:default": {
                provider: "amazon-bedrock",
                mode: "aws-sdk",
              },
            },
          },
        } as OpenClawConfig,
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    });
  });

  it("keeps explicit user override when stored order prefers another profile", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-josh",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-claude",
          },
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_SECONDARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });

  it("keeps session override when CLI provider aliases the stored profile provider", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-codex",
          },
        },
        order: {
          "codex-cli": [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "codex-cli",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
    });
  });

  it("keeps a session override from an accepted runtime auth provider", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-codex",
          },
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        acceptedProviderIds: ["openai"],
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
    });
  });

  it("keeps user-pinned normal OpenAI API-key profiles for Codex sessions", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          "openai:api-key-backup": {
            type: "api_key",
            provider: "openai",
            key: "sk-openai",
          },
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-codex",
          },
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "openai:api-key-backup",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        acceptedProviderIds: ["openai"],
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai:api-key-backup");
      expect(sessionEntry.authProfileOverride).toBe("openai:api-key-backup");
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });

  it("keeps a valid user override during cooldown when a healthy sibling exists", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-stale",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-healthy",
          },
        },
        order: {
          openai: [TEST_SECONDARY_PROFILE_ID, TEST_PRIMARY_PROFILE_ID],
        },
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store: AuthProfileStore, profileId: string) => profileId === TEST_PRIMARY_PROFILE_ID,
      );

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });

  it("clears auth state without restoring concurrent session management fields", async () => {
    await withAuthState(async (state) => {
      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(scope, {
        sessionId: "s1",
        updatedAt: 1,
        label: "before",
        pinnedAt: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      });
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(sessionEntry).toBeDefined();
      const sessionStore = { [sessionKey]: sessionEntry! };

      await patchSessionEntry(scope, () => ({ label: "renamed", pinnedAt: undefined }));
      await clearSessionAuthProfileOverride({
        sessionEntry: sessionEntry!,
        sessionStore,
        sessionKey,
        storePath,
      });

      const persisted = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(persisted?.label).toBe("renamed");
      expect(persisted?.pinnedAt).toBeUndefined();
      expect(persisted?.authProfileOverride).toBeUndefined();
      expect(sessionStore[sessionKey]?.label).toBe("renamed");
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    });
  });

  it("rotates auth state without restoring concurrent session management fields", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-primary",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-secondary",
          },
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
        },
      });

      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(scope, {
        sessionId: "s1",
        updatedAt: 1,
        label: "before",
        pinnedAt: 1,
        compactionCount: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      });
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(sessionEntry).toBeDefined();
      const sessionStore = { [sessionKey]: sessionEntry! };

      await patchSessionEntry(scope, () => ({ label: "renamed", pinnedAt: undefined }));
      const resolved = await resolveOpenAiSession({
        agentDir,
        sessionEntry: sessionEntry!,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      const persisted = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(persisted?.label).toBe("renamed");
      expect(persisted?.pinnedAt).toBeUndefined();
      expect(persisted?.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionStore[sessionKey]?.label).toBe("renamed");
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    });
  });

  it("clears a persisted automatic override when every auth profile is in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        profileIds: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
      });

      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(scope, {
        sessionId: "s1",
        updatedAt: 1,
        label: "before",
        pinnedAt: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 3,
      });
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(sessionEntry).toBeDefined();
      const sessionStore = { [sessionKey]: sessionEntry! };
      await patchSessionEntry(scope, () => ({ label: "renamed", pinnedAt: undefined }));

      const resolved = await resolveOpenAiSession({
        agentDir,
        sessionEntry: sessionEntry!,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBeUndefined();
      for (const entry of [
        sessionEntry,
        sessionStore[sessionKey],
        loadSessionEntry({ ...scope, readConsistency: "latest" }),
      ]) {
        expect(entry?.authProfileOverride).toBeUndefined();
        expect(entry?.authProfileOverrideSource).toBeUndefined();
        expect(entry?.authProfileOverrideCompactionCount).toBeUndefined();
      }
      expect(sessionStore[sessionKey]?.label).toBe("renamed");
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    });
  });

  it.each([
    ["persisted", true, false, "user"],
    ["in-memory", false, false, "user"],
    ["persisted cross-provider", true, true, "user"],
    ["persisted legacy user", true, false, undefined],
    ["persisted automatic", true, false, "auto"],
  ] as const)(
    "preserves a newer %s override against an obsolete automatic clear",
    async (_label, persisted, crossProvider, source) => {
      await withAuthState(async (state) => {
        const agentDir = await prepareCooldownAuthState(state, {
          profileIds: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
        });
        const latestProfileId = crossProvider ? "anthropic:manual" : TEST_SECONDARY_PROFILE_ID;
        if (crossProvider) {
          authStoreMocks.state.store.profiles[latestProfileId] = {
            type: "api_key",
            provider: "anthropic",
            key: "sk-anthropic",
          };
        }
        const sessionKey = "agent:main:main";
        const scope = { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey };
        let sessionEntry = createAutomaticSessionEntry({
          label: "before",
          pinnedAt: 1,
          authProfileOverrideCompactionCount: 3,
        });
        const latestEntry: SessionEntry = {
          sessionId: "s1",
          updatedAt: 2,
          label: "manually selected",
          authProfileOverride: latestProfileId,
          ...(source ? { authProfileOverrideSource: source } : {}),
        };
        if (persisted) {
          await replaceSessionEntry(scope, sessionEntry);
          sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" })!;
          await patchSessionEntry(scope, () => ({
            ...latestEntry,
            authProfileOverrideSource: source,
            pinnedAt: undefined,
            authProfileOverrideCompactionCount: undefined,
          }));
        }
        const sessionStore = { [sessionKey]: persisted ? sessionEntry : latestEntry };
        const resolved = await resolveOpenAiSession({
          agentDir,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath: persisted ? scope.storePath : undefined,
        });

        expect(resolved).toBe(
          crossProvider || source === "auto" ? undefined : TEST_SECONDARY_PROFILE_ID,
        );
        const entries = [sessionEntry, sessionStore[sessionKey]];
        if (persisted) {
          entries.push(loadSessionEntry({ ...scope, readConsistency: "latest" })!);
        }
        latestEntry.updatedAt = sessionStore[sessionKey].updatedAt;
        for (const entry of entries) {
          expect(entry).toMatchObject(latestEntry);
          expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
          expect(entry.pinnedAt).toBeUndefined();
        }
      });
    },
  );

  it("preserves newer in-memory session metadata when an automatic override snapshot still matches", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = createAutomaticSessionEntry({ label: "stale", pinnedAt: 1 });
      const latestEntry = createAutomaticSessionEntry({ label: "latest", pinnedAt: 2 });
      const sessionStore = { "agent:main:main": latestEntry };

      const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionStore["agent:main:main"]).toBe(latestEntry);
      for (const entry of [sessionEntry, latestEntry]) {
        expect(entry.label).toBe("latest");
        expect(entry.pinnedAt).toBe(2);
        expect(entry.authProfileOverride).toBeUndefined();
        expect(entry.authProfileOverrideSource).toBeUndefined();
      }
    });
  });

  it("does not recreate a concurrently deleted in-memory session", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = createAutomaticSessionEntry();
      const sessionStore: Record<string, SessionEntry> = {};

      expect(await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore })).toBeUndefined();
      expect(Object.hasOwn(sessionStore, "agent:main:main")).toBe(false);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
    });
  });

  it("does not recreate a concurrently deleted session while clearing its automatic override", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(
        scope,
        createAutomaticSessionEntry({ sessionId: "deleted-session" }),
      );
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" })!;
      const sessionStore = { [sessionKey]: sessionEntry };
      await deleteSessionEntryLifecycle({
        archiveTranscript: false,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });

      const resolved = await resolveOpenAiSession({
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBeUndefined();
      expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toBeUndefined();
    });
  });

  it.each([
    {
      label: "rate-limit cooldown",
      hasHealthySibling: false,
      createStats: (until: number) => ({
        cooldownUntil: until,
        cooldownReason: "rate_limit" as const,
        cooldownModel: "model-x",
      }),
    },
    {
      label: "provider block",
      hasHealthySibling: false,
      createStats: (until: number) => ({
        blockedUntil: until,
        blockedReason: "subscription_limit" as const,
        blockedModel: "model-x",
        blockedScope: "model" as const,
      }),
    },
    {
      label: "rate-limit cooldown with a healthy sibling",
      hasHealthySibling: true,
      createStats: (until: number) => ({
        cooldownUntil: until,
        cooldownReason: "rate_limit" as const,
        cooldownModel: "model-x",
      }),
    },
  ])(
    "preserves established profile selection during a model-scoped $label",
    async ({ createStats, hasHealthySibling }) => {
      await withAuthState(async (state) => {
        const agentDir = await prepareCooldownAuthState(state, {
          profileIds: hasHealthySibling
            ? [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID]
            : undefined,
          usageStats: { [TEST_PRIMARY_PROFILE_ID]: createStats(Date.now() + 60_000) },
        });
        authStoreMocks.isProfileInCooldown.mockReturnValue(false);

        const sessionEntry = createAutomaticSessionEntry({
          model: "model-y",
          authProfileOverrideCompactionCount: 0,
        });
        const sessionStore = { "agent:main:main": sessionEntry };
        const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });
        expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
        expect(authStoreMocks.isProfileInCooldown).toHaveBeenCalledWith(
          expect.anything(),
          TEST_PRIMARY_PROFILE_ID,
          undefined,
          "model-y",
        );
      });
    },
  );

  it("clears an automatic override when a model-scoped cooldown also has a profile-wide disable", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        usageStats: {
          [TEST_PRIMARY_PROFILE_ID]: {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model-x",
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing",
          },
        },
      });

      const sessionEntry = createAutomaticSessionEntry({
        model: "model-y",
        authProfileOverrideCompactionCount: 0,
      });
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    });
  });

  it("does not persist an automatic override when every auth profile is in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);

      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const sessionStore = { "agent:main:main": sessionEntry };
      const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionEntry).toEqual({ sessionId: "s1", updatedAt: 1 });
      expect(sessionStore["agent:main:main"]).toBe(sessionEntry);
    });
  });

  it.each([
    { name: "missing", profile: undefined },
    {
      name: "provider-mismatched",
      profile: { type: "api_key" as const, provider: "anthropic", key: "sk-mismatched" },
    },
  ])(
    "does not replace a $name user override with an auth profile in cooldown",
    async ({ profile }) => {
      await withAuthState(async (state) => {
        const agentDir = await prepareCooldownAuthState(state);
        if (profile) {
          authStoreMocks.state.store.profiles["anthropic:stale"] = profile;
        }

        const sessionEntry: SessionEntry = {
          sessionId: "s1",
          updatedAt: 1,
          authProfileOverride: profile ? "anthropic:stale" : "openai:missing",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 2,
        };
        const sessionStore = { "agent:main:main": sessionEntry };
        const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });

        expect(resolved).toBeUndefined();
        expect(sessionEntry.authProfileOverride).toBeUndefined();
        expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
        expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
      });
    },
  );

  it("preserves a valid user-selected override when every auth profile is in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };
      const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
      expect(sessionEntry.updatedAt).toBe(1);
    });
  });

  it("rotates an automatic override to an auth profile that is not in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        profileIds: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store: AuthProfileStore, profileId: string) => profileId === TEST_PRIMARY_PROFILE_ID,
      );

      const sessionEntry = createAutomaticSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };
      const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("keeps an automatic override after its auth-profile cooldown expires", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        usageStats: { [TEST_PRIMARY_PROFILE_ID]: { cooldownUntil: Date.now() - 1 } },
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (store: AuthProfileStore, profileId: string) =>
          (store.usageStats?.[profileId]?.cooldownUntil ?? 0) > Date.now(),
      );

      const sessionEntry = createAutomaticSessionEntry({ authProfileOverrideCompactionCount: 0 });
      const sessionStore = { "agent:main:main": sessionEntry };
      const resolved = await resolveOpenAiSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.updatedAt).toBe(1);
    });
  });
});
