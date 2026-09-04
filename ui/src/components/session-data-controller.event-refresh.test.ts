import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment node
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createSessionCapability, type SessionCapability } from "../lib/sessions/index.ts";
import type { SessionGateway } from "../lib/sessions/session-capability.ts";
import type { SessionDataControllerHost } from "./session-data-controller-catalog.ts";
import { SessionDataController } from "./session-data-controller.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createFilteredSessionController(
  statusFilter: "active" | "archived" | "all",
  rowCount = 1,
  includeActiveRows = false,
) {
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  });
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());

  const rows = Array.from({ length: rowCount }, (_, index) => ({
    key: index === 0 ? "agent:main:remote-change" : `agent:main:session-${index}`,
    kind: "direct" as const,
    updatedAt: index + 1,
  }));
  const resultForKeys = (keys: string[]) => ({
    ts: 1,
    path: "",
    count: keys.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: keys.map((key) => ({ key, kind: "direct" as const })),
  });
  const list = vi.fn(async (options?: Parameters<SessionCapability["list"]>[0]) => {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 60;
    const matchingRows =
      options?.involvingMe || options?.ownerId ? rows.filter((_, index) => index % 2 === 0) : rows;
    const sessions = matchingRows.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < matchingRows.length;
    return {
      ts: 1,
      path: "",
      count: sessions.length,
      totalCount: matchingRows.length,
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions,
    };
  });
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const client = {
    request: <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "sessions.groups.list") {
        return Promise.resolve({ names: [], sectionOrder: [] } as T);
      }
      if (method === "sessions.subscribe") {
        return Promise.resolve({ subscribed: true } as T);
      }
      const { archived, ...options } = (params ?? {}) as NonNullable<
        Parameters<SessionCapability["list"]>[0]
      > & { archived?: true | "all" };
      if (!includeActiveRows && !archived && !options.spawnedBy) {
        return Promise.resolve({
          ts: 1,
          path: "",
          count: 0,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [],
        } as T);
      }
      return list({
        ...options,
        ...(archived ? { archivedFilter: archived === true ? "archived" : "all" } : {}),
      }) as Promise<T>;
    },
  } as GatewayBrowserClient;
  const snapshot: SessionGateway["snapshot"] = {
    phase: "connected",
    client,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
  };
  const gatewayListeners = new Set<(next: SessionGateway["snapshot"]) => void>();
  const gateway = {
    snapshot,
    subscribe(listener: (next: SessionGateway["snapshot"]) => void) {
      gatewayListeners.add(listener);
      return () => gatewayListeners.delete(listener);
    },
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as const;
  const sessions = createSessionCapability(gateway);
  let selectedAgentId = "main";
  let selectedStatusFilter = statusFilter;
  let membership = { ownerId: null as string | null, involvingMe: false };
  const agentsState = {
    connected: true,
    client,
    agentsList: {
      defaultId: "main",
      agents: [{ id: "main" }, { id: "research" }],
    } as ApplicationContext["agents"]["state"]["agentsList"],
  };
  const agentListeners = new Set<(state: ApplicationContext["agents"]["state"]) => void>();
  const context = {
    gateway,
    sessions,
    agents: {
      state: agentsState,
      subscribe(listener: (state: ApplicationContext["agents"]["state"]) => void) {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
    },
    agentSelection: {
      get state() {
        return { selectedId: selectedAgentId, scopeId: selectedAgentId };
      },
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
  const host = {
    isConnected: true,
    connected: true,
    sessionDataContext: context,
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
    dismissTransientMenus: () => false,
    expandedAgentId: () => selectedAgentId,
    promoteCreatedSession: () => undefined,
    selectedAgentIdForSessions: () => selectedAgentId,
    sidebarSessionStatusFilter: () => selectedStatusFilter,
    sidebarSessionOwnerFilter: () => membership,
    querySelector: () => null,
  } satisfies SessionDataControllerHost;
  const controller = new SessionDataController(host);

  return {
    controller,
    list,
    resultForKeys,
    reconnect: () => {
      for (const phase of ["reconnecting", "connected"] as const) {
        snapshot.phase = phase;
        gatewayListeners.forEach((listener) => listener(snapshot));
      }
    },
    selectMembership: async (filter: typeof membership) => {
      membership = filter;
      await controller.refreshSidebarSessions();
    },
    selectAgent: (agentId: string) => {
      selectedAgentId = agentId;
      controller.synchronizeSessionScope();
    },
    selectStatusFilter: (nextStatusFilter: "active" | "archived" | "all") => {
      selectedStatusFilter = nextStatusFilter;
      controller.resetSessionList();
    },
    publishSessionChanged: (payload: Record<string, unknown> = {}) => {
      const event = {
        type: "event" as const,
        event: "sessions.changed",
        payload: {
          sessionKey: "agent:main:remote-change",
          agentId: "main",
          reason: "archive",
          ...payload,
        },
      };
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    publishAgentRoster: (agentIds: string[] | null) => {
      agentsState.agentsList = agentIds
        ? {
            defaultId: "main",
            mainKey: "main",
            scope: "global",
            agents: agentIds.map((id) => ({ id })),
          }
        : null;
      for (const listener of agentListeners) {
        listener(agentsState as ApplicationContext["agents"]["state"]);
      }
    },
  };
}

describe("filtered sidebar session event refresh", () => {
  it.each(["active", "archived", "all"] as const)(
    "keeps membership in the displayed %s query across refresh, pagination, and agent changes",
    async (statusFilter) => {
      vi.useFakeTimers();
      const {
        controller,
        list,
        selectMembership,
        selectAgent,
        selectStatusFilter,
        reconnect,
        publishSessionChanged,
        // Membership keeps the odd-numbered half, so four roster pages of rows
        // leave two pages of matches -- enough that pagination is still real.
      } = createFilteredSessionController(statusFilter, SIDEBAR_SESSION_ROSTER_LIMIT * 4, true);
      const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
      controller.hostConnected();
      try {
        await selectMembership({ ownerId: null, involvingMe: true });
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize);
        expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ involvingMe: true }));
        expect(controller.sessionsResult?.sessions.every((row) => row.updatedAt! % 2 === 1)).toBe(
          true,
        );

        await controller.loadMoreSidebarSessions();
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize * 2);
        expect(list).toHaveBeenLastCalledWith(
          expect.objectContaining({ involvingMe: true, offset: pageSize }),
        );
        await controller.refreshSidebarSessions();
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize * 2);

        list.mockClear();
        publishSessionChanged();
        await vi.advanceTimersByTimeAsync(200);
        expect(list.mock.calls.some(([query]) => query?.involvingMe === true)).toBe(true);
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize * 2);

        list.mockClear();
        reconnect();
        await controller.refreshSidebarSessions();
        expect(list.mock.calls.some(([query]) => query?.involvingMe === true)).toBe(true);
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize * 2);

        selectStatusFilter(statusFilter === "all" ? "archived" : "all");
        await controller.refreshSidebarSessions();
        expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ involvingMe: true }));
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize);

        selectAgent("research");
        await controller.refreshSidebarSessions();
        expect(list).toHaveBeenLastCalledWith(
          expect.objectContaining({ agentId: "research", involvingMe: true }),
        );
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize);

        await selectMembership({ ownerId: "profile-ada", involvingMe: false });
        expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ ownerId: "profile-ada" }));
        expect(list.mock.lastCall?.[0]?.involvingMe).toBeUndefined();
        expect(controller.sessionsResult?.sessions).toHaveLength(pageSize);

        await selectMembership({ ownerId: null, involvingMe: false });
        expect(list.mock.lastCall?.[0]?.ownerId).toBeUndefined();
        expect(list.mock.lastCall?.[0]?.involvingMe).toBeUndefined();
      } finally {
        controller.hostDisconnected();
      }
    },
  );
  it.each(["archived", "all"] as const)(
    "clears a recovered %s list failure without erasing a same-text action failure",
    async (statusFilter) => {
      const { controller, list, selectStatusFilter } =
        createFilteredSessionController(statusFilter);
      controller.hostConnected();
      list.mockRejectedValueOnce(new Error("Session request failed"));

      await controller.refreshSidebarSessions();

      expect(controller.sessionMutationError).toBe("Session request failed");

      await controller.refreshSidebarSessions();

      expect(controller.sessionMutationError).toBeNull();
      expect(controller.sessionsResult?.sessions).toHaveLength(1);

      list.mockRejectedValueOnce(new Error("Session request failed"));
      await controller.refreshSidebarSessions();

      const mutation = controller.beginSessionMutation();
      expect(mutation).not.toBeNull();
      controller.publishSessionMutationError(mutation!, new Error("Session request failed"));

      list.mockRejectedValueOnce(new Error("Background session list failed"));
      await controller.refreshSidebarSessions();
      expect(controller.sessionMutationError).toBe("Session request failed");

      await controller.refreshSidebarSessions();
      expect(controller.sessionMutationError).toBe("Session request failed");

      selectStatusFilter(statusFilter === "archived" ? "all" : "archived");
      expect(controller.sessionMutationError).toBe("Session request failed");

      controller.hostDisconnected();
      expect(controller.sessionMutationError).toBeNull();
    },
  );

  it.each(["archived", "all"] as const)(
    "retires the %s list failure when its selected filter changes",
    async (statusFilter) => {
      const { controller, list, selectStatusFilter } =
        createFilteredSessionController(statusFilter);
      controller.hostConnected();
      list.mockRejectedValueOnce(new Error("Retired session list failed"));

      await controller.refreshSidebarSessions();
      expect(controller.sessionMutationError).toBe("Retired session list failed");

      selectStatusFilter(statusFilter === "archived" ? "all" : "archived");

      expect(controller.sessionMutationError).toBeNull();
      controller.hostDisconnected();
    },
  );

  it("dismisses a filtered list failure without restoring it on recovery", async () => {
    const { controller, list } = createFilteredSessionController("archived");
    controller.hostConnected();
    list.mockRejectedValueOnce(new Error("Dismissed session list failed"));

    await controller.refreshSidebarSessions();
    expect(controller.sessionMutationError).toBe("Dismissed session list failed");

    controller.dismissSessionMutationError();
    expect(controller.sessionMutationError).toBeNull();

    await controller.refreshSidebarSessions();
    expect(controller.sessionMutationError).toBeNull();
    controller.hostDisconnected();
  });

  it("ignores a retired filter's delayed failure after the replacement scope binds", async () => {
    const { controller, list, selectStatusFilter } = createFilteredSessionController("archived");
    controller.hostConnected();
    // Retire an issued request, not a refresh still queued behind startup.
    await controller.refreshSidebarSessions();
    list.mockClear();
    let rejectList!: (error: Error) => void;
    const delayedList = new Promise<Awaited<ReturnType<typeof list>>>((_, reject) => {
      rejectList = reject;
    });
    list.mockImplementationOnce(async () => await delayedList);

    const retiredRefresh = controller.refreshSidebarSessions();
    expect(list).toHaveBeenCalledOnce();
    selectStatusFilter("all");
    rejectList(new Error("Retired archived request failed"));
    await retiredRefresh;

    expect(controller.sessionMutationError).toBeNull();
    controller.hostDisconnected();
  });

  it("evicts cached sessions when an agent leaves the authoritative roster", () => {
    const { controller, publishAgentRoster, resultForKeys } =
      createFilteredSessionController("all");
    controller.hostConnected();
    controller.sessionResultsByAgent = {
      main: resultForKeys(["agent:main:kept"]),
      research: resultForKeys(["agent:research:removed"]),
    };
    controller.sessionsResult = controller.sessionResultsByAgent.research ?? null;
    controller.sessionsAgentId = "research";

    publishAgentRoster(null);
    expect(Object.keys(controller.sessionResultsByAgent)).toEqual(["main", "research"]);

    publishAgentRoster(["main"]);
    expect(Object.keys(controller.sessionResultsByAgent)).toEqual(["main"]);
    expect(controller.sessionsResult).toBeNull();
    expect(controller.sessionsAgentId).toBeNull();
    controller.hostDisconnected();
  });

  it("retains the current canonical result outside the per-agent cache", () => {
    const { controller, publishAgentRoster, resultForKeys } =
      createFilteredSessionController("all");
    controller.hostConnected();
    controller.sessionsResult = resultForKeys(["agent:main:current"]);
    controller.sessionsAgentId = "main";

    publishAgentRoster(["main"]);

    expect(controller.sessionsAgentId).toBe("main");
    expect(controller.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "agent:main:current",
    ]);
    controller.hostDisconnected();
  });

  it.each(["archived", "all"] as const)(
    "refreshes the %s list once for duplicate remote session events",
    async (statusFilter) => {
      vi.useFakeTimers();
      const { controller, list, publishSessionChanged } =
        createFilteredSessionController(statusFilter);
      controller.hostConnected();
      await controller.refreshSidebarSessions();
      list.mockClear();

      publishSessionChanged();
      publishSessionChanged();
      await vi.advanceTimersByTimeAsync(199);
      expect(list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(list).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", archivedFilter: statusFilter }),
      );
      expect(controller.sessionsResult?.sessions[0]?.key).toBe("agent:main:remote-change");
      controller.hostDisconnected();
    },
  );

  it.each(["archived", "all"] as const)(
    "preserves every loaded %s page when a remote event replaces the list",
    async (statusFilter) => {
      vi.useFakeTimers();
      // Two full roster pages, so the retained window still spans a real append.
      const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
      const { controller, list, publishSessionChanged } = createFilteredSessionController(
        statusFilter,
        pageSize * 2,
      );
      controller.hostConnected();
      await controller.refreshSidebarSessions();
      expect(controller.sessionsResult?.sessions).toHaveLength(pageSize);

      await controller.loadMoreSidebarSessions();
      expect(controller.sessionsResult?.sessions).toHaveLength(pageSize * 2);
      list.mockClear();

      publishSessionChanged();
      await vi.advanceTimersByTimeAsync(200);

      expect(list).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          archivedFilter: statusFilter,
          includeLastMessage: true,
          limit: pageSize * 2,
        }),
      );
      expect(controller.sessionsResult?.sessions).toHaveLength(pageSize * 2);
      controller.hostDisconnected();
    },
  );

  it("ignores session changes belonging to another agent", async () => {
    vi.useFakeTimers();
    const { controller, list, publishSessionChanged } = createFilteredSessionController("all");
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    list.mockClear();

    publishSessionChanged({ sessionKey: "agent:research:remote-change", agentId: "research" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(list).not.toHaveBeenCalled();
    controller.hostDisconnected();
  });

  it("retires queued refreshes when the selected agent changes", async () => {
    vi.useFakeTimers();
    const { controller, list, publishSessionChanged, selectAgent } =
      createFilteredSessionController("archived");
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    list.mockClear();

    publishSessionChanged();
    selectAgent("research");
    list.mockClear();
    await vi.advanceTimersByTimeAsync(200);

    expect(list).not.toHaveBeenCalled();
    controller.hostDisconnected();
  });

  it("does not carry another filtered list's page depth across a filter change", async () => {
    // The archived list grows to two pages; switching filters must start over
    // at one page rather than inheriting that depth.
    const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
    const { controller, list, selectStatusFilter } = createFilteredSessionController(
      "archived",
      pageSize * 2,
    );
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    await controller.loadMoreSidebarSessions();
    expect(controller.sessionsResult?.sessions).toHaveLength(pageSize * 2);
    list.mockClear();

    selectStatusFilter("all");
    await controller.refreshSidebarSessions();

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", archivedFilter: "all", limit: pageSize }),
    );
    expect(controller.sessionsResult?.sessions).toHaveLength(pageSize);
    controller.hostDisconnected();
  });

  it("retires an in-flight child snapshot when the status filter changes", async () => {
    const { controller, list, selectStatusFilter } = createFilteredSessionController("archived");
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    let resolveChildPage!: (value: Awaited<ReturnType<typeof list>>) => void;
    const childPage = new Promise<Awaited<ReturnType<typeof list>>>((resolve) => {
      resolveChildPage = resolve;
    });
    list.mockImplementationOnce(async () => await childPage);

    const pendingChildren = controller.loadChildSessions("agent:main:parent");
    expect(controller.loadingChildSessionKeys.has("agent:main:parent")).toBe(true);

    selectStatusFilter("all");
    resolveChildPage({
      ts: 2,
      path: "",
      count: 1,
      totalCount: 1,
      nextOffset: null,
      hasMore: false,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "agent:main:stale-child", kind: "direct", updatedAt: 2 }],
    });
    await pendingChildren;

    expect(controller.childSessionRowsByParent).toEqual({});
    expect(controller.loadedChildSessionKeys.has("agent:main:parent")).toBe(false);
    expect(controller.loadingChildSessionKeys.has("agent:main:parent")).toBe(false);
    controller.hostDisconnected();
  });

  it("bounds refresh latency while same-agent events continue arriving", async () => {
    vi.useFakeTimers();
    const { controller, list, publishSessionChanged } = createFilteredSessionController("all");
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    list.mockClear();

    publishSessionChanged();
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(199);
      publishSessionChanged();
    }
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);

    expect(list).toHaveBeenCalledOnce();
    controller.hostDisconnected();
  });

  it("cancels a queued filtered refresh when its gateway subscription disconnects", async () => {
    vi.useFakeTimers();
    const { controller, list, publishSessionChanged } = createFilteredSessionController("archived");
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    list.mockClear();

    publishSessionChanged();
    controller.hostDisconnected();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(list).not.toHaveBeenCalled();
  });

  it("serializes duplicate session events while a filtered refresh is in flight", async () => {
    vi.useFakeTimers();
    const { controller, list, publishSessionChanged } = createFilteredSessionController("archived");
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    list.mockClear();
    let resolveFirstRefresh!: (value: Awaited<ReturnType<typeof list>>) => void;
    const firstRefresh = new Promise<Awaited<ReturnType<typeof list>>>((resolve) => {
      resolveFirstRefresh = resolve;
    });
    const refreshedPage = {
      ts: 2,
      path: "",
      count: 1,
      totalCount: 1,
      nextOffset: null,
      hasMore: false,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "agent:main:remote-change", kind: "direct" as const, updatedAt: 2 }],
    };
    list.mockImplementationOnce(async () => await firstRefresh).mockResolvedValue(refreshedPage);

    publishSessionChanged();
    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledOnce();

    publishSessionChanged();
    await Promise.resolve();
    publishSessionChanged();
    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledOnce();

    resolveFirstRefresh(refreshedPage);
    await vi.advanceTimersByTimeAsync(0);

    expect(list).toHaveBeenCalledTimes(2);
    expect(controller.sessionsResult?.sessions[0]?.updatedAt).toBe(2);
    controller.hostDisconnected();
  });
});
