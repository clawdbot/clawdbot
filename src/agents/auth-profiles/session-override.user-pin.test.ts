// Focused lifecycle coverage for explicit auth-profile pins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";
import type { AuthProfileStore } from "./types.js";

const PRIMARY_PROFILE_ID = "openai:primary@example.test";
const SECONDARY_PROFILE_ID = "openai:secondary@example.test";

const authStoreMocks = vi.hoisted(() => {
  const state: { store: AuthProfileStore } = {
    store: { version: 1, profiles: {} },
  };
  return {
    state,
    isProfileInCooldown: vi.fn(() => false),
  };
});

vi.mock("./store.js", () => ({
  ensureAuthProfileStore: () => authStoreMocks.state.store,
  hasAnyAuthProfileStoreSource: () => true,
}));

vi.mock("./order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    provider,
    credential,
  }: {
    provider: string;
    credential: { provider: string };
  }) => credential.provider === provider,
  isConfiguredAwsSdkAuthProfileForProvider: () => false,
  resolveAuthProfileOrder: ({ store, provider }: { store: AuthProfileStore; provider: string }) =>
    store.order?.[provider] ?? [],
}));

vi.mock("./usage.js", () => ({
  isProfileInCooldown: authStoreMocks.isProfileInCooldown,
}));

function createStore(order: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [PRIMARY_PROFILE_ID]: {
        type: "api_key",
        provider: "openai",
        key: "sk-primary",
      },
      [SECONDARY_PROFILE_ID]: {
        type: "api_key",
        provider: "openai",
        key: "sk-secondary",
      },
    },
    order: { openai: order },
  };
}

async function resolveSession(params: {
  sessionEntry: SessionEntry;
  isNewSession: boolean;
}): Promise<string | undefined> {
  return await resolveSessionAuthProfileOverride({
    cfg: {} as OpenClawConfig,
    provider: "openai",
    agentDir: "/tmp/agent",
    sessionEntry: params.sessionEntry,
    sessionStore: { "agent:main:main": params.sessionEntry },
    sessionKey: "agent:main:main",
    storePath: undefined,
    isNewSession: params.isNewSession,
  });
}

describe("explicit auth-profile pin lifecycle", () => {
  beforeEach(() => {
    authStoreMocks.state.store = createStore([PRIMARY_PROFILE_ID, SECONDARY_PROFILE_ID]);
    authStoreMocks.isProfileInCooldown.mockReset();
    authStoreMocks.isProfileInCooldown.mockReturnValue(false);
  });

  it.each([
    {
      name: "empty configured order",
      order: [] as string[],
      isNewSession: false,
      compactionCount: 0,
      authProfileOverrideCompactionCount: 0,
    },
    {
      name: "new session",
      order: [PRIMARY_PROFILE_ID, SECONDARY_PROFILE_ID],
      isNewSession: true,
      compactionCount: 0,
      authProfileOverrideCompactionCount: 0,
    },
    {
      name: "compaction advance",
      order: [PRIMARY_PROFILE_ID, SECONDARY_PROFILE_ID],
      isNewSession: false,
      compactionCount: 2,
      authProfileOverrideCompactionCount: 1,
    },
  ])(
    "preserves a valid user pin across $name",
    async ({ order, isNewSession, compactionCount, authProfileOverrideCompactionCount }) => {
      authStoreMocks.state.store = createStore(order);
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        compactionCount,
        authProfileOverride: PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount,
      };

      const resolved = await resolveSession({ sessionEntry, isNewSession });

      expect(resolved).toBe(PRIMARY_PROFILE_ID);
      expect(sessionEntry).toMatchObject({
        updatedAt: 1,
        authProfileOverride: PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount,
      });
    },
  );

  it("preserves a legacy source-less user pin on a new session", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      compactionCount: 0,
      authProfileOverride: PRIMARY_PROFILE_ID,
    };

    const resolved = await resolveSession({ sessionEntry, isNewSession: true });

    expect(resolved).toBe(PRIMARY_PROFILE_ID);
    expect(sessionEntry.authProfileOverride).toBe(PRIMARY_PROFILE_ID);
  });

  it("still rotates a legacy source-less automatic pin on a new session", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      compactionCount: 0,
      authProfileOverride: PRIMARY_PROFILE_ID,
      authProfileOverrideCompactionCount: 0,
    };

    const resolved = await resolveSession({ sessionEntry, isNewSession: true });

    expect(resolved).toBe(SECONDARY_PROFILE_ID);
    expect(sessionEntry.authProfileOverride).toBe(SECONDARY_PROFILE_ID);
    expect(sessionEntry.authProfileOverrideSource).toBe("auto");
  });
});
