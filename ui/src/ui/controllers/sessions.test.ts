import { afterEach, describe, expect, it, vi } from "vitest";
import { isSessionRunActive } from "../session-run-state.ts";
import {
  applySessionsChangedEvent,
  createSessionAndRefresh,
  deleteSessionsAndRefresh,
  loadSessions,
  subscribeSessions,
  syncSelectedSessionMessageSubscription,
  type SessionsState,
} from "./sessions.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

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
    sessionsShowArchived: false,
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

describe("syncSelectedSessionMessageSubscription", () => {
  it("subscribes to the selected session message stream", async () => {
    const request = vi.fn(async () => ({ key: "agent:main:main" }));
    const state = createState(request, { sessionKey: "agent:main:main" } as Partial<
      SessionsState & { sessionKey: string }
    >) as SessionsState & { sessionKey: string };

    await syncSelectedSessionMessageSubscription(state);

    expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", {
      key: "agent:main:main",
    });
    expect(state.chatSessionMessageSubscriptionKey).toBe("agent:main:main");
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe("agent:main:main");
  });

  it("unsubscribes the previous selected session before switching streams", async () => {
    const request = vi.fn(async () => ({ key: "agent:main:next" }));
    const state = createState(request, {
      sessionKey: "agent:main:next",
      chatSessionMessageSubscriptionKey: "agent:main:previous",
    } as Partial<SessionsState & { sessionKey: string }>) as SessionsState & {
      sessionKey: string;
    };

    await syncSelectedSessionMessageSubscription(state);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.messages.unsubscribe", {
      key: "agent:main:previous",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", {
      key: "agent:main:next",
    });
    expect(state.chatSessionMessageSubscriptionKey).toBe("agent:main:next");
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe("agent:main:next");
  });

  it("does not churn when the selected alias resolves to a canonical key", async () => {
    const request = vi.fn(async () => ({ key: "agent:main:main" }));
    const state = createState(request, { sessionKey: "main" } as Partial<
      SessionsState & { sessionKey: string }
    >) as SessionsState & { sessionKey: string };

    await syncSelectedSessionMessageSubscription(state);
    await syncSelectedSessionMessageSubscription(state);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", { key: "main" });
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe("main");
    expect(state.chatSessionMessageSubscriptionKey).toBe("agent:main:main");
  });

  it("ignores stale subscription completions after the selected session changes", async () => {
    const firstSubscribe = createDeferred<{ key: string }>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      const key = (params as { key?: string } | undefined)?.key;
      if (method === "sessions.messages.subscribe" && key === "agent:main:first") {
        return await firstSubscribe.promise;
      }
      if (method === "sessions.messages.subscribe" && key === "agent:main:second") {
        return { key: "agent:main:second" };
      }
      if (method === "sessions.messages.unsubscribe") {
        return { subscribed: false, key };
      }
      throw new Error(`unexpected request: ${method} ${String(key)}`);
    });
    const state = createState(request, { sessionKey: "agent:main:first" } as Partial<
      SessionsState & { sessionKey: string }
    >) as SessionsState & { sessionKey: string };

    const firstSync = syncSelectedSessionMessageSubscription(state);
    expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", {
      key: "agent:main:first",
    });

    state.sessionKey = "agent:main:second";
    await syncSelectedSessionMessageSubscription(state);
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe("agent:main:second");
    expect(state.chatSessionMessageSubscriptionKey).toBe("agent:main:second");

    firstSubscribe.resolve({ key: "agent:main:first" });
    await firstSync;

    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe("agent:main:second");
    expect(state.chatSessionMessageSubscriptionKey).toBe("agent:main:second");
    expect(request).toHaveBeenCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:first",
    });
  });
});

