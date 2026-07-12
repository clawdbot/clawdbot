/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import type { UiSettings } from "../../app/settings.ts";
import {
  blockArtCodeBlockCopyPayloadEncoding,
  encodeBlockArtCodeBlockCopyPayload,
} from "../../components/markdown.ts";
import { i18n, t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  resetChatAttachmentPayloadStoreForTest,
} from "./attachment-payload-store.ts";
import { switchChatFastMode, switchChatModel, switchChatThinkingLevel } from "./chat-session.ts";
import { renderChat, resetChatViewState } from "./chat-view.ts";
import { renderChatQueue, resetChatComposerState } from "./components/chat-composer.ts";
import {
  renderChatModelControls,
  type ChatModelControlsProps,
} from "./components/chat-model-controls.ts";
import {
  renderRealtimeTalkOptions,
  type ChatRealtimeTalkOptionsProps,
} from "./components/chat-realtime-controls.ts";
import { renderMarkdownSidebar } from "./components/chat-sidebar.ts";
import { buildRawSidebarContent } from "./components/chat-sidebar.ts";
import {
  isChatThreadSearchOpen,
  resetChatThreadPresentationState,
  toggleChatThreadSearch,
} from "./components/chat-thread.ts";
import { renderWelcomeState } from "./components/chat-welcome.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";

const refreshVisibleToolsEffectiveForCurrentSessionMock = vi.hoisted(() =>
  vi.fn(async (state: ChatHeaderTestState) => {
    const agentId = state.agentsSelectedId ?? "main";
    const sessionKey = state.sessionKey;
    await state.client?.request("tools.effective", { agentId, sessionKey });
    const override = state.sessions.state.modelOverrides[sessionKey];
    state.toolsEffectiveResultKey = `${agentId}:${sessionKey}:model=${override ?? "(default)"}`;
    state.toolsEffectiveResult = { agentId, profile: "coding", groups: [] };
  }),
);
const buildChatItemsMock = vi.hoisted(() =>
  vi.fn(
    (props: {
      messages: unknown[];
      stream: string | null;
      streamStartedAt: number | null;
      runWorking?: boolean;
      loading?: boolean;
    }) => {
      if (
        props.messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { __testDivider?: unknown })["__testDivider"] === true,
        )
      ) {
        return [
          {
            kind: "divider",
            key: "divider:compaction:test",
            label: "Compacted history",
            description:
              "The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.",
            action: {
              kind: "session-checkpoints",
              label: "Open checkpoints",
            },
            timestamp: 1,
          },
        ];
      }
      const items: unknown[] = [];
      if (props.messages.length > 0) {
        items.push({
          kind: "group",
          key: "group:assistant:test",
          role: "assistant",
          messages: props.messages.map((message, index) => ({
            key: `message:${index}`,
            message,
          })),
          timestamp: 1,
          isStreaming: false,
        });
      }
      // Mirrors buildChatItems: streamed text renders as a stream item; an
      // empty stream or a working run with no stream shows the reading
      // indicator (working spark), except on the initial empty load where
      // the skeleton owns the thread.
      if (props.stream !== null) {
        items.push(
          props.stream
            ? {
                kind: "stream",
                key: "stream:test",
                text: props.stream,
                startedAt: props.streamStartedAt ?? 1,
                isStreaming: true,
              }
            : { kind: "reading-indicator", key: "reading:test" },
        );
      } else if (
        props.runWorking === true &&
        !(props.loading === true && props.messages.length === 0)
      ) {
        items.push({ kind: "reading-indicator", key: "reading:test" });
      }
      return items;
    },
  ),
);
const renderMessageGroupMock = vi.hoisted(() =>
  vi.fn(
    (
      group: { messages: Array<{ message: unknown }> },
      _opts?: { onAssistantAttachmentLoaded?: () => void },
    ) => {
      const element = document.createElement("div");
      element.className = "chat-group";
      element.textContent = group.messages
        .map(({ message }) => {
          if (typeof message === "object" && message !== null && "content" in message) {
            const content = (message as { content?: unknown }).content;
            if (typeof content === "string") {
              return content;
            }
            return content == null ? "" : JSON.stringify(content);
          }
          return String(message);
        })
        .join("\n");
      return element;
    },
  ),
);
const assistantAttachmentRenderVersionMock = vi.hoisted(() => ({ value: 0 }));

type ChatHeaderTestState = {
  basePath?: string;
  chatLoading: boolean;
  chatMessage: string;
  chatMessages: unknown[];
  chatModelCatalog: ModelCatalogEntry[];
  chatModelsLoading?: boolean;
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatThinkingLevel: string | null;
  chatVerboseLevel: string | null;
  chatAvatarUrl: string | null;
  client: GatewayBrowserClient;
  connected: boolean;
  hello: null;
  lastError: string | null;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  agentsList: null;
  agentsPanel: string;
  agentsSelectedId: string | null;
  settings: UiSettings;
  sessions: SessionCapability;
  setRoute: ReturnType<typeof vi.fn>;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResultKey: string | null;
  toolsEffectiveResult: unknown;
  applySettings(next: UiSettings): void;
  loadAssistantIdentity(): void;
  onModelChanged(): void | Promise<void>;
  resetChatInputHistoryNavigation(): void;
  resetChatScroll(): void;
  resetToolStream(): void;
};

function requireFirstAttachmentsChange(
  onAttachmentsChange: ReturnType<typeof vi.fn>,
): ChatAttachment[] {
  const [call] = onAttachmentsChange.mock.calls;
  if (!call) {
    throw new Error("expected attachments change call");
  }
  const [attachments] = call;
  if (!Array.isArray(attachments)) {
    throw new Error("expected attachments array");
  }
  return attachments as ChatAttachment[];
}

vi.mock("../../components/icons.ts", () => ({
  icons: {},
}));

vi.mock("./chat-thread.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-thread.ts")>();
  return {
    ...actual,
    buildCachedChatItems: buildChatItemsMock,
    getExpandedToolCards: () => new Map<string, boolean>(),
    syncToolCardExpansionState: () => undefined,
  };
});

vi.mock("./components/chat-message.ts", () => ({
  getAssistantAttachmentAvailabilityRenderVersion: () => assistantAttachmentRenderVersionMock.value,
  renderMessageGroup: renderMessageGroupMock,
  renderStreamGroup: (parts: Array<{ kind: string; text?: string }>) => {
    const group = document.createElement("div");
    group.className = "chat-stream-run";
    for (const part of parts) {
      const bubble = document.createElement("div");
      if (part.kind === "reading-indicator") {
        bubble.className = "chat-reading-indicator";
      } else {
        bubble.className = "chat-stream";
        bubble.textContent = part.text ?? "";
      }
      group.appendChild(bubble);
    }
    return group;
  },
}));

vi.mock("../../lib/agents/tools-effective.ts", () => ({
  refreshVisibleToolsEffectiveForCurrentSession: refreshVisibleToolsEffectiveForCurrentSessionMock,
}));

vi.mock("../../lib/agents/display.ts", () => ({
  assistantAvatarFallbackUrl: () => "apple-touch-icon.png",
}));

function renderQueue(params: {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRemove?: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
}) {
  const container = document.createElement("div");
  render(
    renderChatQueue({
      queue: params.queue,
      canAbort: params.canAbort ?? true,
      onQueueRemove: params.onQueueRemove ?? (() => undefined),
      onQueueRetry: params.onQueueRetry,
      onQueueSteer: params.onQueueSteer,
    }),
    container,
  );
  return container;
}

function createSessionsResultFromRows(
  sessions: GatewaySessionRow[],
  overrides: Partial<
    Pick<SessionsListResult, "hasMore" | "nextOffset" | "offset" | "totalCount">
  > = {},
): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
    sessions,
    ...overrides,
  };
}

function createChatHeaderState(
  overrides: {
    model?: string | null;
    modelProvider?: string | null;
    models?: ModelCatalogEntry[];
    defaultsThinkingDefault?: string;
    thinkingDefault?: string;
    omitSessionFromList?: boolean;
  } = {},
): { state: ChatHeaderTestState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  let currentModelProvider = overrides.modelProvider ?? (currentModel ? "openai" : null);
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const catalog = overrides.models ?? createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "sessions.patch") {
      const nextModel = (params.model as string | null | undefined) ?? null;
      if (!nextModel) {
        currentModel = null;
        currentModelProvider = null;
      } else {
        const normalized = nextModel.trim();
        const slashIndex = normalized.indexOf("/");
        if (slashIndex > 0) {
          currentModelProvider = normalized.slice(0, slashIndex);
          currentModel = normalized.slice(slashIndex + 1);
        } else {
          currentModel = normalized;
          const matchingProviders: string[] = [];
          for (const entry of catalog) {
            if (entry.id === normalized && entry.provider) {
              matchingProviders.push(entry.provider);
            }
          }
          currentModelProvider =
            matchingProviders.length === 1
              ? expectDefined(matchingProviders[0], "single matching model provider")
              : currentModelProvider;
        }
      }
      return { ok: true, key: "main" };
    }
    if (method === "chat.history") {
      return { messages: [], thinkingLevel: null };
    }
    if (method === "sessions.list") {
      const search = typeof params.search === "string" ? params.search.trim() : "";
      const offset =
        typeof params.offset === "number" && Number.isFinite(params.offset) ? params.offset : 0;
      const matchesTelegramSearch = search !== "" && "telegram".startsWith(search);
      if (matchesTelegramSearch && offset === 50) {
        return createSessionsResultFromRows(
          [
            {
              key: "agent:main:telegram-page-51",
              kind: "direct",
              label: "Telegram page 51",
              updatedAt: 2,
            },
            {
              key: "agent:main:telegram-page-52",
              kind: "direct",
              label: "Telegram page 52",
              updatedAt: 1,
            },
          ],
          { hasMore: false, nextOffset: null, offset: 50, totalCount: 4 },
        );
      }
      if (matchesTelegramSearch) {
        return createSessionsResultFromRows(
          [
            { key: "agent:main:telegram-one", kind: "direct", label: "Telegram one", updatedAt: 4 },
            { key: "agent:main:telegram-two", kind: "direct", label: "Telegram two", updatedAt: 3 },
            {
              key: "agent:main:telegram-archived",
              kind: "direct",
              label: "Telegram archived",
              updatedAt: 2,
              archived: true,
            },
          ],
          { hasMore: true, nextOffset: 50, totalCount: 4 },
        );
      }
      return createSessionsListResult({
        model: currentModel,
        modelProvider: currentModelProvider,
        defaultsThinkingDefault: overrides.defaultsThinkingDefault,
        thinkingDefault: overrides.thinkingDefault,
        omitSessionFromList,
      });
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    if (method === "tools.effective") {
      return {
        agentId: "main",
        profile: "coding",
        groups: [],
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = createSessionCapability({
    snapshot: { client, connected: true, hello: null },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  const initialSessionsResult = createSessionsListResult({
    model: currentModel,
    modelProvider: currentModelProvider,
    defaultsThinkingDefault: overrides.defaultsThinkingDefault,
    thinkingDefault: overrides.thinkingDefault,
    omitSessionFromList,
  });
  const state: ChatHeaderTestState = {
    sessionKey: "main",
    connected: true,
    sessionsResult: initialSessionsResult,
    chatModelCatalog: catalog,
    chatModelsLoading: false,
    client,
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 280,
      sidebarPinnedRoutes: [],
      sidebarMoreExpanded: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    chatMessage: "",
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatQueue: [],
    chatMessages: [],
    chatLoading: false,
    chatSending: false,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    lastError: null,
    chatAvatarUrl: null,
    basePath: "",
    hello: null,
    agentsList: null,
    agentsPanel: "overview",
    agentsSelectedId: null,
    sessions,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    applySettings(next: UiSettings) {
      state.settings = next;
    },
    setRoute: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    resetChatInputHistoryNavigation: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
    onModelChanged: (): Promise<void> => refreshVisibleToolsEffectiveForCurrentSessionMock(state),
  };
  sessions.subscribe((next) => {
    state.sessionsResult = next.result;
  });
  return { state, request };
}

function getChatModelSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-model-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat model control");
  }
  return select;
}

function createChatModelControlsProps(state: ChatHeaderTestState): ChatModelControlsProps {
  return {
    activeRunId: state.chatRunId,
    connected: state.connected,
    gatewayAvailable: Boolean(state.client),
    loading: state.chatLoading,
    modelCatalog: state.chatModelCatalog,
    modelOverrides: state.sessions.state.modelOverrides,
    modelSwitching: false,
    modelsLoading: state.chatModelsLoading,
    sending: state.chatSending,
    sessionKey: state.sessionKey,
    sessionsResult: state.sessionsResult,
    stream: state.chatStream,
    onFastModeSelect: (value, targetSessionKey) =>
      switchChatFastMode(
        state as unknown as Parameters<typeof switchChatFastMode>[0],
        value,
        targetSessionKey,
      ),
    onModelSelect: (value, targetSessionKey) =>
      switchChatModel(
        state as unknown as Parameters<typeof switchChatModel>[0],
        value,
        targetSessionKey,
      ),
    onThinkingSelect: (value, targetSessionKey) =>
      switchChatThinkingLevel(
        state as unknown as Parameters<typeof switchChatThinkingLevel>[0],
        value,
        targetSessionKey,
      ),
  };
}

function getChatThinkingValue(control: HTMLElement): string {
  return control.dataset.chatThinkingValue ?? "";
}

function getThinkingSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-thinking-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat thinking control");
  }
  return select;
}

function getThinkingSlider(container: Element): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('[data-chat-thinking-slider="true"]');
}

function getThinkingSliderValues(container: Element): string[] {
  const values = getThinkingSlider(container)?.dataset.chatThinkingValues ?? "";
  return values ? values.split(",") : [];
}

function getThinkingReasoningValueLabel(container: Element): string {
  return container.querySelector(".chat-controls__reasoning-value")?.textContent?.trim() ?? "";
}

function getThinkingResetButton(container: Element): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-chat-thinking-option=""]');
}

function requireElement(container: Element, selector: string, label: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`expected ${label}`);
  }
  return element;
}

function createDragEvent(type: string, types = ["Files"]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types } });
  return event;
}

function itemAt<T>(items: ArrayLike<T>, index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

function getTalkSelectOptionValues(container: Element, name: string): string[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      `[data-talk-select="${name}"] [data-talk-select-option]`,
    ),
  ).map((option) => option.dataset.talkSelectOption ?? "");
}

function clickTalkSelectOption(container: Element, name: string, value: string): void {
  const option = container.querySelector<HTMLButtonElement>(
    `[data-talk-select="${name}"] [data-talk-select-option="${value}"]`,
  );
  if (option === null) {
    throw new Error(`expected Talk ${name} option ${value}`);
  }
  option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function createChatProps(
  overrides: Partial<Parameters<typeof renderChat>[0]> = {},
): Parameters<typeof renderChat>[0] {
  return {
    paneId: "single",
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    sideChatTurns: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: null,
    sidebarOpen: false,
    sidebarContent: null,
    splitRatio: 0.6,
    canvasPluginSurfaceUrl: null,
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    assistantName: "Val",
    sendShortcut: "enter",
    assistantAvatar: null,
    userName: null,
    userAvatar: null,
    localMediaPreviewRoots: [],
    assistantAttachmentAuthToken: null,
    autoExpandToolCalls: false,
    attachments: [],
    onAttachmentsChange: () => undefined,
    showNewMessages: false,
    onScrollToBottom: () => undefined,
    onRefresh: () => undefined,
    getDraft: () => "",
    onDraftChange: () => undefined,
    onRequestUpdate: () => undefined,
    onSend: () => undefined,
    onCompact: () => undefined,
    onToggleRealtimeTalk: () => undefined,
    onDismissError: () => undefined,
    onAbort: () => undefined,
    onQueueRemove: () => undefined,
    onQueueSteer: () => undefined,
    onSideChatClose: () => undefined,
    onSideChatClear: () => undefined,
    onNewSession: () => undefined,
    onClearHistory: () => undefined,
    onOpenSessionCheckpoints: () => undefined,
    agentsList: null,
    currentAgentId: "main",
    onAgentChange: () => undefined,
    onNavigateToAgent: () => undefined,
    onSessionSelect: () => undefined,
    onOpenSidebar: () => undefined,
    onCloseSidebar: () => undefined,
    onSplitRatioChange: () => undefined,
    onChatScroll: () => undefined,
    basePath: "",
    ...overrides,
  };
}

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]> = {}) {
  const container = document.createElement("div");
  render(renderChat(createChatProps(overrides)), container);
  return container;
}

