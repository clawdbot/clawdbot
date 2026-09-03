// Focused lifecycle coverage for explicit auth-profile pins.
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  authStoreMocks,
  createAuthStoreWithProfiles,
  resolveSession,
  TEST_PRIMARY_PROFILE_ID,
  TEST_SECONDARY_PROFILE_ID,
} from "./session-override.test-support.js";

function createStore(order: string[]) {
  return createAuthStoreWithProfiles({
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
    order: { openai: order },
  });
}

async function resolvePinnedSession(
  sessionEntry: SessionEntry,
  isNewSession: boolean,
): Promise<string | undefined> {
  return await resolveSession({
    agentDir: "/tmp/agent",
    sessionEntry,
    sessionStore: { "agent:main:main": sessionEntry },
    isNewSession,
  });
}

describe("explicit auth-profile pin lifecycle", () => {
  beforeEach(() => {
    authStoreMocks.state.hasSource = true;
    authStoreMocks.state.store = createStore([TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID]);
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
      order: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
      isNewSession: true,
      compactionCount: 0,
      authProfileOverrideCompactionCount: 0,
    },
    {
      name: "compaction advance",
      order: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
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
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount,
      };

      const resolved = await resolvePinnedSession(sessionEntry, isNewSession);

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry).toMatchObject({
        updatedAt: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
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
      authProfileOverride: TEST_PRIMARY_PROFILE_ID,
    };

    const resolved = await resolvePinnedSession(sessionEntry, true);

    expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
    expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
  });

  it("still rotates a legacy source-less automatic pin on a new session", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      compactionCount: 0,
      authProfileOverride: TEST_PRIMARY_PROFILE_ID,
      authProfileOverrideCompactionCount: 0,
    };

    const resolved = await resolvePinnedSession(sessionEntry, true);

    expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
    expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
    expect(sessionEntry.authProfileOverrideSource).toBe("auto");
  });
});
