import { vi } from "vitest";
import type { ControlUiAction, ControlUiHost } from "../../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type {
  SessionCapability,
  SessionListOptions,
  SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import type { SessionRefreshOptions } from "../../lib/sessions/session-capability.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { sessionsPageListQuery, type SessionsRouteData } from "./route.ts";
import type { TranscriptSearchState } from "./view.ts";
import "./sessions-page.ts";

export type TestSessionsPage = HTMLElement & {
  context: ApplicationContext;
  render: () => unknown;
  requestUpdate: () => void;
  readonly updateComplete: Promise<boolean>;
  routeData?: SessionsRouteData;
  result: SessionsListResult | null;
  error: string | null;
  loading: boolean;
  statusFilter: "active" | "archived" | "all";
  selectedKeys: Set<string>;
  sessionMenu: { key: string; x: number; y: number } | null;
  sessionMenuTrigger: HTMLElement | null;
  checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  checkpointErrorByKey: Record<string, string>;
  checkpointLoadingKey: string | null;
  checkpointBusyKey: string | null;
  sessionMutationPending: boolean;
  transcriptSearchQuery: string;
  transcriptSearch: TranscriptSearchState;
  updateTranscriptSearchQuery: (query: string) => void;
  runTranscriptSearch: () => Promise<void>;
  loadCheckpoint: (sessionKey: string) => Promise<void>;
  deleteSelected: () => Promise<void>;
  deleteSessionFromMenu: (row: GatewaySessionRow) => Promise<void>;
  deleteAllArchived: () => Promise<void>;
  stopCloudWorker: (row: GatewaySessionRow) => Promise<void>;
  rememberCustomGroup: (name: string) => Promise<unknown>;
  requestNewCategory: (sessionKey?: string) => Promise<void>;
  openSessionMenu: (
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) => void;
  patchSession: (
    key: string,
    patch: { archived?: boolean; pinned?: boolean; label?: string | null; unread?: boolean },
    scope?: unknown,
    expectedSessionId?: string,
  ) => Promise<unknown>;
  archiveSessionWithUndo: (row: GatewaySessionRow) => Promise<void>;
  forkSession: (key: string, fromLastCompleted?: boolean) => Promise<void>;
  branchCheckpoint: (sessionKey: string, checkpointId: string) => Promise<void>;
  restoreCheckpoint: (sessionKey: string, checkpointId: string) => Promise<void>;
  runPluginAction: (id: string, session: GatewaySessionRow) => Promise<void>;
};

type MutableGateway = {
  gateway: ApplicationContext["gateway"];
  emit: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  setSessionKey: ReturnType<typeof vi.fn>;
};

export function createGateway(client: GatewayBrowserClient): MutableGateway {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: sessionMutationGatewayHello(),
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

export function createSessions(overrides: Partial<SessionCapability> = {}): SessionCapability {
  return createManagedSessions(overrides).sessions;
}

function sessionListKey(options: SessionListOptions | SessionRefreshOptions): string {
  const {
    force: _force,
    backgroundHydrate: _backgroundHydrate,
    offset: _offset,
    append: _append,
    ...scope
  } = options as SessionRefreshOptions;
  return JSON.stringify(scope);
}

const managedListPublishers = new WeakMap<
  SessionCapability,
  (options: SessionListOptions, snapshot: SessionListSnapshot) => void
>();

export function createManagedSessions(overrides: Partial<SessionCapability> = {}) {
  const subscribe = () => () => undefined;
  const snapshots = new Map<string, SessionListSnapshot>();
  const listeners = new Map<string, Set<(snapshot: SessionListSnapshot) => void>>();
  const emptySnapshot = (): SessionListSnapshot => ({
    result: null,
    agentId: null,
    loading: false,
    error: null,
  });
  const publish = (options: SessionListOptions, snapshot: SessionListSnapshot) => {
    const key = sessionListKey(options);
    snapshots.set(key, snapshot);
    listeners.get(key)?.forEach((listener) => listener(snapshot));
  };
  const listSnapshot = vi.fn((options: SessionListOptions) => {
    return snapshots.get(sessionListKey(options)) ?? emptySnapshot();
  });
  const subscribeList = vi.fn(
    (options: SessionListOptions, listener: (snapshot: SessionListSnapshot) => void) => {
      const key = sessionListKey(options);
      const scoped = listeners.get(key) ?? new Set();
      scoped.add(listener);
      listeners.set(key, scoped);
      return () => {
        scoped.delete(listener);
      };
    },
  );
  const refreshList = vi.fn(async (options: SessionRefreshOptions = {}) => {
    const snapshot = listSnapshot(options);
    publish(options, { ...snapshot, loading: true, error: null });
    publish(options, { ...snapshot, loading: false, error: null });
  });
  const sessions = {
    state: {
      result: null,
      agentId: null,
      modelOverrides: {},
      loading: false,
      error: null,
      deletedSessions: [],
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    },
    list: vi.fn(async () => null),
    listSnapshot,
    subscribeList,
    refreshList,
    listCheckpoints: vi.fn(async () => []),
    deleteMany: vi.fn(async () => ({ deleted: [], errors: [], preservedWorktrees: [] })),
    patch: vi.fn(async () => null),
    create: vi.fn(async () => null),
    branchCheckpoint: vi.fn(async () => ({ key: "branch" })),
    restoreCheckpoint: vi.fn(async () => ({ ok: true })),
    subscribe,
    ...overrides,
  } as unknown as SessionCapability;
  managedListPublishers.set(sessions, publish);
  return { sessions, publish, listSnapshot, subscribeList, refreshList };
}

export function createContext(
  gateway: ApplicationContext["gateway"],
  sessions: SessionCapability,
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway,
    sessions,
    placementStartup: { pause: vi.fn() },
    agents: { state: { agentsList: null }, subscribe },
    agentIdentity: { get: () => undefined, ensure: vi.fn(), subscribe },
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
    channels: { subscribe },
    runtimeConfig: { state: { configSnapshot: null }, subscribe },
    plugins: {
      registrations: vi.fn(() => []),
      reportError: vi.fn(),
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(),
  } as unknown as ApplicationContext;
}

export function registerSessionPluginAction(context: ApplicationContext, action: ControlUiAction) {
  const lifetime = new AbortController();
  const open = vi.fn();
  const host = {
    signal: lifetime.signal,
    sessions: { open },
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const entry = {
    key: `review/${action.id}`,
    pluginId: "review",
    value: action,
    signal: lifetime.signal,
    host,
  };
  Object.assign(context.plugins, {
    registrations: vi.fn((kind) => (kind === "actions" ? [entry] : [])),
  });
  return { entry, lifetime, open };
}

export async function createRenderedPage(
  context: ApplicationContext,
  result: SessionsListResult,
  statusFilter: "active" | "archived" | "all" = "active",
  expandedSessionKey: string | null = null,
): Promise<TestSessionsPage> {
  const query = sessionsPageListQuery(context, {
    limit: 50,
    includeGlobal: true,
    includeUnknown: false,
    statusFilter,
    deepLinkSessionKey: expandedSessionKey,
  });
  const publish = managedListPublishers.get(context.sessions);
  if (publish) {
    publish(query, { result, agentId: query.agentId ?? null, loading: false, error: null });
  } else {
    await context.sessions.refreshList(query);
  }
  const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
  page.context = context;
  page.routeData = {
    expandedSessionKey,
    statusFilter,
  };
  document.body.append(page);
  await page.updateComplete;
  return page;
}
