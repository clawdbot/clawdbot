// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;
const SESSION_EVENT_REFRESH_MAX_WAIT_MS = 1_000;

function sessionsResult(
  ts: number,
  sessions: SessionsListResult["sessions"] = [],
): SessionsListResult {
  return {
    ts,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function sessionChangedEvent(key: string): GatewayEventFrame {
  return {
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: key, reason: "create", key, kind: "direct", updatedAt: 1 },
  };
}

function createHarness(request: GatewayBrowserClient["request"]) {
  const client = { request } as GatewayBrowserClient;
  let eventListener: ((event: GatewayEventFrame) => void) | undefined;
  const sessions = createSessionCapability({
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: null,
    },
    subscribe: () => () => undefined,
    subscribeEvents(listener) {
      eventListener = listener;
      return () => {
        eventListener = undefined;
      };
    },
  });
  return { sessions, emitEvent: (event: GatewayEventFrame) => eventListener?.(event) };
}

function installPageLifecycle() {
  const documentEvents = new EventTarget();
  const pageEvents = new EventTarget();
  let visibilityState: DocumentVisibilityState = "visible";
  Object.defineProperty(documentEvents, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  return {
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    },
    pageHide() {
      pageEvents.dispatchEvent(new Event("pagehide"));
    },
    pageShow() {
      pageEvents.dispatchEvent(new Event("pageshow"));
    },
  };
}

