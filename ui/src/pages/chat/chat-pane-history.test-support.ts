import { vi } from "vitest";
/* Shared fixtures for chat pane history pagination suites. */
import type { SessionCatalogTranscriptItem } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import {
  createInitializationContext,
  createRenderTestChatPane,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export function createRefreshChatPane(client?: GatewayBrowserClient) {
  const context: ApplicationContext = {
    ...createInitializationContext(),
    sessions: createSessionCapabilityFixture({
      state: { result: null, agentId: "main", modelOverrides: {} },
      think: () => undefined,
      reconcile: vi.fn(),
    }),
  };
  if (client) {
    context.gateway.snapshot.client = client;
    context.gateway.snapshot.phase = "connected";
  }
  const pane = createRenderTestChatPane();
  const state = pane.initialize(context);
  if (client) {
    state.client = client;
    state.connected = true;
  }
  return { pane, state, context };
}

export type TestChatPane = HTMLElement & {
  catalogCursor: string | undefined;
  catalogMessages: unknown[];
  context: ApplicationContext;
  state: ChatPageHost;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  sessionKey: string;
  catalogItemMessage: (item: SessionCatalogTranscriptItem) => Record<string, unknown> | null;
  handleTranscriptScroll: (event: Event) => void;
  historyAutoLoadBlocked: boolean;
  historyObserverArmed: boolean;
  syncHistoryObserver: () => void;
  prependUniqueNativeMessages: (messages: unknown[], current: unknown[]) => unknown[];
  prependUniqueCatalogMessages: (messages: unknown[]) => unknown[];
  loadOlderMessages: () => Promise<boolean>;
  stagedOlderPage: unknown;
  stagedOlderLoad: Promise<void> | null;
  showEarlierMessages: () => Promise<void>;
  requestReplyMessage: (messageId: string) => void;
  readReplyMessage: (messageId: string) => unknown;
  openReplyMessage: (messageId: string) => void;
  currentReplyNavigationId: (sessionKey: string) => string | null;
  hasOlderMessages: () => boolean;
  loadingOlder: boolean;
  resetOlderMessagesViewport: () => void;
  readonly updateComplete: Promise<boolean>;
  transcriptScrollTop: number | null;
  transcript: {
    activeSessionKey: string | null;
    readonly scrollElement: HTMLDivElement | null;
    revealMessage: (messageId: string) => boolean;
    scrollToOffset: (offset: number) => void;
  };
};

function createSessionContext(
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: { features: { methods: ["taskSuggestions.list"] } },
      },
    },
    agents: { state: { agentsList: null } },
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
    chatError: null,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatSendingScopeKey: null,
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
    sidebarLayout: { columns: [] },
    chatScrollGeneration: 0,
    chatScrollCommitCleanup: null,
    chatScrollFrame: null,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatNewMessagesBelow: false,
    handleChatScroll: vi.fn(),
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
  } as unknown as ChatPageHost;
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return { pane, state, requestUpdate };
}

export function nativeHistoryMessage(seq: number, text = `message ${seq}`) {
  return {
    role: seq % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  };
}

export function nativeHistorySeq(message: unknown): number | undefined {
  const metadata = (message as Record<string, unknown>)["__openclaw"] as
    | Record<string, unknown>
    | undefined;
  return typeof metadata?.seq === "number" ? metadata.seq : undefined;
}

export function appendChatThread(
  pane: TestChatPane,
  options: { clientHeight?: number; scrollHeight?: number; scrollTop?: number } = {},
) {
  const thread = document.createElement("div");
  thread.className = "chat-thread";
  thread.scrollTop = options.scrollTop ?? 0;
  Object.defineProperty(thread, "clientHeight", { value: options.clientHeight ?? 500 });
  Object.defineProperty(thread, "scrollHeight", { value: options.scrollHeight ?? 2_000 });
  pane.append(thread);
  vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
  return thread;
}

export function createNativeShowEarlierPane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const result = createTestChatPane({ client, sessions: {} as SessionCapability });
  result.state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
  result.state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
  const thread = appendChatThread(result.pane);
  vi.spyOn(result.pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  const scrollToOffset = vi.spyOn(result.pane.transcript, "scrollToOffset");
  return { ...result, scrollToOffset, thread };
}

/** Offset-scripted chat.history mock for an 8-message transcript whose tail
 * (seq 7-8) is loaded; overrides replace or extend the default pages. */
export function stagedPagesRequest(overrides: Record<number, () => unknown> = {}) {
  const pages: Record<number, () => unknown> = {
    2: () => ({
      messages: [nativeHistoryMessage(5), nativeHistoryMessage(6)],
      hasMore: true,
      nextOffset: 4,
      totalMessages: 8,
    }),
    4: () => ({
      messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
      hasMore: true,
      nextOffset: 6,
      totalMessages: 8,
    }),
    6: () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 8,
    }),
    ...overrides,
  };
  return vi.fn(async (_method: string, params: { offset?: number }) => {
    const page = pages[params.offset ?? -1];
    if (!page) {
      throw new Error(`no scripted page for offset ${String(params.offset)}`);
    }
    return page();
  });
}

export function createStagedPrefetchPane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const result = createTestChatPane({ client, sessions: {} as SessionCapability });
  result.state.chatMessages = [nativeHistoryMessage(7), nativeHistoryMessage(8)];
  result.state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 8 };
  return result;
}
