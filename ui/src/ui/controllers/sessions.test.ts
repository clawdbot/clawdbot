import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySessionsChangedEvent,
  deleteSessionsAndRefresh,
  loadSessions,
  subscribeSessions,
  type SessionsState,
} from "./sessions.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

if (!("window" in globalThis)) {
  Object.assign(globalThis, {
    window: {
      confirm: () => false,
    },
  });
}

function createState(request: RequestFn, overrides: Partial<SessionsState> = {}): SessionsState {
  return {
    client: { request } as unknown as SessionsState["client"],
    connected: true,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsError: null,
    sessionsFilterActive: "0",
    sessionsFilterLimit: "0",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    sessionsExpandedCheckpointKey: null,
    sessionsCheckpointItemsByKey: {},
    sessionsCheckpointLoadingKey: null,
    sessionsCheckpointBusyKey: null,
    sessionsCheckpointErrorByKey: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("subscribeSessions", () => {
  it("registers for session change events", async () => {
    const request = vi.fn(async () => ({ subscribed: true }));
    const state = createState(request);

    await subscribeSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.subscribe", {});
    expect(state.sessionsError).toBeNull();
  });
});

describe("deleteSessionsAndRefresh", () => {
  it("deletes multiple sessions and refreshes", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a", "key-b"]);

    expect(deleted).toEqual(["key-a", "key-b"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.delete", {
      key: "key-a",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.delete", {
      key: "key-b",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(state.sessionsLoading).toBe(false);
  });

  it("returns empty array when user cancels", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a"]);

    expect(deleted).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("returns partial results when some deletes fail", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.delete") {
        const p = params as { key: string };
        if (p.key === "key-b" || p.key === "key-c") {
          throw new Error(`delete failed: ${p.key}`);
        }
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a", "key-b", "key-c", "key-d"]);

    expect(deleted).toEqual(["key-a", "key-d"]);
    expect(state.sessionsError).toBe("Error: delete failed: key-b; Error: delete failed: key-c");
    expect(state.sessionsLoading).toBe(false);
  });

  it("returns empty array when already loading", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsLoading: true });

    const deleted = await deleteSessionsAndRefresh(state, ["key-a"]);

    expect(deleted).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("queues refreshes requested during delete without releasing mutation loading", async () => {
    let resolveDelete: () => void = () => undefined;
    let signalDeleteStarted: () => void = () => undefined;
    const deleteStarted = new Promise<void>((resolve) => {
      signalDeleteStarted = resolve;
    });
    const deleteBlocker = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        signalDeleteStarted();
        await deleteBlocker;
        return { ok: true };
      }
      if (method === "sessions.list") {
        return {
          ts: 2,
          path: "(multiple)",
          count: 0,
          defaults: {},
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deletePromise = deleteSessionsAndRefresh(state, ["key-a"]);
    await deleteStarted;
    expect(state.sessionsLoading).toBe(true);

    await loadSessions(state);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.sessionsLoading).toBe(true);

    resolveDelete();
    const deleted = await deletePromise;

    expect(deleted).toEqual(["key-a"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(state.sessionsLoading).toBe(false);
  });
});

describe("loadSessions", () => {
  it("coalesces overlapping refreshes instead of dropping the latest request", async () => {
    let resolveFirst: () => void = () => undefined;
    const firstBlocker = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      if (request.mock.calls.length === 1) {
        await firstBlocker;
        return {
          ts: 1,
          path: "(multiple)",
          count: 0,
          defaults: {},
          sessions: [],
        };
      }
      return {
        ts: 2,
        path: "(multiple)",
        count: 0,
        defaults: {},
        sessions: [],
      };
    });
    const state = createState(request, {
      sessionsFilterActive: "30",
      sessionsFilterLimit: "10",
    });

    const first = loadSessions(state);
    const second = loadSessions(state, { activeMinutes: 0, limit: 0 });
    expect(request).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {
      activeMinutes: 30,
      limit: 10,
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(state.sessionsResult?.ts).toBe(2);
    expect(state.sessionsLoading).toBe(false);
  });

  it("refreshes expanded checkpoint cards when the row summary changes", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "(multiple)",
          count: 1,
          defaults: {},
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: 1,
              compactionCheckpointCount: 1,
              latestCompactionCheckpoint: {
                checkpointId: "checkpoint-new",
                createdAt: 20,
              },
            },
          ],
        };
      }
      if (method === "sessions.compaction.list") {
        return {
          ok: true,
          key: "agent:main:main",
          checkpoints: [
            {
              checkpointId: "checkpoint-new",
              sessionKey: "agent:main:main",
              sessionId: "session-1",
              createdAt: 20,
              reason: "manual",
            },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      sessionsExpandedCheckpointKey: "agent:main:main",
      sessionsResult: {
        ts: 0,
        path: "(multiple)",
        count: 1,
        defaults: {},
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 0,
            compactionCheckpointCount: 3,
            latestCompactionCheckpoint: {
              checkpointId: "checkpoint-old",
              createdAt: 10,
            },
          },
        ],
      } as never,
      sessionsCheckpointItemsByKey: {
        "agent:main:main": [
          {
            checkpointId: "checkpoint-old",
            sessionKey: "agent:main:main",
            sessionId: "session-old",
            createdAt: 10,
            reason: "manual",
          },
        ] as never,
      },
    });

    await loadSessions(state);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.compaction.list", {
      key: "agent:main:main",
    });
    expect(
      state.sessionsCheckpointItemsByKey["agent:main:main"]?.map((item) => item.checkpointId),
    ).toEqual(["checkpoint-new"]);
  });
});

describe("applySessionsChangedEvent", () => {
  it("updates fresh context usage from websocket event payloads", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: "openai", model: "gpt-5.4", contextTokens: 200_000 },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            totalTokens: 20_000,
            totalTokensFresh: true,
            contextTokens: 200_000,
          },
        ],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:main",
      ts: 2,
      totalTokens: 190_000,
      totalTokensFresh: true,
      contextTokens: 200_000,
      model: "gpt-5.4",
    });

    expect(applied).toBe(true);
    expect(state.sessionsResult?.ts).toBe(2);
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      key: "agent:main:main",
      totalTokens: 190_000,
      totalTokensFresh: true,
      contextTokens: 200_000,
      model: "gpt-5.4",
    });
  });

  it("clears old token totals when the gateway marks the measurement stale", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: 200_000 },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            totalTokens: 190_000,
            totalTokensFresh: true,
            contextTokens: 200_000,
          },
        ],
      },
    });

    applySessionsChangedEvent(state, {
      sessionKey: "agent:main:main",
      totalTokensFresh: false,
      contextTokens: 200_000,
    });

    expect(state.sessionsResult?.sessions[0]?.totalTokens).toBeUndefined();
    expect(state.sessionsResult?.sessions[0]?.totalTokensFresh).toBe(false);
    expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(200_000);
  });
});