function renderVoiceOptions(overrides: Partial<ChatRealtimeTalkOptionsProps> = {}) {
  const container = document.createElement("div");
  render(
    renderRealtimeTalkOptions({
      realtimeTalkOptions: {
        model: "",
        voice: "",
        vadThreshold: "",
      },
      onRealtimeTalkOptionsChange: () => undefined,
      onRealtimeTalkInputRefresh: () => undefined,
      onRealtimeTalkInputSelect: () => undefined,
      ...overrides,
    }),
    container,
  );
  return container;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("chat compaction divider", () => {
  it("renders checkpoint recovery copy and action", () => {
    const onOpenSessionCheckpoints = vi.fn();
    const container = renderChatView({
      messages: [{ __testDivider: true }],
      onOpenSessionCheckpoints,
    });

    expect(container.querySelector(".chat-divider__label")?.textContent).toBe("Compacted history");
    expect(container.querySelector(".chat-divider__description")?.textContent?.trim()).toBe(
      "The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.",
    );
    const button = container.querySelector<HTMLButtonElement>(".chat-divider__action");
    expect(button?.textContent?.trim()).toBe("Open checkpoints");

    expect(button).toBeInstanceOf(HTMLButtonElement);
    button!.click();

    expect(onOpenSessionCheckpoints).toHaveBeenCalledTimes(1);
  });
});

describe("chat conversation width", () => {
  it("applies a configured width once to the centered transcript frame", () => {
    const container = renderChatView({
      chatMessageMaxWidth: "82%",
      messages: [{ role: "assistant", content: "hello", timestamp: 1 }],
    });
    const chat = container.querySelector<HTMLElement>(".chat");

    expect(chat?.style.getPropertyValue("--chat-thread-max-width")).toBe("82%");
    expect(chat?.style.getPropertyValue("--chat-message-max-width")).toBe("100%");
  });
});

describe("chat history pagination", () => {
  it("renders the auto-load sentinel and a spinner while older history loads", () => {
    const container = renderChatView({
      historyPagination: {
        loading: true,
        manualFallback: false,
        onLoadOlder: () => undefined,
      },
    });
    const threadInner = requireElement(container, ".chat-thread-inner", "chat thread inner");
    const sentinel = requireElement(container, ".chat-history-sentinel", "history sentinel");

    expect(threadInner.firstElementChild).toBe(sentinel);
    expect(sentinel.querySelector(".session-run-spinner")).not.toBeNull();
    expect(sentinel.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      t("common.loading"),
    );
    expect(sentinel.querySelector("button")).toBeNull();
  });

  it("keeps a manual button only when IntersectionObserver is unavailable", () => {
    const onLoadOlder = vi.fn();
    const container = renderChatView({
      historyPagination: {
        loading: false,
        manualFallback: true,
        onLoadOlder,
      },
    });
    const button = requireElement(
      container,
      ".chat-history-fallback",
      "history fallback",
    ) as HTMLButtonElement;

    expect(button.textContent?.trim()).toBe(t("chat.loadOlder"));
    button.click();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});

describe("direct thread avatar mode", () => {
  function sessionsListWithKind(sessionKey: string, kind: "direct" | "group" | "global") {
    return {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: 200_000 },
      sessions: [{ key: sessionKey, kind, updatedAt: 1 }],
    };
  }

  const labeledHistory = [
    { role: "user", content: "hi", timestamp: 1 },
    { role: "assistant", content: "hello", timestamp: 2 },
    { role: "user", content: "me too", senderLabel: "Mario", timestamp: 3 },
  ];

  it("classifies by canonical session kind even when DM rows carry sender labels", () => {
    const direct = renderChatView({
      sessionKey: "kind-direct",
      sessions: sessionsListWithKind("kind-direct", "direct"),
      messages: labeledHistory,
    });
    expect(
      requireElement(direct, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(true);

    const group = renderChatView({
      sessionKey: "kind-group",
      sessions: sessionsListWithKind("kind-group", "group"),
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(group, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(false);
  });

  it("keeps avatars in global sessions, which can aggregate group senders", () => {
    const globalThread = renderChatView({
      sessionKey: "global",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(globalThread, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(false);
  });

  it("matches session metadata across equivalent alias keys", () => {
    // Default session travels as "main" or "agent:main:main" depending on caller.
    const aliased = renderChatView({
      sessionKey: "main",
      sessions: sessionsListWithKind("agent:main:main", "direct"),
      messages: labeledHistory,
    });
    expect(
      requireElement(aliased, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(true);
  });

  it("falls back to session-key shape when session metadata is missing", () => {
    // Labeled DM rows must not flip the mode: sanitization labels 1:1 DMs too.
    const direct = renderChatView({
      sessionKey: "agent:main:telegram:direct:2",
      messages: labeledHistory,
    });
    expect(
      requireElement(direct, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(true);

    const group = renderChatView({
      sessionKey: "agent:main:telegram:group:42",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(group, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(false);
  });

  it("keeps avatars when a main alias selects the canonical global row", () => {
    // scope=global: sessions.list only carries the literal "global" row while
    // the pane navigates via agent:<id>:main; the host resolves the alias.
    const aliasedGlobal = renderChatView({
      sessionKey: "agent:work:main",
      sessions: sessionsListWithKind("global", "global"),
      sessionHost: {
        agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
        hello: null,
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(aliasedGlobal, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(false);
  });

  it("classifies global-scope main aliases without a listed global row", () => {
    // The capped list can omit the canonical global row (or it may not exist
    // before the first persisted turn); configured scope alone decides.
    const aliased = renderChatView({
      sessionKey: "agent:work:main",
      sessionHost: {
        agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
        hello: null,
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(aliased, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(false);
  });

  it("ignores stray global rows for main aliases outside global scope", () => {
    // per-sender scope: a listed global row must not reclassify a direct main
    // thread whose exact row is missing from the capped list.
    const direct = renderChatView({
      sessionKey: "agent:work:main",
      sessions: sessionsListWithKind("global", "global"),
      sessionHost: {
        agentsList: { defaultId: "work", mainKey: "main", scope: "per-sender" },
        hello: null,
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(direct, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(true);
  });

  it("prefers the equivalent direct row over a global row for main aliases", () => {
    const sessions = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: 200_000 },
      sessions: [
        { key: "global", kind: "global" as const, updatedAt: 2 },
        { key: "agent:work:main", kind: "direct" as const, updatedAt: 1 },
      ],
    };
    const direct = renderChatView({
      sessionKey: "agent:work:main",
      sessions,
      sessionHost: {
        agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
        hello: null,
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(direct, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(true);
  });

  it("treats explicit agent global keys as global even without a session row", () => {
    const globalAlias = renderChatView({
      sessionKey: "agent:work:global",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(
      requireElement(globalAlias, ".chat-thread", "chat thread").classList.contains(
        "chat-thread--direct",
      ),
    ).toBe(false);
  });
});

describe("chat code-block copy", () => {
  it("copies decoded QR block-art boundary spaces from the delegated button handler", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderChatView();
    const thread = requireElement(container, ".chat-thread", "chat thread");
    const payload = "  ▀▀▀▀  \n  ▄▄▄▄  ";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy";
    button.dataset.code = encodeBlockArtCodeBlockCopyPayload(payload);
    button.dataset.codeEncoding = blockArtCodeBlockCopyPayloadEncoding;
    thread.appendChild(button);

    button.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(payload);
  });

  it("keeps legacy raw data-code payloads copyable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderChatView();
    const thread = requireElement(container, ".chat-thread", "chat thread");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy";
    button.dataset.code = "legacy text";
    thread.appendChild(button);

    button.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("legacy text");
  });

  it("does not decode unmarked raw data-code payloads that start with the block-art prefix", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderChatView();
    const thread = requireElement(container, ".chat-thread", "chat thread");
    const payload = 'openclaw:block-art-code:"literal"';
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy";
    button.dataset.code = payload;
    thread.appendChild(button);

    button.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(payload);
  });
});

describe("chat history render window", () => {
  it("starts freshly loaded large histories with a small render window", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));

    renderChatView({ messages });

    expect(buildChatItemsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages,
        historyRenderLimit: 30,
      }),
    );
  });

  it("expands the history render window when the user scrolls to the top", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));
    const onRequestUpdate = vi.fn();
    const onChatScroll = vi.fn();

    const container = renderChatView({ messages, onRequestUpdate, onChatScroll });
    const thread = requireElement(container, ".chat-thread", "chat thread") as HTMLElement;
    thread.scrollTop = 120;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(onRequestUpdate).toHaveBeenCalledTimes(1);
    expect(onChatScroll).toHaveBeenCalledTimes(2);

    buildChatItemsMock.mockClear();
    renderChatView({ messages, onRequestUpdate, onChatScroll });

    expect(buildChatItemsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages,
        historyRenderLimit: 60,
      }),
    );
  });

  it("preserves the visible anchor across repeated top-scroll expansion", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));
    const onRequestUpdate = vi.fn();
    const onChatScroll = vi.fn();
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const container = renderChatView({ messages, onRequestUpdate, onChatScroll });
    const thread = requireElement(container, ".chat-thread", "chat thread") as HTMLElement;
    Object.defineProperties(thread, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    });
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));

    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 600 });
    buildChatItemsMock.mockClear();
    renderChatView({ messages, onRequestUpdate, onChatScroll });

    expect(buildChatItemsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages,
        historyRenderLimit: 60,
      }),
    );
    const firstExpandedThread = requireElement(
      container,
      ".chat-thread",
      "chat thread",
    ) as HTMLElement;
    Object.defineProperties(firstExpandedThread, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
    });
    for (const callback of frameCallbacks.splice(0)) {
      callback(0);
    }
    expect(firstExpandedThread.scrollTop).toBe(300);

    firstExpandedThread.scrollTop = 0;
    firstExpandedThread.dispatchEvent(new Event("scroll", { bubbles: true }));

    buildChatItemsMock.mockClear();
    renderChatView({ messages, onRequestUpdate, onChatScroll });

    expect(buildChatItemsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages,
        historyRenderLimit: 80,
      }),
    );
    const secondExpandedThread = requireElement(
      container,
      ".chat-thread",
      "chat thread",
    ) as HTMLElement;
    Object.defineProperties(secondExpandedThread, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 900 },
    });
    for (const callback of frameCallbacks.splice(0)) {
      callback(0);
    }
    expect(secondExpandedThread.scrollTop).toBe(300);
    expect(onRequestUpdate).toHaveBeenCalledTimes(2);
    expect(onChatScroll).toHaveBeenCalledTimes(2);
  });

  it("does not expand the history render window for bottom auto-scrolls inside the top threshold", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));
    const onRequestUpdate = vi.fn();
    const onChatScroll = vi.fn();

    const container = renderChatView({ messages, onRequestUpdate, onChatScroll });
    const thread = requireElement(container, ".chat-thread", "chat thread") as HTMLElement;
    thread.scrollTop = 30;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(onRequestUpdate).not.toHaveBeenCalled();
    expect(onChatScroll).toHaveBeenCalledTimes(1);

    buildChatItemsMock.mockClear();
    const rerenderedContainer = renderChatView({ messages, onRequestUpdate, onChatScroll });

    expect(buildChatItemsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages,
        historyRenderLimit: 30,
      }),
    );

    const rerenderedThread = requireElement(
      rerenderedContainer,
      ".chat-thread",
      "chat thread",
    ) as HTMLElement;
    rerenderedThread.scrollTop = 0;
    rerenderedThread.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(onRequestUpdate).toHaveBeenCalledTimes(1);
    expect(onChatScroll).toHaveBeenCalledTimes(2);
  });

  it("expands the history render window when the thread is already at the top", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));
    const onRequestUpdate = vi.fn();
    const onChatScroll = vi.fn();

    const container = renderChatView({ messages, onRequestUpdate, onChatScroll });
    const thread = requireElement(container, ".chat-thread", "chat thread") as HTMLElement;
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(onRequestUpdate).toHaveBeenCalledTimes(1);
    expect(onChatScroll).toHaveBeenCalledTimes(1);
  });

  it("expands the render window after render when the initial window cannot scroll", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));
    const onRequestUpdate = vi.fn();
    const onScrollToBottom = vi.fn();
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    renderChatView({ messages, onRequestUpdate, onScrollToBottom });

    expect(buildChatItemsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages,
        historyRenderLimit: 30,
      }),
    );
    expect(frameCallbacks).toHaveLength(1);

    itemAt(frameCallbacks, 0, "history growth frame")(0);

    expect(onRequestUpdate).toHaveBeenCalledTimes(1);
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);

    buildChatItemsMock.mockClear();
    renderChatView({ messages, onRequestUpdate, onScrollToBottom });

    expect(buildChatItemsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages,
        historyRenderLimit: 60,
      }),
    );
  });
});

