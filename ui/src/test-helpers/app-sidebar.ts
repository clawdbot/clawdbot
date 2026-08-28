import { afterEach, beforeEach, vi } from "vitest";
import type {
  PreservedSessionWorktree,
  SessionCatalogPullRequestSummary,
  SessionsCatalogListResult,
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, SessionsListResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../app/context.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import type { ApplicationOverlays } from "../app/overlays-types.ts";
import type {
  SidebarWorkboardBoard,
  SidebarWorkboardRenderers,
} from "../components/app-sidebar-workboard.ts";
import type { SessionDataController } from "../components/session-data-controller.ts";
import type { SessionOrganizerController } from "../components/session-organizer-controller.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import {
  createSessionCapability,
  type SessionCapability,
  type SessionListOptions,
} from "../lib/sessions/index.ts";
import { reconcileSessionHistory } from "../lib/sessions/reconcile.ts";
import {
  createApplicationContextProvider,
  hiddenScopeUpgradeCapability,
} from "./application-context.ts";
import { gatewayHelloForMethods, SESSION_MUTATION_TEST_METHODS } from "./gateway-methods.ts";
import { createStorageMock } from "./storage.ts";

// The attention widget owns independent health RPC tests. Keep those requests
// out of sidebar client call-order assertions.
// Sidebar attention is inert in this harness; cover attention rendering in
// sidebar-attention.test.ts, not app-sidebar cases.
vi.mock("../components/sidebar-attention.ts", () => ({}));

export type SessionGroupMutationResult = Awaited<ReturnType<SessionCapability["groupsRename"]>>;
type SessionDeleteResult = Awaited<ReturnType<SessionCapability["delete"]>>;
type SessionState = SessionCapability["state"];
const sidebarSessionGatewayBindings = new WeakMap<
  SessionCapability,
  (gateway: ApplicationGateway) => void
>();

export type SidebarLifecycleState = HTMLElement & {
  basePath: string;
  hiddenSessionCatalogIds: ReadonlySet<string>;
  activeRouteId?: string;
  activeWorkboardBoardId: string;
  enabledRouteIds?: readonly NavigationRouteId[];
  connected: boolean;
  offline: boolean;
  restartPending: boolean;
  queuedOutboxCount: number;
  lastError: string | null;
  outboxAttentionCountForSession: (sessionKey: string) => number;
  hasSessionDraft: (sessionKey: string) => boolean;
  terminalAvailable: boolean;
  catalogOpenTarget: "viewer" | "terminal";
  canPairDevice: boolean;
  sidebarEntries: readonly string[];
  workboardBoards: readonly SidebarWorkboardBoard[];
  workboardBoardsReady: boolean;
  workboardRenderers?: SidebarWorkboardRenderers;
  sidebarLiveActivity: boolean;
  onUpdateSidebarEntries?: (entries: string[]) => void;
  pinnedAgentIds: readonly string[];
  readonly sessionOwnerFilterId: string | null;
  sessionKey: string;
  onNavigate: (
    routeId: string,
    options?: { pathname?: string; search?: string; hash?: string },
  ) => void;
  dismissTransientMenus: () => boolean;
  readonly sessionData: SessionDataController;
  readonly sessionOrganizer: SessionOrganizerController;
  listSessionGroupFolders(path?: string): Promise<{
    path: string;
    home: string;
    entries: Array<{ name: string; path: string; type: "directory" | "file" }>;
  }>;
  inspectSessionGroupRepository(path?: string): Promise<"git" | "not_git" | "unavailable">;
  requestUpdate: () => void;
  updateComplete: Promise<boolean>;
  updateAvailable: { currentVersion: string; latestVersion: string; channel: string } | null;
  updateBusy: boolean;
  canUpdate: boolean;
  onUpdate: () => void;
  refreshRequired: boolean;
  onRefresh: () => void;
  onRetryConnect?: () => void;
  onOpenNewSession?: (agentId: string, target?: { catalogId: string }) => void;
  variant: "panel" | "drawer";
};