describe("createSessionAndRefresh", () => {
  it("creates a dashboard session and refreshes the session list", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { key: "agent:main:dashboard:abc" };
      }
      if (method === "sessions.list") {
        return {
          ts: 2,
          path: "(multiple)",
          count: 1,
          defaults: {},
          sessions: [{ key: "agent:main:dashboard:abc", kind: "direct", updatedAt: 2 }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    const key = await createSessionAndRefresh(
      state,
      { agentId: "main", parentSessionKey: "agent:main:main" },
      { activeMinutes: 0, limit: 0, includeGlobal: true, includeUnknown: true },
    );

    expect(key).toBe("agent:main:dashboard:abc");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      agentId: "main",
      parentSessionKey: "agent:main:main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
    });
    expect(state.sessionsResult?.sessions[0]?.key).toBe("agent:main:dashboard:abc");
    expect(state.sessionsLoading).toBe(false);
  });

  it("keeps the current state when create does not return a key", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    const key = await createSessionAndRefresh(state);

    expect(key).toBeNull();
    expect(state.sessionsError).toBe("Error: sessions.create returned no key");
    expect(state.sessionsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not start a create mutation while sessions are loading", async () => {
    const request = vi.fn(async () => ({ key: "agent:main:dashboard:abc" }));
    const state = createState(request, { sessionsLoading: true });

    const key = await createSessionAndRefresh(state);

    expect(key).toBeNull();
    expect(request).not.toHaveBeenCalled();
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
      configuredAgentsOnly: true,
    });
    expect(state.sessionsLoading).toBe(false);
  });

  it("returns empty array when user cancels", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a"]);

    expect(deleted).toStrictEqual([]);
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

    expect(deleted).toStrictEqual([]);
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
      configuredAgentsOnly: true,
    });
    expect(state.sessionsLoading).toBe(false);
  });
});

