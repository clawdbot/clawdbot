import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  createSessionState,
  deferred,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar gateway session pagination", () => {
  it.each(["archived", "all"] as const)(
    "refreshes the %s sidebar once when another client changes sessions",
    async (statusFilter) => {
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      const firstResult = createSessionState("main", ["agent:main:before-remote-change"]).result;
      const changedResult = createSessionState("main", ["agent:main:after-remote-change"]).result;
      if (!firstResult || !changedResult) {
        throw new Error("expected filtered session results");
      }
      harness.list.mockResolvedValue(firstResult);
      const gateway = createGatewayHarness({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
      (sidebar as unknown as { sessionsStatusFilter: "archived" | "all" }).sessionsStatusFilter =
        statusFilter;
      sidebar.sessionData.resetSessionList();
      await sidebar.sessionData.refreshSidebarSessions("main");
      harness.list.mockClear();
      harness.list.mockResolvedValue(changedResult);

      gateway.publishEvent("sessions.changed", {
        sessionKey: "agent:main:after-remote-change",
        reason: "archive",
      });
      gateway.publishEvent("sessions.changed", {
        sessionKey: "agent:main:after-remote-change",
        reason: "archive",
      });

      await waitForFast(() => {
        expect(harness.list).toHaveBeenCalledTimes(1);
        expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
          "agent:main:after-remote-change",
        ]);
      });
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", archivedFilter: statusFilter }),
      );
    },
  );

  it.each(["archived", "all"] as const)(
    "keeps every loaded %s sidebar page after another client's session event",
    async (statusFilter) => {
      const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
      const keys = Array.from(
        { length: pageSize * 2 },
        (_, index) => `agent:main:session-${index}`,
      );
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      harness.list.mockImplementation(async (options) => {
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? pageSize;
        const sessions = createSessionState("main", keys.slice(offset, offset + limit)).result;
        if (!sessions) {
          throw new Error("expected a paginated filtered session result");
        }
        const nextOffset = offset + sessions.sessions.length;
        const hasMore = nextOffset < keys.length;
        return {
          ...sessions,
          totalCount: keys.length,
          nextOffset: hasMore ? nextOffset : null,
          hasMore,
        };
      });
      const gateway = createGatewayHarness({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
      (sidebar as unknown as { sessionsStatusFilter: "archived" | "all" }).sessionsStatusFilter =
        statusFilter;
      sidebar.sessionData.resetSessionList();
      await sidebar.sessionData.refreshSidebarSessions("main");
      await sidebar.sessionData.loadMoreSidebarSessions();
      expect(sidebar.sessionData.sessionsResult?.sessions).toHaveLength(pageSize * 2);
      harness.list.mockClear();

      gateway.publishEvent("sessions.changed", {
        sessionKey: keys[0],
        agentId: "main",
        reason: "archive",
      });

      await waitForFast(() => {
        expect(harness.list).toHaveBeenCalledOnce();
        expect(sidebar.sessionData.sessionsResult?.sessions).toHaveLength(pageSize * 2);
      });
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          archivedFilter: statusFilter,
          limit: pageSize * 2,
        }),
      );
    },
  );

  it.each(["archived", "all"] as const)(
    "keeps a pending %s first page across a stable same-client Gateway notification",
    async (statusFilter) => {
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      const result = createSessionState("main", ["agent:main:current-archive"]).result;
      if (!result) {
        throw new Error("expected a scoped session result");
      }
      const pendingPage = deferred<typeof result>();
      harness.list.mockImplementation(async () => await pendingPage.promise);
      const gateway = createGatewayHarness({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
      (sidebar as unknown as { sessionsStatusFilter: "archived" | "all" }).sessionsStatusFilter =
        statusFilter;
      sidebar.sessionData.resetSessionList();

      const pendingRefresh = sidebar.sessionData.refreshSidebarSessions("main");
      const generation = sidebar.sessionData.sessionScopeGeneration;

      gateway.publish({ offlineStable: true });
      await sidebar.updateComplete;

      expect(sidebar.sessionData.sessionScopeGeneration).toBe(generation);
      expect(harness.list).toHaveBeenCalledTimes(1);

      pendingPage.resolve(result);
      await pendingRefresh;
      await sidebar.updateComplete;

      expect(sidebar.sessionData.sessionsAgentId).toBe("main");
      expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
        "agent:main:current-archive",
      ]);
    },
  );

  it.each(["archived", "all"] as const)(
    "retires a pending %s first page when the selected agent changes",
    async (statusFilter) => {
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      const mainResult = createSessionState("main", ["agent:main:stale-archive"]).result;
      const researchResult = createSessionState("research", ["agent:research:current"]).result;
      if (!mainResult || !researchResult) {
        throw new Error("expected scoped session results");
      }
      const pendingMain = deferred<typeof mainResult>();
      harness.list.mockImplementation(async (options) =>
        options?.agentId === "research" ? researchResult : await pendingMain.promise,
      );
      const { sidebar, context } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        harness.sessions,
        "panel",
        TWO_AGENTS,
      );
      (sidebar as unknown as { sessionsStatusFilter: "archived" | "all" }).sessionsStatusFilter =
        statusFilter;
      sidebar.sessionData.resetSessionList();

      const staleRefresh = sidebar.sessionData.refreshSidebarSessions("main");
      context.agentSelection.state.selectedId = "research";
      context.agentSelection.state.scopeId = "research";
      sidebar.requestUpdate();
      await sidebar.updateComplete;

      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "research", archivedFilter: statusFilter }),
      );

      pendingMain.resolve(mainResult);
      await staleRefresh;
      await sidebar.updateComplete;

      expect(sidebar.sessionData.sessionsAgentId).toBe("research");
      expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
        "agent:research:current",
      ]);
    },
  );

  it.each(["archived", "all"] as const)(
    "retires a pending %s first page across a same-client reconnect",
    async (statusFilter) => {
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      const staleResult = createSessionState("main", ["agent:main:before-reconnect"]).result;
      const freshResult = createSessionState("main", ["agent:main:after-reconnect"]).result;
      if (!staleResult || !freshResult) {
        throw new Error("expected reconnect session results");
      }
      const pendingPage = deferred<typeof staleResult>();
      harness.list
        .mockImplementationOnce(async () => await pendingPage.promise)
        .mockResolvedValue(freshResult);
      const gateway = createGatewayHarness({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
      (sidebar as unknown as { sessionsStatusFilter: "archived" | "all" }).sessionsStatusFilter =
        statusFilter;
      sidebar.sessionData.resetSessionList();

      const staleRefresh = sidebar.sessionData.refreshSidebarSessions("main");
      gateway.publish({ phase: "reconnecting" });
      await sidebar.updateComplete;
      gateway.publish({ phase: "connected" });
      await sidebar.updateComplete;

      expect(harness.list).toHaveBeenCalledTimes(2);

      pendingPage.resolve(staleResult);
      await staleRefresh;
      await sidebar.updateComplete;

      expect(sidebar.sessionData.sessionsAgentId).toBe("main");
      expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
        "agent:main:after-reconnect",
      ]);
    },
  );

  it.each(["archived", "all"] as const)(
    "does not append a stale %s page during a full session refresh",
    async (statusFilter) => {
      const keys = Array.from({ length: 61 }, (_, index) => `agent:main:session-${index}`);
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      const firstResult = createSessionState("main", keys.slice(0, 60)).result;
      const nextResult = createSessionState("main", keys.slice(60)).result;
      if (!firstResult || !nextResult) {
        throw new Error("expected paginated session results");
      }
      const firstPage = {
        ...firstResult,
        count: 60,
        totalCount: 61,
        limitApplied: 60,
        offset: 0,
        nextOffset: 60,
        hasMore: true,
      };
      harness.list.mockResolvedValue(firstPage);
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        harness.sessions,
      );
      (sidebar as unknown as { sessionsStatusFilter: "archived" | "all" }).sessionsStatusFilter =
        statusFilter;
      sidebar.sessionData.resetSessionList();
      await sidebar.sessionData.refreshSidebarSessions("main");
      harness.list.mockClear();

      const fullRefresh = deferred<typeof firstPage>();
      harness.list.mockImplementation(async (options) =>
        options?.offset === 60
          ? { ...nextResult, totalCount: 61, offset: 60, nextOffset: null, hasMore: false }
          : await fullRefresh.promise,
      );
      const refreshing = sidebar.sessionData.refreshSidebarSessions("main");

      expect(sidebar.sessionData.sessionsLoading).toBe(true);
      await sidebar.sessionData.loadMoreSidebarSessions();
      expect(harness.list).toHaveBeenCalledTimes(1);
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", archivedFilter: statusFilter }),
      );
      expect(harness.list.mock.calls[0]?.[0]).not.toHaveProperty("offset");

      fullRefresh.resolve(firstPage);
      await refreshing;
      expect(sidebar.sessionData.sessionsResult?.sessions).toEqual(firstPage.sessions);
      expect(sidebar.sessionData.sessionsLoading).toBe(false);
    },
  );

  it("loads the 51st active session through the canonical paginated refresh", async () => {
    const keys = Array.from({ length: 51 }, (_, index) => `agent:main:session-${index}`);
    const harness = createSessionsHarness("main", keys.slice(0, 50));
    const initialResult = harness.sessions.state.result;
    const nextResult = createSessionState("main", keys.slice(50)).result;
    if (!initialResult || !nextResult) {
      throw new Error("expected paginated session results");
    }
    const firstPage = {
      ...initialResult,
      count: 50,
      totalCount: 51,
      limitApplied: 50,
      offset: 0,
      nextOffset: 50,
      hasMore: true,
    };
    harness.publishList({ result: firstPage, agentId: "main" });
    const refresh = vi.spyOn(harness.sessions, "refresh").mockImplementation(async (options) => {
      if (options?.offset !== 50) {
        return;
      }
      harness.publishList({
        agentId: "main",
        result: {
          ...nextResult,
          count: 51,
          totalCount: 51,
          limitApplied: 60,
          offset: 50,
          nextOffset: null,
          hasMore: false,
          sessions: [...firstPage.sessions, ...nextResult.sessions],
        },
      });
    });
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );

    for (let page = 0; page < 5; page += 1) {
      const button = sidebar.querySelector<HTMLButtonElement>('button[aria-label="Show more"]');
      if (!button) {
        break;
      }
      button.click();
      await sidebar.updateComplete;
    }
    const loadMore = sidebar.querySelector<HTMLButtonElement>(
      'button[aria-label="Load more sessions"]',
    );
    expect(loadMore).not.toBeNull();
    loadMore?.click();
    await sidebar.updateComplete;

    await waitForFast(() => {
      expect(sidebar.querySelector('[data-session-key="agent:main:session-50"]')).not.toBeNull();
    });
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        archivedFilter: "active",
        offset: 50,
        limit: SIDEBAR_SESSION_ROSTER_LIMIT,
        append: true,
        force: true,
      }),
    );
    expect(sidebar.querySelector('button[aria-label="Load more sessions"]')).toBeNull();
  });

  it("derives the active page offset when the Gateway omits its optional cursor", async () => {
    const keys = Array.from({ length: 51 }, (_, index) => `agent:main:session-${index}`);
    const harness = createSessionsHarness("main", keys.slice(0, 50));
    const initialResult = harness.sessions.state.result;
    if (!initialResult) {
      throw new Error("expected an active paginated session result");
    }
    harness.publishList({
      agentId: "main",
      result: {
        ...initialResult,
        count: 50,
        totalCount: 51,
        limitApplied: 50,
        nextOffset: undefined,
        hasMore: true,
      },
    });
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );

    await sidebar.sessionData.loadMoreSidebarSessions();

    expect(harness.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", archivedFilter: "active", offset: 50 }),
    );
  });

  it("does not turn an explicit terminal session cursor into another page", async () => {
    const harness = createSessionsHarness("main", ["agent:main:session-0"]);
    const initialResult = harness.sessions.state.result;
    if (!initialResult) {
      throw new Error("expected a terminal paginated session result");
    }
    harness.publishList({
      agentId: "main",
      result: {
        ...initialResult,
        count: 1,
        totalCount: 2,
        limitApplied: 1,
        nextOffset: null,
        hasMore: true,
      },
    });
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.refresh.mockClear();

    await sidebar.sessionData.loadMoreSidebarSessions();

    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it.each(["archived", "all"] as const)(
    "derives the %s page offset when the Gateway omits its optional cursor",
    async (statusFilter) => {
      const keys = Array.from({ length: 61 }, (_, index) => `agent:main:session-${index}`);
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      const firstResult = createSessionState("main", keys.slice(0, 60)).result;
      const nextResult = createSessionState("main", keys.slice(60)).result;
      if (!firstResult || !nextResult) {
        throw new Error("expected paginated archived session results");
      }
      const archived = statusFilter === "archived";
      const firstPage = {
        ...firstResult,
        sessions: firstResult.sessions.map((row) => Object.assign({}, row, { archived })),
        count: 60,
        totalCount: 61,
        limitApplied: 60,
        nextOffset: undefined,
        hasMore: true,
      };
      const nextPage = {
        ...nextResult,
        sessions: nextResult.sessions.map((row) => Object.assign({}, row, { archived })),
        count: 1,
        totalCount: 61,
        offset: 60,
        nextOffset: null,
        hasMore: false,
      };
      harness.list.mockImplementation(async (options) =>
        options?.offset === 60 ? nextPage : firstPage,
      );
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        harness.sessions,
      );
      (sidebar as unknown as { sessionsStatusFilter: "archived" | "all" }).sessionsStatusFilter =
        statusFilter;
      sidebar.sessionData.resetSessionList();
      await sidebar.sessionData.refreshSidebarSessions("main");
      harness.list.mockClear();

      await sidebar.sessionData.loadMoreSidebarSessions();

      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", archivedFilter: statusFilter, offset: 60 }),
      );
      expect(harness.sessions.state.result?.sessions[0]?.key).toBe("agent:main:canonical-active");
    },
  );

  it.each(["archived", "all"] as const)(
    "loads the 61st %s session without replacing the canonical active list",
    async (statusFilter) => {
      const keys = Array.from({ length: 61 }, (_, index) => `agent:main:session-${index}`);
      const harness = createSessionsHarness("main", ["agent:main:canonical-active"]);
      const firstResult = createSessionState("main", keys.slice(0, 60)).result;
      const nextResult = createSessionState("main", keys.slice(60)).result;
      if (!firstResult || !nextResult) {
        throw new Error("expected paginated session results");
      }
      const archived = statusFilter === "archived";
      const firstPage = {
        ...firstResult,
        sessions: firstResult.sessions.map((row) => Object.assign({}, row, { archived })),
        count: 60,
        totalCount: 61,
        limitApplied: 60,
        offset: 0,
        nextOffset: 60,
        hasMore: true,
      };
      const nextPage = {
        ...nextResult,
        sessions: nextResult.sessions.map((row) => Object.assign({}, row, { archived })),
        count: 1,
        totalCount: 61,
        limitApplied: 60,
        offset: 60,
        nextOffset: null,
        hasMore: false,
      };
      harness.list.mockImplementation(async (options) =>
        options?.offset === 60 ? nextPage : firstPage,
      );
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        harness.sessions,
      );
      (
        sidebar as unknown as {
          sessionsStatusFilter: "archived" | "all";
        }
      ).sessionsStatusFilter = statusFilter;
      sidebar.sessionData.resetSessionList();
      await sidebar.sessionData.refreshSidebarSessions("main");
      await sidebar.updateComplete;

      for (let page = 0; page < 6; page += 1) {
        const button = sidebar.querySelector<HTMLButtonElement>('button[aria-label="Show more"]');
        if (!button) {
          break;
        }
        button.click();
        await sidebar.updateComplete;
      }
      const loadMore = sidebar.querySelector<HTMLButtonElement>(
        'button[aria-label="Load more sessions"]',
      );
      expect(loadMore).not.toBeNull();
      loadMore?.click();
      await sidebar.updateComplete;

      await waitForFast(() => {
        expect(sidebar.querySelector('[data-session-key="agent:main:session-60"]')).not.toBeNull();
      });
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          archivedFilter: statusFilter,
          offset: 60,
          limit: SIDEBAR_SESSION_ROSTER_LIMIT,
        }),
      );
      expect(harness.refresh).not.toHaveBeenCalledWith(expect.objectContaining({ offset: 60 }));
      expect(harness.sessions.state.result?.sessions[0]?.key).toBe("agent:main:canonical-active");
      expect(sidebar.querySelector('button[aria-label="Load more sessions"]')).toBeNull();
    },
  );
});
