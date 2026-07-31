// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
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
  let eventListener: ((event: { event: string; payload: unknown }) => void) | undefined;
  const sessions = {
    state: {
      result: null,
      agentId: "main",
      modelOverrides: {},
      loading: false,
      error: null,
      deletedSessions: [],
      groups: [],
      sectionOrder: [],
    },
    canonicalListRevision: 1,
    subscribe: () => () => undefined,
    subscribeCreated: () => () => undefined,
    groupsLoad: () => Promise.resolve(),
    list,
  } as unknown as SessionCapability;
  const gateway = {
    snapshot: {
      phase: "connected",
      client: {} as GatewayBrowserClient,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    },
    subscribe: () => () => undefined,
    subscribeEvents(listener: (event: { event: string; payload: unknown }) => void) {
      eventListener = listener;
      return () => {
        eventListener = undefined;
      };
    },
  };
  const context = { gateway, sessions } as unknown as ApplicationContext;
  let selectedAgentId = "main";
  let selectedStatusFilter = statusFilter;
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
    selectAgent: (agentId: string) => {
      selectedAgentId = agentId;
    },
    selectStatusFilter: (nextStatusFilter: "archived" | "all") => {
      selectedStatusFilter = nextStatusFilter;
      controller.resetForStatusFilter(nextStatusFilter);
    },
    publishSessionChanged: (payload: Record<string, unknown> = {}) => {
      eventListener?.({
        event: "sessions.changed",
        payload: {
          sessionKey: "agent:main:remote-change",
          agentId: "main",
          reason: "archive",
          ...payload,
        },
      });
    },
  };
}

describe("filtered sidebar session event refresh", () => {
  it.each(["archived", "all"] as const)(
    "refreshes the %s list once for duplicate remote session events",
    async (statusFilter) => {
      vi.useFakeTimers();
      const { controller, list, publishSessionChanged } =
        createFilteredSessionController(statusFilter);
      controller.hostConnected();
      await Promise.resolve();
      await Promise.resolve();
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
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.sessionsResult?.sessions).toHaveLength(60);

      await controller.loadMoreSidebarSessions();
      expect(controller.sessionsResult?.sessions).toHaveLength(120);
      list.mockClear();

      publishSessionChanged();
      await vi.advanceTimersByTimeAsync(200);

      expect(list).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", archivedFilter: statusFilter, limit: 120 }),
      );
      expect(controller.sessionsResult?.sessions).toHaveLength(120);
      controller.hostDisconnected();
    },
  );

  it("ignores session changes belonging to another agent", async () => {
    vi.useFakeTimers();
    const { controller, list, publishSessionChanged } = createFilteredSessionController("all");
    controller.hostConnected();
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
    list.mockClear();

    publishSessionChanged();
    selectAgent("research");
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
    await Promise.resolve();
    await Promise.resolve();
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

  it("bounds refresh latency while same-agent events continue arriving", async () => {
    vi.useFakeTimers();
    const { controller, list, publishSessionChanged } = createFilteredSessionController("all");
    controller.hostConnected();
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
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
