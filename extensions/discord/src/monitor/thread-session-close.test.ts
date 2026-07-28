// Discord tests cover thread session close plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const deleteSessionEntry = vi.fn();
  const listSessionEntries = vi.fn();
  const resolveStorePath = vi.fn(() => "/tmp/openclaw-sessions.json");
  return { deleteSessionEntry, listSessionEntries, resolveStorePath };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    deleteSessionEntry: hoisted.deleteSessionEntry,
    listSessionEntries: hoisted.listSessionEntries,
    resolveStorePath: hoisted.resolveStorePath,
  };
});

let closeDiscordThreadSessions: typeof import("./thread-session-close.js").closeDiscordThreadSessions;

function setupStore(store: Record<string, { sessionId?: string; updatedAt: number }>) {
  hoisted.listSessionEntries.mockImplementation(() =>
    Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  );
  hoisted.deleteSessionEntry.mockImplementation(
    async (params: {
      expectedSessionId?: string | null;
      expectedUpdatedAt?: number;
      sessionKey: string;
    }) => {
      const entry = store[params.sessionKey];
      if (
        !entry ||
        (params.expectedSessionId === null
          ? entry.sessionId !== undefined
          : entry.sessionId !== params.expectedSessionId) ||
        entry.updatedAt !== params.expectedUpdatedAt
      ) {
        return false;
      }
      delete store[params.sessionKey];
      return true;
    },
  );
}

const THREAD_ID = "999";
const OTHER_ID = "111";

const MATCHED_KEY = `agent:main:discord:channel:${THREAD_ID}`;
const UNMATCHED_KEY = `agent:main:discord:channel:${OTHER_ID}`;

describe("closeDiscordThreadSessions", () => {
  beforeAll(async () => {
    ({ closeDiscordThreadSessions } = await import("./thread-session-close.js"));
  });

  beforeEach(() => {
    hoisted.deleteSessionEntry.mockReset();
    hoisted.listSessionEntries.mockReset();
    hoisted.resolveStorePath.mockClear();
    hoisted.resolveStorePath.mockReturnValue("/tmp/openclaw-sessions.json");
  });

  it("deletes sessions whose key contains the threadId", async () => {
    const store = {
      [MATCHED_KEY]: { updatedAt: 1_700_000_000_000 },
      [UNMATCHED_KEY]: { updatedAt: 1_700_000_000_001 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(1);
    expect(store[MATCHED_KEY]).toBeUndefined();
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("returns 0 and leaves store unchanged when no session matches", async () => {
    const store = {
      [UNMATCHED_KEY]: { updatedAt: 1_700_000_000_001 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("deletes all matching sessions when multiple keys contain the threadId", async () => {
    const keyA = `agent:main:discord:channel:${THREAD_ID}`;
    const keyB = `agent:work:discord:channel:${THREAD_ID}`;
    const keyC = `agent:main:discord:channel:${OTHER_ID}`;
    const store = {
      [keyA]: { updatedAt: 1_000 },
      [keyB]: { updatedAt: 2_000 },
      [keyC]: { updatedAt: 3_000 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(2);
    expect(store[keyA]).toBeUndefined();
    expect(store[keyB]).toBeUndefined();
    expect(store[keyC].updatedAt).toBe(3_000);
  });

  it("does not match a key that contains the threadId as a substring of a longer snowflake", async () => {
    const longerSnowflake = `${THREAD_ID}00`;
    const noMatchKey = `agent:main:discord:channel:${longerSnowflake}`;
    const store = {
      [noMatchKey]: { updatedAt: 9_999 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(store[noMatchKey].updatedAt).toBe(9_999);
  });

  it("matching is case-insensitive for the session key", async () => {
    const uppercaseKey = `agent:main:discord:channel:${THREAD_ID.toUpperCase()}`;
    const store = {
      [uppercaseKey]: { updatedAt: 5_000 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID.toLowerCase(),
    });

    expect(count).toBe(1);
    expect(store[uppercaseKey]).toBeUndefined();
  });

  it("returns 0 immediately when threadId is empty without touching the store", async () => {
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: "   ",
    });

    expect(count).toBe(0);
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(hoisted.deleteSessionEntry).not.toHaveBeenCalled();
  });

  it("does not recount sessions that were already deleted", async () => {
    const store = {
      [MATCHED_KEY]: { updatedAt: 1_700_000_000_000 },
      [UNMATCHED_KEY]: { updatedAt: 1_700_000_000_001 },
    };
    setupStore(store);

    const firstCount = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });
    const secondCount = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
    expect(store[MATCHED_KEY]).toBeUndefined();
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("does not delete a matching session that changed after the list snapshot", async () => {
    const store = {
      [MATCHED_KEY]: {
        sessionId: "fresh-session",
        updatedAt: 2_000,
      },
    };
    setupStore(store);
    hoisted.listSessionEntries.mockReturnValue([
      {
        sessionKey: MATCHED_KEY,
        entry: {
          sessionId: "old-session",
          updatedAt: 1_000,
        },
      },
    ]);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(store[MATCHED_KEY].updatedAt).toBe(2_000);
    expect(store[MATCHED_KEY].sessionId).toBe("fresh-session");
  });

  it("resolves the store path using cfg.session.store and accountId", async () => {
    const store = {};
    setupStore(store);

    await closeDiscordThreadSessions({
      cfg: { session: { store: "/custom/path/sessions.json" } },
      accountId: "my-bot",
      threadId: THREAD_ID,
    });

    expect(hoisted.resolveStorePath).toHaveBeenCalledWith("/custom/path/sessions.json", {
      agentId: "my-bot",
    });
  });
});
