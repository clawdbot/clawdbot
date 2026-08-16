import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { SessionsRouteData } from "./sessions-page.ts";
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
  loadSessions: () => Promise<void>;
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
    patch: { archived?: boolean; pinned?: boolean; label?: string | null },
    scope?: unknown,
    expectedSessionId?: string,
  ) => Promise<unknown>;
  archiveSessionWithUndo: (row: GatewaySessionRow) => Promise<void>;
  forkSession: (key: string, fromLastCompleted?: boolean) => Promise<void>;
  branchCheckpoint: (sessionKey: string, checkpointId: string) => Promise<void>;
  restoreCheckpoint: (sessionKey: string, checkpointId: string) => Promise<void>;
  addToWorkboard: (session: GatewaySessionRow) => Promise<void>;
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

export function createSessions(overrides: Partial<SessionCapability> = {}): SessionCapability {
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

export function createContext(
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
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
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

export async function createRenderedPage(
  context: ApplicationContext,
  result: SessionsListResult,
  statusFilter: "active" | "archived" | "all" = "active",
  expandedSessionKey: string | null = null,
): Promise<TestSessionsPage> {
  const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
  page.context = context;
  page.routeData = {
    gateway: context.gateway,
    gatewaySnapshot: context.gateway.snapshot,
    result,
    error: null,
    expandedSessionKey,
    statusFilter,
  };
  document.body.append(page);
  await page.updateComplete;
  return page;
}