describe("event-driven session list refresh", () => {
  it("refreshes exact managed queries by agent and retains appended dashboard windows", async () => {
    vi.useFakeTimers();
    const dashboardRows = Array.from({ length: 4 }, (_, index) => ({
      key: `agent:main:dashboard-${index}`,
      kind: "direct" as const,
      boardFace: "dashboard" as const,
      updatedAt: index + 1,
    }));
    const request = vi.fn(
      async (
        method: string,
        params?: {
          agentId?: string;
          archived?: "all";
          boardFace?: "dashboard";
          includeDerivedTitles?: boolean;
          includeLastMessage?: boolean;
          limit?: number;
          offset?: number;
        },
      ) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        if (params?.boardFace !== "dashboard") {
          return sessionsResult(1);
        }
        const rows = params.agentId
          ? [{ ...dashboardRows[0]!, key: `agent:${params.agentId}:dashboard` }]
          : dashboardRows;
        const offset = params.offset ?? 0;
        const page = rows.slice(offset, offset + (params.limit ?? 50));
        return {
          ...sessionsResult(1, page),
          totalCount: rows.length,
          hasMore: offset + page.length < rows.length,
          nextOffset: offset + page.length < rows.length ? offset + page.length : null,
        };
      },
    );
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const allAgentsQuery = {
      boardFace: "dashboard" as const,
      archivedFilter: "all" as const,
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 2,
    };
    const writerQuery = { ...allAgentsQuery, agentId: "writer" };
    const stopAll = sessions.subscribeList(allAgentsQuery, () => undefined);
    const stopWriter = sessions.subscribeList(writerQuery, () => undefined);

    try {
      await sessions.refreshList({ ...allAgentsQuery, force: true });
      await sessions.refreshList({ ...allAgentsQuery, offset: 2, append: true, force: true });
      await sessions.refreshList({ ...writerQuery, force: true });
      expect(sessions.listSnapshot(allAgentsQuery).result?.sessions).toHaveLength(4);
      request.mockClear();

      emitEvent(sessionChangedEvent("agent:research:changed"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      const researchDashboardRequests = request.mock.calls.filter(
        ([, params]) => (params as { boardFace?: unknown } | undefined)?.boardFace === "dashboard",
      );
      expect(researchDashboardRequests).toHaveLength(1);
      expect(researchDashboardRequests[0]?.[1]).toEqual({
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
        limit: 4,
        includeDerivedTitles: true,
        includeLastMessage: true,
        archived: "all",
        boardFace: "dashboard",
      });
      expect(researchDashboardRequests[0]?.[1]).not.toHaveProperty("offset");
      expect(researchDashboardRequests[0]?.[1]).not.toHaveProperty("agentId");
      expect(sessions.listSnapshot(allAgentsQuery).result?.sessions).toHaveLength(4);
      request.mockClear();

      emitEvent(sessionChangedEvent("agent:writer:changed"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      const writerDashboardRequests = request.mock.calls.filter(
        ([, params]) => (params as { boardFace?: unknown } | undefined)?.boardFace === "dashboard",
      );
      expect(writerDashboardRequests).toHaveLength(2);
      expect(
        writerDashboardRequests.map(
          ([, params]) => (params as { agentId?: string } | undefined)?.agentId ?? null,
        ),
      ).toEqual([null, "writer"]);
    } finally {
      stopAll();
      stopWriter();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("refreshes a Sessions-style managed query after a terminal session message", async () => {
    vi.useFakeTimers();
    const key = "agent:main:main";
    const calls = { canonical: 0, main: 0, research: 0 };
    const request = vi.fn(
      async (method: string, params?: { agentId?: string; includeUnknown?: boolean }) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        const lane =
          params?.includeUnknown === true
            ? "canonical"
            : params?.agentId === "main"
              ? "main"
              : "research";
        calls[lane] += 1;
        const done = lane !== "research" && calls[lane] > 1;
        const rowKey = lane === "research" ? "agent:research:other" : key;
        return sessionsResult(calls[lane], [
          {
            key: rowKey,
            kind: "direct",
            updatedAt: calls[lane],
            hasActiveRun: !done,
            status: done ? "done" : "running",
          },
        ]);
      },
    );
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const mainQuery = {
      agentId: "main",
      limit: 50,
      includeGlobal: true,
      includeUnknown: false,
      includeDerivedTitles: false,
      includeLastMessage: false,
      archivedFilter: "active" as const,
    };
    const researchQuery = { ...mainQuery, agentId: "research" };
    const stopMain = sessions.subscribeList(mainQuery, () => undefined);
    const stopResearch = sessions.subscribeList(researchQuery, () => undefined);

    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList({ ...mainQuery, force: true });
      await sessions.refreshList({ ...researchQuery, force: true });
      expect(sessions.listSnapshot(mainQuery).result?.sessions[0]).toMatchObject({
        hasActiveRun: true,
        status: "running",
      });
      request.mockClear();

      emitEvent({
        type: "event",
        event: "session.message",
        payload: { sessionKey: key, updatedAt: 1, status: "done" },
      });
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      expect(request).toHaveBeenCalledTimes(2);
      expect(calls).toEqual({ canonical: 2, main: 2, research: 1 });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        key,
        hasActiveRun: false,
        status: "done",
      });
      expect(sessions.listSnapshot(mainQuery).result?.sessions[0]).toMatchObject({
        key,
        hasActiveRun: false,
        status: "done",
      });
    } finally {
      stopMain();
      stopResearch();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("retains every loaded page when a session event replaces the canonical list", async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 120 }, (_, index) => ({
      key: `agent:main:session-${index}`,
      kind: "direct" as const,
      updatedAt: index + 1,
    }));
    const request = vi.fn(async (method: string, params?: { limit?: number; offset?: number }) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 50;
      const page = rows.slice(offset, offset + limit);
      const hasMore = offset + page.length < rows.length;
      return {
        ...sessionsResult(offset + 1, page),
        totalCount: rows.length,
        nextOffset: hasMore ? offset + page.length : null,
        hasMore,
      };
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ agentId: "main", limit: 60, force: true });
      await sessions.refresh({ agentId: "main", limit: 60, offset: 60, append: true, force: true });
      expect(sessions.state.result?.sessions).toHaveLength(120);

      emitEvent(sessionChangedEvent("agent:main:session-0"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      expect(request.mock.calls[2]?.[1]).toMatchObject({ agentId: "main", limit: 120 });
      expect(request.mock.calls[2]?.[1]).not.toHaveProperty("offset");
      expect(sessions.state.result?.sessions).toHaveLength(120);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("clears a recreated session's prior deletion before the debounced refresh", async () => {
    vi.useFakeTimers();
    const key = "agent:main:recreated-thread";
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { sessionKey: key, reason: "delete" },
      });
      expect(sessions.state.deletedSessions).toEqual([{ key, agentId: undefined }]);

      emitEvent(sessionChangedEvent(key));

      expect(sessions.state.deletedSessions).toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("debounces rapid session events into one trailing list refresh", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      emitEvent(sessionChangedEvent("agent:main:second"));
      emitEvent(sessionChangedEvent("agent:main:third"));

      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds canonical refresh latency during sustained event traffic", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      for (let index = 0; index < 5; index += 1) {
        await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS - 1);
        emitEvent(sessionChangedEvent(`agent:main:sustained-${index}`));
      }

      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(
        SESSION_EVENT_REFRESH_MAX_WAIT_MS - 5 * (SESSION_EVENT_REFRESH_DEBOUNCE_MS - 1),
      );
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("lets an explicit refresh bypass and subsume the event debounce", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:event"));
      await sessions.refresh({ force: true });

      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    { timing: "before", fireBeforeInitialCompletion: true },
    { timing: "after", fireBeforeInitialCompletion: false },
  ])(
    "preserves queued explicit options when the event debounce fires $timing the active request completes",
    async ({ fireBeforeInitialCompletion }) => {
      vi.useFakeTimers();
      const firstList = deferred<SessionsListResult>();
      const secondList = deferred<SessionsListResult>();
      const secondListStarted = deferred<void>();
      let listCalls = 0;
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        listCalls += 1;
        if (listCalls === 1) {
          return await firstList.promise;
        }
        if (listCalls === 2) {
          secondListStarted.resolve();
          return await secondList.promise;
        }
        return sessionsResult(listCalls);
      });
      const { sessions, emitEvent } = createHarness(
        request as unknown as GatewayBrowserClient["request"],
      );

      try {
        const initialRefresh = sessions.refresh({ agentId: "main", force: true });
        const explicitRefresh = sessions.refresh({
          agentId: "other",
          search: "queued",
          archivedFilter: "archived",
          limit: 17,
          includeDerivedTitles: true,
          backgroundHydrate: true,
          force: true,
        });

        emitEvent(sessionChangedEvent("agent:main:later-event"));
        if (fireBeforeInitialCompletion) {
          await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
          expect(request).toHaveBeenCalledTimes(1);
        }

        firstList.resolve(sessionsResult(1));
        await secondListStarted.promise;
        if (!fireBeforeInitialCompletion) {
          await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
        }

        expect(request.mock.calls[1]?.[1]).toEqual({
          includeGlobal: true,
          includeUnknown: true,
          configuredAgentsOnly: true,
          limit: 17,
          includeDerivedTitles: true,
          archived: true,
          agentId: "other",
          search: "queued",
        });
        expect(sessions.state.loading).toBe(false);

        secondList.resolve(sessionsResult(2));
        await Promise.all([initialRefresh, explicitRefresh]);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        firstList.resolve(sessionsResult(1));
        secondList.resolve(sessionsResult(2));
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    {
      timing: "after the append is queued",
      eventBeforeAppend: false,
      queueReplacementFirst: false,
    },
    {
      timing: "before the append is queued",
      eventBeforeAppend: true,
      queueReplacementFirst: false,
    },
    {
      timing: "before a queued replacement is replaced by the append",
      eventBeforeAppend: true,
      queueReplacementFirst: true,
    },
  ])("keeps event invalidation $timing", async ({ eventBeforeAppend, queueReplacementFirst }) => {
    vi.useFakeTimers();
    const firstList = deferred<SessionsListResult>();
    const secondList = deferred<SessionsListResult>();
    const secondListStarted = deferred<void>();
    let listCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      if (listCalls === 1) {
        return await firstList.promise;
      }
      if (listCalls === 2) {
        secondListStarted.resolve();
        return await secondList.promise;
      }
      return sessionsResult(listCalls);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      const initialRefresh = sessions.refresh({ agentId: "main", limit: 25, force: true });
      if (eventBeforeAppend) {
        emitEvent(sessionChangedEvent("agent:main:later-event"));
      }
      if (queueReplacementFirst) {
        void sessions.refresh({ agentId: "discarded", force: true });
      }
      const appendRefresh = sessions.refresh({
        agentId: "main",
        limit: 25,
        offset: 25,
        append: true,
        force: true,
      });
      if (!eventBeforeAppend) {
        emitEvent(sessionChangedEvent("agent:main:later-event"));
      }
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      firstList.resolve(sessionsResult(1));
      await secondListStarted.promise;
      expect(request.mock.calls[1]?.[1]).toMatchObject({
        agentId: "main",
        limit: 25,
        offset: 25,
      });

      secondList.resolve(sessionsResult(2));
      await Promise.all([initialRefresh, appendRefresh]);
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]?.[1]).toMatchObject({
        agentId: "main",
        limit: 25,
      });
      expect(request.mock.calls[2]?.[1]).not.toHaveProperty("offset");
    } finally {
      firstList.resolve(sessionsResult(1));
      secondList.resolve(sessionsResult(2));
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("queues one trailing refresh for an event during an in-flight refresh", async () => {
    vi.useFakeTimers();
    const secondList = deferred<SessionsListResult>();
    const thirdListStarted = deferred<void>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      if (listCalls === 2) {
        return await secondList.promise;
      }
      if (listCalls === 3) {
        thirdListStarted.resolve();
      }
      return sessionsResult(listCalls);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);

      emitEvent(sessionChangedEvent("agent:main:during-flight"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);

      secondList.resolve(sessionsResult(2));
      await thirdListStarted.promise;
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("defers a queued filtered refresh when the page hides during its active request", async () => {
    vi.useFakeTimers();
    const page = installPageLifecycle();
    const activeRefresh = deferred<SessionsListResult>();
    let filteredCalls = 0;
    const request = vi.fn(async (method: string, params?: { archived?: string }) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (params?.archived !== "all") {
        return sessionsResult(0);
      }
      filteredCalls += 1;
      return filteredCalls === 2 ? await activeRefresh.promise : sessionsResult(filteredCalls);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const unsubscribe = sessions.subscribeList({ agentId: "main", archivedFilter: "all" }, vi.fn());

    try {
      await sessions.refreshList({ agentId: "main", archivedFilter: "all", force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(filteredCalls).toBe(2);

      emitEvent(sessionChangedEvent("agent:main:queued"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      page.setVisibility("hidden");
      activeRefresh.resolve(sessionsResult(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(filteredCalls).toBe(2);

      page.setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
      expect(filteredCalls).toBe(3);
    } finally {
      activeRefresh.resolve(sessionsResult(2));
      unsubscribe();
      sessions.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("holds canonical and filtered event refreshes while hidden and catches up once", async () => {
    vi.useFakeTimers();
    const page = installPageLifecycle();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1, [{ key: "agent:main:pending", kind: "direct", updatedAt: 0 }]);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const unsubscribe = sessions.subscribeList({ agentId: "main", archivedFilter: "all" }, vi.fn());

    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList({ agentId: "main", archivedFilter: "all", force: true });
      emitEvent(sessionChangedEvent("agent:main:pending"));

      page.setVisibility("hidden");
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: "agent:main:pending",
          reason: "update",
          key: "agent:main:pending",
          kind: "direct",
          updatedAt: 2,
          archived: true,
          archivedAt: 2,
        },
      });
      expect(sessions.state.result?.sessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_MAX_WAIT_MS * 2);
      expect(request).toHaveBeenCalledTimes(2);

      page.setVisibility("visible");
      page.pageShow();
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(4);

      page.setVisibility("hidden");
      page.pageHide();
      page.pageShow();
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(4);
      page.setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(6);

      sessions.dispose();
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS * 2);
      expect(request).toHaveBeenCalledTimes(6);
    } finally {
      unsubscribe();
      sessions.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
