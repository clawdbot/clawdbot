/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { switchChatSession } from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../chat-model.test-helpers.ts";
import {
  getChatAttachmentDataUrl,
  resetChatAttachmentPayloadStoreForTest,
} from "../chat/attachment-payload-store.ts";
import { renderChatQueue } from "../chat/chat-queue.ts";
import { buildRawSidebarContent } from "../chat/chat-sidebar-raw.ts";
import { renderWelcomeState } from "../chat/chat-welcome.ts";
import { renderChatSessionSelect } from "../chat/session-controls.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow, ModelCatalogEntry, SessionsListResult } from "../types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { renderChat, resetChatViewState } from "./chat.ts";

const refreshVisibleToolsEffectiveForCurrentSessionMock = vi.hoisted(() =>
  vi.fn(async (state: AppViewState) => {
    const agentId = state.agentsSelectedId ?? "main";
    const sessionKey = state.sessionKey;
    await state.client?.request("tools.effective", { agentId, sessionKey });
    const override = state.chatModelOverrides[sessionKey];
    state.toolsEffectiveResultKey = `${agentId}:${sessionKey}:model=${override?.value ?? "(default)"}`;
    state.toolsEffectiveResult = { agentId, profile: "coding", groups: [] };
  }),
);
const loadSessionsMock = vi.hoisted(() =>
  vi.fn(async (state: AppViewState) => {
    const res = await state.client?.request("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    if (res) {
      state.sessionsResult = res as AppViewState["sessionsResult"];
    }
  }),
);
const buildChatItemsMock = vi.hoisted(() =>
  vi.fn((props: { messages: unknown[]; stream: string | null; streamStartedAt: number | null }) => {
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
    if (props.messages.length > 0) {
      return [
        {
          kind: "group",
          key: "group:assistant:test",
          role: "assistant",
          messages: props.messages.map((message, index) => ({
            key: `message:${index}`,
            message,
          })),
          timestamp: 1,
          isStreaming: false,
        },
      ];
    }
    if (props.stream !== null) {
      return props.stream
        ? [
            {
              kind: "stream",
              key: "stream:test",
              text: props.stream,
              startedAt: props.streamStartedAt ?? 1,
              isStreaming: true,
            },
          ]
        : [{ kind: "reading-indicator", key: "reading:test" }];
    }
    return [];
  }),
);
const renderMessageGroupMock = vi.hoisted(() =>
  vi.fn((group: { messages: Array<{ message: unknown }> }) => {
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
  }),
);
const assistantAttachmentRenderVersionMock = vi.hoisted(() => ({ value: 0 }));

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

vi.mock("../icons.ts", () => ({
  icons: {},
}));

vi.mock("../chat/build-chat-items.ts", () => ({
  buildChatItems: buildChatItemsMock,
}));

vi.mock("../chat/grouped-render.ts", () => ({
  getAssistantAttachmentAvailabilityRenderVersion: () => assistantAttachmentRenderVersionMock.value,
  renderMessageGroup: renderMessageGroupMock,
  renderReadingIndicatorGroup: () => {
    const element = document.createElement("div");
    element.className = "chat-reading-indicator";
    return element;
  },
  renderStreamingGroup: (text: string) => {
    const element = document.createElement("div");
    element.className = "chat-stream";
    element.textContent = text;
    return element;
  },
}));

vi.mock("../markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

vi.mock("../chat/tool-expansion-state.ts", () => ({
  getExpandedToolCards: () => new Map<string, boolean>(),
  syncToolCardExpansionState: () => undefined,
}));

vi.mock("../controllers/agents.ts", () => ({
  refreshVisibleToolsEffectiveForCurrentSession: refreshVisibleToolsEffectiveForCurrentSessionMock,
}));

vi.mock("../controllers/sessions.ts", () => ({
  loadSessions: loadSessionsMock,
  syncSelectedSessionMessageSubscription: vi.fn(async () => undefined),
}));

vi.mock("./agents-utils.ts", () => ({
  isRenderableControlUiAvatarUrl: (value: string) =>
    /^data:image\//i.test(value) || (value.startsWith("/") && !value.startsWith("//")),
  agentLogoUrl: () => "/openclaw-logo.svg",
  assistantAvatarFallbackUrl: () => "apple-touch-icon.png",
  resolveChatAvatarRenderUrl: (
    candidate: string | null | undefined,
    agent: { identity?: { avatar?: string; avatarUrl?: string } },
  ) => {
    const isRenderableControlUiAvatarUrl = (value: string) =>
      /^data:image\//i.test(value) || (value.startsWith("/") && !value.startsWith("//"));
    if (typeof candidate === "string" && candidate.startsWith("blob:")) {
      return candidate;
    }
    for (const value of [candidate, agent.identity?.avatarUrl, agent.identity?.avatar]) {
      if (typeof value === "string" && isRenderableControlUiAvatarUrl(value)) {
        return value;
      }
    }
    return null;
  },
  resolveAssistantTextAvatar: (value: string | null | undefined) => {
    if (!value) {
      return null;
    }
    return value.length <= 3 ? value : null;
  },
}));

function renderQueue(params: {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
}) {
  const container = document.createElement("div");
  render(
    renderChatQueue({
      queue: params.queue,
      canAbort: params.canAbort ?? true,
      onQueueRetry: params.onQueueRetry,
      onQueueSteer: params.onQueueSteer,
      onQueueRemove: () => undefined,
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
): { state: AppViewState; request: ReturnType<typeof vi.fn> } {
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
            matchingProviders.length === 1 ? matchingProviders[0] : currentModelProvider;
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
  const state = {
    sessionKey: "main",
    connected: true,
    sessionsHideCron: true,
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: false,
    sessionsShowArchived: false,
    sessionsResult: createSessionsListResult({
      model: currentModel,
      modelProvider: currentModelProvider,
      defaultsThinkingDefault: overrides.defaultsThinkingDefault,
      thinkingDefault: overrides.thinkingDefault,
      omitSessionFromList,
    }),
    chatModelOverrides: {},
    chatModelCatalog: catalog,
    chatModelsLoading: false,
    chatSessionPickerOpen: false,
    chatSessionPickerSurface: null,
    chatSessionPickerQuery: "",
    chatSessionPickerAppliedQuery: "",
    chatSessionPickerLoading: false,
    chatSessionPickerError: null,
    chatSessionPickerResult: null,
    client: { request } as unknown as GatewayBrowserClient,
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
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatShowThinking: false,
    },
    chatMessage: "",
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatQueue: [],
    chatMessages: [],
    chatLoading: false,
    chatThinkingLevel: null,
    lastError: null,
    chatAvatarUrl: null,
    basePath: "",
    hello: null,
    agentsList: null,
    agentsPanel: "overview",
    agentsSelectedId: null,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    applySettings(next: AppViewState["settings"]) {
      state.settings = next;
    },
    setTab: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    resetChatInputHistoryNavigation: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
  } as unknown as AppViewState & {
    client: GatewayBrowserClient;
    settings: AppViewState["settings"];
  };
  return { state, request };
}

async function flushTasks() {
  await vi.dynamicImportSettled();
}

function getChatModelSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-model-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat model control");
  }
  return select;
}

function getChatSelectValue(control: HTMLElement): string {
  return control.dataset.chatSelectValue ?? "";
}

function getChatThinkingValue(control: HTMLElement): string {
  return control.dataset.chatThinkingValue ?? "";
}

function clickChatModelOption(container: Element, value: string) {
  const option = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
  ).find((button) => button.dataset.chatModelOption === value);
  expect(option).toBeInstanceOf(HTMLButtonElement);
  option?.click();
}