describe("chat goal status", () => {
  function goalSessions(goal: Partial<NonNullable<GatewaySessionRow["goal"]>> = {}) {
    return createSessionsResultFromRows([
      {
        key: "main",
        kind: "direct",
        updatedAt: 2,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "Land the web goal UI",
          status: "active",
          createdAt: Date.now() - 15_000,
          updatedAt: 2,
          tokenStart: 100,
          tokensUsed: 12_400,
          tokenBudget: 50_000,
          continuationTurns: 0,
          ...goal,
        },
      },
    ]);
  }

  it("renders the goal pill with status, objective, and elapsed time", () => {
    const container = renderChatView({ sessions: goalSessions() });

    const goal = container.querySelector(".agent-chat__goal");
    expect(goal?.querySelector(".agent-chat__goal-label")?.textContent).toBe("Pursuing goal");
    expect(goal?.querySelector(".agent-chat__goal-objective")?.textContent).toBe(
      "Land the web goal UI",
    );
    expect(goal?.querySelector(".agent-chat__goal-elapsed")?.textContent).toBe("15s");
    expect(goal?.getAttribute("aria-label")).toBe("Pursuing goal (12k/50k): Land the web goal UI");
    expect(goal?.closest(".agent-chat__composer-status-stack")).not.toBeNull();
  });

  it("dispatches goal commands from the pill controls", () => {
    const onGoalCommand = vi.fn();
    const container = renderChatView({ sessions: goalSessions(), onGoalCommand });

    container.querySelector<HTMLButtonElement>('button[aria-label="Pause goal"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Clear goal"]')?.click();

    expect(onGoalCommand).toHaveBeenNthCalledWith(1, "/goal pause");
    expect(onGoalCommand).toHaveBeenNthCalledWith(2, "/goal clear");
    expect(container.querySelector('button[aria-label="Resume goal"]')).toBeNull();
  });

  it("offers resume instead of pause for paused goals", () => {
    const onGoalCommand = vi.fn();
    const container = renderChatView({
      sessions: goalSessions({ status: "paused", pausedAt: Date.now() }),
      onGoalCommand,
    });

    expect(container.querySelector('button[aria-label="Pause goal"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('button[aria-label="Resume goal"]')?.click();
    expect(onGoalCommand).toHaveBeenCalledWith("/goal resume");
  });

  it("prefills the composer draft when editing the goal", () => {
    const onDraftChange = vi.fn();
    const container = renderChatView({
      sessions: goalSessions(),
      onGoalCommand: vi.fn(),
      onDraftChange,
    });

    container.querySelector<HTMLButtonElement>('button[aria-label="Edit goal"]')?.click();

    expect(onDraftChange).toHaveBeenCalledWith("/goal edit Land the web goal UI");
  });

  it("expands goal details on demand", () => {
    const props = createChatProps({
      sessions: goalSessions({ lastStatusNote: "Waiting for CI" }),
      onGoalCommand: vi.fn(),
    });
    const container = document.createElement("div");
    render(renderChat(props), container);

    expect(container.querySelector(".agent-chat__goal-detail")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show goal details"]',
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.click();
    render(renderChat(props), container);

    const detail = container.querySelector(".agent-chat__goal-detail");
    expect(detail?.querySelector(".agent-chat__goal-detail-objective")?.textContent).toBe(
      "Land the web goal UI",
    );
    expect(detail?.querySelector(".agent-chat__goal-detail-note")?.textContent).toBe(
      "Waiting for CI",
    );
    expect(detail?.querySelector(".agent-chat__goal-detail-meta")?.textContent?.trim()).toBe(
      "12k/50k · 15s",
    );
    expect(
      container
        .querySelector('button[aria-label="Hide goal details"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("hides goal action buttons when the composer cannot send", () => {
    const container = renderChatView({
      sessions: goalSessions(),
      onGoalCommand: vi.fn(),
      connected: false,
    });

    expect(container.querySelector('button[aria-label="Pause goal"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Show goal details"]')).not.toBeNull();
  });
});

describe("chat scroll-to-bottom affordance", () => {
  it("renders a centered icon button above the composer when the transcript is away from latest", () => {
    const onScrollToBottom = vi.fn();
    const container = renderChatView({ showNewMessages: true, onScrollToBottom });

    const button = container.querySelector<HTMLButtonElement>(".chat-scroll-to-bottom");
    const wrapper = button?.closest(".chat-scroll-to-bottom-wrap");
    expect(button?.getAttribute("aria-label")).toBe("Scroll to latest");
    expect(wrapper?.previousElementSibling?.classList.contains("chat-thread")).toBe(true);
    expect(wrapper?.nextElementSibling?.classList.contains("agent-chat__composer-shell")).toBe(
      true,
    );
    expect(button?.textContent?.trim()).toBe("");
    expect(container.querySelector(".chat-new-messages")).toBeNull();

    button?.click();

    expect(onScrollToBottom).toHaveBeenCalledWith({ smooth: true });
  });

  it("keeps the button above a variable-height footer stack", () => {
    const container = renderChatView({
      showNewMessages: true,
      queue: [
        { id: "queued-1", text: "first queued message", createdAt: 1 },
        { id: "queued-2", text: "second queued message", createdAt: 2 },
      ],
    });

    const wrapper = container.querySelector(".chat-scroll-to-bottom-wrap");
    const queue = container.querySelector(".chat-queue");
    expect(wrapper?.nextElementSibling).toBe(queue);
    expect(queue?.nextElementSibling?.classList.contains("agent-chat__composer-shell")).toBe(true);
  });

  it("hides the scroll-to-bottom button when the transcript is already latest", () => {
    const container = renderChatView({ showNewMessages: false });

    expect(container.querySelector(".chat-scroll-to-bottom")).toBeNull();
  });
});

describe("chat composer workbench", () => {
  it("queues ordinary input offline while keeping live commands disabled", () => {
    const onSend = vi.fn();
    const container = renderChatView({
      connected: false,
      draft: "queue this offline",
      getDraft: () => "queue this offline",
      onSend,
    });

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>(".agent-chat__file-input")?.disabled).toBe(
      false,
    );
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(send?.disabled).toBe(false);
    send?.click();
    expect(onSend).toHaveBeenCalledTimes(1);

    const commandContainer = renderChatView({ connected: false, draft: "/status" });
    expect(
      commandContainer.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.disabled,
    ).toBe(true);
  });

  it("renders session controls in the composer and workspace files in the expanded rail", () => {
    const onToggleCollapsed = vi.fn();
    const onRefresh = vi.fn();
    const onBrowsePath = vi.fn();
    const onCopyPath = vi.fn();
    const onOpenFile = vi.fn();
    const onSearch = vi.fn();
    const container = renderChatView({
      composerControls: html`<button class="test-composer-control">Model</button>`,
      sessionWorkspace: {
        collapsed: false,
        sessionKey: "agent:main",
        list: {
          sessionKey: "agent:main",
          root: "/workspace",
          files: [
            {
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              kind: "modified",
              missing: false,
              size: 2048,
            },
          ],
          browser: {
            path: "",
            entries: [
              {
                name: "ui",
                path: "ui",
                kind: "directory",
                sessionKind: "modified",
              },
              {
                name: "package.json",
                path: "package.json",
                kind: "file",
                size: 4096,
              },
            ],
          },
          artifacts: [],
        },
        loading: false,
        error: null,
        activeId: "file:/workspace/AGENTS.md",
        dock: "right",
        narrowLayout: false,
        dockDragging: false,
        dockDragZone: null,
        onToggleCollapsed,
        onSetDock: () => undefined,
        onDockDragStart: () => undefined,
        onRefresh,
        onBrowsePath,
        onCopyPath,
        onOpenFile,
        onSearch,
        onOpenArtifact: () => undefined,
      },
    });

    const composerControl = container.querySelector(
      ".agent-chat__composer-controls .test-composer-control",
    );
    expect(composerControl).not.toBeNull();
    expect(composerControl?.closest(".agent-chat__composer-footer")).not.toBeNull();
    expect(container.querySelector(".agent-chat__composer-header")).toBeNull();
    const workbench = container.querySelector(".chat-workbench");
    const main = container.querySelector(".chat-workbench__main");
    const rail = container.querySelector(".chat-workspace-rail");
    expect(main?.parentElement).toBe(workbench);
    expect(rail?.parentElement).toBe(workbench);
    expect(Array.from(workbench?.children ?? []).map((child) => child.className)).toEqual([
      "chat-workspace-rail",
      "chat-workbench__main",
    ]);
    expect(container.querySelector(".chat-workspace-rail__path")?.textContent?.trim()).toBe(
      "/workspace",
    );
    const file = container.querySelector<HTMLDivElement>(".chat-workspace-rail__file");
    expect(file?.textContent).toContain("AGENTS.md");
    expect(file?.textContent).toContain("2 KB");
    expect(container.querySelector(".chat-workspace-rail__summary")?.textContent).toContain(
      "1 changed",
    );
    expect(container.querySelector(".chat-workspace-rail__browser")?.textContent).toContain(
      "package.json",
    );

    file?.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")?.click();
    file?.querySelector<HTMLButtonElement>('button[aria-label="Copy path"]')?.click();
    const browserDirectory = Array.from(
      container.querySelectorAll<HTMLDivElement>(".chat-workspace-rail__file"),
    ).find((row) => row.textContent?.includes("ui"));
    browserDirectory?.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")?.click();
    const browserFile = Array.from(
      container.querySelectorAll<HTMLDivElement>(".chat-workspace-rail__file"),
    ).find((row) => row.textContent?.includes("package.json"));
    const browserFileButton = browserFile?.querySelector<HTMLButtonElement>(
      ".chat-workspace-rail__file-open",
    );
    expect(browserFileButton?.disabled).toBe(false);
    browserFileButton?.click();
    const collapseToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse session workspace"]',
    );
    expect(collapseToggle?.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+B");
    collapseToggle?.click();

    expect(onOpenFile).toHaveBeenCalledWith("/workspace/AGENTS.md", "session");
    expect(onOpenFile).toHaveBeenCalledWith("package.json", "workspace");
    expect(onCopyPath).toHaveBeenCalledWith("/workspace/AGENTS.md");
    expect(onBrowsePath).toHaveBeenCalledWith("ui");
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Session workspace"]')).toBeNull();
  });

  it("renders no rail strip while collapsed and reopens via the floating toggle", () => {
    const onToggleCollapsed = vi.fn();
    const container = renderChatView({
      sessionWorkspace: {
        collapsed: true,
        sessionKey: "agent:main",
        list: {
          sessionKey: "agent:main",
          root: "/workspace",
          files: [
            {
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              kind: "modified",
              missing: false,
              size: 2048,
            },
          ],
          browser: { path: "", entries: [] },
          artifacts: [],
        },
        loading: false,
        error: null,
        activeId: null,
        dock: "right",
        narrowLayout: false,
        dockDragging: false,
        dockDragZone: null,
        onToggleCollapsed,
        onSetDock: () => undefined,
        onDockDragStart: () => undefined,
        onRefresh: () => undefined,
        onBrowsePath: () => undefined,
        onCopyPath: () => undefined,
        onOpenFile: () => undefined,
        onSearch: () => undefined,
        onOpenArtifact: () => undefined,
      },
    });

    // A collapsed rail renders nothing — no icon strip in the layout.
    expect(container.querySelector(".chat-workspace-rail")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(".chat-workspace-toggle");
    expect(toggle?.getAttribute("aria-label")).toBe("Show session files");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+B");
    expect(toggle?.querySelector(".chat-workspace-toggle__badge")?.textContent?.trim()).toBe("1");

    toggle?.click();

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("renders the split-view opener in the floating toggle cluster", () => {
    const onOpenSplitView = vi.fn();
    const container = renderChatView({ onOpenSplitView });

    const cluster = container.querySelector(".chat-floating-toggles");
    const opener = cluster?.querySelector<HTMLButtonElement>(".chat-open-split-view");
    expect(opener?.getAttribute("aria-label")).toBe("Open split view");

    opener?.click();
    expect(onOpenSplitView).toHaveBeenCalledTimes(1);
  });

  it("hides the split-view opener while the detail sidebar is open", () => {
    const container = renderChatView({
      onOpenSplitView: () => undefined,
      sidebarOpen: true,
      sidebarContent: { kind: "markdown", content: "detail" },
      onCloseSidebar: () => undefined,
    });

    expect(container.querySelector(".chat-open-split-view")).toBeNull();
  });

  it("suppresses the floating workspace toggle when a pane header hosts it", () => {
    const container = renderChatView({
      paneHeaderActive: true,
      sessionWorkspace: {
        collapsed: true,
        sessionKey: "agent:main",
        list: null,
        loading: false,
        error: null,
        activeId: null,
        dock: "right",
        narrowLayout: false,
        dockDragging: false,
        dockDragZone: null,
        onToggleCollapsed: () => undefined,
        onSetDock: () => undefined,
        onDockDragStart: () => undefined,
        onRefresh: () => undefined,
        onBrowsePath: () => undefined,
        onCopyPath: () => undefined,
        onOpenFile: () => undefined,
        onSearch: () => undefined,
        onOpenArtifact: () => undefined,
      },
    });

    expect(container.querySelector(".chat-workspace-toggle")).toBeNull();
    expect(container.querySelector(".chat-workspace-rail")).toBeNull();
  });

  it("stacks the detail sidebar under the thread with a horizontal divider on narrow panes", () => {
    const sidebarProps = {
      sidebarOpen: true,
      sidebarContent: { kind: "markdown", content: "Stacked detail" } as const,
      onCloseSidebar: () => undefined,
    };
    const wide = renderChatView(sidebarProps);
    const wideContainer = wide.querySelector(".chat-split-container");
    expect(wideContainer?.classList.contains("chat-split-container--open")).toBe(true);
    expect(wideContainer?.classList.contains("chat-split-container--stacked")).toBe(false);
    // Attribute reflection is async; the property binding lands synchronously.
    expect(wide.querySelector("resizable-divider")?.orientation).toBe("vertical");

    const stacked = renderChatView({ ...sidebarProps, sidebarStacked: true });
    const stackedContainer = stacked.querySelector(".chat-split-container");
    expect(stackedContainer?.classList.contains("chat-split-container--stacked")).toBe(true);
    expect(stacked.querySelector("resizable-divider")?.orientation).toBe("horizontal");
  });

  it("forces the workspace rail to the bottom dock and drops side-dock controls on narrow panes", () => {
    const container = renderChatView({
      sessionWorkspace: {
        collapsed: false,
        sessionKey: "agent:main",
        list: null,
        loading: false,
        error: null,
        activeId: null,
        dock: "right",
        narrowLayout: true,
        dockDragging: false,
        dockDragZone: null,
        onToggleCollapsed: () => undefined,
        onSetDock: () => undefined,
        onDockDragStart: () => undefined,
        onRefresh: () => undefined,
        onBrowsePath: () => undefined,
        onCopyPath: () => undefined,
        onOpenFile: () => undefined,
        onSearch: () => undefined,
        onOpenArtifact: () => undefined,
      },
    });

    const workbench = container.querySelector(".chat-workbench");
    expect(workbench?.classList.contains("chat-workbench--dock-bottom")).toBe(true);
    expect(container.querySelector(".chat-workspace-rail")).not.toBeNull();
    expect(container.querySelector(".chat-workspace-rail__dock")).toBeNull();
    expect(container.querySelector(".chat-workspace-rail__grip")).toBeNull();
  });

  it("moves the background-tasks rail to a bottom strip on narrow panes", () => {
    const backgroundTasks = {
      agentId: "main",
      collapsed: false,
      narrowLayout: false,
      connected: true,
      canCancel: false,
      loading: false,
      error: null,
      tasks: [],
      cancellingTaskIds: new Set<string>(),
      finishedCollapsed: false,
      onToggleCollapsed: () => undefined,
      onToggleFinished: () => undefined,
      onRefresh: () => undefined,
      onCancel: () => undefined,
      onOpenSession: () => undefined,
    };

    const wide = renderChatView({ backgroundTasks });
    const wideWorkbench = wide.querySelector(".chat-workbench");
    expect(wideWorkbench?.classList.contains("chat-workbench--tasks-open")).toBe(true);
    expect(wideWorkbench?.classList.contains("chat-workbench--tasks-dock-bottom")).toBe(false);

    const narrow = renderChatView({ backgroundTasks: { ...backgroundTasks, narrowLayout: true } });
    const narrowWorkbench = narrow.querySelector(".chat-workbench");
    expect(narrowWorkbench?.classList.contains("chat-workbench--tasks-open")).toBe(false);
    expect(narrowWorkbench?.classList.contains("chat-workbench--tasks-dock-bottom")).toBe(true);
    expect(narrow.querySelector(".chat-tasks-rail")).not.toBeNull();
  });

  it("keeps the secondary New session and Export controls suppressed in the composer", () => {
    const container = renderChatView({
      messages: [{ role: "assistant", content: "ready" }],
    });

    const labels = Array.from(container.querySelectorAll(".agent-chat__composer-shell button")).map(
      (button) => button.getAttribute("aria-label"),
    );
    expect(labels).not.toContain(t("chat.runControls.newSession"));
    expect(labels).not.toContain(t("chat.runControls.exportChat"));
  });

  it("uses the primary action for voice without a separate voice settings button", () => {
    const container = renderChatView({
      onToggleRealtimeTalk: () => undefined,
    });

    const voiceButton = container.querySelector('button[aria-label="Start voice input"]');
    expect(voiceButton).not.toBeNull();
    expect(voiceButton?.closest(".agent-chat__composer-input-row")).not.toBeNull();
    expect(container.querySelector('button[aria-label="Talk settings"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Microphone input"]')).toBeNull();
  });
});

afterEach(() => {
  vi.useRealTimers();
  buildChatItemsMock.mockClear();
  renderMessageGroupMock.mockClear();
  assistantAttachmentRenderVersionMock.value = 0;
  refreshVisibleToolsEffectiveForCurrentSessionMock.mockClear();
  resetChatViewState();
  resetChatAttachmentPayloadStoreForTest();
  vi.unstubAllGlobals();
});

describe("per-pane chat presentation state", () => {
  it("keeps slash menus independent and resets only the targeted pane", () => {
    const paneA = document.createElement("div");
    const paneB = document.createElement("div");
    const renderPane = (container: HTMLElement, paneId: string, draft: string) => {
      render(renderChat(createChatProps({ paneId, draft, getDraft: () => draft })), container);
    };
    const openSlashMenu = (container: HTMLElement) => {
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      if (!textarea) {
        throw new Error("expected composer textarea");
      }
      textarea.value = "/";
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    };

    renderPane(paneA, "pane-a", "");
    renderPane(paneB, "pane-b", "");
    openSlashMenu(paneA);
    renderPane(paneA, "pane-a", "/");

    expect(paneA.querySelector(".slash-menu")).not.toBeNull();
    expect(paneB.querySelector(".slash-menu")).toBeNull();

    openSlashMenu(paneB);
    renderPane(paneB, "pane-b", "/");
    expect(paneA.querySelector(".slash-menu")?.id).toBe("chat-pane-a-slash-menu-listbox");
    expect(paneB.querySelector(".slash-menu")?.id).toBe("chat-pane-b-slash-menu-listbox");
    resetChatComposerState("pane-a");
    renderPane(paneA, "pane-a", "/");

    expect(paneA.querySelector(".slash-menu")).toBeNull();
    expect(paneB.querySelector(".slash-menu")).not.toBeNull();
  });

  it("keeps thread search independent and resets only the targeted pane", () => {
    toggleChatThreadSearch("pane-a", vi.fn());
    expect(isChatThreadSearchOpen("pane-a")).toBe(true);
    expect(isChatThreadSearchOpen("pane-b")).toBe(false);

    toggleChatThreadSearch("pane-b", vi.fn());
    resetChatThreadPresentationState("pane-a");

    expect(isChatThreadSearchOpen("pane-a")).toBe(false);
    expect(isChatThreadSearchOpen("pane-b")).toBe(true);
  });
});

describe("chat transcript rendering cache", () => {
  it("rerenders transcript groups when assistant attachment availability changes", () => {
    const messages = [{ role: "assistant", content: "ready" }];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const queue: ChatQueueItem[] = [];
    const container = document.createElement("div");

    render(
      renderChat(createChatProps({ messages, toolMessages, streamSegments, queue })),
      container,
    );
    assistantAttachmentRenderVersionMock.value += 1;
    render(
      renderChat(createChatProps({ messages, toolMessages, streamSegments, queue, draft: "h" })),
      container,
    );

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(2);
  });

  it("passes assistant attachment load callbacks to transcript groups", () => {
    const onAssistantAttachmentLoaded = vi.fn();

    renderChatView({
      messages: [{ role: "assistant", content: "MEDIA:https://example.com/voice.ogg" }],
      onAssistantAttachmentLoaded,
    });

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(1);
    expect(renderMessageGroupMock.mock.calls[0]?.[1]).toMatchObject({
      onAssistantAttachmentLoaded,
    });
  });

  it("rebuilds transcript items when the transcript reference changes", () => {
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const queue: ChatQueueItem[] = [];

    renderChatView({
      messages: [{ role: "assistant", content: "ready" }],
      toolMessages,
      streamSegments,
      queue,
      draft: "",
    });
    renderChatView({
      messages: [{ role: "assistant", content: "new reply" }],
      toolMessages,
      streamSegments,
      queue,
      draft: "",
    });

    expect(buildChatItemsMock).toHaveBeenCalledTimes(2);
  });
});

describe("chat loading skeleton", () => {
  it("renders realtime Talk transcript as ordered voice turns", () => {
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkConversation: [
        { id: "u1", role: "user", text: "Turn off the lights", isStreaming: false },
        { id: "a1", role: "assistant", text: "Checking", isStreaming: true },
        { id: "u2", role: "user", text: "Second request", isStreaming: false },
      ],
    });

    const turns = [...container.querySelectorAll(".agent-chat__voice-turn")];
    expect(turns.map((turn) => turn.getAttribute("data-role"))).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(turns.map((turn) => turn.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "You Turn off the lights",
      "Val Checking",
      "You Second request",
    ]);
    expect(container.querySelector(".chat-thread-inner .agent-chat__voice-turns")).not.toBeNull();
    expect(container.querySelector(".agent-chat__input .agent-chat__voice-turns")).toBeNull();
    expect(container.querySelector(".agent-chat__welcome")).toBeNull();
  });

  it("shows the skeleton while the initial history load has no rendered content", () => {
    const container = renderChatView({ loading: true });

    expect(container.querySelectorAll(".chat-loading-skeleton")).toHaveLength(1);
    expect(container.querySelector(".agent-chat__welcome")).toBeNull();
  });

  it("shows the loading skeleton for an active run with no stream", () => {
    const container = renderChatView({ canAbort: true, loading: true });

    expect(container.querySelector(".chat-loading-skeleton")).not.toBeNull();
    expect(container.querySelectorAll(".chat-reading-indicator")).toHaveLength(0);
    expect(container.querySelector(".agent-chat__welcome")).toBeNull();
  });

  it("shows the reading indicator when an active run has an empty stream", () => {
    const container = renderChatView({ canAbort: true, stream: "" });

    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
  });

  it("keeps the working spark below a rendered response while the run continues", () => {
    const container = renderChatView({
      canAbort: true,
      messages: [
        {
          role: "assistant",
          content: "Finished answer",
          timestamp: 1,
        },
      ],
      stream: null,
    });

    // canAbort with no terminal status means the run is still working (e.g.
    // between tool steps); the spark stays as the "still working" signal.
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
    expect(container.querySelector(".chat-group")?.textContent?.trim()).toBe("Finished answer");
  });

  it("drops the working spark once the run reaches a terminal status", () => {
    const container = renderChatView({
      canAbort: true,
      runStatus: {
        phase: "done",
        runId: "run-1",
        sessionKey: "main",
        occurredAt: Date.now(),
      },
      messages: [
        {
          role: "assistant",
          content: "Finished answer",
          timestamp: 1,
        },
      ],
      stream: null,
    });

    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
  });

  it("keeps existing messages visible without the skeleton during a background reload", () => {
    const container = renderChatView({
      loading: true,
      messages: [
        {
          role: "assistant",
          content: "Already loaded answer",
          timestamp: 1,
        },
      ],
    });

    expect(container.querySelector(".chat-loading-skeleton")).toBeNull();
    expect(container.querySelector(".chat-group")?.textContent?.trim()).toBe(
      "Already loaded answer",
    );
  });

  it("keeps active stream content visible without the skeleton during a background reload", () => {
    const container = renderChatView({
      loading: true,
      stream: "Partial streamed answer",
      streamStartedAt: 1,
    });

    expect(container.querySelector(".chat-loading-skeleton")).toBeNull();
    expect(container.querySelector(".chat-stream")?.textContent).toBe("Partial streamed answer");
  });

  it("keeps the reading indicator visible without the skeleton before stream text arrives", () => {
    const container = renderChatView({
      loading: true,
      stream: "",
      streamStartedAt: 1,
    });

    expect(container.querySelector(".chat-loading-skeleton")).toBeNull();
    expect(container.querySelectorAll(".chat-reading-indicator")).toHaveLength(1);
  });

  it("shows prompt-bar progress beside context usage while the current session send is awaiting acknowledgement", () => {
    const container = renderChatView({
      sending: true,
      composerControls: html`<button class="chat-settings-chip" type="button">Settings</button>`,
      queue: [
        {
          id: "send-main",
          text: "hello",
          createdAt: 1,
          sendRunId: "run-main",
          sendState: "sending",
          sessionKey: "main",
        },
      ],
      sessions: {
        ts: 0,
        path: "",
        count: 1,
        defaults: {
          modelProvider: "openai",
          model: "gpt-5.5",
          contextTokens: 200_000,
        },
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: 1,
            totalTokens: 46_000,
            totalTokensFresh: true,
          },
        ],
      },
    });

    // The composer shows no working chrome; the thread spark is the visible
    // signal and the sr-only region carries the phase announcement.
    const context = container.querySelector(".context-ring");
    const contextUsage = context?.closest(".context-usage");
    expect(container.querySelector(".agent-chat__run-status")).toBeNull();
    expect(container.querySelector(".agent-chat__run-status-announcement")?.textContent).toContain(
      "Sending message",
    );
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
    expect(contextUsage?.closest(".agent-chat__composer-meta")).not.toBeNull();
  });

  it("places context usage after the composer controls in the bottom row", () => {
    const container = renderChatView({
      providerUsage: {
        basePath: "/rosita",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
      },
      messages: [
        {
          role: "assistant",
          provider: "openai",
          responseModel: "gpt-5.5",
          cost: { input: 0.001, output: 0.002 },
        },
      ],
      sessions: {
        ts: 0,
        path: "",
        count: 1,
        defaults: {
          modelProvider: "openai",
          model: "gpt-5.5",
          contextTokens: 200_000,
        },
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: 1,
            totalTokens: 46_000,
            totalTokensFresh: true,
          },
        ],
      },
    });

    const context = container.querySelector(".context-ring");
    expect(context).toBeInstanceOf(HTMLElement);
    expect(context?.closest(".agent-chat__composer-meta")).not.toBeNull();
    expect(context?.closest(".agent-chat__composer-footer")).not.toBeNull();
    // The session provider matches a plan-usage group, so dollar estimates
    // yield to the subscription windows.
    expect(container.querySelector(".context-usage__stats--cost")).toBeNull();
    expect(container.querySelector(".context-usage__model")?.textContent).toContain("openai");
    expect(container.querySelector(".agent-chat__composer-header")).toBeNull();
    const limitRow = container.querySelector(".context-usage__limit");
    expect(limitRow?.textContent?.replace(/\s+/g, " ").trim()).toBe("Weekly · all models 72%");
    const usageLink = container.querySelector<HTMLAnchorElement>(
      ".context-usage__popover [data-chat-provider-usage='true']",
    );
    expect(usageLink?.getAttribute("href")).toBe("/rosita/usage");
  });

  it("does not announce progress for another session send", () => {
    const container = renderChatView({
      sessionKey: "session-b",
      sending: true,
      queue: [
        {
          id: "send-a",
          text: "hello from A",
          createdAt: 1,
          sendRunId: "run-a",
          sendState: "sending",
          sessionKey: "session-a",
        },
      ],
    });

    expect(
      container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
    ).toBe("");
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
  });

  it("shows the working spark while the current session send waits for model switching", () => {
    const container = renderChatView({
      queue: [
        {
          id: "send-main",
          text: "hello",
          createdAt: 1,
          sendRunId: "run-main",
          sendState: "waiting-model",
          sessionKey: "main",
        },
      ],
    });

    expect(container.querySelector(".agent-chat__run-status-announcement")?.textContent).toContain(
      "Preparing model",
    );
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
  });

  it("shows active model-switch progress over the previous run's terminal status", () => {
    const container = renderChatView({
      runStatus: {
        phase: "done",
        runId: "run-previous",
        sessionKey: "main",
        occurredAt: 1_000,
      },
      queue: [
        {
          id: "send-main",
          text: "hello",
          createdAt: 999,
          sendRunId: "run-main",
          sendState: "waiting-model",
          sessionKey: "main",
        },
      ],
    });

    expect(container.querySelector(".agent-chat__run-status-announcement")?.textContent).toContain(
      "Preparing model",
    );
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
  });

  it("keeps terminal status for the submitted run while its acknowledgement is pending", () => {
    const occurredAt = Date.now();
    const container = renderChatView({
      runStatus: {
        phase: "done",
        runId: "run-main",
        sessionKey: "main",
        occurredAt,
      },
      queue: [
        {
          id: "send-main",
          text: "hello",
          createdAt: 999,
          sendRunId: "run-main",
          sendState: "sending",
          sessionKey: "main",
        },
      ],
    });

    expect(
      container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
    ).toBe("Done");
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
  });

  it("does not announce progress for reconnect-waiting sends", () => {
    const container = renderChatView({
      queue: [
        {
          id: "send-main",
          text: "hello",
          createdAt: 1,
          sendRunId: "run-main",
          sendState: "waiting-reconnect",
          sessionKey: "main",
        },
      ],
    });

    expect(
      container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
    ).toBe("");
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
  });

  it("lets terminal run status win over stale abortable session UI", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const container = renderChatView({
        canAbort: true,
        runStatus: {
          phase: "done",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 1_000,
        },
        sessions: {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: 200_000 },
          sessions: [
            {
              key: "main",
              kind: "direct",
              updatedAt: null,
              hasActiveRun: true,
              status: "done",
              totalTokens: 190_000,
              contextTokens: 200_000,
            },
          ],
        },
        onCompact: () => undefined,
      });

      expect(
        container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
      ).toBe("Done");
      expect(container.querySelector(".agent-chat__run-status")).toBeNull();
      expect(container.querySelector(".chat-reading-indicator")).toBeNull();
      expect(container.querySelector(".chat-send-btn--stop")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("shows the interrupted toast in the composer footer", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const container = renderChatView({
        composerControls: html`<button class="chat-settings-chip" type="button">Settings</button>`,
        runStatus: {
          phase: "interrupted",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 1_000,
        },
      });

      const toast = container.querySelector(
        ".agent-chat__composer-run-status .agent-chat__run-status--interrupted",
      );
      expect(toast?.textContent).toContain("Interrupted");
      expect(
        container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
      ).toBe("Interrupted");
      expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("chat voice controls", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("keeps voice input visible without a second dictation control", () => {
    const container = renderChatView();

    requireElement(container, '[aria-label="Start voice input"]', "voice input button");
    expect(container.querySelector('[aria-label="Voice input"]')).toBeNull();
  });

  it("stops active voice input without sending a composed draft", () => {
    const onSend = vi.fn();
    const onToggleRealtimeTalk = vi.fn();
    const container = renderChatView({
      draft: "Keep this draft",
      realtimeTalkActive: true,
      onSend,
      onToggleRealtimeTalk,
    });

    const stop = requireElement(
      container,
      '[aria-label="Stop voice input"]',
      "stop voice input button",
    );
    stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleRealtimeTalk).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    ["connecting", "Connecting voice input..."],
    ["listening", "Listening..."],
    ["thinking", "Asking OpenClaw..."],
  ] as const)("renders %s voice activity without visible status copy", (status, label) => {
    const inputLevel = new RealtimeTalkLevelSignal();
    inputLevel.set(0.64);
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: status,
      realtimeTalkInputLevel: inputLevel,
    });

    const stopVoiceButton = container.querySelector('button[aria-label="Stop voice input"]');
    const visualizer = stopVoiceButton?.querySelector<HTMLElement>(
      `.agent-chat__voice-activity[data-status="${status}"]`,
    );
    expect(visualizer?.getAttribute("data-level")).toBe("0.64");
    expect(visualizer?.getAttribute("data-source")).toBe("microphone");
    expect(visualizer?.getAttribute("aria-hidden")).toBe("true");
    expect(visualizer?.querySelectorAll(".agent-chat__voice-activity-bar")).toHaveLength(7);
    const statusRegion = container.querySelector('[role="status"].agent-chat__voice-status');
    expect(statusRegion?.getAttribute("aria-live")).toBe("polite");
    expect(statusRegion?.getAttribute("aria-atomic")).toBe("true");
    expect(statusRegion?.textContent?.trim()).toBe(label);
    expect(container.querySelector(".agent-chat__talk-status")).toBeNull();
  });

  it("keeps the stop control without a live meter when a running session errors", () => {
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "error",
      realtimeTalkDetail: "Microphone unavailable",
    });

    const stopVoiceButton = requireElement(
      container,
      '[aria-label="Stop voice input"]',
      "stop voice input button",
    );
    expect(stopVoiceButton.classList.contains("chat-send-btn--voice-error")).toBe(true);
    expect(stopVoiceButton.querySelector(".agent-chat__voice-activity")).toBeNull();
    expect(container.querySelector(".agent-chat__voice-status")).toBeNull();
    expect(
      container
        .querySelector('[role="alert"].agent-chat__talk-status .agent-chat__talk-status-text')
        ?.textContent?.trim(),
    ).toBe("Microphone unavailable");
  });

  it("clamps the rendered microphone level", () => {
    const inputLevel = new RealtimeTalkLevelSignal();
    inputLevel.set(4);
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkInputLevel: inputLevel,
    });

    expect(container.querySelector(".agent-chat__voice-activity")?.getAttribute("data-level")).toBe(
      "1",
    );
  });

  it("updates microphone bars without rerendering the chat", () => {
    const inputLevel = new RealtimeTalkLevelSignal();
    inputLevel.set(0.2);
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkInputLevel: inputLevel,
    });
    document.body.append(container);
    try {
      const visualizer = container.querySelector<HTMLElement>(".agent-chat__voice-activity");
      const centerBar = visualizer?.querySelector<HTMLElement>(
        ".agent-chat__voice-activity-bar:nth-child(4)",
      );
      const initialScale = centerBar?.style.getPropertyValue("--talk-bar-scale");

      inputLevel.set(0.8);

      expect(visualizer?.getAttribute("data-level")).toBe("0.8");
      expect(centerBar?.style.getPropertyValue("--talk-bar-scale")).not.toBe(initialScale);
    } finally {
      container.remove();
    }
  });

  it("shows every available microphone in Voice settings", () => {
    const onRealtimeTalkInputSelect = vi.fn();
    const container = renderVoiceOptions({
      realtimeTalkInputDevices: [
        { deviceId: "built-in", label: "MacBook Microphone" },
        { deviceId: "usb", label: "USB Audio Interface" },
      ],
      realtimeTalkInputDeviceId: "usb",
      onRealtimeTalkInputSelect,
    });

    const microphone = container.querySelector<HTMLSelectElement>(
      '[data-talk-select="microphone"] select',
    );
    expect(microphone).toBeInstanceOf(HTMLSelectElement);
    expect(
      Array.from(microphone?.options ?? []).map((option) => option.textContent?.trim()),
    ).toEqual(["System default", "MacBook Microphone", "USB Audio Interface"]);
    expect(microphone?.value).toBe("usb");
    if (!(microphone instanceof HTMLSelectElement)) {
      throw new Error("expected microphone select");
    }
    microphone.value = "built-in";
    microphone.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onRealtimeTalkInputSelect).toHaveBeenCalledWith("built-in");
  });

  it("keeps a persisted microphone visible before discovery can name it", () => {
    const container = renderVoiceOptions({
      realtimeTalkInputDeviceId: "persisted-microphone",
    });

    const microphone = container.querySelector<HTMLSelectElement>(
      '[data-talk-select="microphone"] select',
    );
    expect(microphone).toBeInstanceOf(HTMLSelectElement);
    expect(
      Array.from(microphone?.options ?? []).map((option) => ({
        label: option.textContent?.trim(),
        value: option.value,
      })),
    ).toEqual([
      { label: "System default", value: "" },
      { label: "Microphone 1", value: "persisted-microphone" },
    ]);
    expect(microphone?.value).toBe("persisted-microphone");
  });

  it("shows microphone loading, empty, and error states without hiding System default", () => {
    const loading = renderVoiceOptions({
      realtimeTalkInputLoading: true,
      onRealtimeTalkInputSelect: () => undefined,
    });
    expect(loading.textContent).toContain("System default");
    expect(loading.textContent).toContain("Loading microphones");
    expect(loading.textContent).not.toContain("No additional microphones found");

    const empty = renderVoiceOptions({
      onRealtimeTalkInputSelect: () => undefined,
    });
    expect(empty.textContent).toContain("No additional microphones found");

    const error = renderVoiceOptions({
      realtimeTalkInputError: "Microphone access is blocked.",
      onRealtimeTalkInputSelect: () => undefined,
    });
    expect(error.textContent).toContain("Microphone access is blocked.");
  });

  it("renders editable voice launch options", () => {
    const onRealtimeTalkOptionsChange = vi.fn();
    const onOpenRealtimeTalkSettings = vi.fn();
    const container = renderVoiceOptions({
      realtimeTalkOptions: {
        model: "gpt-realtime-2",
        voice: "marin",
        vadThreshold: "0.5",
      },
      onRealtimeTalkOptionsChange,
      onOpenRealtimeTalkSettings,
    });

    const model = container.querySelector<HTMLInputElement>(
      `.agent-chat__talk-options-primary input[placeholder="${t("chat.composer.talkModelAuto")}"]`,
    );
    const sensitivitySelect = container.querySelector<HTMLSelectElement>(
      '[data-talk-select="sensitivity"] select',
    );
    if (sensitivitySelect === null) {
      throw new Error("expected Talk sensitivity select");
    }

    expect(getTalkSelectOptionValues(container, "voice")).toEqual([
      "",
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "sage",
      "shimmer",
      "verse",
      "marin",
      "cedar",
    ]);
    expect(sensitivitySelect.value).toBe("0.5");
    expect(getTalkSelectOptionValues(container, "sensitivity")).toEqual([
      "",
      "0.65",
      "0.5",
      "0.35",
    ]);
    expect(container.textContent).toContain(t("chat.composer.talkSensitivity"));
    expect(container.textContent).toContain(t("chat.composer.talkMoreInSettings"));
    for (const advancedLabel of [
      "Advanced",
      "Provider",
      "Transport",
      "Reasoning",
      "Exact VAD",
      "Pause before send",
      "Lead-in",
    ]) {
      expect(container.textContent).not.toContain(advancedLabel);
    }
    if (model === null) {
      throw new Error("expected Talk model input");
    }
    model.value = "gpt-realtime-mini";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    clickTalkSelectOption(container, "sensitivity", "0.35");
    clickTalkSelectOption(container, "sensitivity", "");

    expect(onRealtimeTalkOptionsChange).toHaveBeenCalledWith({ model: "gpt-realtime-mini" });
    expect(onRealtimeTalkOptionsChange).toHaveBeenCalledWith({ vadThreshold: "0.35" });
    expect(onRealtimeTalkOptionsChange).toHaveBeenCalledWith({ vadThreshold: "" });

    requireElement(container, ".agent-chat__talk-settings-link", "Settings link").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onOpenRealtimeTalkSettings).toHaveBeenCalledOnce();
  });

  it("explains why advanced Talk settings are unavailable without admin scope", () => {
    const onOpenRealtimeTalkSettings = vi.fn();
    const container = renderVoiceOptions({
      realtimeTalkOptions: { model: "", voice: "", vadThreshold: "" },
      canOpenRealtimeTalkSettings: false,
      onRealtimeTalkOptionsChange: () => undefined,
      onOpenRealtimeTalkSettings,
    });

    const settings = requireElement(
      container,
      ".agent-chat__talk-settings-link",
      "disabled advanced Settings link",
    ) as HTMLButtonElement;
    expect(settings.disabled).toBe(true);
    expect(settings.textContent?.trim()).toBe(t("chat.composer.talkAdvancedSettingsRequiresAdmin"));
    expect(settings.title).toContain("operator.admin");
    settings.click();
    expect(onOpenRealtimeTalkSettings).not.toHaveBeenCalled();
  });

  it("renders composer labels from the active locale map", async () => {
    await i18n.setLocale("zh-CN");
    const container = renderChatView();
    const voiceOptions = renderVoiceOptions({
      realtimeTalkOptions: { model: "", voice: "", vadThreshold: "" },
      onRealtimeTalkOptionsChange: () => undefined,
      onOpenRealtimeTalkSettings: () => undefined,
    });
    const startTalkLabel = t("chat.composer.startVoiceInput");

    const talkButton = requireElement(
      container,
      `[aria-label="${startTalkLabel}"]`,
      "localized voice input button",
    );
    const tooltip = talkButton.parentElement as (HTMLElement & { content?: string }) | null;
    expect(talkButton.getAttribute("title")).toBeNull();
    expect(tooltip?.localName).toBe("openclaw-tooltip");
    expect(tooltip?.content).toBe(startTalkLabel);
    expect(talkButton.textContent?.trim()).toBe(startTalkLabel);
    expect(
      voiceOptions.querySelector('[data-talk-select="voice"] > span')?.textContent?.trim(),
    ).toBe(t("chat.composer.talkVoice"));
    expect(
      voiceOptions.querySelector('[data-talk-select="sensitivity"] > span')?.textContent?.trim(),
    ).toBe(t("chat.composer.talkSensitivity"));
    expect(
      voiceOptions.querySelector('[data-talk-select="microphone"] > span')?.textContent?.trim(),
    ).toBe(t("chat.composer.microphoneInput"));
    expect(
      voiceOptions.querySelector<HTMLInputElement>(".agent-chat__talk-options-primary input")
        ?.placeholder,
    ).toBe(t("chat.composer.talkModelAuto"));
    expect(voiceOptions.querySelector(".agent-chat__talk-settings-link")?.textContent?.trim()).toBe(
      t("chat.composer.talkMoreInSettings"),
    );
    requireElement(
      container,
      `[aria-label="${t("chat.composer.addAttachment")}"]`,
      "localized attachment menu",
    );
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholder", { name: "Val" }),
    );
  });

  it("focuses the composer from non-control input chrome", () => {
    const container = renderChatView();
    const composerFooter = requireElement(
      container,
      ".agent-chat__composer-footer",
      "composer footer",
    );
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(textarea, "focus");

    composerFooter.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("keeps composer control clicks on the clicked control", () => {
    const container = renderChatView();
    const attachButton = requireElement(
      container,
      `[aria-label="${t("chat.composer.addAttachment")}"]`,
      "attach button",
    );
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(textarea, "focus");

    attachButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("lets users dismiss Talk start errors", () => {
    const onDismissRealtimeTalkError = vi.fn();
    const container = renderChatView({
      realtimeTalkStatus: "error",
      realtimeTalkDetail: 'Realtime voice provider "openai" is not configured',
      onDismissRealtimeTalkError,
    });

    const talkAlert = container.querySelector('[role="alert"].agent-chat__talk-status');
    expect(talkAlert?.querySelector(".agent-chat__talk-status-text")?.textContent?.trim()).toBe(
      'Realtime voice provider "openai" is not configured',
    );

    const dismiss = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t("chat.composer.dismissVoiceInputError")}"]`,
    );
    expect(dismiss).toBeInstanceOf(HTMLButtonElement);
    dismiss!.click();

    expect(onDismissRealtimeTalkError).toHaveBeenCalledTimes(1);
  });
});

