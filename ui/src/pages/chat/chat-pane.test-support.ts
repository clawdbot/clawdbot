import type { TemplateResult } from "lit";
import { vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  TaskSuggestion,
  TaskSuggestionEvent,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import type { ChatPageHost } from "./chat-state.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";

export type TestChatPane = HTMLElement & {
  catalogMessages: unknown[];
  active: boolean;
  chatMessagesBySession?: ChatMessageCache;
  chatState: { attach: (state: ChatPageHost) => void };
  context: ApplicationContext;
  state: ChatPageHost;
  connectedClient: GatewayBrowserClient | null;
  applyGatewaySnapshot: (snapshot: ApplicationContext["gateway"]["snapshot"]) => void;
  connectedCallback: () => void;
  connectionGeneration: number;
  createSession: () => Promise<boolean>;
  disconnectedCallback: () => void;
  acceptTaskSuggestion: (suggestion: TaskSuggestion) => Promise<void>;
  handleDocumentKeydown: (event: KeyboardEvent) => void;
  handleTaskSuggestionEvent: (event: TaskSuggestionEvent) => void;
  refreshTaskSuggestions: () => Promise<void>;
  refreshSessionPullRequests: (options?: { refresh?: boolean }) => Promise<void>;
  sessionPullRequests: ControlUiSessionPullRequest[];
  taskSuggestions: TaskSuggestion[];
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
  sessionKey: string;
  switchPaneSession: (nextSessionKey: string) => void;
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
  olderOffsetsSeen: Set<number>;
  headerEditing: boolean;
  headerRenameValue: string;
  beginHeaderRename: (row: GatewaySessionRow) => void;
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
  markSessionRead: (row: GatewaySessionRow | undefined) => void;
  renderPaneHeader: (
    workspace: ReturnType<typeof createSessionWorkspaceProps>,
    tasks: ReturnType<typeof createBackgroundTasksProps>,
    row: undefined,
    catalog: boolean,
    agentWorkspace: undefined,
    workspaceGit: boolean,
  ) => TemplateResult;
};

export function createSessionContext(
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client,
        connected: true,
        hello: { features: { methods: ["taskSuggestions.list"] } },
      },
    },
    agents: { state: { agentsList: null } },
    config: {
      current: {
        assistantIdentity: { name: "Molty" },
        terminalEnabled: false,
      },
    },
    initialUserMessage: createInitialUserMessageHandoff(),
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
    chatError: null,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    client: params.client,
    connected: true,
    connectionEpoch: 4,
    hello: null,
    lastError: null,
    requestUpdate,
    sessionKey: "agent:main:current",
    sessions: params.sessions,
    sessionsError: null,
    sessionsLoading: false,
    sidebarContent: null,
    sidebarOpen: false,
    // Minimal scroll host so scheduleChatScroll is a no-op instead of throwing.
    chatScrollGeneration: 0,
    chatScrollCommitCleanup: null,
    handleChatScroll: vi.fn(),
    realtimeTalkInputLevel: { set: vi.fn() },
    resetToolStream: vi.fn(),
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
  } as unknown as ChatPageHost;
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return { pane, requestUpdate, state };
}
