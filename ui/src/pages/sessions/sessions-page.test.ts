/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import type { SessionsRouteData } from "./sessions-page.ts";
import "./sessions-page.ts";

type TestSessionsPage = HTMLElement & {
  context: ApplicationContext;
  render: () => unknown;
  requestUpdate: () => void;
  readonly updateComplete: Promise<boolean>;
  routeData?: SessionsRouteData;
  result: SessionsListResult | null;
  error: string | null;
  loading: boolean;
  selectedKeys: Set<string>;
  sessionMenu: { key: string; x: number; y: number } | null;
  sessionMenuTrigger: HTMLElement | null;
  checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  checkpointLoadingKey: string | null;
  checkpointBusyKey: string | null;
  sessionMutationPending: boolean;
  loadSessions: () => Promise<void>;
  loadCheckpoint: (sessionKey: string) => Promise<void>;
  deleteSelected: () => Promise<void>;
  deleteSessionFromMenu: (row: GatewaySessionRow) => Promise<void>;
  openSessionMenu: (
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) => void;
  patchSession: (key: string, patch: { archived?: boolean }) => Promise<void>;
  forkSession: (key: string) => Promise<void>;
  branchCheckpoint: (sessionKey: string, checkpointId: string) => Promise<void>;
  restoreCheckpoint: (sessionKey: string, checkpointId: string) => Promise<void>;
  addToWorkboard: (session: GatewaySessionRow) => Promise<void>;
};