function clickChatSpeedOption(container: Element, value: string) {
  const option = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-chat-speed-option]"),
  ).find((button) => button.dataset.chatSpeedOption === value);
  expect(option).toBeInstanceOf(HTMLButtonElement);
  option?.click();
}

function getThinkingSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-thinking-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat thinking control");
  }
  return select;
}

function getThinkingOptions(container: Element): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[data-chat-thinking-option]"));
}

function requireElement(container: Element, selector: string, label: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`expected ${label}`);
  }
  return element;
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
    sideResult: null,
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
    realtimeTalkTranscript: null,
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: null,
    sidebarOpen: false,
    sidebarContent: null,
    sidebarError: null,
    splitRatio: 0.6,
    canvasPluginSurfaceUrl: null,
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    assistantName: "Val",
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
    onDismissSideResult: () => undefined,
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

    frameCallbacks[0](0);

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
  it("renders the active session goal inside the composer", () => {
    const container = renderChatView({
      sessions: createSessionsResultFromRows([
        {
          key: "main",
          kind: "direct",
          updatedAt: 2,
          goal: {
            schemaVersion: 1,
            id: "goal-1",
            objective: "Land the web goal UI",
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 100,
            tokensUsed: 12_400,
            tokenBudget: 50_000,
            continuationTurns: 0,
          },
        },
      ]),
    });

    const goal = container.querySelector(".agent-chat__goal");
    expect(goal?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Pursuing goal (12k/50k) Land the web goal UI",
    );
    expect(goal?.getAttribute("aria-label")).toBe("Pursuing goal (12k/50k): Land the web goal UI");
    expect(goal?.closest(".agent-chat__composer-status-stack")).not.toBeNull();
  });
});

describe("chat composer workbench", () => {
  it("renders session controls in the composer and workspace files in the rail", () => {
    const onRefresh = vi.fn();
    const onOpenFile = vi.fn();
    const container = renderChatView({
      composerControls: html`<button class="test-composer-control">Model</button>`,
      workspaceFiles: {
        agentId: "main",
        list: {
          agentId: "main",
          workspace: "/workspace",
          files: [
            {
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              missing: false,
              size: 2048,
            },
          ],
        },
        loading: false,
        error: null,
        activeName: "AGENTS.md",
        onRefresh,
        onOpenFile,
      },
    });

    expect(
      container.querySelector(".agent-chat__composer-controls .test-composer-control"),
    ).not.toBeNull();
    expect(container.querySelector(".chat-workspace-rail__path")?.textContent?.trim()).toBe(
      "/workspace",
    );
    const file = container.querySelector<HTMLButtonElement>(".chat-workspace-rail__file");
    expect(file?.textContent).toContain("AGENTS.md");
    expect(file?.textContent).toContain("2 KB");

    file?.click();

    expect(onOpenFile).toHaveBeenCalledWith("AGENTS.md");
  });

  it("keeps the secondary New session and Export controls suppressed in the composer", () => {
    const container = renderChatView({
      messages: [{ role: "assistant", content: "ready" }],
    });

    const toolbarRight = container.querySelector(".agent-chat__toolbar-right");
    expect(toolbarRight).not.toBeNull();
    const labels = Array.from(toolbarRight?.querySelectorAll("button") ?? []).map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).not.toContain(t("chat.runControls.newSession"));
    expect(labels).not.toContain(t("chat.runControls.exportChat"));
  });

  it("exposes aria-expanded on the Talk settings button reflecting open state", () => {
    const collapsed = renderChatView({
      onToggleRealtimeTalk: () => undefined,
      onToggleRealtimeTalkOptions: () => undefined,
      realtimeTalkOptionsOpen: false,
    });
    const collapsedBtn = collapsed.querySelector<HTMLButtonElement>(
      'button[aria-label="Talk settings"]',
    );
    expect(collapsedBtn).not.toBeNull();
    expect(collapsedBtn?.getAttribute("aria-expanded")).toBe("false");

    const expanded = renderChatView({
      onToggleRealtimeTalk: () => undefined,
      onToggleRealtimeTalkOptions: () => undefined,
      realtimeTalkOptionsOpen: true,
    });
    const expandedBtn = expanded.querySelector<HTMLButtonElement>(
      'button[aria-label="Talk settings"]',
    );
    expect(expandedBtn?.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders Talk settings from its own callback contract", () => {
    const onToggleRealtimeTalkOptions = vi.fn();
    const container = renderChatView({
      onToggleRealtimeTalk: undefined,
      onToggleRealtimeTalkOptions,
      realtimeTalkOptionsOpen: false,
    });

    const settings = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Talk settings"]',
    );
    expect(settings).not.toBeNull();
    expect(container.querySelector('button[aria-label="Start Talk"]')).toBeNull();

    settings?.click();

    expect(onToggleRealtimeTalkOptions).toHaveBeenCalledOnce();
  });

  it("does not render a dead Talk settings button without its callback", () => {
    const container = renderChatView({
      onToggleRealtimeTalk: () => undefined,
      realtimeTalkOptionsOpen: true,
    });

    expect(container.querySelector('button[aria-label="Start Talk"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Talk settings"]')).toBeNull();
  });
});

afterEach(() => {
  vi.useRealTimers();
  buildChatItemsMock.mockClear();
  renderMessageGroupMock.mockClear();
  assistantAttachmentRenderVersionMock.value = 0;
  loadSessionsMock.mockClear();
  refreshVisibleToolsEffectiveForCurrentSessionMock.mockClear();
  resetChatViewState();
  resetChatAttachmentPayloadStoreForTest();
  vi.unstubAllGlobals();
});