describe("chat composer IME composition", () => {
  it("switches to send on the first composing character without committing the draft", () => {
    const onDraftChange = vi.fn();
    const container = document.createElement("div");
    let props = createChatProps({ onDraftChange });
    const onRequestUpdate = vi.fn(() => {
      render(renderChat(props), container);
    });
    props = { ...props, onRequestUpdate };
    render(renderChat(props), container);
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;

    expect(container.querySelector('button[aria-label="Start voice input"]')).not.toBeNull();

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "d";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Send message"]')).not.toBeNull();

    textarea.value = "当前";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenLastCalledWith("当前");
  });

  it("preserves composing text across host rerenders with stale draft props", () => {
    const onDraftChange = vi.fn();
    const onRequestUpdate = vi.fn();
    const container = document.createElement("div");
    const props = createChatProps({ draft: "", onDraftChange, onRequestUpdate });

    render(renderChat(props), container);
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "dangqian";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);

    render(renderChat({ ...props, draft: "" }), container);

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("dangqian");

    const rerenderedTextarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    rerenderedTextarea.value = "当前";
    rerenderedTextarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenLastCalledWith("当前");
  });

  it("leaves keyboard events to the browser while IME composition is active", () => {
    const onHistoryKeydown = vi.fn(() => ({
      handled: true,
      preventDefault: true,
      restoreCaret: null,
      decision: "handled:history-up" as const,
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: false,
      selectionStart: 0,
      selectionEnd: 0,
      valueLength: 0,
    }));
    const onSend = vi.fn();
    const container = renderChatView({ onHistoryKeydown, onSend });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "dangqian";
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    const arrowEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(enterEvent);
    textarea.dispatchEvent(arrowEvent);

    expect(enterEvent.defaultPrevented).toBe(false);
    expect(arrowEvent.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(onHistoryKeydown).not.toHaveBeenCalled();
  });

  it("invalidates after handled input history navigation", () => {
    const onRequestUpdate = vi.fn();
    const onHistoryKeydown = vi.fn(() => ({
      handled: true,
      preventDefault: true,
      restoreCaret: "up" as const,
      decision: "handled:history-up" as const,
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: true,
      selectionStart: 0,
      selectionEnd: 0,
      valueLength: 0,
    }));
    const container = renderChatView({ onHistoryKeydown, onRequestUpdate });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    const arrowEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(arrowEvent);

    expect(arrowEvent.defaultPrevented).toBe(true);
    expect(onHistoryKeydown).toHaveBeenCalledOnce();
    expect(onRequestUpdate).toHaveBeenCalledOnce();
  });

  it("does not force textarea resize during IME composition", () => {
    const container = renderChatView({});
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;

    // Set a sentinel height to detect unwanted overwrites
    textarea.style.height = "42px";

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "shi";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    textarea.value = "shichang";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

    // Height must stay untouched — no forced reflow during composition
    expect(textarea.style.height).toBe("42px");

    textarea.value = "市场";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    // After composition ends, adjustTextareaHeight runs via syncComposerValue
    expect(textarea.style.height).not.toBe("42px");
  });
});

