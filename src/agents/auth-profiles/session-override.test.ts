import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";
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

const TEST_PRIMARY_PROFILE_ID = "openai-codex:primary@example.test";
const TEST_SECONDARY_PROFILE_ID = "openai-codex:secondary@example.test";

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
            provider: "openai-codex",
            key: "sk-josh",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-claude",
          },
        },
        order: {
          "openai-codex": [TEST_PRIMARY_PROFILE_ID],
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
        provider: "openai-codex",
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
            provider: "openai-codex",
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
            provider: "openai-codex",
            key: "sk-codex",
          },
        },
        order: {
          "openai-codex": [TEST_PRIMARY_PROFILE_ID],
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
        acceptedProviderIds: ["openai-codex"],
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
            provider: "openai-codex",
            key: "sk-codex",
          },
        },
        order: {
          "openai-codex": [TEST_PRIMARY_PROFILE_ID],
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
        acceptedProviderIds: ["openai-codex"],
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

  it("re-resolves a stale user session override when the selected profile becomes unusable", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-stale",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-healthy",
          },
        },
        order: {
          "openai-codex": [TEST_SECONDARY_PROFILE_ID, TEST_PRIMARY_PROFILE_ID],
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
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });
});
