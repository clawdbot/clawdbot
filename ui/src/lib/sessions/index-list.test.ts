import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

type ListParams = {
  agentId?: string;
  archived?: true | "all";
  boardFace?: "chat" | "dashboard";
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  limit?: number;
  offset?: number;
};

function listResult(keys: string[] = [], totalCount = keys.length, offset = 0): SessionsListResult {
  const nextOffset = offset + keys.length;
  return {
    ts: 1,
    path: "",
    count: keys.length,
    totalCount,
    hasMore: nextOffset < totalCount,
    nextOffset: nextOffset < totalCount ? nextOffset : null,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: keys.map((key, updatedAt) => ({ key, kind: "direct", updatedAt })),
  };
}

function sessionHarness(request: unknown) {
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  let listener: ((next: typeof snapshot) => void) | undefined;
  const sessions = createSessionCapability({
    snapshot,
    subscribe(next) {
      listener = next;
      return () => undefined;
    },
    subscribeEvents: () => () => undefined,
  });
  return {
    sessions,
    reconnect: () => {
      for (const phase of ["reconnecting", "connected"] as const) {
        snapshot.phase = phase;
        listener?.(snapshot);
      }
    },
  };
}

describe("session list requests", () => {
  it("forwards a trimmed parent key when listing child sessions", async () => {
    const request = vi.fn(async (_method: string, _params?: unknown) => listResult());
    const { sessions } = sessionHarness(request);
    const options = { agentId: "main", limit: 20, includeGlobal: false, includeUnknown: false };
    await sessions.list({ ...options, spawnedBy: "  agent:main:parent  " });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      ...options,
      configuredAgentsOnly: true,
      spawnedBy: "agent:main:parent",
    });
    sessions.dispose();
  });

  it("maps archived status filters to the tri-state wire contract", async () => {
    const request = vi.fn(async (_method: string, _params?: unknown) => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ archivedFilter: "active", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "archived", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "all", activeMinutes: 30 });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ activeMinutes: 30 });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("archived");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ archived: true });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("activeMinutes");
    expect(request.mock.calls[2]?.[1]).toMatchObject({ archived: "all" });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("activeMinutes");
    sessions.dispose();
  });

  it("forwards the server-side face filter", async () => {
    const request = vi.fn(async () => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ boardFace: "dashboard" });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      configuredAgentsOnly: true,
      boardFace: "dashboard",
      includeGlobal: true,
      includeUnknown: true,
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
    });
    sessions.dispose();
  });

  it("forwards the involving-me predicate", async () => {
    const request = vi.fn(async () => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ involvingMe: true });
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ involvingMe: true }),
    );
    sessions.dispose();
  });

  it("discards a list rejection from a retired same-client connection", async () => {
    let rejectStale!: (error: Error) => void;
    const staleRequest = new Promise<SessionsListResult>((_resolve, reject) => {
      rejectStale = reject;
    });
    const request = vi.fn(async () => staleRequest);
    const { sessions, reconnect } = sessionHarness(request);
    const retiredRequest = sessions.list({ boardFace: "dashboard" });
    reconnect();
    rejectStale(new Error("retired connection"));
    await expect(retiredRequest).resolves.toBeNull();
    sessions.dispose();
  });

  it("keeps filtered pages scoped without replacing the canonical active roster", async () => {
    const request = vi.fn(async (_method: string, params?: ListParams) => {
      const filter = params?.archived === true ? "archived" : params?.archived || "active";
      const offset = params?.offset ?? 0;
      const keys = Array.from({ length: 4 }, (_, index) => `agent:main:${filter}-${index}`);
      return listResult(keys.slice(offset, offset + (params?.limit ?? 50)), 4, offset);
    });
    const { sessions } = sessionHarness(request);
    const archivedScope = { agentId: "main", archivedFilter: "archived" as const, limit: 2 };
    const allScope = { agentId: "main", archivedFilter: "all" as const, limit: 1 };
    const observeSnapshot = vi.fn();
    const unsubscribe = sessions.subscribeList(archivedScope, observeSnapshot);
    await sessions.refreshList({ agentId: "main", limit: 1, force: true });
    const activeResult = sessions.state.result;
    await sessions.refreshList({ ...archivedScope, limit: 2 });
    await sessions.refreshList({ ...archivedScope, limit: 2, offset: 2, append: true });
    await sessions.refreshList({ ...allScope, limit: 1 });
    await sessions.refreshList({ ...archivedScope, limit: 2 });
    expect(request).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main", archived: true, limit: 4 }),
    );
    expect(sessions.listSnapshot(archivedScope).result?.sessions).toHaveLength(4);
    expect(sessions.listSnapshot(allScope).result?.sessions).toHaveLength(1);
    expect(sessions.state.result).toBe(activeResult);
    expect(sessions.canonicalListRevision).toBe(1);
    expect(observeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ loading: true }));
    unsubscribe();
    sessions.dispose();
  });

  it("coalesces concurrent managed-list demand while preserving later forced refreshes", async () => {
    let resolveRequest!: (result: SessionsListResult) => void;
    const pendingResult = new Promise<SessionsListResult>((resolve) => {
      resolveRequest = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => pendingResult)
      .mockResolvedValue(listResult(["agent:main:refreshed"]));
    const { sessions } = sessionHarness(request);
    const query = { agentId: "main", archivedFilter: "all" as const, limit: 50 };
    const unsubscribe = sessions.subscribeList(query, () => undefined);

    try {
      const first = sessions.refreshList(query);
      const duplicate = sessions.refreshList(query);
      expect(duplicate).toBe(first);
      expect(request).toHaveBeenCalledOnce();

      resolveRequest(listResult(["agent:main:initial"]));
      await Promise.all([first, duplicate]);
      expect(request).toHaveBeenCalledOnce();

      await sessions.refreshList({ ...query, force: true });
      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:refreshed");
    } finally {
      resolveRequest(listResult());
      unsubscribe();
      sessions.dispose();
    }
  });

  it.each([
    { description: "archived", query: { archivedFilter: "archived" as const } },
    { description: "all", query: { archivedFilter: "all" as const } },
    { description: "dashboard", query: { boardFace: "dashboard" as const } },
    { description: "involving-me", query: { involvingMe: true as const } },
  ])(
    "honors a forced $description refresh requested during an existing load",
    async ({ query }) => {
      let resolveRequest!: (result: SessionsListResult) => void;
      const pendingResult = new Promise<SessionsListResult>((resolve) => {
        resolveRequest = resolve;
      });
      const request = vi
        .fn()
        .mockImplementationOnce(async () => pendingResult)
        .mockResolvedValue(listResult(["agent:main:current"]));
      const { sessions } = sessionHarness(request);
      const scope = { agentId: "main", limit: 50, ...query };
      const unsubscribe = sessions.subscribeList(scope, () => undefined);

      try {
        const pending = sessions.refreshList(scope);
        const forced = sessions.refreshList({ ...scope, force: true });
        const repeated = sessions.refreshList({ ...scope, force: true });
        expect(forced).toBe(pending);
        expect(repeated).toBe(pending);

        resolveRequest(listResult(["agent:main:stale"]));
        await Promise.all([pending, forced, repeated]);

        expect(request).toHaveBeenCalledTimes(2);
        expect(sessions.listSnapshot(scope).result?.sessions[0]?.key).toBe("agent:main:current");
      } finally {
        resolveRequest(listResult());
        unsubscribe();
        sessions.dispose();
      }
    },
  );

  it("does not queue forced filtered pagination behind an in-flight replacement", async () => {
    let resolveRequest!: (result: SessionsListResult) => void;
    const pendingResult = new Promise<SessionsListResult>((resolve) => {
      resolveRequest = resolve;
    });
    const firstPage = listResult(["agent:main:first", "agent:main:second"], 4);
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockImplementationOnce(async () => pendingResult);
    const { sessions } = sessionHarness(request);
    const scope = { archivedFilter: "archived" as const, limit: 2 };
    const unsubscribe = sessions.subscribeList(scope, () => undefined);

    try {
      await sessions.refreshList(scope);
      const pending = sessions.refreshList({ ...scope, force: true });
      const append = sessions.refreshList({ ...scope, offset: 2, append: true, force: true });
      expect(append).toBe(pending);

      resolveRequest(firstPage);
      await Promise.all([pending, append]);

      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.listSnapshot(scope).result?.sessions).toEqual(firstPage.sessions);
    } finally {
      resolveRequest(firstPage);
      unsubscribe();
      sessions.dispose();
    }
  });

  it("retains an in-flight managed query while its route subscriber is replaced", async () => {
    let resolveRequest!: (result: SessionsListResult) => void;
    const pendingResult = new Promise<SessionsListResult>((resolve) => {
      resolveRequest = resolve;
    });
    const request = vi.fn(async () => pendingResult);
    const { sessions } = sessionHarness(request);
    const query = { agentId: "main", archivedFilter: "all" as const, limit: 50 };
    let unsubscribe = sessions.subscribeList(query, () => undefined);

    try {
      const first = sessions.refreshList(query);
      unsubscribe();
      unsubscribe = sessions.subscribeList(query, () => undefined);

      expect(sessions.listSnapshot(query).loading).toBe(true);
      const replacement = sessions.refreshList(query);
      expect(replacement).toBe(first);
      expect(request).toHaveBeenCalledOnce();

      resolveRequest(listResult(["agent:main:retained"]));
      await Promise.all([first, replacement]);
      expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:retained");
      expect(request).toHaveBeenCalledOnce();
    } finally {
      resolveRequest(listResult());
      unsubscribe();
      sessions.dispose();
    }
  });

  it("keeps dashboard and sidebar queries distinct without inventing a dashboard agent", async () => {
    const request = vi.fn(async (_method: string, params?: ListParams) =>
      listResult([
        params?.boardFace === "dashboard"
          ? "agent:main:dashboard-result"
          : "agent:main:sidebar-result",
      ]),
    );
    const { sessions } = sessionHarness(request);
    const dashboardQuery = {
      limit: 50,
      boardFace: "dashboard" as const,
      archivedFilter: "all" as const,
    };
    const sidebarQuery = {
      agentId: "main",
      limit: 60,
      includeDerivedTitles: true,
      includeLastMessage: true,
      archivedFilter: "all" as const,
    };
    const stopDashboard = sessions.subscribeList(dashboardQuery, () => undefined);
    const stopSidebar = sessions.subscribeList(sidebarQuery, () => undefined);

    await sessions.refreshList({
      ...dashboardQuery,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
      force: true,
    });
    await sessions.refreshList({ ...sidebarQuery, force: true });

    expect(sessions.listSnapshot(dashboardQuery).result?.sessions[0]?.key).toBe(
      "agent:main:dashboard-result",
    );
    expect(sessions.listSnapshot(sidebarQuery).result?.sessions[0]?.key).toBe(
      "agent:main:sidebar-result",
    );
    expect(request.mock.calls[0]?.[1]).toEqual({
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      limit: 50,
      archived: "all",
      boardFace: "dashboard",
    });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("agentId");
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      agentId: "main",
      archived: "all",
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 60,
    });
    stopDashboard();
    stopSidebar();
    sessions.dispose();
  });

  it("keeps explicit unenriched page queries independent from the primary roster", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(listResult(["agent:main:primary"]))
      .mockResolvedValueOnce(listResult(["agent:main:page"]));
    const { sessions } = sessionHarness(request);
    const pageQuery = {
      agentId: "main",
      limit: 50,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
    };
    const unsubscribe = sessions.subscribeList(pageQuery, () => undefined);

    await sessions.refreshList({ agentId: "main", limit: 50, force: true });
    const primaryResult = sessions.state.result;
    await sessions.refreshList({ ...pageQuery, force: true });

    expect(sessions.state.result).toBe(primaryResult);
    expect(sessions.listSnapshot(pageQuery).result?.sessions[0]?.key).toBe("agent:main:page");
    expect(request.mock.calls[1]?.[1]).toEqual({
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
    unsubscribe();
    sessions.dispose();
  });

  it("keeps involving-me queries independent from the primary roster", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(listResult(["agent:main:primary"]))
      .mockResolvedValueOnce(listResult(["agent:main:involving-me"]));
    const { sessions } = sessionHarness(request);
    const involvingMeQuery = {
      agentId: "main",
      limit: 50,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      involvingMe: true,
    };
    const unsubscribe = sessions.subscribeList(involvingMeQuery, () => undefined);

    await sessions.refreshList({ agentId: "main", limit: 50, force: true });
    const primaryResult = sessions.state.result;
    await sessions.refreshList({ ...involvingMeQuery, force: true });

    expect(sessions.state.result).toBe(primaryResult);
    expect(sessions.listSnapshot(involvingMeQuery).result?.sessions[0]?.key).toBe(
      "agent:main:involving-me",
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({ involvingMe: true });
    unsubscribe();
    sessions.dispose();
  });

  it("retires stale filtered snapshots across same-client reconnects without losing subscribers", async () => {
    let resolveStale!: (result: SessionsListResult) => void;
    const staleResult = new Promise<SessionsListResult>((resolve) => {
      resolveStale = resolve;
    });
    let archivedRequests = 0;
    const request = vi.fn(async (method: string, params?: { archived?: boolean }) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (params?.archived) {
        archivedRequests += 1;
        return archivedRequests === 1 ? staleResult : listResult(["agent:main:current"]);
      }
      return listResult(["agent:main:active"]);
    });
    const { sessions, reconnect } = sessionHarness(request);
    const scope = { agentId: "main", archivedFilter: "archived" as const };
    const observed: Array<string | null> = [];
    const unsubscribe = sessions.subscribeList(scope, (next) =>
      observed.push(next.result?.sessions[0]?.key ?? null),
    );
    const retiredRequest = sessions.refreshList(scope);
    reconnect();
    resolveStale(listResult(["agent:main:stale"]));
    await retiredRequest;
    await sessions.refreshList(scope);
    expect(sessions.listSnapshot(scope).result?.sessions[0]?.key).toBe("agent:main:current");
    expect(observed).toContain(null);
    expect(observed).toContain("agent:main:current");
    expect(observed).not.toContain("agent:main:stale");
    unsubscribe();
    sessions.dispose();
  });
});