describe("chat composer sizing", () => {
  it("sizes restored drafts after the rendered value is committed", async () => {
    const container = renderChatView({ draft: "A restored long draft" });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, value: 180 },
      clientHeight: { configurable: true, value: 150 },
    });
    document.body.append(container);

    await Promise.resolve();

    expect(textarea.style.height).toBe("150px");
    expect(textarea.style.overflowY).toBe("auto");
    container.remove();
  });

  it("shows the textarea scrollbar only when the draft overflows", () => {
    const container = renderChatView({});
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    let scrollHeight = 42;
    let clientHeight = 42;
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
    });

    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(textarea.style.height).toBe("42px");
    expect(textarea.style.overflowY).toBe("hidden");

    scrollHeight = 180;
    clientHeight = 150;
    textarea.value = "A long draft";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(textarea.style.height).toBe("150px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("rechecks overflow when responsive layout changes the textarea height", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): ResizeObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const container = renderChatView({});
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    let scrollHeight = 42;
    let clientHeight = 42;
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
    });
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(textarea.style.overflowY).toBe("hidden");

    scrollHeight = 120;
    clientHeight = 56;
    resizeCallback?.([], {} as ResizeObserver);

    expect(textarea.style.overflowY).toBe("auto");
  });
});

describe("chat slash menu accessibility", () => {
  function inputDraft(container: HTMLElement, value: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.value = value;
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function keydownComposer(container: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    const event = new KeyboardEvent("keydown", { ...init, key, bubbles: true, cancelable: true });
    textarea!.dispatchEvent(event);
    return event;
  }

  it("requests slash command hydration only after slash intent", () => {
    const onSlashIntent = vi.fn(async () => undefined);
    const container = renderChatView({ onSlashIntent });

    inputDraft(container, "plain first message");

    expect(onSlashIntent).not.toHaveBeenCalled();

    inputDraft(container, "/");

    expect(onSlashIntent).toHaveBeenCalledTimes(1);
  });

  it("does not reopen slash suggestions when command hydration finishes after plain typing", async () => {
    let draft = "";
    const hydration = createDeferred<void>();
    const onSlashIntent = vi.fn(() => hydration.promise);
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const container = document.createElement("div");
    const renderCurrent = () => {
      render(
        renderChat(
          createChatProps({
            draft,
            getDraft: () => draft,
            onDraftChange,
            onRequestUpdate: renderCurrent,
            onSlashIntent,
          }),
        ),
        container,
      );
    };
    renderCurrent();

    inputDraft(container, "/");
    expect(container.querySelector(".slash-menu")).not.toBeNull();

    inputDraft(container, "plain first message");
    expect(container.querySelector(".slash-menu")).toBeNull();
    hydration.resolve();
    await hydration.promise;
    await Promise.resolve();

    expect(container.querySelector(".slash-menu")).toBeNull();
  });

  it("does not submit a stale slash argument menu after disconnect", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const container = document.createElement("div");
    const renderCurrent = (connected: boolean) => {
      render(
        renderChat(
          createChatProps({
            connected,
            draft,
            getDraft: () => draft,
            onDraftChange,
            onSend,
          }),
        ),
        container,
      );
    };

    renderCurrent(true);
    inputDraft(container, "/tools ");
    renderCurrent(true);
    expect(container.querySelector(".slash-menu")).not.toBeNull();

    renderCurrent(false);
    expect(container.querySelector(".slash-menu")).toBeNull();
    keydownComposer(container, "Enter");

    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("/tools ");
  });

  it("clears the visible local draft immediately when send clears the host draft", () => {
    let draft = "";
    const container = document.createElement("div");
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn(() => {
      draft = "";
    });
    const renderWithDraft = () => {
      render(
        renderChat(createChatProps({ draft, getDraft: () => draft, onDraftChange, onSend })),
        container,
      );
    };

    renderWithDraft();
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    expect(onDraftChange).toHaveBeenCalledWith("submitted message");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
  });

  it("ignores a stale native InputEvent replay after send clears the host draft", () => {
    let draft = "";
    const container = document.createElement("div");
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn(() => {
      draft = "";
    });
    const renderWithDraft = () => {
      render(
        renderChat(createChatProps({ draft, getDraft: () => draft, onDraftChange, onSend })),
        container,
      );
    };

    renderWithDraft();
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    textarea!.value = "submitted message";
    textarea!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "submitted message",
        inputType: "insertText",
      }),
    );

    expect(textarea?.value).toBe("");
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a new same-session draft when a delayed stale replay arrives", () => {
    let draft = "";
    const container = document.createElement("div");
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn(() => {
      draft = "";
    });
    const renderWithDraft = () => {
      render(
        renderChat(createChatProps({ draft, getDraft: () => draft, onDraftChange, onSend })),
        container,
      );
    };

    renderWithDraft();
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    textarea!.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        data: "new draft",
        inputType: "insertText",
      }),
    );
    textarea!.value = "new draft";
    textarea!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "new draft",
        inputType: "insertText",
      }),
    );
    expect(textarea?.value).toBe("new draft");

    textarea!.value = "submitted message";
    textarea!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "submitted message",
        inputType: "insertText",
      }),
    );

    expect(textarea?.value).toBe("new draft");
  });

  it("does not apply a stale submitted draft replay to another session", () => {
    const drafts = {
      "stale-replay-a": "",
      "stale-replay-b": "",
    };
    const onDraftChange = vi.fn((sessionKey: keyof typeof drafts, next: string) => {
      drafts[sessionKey] = next;
    });
    const container = document.createElement("div");
    const renderSession = (sessionKey: keyof typeof drafts) => {
      render(
        renderChat(
          createChatProps({
            currentAgentId: "stale-replay-agent",
            draft: drafts[sessionKey],
            getDraft: () => drafts[sessionKey],
            onDraftChange: (next) => onDraftChange(sessionKey, next),
            onSend: () => {
              drafts[sessionKey] = "";
            },
            sessionKey,
          }),
        ),
        container,
      );
    };

    renderSession("stale-replay-a");
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");

    renderSession("stale-replay-b");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    textarea!.value = "submitted message";
    textarea!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "submitted message",
        inputType: "insertText",
      }),
    );

    expect(textarea?.value).toBe("");
    expect(drafts["stale-replay-b"]).toBe("");
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an intervening session draft with a delayed stale replay", () => {
    const drafts = {
      "delayed-replay-a": "",
      "delayed-replay-b": "",
    };
    const onDraftChange = vi.fn((sessionKey: keyof typeof drafts, next: string) => {
      drafts[sessionKey] = next;
    });
    const container = document.createElement("div");
    const renderSession = (sessionKey: keyof typeof drafts) => {
      render(
        renderChat(
          createChatProps({
            currentAgentId: "delayed-replay-agent",
            draft: drafts[sessionKey],
            getDraft: () => drafts[sessionKey],
            onDraftChange: (next) => onDraftChange(sessionKey, next),
            onSend: () => {
              drafts[sessionKey] = "";
            },
            sessionKey,
          }),
        ),
        container,
      );
    };

    renderSession("delayed-replay-a");
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");

    renderSession("delayed-replay-b");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    textarea!.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        data: "session b draft",
        inputType: "insertText",
      }),
    );
    textarea!.value = "session b draft";
    textarea!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "session b draft",
        inputType: "insertText",
      }),
    );
    expect(textarea?.value).toBe("session b draft");

    textarea!.value = "submitted message";
    textarea!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "submitted message",
        inputType: "insertText",
      }),
    );

    expect(textarea?.value).toBe("session b draft");
    expect(drafts["delayed-replay-b"]).toBe("session b draft");
  });

  it("commits local draft input before Enter sends", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const container = renderChatView({ onDraftChange, onSend });

    inputDraft(container, "send from enter");
    keydownComposer(container, "Enter");

    expect(onDraftChange).toHaveBeenCalledWith("send from enter");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container.querySelector("textarea")?.getAttribute("aria-keyshortcuts")).toBe("Enter");
  });

  it("requires Ctrl or Meta to send in modifier mode", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const container = renderChatView({
      onDraftChange,
      onSend,
      sendShortcut: "modifier-enter",
    });

    inputDraft(container, "compose across lines");
    const plainEnter = keydownComposer(container, "Enter");
    const shiftedEnter = keydownComposer(container, "Enter", { ctrlKey: true, shiftKey: true });

    expect(plainEnter.defaultPrevented).toBe(false);
    expect(shiftedEnter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();

    keydownComposer(container, "Enter", { ctrlKey: true });
    keydownComposer(container, "Enter", { metaKey: true });

    expect(onDraftChange).toHaveBeenCalledWith("compose across lines");
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(container.querySelector("textarea")?.getAttribute("aria-keyshortcuts")).toBe(
      "Control+Enter Meta+Enter",
    );
  });

  it("does not send a modifier shortcut during IME composition", () => {
    const onSend = vi.fn();
    const container = renderChatView({ onSend, sendShortcut: "modifier-enter" });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    keydownComposer(container, "Enter", { ctrlKey: true });
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("commits local draft input on blur", () => {
    const onDraftChange = vi.fn();
    const container = renderChatView({ onDraftChange });

    inputDraft(container, "persist before leaving composer");
    container
      .querySelector<HTMLTextAreaElement>("textarea")!
      .dispatchEvent(new FocusEvent("blur", { bubbles: false }));

    expect(onDraftChange).toHaveBeenCalledWith("persist before leaving composer");
  });

  it("commits plain draft input while a send is active", () => {
    const onDraftChange = vi.fn();
    const container = renderChatView({ onDraftChange, sending: true });

    inputDraft(container, "do not let failed send restore over this");

    expect(onDraftChange).toHaveBeenCalledWith("do not let failed send restore over this");
  });

  it("preserves local draft input across unrelated rerenders", () => {
    const onDraftChange = vi.fn();
    const container = document.createElement("div");

    render(renderChat(createChatProps({ onDraftChange })), container);
    inputDraft(container, "still typing locally");
    render(renderChat(createChatProps({ onDraftChange, loading: true })), container);

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "still typing locally",
    );
  });

  it("replaces local draft input when the host draft changes", () => {
    const onDraftChange = vi.fn();
    const container = document.createElement("div");

    render(renderChat(createChatProps({ onDraftChange, draft: "" })), container);
    inputDraft(container, "still typing locally");
    render(renderChat(createChatProps({ onDraftChange, draft: "history recall" })), container);

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("history recall");
  });

  it("wires command suggestions to the composer with stable active option ids", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let container = renderChatView({ draft, onDraftChange });

    inputDraft(container, "/");
    container = renderChatView({ draft, onDraftChange });

    const wrapper = container.querySelector<HTMLElement>(".agent-chat__composer-combobox");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const listbox = container.querySelector<HTMLElement>("#chat-single-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(wrapper?.hasAttribute("role")).toBe(false);
    expect(wrapper?.hasAttribute("aria-expanded")).toBe(false);
    expect(wrapper?.hasAttribute("aria-haspopup")).toBe(false);
    expect(wrapper?.hasAttribute("aria-controls")).toBe(false);
    expect(textarea?.hasAttribute("role")).toBe(false);
    expect(textarea?.hasAttribute("aria-expanded")).toBe(false);
    expect(textarea?.hasAttribute("aria-haspopup")).toBe(false);
    expect(textarea?.getAttribute("aria-controls")).toBe("chat-single-slash-menu-listbox");
    expect(textarea?.getAttribute("aria-autocomplete")).toBe("list");
    expect(listbox?.getAttribute("role")).toBe("listbox");
    expect(activeId).toMatch(/^chat-single-slash-option-command-/u);
    expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("role")).toBe("option");
  });

  it("updates the active descendant and live announcement during command navigation", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let container = renderChatView({ draft, onDraftChange });

    inputDraft(container, "/");
    container = renderChatView({ draft, onDraftChange });
    const initialActiveId = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");

    keydownComposer(container, "ArrowDown");
    container = renderChatView({ draft, onDraftChange });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const nextActiveId = textarea?.getAttribute("aria-activedescendant");
    const activeOption = nextActiveId
      ? container.querySelector<HTMLElement>(`#${nextActiveId}`)
      : null;
    const status = container.querySelector<HTMLElement>("#chat-single-slash-active-announcement");

    if (!nextActiveId) {
      throw new Error("Expected command navigation to set aria-activedescendant");
    }
    expect(nextActiveId).not.toBe(initialActiveId);
    expect(activeOption?.getAttribute("aria-selected")).toBe("true");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    const announcementText = status?.textContent?.trim();
    if (!announcementText) {
      throw new Error("Expected command navigation to update the live announcement");
    }
    const expectedAnnouncement = [
      activeOption?.querySelector(".slash-menu-name")?.textContent?.trim(),
      activeOption?.querySelector(".slash-menu-args")?.textContent?.trim(),
      activeOption?.querySelector(".slash-menu-desc")?.textContent?.trim(),
    ]
      .filter(Boolean)
      .join(" ");
    expect(announcementText).toBe(expectedAnnouncement);
  });

  it("uses the localized command description in the live announcement", async () => {
    const clearCommand = SLASH_COMMANDS.find((command) => command.name === "clear");
    if (!clearCommand) {
      throw new Error("Expected the clear slash command");
    }
    const originalDescriptionKey = clearCommand.descriptionKey;
    clearCommand.descriptionKey = "common.health";
    await i18n.setLocale("zh-CN");
    try {
      let draft = "";
      const onDraftChange = vi.fn((next: string) => {
        draft = next;
      });
      let container = renderChatView({ draft, onDraftChange });

      inputDraft(container, "/clear");
      container = renderChatView({ draft, onDraftChange });

      const status = container.querySelector<HTMLElement>("#chat-single-slash-active-announcement");
      expect(status?.textContent?.trim()).toBe(`/clear ${t("common.health")}`);
    } finally {
      clearCommand.descriptionKey = originalDescriptionKey;
      await i18n.setLocale("en");
    }
  });

  it("wires fixed argument suggestions with command-and-argument option ids", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let container = renderChatView({ draft, onDraftChange });

    inputDraft(container, "/tools ");
    container = renderChatView({ draft, onDraftChange });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const listbox = container.querySelector<HTMLElement>("#chat-single-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(listbox?.getAttribute("aria-label")).toBe("Command arguments");
    expect(activeId).toBe("chat-single-slash-option-arg-tools-compact");
    expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("aria-selected")).toBe("true");
  });

  it("clears active descendant when suggestions close", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let container = renderChatView({ draft, onDraftChange });

    inputDraft(container, "/");
    container = renderChatView({ draft, onDraftChange });
    const activeDescendant = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");
    if (!activeDescendant) {
      throw new Error("Expected slash suggestions to set aria-activedescendant");
    }

    inputDraft(container, "plain message");
    container = renderChatView({ draft, onDraftChange });

    expect(container.querySelector(".slash-menu")).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.hasAttribute("aria-expanded"),
    ).toBe(false);
    expect(
      container
        .querySelector<HTMLElement>(".agent-chat__composer-combobox")
        ?.hasAttribute("aria-expanded"),
    ).toBe(false);
    expect(
      container
        .querySelector<HTMLTextAreaElement>("textarea")
        ?.hasAttribute("aria-activedescendant"),
    ).toBe(false);
  });
});

