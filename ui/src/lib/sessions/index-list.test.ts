import type {
  ControlModel,
  ControlModelSessionCatalogSnapshot,
} from "@openclaw/gateway-client/model";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

type ListParams = { archived?: true | "all"; limit?: number; offset?: number };

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
  it("uses the Control Model catalog snapshot without issuing a duplicate UI request", async () => {
    const refreshSessions = vi.fn(async (_options: unknown, query?: Record<string, unknown>) => {
      catalog = {
        ...catalog,
        status: "ready",
        query: query ?? {},
        ts: 42,
        path: "sessions.list",
        count: 1,
        sessions: [{ key: "agent:main:needle", kind: "direct" }],
        totalCount: 1,
        limitApplied: 5,
        offset: 20,
        nextOffset: null,
        hasMore: false,
        creators: [{ id: "human" }],
        defaults: { modelProvider: "test", model: "test", contextTokens: 1 },
        refreshedAt: 42,
        error: null,
      };
    });
    let catalog: ControlModelSessionCatalogSnapshot = {
      status: "idle",
      query: {},
      ts: null,
      path: null,
      count: 0,
      sessions: [],
      totalCount: 0,
      limitApplied: null,
      offset: null,
      nextOffset: null,
      hasMore: false,
      creators: [],
      defaults: null,
      refreshedAt: null,
      error: null,
    };
    const model = {
      getSnapshot: () => ({
        revision: 1,
        lifecycle: "running",
        connection: { status: "connected", epoch: 1 },
        sessionCatalog: catalog,
      }),
      subscribe: () => () => undefined,
      start: vi.fn(),
      refreshSessions,
      conversation: vi.fn(),
      releaseConversation: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as ControlModel;
    const request = vi.fn(async () => {
      throw new Error("the UI must not issue the canonical request");
    });
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      phase: "connected" as const,
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: null,
    };
    const sessions = createSessionCapability({
      snapshot,
      controlModel: model,
      loadControlModelCatalog: async () => model,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    const options = { agentId: "main", search: "needle", offset: 20, limit: 5 };
    await sessions.refresh(options);
    await sessions.refresh(options);
    expect(refreshSessions).toHaveBeenCalledOnce();
    expect(refreshSessions).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        agentId: "main",
        search: "needle",
        offset: 20,
        limit: 5,
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
      }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:needle");
    expect(sessions.state.result?.defaults.model).toBe("test");
    expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:needle");
    sessions.dispose();
  });

  it("uses the Gateway to refresh a visible roster larger than the model page bound", async () => {
    let catalog: ControlModelSessionCatalogSnapshot = {
      status: "idle",
      query: {},
      ts: null,
      path: null,
      count: 0,
      sessions: [],
      totalCount: 0,
      limitApplied: null,
      offset: null,
      nextOffset: null,
      hasMore: false,
      creators: [],
      defaults: null,
      refreshedAt: null,
      error: null,
    };
    const refreshSessions = vi.fn(async (_options: unknown, query?: Record<string, unknown>) => {
      const offset = typeof query?.offset === "number" ? query.offset : 0;
      const sessions = Array.from({ length: 1_000 }, (_, index) => ({
        key: `agent:main:model-${offset + index}`,
        kind: "direct" as const,
      }));
      catalog = {
        ...catalog,
        status: "ready",
        query: query ?? {},
        count: sessions.length,
        sessions,
        totalCount: 2_000,
        offset,
        nextOffset: offset === 0 ? 1_000 : null,
        hasMore: offset === 0,
        refreshedAt: offset + 1,
      };
    });
    const model = {
      getSnapshot: () => ({
        revision: 1,
        lifecycle: "running",
        connection: { status: "connected", epoch: 1 },
        sessionCatalog: catalog,
      }),
      subscribe: () => () => undefined,
      start: vi.fn(),
      refreshSessions,
      conversation: vi.fn(),
      releaseConversation: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as ControlModel;
    const request = vi.fn(async (_method: string, params?: ListParams) => {
      const limit = params?.limit ?? 50;
      return listResult(Array.from({ length: limit }, (_, index) => `agent:main:gateway-${index}`));
    });
    const sessions = createSessionCapability({
      snapshot: {
        client: { request } as unknown as GatewayBrowserClient,
        phase: "connected",
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: null,
      },
      controlModel: model,
      loadControlModelCatalog: async () => model,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await sessions.refresh({ agentId: "main", limit: 1_000, force: true });
    await sessions.refresh({
      agentId: "main",
      limit: 1_000,
      offset: 1_000,
      append: true,
      force: true,
    });
    expect(sessions.state.result?.sessions).toHaveLength(2_000);

    await sessions.refresh({ agentId: "main", limit: 2_000, force: true });

    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main", limit: 2_000 }),
    );
    expect(refreshSessions).toHaveBeenCalledTimes(2);
    expect(sessions.state.result?.sessions).toHaveLength(2_000);
    sessions.dispose();
  });

  it("falls back to sessions.list when the Control Model chunk fails to load", async () => {
    let eventListener: ((event: { event: string; payload: unknown }) => void) | undefined;
    let modelLoadAttempts = 0;
    const request = vi.fn(async () => listResult(["agent:main:fallback"]));
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      phase: "connected" as const,
      sessionKey: "agent:main:fallback",
      assistantAgentId: "main",
      hello: null,
    };
    const sessions = createSessionCapability({
      snapshot,
      loadControlModelCatalog: async () => {
        modelLoadAttempts += 1;
        throw new Error("chunk failed");
      },
      subscribe: () => () => undefined,
      subscribeEvents(listener) {
        eventListener = listener;
        return () => undefined;
      },
    });

    await sessions.refresh({ agentId: "main" });

    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main" }),
    );
    expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:fallback");

    eventListener?.({
      event: "sessions.changed",
      payload: { agentId: "main", reason: "update", sessionKey: "agent:main:fallback" },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(modelLoadAttempts).toBe(2);

    sessions.dispose();
  });

  it("refreshes the primary archived roster through the Gateway when the model is loaded", async () => {
    let eventListener: ((event: { event: string; payload: unknown }) => void) | undefined;
    let archivedRequests = 0;
    const request = vi.fn(async (_method: string, params?: ListParams) => {
      if (params?.archived === true) {
        archivedRequests += 1;
        return listResult([`agent:main:archived-${archivedRequests}`]);
      }
      return listResult(["agent:main:active"]);
    });
    const model = {
      getSnapshot: () => ({
        revision: 1,
        lifecycle: "running",
        connection: { status: "connected", epoch: 1 },
        sessionCatalog: {
          status: "ready",
          query: {},
          ts: 1,
          path: "sessions.list",
          count: 1,
          sessions: [{ key: "agent:main:active", kind: "direct" }],
          totalCount: 1,
          limitApplied: 50,
          offset: null,
          nextOffset: null,
          hasMore: false,
          creators: [],
          defaults: null,
          refreshedAt: 1,
          error: null,
        },
      }),
      subscribe: () => () => undefined,
      start: vi.fn(),
      refreshSessions: vi.fn(async () => undefined),
      conversation: vi.fn(),
      releaseConversation: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as ControlModel;
    const sessions = createSessionCapability({
      snapshot: {
        client: { request } as unknown as GatewayBrowserClient,
        phase: "connected",
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: null,
      },
      controlModel: model,
      loadControlModelCatalog: async () => model,
      subscribe: () => () => undefined,
      subscribeEvents(listener) {
        eventListener = listener;
        return () => undefined;
      },
    });

    await sessions.refresh({ agentId: "main", archivedFilter: "archived" });
    eventListener?.({
      event: "sessions.changed",
      payload: { agentId: "main", reason: "update", sessionKey: "agent:main:archived-1" },
    });

    await vi.waitFor(() => expect(archivedRequests).toBe(2));
    expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:archived-2");
    sessions.dispose();
  });

  it("keeps local create, reconcile, and run-terminal results when the model owns events", async () => {
    const key = "agent:main:created";
    let catalog: ControlModelSessionCatalogSnapshot = {
      status: "idle",
      query: {},
      ts: null,
      path: null,
      count: 0,
      sessions: [],
      totalCount: 0,
      limitApplied: null,
      offset: null,
      nextOffset: null,
      hasMore: false,
      creators: [],
      defaults: null,
      refreshedAt: null,
      error: null,
    };
    const dispose = vi.fn();
    const model = {
      getSnapshot: () => ({
        revision: 1,
        lifecycle: "running",
        connection: { status: "connected", epoch: 1 },
        sessionCatalog: catalog,
      }),
      subscribe: () => () => undefined,
      start: vi.fn(),
      refreshSessions: vi.fn(async (_options: unknown, query?: Record<string, unknown>) => {
        catalog = {
          ...catalog,
          status: "ready",
          query: query ?? {},
          ts: 1,
          path: "sessions.list",
          count: 1,
          sessions: [
            {
              key,
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: true,
              activeRunIds: ["run-created"],
              status: "running",
              startedAt: 10,
            },
          ],
          totalCount: 1,
          limitApplied: 50,
          offset: null,
          nextOffset: null,
          hasMore: false,
          creators: [],
          defaults: { modelProvider: null, model: null, contextTokens: null },
          refreshedAt: 1,
          error: null,
        };
      }),
      conversation: vi.fn(),
      releaseConversation: vi.fn(async () => undefined),
      dispose,
    } as unknown as ControlModel;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { key };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const sessions = createSessionCapability({
      snapshot: {
        client: { request } as unknown as GatewayBrowserClient,
        phase: "connected",
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: null,
      },
      controlModel: model,
      loadControlModelCatalog: async () => model,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await expect(sessions.createResult({ agentId: "main" })).resolves.toMatchObject({ key });
    expect(
      sessions.reconcile({
        key,
        kind: "direct",
        updatedAt: 20,
        label: "local result",
        hasActiveRun: true,
        activeRunIds: ["run-created"],
        status: "running",
        startedAt: 10,
      }),
    ).toBe(true);
    expect(sessions.state.result?.sessions[0]).toMatchObject({ label: "local result" });
    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: [key],
        runId: "run-created",
        status: "done",
        endedAt: 20,
      }),
    ).toBe(true);
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: "done",
      endedAt: 20,
    });

    sessions.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not reinsert an active current row into a foreground model-filtered roster", async () => {
    const currentKey = "agent:main:current";
    let catalog: ControlModelSessionCatalogSnapshot = {
      status: "idle",
      query: {},
      ts: null,
      path: null,
      count: 0,
      sessions: [],
      totalCount: 0,
      limitApplied: null,
      offset: null,
      nextOffset: null,
      hasMore: false,
      creators: [],
      defaults: null,
      refreshedAt: null,
      error: null,
    };
    const model = {
      getSnapshot: () => ({
        revision: 1,
        lifecycle: "running",
        connection: { status: "connected", epoch: 1 },
        sessionCatalog: catalog,
      }),
      subscribe: () => () => undefined,
      start: vi.fn(),
      refreshSessions: vi.fn(async (_options: unknown, query?: Record<string, unknown>) => {
        const searching = typeof query?.search === "string";
        catalog = {
          ...catalog,
          status: "ready",
          query: query ?? {},
          ts: 1,
          path: "sessions.list",
          count: 1,
          sessions: [
            searching
              ? { key: "agent:main:matched", kind: "direct", updatedAt: 2 }
              : { key: currentKey, kind: "direct", updatedAt: 1 },
          ],
          totalCount: 1,
          limitApplied: 50,
          offset: null,
          nextOffset: null,
          hasMore: false,
          creators: [],
          defaults: { modelProvider: null, model: null, contextTokens: null },
          refreshedAt: 1,
          error: null,
        };
      }),
      conversation: vi.fn(),
      releaseConversation: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as ControlModel;
    const sessions = createSessionCapability({
      snapshot: {
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        phase: "connected",
        sessionKey: currentKey,
        assistantAgentId: "main",
        hello: null,
      },
      controlModel: model,
      loadControlModelCatalog: async () => model,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await sessions.refresh({ agentId: "main" });
    await sessions.list({ agentId: "main", search: "matched", force: true } as never);
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([currentKey]);

    await sessions.refresh({ agentId: "main", search: "matched", force: true });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(["agent:main:matched"]);

    await sessions.refresh({ agentId: "main", force: true });
    await sessions.refresh({ agentId: "main", search: "matched", backgroundHydrate: true });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
      "agent:main:matched",
      currentKey,
    ]);
    sessions.dispose();
  });

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
      limit: 50,
    });
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
    const archivedScope = { agentId: "main", archivedFilter: "archived" as const };
    const allScope = { agentId: "main", archivedFilter: "all" as const };
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

  it("refreshes subscribed archived lists after a terminal message event", async () => {
    let eventListener: ((event: { event: string; payload: unknown }) => void) | undefined;
    let archivedRequests = 0;
    const request = vi.fn(async (_method: string, params?: ListParams) => {
      if (params?.archived === true) {
        archivedRequests += 1;
        return listResult([`agent:main:archived-${archivedRequests}`]);
      }
      return listResult(["agent:main:active"]);
    });
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      phase: "connected" as const,
      sessionKey: "agent:main:active",
      assistantAgentId: "main",
      hello: null,
    };
    const sessions = createSessionCapability({
      snapshot,
      subscribe: () => () => undefined,
      subscribeEvents(listener) {
        eventListener = listener;
        return () => undefined;
      },
      loadControlModelCatalog: async () =>
        ({
          getSnapshot: () => ({
            lifecycle: "running",
            connection: { status: "connected", epoch: 1 },
            sessionCatalog: { status: "idle" },
          }),
          subscribe: () => () => undefined,
        }) as unknown as ControlModel,
    });
    const archivedScope = { agentId: "main", archivedFilter: "archived" as const };
    const unsubscribe = sessions.subscribeList(archivedScope, () => undefined);
    await sessions.refreshList(archivedScope);

    eventListener?.({
      event: "session.message",
      payload: {
        agentId: "main",
        sessionKey: "agent:main:archived-1",
        hasActiveRun: false,
        status: "done",
      },
    });
    await vi.waitFor(() => expect(archivedRequests).toBe(2));

    expect(sessions.listSnapshot(archivedScope).result?.sessions[0]?.key).toBe(
      "agent:main:archived-2",
    );
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
