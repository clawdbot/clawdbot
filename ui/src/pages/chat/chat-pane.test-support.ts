import { html, type TemplateResult } from "lit";
import { onTestFinished, vi } from "vitest";
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
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { loadSettings } from "../../app/settings.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { TaskSuggestionAcceptMode } from "../../lib/task-suggestion-acceptance.ts";
import "./chat-pane.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import { ChatPane } from "./chat-pane-render.ts";
import { attachChatRealtimeActions, createInitialChatRealtimeState } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import type { ChatProps } from "./chat-view.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { SidebarLayout } from "./sidebar-layout.ts";

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
  headerPlacementRestartingKey: string | null;
  moveHeaderPlacement: (row: GatewaySessionRow) => Promise<void>;
  reclaimHeaderPlacement: (row: GatewaySessionRow) => Promise<void>;
  restartHeaderPlacement: (row: GatewaySessionRow) => Promise<void>;
  markSessionRead: (row: GatewaySessionRow | undefined) => void;
  applySessionsState: (stateValue: ApplicationContext["sessions"]["state"]) => void;
  renderPaneHeader: (
    workspace: ReturnType<typeof createSessionWorkspaceProps>,
    tasks: ReturnType<typeof createBackgroundTasksProps>,
    row: GatewaySessionRow | undefined,
    catalog: boolean,
    agentWorkspace: undefined,
    workspaceGit: boolean,
    placementStartupStatus: ApplicationPlacementStartupStatus | null | undefined,
    sidebarLayout?: SidebarLayout,
    panelDefinitions?: SidebarPanelDefinition[],
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

function withLivePreferences(context: Omit<ApplicationContext, "theme">): ApplicationContext {
  const theme = createApplicationTheme(
    loadSettings(context.gateway.connection.gatewayUrl),
    context.gateway,
  );
  onTestFinished(() => theme.dispose());
  return { ...context, theme };
}

export function createInitializationContext(): ApplicationContext {
  return withLivePreferences({
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
      connection: {
        gatewayUrl: loadSettings().gatewayUrl,
        token: "",
        bootstrapToken: "",
        password: "",
      },
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
      pause: () => undefined,
      subscribe: () => () => {},
    },
    navigate: () => undefined,
    chatSubmissions: createChatSubmissions(),
    chatAttachmentHandoff: createChatAttachmentHandoff(),
    sessions: { state: { modelOverrides: {} } },
  } as unknown as Omit<ApplicationContext, "theme">);
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
  return withLivePreferences({
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
    chatSubmissions: createChatSubmissions(),
    chatAttachmentHandoff: createChatAttachmentHandoff(),
    nativeChatDrafts: { subscribe: () => () => undefined },
    placementStartup: { get: vi.fn(() => null), pause: vi.fn() },
    sessions,
  } as unknown as Omit<ApplicationContext, "theme">);
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
    modelAuthStatusRequestVersion: 0,
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

type ActivePlacement = Extract<NonNullable<GatewaySessionRow["placement"]>, { state: "active" }>;

export function activePlacementSession(
  key = "agent:main:cloud",
): GatewaySessionRow & { placement: ActivePlacement } {
  return {
    key,
    kind: "direct",
    updatedAt: 0,
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      environmentId: "worker:one",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
    },
  };
}

export function offlineDeviceSession(): GatewaySessionRow & { placement: ActivePlacement } {
  const session = activePlacementSession("agent:main:offline-device");
  return {
    ...session,
    hasActiveRun: true,
    placement: {
      ...session.placement,
      runner: { kind: "device", status: "offline" },
    },
  };
}

class RenderTestChatPane extends ChatPane {
  chatProps: ChatProps | undefined;

  initialize(context: ApplicationContext) {
    this.context = context;
    this.state = createPageState(
      context,
      { afterCommit: () => () => {}, invalidate: () => {} },
      this,
    );
    return this.state;
  }

  protected override renderChatPaneLayout(params: { chatProps: ChatProps }) {
    this.chatProps = params.chatProps;
    return html``;
  }

  override applySessionsState(state: ApplicationContext["sessions"]["state"]) {
    super.applySessionsState(state);
  }
}

export function createRenderTestChatPane() {
  if (!customElements.get("openclaw-chat-render-regression")) {
    customElements.define("openclaw-chat-render-regression", RenderTestChatPane);
  }
  return document.createElement("openclaw-chat-render-regression") as RenderTestChatPane;
}