describe("chat attachment picker", () => {
  it("highlights only the chat pane receiving a file drag", () => {
    const first = renderChatView();
    const second = renderChatView();
    const firstChat = requireElement(first, "section.card.chat", "first chat drop target");
    const secondChat = requireElement(second, "section.card.chat", "second chat drop target");

    secondChat.dispatchEvent(createDragEvent("dragenter"));

    expect(firstChat.hasAttribute("data-attachment-drop-active")).toBe(false);
    expect(secondChat.hasAttribute("data-attachment-drop-active")).toBe(true);

    secondChat.dispatchEvent(createDragEvent("dragleave"));

    expect(secondChat.hasAttribute("data-attachment-drop-active")).toBe(false);
  });

  it("keeps the file drop overlay stable across nested drag targets", () => {
    const container = renderChatView();
    const chat = requireElement(container, "section.card.chat", "chat drop target");

    chat.dispatchEvent(createDragEvent("dragenter"));
    chat.dispatchEvent(createDragEvent("dragenter"));
    chat.dispatchEvent(createDragEvent("dragleave"));
    expect(chat.hasAttribute("data-attachment-drop-active")).toBe(true);

    chat.dispatchEvent(createDragEvent("dragleave"));
    expect(chat.hasAttribute("data-attachment-drop-active")).toBe(false);

    chat.dispatchEvent(createDragEvent("dragenter", ["application/x-openclaw-session"]));
    expect(chat.hasAttribute("data-attachment-drop-active")).toBe(false);
  });

  it("turns large pasted plain text into a compact attachment", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({
      draft: "intro",
      getDraft: () => "intro",
      onAttachmentsChange,
    });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const pastedText = "large paste\n" + "x".repeat(1100);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: { 0: { type: "text/plain" }, length: 1 },
        getData: (type: string) => (type === "text/plain" ? pastedText : ""),
      },
    });

    const allowed = textarea.dispatchEvent(event);

    expect(allowed).toBe(false);
    await vi.waitFor(() => {
      const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.fileName).toMatch(/^pasted-text-\d+\.txt$/u);
      expect(attachments[0]?.mimeType).toBe("text/plain");
      expect(attachments[0]?.sizeBytes).toBe(new Blob([pastedText]).size);
      expect(
        getChatAttachmentDataUrl(expectDefined(attachments[0], "attachments[0] test invariant")),
      ).toMatch(/^data:text\/plain;base64,/u);
    });
  });

  it("turns large rich-text clipboard content into a text attachment", () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const pastedText = `large rich-text paste ${"x".repeat(1100)}`;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: {
          0: { type: "text/plain" },
          1: { type: "text/html" },
          length: 2,
        },
        getData: (type: string) => (type === "text/plain" ? pastedText : "<p>rich text</p>"),
      },
    });

    expect(textarea.dispatchEvent(event)).toBe(false);
    expect(requireFirstAttachmentsChange(onAttachmentsChange)).toHaveLength(1);
  });

  it("registers a large paste before an immediate send", () => {
    let attachments: ChatAttachment[] = [];
    const onSend = vi.fn(() => {
      expect(attachments).toHaveLength(1);
    });
    const container = renderChatView({
      attachments,
      getAttachments: () => attachments,
      onAttachmentsChange: (next) => {
        attachments = next;
      },
      onSend,
    });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const pastedText = `large paste ${"x".repeat(1100)}`;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: { 0: { type: "text/plain" }, length: 1 },
        getData: (type: string) => (type === "text/plain" ? pastedText : ""),
      },
    });

    textarea.dispatchEvent(pasteEvent);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onSend).toHaveBeenCalledOnce();
  });

  it("merges successive large pastes into the current attachment state", () => {
    let attachments: ChatAttachment[] = [];
    const onAttachmentsChange = vi.fn((next: ChatAttachment[]) => {
      attachments = next;
    });
    const container = renderChatView({
      attachments,
      getAttachments: () => attachments,
      onAttachmentsChange,
    });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const paste = (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          items: { 0: { type: "text/plain" }, length: 1 },
          getData: (type: string) => (type === "text/plain" ? text : ""),
        },
      });
      textarea.dispatchEvent(event);
    };
    const firstText = `first ${"a".repeat(1100)}`;
    const secondText = `second ${"b".repeat(1100)}`;

    paste(firstText);
    paste(secondText);

    expect(attachments).toHaveLength(2);
    expect(attachments.map((attachment) => getChatAttachmentDataUrl(attachment))).toEqual([
      `data:text/plain;base64,${btoa(firstText)}`,
      `data:text/plain;base64,${btoa(secondText)}`,
    ]);
  });

  it("preserves a large paste when a dropped file finishes later", async () => {
    const readers: FileReader[] = [];
    const readAsDataUrl = vi
      .spyOn(FileReader.prototype, "readAsDataURL")
      .mockImplementation(function (this: FileReader) {
        readers.push(this);
      });
    let attachments: ChatAttachment[] = [];
    const onAttachmentsChange = vi.fn((next: ChatAttachment[]) => {
      attachments = next;
    });
    const container = renderChatView({
      attachments,
      getAttachments: () => attachments,
      onAttachmentsChange,
    });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const chat = requireElement(container, "section.card.chat", "chat drop target");
    const pastedText = `large paste ${"x".repeat(1100)}`;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: { 0: { type: "text/plain" }, length: 1 },
        getData: (type: string) => (type === "text/plain" ? pastedText : ""),
      },
    });
    const droppedFile = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", { value: { files: [droppedFile] } });

    try {
      textarea.dispatchEvent(pasteEvent);
      chat.dispatchEvent(dropEvent);

      expect(readers).toHaveLength(1);
      expect(attachments).toHaveLength(1);
      Object.defineProperty(readers[0], "result", {
        configurable: true,
        value: `data:application/pdf;base64,${btoa("%PDF-1.4\n")}`,
      });
      expectDefined(readers[0], "readers[0] test invariant").dispatchEvent(
        new ProgressEvent("load"),
      );

      await vi.waitFor(() => expect(attachments).toHaveLength(2));
      expect(attachments.map((attachment) => attachment.fileName)).toEqual([
        expect.stringMatching(/^pasted-text-\d+\.txt$/u),
        "brief.pdf",
      ]);
    } finally {
      readAsDataUrl.mockRestore();
    }
  });

  it("keeps the default placeholder only for internally generated pasted text", () => {
    let pastedTextAttachments: ChatAttachment[] = [];
    const pasteTarget = renderChatView({
      getAttachments: () => pastedTextAttachments,
      onAttachmentsChange: (next) => {
        pastedTextAttachments = next;
      },
    });
    const textarea = requireElement(
      pasteTarget,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: { 0: { type: "text/plain" }, length: 1 },
        getData: (type: string) => (type === "text/plain" ? `large paste ${"x".repeat(1100)}` : ""),
      },
    });
    textarea.dispatchEvent(event);

    const namedLikePaste = registerChatAttachmentPayload({
      attachment: {
        id: "ordinary-text-file",
        fileName: "pasted-text-1.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
      },
      dataUrl: `data:text/plain;base64,${btoa("file")}`,
      file: new File(["file"], "pasted-text-1.txt", { type: "text/plain" }),
    });
    const imageAttachment: ChatAttachment = {
      id: "image",
      fileName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 2048,
    };

    const textOnly = renderChatView({ attachments: pastedTextAttachments });
    expect(textOnly.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholder", { name: "Val" }),
    );

    const ordinaryTextFile = renderChatView({ attachments: [namedLikePaste] });
    expect(ordinaryTextFile.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholderWithAttachments"),
    );
    expect(ordinaryTextFile.querySelector(".chat-attachment-text-action")).toBeNull();

    const withImage = renderChatView({ attachments: [imageAttachment] });
    expect(withImage.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholderWithAttachments"),
    );
  });

  it("shows a cached short preview for pasted text", () => {
    let attachments: ChatAttachment[] = [];
    let container = renderChatView({
      attachments,
      getAttachments: () => attachments,
      onAttachmentsChange: (next) => {
        attachments = next;
      },
    });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const text = `First words from a long pasted note ${"x".repeat(1100)}`;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: { 0: { type: "text/plain" }, length: 1 },
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
    textarea.dispatchEvent(event);
    container = renderChatView({ attachments });

    expect(container.querySelector(".chat-attachment-file__name")?.textContent).toContain(
      "First words from a l...",
    );
    expect(container.querySelector(".chat-attachment-text-action")?.textContent).toContain(
      "Restore",
    );
  });

  it("keeps normal short plain-text paste in the textarea", () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: { 0: { type: "text/plain" }, length: 1 },
        getData: (type: string) => (type === "text/plain" ? "short paste" : ""),
      },
    });

    const allowed = textarea.dispatchEvent(event);

    expect(allowed).toBe(true);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("moves a pasted text attachment back into the composer", async () => {
    const onAttachmentsChange = vi.fn();
    const firstRender = renderChatView({ onAttachmentsChange });
    const textarea = requireElement(
      firstRender,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const pastedText = "large paste\n" + "x".repeat(1100);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: { 0: { type: "text/plain" }, length: 1 },
        getData: (type: string) => (type === "text/plain" ? pastedText : ""),
      },
    });
    textarea.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(onAttachmentsChange).toHaveBeenCalled();
    });
    const attachment = expectDefined(
      requireFirstAttachmentsChange(onAttachmentsChange)[0],
      "pasted attachment",
    );
    const onDraftChange = vi.fn();
    const onShowAttachmentsChange = vi.fn();
    const preview = expectDefined(
      renderChatView({
        attachments: [attachment],
        draft: "intro",
        getDraft: () => "intro",
        onAttachmentsChange: onShowAttachmentsChange,
        onDraftChange,
      }),
      'renderChatView({ attachments: [attachment], draft: "intro", getDraft:... test invariant',
    );
    const showButton = requireElement(
      preview,
      '[aria-label="Restore"]',
      "show pasted text button",
    ) as HTMLButtonElement;

    showButton.click();

    expect(onShowAttachmentsChange).toHaveBeenCalledWith([]);
    expect(onDraftChange).toHaveBeenCalledWith(`intro\n\n${pastedText}`);
    expect(
      getChatAttachmentDataUrl(expectDefined(attachment, "attachment test invariant")),
    ).toBeNull();
  });

  it("converts pasted data image text into an attachment", () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    );
    const base64 = btoa("png");
    const dataUrl = ` data:image/PNG;base64,${base64.slice(0, 2)}\n${base64.slice(2)} `;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: { length: 0 },
        getData: (type: string) => (type === "text/plain" ? dataUrl : ""),
      },
    });

    const allowed = textarea.dispatchEvent(event);

    expect(allowed).toBe(false);
    const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.fileName).toBe("pasted-image.png");
    expect(attachments[0]?.mimeType).toBe("image/png");
    expect(attachments[0]?.sizeBytes).toBe(3);
    expect(getChatAttachmentDataUrl(itemAt(attachments, 0, "pasted attachment"))).toBe(
      `data:image/png;base64,${base64}`,
    );
  });

  it("removes a pasted image attachment from the preview", () => {
    const attachment: ChatAttachment = {
      id: "image",
      fileName: "pasted-image.png",
      mimeType: "image/png",
      previewUrl: "blob:pasted-image",
      sizeBytes: 3,
    };
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ attachments: [attachment], onAttachmentsChange });
    const removeButton = requireElement(
      container,
      '[aria-label="Remove attachment"]',
      "remove attachment button",
    ) as HTMLButtonElement;

    removeButton.click();

    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
  });

  it("opens the scoped file input from the attachment menu", () => {
    const container = renderChatView();
    const input = requireElement(
      container,
      ".agent-chat__file-input",
      "attachment file input",
    ) as HTMLInputElement;
    const attachButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".agent-chat__attach-menu-option"),
    ).find((button) => button.textContent?.trim() === t("chat.composer.attachFileOption"));
    const clickInput = vi.spyOn(input, "click").mockImplementation(() => undefined);

    expect(attachButton).toBeInstanceOf(HTMLButtonElement);
    attachButton!.click();

    expect(clickInput).toHaveBeenCalledTimes(1);
  });

  it("opens the camera input from the attachment menu and attaches the captured photo", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = requireElement(
      container,
      ".agent-chat__camera-input",
      "camera capture input",
    ) as HTMLInputElement;
    const cameraButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".agent-chat__attach-menu-option"),
    ).find((button) => button.textContent?.trim() === t("chat.composer.takePhoto"));
    const clickInput = vi.spyOn(input, "click").mockImplementation(() => undefined);

    expect(input.accept).toBe("image/*");
    expect(input.getAttribute("capture")).toBe("environment");
    expect(cameraButton).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector(".agent-chat__camera-btn")).toBeNull();
    cameraButton!.click();
    expect(clickInput).toHaveBeenCalledTimes(1);

    const photo = new File(["photo"], "camera.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [photo],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.fileName).toBe("camera.jpg");
      expect(attachments[0]?.mimeType).toBe("image/jpeg");
    });
  });

  it("keeps the camera attachment option available when the composer has text", () => {
    const container = renderChatView({ draft: "Ready to send" });
    const cameraButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".agent-chat__attach-menu-option"),
    ).find((button) => button.textContent?.trim() === t("chat.composer.takePhoto"));

    expect(cameraButton).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector(".agent-chat__camera-btn")).toBeNull();
    expect(container.querySelector('button[aria-label="Send message"]')).not.toBeNull();
  });

  it("accepts and previews non-video file attachments", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = container.querySelector<HTMLInputElement>(".agent-chat__file-input");
    const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });

    expect(input).toBeInstanceOf(HTMLInputElement);
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [file],
    });
    input!.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.fileName).toBe("brief.pdf");
      expect(attachments[0]?.mimeType).toBe("application/pdf");
      expect(attachments[0]?.sizeBytes).toBe(file.size);
    });

    const nextAttachments = requireFirstAttachmentsChange(onAttachmentsChange);
    expect(getChatAttachmentDataUrl(itemAt(nextAttachments, 0, "file attachment"))).toMatch(
      /^data:application\/pdf;base64,/,
    );
    const preview = renderChatView({ attachments: nextAttachments });
    expect(preview.querySelectorAll(".chat-attachment-thumb--file")).toHaveLength(1);
    expect(preview.querySelector(".chat-attachment-file__name")?.textContent).toBe("brief.pdf");
  });

  it("filters video file attachments", () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = container.querySelector<HTMLInputElement>(".agent-chat__file-input");
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });

    expect(input).toBeInstanceOf(HTMLInputElement);
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [file],
    });
    input!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });
});

