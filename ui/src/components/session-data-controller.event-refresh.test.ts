// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createSessionCapability, type SessionCapability } from "../lib/sessions/index.ts";
import type { SessionDataControllerHost } from "./session-data-controller-catalog.ts";
import { SessionDataController } from "./session-data-controller.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createFilteredSessionController(statusFilter: "archived" | "all", rowCount = 1) {
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
    const sessions = rows.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < rows.length;
    return {
      ts: 1,
      path: "",
      count: sessions.length,
      totalCount: rows.length,
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
      if (!archived && !options.spawnedBy) {
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
  const gateway = {
    snapshot: {
      phase: "connected",
      client,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    },
    subscribe: () => () => undefined,
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as const;
  const sessions = createSessionCapability(gateway);
  let selectedAgentId = "main";
  let selectedStatusFilter = statusFilter;
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
    querySelector: () => null,
  } satisfies SessionDataControllerHost;
  const controller = new SessionDataController(host);

  return {
    controller,
    list,
    resultForKeys,
    selectAgent: (agentId: string) => {
      selectedAgentId = agentId;
      controller.synchronizeSessionScope();
    },
    selectStatusFilter: (nextStatusFilter: "archived" | "all") => {
      selectedStatusFilter = nextStatusFilter;
      controller.resetForStatusFilter(nextStatusFilter);
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
    controller.sessionCreatedOrder = new Map([
      ["agent:main:kept", 0],
      ["agent:research:removed", 1],
    ]);

    publishAgentRoster(null);
    expect(Object.keys(controller.sessionResultsByAgent)).toEqual(["main", "research"]);

    publishAgentRoster(["main"]);
    expect(Object.keys(controller.sessionResultsByAgent)).toEqual(["main"]);
    expect(controller.sessionsResult).toBeNull();
    expect(controller.sessionsAgentId).toBeNull();
    expect([...controller.sessionCreatedOrder.keys()]).toEqual(["agent:main:kept"]);
    controller.hostDisconnected();
  });

  it("retains the current canonical result outside the per-agent cache", () => {
    const { controller, publishAgentRoster, resultForKeys } =
      createFilteredSessionController("all");
    controller.hostConnected();
    controller.sessionsResult = resultForKeys(["agent:main:current"]);
    controller.sessionsAgentId = "main";
    controller.sessionCreatedOrder = new Map([["agent:main:current", 0]]);

    publishAgentRoster(["main"]);

    expect([...controller.sessionCreatedOrder.keys()]).toEqual(["agent:main:current"]);
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
      const { controller, list, publishSessionChanged } = createFilteredSessionController(
        statusFilter,
        120,
      );
      controller.hostConnected();
      await controller.refreshSidebarSessions();
      expect(controller.sessionsResult?.sessions).toHaveLength(60);

      await controller.loadMoreSidebarSessions();
      expect(controller.sessionsResult?.sessions).toHaveLength(120);
      list.mockClear();

      publishSessionChanged();
      await vi.advanceTimersByTimeAsync(200);

      expect(list).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          archivedFilter: statusFilter,
          includeLastMessage: true,
          limit: 120,
        }),
      );
      expect(controller.sessionsResult?.sessions).toHaveLength(120);
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
    const { controller, list, selectStatusFilter } = createFilteredSessionController(
      "archived",
      120,
    );
    controller.hostConnected();
    await controller.refreshSidebarSessions();
    await controller.loadMoreSidebarSessions();
    expect(controller.sessionsResult?.sessions).toHaveLength(120);
    list.mockClear();

    selectStatusFilter("all");
    await controller.refreshSidebarSessions();

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", archivedFilter: "all", limit: 60 }),
    );
    expect(controller.sessionsResult?.sessions).toHaveLength(60);
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