describe("chat transcript rendering cache", () => {
  it("does not rebuild transcript items for draft-only rerenders", () => {
    const messages = [{ role: "assistant", content: "ready" }];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const queue: ChatQueueItem[] = [];

    renderChatView({ messages, toolMessages, streamSegments, queue, draft: "" });
    renderChatView({ messages, toolMessages, streamSegments, queue, draft: "h" });
    renderChatView({ messages, toolMessages, streamSegments, queue, draft: "hello" });

    expect(buildChatItemsMock).toHaveBeenCalledTimes(1);
  });

  it("does not rerender transcript groups for draft-only rerenders", () => {
    const messages = [{ role: "assistant", content: "ready" }];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const queue: ChatQueueItem[] = [];
    const container = document.createElement("div");

    render(
      renderChat(createChatProps({ messages, toolMessages, streamSegments, queue })),
      container,
    );
    render(
      renderChat(createChatProps({ messages, toolMessages, streamSegments, queue, draft: "h" })),
      container,
    );
    render(
      renderChat(
        createChatProps({ messages, toolMessages, streamSegments, queue, draft: "hello" }),
      ),
      container,
    );

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(1);
  });

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

  it("does not keep the reading indicator after an assistant response has rendered", () => {
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

    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    expect(container.querySelector(".chat-group")?.textContent?.trim()).toBe("Finished answer");
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

      expect(container.querySelector(".agent-chat__run-status--done")?.textContent).toContain(
        "Done",
      );
      expect(container.querySelector(".agent-chat__run-status--in-progress")).toBeNull();
      expect(container.querySelector(".chat-reading-indicator")).toBeNull();
      expect(container.querySelector(".chat-send-btn--stop")).toBeNull();
      expect(container.querySelector<HTMLButtonElement>(".context-notice__action")?.disabled).toBe(
        false,
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("chat voice controls", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("keeps Talk visible without the stale browser dictation button", () => {
    const container = renderChatView();

    requireElement(container, '[aria-label="Start Talk"]', "Start Talk button");
    expect(container.querySelector('[aria-label="Voice input"]')).toBeNull();
  });

  it("renders editable Talk launch options", () => {
    const onRealtimeTalkOptionsChange = vi.fn();
    const container = renderChatView({
      realtimeTalkOptionsOpen: true,
      realtimeTalkOptions: {
        provider: "openai",
        model: "gpt-realtime-2",
        voice: "marin",
        transport: "webrtc",
        vadThreshold: "0.45",
        silenceDurationMs: "650",
        prefixPaddingMs: "250",
        reasoningEffort: "low",
      },
      onRealtimeTalkOptionsChange,
    });

    const model = container.querySelector<HTMLInputElement>(
      '.agent-chat__talk-options-primary input[placeholder="Auto"]',
    );
    const sensitivityLabel = requireElement(
      container,
      '[data-talk-select="sensitivity"] .agent-chat__talk-select-label',
      "Talk sensitivity selected label",
    );

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
    expect(sensitivityLabel.textContent).toBe("Custom");
    expect(getTalkSelectOptionValues(container, "sensitivity")).toEqual([
      "",
      "0.65",
      "0.5",
      "0.35",
      "__custom",
    ]);
    expect(getTalkSelectOptionValues(container, "reasoning")).toEqual([
      "",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(container.textContent).toContain("Sensitivity");
    expect(container.textContent).toContain("Advanced");
    expect(container.textContent).toContain("Pause before send");
    expect(container.textContent).not.toContain("Silence ms");
    expect(container.textContent).not.toContain("Prefix ms");
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

    const defaultContainer = renderChatView({
      realtimeTalkOptionsOpen: true,
      realtimeTalkOptions: {
        provider: "",
        model: "",
        voice: "",
        transport: "",
        vadThreshold: "",
        silenceDurationMs: "",
        prefixPaddingMs: "",
        reasoningEffort: "",
      },
      onRealtimeTalkOptionsChange,
    });
    const defaultSensitivityLabel = requireElement(
      defaultContainer,
      '[data-talk-select="sensitivity"] .agent-chat__talk-select-label',
      "default Talk sensitivity selected label",
    );
    expect(defaultSensitivityLabel.textContent).toBe("Default");
    expect(getTalkSelectOptionValues(defaultContainer, "sensitivity")).toEqual([
      "",
      "0.65",
      "0.5",
      "0.35",
    ]);
  });

  it("renders composer and Talk labels from the active locale", async () => {
    await i18n.setLocale("zh-CN");
    const container = renderChatView();
    const startTalkLabel = t("chat.composer.startTalk");

    const talkButton = requireElement(
      container,
      `[aria-label="${startTalkLabel}"]`,
      "localized Start Talk button",
    );
    expect(talkButton.getAttribute("title")).toBe(startTalkLabel);
    expect(talkButton.textContent?.trim()).toBe(startTalkLabel);
    expect(container.querySelector('[aria-label="Start Talk"]')).toBeNull();
    requireElement(
      container,
      `[aria-label="${t("chat.composer.attachFile")}"]`,
      "localized attach file button",
    );
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholder", { name: "Val" }),
    );
  });

  it("focuses the composer from non-control input chrome", () => {
    const container = renderChatView();
    const toolbar = requireElement(container, ".agent-chat__toolbar", "composer toolbar");
    const textarea = requireElement(
      container,
      ".agent-chat__composer-combobox > textarea",
      "composer textarea",
    ) as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(textarea, "focus");

    toolbar.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("keeps composer control clicks on the clicked control", () => {
    const container = renderChatView();
    const attachButton = requireElement(
      container,
      `[aria-label="${t("chat.composer.attachFile")}"]`,
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
    const onDismissError = vi.fn();
    const container = renderChatView({
      error: 'Realtime voice provider "openai" is not configured',
      realtimeTalkStatus: "error",
      realtimeTalkDetail: 'Realtime voice provider "openai" is not configured',
      onDismissError,
    });

    expect(container.querySelector('[role="alert"] .callout__content')?.textContent).toBe(
      'Realtime voice provider "openai" is not configured',
    );

    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]');
    expect(dismiss).toBeInstanceOf(HTMLButtonElement);
    dismiss!.click();

    expect(onDismissError).toHaveBeenCalledTimes(1);
  });
});

describe("chat slash menu accessibility", () => {
  function inputDraft(container: HTMLElement, value: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.value = value;
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function keydownComposer(container: HTMLElement, key: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  it("keeps plain draft input local until send while suggestions are closed", () => {
    const onDraftChange = vi.fn();
    const onRequestUpdate = vi.fn();
    const onSend = vi.fn();
    const container = renderChatView({ onDraftChange, onRequestUpdate, onSend });

    inputDraft(container, "plain first message");

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onRequestUpdate).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    expect(onDraftChange).toHaveBeenCalledWith("plain first message");
    expect(onSend).toHaveBeenCalledTimes(1);
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

  it("commits local draft input before Enter sends", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const container = renderChatView({ onDraftChange, onSend });

    inputDraft(container, "send from enter");
    keydownComposer(container, "Enter");

    expect(onDraftChange).toHaveBeenCalledWith("send from enter");
    expect(onSend).toHaveBeenCalledTimes(1);
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
    expect(onDraftChange).not.toHaveBeenCalled();
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
    const listbox = container.querySelector<HTMLElement>("#chat-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(wrapper?.hasAttribute("role")).toBe(false);
    expect(wrapper?.hasAttribute("aria-expanded")).toBe(false);
    expect(wrapper?.hasAttribute("aria-haspopup")).toBe(false);
    expect(wrapper?.hasAttribute("aria-controls")).toBe(false);
    expect(textarea?.hasAttribute("role")).toBe(false);
    expect(textarea?.hasAttribute("aria-expanded")).toBe(false);
    expect(textarea?.hasAttribute("aria-haspopup")).toBe(false);
    expect(textarea?.getAttribute("aria-controls")).toBe("chat-slash-menu-listbox");
    expect(textarea?.getAttribute("aria-autocomplete")).toBe("list");
    expect(listbox?.getAttribute("role")).toBe("listbox");
    expect(activeId).toMatch(/^chat-slash-option-command-/u);
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
    const status = container.querySelector<HTMLElement>("#chat-slash-active-announcement");

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

  it("wires fixed argument suggestions with command-and-argument option ids", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let container = renderChatView({ draft, onDraftChange });

    inputDraft(container, "/tools ");
    container = renderChatView({ draft, onDraftChange });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const listbox = container.querySelector<HTMLElement>("#chat-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(listbox?.getAttribute("aria-label")).toBe("Command arguments");
    expect(activeId).toBe("chat-slash-option-arg-tools-compact");
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
    expect(getChatAttachmentDataUrl(attachments[0])).toBe(`data:image/png;base64,${base64}`);
  });

  it("opens the scoped file input from the visible attach button", () => {
    const container = renderChatView();
    const input = requireElement(
      container,
      ".agent-chat__file-input",
      "attachment file input",
    ) as HTMLInputElement;
    const attachButton = requireElement(
      container,
      `[aria-label="${t("chat.composer.attachFile")}"]`,
      "attach button",
    ) as HTMLButtonElement;
    const clickInput = vi.spyOn(input, "click").mockImplementation(() => undefined);

    attachButton.click();

    expect(attachButton.type).toBe("button");
    expect(clickInput).toHaveBeenCalledTimes(1);
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
    expect(getChatAttachmentDataUrl(nextAttachments[0])).toMatch(/^data:application\/pdf;base64,/);
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
      ],
    });

    const steerButtons = container.querySelectorAll<HTMLButtonElement>(".chat-queue__steer");
    expect(steerButtons).toHaveLength(1);
    expect(steerButtons[0].textContent?.trim()).toBe("Steer");
    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe("Steered");

    steerButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onQueueSteer).toHaveBeenCalledWith("queued-1");

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
});

describe("chat welcome", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  function renderWelcome(params: {
    assistantAvatar: string | null;
    assistantAvatarUrl?: string | null;
  }) {
    const container = document.createElement("div");
    render(
      renderWelcomeState({
        assistantName: "Val",
        assistantAvatar: params.assistantAvatar,
        assistantAvatarUrl: params.assistantAvatarUrl,
        onDraftChange: () => undefined,
        onSend: () => undefined,
      }),
      container,
    );
    return container;
  }

  it("renders configured assistant avatars and fallback in the welcome state", () => {
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

    const fallbackAvatar = container.querySelector<HTMLImageElement>(
      ".agent-chat__avatar--logo img",
    );
    expect(fallbackAvatar?.getAttribute("src")).toBe("apple-touch-icon.png");
    expect(fallbackAvatar?.getAttribute("alt")).toBe("Val");
  });

  it("renders welcome text from the active locale", async () => {
    await i18n.setLocale("zh-CN");
    const container = renderWelcome({ assistantAvatar: "VC", assistantAvatarUrl: null });

    expect(container.querySelector(".agent-chat__badge")?.textContent?.trim()).toBe(
      t("chat.welcome.ready"),
    );
    expect(container.querySelector(".agent-chat__suggestion")?.textContent?.trim()).toBe(
      t("chat.welcome.suggestions.whatCanYouDo"),
    );
  });
});

describe("chat session controls", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("filters chat sessions by agent and switches to that agent's latest eligible session", () => {
    const { state } = createChatHeaderState();
    const onSwitchSession = vi.fn();
    state.sessionKey = "agent:alpha:main";
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 6,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        { key: "agent:alpha:main", kind: "direct", updatedAt: 4 },
        { key: "agent:alpha:dashboard:alpha-recent", kind: "direct", updatedAt: 3 },
        {
          key: "agent:alpha:subagent:worker",
          kind: "direct",
          updatedAt: 5,
          spawnedBy: "agent:alpha:main",
        },
        { key: "agent:beta:dashboard:beta-recent", kind: "direct", updatedAt: 2 },
        { key: "agent:beta:main", kind: "direct", updatedAt: 1 },
        {
          key: "agent:beta:subagent:worker",
          kind: "direct",
          updatedAt: 6,
          spawnedBy: "agent:beta:main",
        },
      ],
    };

    const container = document.createElement("div");
    render(renderChatSessionSelect(state, onSwitchSession), container);

    const agentSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-agent-filter="true"]',
    );
    const sessionTrigger = container.querySelector<HTMLButtonElement>(
      'button[data-chat-session-select="true"]',
    );

    expect(agentSelect?.value).toBe("alpha");
    expect(sessionTrigger?.textContent).toContain("main");

    agentSelect!.value = "beta";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onSwitchSession).toHaveBeenCalledWith(state, "agent:beta:dashboard:beta-recent");
  });

  it("keeps agent switch targets after scoped session refreshes", () => {
    const { state } = createChatHeaderState();
    const onSwitchSession = vi.fn();
    state.sessionKey = "agent:alpha:main";
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 3,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        { key: "agent:alpha:main", kind: "direct", updatedAt: 4 },
        { key: "agent:beta:dashboard:beta-recent", kind: "direct", updatedAt: 3 },
        { key: "agent:beta:main", kind: "direct", updatedAt: 2 },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state, onSwitchSession), container);

    state.sessionsResultAgentId = "alpha";
    state.sessionsResult = {
      ts: 1,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [{ key: "agent:alpha:main", kind: "direct", updatedAt: 5 }],
    };
    render(renderChatSessionSelect(state, onSwitchSession), container);

    const agentSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-agent-filter="true"]',
    );
    agentSelect!.value = "beta";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onSwitchSession).toHaveBeenCalledWith(state, "agent:beta:dashboard:beta-recent");
  });

  it("clears cached agent switch targets after a scoped empty refresh", () => {
    const { state } = createChatHeaderState();
    const onSwitchSession = vi.fn();
    state.sessionKey = "agent:alpha:main";
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        { key: "agent:alpha:main", kind: "direct", updatedAt: 4 },
        { key: "agent:beta:dashboard:deleted", kind: "direct", updatedAt: 3 },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state, onSwitchSession), container);

    state.sessionsResultAgentId = "beta";
    state.sessionsResult = {
      ts: 1,
      path: "",
      count: 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [],
    };
    render(renderChatSessionSelect(state, onSwitchSession), container);

    const agentSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-agent-filter="true"]',
    );
    agentSelect!.value = "beta";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onSwitchSession).toHaveBeenCalledWith(state, "agent:beta:main");
  });

  it("renders selector labels from the active locale", async () => {
    await i18n.setLocale("zh-CN");
    const { state } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    expect(
      container
        .querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')
        ?.getAttribute("aria-label"),
    ).toBe(t("chat.selectors.session"));
    const combinedLabel = container
      .querySelector('[data-chat-model-select="true"]')
      ?.getAttribute("aria-label");
    expect(combinedLabel).toContain(t("chat.selectors.model"));
    expect(combinedLabel).toContain(t("chat.selectors.thinkingLevel"));
  });

  it("searches chat sessions inside the picker without replacing recent sessions", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    const originalSessionsResult = state.sessionsResult;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    render(renderChatSessionSelect(state), container);
    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );
    const submit = container.querySelector<HTMLButtonElement>(
      'button[data-chat-session-search-submit="true"]',
    );

    input!.value = " telegram ";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.chatSessionPickerQuery).toBe(" telegram ");
    expect(submit?.disabled).toBe(false);
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(state.chatSessionPickerAppliedQuery).toBe("telegram"));
    render(renderChatSessionSelect(state), container);

    expect(state.chatSessionPickerQuery).toBe(" telegram ");
    expect(state.sessionsResult).toBe(originalSessionsResult);
    expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
      "agent:main:telegram-one",
      "agent:main:telegram-two",
    ]);
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
      search: "telegram",
    });
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("debounces chat session picker search while typing", async () => {
    vi.useFakeTimers();
    const { state, request } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    render(renderChatSessionSelect(state), container);
    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );

    input!.value = "tele";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(299);

    expect(state.chatSessionPickerAppliedQuery).toBe("");
    expect(
      request.mock.calls.some(
        ([method, params]) =>
          method === "sessions.list" &&
          (params as Record<string, unknown> | undefined)?.search === "tele",
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(state.chatSessionPickerAppliedQuery).toBe("tele");
    expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
      "agent:main:telegram-one",
      "agent:main:telegram-two",
    ]);
  });

  it("flushes pending chat session picker search on blur", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    render(renderChatSessionSelect(state), container);
    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );

    input!.value = "tele";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new FocusEvent("blur", { bubbles: false }));

    await vi.waitFor(() => expect(state.chatSessionPickerAppliedQuery).toBe("tele"));
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
      search: "tele",
    });
  });

  it("keeps picker options clickable after blurring an empty search input", async () => {
    const { state } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    const rows: GatewaySessionRow[] = [
      { key: "main", kind: "direct", label: "Main", updatedAt: 2 },
      { key: "agent:main:work", kind: "direct", label: "Work", updatedAt: 1 },
    ];
    state.sessionsResult = createSessionsResultFromRows(rows);
    const request = vi.fn((method: string) => {
      if (method === "sessions.list") {
        return Promise.resolve(createSessionsResultFromRows(rows));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    const onSwitchSession = vi.fn();
    const container = document.createElement("div");
    render(renderChatSessionSelect(state, onSwitchSession), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    await vi.waitFor(() => expect(state.chatSessionPickerResult).not.toBeNull());
    render(renderChatSessionSelect(state, onSwitchSession), container);
    const pickerResultBefore = state.chatSessionPickerResult;
    const requestCountBefore = request.mock.calls.length;

    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );
    expect(input!.value).toBe("");
    input!.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    render(renderChatSessionSelect(state, onSwitchSession), container);

    expect(state.chatSessionPickerResult).toBe(pickerResultBefore);
    expect(state.chatSessionPickerAppliedQuery).toBe("");
    expect(state.chatSessionPickerOpen).toBe(true);
    expect(request).toHaveBeenCalledTimes(requestCountBefore);
    const options = container.querySelectorAll<HTMLButtonElement>(
      'button[data-chat-session-picker-option="true"]',
    );
    const target = [...options].find(
      (button) => button.dataset.sessionKey && button.dataset.sessionKey !== state.sessionKey,
    );
    if (!target?.dataset.sessionKey) {
      throw new Error("expected another session option");
    }
    const targetSessionKey = target.dataset.sessionKey;
    target.click();

    expect(onSwitchSession).toHaveBeenCalledWith(state, targetSessionKey);
  });

  it("clears applied chat session picker search when the input is cleared", async () => {
    const { state } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    render(renderChatSessionSelect(state), container);
    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );
    const submit = container.querySelector<HTMLButtonElement>(
      'button[data-chat-session-search-submit="true"]',
    );

    input!.value = "telegram";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(state.chatSessionPickerAppliedQuery).toBe("telegram"));
    expect(state.chatSessionPickerResult?.sessions).toHaveLength(2);

    input!.value = "";
    input!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(state.chatSessionPickerQuery).toBe("");
    expect(state.chatSessionPickerAppliedQuery).toBe("");
    expect(state.chatSessionPickerResult).toBeNull();
  });

  it("reloads scoped picker rows after clearing search", async () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    const request = vi.fn((method: string, params: Record<string, unknown> = {}) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const search = typeof params.search === "string" ? params.search.trim() : "";
      if (search) {
        return Promise.resolve(
          createSessionsResultFromRows([
            { key: "agent:main:telegram", kind: "direct", label: "Telegram", updatedAt: 5 },
          ]),
        );
      }
      return Promise.resolve(
        createSessionsResultFromRows([
          { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 6 },
          { key: "agent:main:work", kind: "direct", label: "Main work", updatedAt: 4 },
        ]),
      );
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    render(renderChatSessionSelect(state), container);
    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );
    const submit = container.querySelector<HTMLButtonElement>(
      'button[data-chat-session-search-submit="true"]',
    );

    input!.value = "telegram";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
        "agent:main:telegram",
      ]),
    );

    input!.value = "";
    input!.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() =>
      expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
        "agent:main:main",
        "agent:main:work",
      ]),
    );
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
  });

  it("ignores stale chat session picker search responses", async () => {
    const { state } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    let resolveTele!: (value: SessionsListResult) => void;
    let resolveTelegram!: (value: SessionsListResult) => void;
    const request = vi.fn((method: string, params: Record<string, unknown> = {}) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (params.search === "tele") {
        return new Promise<SessionsListResult>((resolve) => {
          resolveTele = resolve;
        });
      }
      if (params.search === "telegram") {
        return new Promise<SessionsListResult>((resolve) => {
          resolveTelegram = resolve;
        });
      }
      return Promise.resolve(state.sessionsResult);
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    render(renderChatSessionSelect(state), container);
    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );

    input!.value = "tele";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
      search: "tele",
    });

    input!.value = "telegram";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
      search: "telegram",
    });

    resolveTelegram(
      createSessionsResultFromRows([
        {
          key: "agent:main:telegram-latest",
          kind: "direct",
          label: "Telegram latest",
          updatedAt: 5,
        },
      ]),
    );
    await vi.waitFor(() => expect(state.chatSessionPickerAppliedQuery).toBe("telegram"));
    expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
      "agent:main:telegram-latest",
    ]);

    resolveTele(
      createSessionsResultFromRows([
        {
          key: "agent:main:tele-stale",
          kind: "direct",
          label: "Tele stale",
          updatedAt: 6,
        },
      ]),
    );
    await flushTasks();

    expect(state.chatSessionPickerAppliedQuery).toBe("telegram");
    expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
      "agent:main:telegram-latest",
    ]);
  });

  it("loads another chat session picker page using the server next offset", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    state.chatSessionPickerOpen = true;
    state.chatSessionPickerSurface = "desktop";
    state.chatSessionPickerQuery = "telegram";
    state.chatSessionPickerAppliedQuery = "telegram";
    state.chatSessionPickerResult = createSessionsResultFromRows(
      [
        { key: "agent:main:telegram-one", kind: "direct", label: "Telegram one", updatedAt: 4 },
        { key: "agent:main:telegram-two", kind: "direct", label: "Telegram two", updatedAt: 3 },
      ],
      {
        hasMore: true,
        nextOffset: 50,
        totalCount: 4,
      },
    );
    const originalSessionsResult = state.sessionsResult;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const loadMore = container.querySelector<HTMLButtonElement>(
      'button[data-chat-session-load-more="true"]',
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[data-chat-session-picker-search="true"]',
    );
    expect(loadMore?.disabled).toBe(false);
    request.mockClear();
    input!.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    await flushTasks();
    expect(request).not.toHaveBeenCalled();

    loadMore!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(state.chatSessionPickerResult?.sessions).toHaveLength(4));

    expect(state.sessionsResult).toBe(originalSessionsResult);
    expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
      "agent:main:telegram-one",
      "agent:main:telegram-two",
      "agent:main:telegram-page-51",
      "agent:main:telegram-page-52",
    ]);
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
      offset: 50,
      search: "telegram",
    });
  });

  it("loads unsearched picker pages from a scoped first page", async () => {
    const { state } = createChatHeaderState();
    state.sessionsIncludeGlobal = false;
    state.sessionsIncludeUnknown = false;
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = createSessionsResultFromRows(
      [
        { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 6 },
        { key: "agent:other:main", kind: "direct", label: "Other agent", updatedAt: 5 },
      ],
      {
        hasMore: true,
        nextOffset: 50,
        totalCount: 100,
      },
    );
    const request = vi.fn((method: string, params: Record<string, unknown> = {}) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const offset =
        typeof params.offset === "number" && Number.isFinite(params.offset) ? params.offset : 0;
      if (offset === 2) {
        return Promise.resolve(
          createSessionsResultFromRows(
            [
              { key: "agent:main:page-three", kind: "direct", label: "Main page 3", updatedAt: 3 },
              { key: "agent:main:page-four", kind: "direct", label: "Main page 4", updatedAt: 2 },
            ],
            { hasMore: false, nextOffset: null, offset: 2, totalCount: 4 },
          ),
        );
      }
      return Promise.resolve(
        createSessionsResultFromRows(
          [
            { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 6 },
            { key: "agent:main:work", kind: "direct", label: "Main work", updatedAt: 4 },
          ],
          { hasMore: true, nextOffset: 2, totalCount: 4 },
        ),
      );
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    await vi.waitFor(() =>
      expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
        "agent:main:main",
        "agent:main:work",
      ]),
    );
    render(renderChatSessionSelect(state), container);

    container
      .querySelector<HTMLButtonElement>('button[data-chat-session-load-more="true"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
        "agent:main:main",
        "agent:main:work",
        "agent:main:page-three",
        "agent:main:page-four",
      ]),
    );

    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
      offset: 2,
    });
    expect(request.mock.calls.some(([, params]) => params?.offset === 50)).toBe(false);
  });

  it("leaves global chat picker requests unscoped", async () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "global";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = createSessionsResultFromRows([
      { key: "global", kind: "global", label: "Global chat", updatedAt: 6 },
      { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 5 },
    ]);
    const request = vi.fn((method: string, params: Record<string, unknown> = {}) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (params.agentId) {
        return Promise.resolve(
          createSessionsResultFromRows([
            { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 5 },
          ]),
        );
      }
      return Promise.resolve(
        createSessionsResultFromRows([
          { key: "global", kind: "global", label: "Global chat", updatedAt: 6 },
          { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 5 },
        ]),
      );
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    const container = document.createElement("div");

    render(renderChatSessionSelect(state), container);
    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();

    await vi.waitFor(() =>
      expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
        "global",
        "agent:main:main",
      ]),
    );

    expect(request).toHaveBeenCalledWith("sessions.list", {
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
    expect(request.mock.calls.some(([, params]) => Object.hasOwn(params ?? {}, "agentId"))).toBe(
      false,
    );
  });

  it("reloads the picker after switching agents", async () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = state.sessionKey;
    state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "configured",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    };
    state.sessionsResult = createSessionsResultFromRows([
      { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 6 },
      { key: "agent:ops:main", kind: "direct", label: "Ops chat", updatedAt: 5 },
    ]);
    const request = vi.fn((method: string, params: Record<string, unknown> = {}) => {
      if (method === "chat.history") {
        const sessionId = typeof params.sessionKey === "string" ? params.sessionKey : "";
        return Promise.resolve({ messages: [], sessionId });
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const agentId = params.agentId === "ops" ? "ops" : "main";
      return Promise.resolve(
        createSessionsResultFromRows([
          {
            key: `agent:${agentId}:main`,
            kind: "direct",
            label: `${agentId} main`,
            updatedAt: 6,
          },
          {
            key: `agent:${agentId}:work`,
            kind: "direct",
            label: `${agentId} work`,
            updatedAt: 4,
          },
        ]),
      );
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    const container = document.createElement("div");

    render(renderChatSessionSelect(state), container);
    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    await vi.waitFor(() =>
      expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
        "agent:main:main",
        "agent:main:work",
      ]),
    );

    switchChatSession(state, "agent:ops:main");
    expect(state.chatSessionPickerResult).toBeNull();
    expect(state.chatSessionPickerAppliedQuery).toBe("");

    render(renderChatSessionSelect(state), container);
    container.querySelector<HTMLButtonElement>('button[data-chat-session-select="true"]')!.click();
    await vi.waitFor(() =>
      expect(state.chatSessionPickerResult?.sessions.map((row) => row.key)).toEqual([
        "agent:ops:main",
        "agent:ops:work",
      ]),
    );

    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "ops",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
  });

  it("keeps Escape inside the chat session picker from bubbling", () => {
    const { state } = createChatHeaderState();
    state.chatSessionPickerOpen = true;
    state.chatSessionPickerSurface = "mobile";
    const documentKeydown = vi.fn();
    document.addEventListener("keydown", documentKeydown);
    try {
      const container = document.createElement("div");
      render(renderChatSessionSelect(state, undefined, { surface: "mobile" }), container);
      const picker = container.querySelector<HTMLElement>(".chat-session-picker");

      picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(state.chatSessionPickerOpen).toBe(false);
      expect(documentKeydown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", documentKeydown);
    }
  });

  it("renders picker pagination controls inside the popover", () => {
    const { state } = createChatHeaderState();
    state.chatSessionPickerOpen = true;
    state.chatSessionPickerSurface = "desktop";
    state.chatSessionPickerResult = {
      ...state.sessionsResult!,
      totalCount: 125,
      limitApplied: 50,
      nextOffset: 50,
      hasMore: true,
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    expect(container.querySelector(".chat-session-picker")).toBeInstanceOf(HTMLElement);
    expect(container.querySelector(".chat-session-picker__footer")?.textContent).toContain(
      "1 / 125",
    );
    expect(container.querySelector('button[data-chat-session-load-more="true"]')).toBeInstanceOf(
      HTMLButtonElement,
    );
  });

  it("renders only active-agent chat sessions in the picker popover", () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = state.sessionKey;
    state.chatSessionPickerOpen = true;
    state.chatSessionPickerSurface = "desktop";
    state.chatSessionPickerResult = createSessionsResultFromRows([
      { key: "agent:main:main", kind: "direct", label: "Main chat", updatedAt: 6 },
      { key: "agent:main:work", kind: "direct", label: "Main work", updatedAt: 5 },
      { key: "agent:other:main", kind: "direct", label: "Other agent", updatedAt: 4 },
      { key: "agent:main:cron:daily", kind: "direct", label: "Cron daily", updatedAt: 3 },
      {
        key: "agent:main:subagent:child",
        kind: "direct",
        label: "Child worker",
        updatedAt: 2,
        spawnedBy: "agent:main:main",
      },
    ]);
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(
      container.querySelectorAll<HTMLElement>(".chat-session-picker__option-label"),
    ).map((node) => node.textContent?.trim());

    expect(labels).toEqual(["Main chat", "Main work"]);
  });

  it("does not render Invalid Date for Date-invalid session picker timestamps", () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = state.sessionKey;
    state.chatSessionPickerOpen = true;
    state.chatSessionPickerSurface = "desktop";
    state.chatSessionPickerResult = createSessionsResultFromRows([
      {
        key: "agent:main:main",
        kind: "direct",
        label: "Main chat",
        updatedAt: 8_640_000_000_000_001,
      },
    ]);
    const container = document.createElement("div");

    render(renderChatSessionSelect(state), container);

    expect(container.textContent).toContain("Main chat");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it("does not add the active session to searched picker rows", () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = state.sessionKey;
    state.chatSessionPickerOpen = true;
    state.chatSessionPickerSurface = "desktop";
    state.chatSessionPickerQuery = "telegram";
    state.chatSessionPickerAppliedQuery = "telegram";
    state.chatSessionPickerResult = createSessionsResultFromRows(
      [{ key: "agent:main:telegram", kind: "direct", label: "Telegram", updatedAt: 5 }],
      { totalCount: 1 },
    );
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(
      container.querySelectorAll<HTMLElement>(".chat-session-picker__option-label"),
    ).map((node) => node.textContent?.trim());

    expect(labels).toEqual(["Telegram"]);
    expect(container.querySelector(".chat-session-picker__count")?.textContent).toBe("1 / 1");
  });

  it("keeps empty searched picker rows empty", () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = state.sessionKey;
    state.chatSessionPickerOpen = true;
    state.chatSessionPickerSurface = "desktop";
    state.chatSessionPickerQuery = "missing";
    state.chatSessionPickerAppliedQuery = "missing";
    state.chatSessionPickerResult = createSessionsResultFromRows([], { totalCount: 0 });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    expect(container.querySelectorAll(".chat-session-picker__option-label")).toHaveLength(0);
    expect(container.querySelector(".chat-session-picker__status")?.textContent).toContain(
      t("sessionsView.noSessions"),
    );
    expect(container.querySelector(".chat-session-picker__count")?.textContent).toBe("0 / 0");
  });

  it("shows provider quota in the chat header when usage data is loaded", () => {
    const { state } = createChatHeaderState();
    state.modelAuthStatusResult = {
      ts: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "Codex",
          status: "ok",
          profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
          usage: {
            windows: [
              { label: "3h", usedPercent: 18 },
              { label: "Week", usedPercent: 72 },
            ],
          },
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const quota = container.querySelector<HTMLAnchorElement>('[data-chat-provider-usage="true"]');
    expect(quota?.textContent?.replace(/\s+/g, " ").trim()).toBe("Usage 28%");
    expect(quota?.getAttribute("href")).toBe("/usage");
    expect(quota?.getAttribute("title")).toContain("Codex · Week");

    quota?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));

    expect(state.setTab).toHaveBeenCalledWith("usage");
  });

  it("falls back to the selected agent's main session when no sessions exist yet", () => {
    const { state } = createChatHeaderState();
    const onSwitchSession = vi.fn();
    state.sessionKey = "agent:alpha:main";
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [{ key: "agent:alpha:main", kind: "direct", updatedAt: 4 }],
    };

    const container = document.createElement("div");
    render(renderChatSessionSelect(state, onSwitchSession), container);

    const agentSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-agent-filter="true"]',
    );
    expect(agentSelect).toBeInstanceOf(HTMLSelectElement);

    agentSelect!.value = "beta";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onSwitchSession).toHaveBeenCalledWith(state, "agent:beta:main");
  });

  it("renders session switch feedback in the chat controls live region", () => {
    const { state } = createChatHeaderState();
    state.sessionSwitchNotice = { id: 1, text: "Switched to Coding" };
    state.sessionSwitchFlashKey = state.sessionKey;

    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const notice = container.querySelector<HTMLElement>(".chat-controls__session-notice");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.getAttribute("aria-live")).toBe("polite");
    expect(notice?.textContent?.trim()).toBe("Switched to Coding");
    expect(container.querySelectorAll(".chat-controls__session-row--flash")).toHaveLength(1);
  });

  it("shows the active agent main session instead of a blank select when no row exists yet", () => {
    const { state } = createChatHeaderState();
    state.sessionKey = "agent:main:main";
    state.settings.sessionKey = "agent:main:main";
    state.agentsList = {
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "all",
      agents: [{ id: "main", name: "MB Black" }],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const sessionTrigger = container.querySelector<HTMLButtonElement>(
      'button[data-chat-session-select="true"]',
    );

    expect(sessionTrigger?.textContent).toContain("Main Session");
    expect(sessionTrigger?.disabled).toBe(false);
  });

  it("patches the current session model and refreshes active tool visibility", async () => {
    const { state, request } = createChatHeaderState();
    state.agentsPanel = "tools";
    state.agentsSelectedId = "main";
    state.toolsEffectiveResultKey = "main:main";
    state.toolsEffectiveResult = {
      agentId: "main",
      profile: "coding",
      groups: [],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = getChatModelSelect(container);
    expect(getChatSelectValue(modelSelect)).toBe("");

    clickChatModelOption(container, "openai/gpt-5-mini");

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "openai/gpt-5-mini",
    });
    expect(request.mock.calls.some(([method]) => method === "chat.history")).toBe(false);
    await flushTasks();
    expect(loadSessionsMock).toHaveBeenCalledTimes(1);
    expect(state.sessionsResult?.sessions[0]?.model).toBe("gpt-5-mini");
    expect(state.sessionsResult?.sessions[0]?.modelProvider).toBe("openai");
    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5-mini");
  });

  it("clears the session model override back to the default model", async () => {
    const { state, request } = createChatHeaderState({ model: "gpt-5-mini" });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = getChatModelSelect(container);
    expect(getChatSelectValue(modelSelect)).toBe("openai/gpt-5-mini");

    clickChatModelOption(container, "");

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: null,
    });
    await flushTasks();
    expect(loadSessionsMock).toHaveBeenCalledTimes(1);
    expect(state.sessionsResult?.sessions[0]?.model).toBeUndefined();
  });

  it("keeps Default available when an explicit model override matches the default", async () => {
    const { state, request } = createChatHeaderState({ model: "gpt-5" });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    clickChatModelOption(container, "");

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: null,
    });
  });

  it("scopes composer speed changes for a selected global-session agent", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionKey = "global";
    state.settings.sessionKey = "global";
    state.assistantAgentId = "beta";
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "global",
        kind: "global",
        modelProvider: "openai",
        model: "gpt-5",
        updatedAt: 1,
      },
    ]);
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    clickChatSpeedOption(container, "on");

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "global",
      agentId: "beta",
      fastMode: true,
    });
  });

  it("scopes composer model changes for a selected global-session agent", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionKey = "global";
    state.settings.sessionKey = "global";
    state.assistantAgentId = "beta";
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "global",
        kind: "global",
        modelProvider: "minimax",
        model: "MiniMax-M2.7",
        updatedAt: 1,
      },
    ]);
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    clickChatModelOption(container, "openai/gpt-5-mini");

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "global",
      agentId: "beta",
      model: "openai/gpt-5-mini",
    });
  });

  it("scopes composer thinking changes for a selected global-session agent", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionKey = "global";
    state.settings.sessionKey = "global";
    state.assistantAgentId = "beta";
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "global",
        kind: "global",
        modelProvider: "openai",
        model: "gpt-5",
        thinkingLevel: "off",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "adaptive", label: "adaptive" },
        ],
        updatedAt: 1,
      },
    ]);
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const adaptive = getThinkingOptions(container).find(
      (option) => option.dataset.chatThinkingOption === "adaptive",
    );
    expect(adaptive).toBeInstanceOf(HTMLButtonElement);
    adaptive?.click();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "global",
      agentId: "beta",
      thinkingLevel: "adaptive",
    });
  });

  it("shows existing speed overrides for providers outside the fast-mode allowlist", async () => {
    const { state, request } = createChatHeaderState();
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "main",
        kind: "direct",
        modelProvider: "custom",
        model: "local-model",
        fastMode: true,
        updatedAt: 1,
      },
    ]);
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    expect(container.querySelectorAll("[data-chat-speed-option]").length).toBe(3);

    clickChatSpeedOption(container, "");

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      fastMode: null,
    });
  });

  it("disables the chat header model picker while a run is active", () => {
    const { state } = createChatHeaderState();
    state.chatRunId = "run-123";
    state.chatStream = "Working";
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = getChatModelSelect(container);
    expect(modelSelect.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the selected model visible when the active session is absent from sessions.list", async () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    clickChatModelOption(container, "openai/gpt-5-mini");
    await flushTasks();
    render(renderChatSessionSelect(state), container);

    const rerendered = getChatModelSelect(container);
    expect(getChatSelectValue(rerendered)).toBe("openai/gpt-5-mini");
  });

  it("keeps the selected model visible after switching away and back to a session", async () => {
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const catalog = createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG, {
      id: "claude-opus-4.5",
      name: "Claude Opus 4.5",
      provider: "bedrock",
    });
    const { state } = createChatHeaderState({ models: catalog });
    let rows: GatewaySessionRow[] = [
      { key: sessionA, kind: "direct", label: "Session A", updatedAt: 2 },
      { key: sessionB, kind: "direct", label: "Session B", updatedAt: 1 },
    ];
    const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "sessions.patch") {
        const key = typeof params.key === "string" ? params.key : "";
        const nextModel = typeof params.model === "string" ? params.model.trim() : "";
        rows = rows.map((row) => {
          if (row.key !== key) {
            return row;
          }
          const nextRow: GatewaySessionRow = { ...row };
          if (!nextModel) {
            delete nextRow.model;
            delete nextRow.modelProvider;
            return nextRow;
          }
          const slashIndex = nextModel.indexOf("/");
          if (slashIndex > 0) {
            nextRow.modelProvider = nextModel.slice(0, slashIndex);
          } else {
            delete nextRow.modelProvider;
          }
          nextRow.model = slashIndex > 0 ? nextModel.slice(slashIndex + 1) : nextModel;
          return nextRow;
        });
        return { ok: true, key };
      }
      if (method === "sessions.list") {
        return createSessionsResultFromRows(rows);
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "tools.effective") {
        return { agentId: "main", profile: "coding", groups: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    state.sessionKey = sessionA;
    state.settings.sessionKey = sessionA;
    state.sessionsResult = createSessionsResultFromRows(rows);
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = getChatModelSelect(container);
    expect(getChatSelectValue(modelSelect)).toBe("");

    clickChatModelOption(container, "bedrock/claude-opus-4.5");
    await flushTasks();

    state.sessionKey = sessionB;
    state.settings.sessionKey = sessionB;
    render(renderChatSessionSelect(state), container);
    expect(getChatSelectValue(getChatModelSelect(container))).toBe("");

    state.sessionKey = sessionA;
    state.settings.sessionKey = sessionA;
    render(renderChatSessionSelect(state), container);

    expect(getChatSelectValue(getChatModelSelect(container))).toBe("bedrock/claude-opus-4.5");
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
    render(renderChatSessionSelect(state), container);

    const thinkingOptions = getThinkingOptions(container);

    expect(thinkingOptions.map((option) => option.dataset.chatThinkingOption)).toEqual([
      "",
      "off",
      "adaptive",
      "xhigh",
      "max",
    ]);
    expect(thinkingOptions.map((option) => option.textContent?.trim())).toEqual([
      "Default",
      "Off",
      "Adaptive",
      "Extra high",
      "Maximum",
    ]);
  });

  it("labels chat thinking default from the active session row", () => {
    const { state } = createChatHeaderState({
      model: "gemma4:hermes-e4b",
      modelProvider: "ollama",
      thinkingDefault: "adaptive",
    });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = getThinkingSelect(container);
    const thinkingOptions = getThinkingOptions(container);

    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(thinkingOptions[0]?.textContent?.trim()).toBe("Default");
    expect(thinkingSelect.title).toContain("Adaptive");
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
    const session = state.sessionsResult!.sessions[0];
    state.sessionsResult = {
      ...state.sessionsResult!,
      defaults: {
        ...state.sessionsResult!.defaults,
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
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = getThinkingSelect(container);
    const thinkingOptions = getThinkingOptions(container);

    expect(thinkingSelect.dataset.chatThinkingDisabled).toBe("true");
    expect(thinkingOptions.map((option) => option.dataset.chatThinkingOption)).toEqual([""]);
    expect(thinkingOptions.map((option) => option.textContent?.trim())).toEqual(["Default"]);
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
    render(renderChatSessionSelect(state), container);

    const thinkingOptions = getThinkingOptions(container);

    expect(thinkingOptions[0]?.textContent?.trim()).toBe("Default");
  });

  it("always renders full thinking labels", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
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
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = getThinkingSelect(container);
    const thinkingOptions = getThinkingOptions(container);

    expect(container.querySelector('[data-chat-thinking-select-compact="true"]')).toBeNull();
    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(thinkingSelect.title).toContain("High");
    expect(thinkingOptions.map((option) => option.textContent?.trim())).toEqual([
      "Default",
      "Off",
      "Low",
      "Medium",
      "High",
      "Extra high",
    ]);
  });

  it("labels chat thinking default from session defaults when the row is absent", () => {
    const { state } = createChatHeaderState({
      defaultsThinkingDefault: "adaptive",
      omitSessionFromList: true,
    });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = getThinkingSelect(container);
    const thinkingOptions = getThinkingOptions(container);

    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(thinkingOptions[0]?.textContent?.trim()).toBe("Default");
    expect(thinkingSelect.title).toContain("Adaptive");
  });
});
