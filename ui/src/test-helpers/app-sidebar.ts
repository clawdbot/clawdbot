import { afterEach, beforeEach, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogPullRequestSummary,
  SessionsCatalogListResult,
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
import type { ApplicationOverlays } from "../app/overlays.ts";
import type {
  SidebarWorkboardBoard,
  SidebarWorkboardRenderers,
} from "../components/app-sidebar-workboard.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { createApplicationContextProvider } from "./application-context.ts";
import { createStorageMock } from "./storage.ts";

// The attention widget owns independent health RPC tests. Keep those requests
// out of sidebar client call-order assertions.
vi.mock("../components/sidebar-attention.ts", () => ({}));

export type SessionGroupMutationResult = Awaited<ReturnType<SessionCapability["groupsRename"]>>;
type SessionDeleteResult = Awaited<ReturnType<SessionCapability["delete"]>>;
type SessionState = SessionCapability["state"];

export type SidebarLifecycleState = HTMLElement & {
  activeRouteId?: string;
  activeWorkboardBoardId: string;
  enabledRouteIds?: readonly NavigationRouteId[];
  connected: boolean;
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
  sessionKey: string;
  onNavigate: (
    routeId: string,
    options?: { pathname?: string; search?: string; hash?: string },
  ) => void;
  sessionCatalogs: SessionCatalog[];
  sessionRowsByAgent: Record<string, SessionsListResult["sessions"]>;
  sessionCreatedOrder: Map<string, number>;
  sessionsAgentId: string | null;
  sessionsResult: SessionsListResult | null;
  requestUpdate: () => void;
  updateComplete: Promise<boolean>;
  updateAvailable: { currentVersion: string; latestVersion: string; channel: string } | null;
  updateRunning: boolean;
  onUpdate: () => void;
  onOpenNewSession?: (agentId: string, target?: { catalogId: string }) => void;
  variant: "panel" | "drawer";
};

export type LobsterPetElement = HTMLElement & {
  runOutcome: "ok" | "error" | "aborted";
};

export type TestSessionMenu = HTMLElement & {
  forkDisabled: boolean;
  selectionCount: number;
  readonly updateComplete: Promise<boolean>;
};

export function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
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
  const groupsPut = vi.fn(() => Promise.resolve());
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
      preservedWorktrees: [] as Array<{ id: string; branch: string; path: string }>,
    }),
  );
  const refresh = vi.fn(() => Promise.resolve());
  const refreshReplacement = vi.fn(() => Promise.resolve());
  const subscribeMessages = vi.fn((key: string, options?: { agentId?: string | null }) =>
    Promise.resolve({ key, agentId: options?.agentId ?? null }),
  );
  const unsubscribeMessages = vi.fn(
    (_subscription: Parameters<SessionCapability["unsubscribeMessages"]>[0]) => Promise.resolve(),
  );
  const list = vi.fn((_options?: Parameters<SessionCapability["list"]>[0]) =>
    Promise.resolve<SessionsListResult | null>(null),
  );
  const sessions = {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    subscribe(listener: (next: SessionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCreated: () => () => undefined,
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
    groupsPut,
    groupsRename,
    groupsDelete,
    create,
    patch,
    delete: deleteSession,
    deleteMany,
    list,
    refresh,
    refreshReplacement,
    subscribeMessages,
    unsubscribeMessages,
  } as unknown as SessionCapability;
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
    deleteSession,
    deleteMany,
    list,
    refresh,
    refreshReplacement,
    subscribeMessages,
    unsubscribeMessages,
    publish,
    publishList(statePatch: Partial<SessionState>) {
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
): ApplicationContext<RouteId> {
  const selectedAgentId = sessions.state.agentId ?? "main";
  return {
    gateway,
    sessions,
    agents: {
      state: { agentsList },
      subscribe: () => () => undefined,
    },
    agentSelection: {
      state: { selectedId: selectedAgentId, scopeId: selectedAgentId },
      set: () => undefined,
      setScope: () => undefined,
      subscribe: () => () => undefined,
    },
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
) {
  const context = createContext(gateway, sessions, agentsList, approvalQueue);
  const provider = createApplicationContextProvider(context);
  const sidebar = document.createElement(
    "openclaw-app-sidebar",
  ) as unknown as SidebarLifecycleState;
  sidebar.variant = variant;
  provider.append(sidebar);
  document.body.append(provider);
  await sidebar.updateComplete;
  return { provider, sidebar, context };
}

export const TWO_AGENTS = {
  defaultId: "main",
  mainKey: "main",
  scope: "agent",
  agents: [{ id: "main", identity: { name: "Molty" } }, { id: "research" }],
} as AgentsListResult;

export const manyAgents = (count: number) =>
  ({
    defaultId: "agent-1",
    mainKey: "main",
    scope: "agent",
    agents: Array.from({ length: count }, (_, index) => ({ id: `agent-${index + 1}` })),
  }) as AgentsListResult;

export const catalogPage = (
  sessions: Array<{ threadId: string; name: string }>,
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
    // The Coding zone defaults to collapsed on first run; most cases assert its
    // contents, so start expanded. Collapse-specific tests override this value.
    localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", JSON.stringify([]));
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
}