describe("chat queue", () => {
  it("renders Steer only for queued messages during an active run", () => {
    const onQueueSteer = vi.fn();
    const container = renderQueue({
      onQueueSteer,
      queue: [
        { id: "queued-1", text: "tighten the plan", createdAt: 1 },
        { id: "steered-1", text: "already sent", createdAt: 2, kind: "steered" },
        { id: "local-1", text: "/status", createdAt: 3, localCommandName: "status" },
        {
          id: "waiting-idle-1",
          text: "queued during the run",
          createdAt: 4,
          sendState: "waiting-idle",
        },
        {
          id: "steering-1",
          text: "already steering",
          createdAt: 5,
          sendState: "steering",
        },
      ],
    });

    const steerButtons = container.querySelectorAll<HTMLButtonElement>(".chat-queue__steer");
    expect(steerButtons).toHaveLength(2);
    expect(itemAt(steerButtons, 0, "queue steer button").textContent?.trim()).toBe("Steer");
    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe("Steered");

    itemAt(steerButtons, 0, "queue steer button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(onQueueSteer).toHaveBeenCalledWith("queued-1");
    itemAt(steerButtons, 1, "queue steer button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onQueueSteer).toHaveBeenCalledWith("waiting-idle-1");

    const inactiveContainer = renderQueue({
      canAbort: false,
      onQueueSteer: vi.fn(),
      queue: [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
    });

    expect(inactiveContainer.querySelector(".chat-queue__steer")).toBeNull();
  });

  it("renders failed send state with retry and remove affordances", () => {
    const onQueueRetry = vi.fn();
    const container = renderQueue({
      onQueueRetry,
      queue: [
        {
          id: "failed-1",
          text: "still recoverable",
          createdAt: 1,
          sendError: "send blocked by session policy",
          sendRunId: "run-failed-1",
          sendState: "failed",
        },
      ],
    });

    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe("Failed");
    expect(container.querySelector(".chat-queue__error")?.textContent?.trim()).toBe(
      "send blocked by session policy",
    );
    const retry = container.querySelector<HTMLButtonElement>(".chat-queue__retry");
    expect(retry?.textContent?.trim()).toBe("Retry");

    retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onQueueRetry).toHaveBeenCalledWith("failed-1");
  });

  it("renders a running local command without retry or remove affordances", () => {
    const onQueueRemove = vi.fn();
    const onQueueRetry = vi.fn();
    const container = renderQueue({
      onQueueRemove,
      onQueueRetry,
      queue: [
        {
          id: "running-command",
          text: "/compact",
          createdAt: 1,
          localCommandName: "compact",
          sendState: "executing-command",
        },
      ],
    });

    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe(
      "Running command",
    );
    expect(container.querySelector(".chat-queue__retry")).toBeNull();
    expect(container.querySelector(".chat-queue__remove")).toBeNull();
    expect(onQueueRetry).not.toHaveBeenCalled();
    expect(onQueueRemove).not.toHaveBeenCalled();
  });
});

describe("chat sidebar raw content", () => {
  it("keeps markdown raw text toggles idempotent", () => {
    const rawMarkdown = "```ts\nconst value = 1;\n```";

    expect(
      buildRawSidebarContent({
        kind: "markdown",
        content: `\`\`\`\n${rawMarkdown}\n\`\`\``,
        rawText: rawMarkdown,
      }),
    ).toEqual({
      kind: "markdown",
      content: `\`\`\`\n${rawMarkdown}\n\`\`\``,
      rawText: rawMarkdown,
    });
  });

  it("does not carry full-message requests into raw views", () => {
    const raw = buildRawSidebarContent({
      kind: "markdown",
      content: "Rendered",
      rawText: "Raw",
      fullMessageRequest: {
        sessionKey: "main",
        messageId: "msg-raw",
        kind: "assistant_message",
      },
    });

    expect(raw).toEqual({
      kind: "markdown",
      content: "```\nRaw\n```",
      rawText: "Raw",
    });
  });

  it("renders image sidebar content as an image instead of markdown text", () => {
    const container = document.createElement("div");

    render(
      renderMarkdownSidebar({
        content: {
          kind: "image",
          title: "artifact-preview.png",
          src: "data:image/png;base64,aW1hZ2U=",
          mimeType: "image/png",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
      }),
      container,
    );

    const image = container.querySelector<HTMLImageElement>("img.chat-tool-card__preview-image");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(container.textContent).not.toContain("data:image/png;base64");
  });
});

describe("chat welcome", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  function renderWelcome(params: {
    assistantAvatar: string | null;
    assistantAvatarUrl?: string | null;
    sessions?: SessionsListResult | null;
    sessionKey?: string;
    sessionHost?: { assistantAgentId?: string | null } | null;
    onOpenSession?: (sessionKey: string) => void;
  }) {
    const container = document.createElement("div");
    render(
      renderWelcomeState({
        assistantName: "Val",
        assistantAvatar: params.assistantAvatar,
        assistantAvatarUrl: params.assistantAvatarUrl,
        sessions: params.sessions,
        sessionKey: params.sessionKey,
        sessionHost: params.sessionHost,
        onOpenSession: params.onOpenSession,
        onDraftChange: () => undefined,
        onSend: () => undefined,
      }),
      container,
    );
    return container;
  }

  it("renders configured assistant avatars and the animated Clawd fallback", () => {
    let container = renderWelcome({ assistantAvatar: "VC", assistantAvatarUrl: null });

    const avatar = container.querySelector<HTMLElement>(".agent-chat__avatar");
    expect(avatar?.tagName).toBe("DIV");
    expect(avatar?.textContent?.trim()).toBe("VC");
    expect(avatar?.getAttribute("aria-label")).toBe("Val");

    container = renderWelcome({
      assistantAvatar: "avatars/val.png",
      assistantAvatarUrl: "blob:identity-avatar",
    });

    const imageAvatar = container.querySelector<HTMLImageElement>("img");
    expect(imageAvatar?.getAttribute("src")).toBe("blob:identity-avatar");
    expect(imageAvatar?.getAttribute("alt")).toBe("Val");

    container = renderWelcome({ assistantAvatar: null, assistantAvatarUrl: null });

    const clawd = container.querySelector(".agent-chat__welcome-clawd");
    expect(clawd).not.toBeNull();
    expect(clawd?.querySelector(".lobster-pet__svg")).not.toBeNull();
    expect(container.querySelector(".agent-chat__badge")).toBeNull();
  });

  it("renders welcome text from the active locale", async () => {
    await i18n.setLocale("zh-CN");
    const container = renderWelcome({ assistantAvatar: "VC", assistantAvatarUrl: null });

    expect(container.querySelector(".agent-chat__suggestion")?.textContent?.trim()).toBe(
      t("chat.welcome.suggestions.whatCanYouDo"),
    );
  });

  it("lists recent user chats instead of suggestions when any exist", () => {
    const opened: string[] = [];
    const container = renderWelcome({
      assistantAvatar: null,
      assistantAvatarUrl: null,
      sessionKey: "agent:main:dashboard:current",
      sessions: createSessionsResultFromRows([
        {
          key: "agent:main:dashboard:current",
          kind: "direct",
          updatedAt: 50,
          label: "Current chat",
        },
        {
          key: "agent:main:dashboard:older",
          kind: "direct",
          updatedAt: 10,
          label: "Older chat",
          pinned: true,
          pinnedAt: 5,
        },
        {
          key: "agent:main:discord:group:g-1456",
          kind: "group",
          channel: "discord",
          updatedAt: 90,
        },
        { key: "agent:main:dashboard:newer", kind: "direct", updatedAt: 40, label: "Newer chat" },
      ]),
      onOpenSession: (key) => opened.push(key),
    });

    expect(container.querySelector(".agent-chat__suggestion")).toBeNull();
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".agent-chat__recent")];
    expect(
      rows.map((row) => row.querySelector(".agent-chat__recent-name")?.textContent?.trim()),
    ).toEqual(["Newer chat", "Older chat"]);

    itemAt(rows, 0, "recent session row").click();
    expect(opened).toEqual(["agent:main:dashboard:newer"]);
  });

  it("keeps suggestions when only channel-bound sessions exist", () => {
    const container = renderWelcome({
      assistantAvatar: null,
      assistantAvatarUrl: null,
      sessionKey: "agent:main:dashboard:current",
      sessions: createSessionsResultFromRows([
        {
          key: "agent:main:discord:group:g-1456",
          kind: "group",
          channel: "discord",
          updatedAt: 90,
        },
        { key: "agent:main:telegram:direct:42", kind: "direct", channel: "telegram", updatedAt: 5 },
      ]),
    });

    expect(container.querySelector(".agent-chat__recent")).toBeNull();
    expect(container.querySelectorAll(".agent-chat__suggestion").length).toBeGreaterThan(0);
  });

  it("scopes recents to the selected agent for bare global session keys", () => {
    const container = renderWelcome({
      assistantAvatar: null,
      assistantAvatarUrl: null,
      sessionKey: "global",
      sessionHost: { assistantAgentId: "beta" },
      sessions: createSessionsResultFromRows([
        { key: "agent:beta:dashboard:one", kind: "direct", updatedAt: 20, label: "Beta chat" },
        { key: "agent:main:dashboard:two", kind: "direct", updatedAt: 30, label: "Main chat" },
      ]),
    });

    const rows = [...container.querySelectorAll(".agent-chat__recent-name")];
    expect(rows.map((row) => row.textContent?.trim())).toEqual(["Beta chat"]);
  });
});