describe("loadSessions", () => {
  it("hides explicitly archived sessions by default", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 1,
        path: "(multiple)",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "agent:main:main", kind: "direct", updatedAt: 2 },
          {
            key: "agent:main:subagent:archived",
            kind: "direct",
            updatedAt: 1,
            status: "done",
            archived: true,
          },
        ],
      };
    });
    const state = createState(request);

    await loadSessions(state);

    expect(state.sessionsResult?.sessions.map((session) => session.key)).toEqual([
      "agent:main:main",
    ]);
    expect(state.sessionsResult?.count).toBe(1);
  });

  it("includes explicitly archived sessions when explicitly shown", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 1,
        path: "(multiple)",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "agent:main:main", kind: "direct", updatedAt: 2 },
          {
            key: "agent:main:subagent:archived",
            kind: "direct",
            updatedAt: 1,
            status: "done",
            archived: true,
          },
        ],
      };
    });
    const state = createState(request, { sessionsShowArchived: true });

    await loadSessions(state);

    expect(state.sessionsResult?.sessions.map((session) => session.key)).toEqual([
      "agent:main:main",
      "agent:main:subagent:archived",
    ]);
    expect(state.sessionsResult?.count).toBe(2);
  });

  it("keeps terminal non-archived sessions visible by default", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 1,
        path: "(multiple)",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "agent:main:main", kind: "direct", updatedAt: 2 },
          {
            key: "agent:main:subagent:done",
            kind: "direct",
            updatedAt: 1,
            status: "done",
          },
        ],
      };
    });
    const state = createState(request);

    await loadSessions(state);

    expect(state.sessionsResult?.sessions.map((session) => session.key)).toEqual([
      "agent:main:main",
      "agent:main:subagent:done",
    ]);
    expect(state.sessionsResult?.count).toBe(2);
  });

  it("uses session list terminal state to clear stale local run tracking", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async (method: string) => {
        if (method !== "sessions.list") {
          throw new Error(`unexpected method: ${method}`);
        }
        return {
          ts: 1,
          path: "(multiple)",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "main",
              kind: "direct",
              updatedAt: 2,
              hasActiveRun: true,
              status: "done",
            },
          ],
        };
      });
      const state = createState(request) as SessionsState & {
        sessionKey: string;
        chatRunId: string | null;
        chatStream: string | null;
        chatStreamStartedAt: number | null;
        chatRunStatus?: unknown;
        compactionStatus?: unknown;
        compactionClearTimer?: ReturnType<typeof setTimeout> | null;
        fallbackStatus?: unknown;
        fallbackClearTimer?: ReturnType<typeof setTimeout> | null;
      };
      state.sessionKey = "main";
      state.chatRunId = "run-1";
      state.chatStream = "Visible answer";
      state.chatStreamStartedAt = 123;
      state.compactionStatus = {
        phase: "active",
        runId: "run-1",
        startedAt: 100,
        completedAt: null,
      };
      state.compactionClearTimer = setTimeout(() => undefined, 1_000);
      state.fallbackStatus = {
        selected: "openai/gpt-5.5",
        active: "anthropic/claude-sonnet-4-6",
        attempts: [],
        occurredAt: 100,
      };
      state.fallbackClearTimer = setTimeout(() => undefined, 1_000);

      await loadSessions(state);

      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
      expect(state.chatStreamStartedAt).toBeNull();
      expect(state.compactionStatus).toBeNull();
      expect(state.compactionClearTimer).toBeNull();
      expect(state.fallbackStatus).toBeNull();
      expect(state.fallbackClearTimer).toBeNull();
      expect(state.chatRunStatus).toMatchObject({
        phase: "done",
        runId: "run-1",
        sessionKey: "main",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stale running session list rows idle when no live run remains", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 2,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: 2,
            hasActiveRun: false,
            status: "running",
          },
        ],
      };
    });
    const state = createState(request, {
      sessionKey: "main",
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: false,
            status: "done",
          },
        ],
      },
    } as Partial<SessionsState & { sessionKey: string }>);

    await loadSessions(state);

    const current = state.sessionsResult?.sessions[0];
    expect(current).toMatchObject({
      key: "main",
      hasActiveRun: false,
      status: "running",
    });
    expect(isSessionRunActive(current!)).toBe(false);
  });

  it("omits the active-window cutoff when archived sessions are shown", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 1,
        path: "(multiple)",
        count: 0,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      };
    });
    const state = createState(request, {
      sessionsFilterActive: "120",
      sessionsFilterLimit: "50",
      sessionsShowArchived: true,
    });

    await loadSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.list", {
      limit: 50,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
    });
  });

  it("applies the active-window cutoff while archived sessions are hidden", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 1,
        path: "(multiple)",
        count: 0,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      };
    });
    const state = createState(request, {
      sessionsFilterActive: "120",
      sessionsFilterLimit: "50",
      sessionsShowArchived: false,
    });

    await loadSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.list", {
      activeMinutes: 120,
      limit: 50,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
    });
  });

  it("forwards scoped agent refreshes to sessions.list", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 1,
        path: "(multiple)",
        count: 0,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      };
    });
    const state = createState(request);

    await loadSessions(state, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
      agentId: "ops",
    });

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      agentId: "ops",
    });
  });

  it("forwards search and offset overrides to sessions.list", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 1,
        path: "(multiple)",
        count: 1,
        totalCount: 3,
        limitApplied: 1,
        offset: 2,
        nextOffset: null,
        hasMore: false,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [{ key: "agent:main:dashboard:telegram", kind: "direct", updatedAt: 3 }],
      };
    });
    const state = createState(request);

    await loadSessions(state, {
      activeMinutes: 0,
      limit: 1,
      offset: 2,
      search: "telegram",
      includeGlobal: true,
      includeUnknown: true,
    });

    expect(request).toHaveBeenCalledWith("sessions.list", {
      limit: 1,
      offset: 2,
      search: "telegram",
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
    });
  });

  it("appends paged session rows without duplicating existing rows", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        ts: 2,
        path: "(multiple)",
        count: 2,
        totalCount: 4,
        limitApplied: 2,
        offset: 2,
        nextOffset: null,
        hasMore: false,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "agent:main:dashboard:b", kind: "direct", updatedAt: 2 },
          { key: "agent:main:dashboard:c", kind: "direct", updatedAt: 1 },
        ],
      };
    });
    const state = createState(request, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 2,
        totalCount: 4,
        limitApplied: 2,
        nextOffset: 2,
        hasMore: true,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "agent:main:dashboard:a", kind: "direct", updatedAt: 4 },
          { key: "agent:main:dashboard:b", kind: "direct", updatedAt: 3 },
        ],
      },
    });

    await loadSessions(state, { limit: 2, offset: 2, append: true });

    expect(state.sessionsResult?.sessions.map((session) => session.key)).toEqual([
      "agent:main:dashboard:a",
      "agent:main:dashboard:b",
      "agent:main:dashboard:c",
    ]);
    expect(state.sessionsResult?.count).toBe(3);
    expect(state.sessionsResult?.totalCount).toBe(4);
    expect(state.sessionsResult?.hasMore).toBe(false);
    expect(state.sessionsResult?.nextOffset).toBeNull();
  });

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
        defaults: { modelProvider: null, model: null, contextTokens: null },
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
      configuredAgentsOnly: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
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
      configuredAgentsOnly: true,
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
  it("removes deleted sessions instead of keeping archived rows visible", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "agent:main:main", kind: "direct", updatedAt: 1 },
          { key: "agent:main:old", kind: "direct", updatedAt: 1 },
        ],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:old",
      reason: "delete",
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "deleted" });
    expect(state.sessionsResult?.sessions.map((session) => session.key)).toEqual([
      "agent:main:main",
    ]);
    expect(state.sessionsResult?.count).toBe(1);
  });

  it("does not synthesize new sessions from partial events without a store-backed row", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 0,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:ephemeral",
      reason: "message",
      ts: 2,
    });

    expect(applied).toEqual({ applied: false });
    expect(state.sessionsResult?.sessions).toStrictEqual([]);
  });

  it("applies partial events only to existing source-of-truth rows", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 1 }],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:main",
      reason: "message",
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.sessionsResult?.sessions).toEqual([
      { key: "agent:main:main", kind: "direct", updatedAt: 1 },
    ]);
  });

  it("drops rows that become explicitly archived while archived sessions are hidden", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [{ key: "agent:main:subagent:done", kind: "direct", updatedAt: 1 }],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:subagent:done",
      sessionId: "sess-done",
      status: "done",
      archived: true,
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "deleted" });
    expect(state.sessionsResult?.sessions).toStrictEqual([]);
  });

  it("keeps terminal status updates visible while archived sessions are hidden", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [{ key: "agent:main:subagent:done", kind: "direct", updatedAt: 1 }],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:subagent:done",
      sessionId: "sess-done",
      status: "done",
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.sessionsResult?.sessions).toHaveLength(1);
    expect(state.sessionsResult?.sessions[0]?.key).toBe("agent:main:subagent:done");
    expect(state.sessionsResult?.sessions[0]?.status).toBe("done");
  });

  it("clears preserved active-run flags on terminal status updates", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: true,
            status: "running",
          },
        ],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:main",
      sessionId: "sess-main",
      status: "done",
      endedAt: 2,
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: "done",
      endedAt: 2,
    });
  });

  it("clears the local chat run when an applied websocket patch makes the current session terminal", () => {
    const requestUpdate = vi.fn();
    const state: SessionsState & {
      sessionKey: string;
      chatRunId: string | null;
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatRunStatus?: unknown;
      requestUpdate: () => void;
    } = {
      ...createState(async () => undefined, {
        sessionsResult: {
          ts: 1,
          path: "(multiple)",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:super:main",
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: true,
              status: "running",
            },
          ],
        },
      }),
      sessionKey: "agent:super:main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 1,
      requestUpdate,
    };

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:main",
      sessionId: "sess-main",
      runId: "run-1",
      status: "done",
      hasActiveRun: false,
      endedAt: 2,
      ts: 2,
    });

    expect(applied).toEqual({
      applied: true,
      change: "updated",
      clearedChatRun: true,
      clearedChatRunStatus: {
        phase: "done",
        runId: "run-1",
        sessionKey: "agent:super:main",
      },
    });
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatRunStatus).toBeUndefined();
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("clears the local chat run when a lifecycle patch maps the client run id", () => {
    const requestUpdate = vi.fn();
    const state: SessionsState & {
      sessionKey: string;
      chatRunId: string | null;
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatRunStatus?: unknown;
      requestUpdate: () => void;
    } = {
      ...createState(async () => undefined, {
        sessionsResult: {
          ts: 1,
          path: "(multiple)",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:super:main",
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: true,
              status: "running",
            },
          ],
        },
      }),
      sessionKey: "agent:super:main",
      chatRunId: "client-run-1",
      chatStream: "",
      chatStreamStartedAt: 1,
      requestUpdate,
    };

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:main",
      sessionId: "sess-main",
      runId: "agent-run-1",
      clientRunId: "client-run-1",
      status: "done",
      hasActiveRun: false,
      endedAt: 2,
      ts: 2,
    });

    expect(applied).toEqual({
      applied: true,
      change: "updated",
      clearedChatRun: true,
      clearedChatRunStatus: {
        phase: "done",
        runId: "client-run-1",
        sessionKey: "agent:super:main",
      },
    });
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatRunStatus).toBeUndefined();
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("does not clear a new local run from a send patch with stale terminal status", () => {
    const requestUpdate = vi.fn();
    const state: SessionsState & {
      sessionKey: string;
      chatRunId: string | null;
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      requestUpdate: () => void;
    } = {
      ...createState(async () => undefined, {
        sessionsResult: {
          ts: 1,
          path: "(multiple)",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:super:main",
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: false,
              status: "done",
            },
          ],
        },
      }),
      sessionKey: "agent:super:main",
      chatRunId: "run-new",
      chatStream: "",
      chatStreamStartedAt: 3,
      requestUpdate,
    };

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:main",
      sessionId: "sess-main",
      reason: "send",
      status: "done",
      hasActiveRun: true,
      updatedAt: 4,
      ts: 4,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.chatRunId).toBe("run-new");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamStartedAt).toBe(3);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("does not clear a newer local run from a runless older terminal patch", () => {
    const requestUpdate = vi.fn();
    const state: SessionsState & {
      sessionKey: string;
      chatRunId: string | null;
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      requestUpdate: () => void;
    } = {
      ...createState(async () => undefined, {
        sessionsResult: {
          ts: 10,
          path: "(multiple)",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:super:main",
              kind: "direct",
              updatedAt: 10,
              hasActiveRun: true,
              status: "running",
            },
          ],
        },
      }),
      sessionKey: "agent:super:main",
      chatRunId: "run-new",
      chatStream: "",
      chatStreamStartedAt: 20,
      requestUpdate,
    };

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:main",
      sessionId: "sess-main",
      status: "done",
      hasActiveRun: false,
      endedAt: 12,
      updatedAt: 12,
      ts: 12,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.chatRunId).toBe("run-new");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamStartedAt).toBe(20);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("does not clear a newer local run from an older terminal websocket patch", () => {
    const requestUpdate = vi.fn();
    const state: SessionsState & {
      sessionKey: string;
      chatRunId: string | null;
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      requestUpdate: () => void;
    } = {
      ...createState(async () => undefined, {
        sessionsResult: {
          ts: 1,
          path: "(multiple)",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:super:main",
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: true,
              status: "running",
            },
          ],
        },
      }),
      sessionKey: "agent:super:main",
      chatRunId: "run-new",
      chatStream: "",
      chatStreamStartedAt: 3,
      requestUpdate,
    };

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:main",
      sessionId: "sess-main",
      runId: "run-old",
      status: "done",
      hasActiveRun: false,
      endedAt: 2,
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.chatRunId).toBe("run-new");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamStartedAt).toBe(3);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("does not clear a new local run from unrelated session updates", () => {
    const requestUpdate = vi.fn();
    const state: SessionsState & {
      sessionKey: string;
      chatRunId: string | null;
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      requestUpdate: () => void;
    } = {
      ...createState(async () => undefined, {
        sessionsResult: {
          ts: 1,
          path: "(multiple)",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:super:main",
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: false,
              status: "done",
            },
          ],
        },
      }),
      sessionKey: "agent:super:main",
      chatRunId: "run-2",
      chatStream: "",
      chatStreamStartedAt: 3,
      requestUpdate,
    };

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:side",
      sessionId: "sess-side",
      kind: "direct",
      status: "running",
      hasActiveRun: true,
      updatedAt: 4,
      ts: 4,
    });

    expect(applied).toEqual({ applied: true, change: "inserted" });
    expect(state.chatRunId).toBe("run-2");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamStartedAt).toBe(3);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("keeps stale running session events idle after a local terminal reconcile", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:super:main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: false,
            status: "done",
          },
        ],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:main",
      sessionId: "sess-main",
      phase: "message",
      status: "running",
      updatedAt: 2,
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    const current = state.sessionsResult?.sessions[0];
    expect(current).toMatchObject({
      key: "agent:super:main",
      hasActiveRun: false,
      status: "running",
    });
    expect(isSessionRunActive(current!)).toBe(false);
  });

  it("revives active state when a new lifecycle start follows stale idle state", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:super:main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: false,
            status: "done",
          },
        ],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:super:main",
      sessionId: "sess-main",
      phase: "start",
      status: "running",
      startedAt: 2,
      updatedAt: 2,
      ts: 2,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    const current = state.sessionsResult?.sessions[0];
    expect(current).toMatchObject({
      key: "agent:super:main",
      hasActiveRun: true,
      status: "running",
    });
    expect(isSessionRunActive(current!)).toBe(true);
  });

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
      sessionId: "sess-main",
      ts: 2,
      totalTokens: 190_000,
      totalTokensFresh: true,
      contextTokens: 200_000,
      model: "gpt-5.4",
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.sessionsResult?.ts).toBe(2);
    expect(state.sessionsResult?.sessions[0]?.key).toBe("agent:main:main");
    expect(state.sessionsResult?.sessions[0]?.totalTokens).toBe(190_000);
    expect(state.sessionsResult?.sessions[0]?.totalTokensFresh).toBe(true);
    expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(200_000);
    expect(state.sessionsResult?.sessions[0]?.model).toBe("gpt-5.4");
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
      sessionId: "sess-main",
      totalTokensFresh: false,
      contextTokens: 200_000,
    });

    expect(state.sessionsResult?.sessions[0]?.totalTokens).toBeUndefined();
    expect(state.sessionsResult?.sessions[0]?.totalTokensFresh).toBe(false);
    expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(200_000);
  });

  it("keeps updated existing rows sorted like sessions.list", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:newer",
            kind: "direct",
            updatedAt: 10,
          },
          {
            key: "agent:main:older",
            kind: "direct",
            updatedAt: 1,
          },
        ],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:older",
      ts: 2,
      updatedAt: 20,
    });

    expect(applied).toEqual({ applied: true, change: "updated" });
    expect(state.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "agent:main:older",
      "agent:main:newer",
    ]);
  });

  it("reports when reliable websocket event payloads insert new rows", () => {
    const state = createState(async () => undefined, {
      sessionsResult: {
        ts: 1,
        path: "(multiple)",
        count: 0,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      },
    });

    const applied = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:new",
      sessionId: "sess-new",
      ts: 2,
      kind: "direct",
      updatedAt: 2,
    });

    expect(applied).toEqual({ applied: true, change: "inserted" });
    expect(state.sessionsResult?.count).toBe(1);
    expect(state.sessionsResult?.sessions[0]?.key).toBe("agent:main:new");
    expect(state.sessionsResult?.sessions[0]?.kind).toBe("direct");
    expect(state.sessionsResult?.sessions[0]?.updatedAt).toBe(2);
  });
});
