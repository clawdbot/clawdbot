/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCompactionCheckpoint, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function createPage(context: ApplicationContext): Promise<TestSessionsPage> {
  const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
  page.context = context;
  page.render = () => nothing;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("sessions page managed roster", () => {
  it("rejects route data from an earlier same-client connection epoch", async () => {
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const staleGatewaySnapshot = mutableGateway.gateway.snapshot;
    const refresh = deferred<void>();
    const refreshList = vi.fn(() => refresh.promise);
    const managed = createManagedSessions({ refreshList });
    const context = createContext(mutableGateway.gateway, managed.sessions);
    const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
    page.context = context;
    page.render = () => nothing;
    page.routeData = {
      gateway: mutableGateway.gateway,
      gatewaySnapshot: staleGatewaySnapshot,
      sessions: managed.sessions,
      result: { count: 1, sessions: [{ key: "stale" }] } as SessionsListResult,
      loading: false,
      error: null,
      expandedSessionKey: null,
      statusFilter: "active",
    };

    mutableGateway.emit({ phase: "reconnecting", client });
    mutableGateway.emit({ phase: "connected", client, hello: sessionMutationGatewayHello() });
    document.body.append(page);
    await page.updateComplete;
    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledOnce());

    expect(page.result).toBeNull();
    const query = vi.mocked(managed.subscribeList).mock.calls[0]?.[0];
    if (!query) {
      throw new Error("Expected the current managed query subscription");
    }
    managed.publish(query, {
      result: { count: 1, sessions: [{ key: "current" }] } as SessionsListResult,
      agentId: "main",
      loading: false,
      error: null,
    });
    refresh.resolve();

    await vi.waitFor(() => expect(page.result?.sessions[0]?.key).toBe("current"));
  });

  it("preserves rows across a same-client reconnect and adopts the refreshed managed list", async () => {
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const managed = createManagedSessions();
    const context = createContext(mutableGateway.gateway, managed.sessions);
    const staleResult = { count: 1, sessions: [{ key: "stale" }] } as SessionsListResult;
    const freshResult = { count: 1, sessions: [{ key: "fresh" }] } as SessionsListResult;
    const page = await createRenderedPage(context, staleResult);
    const query = vi.mocked(managed.subscribeList).mock.calls[0]?.[0];
    if (!query) {
      throw new Error("Expected the Sessions page to subscribe to its managed query");
    }

    mutableGateway.emit({ phase: "reconnecting", client });
    expect(page.result?.sessions.map((row) => row.key)).toEqual(["stale"]);
    mutableGateway.emit({ phase: "connected", client });
    managed.publish(query, { result: freshResult, agentId: "main", loading: false, error: null });

    await vi.waitFor(() => expect(page.result?.sessions.map((row) => row.key)).toEqual(["fresh"]));
  });

  it("retires the old managed listener and checkpoint work after capability replacement", async () => {
    const checkpoints = deferred<SessionCompactionCheckpoint[]>();
    const previous = createManagedSessions({
      listCheckpoints: vi.fn(() => checkpoints.promise),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, previous.sessions);
    const page = await createRenderedPage(context, {
      count: 1,
      sessions: [{ key: "previous" }],
    } as SessionsListResult);
    const previousQuery = vi.mocked(previous.subscribeList).mock.calls[0]?.[0];
    if (!previousQuery) {
      throw new Error("Expected the previous capability subscription");
    }

    const checkpointRequest = page.loadCheckpoint("main");
    await vi.waitFor(() => expect(previous.sessions.listCheckpoints).toHaveBeenCalledOnce());

    const replacement = createManagedSessions();
    page.context = { ...context, sessions: replacement.sessions };
    page.requestUpdate();
    await page.updateComplete;
    previous.publish(previousQuery, {
      result: { count: 1, sessions: [{ key: "stale" }] } as SessionsListResult,
      agentId: "main",
      loading: false,
      error: null,
    });
    checkpoints.resolve([{ checkpointId: "stale" }] as SessionCompactionCheckpoint[]);
    await checkpointRequest;

    expect(page.result).toBeNull();
    expect(page.loading).toBe(false);
    expect(page.checkpointItemsByKey).toEqual({});
    expect(page.checkpointLoadingKey).toBeNull();
  });

  it("switches exact managed queries for selected and all-agent scopes", async () => {
    const managed = createManagedSessions();
    const context = createContext(
      createGateway({} as GatewayBrowserClient).gateway,
      managed.sessions,
    );
    let notifyScopeChange: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0] = () =>
      undefined;
    context.agentSelection.subscribe = (listener) => {
      notifyScopeChange = listener;
      return () => undefined;
    };
    const page = await createPage(context);
    await vi.waitFor(() => expect(managed.subscribeList).toHaveBeenCalledOnce());
    const selectedQuery = vi.mocked(managed.subscribeList).mock.calls[0]?.[0];
    expect(selectedQuery).toEqual({
      limit: 50,
      includeGlobal: true,
      includeUnknown: false,
      includeDerivedTitles: false,
      includeLastMessage: false,
      archivedFilter: "active",
      agentId: "main",
    });

    context.agentSelection.state.scopeId = null;
    notifyScopeChange(context.agentSelection.state);
    await vi.waitFor(() => expect(managed.subscribeList).toHaveBeenCalledTimes(2));
    const allAgentsQuery = vi.mocked(managed.subscribeList).mock.calls[1]?.[0];
    expect(allAgentsQuery).toEqual(expect.not.objectContaining({ agentId: expect.anything() }));

    if (!selectedQuery || !allAgentsQuery) {
      throw new Error("Expected both managed query scopes");
    }
    managed.publish(selectedQuery, {
      result: { count: 1, sessions: [{ key: "retired" }] } as SessionsListResult,
      agentId: "main",
      loading: false,
      error: null,
    });
    managed.publish(allAgentsQuery, {
      result: { count: 1, sessions: [{ key: "current" }] } as SessionsListResult,
      agentId: null,
      loading: false,
      error: null,
    });
    await vi.waitFor(() => expect(page.result?.sessions[0]?.key).toBe("current"));
  });

  it("keeps last-good rows while a managed refresh loads and fails", async () => {
    const managed = createManagedSessions();
    const context = createContext(
      createGateway({} as GatewayBrowserClient).gateway,
      managed.sessions,
    );
    const result = { count: 1, sessions: [{ key: "last-good" }] } as SessionsListResult;
    const page = await createRenderedPage(context, result);
    const query = vi.mocked(managed.subscribeList).mock.calls[0]?.[0];
    if (!query) {
      throw new Error("Expected a managed query subscription");
    }

    managed.publish(query, { result, agentId: "main", loading: true, error: null });
    expect(page.loading).toBe(true);
    expect(page.result?.sessions.map((row) => row.key)).toEqual(["last-good"]);

    managed.publish(query, {
      result,
      agentId: "main",
      loading: false,
      error: "managed refresh failed",
    });
    expect(page.loading).toBe(false);
    expect(page.error).toBe("managed refresh failed");
    expect(page.result?.sessions.map((row) => row.key)).toEqual(["last-good"]);
  });

  it("reconciles checkpoint caches only when the managed result pointer changes", async () => {
    const key = "agent:main:checkpointed";
    const checkpoint = (checkpointId: string): SessionCompactionCheckpoint => ({
      checkpointId,
      sessionKey: key,
      sessionId: `session-${checkpointId}`,
      createdAt: checkpointId === "old" ? 1 : 2,
      reason: "manual",
      preCompaction: { sessionId: `pre-${checkpointId}` },
      postCompaction: { sessionId: `post-${checkpointId}` },
    });
    const oldCheckpoint = checkpoint("old");
    const newCheckpoint = checkpoint("new");
    const listCheckpoints = vi.fn(async () => [newCheckpoint]);
    const managed = createManagedSessions({ listCheckpoints });
    const context = createContext(
      createGateway({} as GatewayBrowserClient).gateway,
      managed.sessions,
    );
    const initialResult = {
      count: 1,
      sessions: [
        {
          key,
          compactionCheckpointCount: 1,
          latestCompactionCheckpoint: { checkpointId: "old" },
        },
      ],
    } as SessionsListResult;
    const page = await createRenderedPage(context, initialResult, "active", key);
    await vi.waitFor(() => expect(listCheckpoints).toHaveBeenCalled());
    listCheckpoints.mockClear();
    page.checkpointItemsByKey = { [key]: [oldCheckpoint] };
    const query = vi.mocked(managed.subscribeList).mock.calls[0]?.[0];
    if (!query) {
      throw new Error("Expected a managed query subscription");
    }

    managed.publish(query, { result: initialResult, agentId: "main", loading: true, error: null });
    expect(listCheckpoints).not.toHaveBeenCalled();
    managed.publish(query, {
      result: {
        count: 1,
        sessions: [
          {
            key,
            compactionCheckpointCount: 2,
            latestCompactionCheckpoint: { checkpointId: "new" },
          },
        ],
      } as SessionsListResult,
      agentId: "main",
      loading: false,
      error: null,
    });

    await vi.waitFor(() => expect(listCheckpoints).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(page.checkpointItemsByKey[key]).toEqual([newCheckpoint]));
  });

  it("adopts a managed snapshot that arrives under the bulk-delete lock after its tail refresh", async () => {
    const deleted = deferred<{
      deleted: string[];
      errors: string[];
      preservedWorktrees: Array<{ id: string; branch: string; path: string }>;
    }>();
    const deleteMany = vi.fn(() => deleted.promise);
    const managed = createManagedSessions({ deleteMany });
    const context = createContext(
      createGateway({} as GatewayBrowserClient).gateway,
      managed.sessions,
    );
    const page = await createRenderedPage(context, {
      count: 1,
      sessions: [{ key: "before" }],
    } as SessionsListResult);
    const query = vi.mocked(managed.subscribeList).mock.calls[0]?.[0];
    if (!query) {
      throw new Error("Expected a managed query subscription");
    }
    managed.refreshList.mockClear();
    page.selectedKeys = new Set(["before"]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    const deleting = page.deleteSelected();
    await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledOnce());
    const duringResult = {
      count: 1,
      sessions: [{ key: "arrived-during-mutation" }],
    } as SessionsListResult;
    managed.publish(query, {
      result: duringResult,
      agentId: "main",
      loading: false,
      error: null,
    });
    expect(page.result?.sessions.map((row) => row.key)).toEqual(["before"]);

    deleted.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
    await deleting;

    expect(managed.refreshList).toHaveBeenCalledWith({ ...query, force: true });
    expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      managed.refreshList.mock.invocationCallOrder[0]!,
    );
    expect(page.result?.sessions.map((row) => row.key)).toEqual(["arrived-during-mutation"]);
  });
});