type MutableGateway = {
  gateway: ApplicationContext["gateway"];
  emit: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  setSessionKey: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createGateway(client: GatewayBrowserClient): MutableGateway {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const setSessionKey = vi.fn();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    eventLog: [],
    setSessionKey,
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  return {
    gateway,
    setSessionKey,
    emit(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createSessions(overrides: Partial<SessionCapability> = {}): SessionCapability {
  const subscribe = () => () => undefined;
  return {
    state: {
      result: null,
      agentId: null,
      modelOverrides: {},
      loading: false,
      error: null,
      deletedSessions: [],
    },
    list: vi.fn(async () => null),
    listCheckpoints: vi.fn(async () => []),
    deleteMany: vi.fn(async () => ({ deleted: [], errors: [], preservedWorktrees: [] })),
    patch: vi.fn(async () => null),
    create: vi.fn(async () => null),
    branchCheckpoint: vi.fn(async () => ({ key: "branch" })),
    restoreCheckpoint: vi.fn(async () => ({ ok: true })),
    subscribe,
    ...overrides,
  } as unknown as SessionCapability;
}

function createContext(
  gateway: ApplicationContext["gateway"],
  sessions: SessionCapability,
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway,
    sessions,
    agents: { state: { agentsList: null }, subscribe },
    agentIdentity: { get: () => undefined, ensure: vi.fn(), subscribe },
    agentSelection: { state: { selectedId: "main" }, subscribe },
    channels: { subscribe },
    runtimeConfig: { state: { configSnapshot: null }, subscribe },
    workboard: {
      state: { cards: [], capturingSessionKeys: new Set() },
      notify: vi.fn(),
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(),
  } as unknown as ApplicationContext;
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
  vi.restoreAllMocks();
});

describe("sessions page lifecycle", () => {
  it("rejects preloaded data after a same-client reconnect and loads the current epoch", async () => {
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const preloadedSnapshot = mutableGateway.gateway.snapshot;
    mutableGateway.emit({ connected: false, client });
    mutableGateway.emit({ connected: true, client });
    const freshResult = { count: 1, sessions: [{ key: "fresh" }] } as SessionsListResult;
    const sessions = createSessions({ list: vi.fn(async () => freshResult) });
    const context = createContext(mutableGateway.gateway, sessions);
    const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
    page.context = context;
    page.render = () => nothing;
    page.routeData = {
      gateway: mutableGateway.gateway,
      gatewaySnapshot: preloadedSnapshot,
      result: { count: 1, sessions: [{ key: "stale" }] } as SessionsListResult,
      error: null,
      expandedSessionKey: null,
      showArchived: false,
    };

    document.body.append(page);
    await page.updateComplete;
    await vi.waitFor(() => expect(page.result?.sessions[0]?.key).toBe("fresh"));

    expect(sessions.list).toHaveBeenCalledOnce();
    expect(page.result?.sessions.map((session) => session.key)).toEqual(["fresh"]);
  });

  it("rejects session and checkpoint results after the sessions capability changes", async () => {
    const list = deferred<SessionsListResult | null>();
    const checkpoints = deferred<SessionCompactionCheckpoint[]>();
    const sessions = createSessions({
      list: vi.fn(() => list.promise),
      listCheckpoints: vi.fn(() => checkpoints.promise),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, sessions);
    const page = await createPage(context);

    const listRequest = page.loadSessions();
    const checkpointRequest = page.loadCheckpoint("main");
    await vi.waitFor(() => {
      expect(sessions.list).toHaveBeenCalledOnce();
      expect(sessions.listCheckpoints).toHaveBeenCalledOnce();
    });

    page.context = { ...context, sessions: createSessions() };
    page.requestUpdate();
    await page.updateComplete;
    list.resolve({ count: 1, sessions: [{ key: "stale" }] } as SessionsListResult);
    checkpoints.resolve([{ checkpointId: "stale" }] as SessionCompactionCheckpoint[]);
    await Promise.all([listRequest, checkpointRequest]);

    expect(page.result).toBeNull();
    expect(page.loading).toBe(false);
    expect(page.checkpointItemsByKey).toEqual({});
    expect(page.checkpointLoadingKey).toBeNull();
  });

  it("invalidates checkpoint work and mutation locks on same-client disconnect", async () => {
    const checkpoints = deferred<SessionCompactionCheckpoint[]>();
    const sessions = createSessions({
      listCheckpoints: vi.fn(() => checkpoints.promise),
    });
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    const request = page.loadCheckpoint("main");
    page.checkpointBusyKey = "busy";
    page.sessionMutationPending = true;

    mutableGateway.emit({ connected: false, client });

    expect(page.checkpointLoadingKey).toBeNull();
    expect(page.checkpointBusyKey).toBeNull();
    expect(page.sessionMutationPending).toBe(false);
    checkpoints.resolve([{ checkpointId: "stale" }] as SessionCompactionCheckpoint[]);
    await request;
    expect(page.checkpointItemsByKey).toEqual({});
  });

  it("closes an open row menu on a same-client disconnect", async () => {
    const sessions = createSessions();
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    const trigger = document.createElement("button");
    page.openSessionMenu(
      { key: "agent:main:work" } as GatewaySessionRow,
      { x: 10, y: 20 },
      trigger,
    );

    mutableGateway.emit({ connected: false, client });

    expect(page.sessionMenu).toBeNull();
    expect(page.sessionMenuTrigger).toBeNull();
  });

  it("retargets the Gateway after deleting the current session", async () => {
    const key = "agent:writer:work";
    const sessions = createSessions({
      deleteMany: vi.fn(async () => ({ deleted: [key], errors: [], preservedWorktrees: [] })),
    });
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    mutableGateway.emit({ sessionKey: key });
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    page.result = { count: 1, sessions: [{ key }] } as SessionsListResult;
    page.selectedKeys = new Set([key]);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await page.deleteSelected();

    expect(sessions.deleteMany).toHaveBeenCalledWith([{ key, agentId: undefined }]);
    expect(mutableGateway.setSessionKey).toHaveBeenCalledWith("agent:writer:main");
    expect(page.result?.sessions).toEqual([]);
    expect(page.selectedKeys).toEqual(new Set());
  });

  it("routes a confirmed row-menu deletion through the scoped bulk owner", async () => {
    const key = "agent:main:work";
    const sessions = createSessions({
      deleteMany: vi.fn(async () => ({ deleted: [key], errors: [], preservedWorktrees: [] })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, sessions));
    const row = { key, label: "Work" } as GatewaySessionRow;
    page.result = { count: 1, sessions: [row] } as SessionsListResult;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await page.deleteSessionFromMenu(row);

    expect(confirm).toHaveBeenCalledOnce();
    expect(sessions.deleteMany).toHaveBeenCalledWith([{ key, agentId: undefined }]);
    expect(page.result?.sessions).toEqual([]);
  });

  it("drops stale mutation state, errors, and navigation after disconnect", async () => {
    const deleted = deferred<{
      deleted: string[];
      errors: string[];
      preservedWorktrees: Array<{ id: string; branch: string; path: string }>;
    }>();
    const patched = deferred<unknown>();
    const forked = deferred<string | null>();
    const branched = deferred<{ key: string }>();
    const restored = deferred<unknown>();
    const captured = deferred<unknown>();
    const sessions = createSessions({
      deleteMany: vi.fn(() => deleted.promise),
      patch: vi.fn(() => patched.promise as never),
      create: vi.fn(() => forked.promise),
      branchCheckpoint: vi.fn(() => branched.promise as never),
      restoreCheckpoint: vi.fn(() => restored.promise as never),
    });
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({ messages: [] });
      }
      if (method === "workboard.cards.create") {
        return captured.promise;
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const context = createContext(mutableGateway.gateway, sessions);
    getWorkboardState(context.workboard).loaded = true;
    const page = await createPage(context);
    page.result = { count: 1, sessions: [{ key: "main" }] } as SessionsListResult;
    page.selectedKeys = new Set(["main"]);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const requests = [
      page.deleteSelected(),
      page.patchSession("main", { archived: true }),
      page.forkSession("main"),
      page.branchCheckpoint("main", "branch-checkpoint"),
      page.restoreCheckpoint("main", "restore-checkpoint"),
      page.addToWorkboard({ key: "main" } as GatewaySessionRow),
    ];
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("workboard.cards.create", expect.any(Object)),
    );

    mutableGateway.emit({ connected: false, client });
    deleted.resolve({ deleted: ["main"], errors: ["stale delete error"], preservedWorktrees: [] });
    patched.resolve({ ok: true });
    forked.resolve("forked");
    branched.resolve({ key: "branched" });
    restored.reject(new Error("stale restore error"));
    captured.reject(new Error("stale capture error"));
    await Promise.all(requests);

    expect(page.result?.sessions.map((row) => row.key)).toEqual(["main"]);
    expect(page.selectedKeys).toEqual(new Set(["main"]));
    expect(page.error).toBeNull();
    expect(page.sessionMutationPending).toBe(false);
    expect(page.checkpointBusyKey).toBeNull();
    expect(mutableGateway.setSessionKey).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate when a mutation completes after the page detaches", async () => {
    const forked = deferred<string | null>();
    const sessions = createSessions({ create: vi.fn(() => forked.promise) });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, sessions);
    const page = await createPage(context);

    const request = page.forkSession("main");
    page.remove();
    forked.resolve("detached-fork");
    await request;

    expect(context.navigate).not.toHaveBeenCalled();
  });
});
