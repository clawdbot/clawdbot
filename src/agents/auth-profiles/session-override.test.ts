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
    isProfileInCooldown: vi.fn(() => false),
    reset() {
      state.hasSource = false;
      state.store = { version: 1, profiles: {} };
    },
    resolveAuthProfileOrder: vi.fn(
      ({ store, provider }: { store: AuthProfileStore; provider: string }) => {
        const providerKey = normalizeProvider(provider);
        const ordered = Object.entries(store.order ?? {}).find(
          ([key]) => normalizeProvider(key) === providerKey,
        )?.[1];
        if (ordered) {
          return ordered;
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
      await expect(fs.access(`${agentDir}/auth-profiles.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
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
});