describe("chat model controls", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("disables the chat header model picker while a run is active", () => {
    const { state } = createChatHeaderState();
    state.chatRunId = "run-123";
    state.chatStream = "Working";
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const modelSelect = getChatModelSelect(container);
    expect(modelSelect.getAttribute("aria-disabled")).toBe("true");
  });

  it("applies a model selection immediately", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const container = document.createElement("div");
    render(
      renderChatModelControls({ ...createChatModelControlsProps(state), onModelSelect }),
      container,
    );
    const modelOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).find((button) => button.getAttribute("aria-selected") === "false");
    expect(modelOption).toBeInstanceOf(HTMLButtonElement);
    modelOption?.click();

    expect(onModelSelect).toHaveBeenCalledWith(modelOption?.dataset.chatModelOption, "main");
  });

  it("hides model choices for locked sessions while preserving reasoning and speed", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
      thinkingDefault: "high",
    });
    state.sessionsResult = createSessionsListResult({
      model: "gpt-5.5",
      modelProvider: "openai",
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      defaultsThinkingDefault: "high",
      defaultsThinkingLevels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const onThinkingSelect = vi.fn(async () => true);
    const onFastModeSelect = vi.fn(async () => true);
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        modelSelectionLocked: true,
        modelSelectionRuntimeId: "codex",
        onFastModeSelect,
        onModelSelect,
        onThinkingSelect,
      }),
      container,
    );

    const modelSelect = getChatModelSelect(container);
    expect(modelSelect.dataset.chatModelLocked).toBe("true");
    expect(modelSelect.getAttribute("aria-disabled")).toBe("false");
    expect(container.querySelector(".chat-controls__locked-model-value")?.textContent).toBe(
      "Codex-controlled model",
    );
    expect(
      container.querySelector(".chat-controls__inline-select-label")?.textContent,
    ).not.toContain("GPT-5.5");
    expect(container.querySelectorAll("[data-chat-model-provider]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
    expect(onModelSelect).not.toHaveBeenCalled();

    const slider = getThinkingSlider(container);
    expect(slider).toBeInstanceOf(HTMLInputElement);
    if (slider) {
      slider.value = "0";
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onThinkingSelect).toHaveBeenCalledWith("low", "main");

    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    speedToggle?.click();
    expect(onFastModeSelect).toHaveBeenCalledWith("on", "main");
  });

  it("labels a locked session without native model metadata", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
    });
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        modelSelectionLocked: true,
        modelSelectionRuntimeId: "codex",
      }),
      container,
    );

    expect(container.querySelector(".chat-controls__locked-model-value")?.textContent).toBe(
      "Codex-controlled model",
    );
    expect(container.querySelector(".chat-controls__inline-select-label")?.textContent).toContain(
      "Codex-controlled model",
    );
  });

  it("uses a neutral model label for non-Codex locked sessions", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
    });
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        modelSelectionLocked: true,
        modelSelectionRuntimeId: "openclaw",
      }),
      container,
    );

    expect(container.querySelector(".chat-controls__locked-model-value")?.textContent).toBe(
      "Session model",
    );
    expect(container.textContent).not.toContain("Codex-controlled model");
  });

  it("does not patch the model for a locked session", async () => {
    const { state, request } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
    });
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "agent:main:main",
        kind: "direct",
        model: "gpt-5.5",
        modelProvider: "openai",
        modelSelectionLocked: true,
        updatedAt: 1,
      },
    ]);

    await expect(
      switchChatModel(state as unknown as Parameters<typeof switchChatModel>[0], "openai/gpt-5.4"),
    ).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("ignores model clicks while a run is active", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
    });
    state.chatRunId = "run-123";
    state.chatStream = "Working";
    const onModelSelect = vi.fn(async () => true);
    const container = document.createElement("div");
    render(
      renderChatModelControls({ ...createChatModelControlsProps(state), onModelSelect }),
      container,
    );
    const modelOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).find((button) => button.getAttribute("aria-selected") === "false");
    expect(modelOption?.disabled).toBe(true);
    modelOption?.click();

    expect(onModelSelect).not.toHaveBeenCalled();
  });

  it("groups models by provider and switches the visible provider section", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
      ],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    expect(providerButtons.map((button) => button.textContent?.trim())).toEqual([
      "OpenAI",
      "Anthropic",
      "Google",
    ]);
    expect(providerButtons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="openai"]')?.hidden,
    ).toBe(false);
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="anthropic"]')?.hidden,
    ).toBe(true);

    providerButtons[1]?.click();

    expect(providerButtons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(providerButtons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="openai"]')?.hidden,
    ).toBe(true);
    const anthropicModels = container.querySelector<HTMLElement>(
      '[data-chat-model-provider-group="anthropic"]',
    );
    expect(anthropicModels?.hidden).toBe(false);
    expect(anthropicModels?.textContent).toContain("Claude Sonnet 4.6");
  });

  it("groups legacy Codex model references under OpenAI", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "codex" },
      ],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    expect(providerButtons.map((button) => button.textContent?.trim())).toEqual(["OpenAI"]);
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="openai"]')?.hidden,
    ).toBe(false);
    expect(container.querySelector('[data-chat-model-provider-group="codex"]')).toBeNull();
  });

  it("merges provider aliases into unique visible groups", () => {
    const { state } = createChatHeaderState({
      model: "gemini-2.5-pro",
      modelProvider: "google",
      models: [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
        { id: "gemini-cli", name: "Gemini CLI", provider: "google-gemini-cli" },
        { id: "sonnet", name: "OpenCode Sonnet", provider: "opencode" },
        { id: "kimi", name: "OpenCode Kimi", provider: "opencode-go" },
        { id: "glm", name: "OpenCode GLM", provider: "opencode-zen" },
      ],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    const providerLabels = providerButtons.map((button) => button.textContent?.trim());
    expect(providerLabels).toEqual(["OpenAI", "Google", "OpenCode"]);
    expect(new Set(providerLabels).size).toBe(providerLabels.length);
    expect(
      container.querySelector('[data-chat-model-provider-group="google"]')?.textContent,
    ).toContain("Gemini CLI");
    const openCodeModels = container.querySelector(
      '[data-chat-model-provider-group="opencode"]',
    )?.textContent;
    expect(openCodeModels).toContain("Sonnet");
    expect(openCodeModels).toContain("Kimi");
    expect(openCodeModels).toContain("GLM");
    expect(openCodeModels).not.toContain("OpenCode Sonnet");
    expect(
      container.querySelector('[data-chat-model-provider-group="google-gemini-cli"]'),
    ).toBeNull();
    expect(container.querySelector('[data-chat-model-provider-group="opencode-go"]')).toBeNull();
    expect(container.querySelector('[data-chat-model-provider-group="opencode-zen"]')).toBeNull();
  });

  it("shows canonical OpenAI model names instead of command aliases", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      thinkingDefault: "high",
      models: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          alias: "codex",
          provider: "codex",
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          alias: "gpt",
          provider: "openai",
        },
      ],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    expect(
      container.querySelector(".chat-controls__inline-select-label")?.textContent?.trim(),
    ).toBe("GPT-5.5 · High");
    expect(
      container.querySelector('[data-chat-model-option="openai/gpt-5.5"]')?.textContent,
    ).toContain("GPT-5.5");
  });

  it("marks the actual default model row and selects it when inherited", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      thinkingDefault: "high",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          alias: "gpt",
          provider: "openai",
        },
      ],
    });
    state.sessionsResult = {
      ...state.sessionsResult!,
      defaults: {
        ...state.sessionsResult!.defaults,
        model: "gpt-5.5",
        modelProvider: "openai",
      },
    };
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        modelOverrides: { main: null },
      }),
      container,
    );

    expect(
      container.querySelector(".chat-controls__inline-select-label")?.textContent?.trim(),
    ).toBe("GPT-5.5 · High");
    const defaultOptions = container.querySelectorAll<HTMLButtonElement>(
      '[data-chat-model-default="true"]',
    );
    expect(defaultOptions).toHaveLength(1);
    const defaultOption = defaultOptions[0];
    expect(defaultOption?.dataset.chatModelOption).toBe("openai/gpt-5.5");
    expect(defaultOption?.getAttribute("aria-selected")).toBe("true");
    expect(defaultOption?.textContent).toContain("GPT-5.5");
    expect(defaultOption?.textContent).toContain("Default");
    expect(container.querySelector('[data-chat-model-option=""]')).toBeNull();
  });

  it("clears a different model override from the actual default model row", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.4",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    const onModelSelect = vi.fn(async () => true);
    const container = document.createElement("div");
    const sessionKey = "default-clear";
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        sessionKey,
        modelOverrides: { [sessionKey]: "openai/gpt-5.4" },
        onModelSelect,
      }),
      container,
    );

    const defaultOption = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.5"][data-chat-model-default="true"]',
    );
    expect(defaultOption).toBeInstanceOf(HTMLButtonElement);
    expect(defaultOption?.getAttribute("aria-selected")).toBe("false");
    defaultOption?.click();

    await vi.waitFor(() => {
      expect(onModelSelect).toHaveBeenCalledWith("", sessionKey);
    });
  });

  it("clears an explicit override that matches the default model", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    const onModelSelect = vi.fn(async () => true);
    const container = document.createElement("div");
    const sessionKey = "explicit-default";
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        sessionKey,
        modelOverrides: { [sessionKey]: "openai/gpt-5.5" },
        onModelSelect,
      }),
      container,
    );

    const defaultOption = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.5"][data-chat-model-default="true"]',
    );
    expect(defaultOption).toBeInstanceOf(HTMLButtonElement);
    expect(defaultOption?.getAttribute("aria-selected")).toBe("true");
    defaultOption?.click();

    await vi.waitFor(() => {
      expect(onModelSelect).toHaveBeenCalledWith("", sessionKey);
    });
  });

  it("shows canonical OpenAI names for legacy Codex model references", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "codex",
      thinkingDefault: "high",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          alias: "codex",
          provider: "codex",
        },
      ],
    });
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        modelOverrides: { main: "codex/gpt-5.5" },
      }),
      container,
    );

    expect(
      container.querySelector(".chat-controls__inline-select-label")?.textContent?.trim(),
    ).toBe("GPT-5.5 · High");
  });

  it("uses the session provider for slash-containing raw model ids without metadata", () => {
    const { state } = createChatHeaderState();
    state.chatModelCatalog = [
      {
        id: "google/gemma-4-26b-a4b-it",
        name: "Gemma 4",
        provider: "google",
      },
      {
        id: "google/gemma-4-26b-a4b-it",
        name: "Gemma 4",
        provider: "openrouter",
      },
    ];
    state.sessionsResult = createSessionsListResult({
      model: "google/gemma-4-26b-a4b-it",
      modelProvider: "openrouter",
      defaultsModel: "google/gemma-4-26b-a4b-it",
      defaultsProvider: "openrouter",
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    expect(providerButtons.map((button) => button.textContent?.trim())).toEqual([
      "OpenRouter",
      "Google",
    ]);
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="google"]')
        ?.textContent,
    ).toContain("Gemma 4");
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="openrouter"]')
        ?.textContent,
    ).toContain("Gemma 4");
  });

  it("uses a unique catalog provider before an unrelated stale session hint", () => {
    const { state } = createChatHeaderState({
      model: "moonshotai/kimi-k2.5",
      modelProvider: "zai",
      models: [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5",
          provider: "nvidia",
        },
      ],
    });
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        modelOverrides: { main: "moonshotai/kimi-k2.5" },
      }),
      container,
    );

    const providers = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    ).map((button) => button.dataset.chatModelProvider);
    expect(providers).toContain("nvidia");
    expect(providers).not.toContain("zai");
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="nvidia"]')?.hidden,
    ).toBe(false);
  });

  it("renders reasoning as a slider and speed as a fast-mode toggle", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      thinkingDefault: "high",
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      defaultsThinkingDefault: "high",
      defaultsThinkingLevels: [
        { id: "adaptive", label: "adaptive" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const slider = getThinkingSlider(container);
    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");

    expect(getThinkingSliderValues(container)).toEqual(["adaptive", "low", "medium", "high"]);
    expect(slider?.value).toBe("3");
    expect(slider?.getAttribute("aria-valuetext")).toBe("Default (High)");
    expect(speedToggle?.textContent?.trim()).toBe("Standard");
    expect(speedToggle?.getAttribute("aria-checked")).toBe("false");
    expect(speedToggle?.dataset.chatSpeedToggle).toBe("on");
    expect(
      container.querySelector('[data-chat-model-select="true"] .chat-controls__provider-icon'),
    ).toBeNull();
    expect(
      container.querySelector("[data-chat-model-option] .chat-controls__provider-icon"),
    ).toBeNull();
    expect(
      container.querySelector('[data-chat-model-provider="openai"] [data-provider-icon]'),
    ).not.toBeNull();
  });

  it("applies model, reasoning, and speed immediately for the session that opened the picker", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
      thinkingDefault: "high",
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      defaultsThinkingDefault: "high",
      defaultsThinkingLevels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const onThinkingSelect = vi.fn(async () => true);
    const onFastModeSelect = vi.fn(async () => true);
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        onFastModeSelect,
        onModelSelect,
        onThinkingSelect,
      }),
      container,
    );

    const modelOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).find(
      (button) =>
        button.getAttribute("aria-selected") === "false" && button.dataset.chatModelOption !== "",
    );
    expect(modelOption).toBeInstanceOf(HTMLButtonElement);
    modelOption?.click();
    expect(onModelSelect).toHaveBeenCalledWith(modelOption?.dataset.chatModelOption, "main");

    const slider = getThinkingSlider(container);
    expect(slider).toBeInstanceOf(HTMLInputElement);
    if (slider) {
      slider.value = "0";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      // Drag preview is attribute-only: mutating rendered text would eject
      // Lit's ChildPart markers and freeze later menu renders.
      expect(slider.getAttribute("aria-valuetext")).toBe("Low");
      expect(getThinkingReasoningValueLabel(container)).toBe("High");
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onThinkingSelect).toHaveBeenCalledWith("low", "main");

    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    expect(speedToggle?.textContent?.trim()).toBe("Standard");
    speedToggle?.click();
    expect(onFastModeSelect).toHaveBeenCalledWith("on", "main");
  });

  it("locks reasoning and speed while a model switch is pending", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
      thinkingDefault: "high",
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      defaultsThinkingDefault: "high",
      defaultsThinkingLevels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
      ],
    });
    const container = document.createElement("div");
    render(
      renderChatModelControls({
        ...createChatModelControlsProps(state),
        modelSwitching: true,
      }),
      container,
    );

    // The session row still describes the previous model while the switch is
    // pending, so committing reasoning/speed then would target stale levels.
    expect(getThinkingSlider(container)?.disabled).toBe(true);
    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    expect(speedToggle?.disabled).toBe(true);
  });

  it("keeps the newest speed selection when an older patch fails late", async () => {
    const pendingPatches: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    // Minimal host: the factory's mock gateway rebuilds session rows on every
    // refresh, which would mask the optimistic fastMode value under test.
    const host = {
      client: {},
      connected: true,
      sessionKey: "main",
      chatModelCatalog: [],
      chatThinkingLevel: null,
      sessionsResult: createSessionsResultFromRows([{ key: "main", kind: "direct", updatedAt: 1 }]),
      sessions: {
        patch: () =>
          new Promise((resolve, reject) => {
            pendingPatches.push({
              resolve: () =>
                resolve({
                  ok: true,
                  path: "",
                  key: "main",
                  entry: { sessionId: "main" },
                }),
              reject,
            });
          }),
        refresh: async () => {},
      },
    } as unknown as Parameters<typeof switchChatFastMode>[0];

    const first = switchChatFastMode(host, "on");
    await vi.waitFor(() => expect(pendingPatches).toHaveLength(1));
    const second = switchChatFastMode(host, "off");
    await vi.waitFor(() => expect(pendingPatches).toHaveLength(2));

    pendingPatches[1]?.resolve();
    await expect(second).resolves.toBe(true);
    pendingPatches[0]?.reject(new Error("boom"));
    await expect(first).resolves.toBe(false);

    // Without the per-session patch token, the older failure would roll the
    // row back to its pre-"on" value and clobber the newer selection.
    const row = host.sessionsResult?.sessions.find((entry) => entry.key === "main");
    expect(row?.fastMode).toBe(false);
  });

  it("renders the committed model selection when a model switch fails", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
    });
    const onModelSelect = vi.fn(async () => false);
    const container = document.createElement("div");
    const props = {
      ...createChatModelControlsProps(state),
      onModelSelect,
    };
    render(renderChatModelControls(props), container);

    container
      .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.4"]')
      ?.click();

    await vi.waitFor(() => {
      expect(onModelSelect).toHaveBeenCalledWith("openai/gpt-5.4", "main");
    });
    render(renderChatModelControls(props), container);
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.5"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps the speed toggle visible and disabled for unsupported providers", () => {
    const { state } = createChatHeaderState({
      model: "local-model",
      modelProvider: "ollama",
      models: [{ id: "local-model", name: "Local Model", provider: "ollama" }],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    expect(speedToggle?.textContent?.trim()).toBe("Default");
    expect(speedToggle?.disabled).toBe(true);
  });

  it("uses default thinking options when the active session is absent", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      defaultsThinkingLevels: [
        { id: "off", label: "off" },
        { id: "adaptive", label: "adaptive" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "maximum" },
      ],
      omitSessionFromList: true,
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    expect(getThinkingSliderValues(container)).toEqual(["off", "adaptive", "xhigh", "max"]);
    // No override -> nothing to reset, so the icon reset is not rendered.
    expect(getThinkingResetButton(container)).toBeNull();
  });

  it("clears a reasoning override from the icon reset", async () => {
    const { state, request } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      thinkingDefault: "high",
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      defaultsThinkingDefault: "high",
      defaultsThinkingLevels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
      ],
    });
    state.sessionsResult.sessions[0] = {
      ...state.sessionsResult.sessions[0]!,
      thinkingLevel: "low",
    };
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    expect(getThinkingReasoningValueLabel(container)).toBe("Low");
    const reset = getThinkingResetButton(container);
    expect(reset).toBeInstanceOf(HTMLButtonElement);
    expect(reset?.disabled).toBe(false);
    reset?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("sessions.patch", {
        key: "main",
        thinkingLevel: null,
      });
    });
  });

  it("lets an unanchored slider select its first stop directly", async () => {
    const { state, request } = createChatHeaderState({
      model: "gemma4:hermes-e4b",
      modelProvider: "ollama",
      thinkingDefault: "adaptive",
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const thinkingSelect = getThinkingSelect(container);

    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(getThinkingReasoningValueLabel(container)).toBe("Adaptive");
    expect(getThinkingSliderValues(container)).not.toContain("adaptive");
    const slider = getThinkingSlider(container);
    expect(slider?.classList.contains("chat-controls__reasoning-range--unanchored")).toBe(true);
    slider?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("sessions.patch", {
        key: "main",
        thinkingLevel: "off",
      });
    });
  });

  it("anchors the slider thumb on the inherited default when it is a stop", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      thinkingDefault: "medium",
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const slider = getThinkingSlider(container);
    expect(slider?.classList.contains("chat-controls__reasoning-range--unanchored")).toBe(false);
    expect(slider?.value).toBe(String(getThinkingSliderValues(container).indexOf("medium")));
  });

  it("keeps a single available thinking level selectable without a slider", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "main",
        kind: "direct",
        modelProvider: "openai",
        model: "gpt-5",
        thinkingLevels: [{ id: "adaptive", label: "adaptive" }],
        updatedAt: 1,
      },
    ]);
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    expect(getThinkingSlider(container)).toBeNull();
    const only = container.querySelector<HTMLButtonElement>(
      '[data-chat-thinking-option="adaptive"]',
    );
    expect(only).toBeInstanceOf(HTMLButtonElement);
    expect(only?.getAttribute("aria-pressed")).toBe("false");
    only?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("sessions.patch", {
        key: "main",
        thinkingLevel: "adaptive",
      });
    });
  });

  it("does not pin an inherited single thinking level as an override", () => {
    const { state, request } = createChatHeaderState();
    state.sessionsResult = createSessionsListResult({
      model: "gpt-5",
      modelProvider: "openai",
      defaultsThinkingDefault: "adaptive",
      defaultsThinkingLevels: [{ id: "adaptive", label: "adaptive" }],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const only = container.querySelector<HTMLButtonElement>(
      '[data-chat-thinking-option="adaptive"]',
    );
    expect(only?.getAttribute("aria-pressed")).toBe("true");
    only?.click();

    expect(request).not.toHaveBeenCalled();
  });

  it("disables thinking for known non-reasoning models without duplicate off options", () => {
    const { state } = createChatHeaderState({
      model: "mistral:v0.3",
      modelProvider: "ollama",
      models: [
        {
          id: "mistral:v0.3",
          name: "Mistral",
          provider: "ollama",
          reasoning: false,
        },
      ],
    });
    const sessionsResult = expectDefined(state.sessionsResult, "non-reasoning model sessions");
    const session = expectDefined(sessionsResult.sessions[0], "non-reasoning model session");
    state.sessionsResult = {
      ...sessionsResult,
      defaults: {
        ...sessionsResult.defaults,
        thinkingLevels: [{ id: "off", label: "off" }],
      },
      sessions: [
        {
          ...session,
          thinkingLevel: "off",
          thinkingLevels: [{ id: "off", label: "off" }],
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const thinkingSelect = getThinkingSelect(container);

    expect(thinkingSelect.dataset.chatThinkingDisabled).toBe("true");
    expect(getThinkingSlider(container)).toBeNull();
    expect(getThinkingResetButton(container)).toBeNull();
  });

  it("does not label a non-default chat model from global thinking defaults", () => {
    const { state } = createChatHeaderState({
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      defaultsThinkingDefault: "off",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          provider: "deepseek",
          reasoning: true,
        },
      ],
    });
    state.sessionsResult = createSessionsListResult({
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      defaultsModel: "MiniMax-M2.7",
      defaultsProvider: "minimax",
      defaultsThinkingDefault: "off",
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    expect(getThinkingReasoningValueLabel(container)).toBe("Low");
  });

  it("always renders full thinking labels", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      thinkingDefault: "high",
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      defaultsThinkingDefault: "high",
      defaultsThinkingLevels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
      ],
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const thinkingSelect = getThinkingSelect(container);
    const triggerLabel = container.querySelector(".chat-controls__inline-select-label");

    expect(container.querySelector('[data-chat-thinking-select-compact="true"]')).toBeNull();
    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(triggerLabel?.textContent?.trim()).toBe("GPT-5.5 · High");
    expect(getThinkingSliderValues(container)).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(getThinkingSlider(container)?.value).toBe("3");
    expect(getThinkingReasoningValueLabel(container)).toBe("High");
  });

  it("labels chat thinking default from session defaults when the row is absent", () => {
    const { state } = createChatHeaderState({
      defaultsThinkingDefault: "adaptive",
      omitSessionFromList: true,
    });
    const container = document.createElement("div");
    render(renderChatModelControls(createChatModelControlsProps(state)), container);

    const thinkingSelect = getThinkingSelect(container);

    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(getThinkingReasoningValueLabel(container)).toBe("Adaptive");
  });
});

describe("right-click Reply", () => {
  it("opens context menu and calls onSetReply when Reply is selected", () => {
    const onSetReply = vi.fn();
    const container = renderChatView({ onSetReply });
    const section = container.querySelector<HTMLElement>(".card.chat");
    expect(section).not.toBeNull();

    // Create a real chat bubble inside a group with the data-message-text attribute
    const group = document.createElement("div");
    group.className = "chat-group";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.dataset.messageId = "msg-stable-1";
    bubble.dataset.messageText = "hello world";
    const sender = document.createElement("span");
    sender.className = "chat-sender-name";
    sender.textContent = "User";
    group.appendChild(sender);
    group.appendChild(bubble);
    section!.querySelector(".chat-thread-inner")!.appendChild(group);

    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    bubble.dispatchEvent(evt);

    const menu = document.querySelector(".chat-reply-context-menu");
    expect(menu).not.toBeNull();
    menu!.querySelector("button")!.click();

    expect(onSetReply).toHaveBeenCalledTimes(1);
    const target = itemAt(
      itemAt(onSetReply.mock.calls, 0, "reply callback call"),
      0,
      "reply target",
    );
    expect(target.messageId).toBe("msg-stable-1");
    expect(target.text).toBe("hello world");
    expect(target.senderLabel).toBe("User");
  });

  it("backs off before an emoji that crosses the reply target limit", () => {
    const onSetReply = vi.fn();
    const container = renderChatView({ onSetReply });
    const section = container.querySelector<HTMLElement>(".card.chat");
    const group = document.createElement("div");
    group.className = "chat-group";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.dataset.messageText = "x".repeat(499) + "🧠tail";
    group.appendChild(bubble);
    section!.querySelector(".chat-thread-inner")!.appendChild(group);

    bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    document.querySelector<HTMLButtonElement>(".chat-reply-context-menu button")!.click();

    const target = itemAt(
      itemAt(onSetReply.mock.calls, 0, "reply callback call"),
      0,
      "reply target",
    );
    expect(target.text).toBe("x".repeat(499));
  });

  it("keeps the native context menu when Reply is unavailable", () => {
    const container = renderChatView();
    const section = container.querySelector<HTMLElement>(".card.chat");
    expect(section).not.toBeNull();

    const group = document.createElement("div");
    group.className = "chat-group";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble streaming";
    bubble.dataset.messageText = "still streaming";
    group.appendChild(bubble);
    section!.querySelector(".chat-thread-inner")!.appendChild(group);

    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    bubble.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("dismisses the reply context menu with Escape after delayed listeners register", () => {
    const onSetReply = vi.fn();
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const container = renderChatView({ onSetReply });
    const section = container.querySelector<HTMLElement>(".card.chat");
    expect(section).not.toBeNull();

    const group = document.createElement("div");
    group.className = "chat-group";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.dataset.messageText = "hello world";
    group.appendChild(bubble);
    section!.querySelector(".chat-thread-inner")!.appendChild(group);

    bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    for (const callback of frameCallbacks.splice(0)) {
      callback(0);
    }

    const menu = document.querySelector<HTMLElement>(".chat-reply-context-menu");
    expect(menu).not.toBeNull();
    expect(menu!.getAttribute("role")).toBe("menu");
    expect(menu!.getAttribute("aria-label")).toBe("Message actions");
    const button = menu!.querySelector<HTMLButtonElement>("button");
    expect(button?.getAttribute("role")).toBe("menuitem");
    expect(document.activeElement).toBe(button);

    const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("dismisses the reply context menu before a later context menu opens", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const container = renderChatView({ onSetReply: vi.fn() });
    const section = container.querySelector<HTMLElement>(".card.chat");
    const group = document.createElement("div");
    group.className = "chat-group";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.dataset.messageText = "hello world";
    group.appendChild(bubble);
    section!.querySelector(".chat-thread-inner")!.appendChild(group);
    bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    for (const callback of frameCallbacks.splice(0)) {
      callback(0);
    }
    expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("renders reply preview bar with quote text and dismiss button", () => {
    const container = renderChatView({
      replyTarget: {
        messageId: "msg-1",
        text: "quoted message",
        senderLabel: "User",
      },
    });

    const preview = container.querySelector(".chat-reply-preview");
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain("quoted message");
    expect(preview!.textContent).toContain("User");

    const dismiss = preview!.querySelector<HTMLButtonElement>(".chat-reply-preview__dismiss");
    expect(dismiss).not.toBeNull();
  });

  it("backs off before an emoji that crosses the reply preview limit", () => {
    const container = renderChatView({
      replyTarget: {
        messageId: "msg-emoji",
        text: "x".repeat(119) + "🧠tail",
        senderLabel: "User",
      },
    });

    expect(container.querySelector(".chat-reply-preview__text")?.textContent).toBe(
      `${"x".repeat(119)}...`,
    );
  });

  it("calls onClearReply when dismiss button is clicked", () => {
    const onClearReply = vi.fn();
    const container = renderChatView({
      replyTarget: {
        messageId: "msg-1",
        text: "quoted",
        senderLabel: "User",
      },
      onClearReply,
    });

    container.querySelector<HTMLButtonElement>(".chat-reply-preview__dismiss")!.click();
    expect(onClearReply).toHaveBeenCalledTimes(1);
  });

  it("clears reply target on Escape when no other handler intercepted", () => {
    const onClearReply = vi.fn();
    const container = renderChatView({
      replyTarget: {
        messageId: "msg-1",
        text: "quoted",
        senderLabel: "User",
      },
      onClearReply,
    });

    const section = container.querySelector<HTMLElement>(".card.chat");
    const evt = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    section!.dispatchEvent(evt);

    expect(onClearReply).toHaveBeenCalledTimes(1);
  });

  it("does not clear reply target when Escape is already defaultPrevented", () => {
    const onClearReply = vi.fn();
    const container = renderChatView({
      replyTarget: {
        messageId: "msg-1",
        text: "quoted",
        senderLabel: "User",
      },
      onClearReply,
    });

    const section = container.querySelector<HTMLElement>(".card.chat");
    const evt = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(evt, "defaultPrevented", { value: true });
    section!.dispatchEvent(evt);

    expect(onClearReply).not.toHaveBeenCalled();
  });

  it("does not open Reply menu when onSetReply is absent", () => {
    renderChatView({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    });

    // Without onSetReply, the handler returns early and no menu is created
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });
});
