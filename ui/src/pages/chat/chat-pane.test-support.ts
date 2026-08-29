import type { TemplateResult } from "lit";
import { vi } from "vitest";
import type {
  SessionSuggestion,
  SessionSuggestionEvent,
  SessionTypingEvent,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  TaskSuggestion,
  TaskSuggestionEvent,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type {
  GatewayBrowserClient,
  GatewayEventFrame,
  GatewayEventListener,
} from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { TaskSuggestionAcceptMode } from "../../lib/task-suggestion-acceptance.ts";
import "./chat-pane.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import { attachChatRealtimeActions, createInitialChatRealtimeState } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";

export type TestChatPane = HTMLElement & {
  catalogMessages: unknown[];
  active: boolean;
  presented: boolean;
  presentationId: string;
  chatMessagesBySession?: ChatMessageCache;
  sessionSnapshotStore?: SessionSnapshotStore;
  chatState: { attach: (state: ChatPageHost) => void };
  context: ApplicationContext;
  state: ChatPageHost;
  connectedClient: GatewayBrowserClient | null;
  applyGatewaySnapshot: (snapshot: ApplicationContext["gateway"]["snapshot"]) => void;
  connectedCallback: () => void;
  connectionGeneration: number;
  catalogLoadGeneration: number;
  continueCatalogSession: (key: CatalogSessionKey) => Promise<void>;
  forkFromMessage: (entryId: string) => Promise<void>;
  createSession: () => Promise<boolean>;
  recoverSession: () => Promise<boolean>;
  restartRecoveryComposerBanner: () =>
    | {
        text: string;
        actionLabel: string;
        actionStyle?: "primary";
        busy?: boolean;
        busyLabel?: string;
        onAction: () => void;
      }
    | undefined;
  prepareForEviction: () => void;
  restoreArchivedSession: (sessionKey: string, expectedSessionId: string) => Promise<void>;
  disconnectedCallback: () => void;
  discardStagedAttachments?: () => void;
  resumeStagedAttachments?: () => void;
  acceptTaskSuggestion: (
    suggestion: TaskSuggestion,
    mode: TaskSuggestionAcceptMode,
    cloudProfileId?: string,
  ) => Promise<void>;
  copyTaskSuggestionPrompt: (suggestion: TaskSuggestion) => Promise<void>;
  handleDocumentKeydown: (event: KeyboardEvent) => void;
  handleTaskSuggestionEvent: (event: TaskSuggestionEvent) => void;
  refreshTaskSuggestions: () => Promise<void>;
  refreshSessionPullRequests: (options?: { refresh?: boolean }) => Promise<void>;
  sessionPullRequests: ControlUiSessionPullRequest[];
  sessionPullRequestsBranch: ControlUiSessionBranch | undefined;
  taskSuggestions: TaskSuggestion[];
  presencePayload?: { presence: unknown[] };
  sessionSuggestionAddOperation: symbol | undefined;
  sessionSuggestionRole: "admin" | "owner" | "member" | "viewer" | undefined;
  addCurrentSessionSuggestion: () => Promise<void>;
  resetSessionSuggestions: () => void;
  sessionSuggestions: SessionSuggestion[];
  sessionSuggestionsRequestVersion: number;
  sessionSuggestionsRefreshPromise: Promise<void> | undefined;
  sessionSuggestionTargetSignature: string;
  syncSessionSuggestionTarget: (agentId: string, session: GatewaySessionRow | undefined) => void;
  handleSessionSuggestionEvent: (event: SessionSuggestionEvent) => void;
  handleSessionTypingEvent: (event: SessionTypingEvent) => void;
  clearTypingActorForSessionMessage: (payload: unknown) => void;
  typingActors: Map<string, { label: string; expiresAt: number; preview?: string }>;
  typingActorViews: () => { id: string; label: string; preview?: string }[];
  sendTypingState: (typing: boolean, preview?: string) => void;
  refreshSessionSuggestions: () => Promise<void>;
  resolveCurrentSessionSuggestion: (
    suggestion: SessionSuggestion,
    resolution: "send" | "queue" | "edit" | "dismiss",
  ) => Promise<void>;
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
  paneId: string;
  sessionKey: string;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  performUpdate: () => void;
  deferSessionHydrationUntilTranscript: (
    sessionKey: string,
    transcriptLoad: Promise<boolean>,
  ) => void;
  paneTitle: string;
  catalogSession: SessionCatalogSession | null;
  catalogItemMessage: (item: SessionCatalogTranscriptItem) => Record<string, unknown> | null;
  handleTranscriptScroll: (event: Event) => void;
  handleTranscriptHistoryIntent: (event: Event) => void;
  historyAutoLoadBlocked: boolean;
  historyObserverArmed: boolean;
  transcriptScrollTop: number | null;
  syncHistoryObserver: () => void;
  loadCatalogSession: (key: CatalogSessionKey, older: boolean) => Promise<boolean>;
  prependUniqueNativeMessages: (messages: unknown[], current: unknown[]) => unknown[];
  prependUniqueCatalogMessages: (messages: unknown[]) => unknown[];
  loadOlderMessages: () => Promise<void>;
  hasOlderMessages: () => boolean;
  loadingOlder: boolean;
  catalogCursor: string | undefined;
  olderCursorsSeen: Set<string>;
  headerEditing: boolean;
  headerRenameValue: string;
  beginHeaderRename: (row: GatewaySessionRow) => void;
  handleHeaderSessionAction: (action: HeaderMenuAction, row: GatewaySessionRow) => Promise<void>;
  cancelHeaderRename: () => void;
  commitHeaderRename: () => void;
  handleHeaderMenuAction: (
    action: "reveal" | "copy-path" | "copy-branch",
    row: GatewaySessionRow,
    workspaceRoot: string | null,
    branch: string | null,
    copy?: (value: string) => Promise<boolean>,
  ) => void;
  loadHeaderMenuData: (
    row: GatewaySessionRow,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
  ) => Promise<void>;
  headerPlacementMovingKey: string | null;
  headerPlacementReclaimingKey: string | null;
  moveHeaderPlacement: (row: GatewaySessionRow) => Promise<void>;
  reclaimHeaderPlacement: (row: GatewaySessionRow) => Promise<void>;
  markSessionRead: (row: GatewaySessionRow | undefined) => void;
  applySessionsState: (stateValue: ApplicationContext["sessions"]["state"]) => void;
  renderPaneHeader: (
    workspace: ReturnType<typeof createSessionWorkspaceProps>,
    tasks: ReturnType<typeof createBackgroundTasksProps>,
    row: GatewaySessionRow | undefined,
    catalog: boolean,
    agentWorkspace: undefined,
    workspaceGit: boolean,
  ) => TemplateResult;
};

type GatewayBrowserClientFixtureOverrides = Omit<Partial<GatewayBrowserClient>, "request"> & {
  request?: (method: string, params?: unknown) => unknown;
};

export function createGatewayBrowserClientFixture(
  overrides: GatewayBrowserClientFixtureOverrides = {},
): GatewayBrowserClient {
  return overrides as typeof overrides & GatewayBrowserClient;
}

export function createInitializationContext(): ApplicationContext {
  return {
    basePath: "",
    gateway: {
      snapshot: {
        client: null,
        phase: "stopped",
        offlineStable: false,
        hello: null,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        sessionKey: "",
        lastError: null,
        lastErrorCode: null,
      },
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    },
    config: {
      current: {
        assistantIdentity: {
          agentId: null,
          name: "Assistant",
          avatar: null,
          avatarSource: null,
          avatarStatus: null,
          avatarReason: null,
        },
        serverVersion: null,
        localMediaPreviewRoots: [],
        embedSandboxMode: "strict",
        allowExternalEmbedUrls: false,
        terminalEnabled: false,
      },
    },
    agentSelection: { state: { selectedId: "main" } },
    agents: { state: { agentsList: null } },
    runtimeConfig: {
      state: { configNeedsApply: false, configSnapshot: null },
      subscribe: () => () => {},
    },
    placementStartup: {
      get: () => null,
      hasPendingTurn: () => false,
      retry: () => undefined,
      subscribe: () => () => {},
    },
    navigate: () => undefined,
    initialUserMessage: createInitialUserMessageHandoff(),
    chatAttachmentHandoff: createChatAttachmentHandoff(),
    sessions: { state: { modelOverrides: {} } },
  } as unknown as ApplicationContext;
}

export function nativeHistoryMessage(seq: number, text = `message ${seq}`) {
  return {
    role: seq % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  };
}

type SessionCapabilityFixtureOverrides = Omit<Partial<SessionCapability>, "patch" | "state"> & {
  patch?: (...args: Parameters<NonNullable<SessionCapability["patch"]>>) => unknown;
  state?: Partial<SessionCapability["state"]>;
};

export function createSessionCapabilityFixture(
  overrides: SessionCapabilityFixtureOverrides = {},
): SessionCapability {
  return { deletionState: () => undefined, ...overrides } as typeof overrides & SessionCapability;
}

export function createSessionContext(
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): ApplicationContext {
  const eventListeners = new Set<GatewayEventListener>();
  const agentSelectionListeners = new Set<(state: { selectedId: string | null }) => void>();
  const agentSelectionState = { selectedId: "main" as string | null };
  const snapshotListeners = new Set<
    (snapshot: ApplicationContext["gateway"]["snapshot"]) => void
  >();
  return {
    gateway: {
      snapshot: {
        client,
        phase: "connected" as const,
        hello: gatewayHelloForMethods([
          ...SESSION_MUTATION_TEST_METHODS,
          "taskSuggestions.list",
          "session.suggestions.list",
        ]),
      },
      connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
      eventLog: [],
      subscribe: (listener: (snapshot: ApplicationContext["gateway"]["snapshot"]) => void) => {
        snapshotListeners.add(listener);
        return () => snapshotListeners.delete(listener);
      },
      subscribeEvents: (listener: GatewayEventListener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      subscribeEventLog: () => () => {},
      connect: vi.fn(),
      setSessionKey: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      emitTestEvent: (event: GatewayEventFrame) => {
        for (const listener of eventListeners) {
          listener(event);
        }
      },
    },
    agents: { state: { agentsList: null } },
    agentSelection: {
      state: agentSelectionState,
      set: (agentId: string | null) => {
        agentSelectionState.selectedId = agentId;
        for (const listener of agentSelectionListeners) {
          listener(agentSelectionState);
        }
      },
      subscribe: (listener: (state: { selectedId: string | null }) => void) => {
        agentSelectionListeners.add(listener);
        return () => agentSelectionListeners.delete(listener);
      },
    },
    config: {
      current: {
        assistantIdentity: { name: "Molty" },
        terminalEnabled: false,
      },
    },
    initialUserMessage: createInitialUserMessageHandoff(),
    chatAttachmentHandoff: createChatAttachmentHandoff(),
    nativeChatDrafts: { subscribe: () => () => undefined },
    sessions,
  } as unknown as ApplicationContext;
}

export function createTestChatPane(params: {
  client: GatewayBrowserClient;
  sessions: SessionCapability;
}) {
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  Object.defineProperty(pane, "isConnected", {
    configurable: true,
    value: true,
  });
  const requestUpdate = vi.fn();
  const state = {
    agentsList: null,
    assistantAgentId: null,
    chatAttachments: [],
    chatComposerFallbackByScope: {},
    chatError: null,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatModelCatalog: [],
    chatModelCatalogError: null,
    chatModelsLoading: false,
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    client: params.client,
    connected: true,
    connectionEpoch: 4,
    hello: sessionMutationGatewayHello(),
    lastError: null,
    requestUpdate,
    sessionKey: "agent:main:current",
    sessions: params.sessions,
    sessionsError: null,
    sessionsLoading: false,
    sidebarContent: null,
    attachmentSidebarContent: null,
    sidebarFocusPanelId: "",
    sidebarFocusVersion: 0,
    sidebarLayout: { columns: [] },
    ...createInitialChatRealtimeState(),
    // Minimal scroll host so scheduleChatScroll is a no-op instead of throwing.
    chatScrollGeneration: 0,
    chatScrollCommitCleanup: null,
    handleChatScroll: vi.fn(),
    resetToolStream: vi.fn(),
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
  } as unknown as ChatPageHost;
  attachChatRealtimeActions(state);
  state.updateSidebarLayout = (layout) => {
    state.sidebarLayout = layout;
  };
  state.updateSidebarActivePanel = (panelId) => {
    state.sidebarFocusPanelId = panelId;
    state.sidebarFocusVersion += 1;
  };
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return {
    pane,
    requestUpdate,
    state,
    emitGatewayEvent: (event: string, payload: unknown) => {
      const emit = (
        pane.context.gateway as ApplicationContext["gateway"] & {
          emitTestEvent: (event: GatewayEventFrame) => void;
        }
      ).emitTestEvent;
      emit({ type: "event", event, payload, seq: 1 });
    },
  };
}