export type LobsterPetElement = HTMLElement & {
  runOutcome: "ok" | "error" | "aborted";
};

export type TestSessionMenu = HTMLElement & {
  forkDisabled: boolean;
  forkFromLastCompleted: boolean;
  onAction: (action: { kind: "fork" }) => void;
  selectionCount: number;
  readonly updateComplete: Promise<boolean>;
};

export function createGatewayHarness(client: GatewayBrowserClient) {
  const originalRequest =
    typeof client.request === "function"
      ? (client.request.bind(client) as GatewayBrowserClient["request"])
      : undefined;
  // Custom-element registrations survive non-isolated test files, so real
  // attention health requests must not consume sidebar feature response mocks.
  client.request = <T = unknown>(
    ...args: Parameters<GatewayBrowserClient["request"]>
  ): Promise<T> => {
    const [method] = args;
    if (method === "cron.list") {
      return Promise.resolve({ jobs: [], total: 0 } as T);
    }
    if (method === "models.authStatus") {
      return Promise.resolve({ ts: 0, providers: [] } as T);
    }
    if (!originalRequest) {
      return Promise.reject(new Error(`Unexpected sidebar gateway request: ${method}`));
    }
    return originalRequest<T>(...args);
  };
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "openclaw.chat"]),
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: { event: string; payload: unknown }) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: {
      gatewayUrl: "ws://gateway.test",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    connectionRevision: 0,
    setSessionKey: () => undefined,
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener: (event: { event: string; payload: unknown }) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    updateSelfUser(
      patch: Partial<Omit<NonNullable<ApplicationGatewaySnapshot["selfUser"]>, "id">>,
    ) {
      if (!snapshot.selfUser) {
        return;
      }
      snapshot = { ...snapshot, selfUser: { ...snapshot.selfUser, ...patch } };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    publish(patch: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    publishEvent(event: string, payload: unknown) {
      for (const listener of eventListeners) {
        listener({ event, payload });
      }
    },
  };
}

export function createSessionState(agentId: string, keys: string[]): SessionState {
  const result = {
    ts: 1,
    path: "",
    count: keys.length,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: keys.map((key, index) => ({
      key,
      sessionId: `session:${key}`,
      kind: "direct" as const,
      updatedAt: index + 1,
    })),
  } satisfies SessionsListResult;
  return {
    result,
    agentId,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
    groups: [],
    groupSettings: [],
    sectionOrder: [],
  };
}

export function successfulSessionPatch(key: string) {
  return {
    ok: true as const,
    path: "",
    key,
    entry: { sessionId: key },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createSessionsHarness(agentId: string, keys: string[]) {
  let state = createSessionState(agentId, keys);
  let canonicalListRevision = 1;
  const listeners = new Set<(next: SessionState) => void>();
  const pullRequestSummaries = new Map<string, SessionCatalogPullRequestSummary>();
  const archiveVisibilityByKey = new Map<string, "pending" | "archived">();
  const groupsPut = vi.fn(() => Promise.resolve<SessionGroupMutationResult>("completed"));
  const groupsRename = vi.fn(() => Promise.resolve<SessionGroupMutationResult>("completed"));
  const groupsDelete = vi.fn(() => Promise.resolve<SessionGroupMutationResult>("completed"));
  const create = vi.fn(() => Promise.resolve("agent:main:fork"));
  const patch = vi.fn((key: string, _patch: Parameters<SessionCapability["patch"]>[1]) =>
    Promise.resolve(successfulSessionPatch(key)),
  );
  const deleteSession = vi.fn(
    (): Promise<SessionDeleteResult> => Promise.resolve({ deleted: false }),
  );
  const deleteMany = vi.fn(() =>
    Promise.resolve({
      deleted: [] as string[],
      errors: [] as string[],
      preservedWorktrees: [] as PreservedSessionWorktree[],
    }),
  );
  const refresh = vi.fn((_options?: Parameters<SessionCapability["refresh"]>[0]) =>
    Promise.resolve(),
  );
  const refreshReplacement = vi.fn(() => Promise.resolve());
  const patchMany = vi.fn(
    async (
      targets: SessionsPatchManyParams["targets"],
      _patch: SessionsPatchManyParams["patch"],
    ): Promise<SessionsPatchManyResult> => ({
      outcomes: targets.map((target) => ({
        ok: true,
        key: target.key,
        ...(target.agentId ? { agentId: target.agentId } : {}),
      })),
    }),
  );
  const subscribeMessages = vi.fn((key: string, options?: { agentId?: string | null }) =>
    Promise.resolve({ key, agentId: options?.agentId ?? null }),
  );
  const unsubscribeMessages = vi.fn(
    (_subscription: Parameters<SessionCapability["unsubscribeMessages"]>[0]) => Promise.resolve(),
  );
  const list = vi.fn((_options?: Parameters<SessionCapability["list"]>[0]) =>
    Promise.resolve<SessionsListResult | null>(state.result),
  );
  const reconcile = vi.fn<SessionCapability["reconcile"]>((row, defaults, options) => {
    const result = reconcileSessionHistory(state.result, row, defaults, options);
    if (result === state.result) {
      return false;
    }
    state = { ...state, result };
    for (const listener of listeners) {
      listener(state);
    }
    return true;
  });
  let scopedSessions: SessionCapability | null = null;
  const assignOwner = vi.fn<SessionCapability["assignOwner"]>(async (key, owner, options) => {
    const assigned = scopedSessions ? await scopedSessions.assignOwner(key, owner, options) : null;
    if (!assigned || !state.result) {
      return assigned;
    }
    state = {
      ...state,
      result: {
        ...state.result,
        sessions: state.result.sessions.map((row) =>
          row.key === key ? { ...row, owner: assigned } : row,
        ),
      },
    };
    for (const listener of listeners) {
      listener(state);
    }
    return assigned;
  });
  const sessions = {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    captureConnectionScope: () => scopedSessions?.captureConnectionScope() ?? null,
    isConnectionScopeCurrent: (
      scope: Parameters<SessionCapability["isConnectionScopeCurrent"]>[0],
    ) => scopedSessions?.isConnectionScopeCurrent(scope) ?? false,
    subscribe(listener: (next: SessionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCreated: () => () => undefined,
    isPreparedWorkSession: () => false,
    pullRequestSummary: (key: string) => pullRequestSummaries.get(key),
    setPullRequestSummary(key: string, summary: SessionCatalogPullRequestSummary | undefined) {
      if (summary) {
        pullRequestSummaries.set(key, summary);
      } else {
        pullRequestSummaries.delete(key);
      }
      for (const listener of listeners) {
        listener(state);
      }
    },
    groupsLoad: () => Promise.resolve(),
    groupsGeneration: () => 0,
    groupsStatus: () => "ready",
    groupsInvalidate: () => undefined,
    groupsPut,
    groupsRename,
    groupsDelete,
    create,
    patch,
    archiveVisibility: (key: string) => archiveVisibilityByKey.get(key),
    setArchivePending(key: string, pending: boolean) {
      if (pending) {
        archiveVisibilityByKey.set(key, "pending");
      } else if (state.result?.sessions.find((row) => row.key === key)?.archived) {
        archiveVisibilityByKey.set(key, "archived");
      } else {
        archiveVisibilityByKey.delete(key);
      }
      for (const listener of listeners) {
        listener(state);
      }
    },
    assignOwner,
    patchMany,
    delete: deleteSession,
    deleteMany,
    list,
    listSnapshot(scope: Parameters<SessionCapability["listSnapshot"]>[0]) {
      if (
        (!scope.archivedFilter || scope.archivedFilter === "active") &&
        !scope.ownerId &&
        !scope.involvingMe
      ) {
        return {
          result: state.result,
          agentId: state.agentId,
          loading: state.loading,
          error: state.error,
        };
      }
      return scopedSessions!.listSnapshot(scope);
    },
    subscribeList(
      scope: Parameters<SessionCapability["subscribeList"]>[0],
      listener: Parameters<SessionCapability["subscribeList"]>[1],
    ) {
      return scopedSessions!.subscribeList(scope, listener);
    },
    refreshList(options: Parameters<SessionCapability["refreshList"]>[0]) {
      if (
        (!options?.archivedFilter || options.archivedFilter === "active") &&
        !options?.ownerId &&
        !options?.involvingMe
      ) {
        return refresh(options);
      }
      return scopedSessions!.refreshList(options);
    },
    reconcile,
    refresh,
    refreshReplacement,
    subscribeMessages,
    unsubscribeMessages,
  } as unknown as SessionCapability;
  let boundGateway: ApplicationGateway | null = null;
  const scopedClients = new WeakMap<GatewayBrowserClient, GatewayBrowserClient>();
  sidebarSessionGatewayBindings.set(sessions, (gateway) => {
    if (boundGateway === gateway) {
      return;
    }
    scopedSessions?.dispose();
    boundGateway = gateway;
    const scopedClient = (client: GatewayBrowserClient | null): GatewayBrowserClient | null => {
      if (!client) {
        return null;
      }
      const existing = scopedClients.get(client);
      if (existing) {
        return existing;
      }
      const proxy = {
        request: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "sessions.subscribe") {
            return { subscribed: true } as T;
          }
          if (method === "sessions.patchMany") {
            const { targets, patch: sessionPatch } = params as SessionsPatchManyParams;
            return (await patchMany(targets, sessionPatch)) as T;
          }
          if (method !== "sessions.list") {
            return client.request<T>(method, params);
          }
          const { archived, ...options } = (params ?? {}) as SessionListOptions & {
            archived?: true | "all";
          };
          if (!archived && !options.ownerId && !options.involvingMe) {
            return state.result as T;
          }
          return (await list({
            ...options,
            ...(archived ? { archivedFilter: archived === true ? "archived" : "all" } : {}),
          })) as T;
        },
      } as GatewayBrowserClient;
      scopedClients.set(client, proxy);
      return proxy;
    };
    scopedSessions = createSessionCapability({
      get snapshot() {
        const snapshot = gateway.snapshot;
        return { ...snapshot, client: scopedClient(snapshot.client) };
      },
      subscribe: (listener) =>
        gateway.subscribe((snapshot) =>
          listener({ ...snapshot, client: scopedClient(snapshot.client) }),
        ),
      subscribeEvents: (listener) => gateway.subscribeEvents(listener),
    });
  });
  const publish = (statePatch: Partial<SessionState>) => {
    state = { ...state, ...statePatch };
    for (const listener of listeners) {
      listener(state);
    }
  };
  return {
    sessions,
    groupsPut,
    groupsRename,
    groupsDelete,
    create,
    patch,
    patchMany,
    deleteSession,
    deleteMany,
    list,
    reconcile,
    refresh,
    refreshReplacement,
    subscribeMessages,
    unsubscribeMessages,
    publish,
    publishList(statePatch: Partial<SessionState>) {
      for (const row of statePatch.result?.sessions ?? []) {
        if (row.archived !== true && archiveVisibilityByKey.get(row.key) === "archived") {
          archiveVisibilityByKey.delete(row.key);
        }
      }
      canonicalListRevision += 1;
      publish(statePatch);
    },
  };
}

export function createGateway(client: GatewayBrowserClient): ApplicationGateway {
  return createGatewayHarness(client).gateway;
}

export function createSessions(agentId: string, keys: string[]): SessionCapability {
  return createSessionsHarness(agentId, keys).sessions;
}

export function createContext(
  gateway: ApplicationGateway,
  sessions: SessionCapability,
  agentsList: AgentsListResult | null = null,
  approvalQueue: readonly ExecApprovalRequest[] = [],
  agentIdentity: AgentIdentityCapability = {
    get: () => null,
    entries: () => [],
    ensure: async () => undefined,
    invalidate: () => undefined,
    subscribe: () => () => undefined,
  },
): ApplicationContext<RouteId> {
  sidebarSessionGatewayBindings.get(sessions)?.(gateway);
  const selectedAgentId = sessions.state.agentId ?? "main";
  return {
    gateway,
    sessions,
    agents: {
      state: {
        client: gateway.snapshot.client,
        connected: gateway.snapshot.phase === "connected",
        agentsLoading: false,
        agentsError: null,
        agentsList,
      },
      subscribe: () => () => undefined,
    },
    agentIdentity,
    agentSelection: {
      state: { selectedId: selectedAgentId, scopeId: selectedAgentId },
      set: () => undefined,
      setScope: () => undefined,
      subscribe: () => () => undefined,
    },
    scopeUpgrade: hiddenScopeUpgradeCapability,
    overlays: {
      snapshot: { approvalQueue },
      subscribe: () => () => undefined,
    } as unknown as ApplicationOverlays,
  } as unknown as ApplicationContext<RouteId>;
}

export async function mountSidebar(
  gateway: ApplicationGateway,
  sessions: SessionCapability,
  variant: SidebarLifecycleState["variant"] = "panel",
  agentsList: AgentsListResult | null = null,
  approvalQueue: readonly ExecApprovalRequest[] = [],
  agentIdentity?: AgentIdentityCapability,
) {
  const context = createContext(gateway, sessions, agentsList, approvalQueue, agentIdentity);
  const provider = createApplicationContextProvider(context);
  const sidebar = document.createElement(
    "openclaw-app-sidebar",
  ) as unknown as SidebarLifecycleState;
  sidebar.variant = variant;
  provider.append(sidebar);
  document.body.append(provider);
  await sidebar.updateComplete;
  const sidebarWithPreloads = sidebar as unknown as {
    preloadCatalogRenderer: () => Promise<unknown>;
    sidebarMenus: { preloadMenuRenderer: () => Promise<unknown> };
  };
  await Promise.all([
    import("../components/app-sidebar-session-narration.ts"),
    sidebarWithPreloads.preloadCatalogRenderer(),
    sidebarWithPreloads.sidebarMenus.preloadMenuRenderer(),
  ]);
  await sidebar.updateComplete;
  return { provider, sidebar, context };
}

export const TWO_AGENTS = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main", identity: { name: "Molty" } }, { id: "research" }],
} as AgentsListResult;

export const manyAgents = (count: number) =>
  ({
    defaultId: "agent-1",
    mainKey: "main",
    scope: "per-sender",
    agents: Array.from({ length: count }, (_, index) => ({ id: `agent-${index + 1}` })),
  }) as AgentsListResult;

export const catalogPage = (
  sessions: Array<{ threadId: string; name: string; sessionKey?: string }>,
  nextCursor?: string,
  catalogId = "codex",
): SessionsCatalogListResult => ({
  catalogs: [
    {
      id: catalogId,
      label: catalogId === "codex" ? "Codex" : "Claude",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Codex",
          kind: "gateway" as const,
          connected: true,
          sessions: sessions.map((session) => ({
            ...session,
            status: "idle",
            archived: false,
            canContinue: true,
            canArchive: true,
          })),
          ...(nextCursor ? { nextCursor } : {}),
        },
      ],
    },
  ],
});

export const catalogErrorPage = (
  message: string,
  catalogId = "codex",
): SessionsCatalogListResult => ({
  catalogs: [
    {
      id: catalogId,
      label: catalogId === "codex" ? "Codex" : "Claude",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Unavailable host",
          kind: "gateway",
          connected: false,
          sessions: [],
          error: { code: "unavailable", message },
        },
      ],
    },
  ],
});

export function setupSidebarTest() {
  let originalLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    // Coding defaults to compact; most cases assert expanded contents, so start
    // expanded. Collapse tests override this value.
    localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", JSON.stringify([]));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
}
