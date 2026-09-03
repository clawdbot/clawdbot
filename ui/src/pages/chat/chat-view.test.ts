/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { UiSettings } from "../../app/settings.ts";
import { i18n, t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import type { SessionPatchOptions } from "../../lib/sessions/patch.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload as registerStoredChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import * as chatProgress from "./chat-progress.ts";
import { switchChatFastMode, switchChatModel, switchChatThinkingLevel } from "./chat-session.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import {
  appendChatBubble,
  createPasteEvent,
  createTestTranscript,
  stubAnimationFrames,
} from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachments.ts";
import { resetChatComposerState } from "./components/chat-composer.ts";
import * as chatMessage from "./components/chat-message.ts";
import { renderChatModelControls } from "./components/chat-model-controls.ts";
import {
  resetThreadPresentation,
  resetTranscriptSession,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";
import { renderWelcomeState } from "./components/chat-welcome.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import {
  workspaceConflictPathForDisplay,
  workspaceResultConflictFromTranscript,
} from "./workspace-conflict.ts";

const registeredAttachmentPayloads = new Map<
  string,
  ReturnType<typeof registerStoredChatAttachmentPayload>
>();

function registerChatAttachmentPayload(
  params: Parameters<typeof registerStoredChatAttachmentPayload>[0],
) {
  const attachment = registerStoredChatAttachmentPayload(params);
  registeredAttachmentPayloads.set(attachment.id, attachment);
  return attachment;
}

function visibleContentForMessages(messages: unknown[]): MessageGroup["visibleContent"] {
  const groups = groupMessages(
    messages.map((message, index) => ({ kind: "message", key: `message:${index}`, message })),
  );
  if (groups.some((group) => group.kind === "group" && group.visibleContent === "non-text")) {
    return "non-text";
  }
  return groups.some((group) => group.kind === "group" && group.visibleContent === "text")
    ? "text"
    : "none";
}

const buildChatItemsMock = vi.fn(
  (props: {
    messages: unknown[];
    stream: string | null;
    streamStartedAt: number | null;
    runWorking?: boolean;
    loading?: boolean;
  }): ReturnType<typeof chatThread.buildCachedChatItems> => {
    const testDivider = props.messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        typeof (message as { testDividerMarker?: unknown }).testDividerMarker === "string",
    ) as { testDividerMarker: string } | undefined;
    if (testDivider) {
      if (testDivider.testDividerMarker === "reset") {
        return [
          {
            kind: "divider",
            key: "divider:reset:test",
            icon: "rotateCcw",
            label: "Session reset",
            description: "The earlier conversation was cleared.",
            timestamp: 1,
          },
        ] as ReturnType<typeof chatThread.buildCachedChatItems>;
      }
      return [
        {
          kind: "divider",
          key: "divider:compaction:test",
          icon: "foldVertical",
          label: "Compacted history",
          description: "The compacted transcript is preserved as a checkpoint.",
          action: {
            kind: "session-checkpoints",
            label: "Open checkpoints",
          },
          timestamp: 1,
        },
      ] as ReturnType<typeof chatThread.buildCachedChatItems>;
    }
    const items: unknown[] = [];
    if (props.messages.length > 0) {
      const virtualRows = props.messages.every(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { testVirtualRow?: unknown }).testVirtualRow === true,
      );
      if (virtualRows) {
        items.push(
          ...props.messages.map((message, index) => {
            const testMessage = message as {
              testVirtualKey?: string;
              testVirtualRole?: string;
            };
            const key = testMessage.testVirtualKey ?? String(index);
            return {
              kind: "group",
              key: `group:${key}`,
              role: testMessage.testVirtualRole ?? (index % 2 === 0 ? "user" : "assistant"),
              messages: [{ key: `message:${key}`, message }],
              visibleContent: visibleContentForMessages([message]),
              timestamp: index + 1,
              isStreaming: false,
            };
          }),
        );
      } else {
        items.push({
          kind: "group",
          key: "group:assistant:test",
          role: "assistant",
          runId: (props.messages.at(-1) as { runId?: string } | undefined)?.runId,
          messages: props.messages.map((message, index) => ({
            key: `message:${index}`,
            message,
          })),
          visibleContent: visibleContentForMessages(props.messages),
          timestamp: 1,
          isStreaming: false,
        });
      }
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
          : {
              kind: "reading-indicator",
              key: "reading:test",
              startedAt: props.streamStartedAt ?? 1,
            },
      );
    } else if (
      props.runWorking === true &&
      !(props.loading === true && props.messages.length === 0)
    ) {
      items.push({
        kind: "reading-indicator",
        key: "reading:test",
        startedAt: props.streamStartedAt ?? 1,
      });
    }
    return items as ReturnType<typeof chatThread.buildCachedChatItems>;
  },
);
const renderMessageGroupMock = vi.fn(
  (
    ...[group, _opts]: Parameters<typeof chatMessage.renderMessageGroup>
  ): ReturnType<typeof chatMessage.renderMessageGroup> => {
    const text = group.messages
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
    return html`<div class="chat-group">${text}</div>`;
  },
);
const chatMediaRenderVersionMock = { value: 0 };

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
  applySettings(patch: Partial<UiSettings>): void;
  loadAssistantIdentity(): void;
  resetChatInputHistoryNavigation(): void;
  resetChatScroll(): void;
  resetToolStream(): void;
};

type ChatProps = Parameters<typeof renderChat>[0];

function createOpenAiModelCatalog(): ModelCatalogEntry[] {
  return [
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
  ];
}

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

function renderStreamGroupMock(
  ...[parts, _opts]: Parameters<typeof chatMessage.renderStreamGroup>
): ReturnType<typeof chatMessage.renderStreamGroup> {
  return html`<div class="chat-stream-run">
    ${parts.map((part) =>
      part.kind === "reading-indicator"
        ? html`<div class="chat-reading-indicator"></div>`
        : html`<div class="chat-stream">${part.kind === "stream" ? part.text : ""}</div>`,
    )}
  </div>`;
}

function renderWorkGroupSummaryMock(
  ..._args: Parameters<typeof chatMessage.renderWorkGroupSummary>
): ReturnType<typeof chatMessage.renderWorkGroupSummary> {
  return html`<div class="chat-work-group"></div>`;
}

beforeEach(() => {
  vi.spyOn(chatThread, "buildCachedChatItems").mockImplementation(buildChatItemsMock);
  vi.spyOn(chatThread, "getExpandedToolCards").mockReturnValue(new Map<string, boolean>());
  vi.spyOn(chatThread, "getExpandedUserMessages").mockReturnValue(new Map<string, boolean>());
  vi.spyOn(chatThread, "syncToolCardExpansionState").mockImplementation(() => undefined);
  vi.spyOn(chatMessage, "getChatMediaRenderVersion").mockImplementation(
    () => chatMediaRenderVersionMock.value,
  );
  vi.spyOn(chatMessage, "renderMessageGroup").mockImplementation(renderMessageGroupMock);
  vi.spyOn(chatMessage, "renderStreamGroup").mockImplementation(renderStreamGroupMock);
  vi.spyOn(chatMessage, "renderWorkGroupSummary").mockImplementation(renderWorkGroupSummaryMock);
});

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
    modelOverrideSource?: GatewaySessionRow["modelOverrideSource"];
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
        modelOverrideSource: overrides.modelOverrideSource,
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
    snapshot: { client, phase: "connected", hello: null },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  const initialSessionsResult = createSessionsListResult({
    model: currentModel,
    modelProvider: currentModelProvider,
    modelOverrideSource: overrides.modelOverrideSource,
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
      navCollapsed: false,
      navWidth: 280,
      sidebarEntries: [],
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
    applySettings(patch: Partial<UiSettings>) {
      state.settings = { ...state.settings, ...patch };
    },
    setRoute: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    resetChatInputHistoryNavigation: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
  };
  sessions.subscribe((next) => {
    state.sessionsResult = next.result;
  });
  return { state, request };
}

function createReasoningHeaderState(
  options: {
    levels?: Array<{ id: string; label: string }>;
    models?: ModelCatalogEntry[];
  } = {},
) {
  const result = createChatHeaderState({
    model: "gpt-5.5",
    modelProvider: "openai",
    models: options.models ?? [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
    thinkingDefault: "high",
  });
  result.state.sessionsResult = createSessionsListResult({
    defaultsModel: "gpt-5.5",
    defaultsProvider: "openai",
    defaultsThinkingDefault: "high",
    defaultsThinkingLevels: options.levels ?? [
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ],
  });
  return result;
}

function createOpenAiHeaderState(overrides: Parameters<typeof createChatHeaderState>[0] = {}) {
  return createChatHeaderState({
    model: "gpt-5.5",
    modelProvider: "openai",
    models: createOpenAiModelCatalog(),
    ...overrides,
  });
}

function getChatModelSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-model-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat model control");
  }
  return select;
}

type ChatModelControlsProps = Parameters<typeof renderChatModelControls>[0];

function createChatModelControlsProps(state: ChatHeaderTestState): ChatModelControlsProps {
  const selectedSession = state.sessionsResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, state.sessionKey),
  );
  return {
    activeRunId: state.chatRunId,
    connected: state.connected,
    gatewayAvailable: Boolean(state.client),
    loading: state.chatLoading,
    modelCatalog: state.chatModelCatalog,
    modelOverrides: state.sessions.state.modelOverrides,
    modelSelectionLocked: selectedSession?.modelSelectionLocked,
    modelSelectionTarget: state.sessionsResult?.defaults.modelSelectionTarget,
    modelSwitching: false,
    modelsLoading: state.chatModelsLoading,
    sending: state.chatSending,
    sessionKey: state.sessionKey,
    selectedSession,
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

function renderModelControls(
  state: ChatHeaderTestState,
  overrides: Partial<ChatModelControlsProps> = {},
  container = document.createElement("div"),
) {
  render(
    renderChatModelControls({ ...createChatModelControlsProps(state), ...overrides }),
    container,
  );
  return container;
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
  const preview = container.querySelector(
    "[data-chat-thinking-preview-committed]:not([hidden]), " +
      "[data-chat-thinking-preview-index]:not([hidden])",
  );
  return preview?.textContent?.trim() ?? "";
}

function requireElement(container: Element, selector: string, label: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`expected ${label}`);
  }
  return element;
}

function getComposerTextarea(container: Element): HTMLTextAreaElement {
  return requireElement(
    container,
    ".agent-chat__composer-combobox > textarea",
    "composer textarea",
  ) as HTMLTextAreaElement;
}

function createDragEvent(type: string, types = ["Files"]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types } });
  return event;
}

function itemAt<T>(items: ArrayLike<T>, index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

function createChatProps(overrides: Partial<ChatProps> = {}): ChatProps {
  const transcript = createTestTranscript();
  const sessionKey = overrides.sessionKey ?? "main";
  const sessionHost = overrides.sessionHost;
  const exactSelectedSession = overrides.sessions?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, sessionKey),
  );
  const selectedSession = Object.hasOwn(overrides, "selectedSession")
    ? overrides.selectedSession
    : (exactSelectedSession ??
      (sessionHost && isUiGlobalScopeConfigured(sessionHost)
        ? overrides.sessions?.sessions.find((row) =>
            uiSessionRowMatchesSelectedChat(sessionHost, row.key, sessionKey),
          )
        : undefined));
  return {
    transcript,
    paneId: "single",
    sessionKey,
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    modelCatalog: [],
    modelSwitching: false,
    queue: [],
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    runError: null,
    approvalCanGrant: false,
    sessions: null,
    selectedSession,
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
    onToggleRealtimeTalk: () => undefined,
    onToggleRealtimeCamera: () => undefined,
    onDismissError: () => undefined,
    onAbort: () => undefined,
    onQueueRemove: () => undefined,
    onQueueSteer: () => undefined,
    onClearHistory: () => undefined,
    onOpenSessionCheckpoints: () => undefined,
    agentsList: null,
    currentAgentId: "main",
    onAgentChange: () => undefined,
    onNavigateToAgent: () => undefined,
    onSessionSelect: () => undefined,
    onOpenSidebar: () => undefined,
    onChatScroll: () => undefined,
    basePath: "",
    ...overrides,
  };
}

function renderChatView(overrides: Partial<ChatProps> = {}) {
  const container = document.createElement("div");
  render(renderChat(createChatProps(overrides)), container);
  return container;
}

function renderChatInto(container: HTMLElement, overrides: Partial<ChatProps> = {}) {
  render(renderChat(createChatProps(overrides)), container);
}

describe("chat typing status", () => {
  it.each([
    {
      actors: [{ id: "ayaan", label: "Ayaan" }],
      expectedText: "Ayaan is typing…",
      expectedAvatars: 1,
    },
    {
      actors: [
        { id: "ayaan", label: "Ayaan" },
        { id: "liam", label: "Liam" },
        { id: "maya", label: "Maya" },
        { id: "zoe", label: "Zoe" },
      ],
      expectedText: "Ayaan, Liam, Maya, Zoe are typing…",
      expectedAvatars: 3,
    },
  ])("renders $expectedText in the transcript", ({ actors, expectedText, expectedAvatars }) => {
    const container = renderChatView({ typingActors: actors });
    const indicator = container.querySelector(".agent-chat__typing-indicator--outside");

    expect(indicator?.closest('[data-virtual-row-key="presence:typing"]')).not.toBeNull();
    expect(indicator?.closest(".agent-chat__composer-shell")).toBeNull();
    expect(indicator?.querySelectorAll(".chat-avatar")).toHaveLength(expectedAvatars);
    expect(
      indicator?.querySelector(".agent-chat__typing-avatars")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(indicator?.textContent).toContain(expectedText);
  });

  it("anchors the run error and queue to the composer without moving transcript presence", () => {
    const container = renderChatView({
      typingActors: [{ id: "ayaan", label: "Ayaan" }],
      runError: { summary: "Gateway unavailable" },
      queue: [{ id: "queued", text: "Try again", createdAt: 1 }],
    });
    const indicator = requireElement(
      container,
      ".agent-chat__typing-indicator--outside",
      "typing status",
    );

    const typingRow = indicator.closest('[data-virtual-row-key="presence:typing"]');
    if (!typingRow) {
      throw new Error("expected typing transcript row");
    }
    const error = requireElement(container, ".chat-error__content", "run error");
    const shell = requireElement(container, ".agent-chat__composer-shell", "composer shell");
    const queue = requireElement(container, ".chat-queue", "composer queue");
    expect(error.textContent).toContain("Gateway unavailable");
    expect(error.closest(".agent-chat__composer-overlay")).not.toBeNull();
    expect(typingRow.compareDocumentPosition(shell)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(queue.closest(".agent-chat__composer-shell")).toBe(shell);
    expect(
      queue.compareDocumentPosition(requireElement(shell, ".agent-chat__input", "composer")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps transcript typing status with the model setup composer", () => {
    const container = renderChatView({
      canSend: false,
      modelSetupRequired: true,
      typingActors: [{ id: "ayaan", label: "Ayaan" }],
    });

    expect(container.querySelector(".agent-chat__typing-indicator--outside")).not.toBeNull();
  });
});

function createBackgroundTasks(
  overrides: Partial<NonNullable<ChatProps["backgroundTasks"]>> = {},
): NonNullable<ChatProps["backgroundTasks"]> {
  return {
    sessionKey: "agent:main:main",
    statusRowId: "chat-tasks-status-test",
    collapsed: false,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [],
    activeCount: 0,
    subagentActivity: {
      rows: [],
      overflowWorking: 0,
      taskIds: new Set<string>(),
      nextExpiryAt: null,
    },
    cancellingTaskIds: new Set<string>(),
    finishedCollapsed: false,
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set<string>(),
    onToggleCollapsed: () => undefined,
    onToggleFinished: () => undefined,
    onRefresh: () => undefined,
    onCancel: () => undefined,
    ...overrides,
  };
}

describe("chat Swarm progress", () => {
  it("stays visible during an active run between the transcript and composer", () => {
    const parentSessionKey = "agent:main:parent";
    const container = renderChatView({
      sessionKey: parentSessionKey,
      canAbort: true,
      showNewMessages: true,
      swarmSessions: [
        {
          key: "agent:main:subagent:worker",
          kind: "direct",
          updatedAt: 1,
          parentSessionKey,
          swarmGroupId: "swarm:agent:main:parent:turn-42",
          label: "Worker A",
          status: "running",
        },
      ],
    });

    const widget = container.querySelector("[data-test-id=chat-swarm]");
    expect(widget).not.toBeNull();
    const scrollAnchor = widget?.previousElementSibling;
    expect(scrollAnchor?.classList.contains("chat-scroll-to-bottom-wrap")).toBe(true);
    expect(scrollAnchor?.previousElementSibling?.classList.contains("chat-thread")).toBe(true);
    expect(widget?.nextElementSibling?.classList.contains("agent-chat__composer-shell")).toBe(true);
    expect(container.querySelector(".chat-swarm__task-name")?.textContent).toBe("Worker A");
  });
});

describe("inline approval card", () => {
  it("renders between the transcript and composer and enforces its grant projection", async () => {
    const onApprovalDecision = vi.fn();
    const inlineApproval = {
      id: "approval-inline",
      kind: "exec",
      request: {
        command: "rm -rf build",
        agentId: "main",
        sessionKey: "agent:main:current",
        commandSpans: [{ startIndex: 0, endIndex: 5 }],
      },
      createdAtMs: 1,
      expiresAtMs: 61_000,
    } satisfies ExecApprovalRequest;

    const container = renderChatView({
      inlineApproval,
      approvalCanGrant: false,
      approvalErrors: new Map([["approval-inline", "Approval failed: gateway unavailable"]]),
      onApprovalDecision,
    });

    const card = container.querySelector(".chat-inline-approval .exec-approval-card");
    const inlineSurface = container.querySelector(".chat-inline-approval");
    expect(card?.getAttribute("data-approval-id")).toBe("approval-inline");
    expect(inlineSurface?.previousElementSibling?.classList.contains("chat-thread")).toBe(true);
    expect(
      inlineSurface?.nextElementSibling?.classList.contains("agent-chat__composer-shell"),
    ).toBe(true);
    const countdown = expectDefined(
      container.querySelector<LitElement>(".exec-approval-countdown"),
      "inline approval countdown",
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    document.body.append(container);
    try {
      await countdown.updateComplete;
      expect(countdown.textContent?.trim()).toBe("expires in 01:00");
    } finally {
      container.remove();
      nowSpy.mockRestore();
    }
    expect(container.querySelector(".exec-approval-command-span")?.textContent).toBe("rm -r");
    expect(container.querySelector(".exec-approval-error")?.textContent).toBe(
      "Approval failed: gateway unavailable",
    );
    expect(container.querySelector(".exec-approval-warning")?.textContent?.trim()).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
      ).every((button) => button.disabled),
    ).toBe(true);
    container.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
    expect(onApprovalDecision).not.toHaveBeenCalled();

    const authorizedContainer = renderChatView({
      inlineApproval,
      approvalCanGrant: true,
      onApprovalDecision,
    });
    authorizedContainer.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
    expect(onApprovalDecision).toHaveBeenCalledWith("approval-inline", "allow-once");
  });
});

describe("chat run error", () => {
  it.each(["run", "request"])(
    "does not offer redundant details for a short %s error",
    async (source) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const message = "Failed to open the plugin state database.";
      for (const diagnostic of [
        message,
        ` \n ${message.replaceAll(" ", "  \t")} \n `,
        `${message}\n${message}`,
        `${message}\n  ${message.replaceAll(" ", "  \t")} \n `,
      ]) {
        const container = renderChatView(
          source === "run" ? { runError: { summary: diagnostic } } : { error: diagnostic },
        );
        const alert = requireElement(container, ".chat-error", "chat error");
        expect(alert.getAttribute("role")).toBe("alert");
        expect(alert.querySelector("strong")?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
          message,
        );
        expect(alert.querySelector("details")).toBeNull();
        expect(alert.textContent).not.toContain("Details");
        expect(alert.querySelectorAll(".chat-copy-btn")).toHaveLength(1);
        alert.querySelector<HTMLButtonElement>('[aria-label="Copy error"]')?.click();
        await Promise.resolve();
        expect(writeText).toHaveBeenLastCalledWith(diagnostic);
      }
    },
  );

  it("keeps Check delivery reachable when exact history deduplicates the retained bubble", () => {
    vi.mocked(chatThread.buildCachedChatItems).mockRestore();
    vi.mocked(chatMessage.renderMessageGroup).mockRestore();
    const onRetrySessionPlacementStartup = vi.fn();
    const container = renderChatView({
      canSend: false,
      messages: [
        {
          role: "user",
          content: "original prompt",
          __openclaw: { idempotencyKey: "initial:user" },
        },
      ],
      placementStartup: {
        sessionKey: "main",
        targetKind: "profile",
        phase: "failed",
        startedAt: 1,
        retryable: true,
        action: "check-delivery",
        initialTurn: {
          id: "initial",
          sendRunId: "initial",
          text: "original prompt",
          createdAt: 1,
          sendAttempts: 1,
          sendState: "unconfirmed",
        },
      },
      onRetrySessionPlacementStartup,
    });
    expect(container.querySelectorAll(".chat-group.user")).toHaveLength(1);
    expect(container.querySelector(".chat-send-status__retry")).toBeNull();
    const action = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-error button"),
    ).find((button) => button.textContent?.trim() === "Check delivery");
    expect(action).toBeDefined();
    action?.click();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
  });

  it.each(["retry", "check-delivery"] as const)(
    "keeps the retained initial turn's %s action usable while ordinary sending is held",
    (action) => {
      vi.mocked(chatThread.buildCachedChatItems).mockRestore();
      vi.mocked(chatMessage.renderMessageGroup).mockRestore();
      const onRetrySessionPlacementStartup = vi.fn();
      const onQueueRetry = vi.fn();
      const container = renderChatView({
        canSend: false,
        queue: [
          {
            id: "ordinary",
            text: "later draft",
            createdAt: 2,
            sendAttempts: 1,
            sendState: "failed",
          },
        ],
        placementStartup: {
          sessionKey: "agent:main:startup",
          targetKind: "profile",
          phase: "failed",
          startedAt: 1,
          retryable: true,
          action,
          error: "Retained initial turn",
          initialTurn: {
            id: "initial",
            text: "original prompt",
            createdAt: 1,
            sendAttempts: 1,
            sendState: action === "retry" ? "failed" : "unconfirmed",
          },
        },
        onRetrySessionPlacementStartup,
        onQueueRetry,
      });
      expect(container.querySelector(".chat-thread")?.textContent).toContain("original prompt");
      expect(container.querySelector(".chat-thread")?.textContent).toContain("later draft");
      const buttons = container.querySelectorAll<HTMLButtonElement>(".chat-send-status__retry");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.textContent?.trim()).toBe(action === "retry" ? "Retry" : "Check delivery");
      buttons[0]?.click();
      expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
      expect(onQueueRetry).not.toHaveBeenCalled();
      expect(container.querySelector(".chat-error")?.textContent).toContain(
        action === "retry" ? "Retained initial turn" : "without resending it or starting a worker",
      );
    },
  );

  it.each([
    ["run", "Error: gateway disconnected\n<img src=x onerror=alert(1)>\nFinal diagnostic line"],
    ["request", "Error: gateway disconnected\n<img src=x onerror=alert(1)>\nFinal diagnostic line"],
    ["run", `Request failed: ${"Long diagnostic text. ".repeat(20)}Final diagnostic line`],
    ["request", `Request failed: ${"Long diagnostic text. ".repeat(20)}Final diagnostic line`],
  ])("exposes the complete %s error as selectable text and a copy action", (source, diagnostic) => {
    const container = renderChatView(
      source === "run" ? { runError: { summary: diagnostic } } : { error: diagnostic },
    );

    const alert = requireElement(container, ".chat-error", "chat run error");
    expect(alert.getAttribute("role")).toBe("alert");
    const details = requireElement(alert, "details", "error disclosure");
    expect(details.hasAttribute("open")).toBe(false);
    const preview = requireElement(details, "strong", "error preview").textContent ?? "";
    expect(preview).not.toContain("Final diagnostic line");
    expect(preview.length).toBeLessThanOrEqual(120);
    if (diagnostic.includes("\n")) {
      expect(preview).toBe("Error: gateway disconnected");
    } else {
      expect(preview).toMatch(/^Request failed: .+…$/u);
    }
    const fullDiagnostic = requireElement(details, "pre", "full diagnostic");
    expect(fullDiagnostic.textContent).toBe(diagnostic);
    expect(fullDiagnostic.getAttribute("tabindex")).toBe("0");
    expect(alert.querySelector("img")).toBeNull();
    expect(alert.querySelector<HTMLButtonElement>('[aria-label="Copy error"]')).not.toBeNull();
    expect(alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]') !== null).toBe(
      source === "request",
    );
    expect(
      alert.closest(source === "run" ? ".agent-chat__composer-overlay" : ".chat-topbar-notices"),
    ).not.toBeNull();
  });

  it.each(["run", "request"])(
    "strips only the decorative prefix from a %s error display and copies the raw diagnostic",
    async (source) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const diagnostic =
        "⚠️ 🛠️ Error:  gateway disconnected near 🧭\n  indented\tdetail\n<img src=x onerror=alert(1)>\nFinal diagnostic line  ";
      const renderedDiagnostic =
        "  Error:  gateway disconnected near 🧭\n  indented\tdetail\n<img src=x onerror=alert(1)>\nFinal diagnostic line  ";
      const onDismissError = vi.fn();
      const onRetrySessionPlacementStartup = vi.fn();
      const container = renderChatView({
        ...(source === "run" ? { runError: { summary: diagnostic } } : { error: diagnostic }),
        onDismissError,
        onRetrySessionPlacementStartup,
      });

      const alert = requireElement(container, ".chat-error", "chat run error");
      expect(alert.getAttribute("role")).toBe("alert");
      const details = requireElement(alert, "details", "error disclosure");
      expect(details.hasAttribute("open")).toBe(false);
      const fullDiagnostic = requireElement(details, "pre", "full diagnostic");
      expect(fullDiagnostic.textContent).toBe(renderedDiagnostic);
      expect(fullDiagnostic.getAttribute("aria-label")).toBe("Error details");
      expect(alert.textContent).not.toMatch(/[⚠🛠]/u);
      expect(alert.textContent).toContain("🧭");
      expect(alert.querySelector("img")).toBeNull();
      const summary = requireElement(details, "summary", "error header");
      expect(summary.textContent).toContain("Details");
      expect(summary.textContent).not.toContain("Error details");
      expect(alert.querySelectorAll(".chat-copy-btn")).toHaveLength(1);
      const copy = summary.querySelector<HTMLButtonElement>('[aria-label="Copy error"]');
      expect(copy).not.toBeNull();
      for (const open of [false, true]) {
        details.toggleAttribute("open", open);
        copy?.click();
        await waitForFast(() => expect(copy?.disabled).toBe(false));
        await waitForFast(() => expect(writeText).toHaveBeenCalledTimes(open ? 2 : 1));
        expect(writeText).toHaveBeenLastCalledWith(diagnostic);
        expect(details.hasAttribute("open")).toBe(open);
      }
      (summary as HTMLElement).click();
      expect(onDismissError).not.toHaveBeenCalled();
      expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
      expect(alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]') !== null).toBe(
        source === "request",
      );
      expect(
        alert.closest(source === "run" ? ".agent-chat__composer-overlay" : ".chat-topbar-notices"),
      ).not.toBeNull();
      alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click();
      expect(onDismissError).toHaveBeenCalledTimes(source === "request" ? 1 : 0);
    },
  );

  it("keeps dismiss on the error state owned by its callback", () => {
    const onDismissError = vi.fn();
    const container = renderChatView({ error: "Request failed", onDismissError });

    container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click();

    expect(onDismissError).toHaveBeenCalledOnce();
    expect(container.querySelector(".chat-error details")).toBeNull();
    expect(container.querySelector(".chat-error")?.closest(".chat-topbar-notices")).not.toBeNull();
  });

  it.each([false, true])("keeps startup Retry owned by retryable=%s", async (retryable) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onRetrySessionPlacementStartup = vi.fn();
    const container = renderChatView({
      placementStartup: {
        sessionKey: "agent:main:startup",
        targetKind: "profile",
        phase: "failed",
        startedAt: 1,
        error: "⚠️ Provisioning failed\n  Final diagnostic line  ",
        retryable,
      },
      onRetrySessionPlacementStartup,
    });
    const alert = requireElement(container, ".chat-error", "startup error");
    expect(requireElement(alert, "pre", "startup diagnostic").textContent).toBe(
      "The session was created, but runner startup failed:  Provisioning failed\n  Final diagnostic line  ",
    );
    expect(alert.textContent).not.toContain("⚠");
    const details = requireElement(alert, "details", "startup disclosure");
    expect(requireElement(details, "summary", "startup header").textContent).toContain("Details");
    expect(requireElement(details, "pre", "startup diagnostic").getAttribute("aria-label")).toBe(
      "Error details",
    );
    const copy = details.querySelector<HTMLButtonElement>('summary [aria-label="Copy error"]');
    expect(copy).not.toBeNull();
    copy?.click();
    await waitForFast(() =>
      expect(writeText).toHaveBeenCalledWith(
        "The session was created, but runner startup failed: ⚠️ Provisioning failed\n  Final diagnostic line  ",
      ),
    );
    expect(details.hasAttribute("open")).toBe(false);
    alert.querySelector<HTMLElement>("summary")?.click();
    expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
    const retry = Array.from(alert.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(Boolean(retry)).toBe(retryable);
    retry?.click();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledTimes(retryable ? 1 : 0);
  });
});

describe("chat compaction divider", () => {
  it("renders checkpoint recovery copy and action", () => {
    const onOpenSessionCheckpoints = vi.fn();
    const container = renderChatView({
      messages: [{ testDividerMarker: "compaction" }],
      onOpenSessionCheckpoints,
    });

    expect(container.querySelector(".chat-divider__title")?.textContent).toBe("Compacted history");
    expect(container.querySelector(".chat-divider__description")?.textContent?.trim()).toBe(
      "The compacted transcript is preserved as a checkpoint.",
    );
    expect(container.querySelector(".chat-divider__icon svg")).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".chat-divider__action");
    expect(button?.textContent?.trim()).toBe("Open checkpoints");

    expect(button).toBeInstanceOf(HTMLButtonElement);
    button!.click();

    expect(onOpenSessionCheckpoints).toHaveBeenCalledTimes(1);
  });

  it("renders the session reset divider title", () => {
    const container = renderChatView({
      messages: [{ testDividerMarker: "reset" }],
    });

    expect(container.querySelector(".chat-divider__title")?.textContent).toBe("Session reset");
  });
});

describe("cloud workspace conflict notice", () => {
  const conflict = {
    paths: [
      "src/[path]-1.ts",
      "src/path-2.ts",
      "src/path-3.ts",
      "src/path-4.ts",
      "src/path-5.ts",
      "src/path-6.ts",
    ],
    stagedResultRef: "refs/openclaw/worker-results/claim-123",
    totalCount: 9,
  };

  it("bounds paths and renders copyable staged-ref guidance", () => {
    const onDismissWorkspaceConflict = vi.fn();
    const container = renderChatView({
      workspaceConflict: conflict,
      onDismissWorkspaceConflict,
    });

    const notice = requireElement(
      container,
      ".chat-workspace-conflict-notice",
      "workspace conflict notice",
    );
    expect(notice.closest(".agent-chat__composer-overlay")).not.toBeNull();
    expect(notice.textContent).toContain("9 cloud workspace conflicts");
    expect(notice.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
    expect(notice.textContent).toContain("+4 more paths");
    expect(notice.textContent).toContain(conflict.stagedResultRef);
    expect(notice.textContent).toContain("Git Bash on Windows");
    expect(notice.textContent).toContain("file/directory conflict");
    expect(notice.textContent).toContain("cloud deleted it");
    expect(notice.textContent).toContain("staged ref is missing");

    const commands = [...notice.querySelectorAll(".chat-workspace-conflict-commands code")].map(
      (element) => element.textContent,
    );
    expect(commands).toEqual([
      "git show 'refs/openclaw/worker-results/claim-123:src/[path]-1.ts'",
      "git checkout 'refs/openclaw/worker-results/claim-123' -- ':(top,literal)src/[path]-1.ts'",
    ]);
    expect(
      notice.querySelector<HTMLButtonElement>('[aria-label="Copy cloud inspect command"]'),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      notice.querySelector<HTMLButtonElement>('[aria-label="Copy take-cloud command"]'),
    ).toBeInstanceOf(HTMLButtonElement);

    notice
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss workspace conflict notice"]')!
      .click();
    expect(onDismissWorkspaceConflict).toHaveBeenCalledTimes(1);
  });

  it("hides the notice after the cleared projection drops the conflict", () => {
    const container = document.createElement("div");
    renderChatInto(container, { workspaceConflict: conflict });
    expect(container.querySelector(".chat-workspace-conflict-notice")).not.toBeNull();

    renderChatInto(container);
    expect(container.querySelector(".chat-workspace-conflict-notice")).toBeNull();
  });

  it.each(["\u001b[201~echo injected\n", "\r", "\u007f", "\u0085"])(
    "keeps terminal-control paths visible without building copyable commands (%j)",
    (controlSequence) => {
      const entryPath = `src/${controlSequence}unsafe.ts`;
      const normalizedConflict = workspaceResultConflictFromTranscript({
        role: "custom",
        customType: "cloud-workspace-conflict",
        details: {
          paths: [entryPath],
          stagedResultRef: "refs/openclaw/worker-results/claim-unsafe",
        },
      });
      expect(normalizedConflict).toBeDefined();
      const container = renderChatView({ workspaceConflict: normalizedConflict });
      expect(container.querySelector(".chat-workspace-conflict-paths code")?.textContent).toBe(
        workspaceConflictPathForDisplay(entryPath),
      );
      expect(container.querySelector(".chat-workspace-conflict-commands")).toBeNull();
      expect(container.textContent).toContain("will not build a copyable shell command");
    },
  );

  it("builds recovery commands for the first shell-safe conflicted path", () => {
    const normalizedConflict = workspaceResultConflictFromTranscript({
      role: "custom",
      customType: "cloud-workspace-conflict",
      details: {
        paths: ["src/unsafe\nname.ts", "src/safe.ts"],
        stagedResultRef: "refs/openclaw/worker-results/claim-mixed",
      },
    });
    const container = renderChatView({ workspaceConflict: normalizedConflict });
    const commands = [...container.querySelectorAll(".chat-workspace-conflict-commands code")].map(
      (element) => element.textContent,
    );
    expect(commands).toEqual([
      "git show 'refs/openclaw/worker-results/claim-mixed:src/safe.ts'",
      "git checkout 'refs/openclaw/worker-results/claim-mixed' -- ':(top,literal)src/safe.ts'",
    ]);
  });

  it("copies the recovery command for the selected conflicted path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const normalizedConflict = workspaceResultConflictFromTranscript({
      role: "custom",
      customType: "cloud-workspace-conflict",
      details: {
        paths: ["src/first.ts", "src/second.ts"],
        stagedResultRef: "refs/openclaw/worker-results/claim-per-row",
      },
    });
    const container = renderChatView({ workspaceConflict: normalizedConflict });
    const rows = container.querySelectorAll(".chat-workspace-conflict-paths li");

    rows[1]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(
      "git checkout 'refs/openclaw/worker-results/claim-per-row' -- ':(top,literal)src/second.ts'",
    );
  });
});

describe("cloud worker disk-space notice", () => {
  it.each([
    {
      status: "warning" as const,
      availableBytes: 400 * 1024 * 1024,
      role: "status",
      title: "Cloud session disk space is low",
      copy: "96% used · 400 MB free. Delete unneeded files or stop the cloud worker before large writes.",
    },
    {
      status: "critical" as const,
      availableBytes: 50 * 1024 * 1024,
      role: "alert",
      title: "Cloud session disk space is critically low",
      copy: "New writes may fail and stop the agent.",
    },
  ])("renders persistent $status action guidance in the compact topbar overlay", (sample) => {
    const container = renderChatView({
      diskSpace: {
        status: sample.status,
        availableBytes: sample.availableBytes,
        totalBytes: 10 * 1024 * 1024 * 1024,
        observedAtMs: 1_000,
      },
    });
    const notice = requireElement(container, ".chat-cloud-disk-space-notice", "disk-space notice");

    expect(notice.getAttribute("role")).toBe(sample.role);
    expect(notice.textContent).toContain(sample.title);
    expect(notice.textContent).toContain(sample.copy);
    expect(notice.querySelector("svg")).not.toBeNull();
    expect(notice.querySelector("button")).toBeNull();
    expect(notice.closest(".chat-topbar-notices")).not.toBeNull();
  });

  it.each(["ok" as const, undefined])("clears for %s disk-space projection", (status) => {
    const container = document.createElement("div");
    renderChatInto(container, {
      diskSpace: {
        status: "warning",
        availableBytes: 400,
        totalBytes: 1_000,
        observedAtMs: 1,
      },
    });
    expect(container.querySelector(".chat-cloud-disk-space-notice")).not.toBeNull();

    renderChatInto(
      container,
      status
        ? {
            diskSpace: {
              status,
              availableBytes: 800,
              totalBytes: 1_000,
              observedAtMs: 2,
            },
          }
        : {},
    );
    expect(container.querySelector(".chat-cloud-disk-space-notice")).toBeNull();
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
  it("keeps earlier history discoverable and retryable until the transcript is exhausted", () => {
    const onShowEarlier = vi.fn();
    const container = document.createElement("div");
    renderChatInto(container, {
      historyPagination: { hasMore: true, loading: false, onShowEarlier },
    });

    const button = requireElement(
      container,
      ".chat-history-boundary__action",
      "earlier history action",
    ) as HTMLButtonElement;
    expect(button.textContent).toContain("Show earlier");
    expect(button.closest(".chat-thread")).not.toBeNull();
    button.click();
    expect(onShowEarlier).toHaveBeenCalledOnce();

    renderChatInto(container, {
      historyPagination: { hasMore: true, loading: true, onShowEarlier },
    });
    const loadingButton = requireElement(
      container,
      ".chat-history-boundary__action",
      "loading earlier history action",
    ) as HTMLButtonElement;
    expect(loadingButton.textContent).toContain("Loading earlier history");
    expect(loadingButton.getAttribute("aria-busy")).toBe("true");
    expect(loadingButton.disabled).toBe(true);
    expect(loadingButton.closest(".chat-history-boundary--loading")).not.toBeNull();

    renderChatInto(container, {
      historyPagination: { hasMore: true, loading: false, onShowEarlier },
    });
    const retryButton = requireElement(
      container,
      ".chat-history-boundary__action",
      "retry earlier history action",
    ) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(false);
    retryButton.click();
    expect(onShowEarlier).toHaveBeenCalledTimes(2);

    renderChatInto(container);
    expect(container.querySelector(".chat-history-boundary")).toBeNull();
    expect(container.querySelector(".chat-history-sentinel")).toBeNull();
  });

  it("renders the boundary in flow above the virtualized transcript", () => {
    const container = renderChatView({
      historyPagination: { hasMore: true, loading: false, onShowEarlier: vi.fn() },
      messages: [{ role: "assistant", content: "hello", timestamp: 1 }],
    });

    const boundary = requireElement(container, ".chat-history-boundary", "history boundary");
    expect(boundary.closest(".chat-thread-inner--virtual")).not.toBeNull();
    expect(boundary.nextElementSibling?.classList.contains("chat-virtual-sizer")).toBe(true);
  });

  it("keeps the auto-load sentinel visually empty while older history loads", () => {
    const container = renderChatView({
      historyPagination: {
        hasMore: true,
        loading: true,
        onShowEarlier: vi.fn(),
      },
    });
    const threadInner = requireElement(container, ".chat-thread-inner", "chat thread inner");
    const sentinel = requireElement(container, ".chat-history-sentinel", "history sentinel");

    expect(threadInner.firstElementChild).toBe(sentinel);
    // The sentinel overlays virtualized rows; content here would paint over
    // real messages. The in-flow boundary row owns the loading affordance.
    expect(sentinel.childElementCount).toBe(0);
  });

  it("loads older history from upward wheel and keyboard intent without a button", () => {
    const onHistoryIntent = vi.fn();
    const container = renderChatView({
      historyPagination: {
        hasMore: true,
        loading: false,
        onShowEarlier: vi.fn(),
      },
      onHistoryIntent,
    });
    const thread = requireElement(container, ".chat-thread", "chat thread");
    const sentinel = requireElement(container, ".chat-history-sentinel", "history sentinel");

    expect(sentinel.querySelector("button")).toBeNull();
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(onHistoryIntent).toHaveBeenCalledTimes(2);
  });

  it("keeps wheel and touch history intent listeners passive", () => {
    const addEventListener = vi.spyOn(EventTarget.prototype, "addEventListener");
    try {
      renderChatView({
        historyPagination: {
          hasMore: true,
          loading: false,
          onShowEarlier: vi.fn(),
        },
        onHistoryIntent: vi.fn(),
      });

      for (const eventName of ["wheel", "touchstart", "touchmove"]) {
        expect(
          addEventListener.mock.calls.some(
            ([type, , options]) =>
              type === eventName &&
              typeof options === "object" &&
              options !== null &&
              "passive" in options &&
              options.passive === true,
          ),
        ).toBe(true);
      }
    } finally {
      addEventListener.mockRestore();
    }
  });
});

describe("retained input navigation", () => {
  it("does not show an inventory banner for a single retained message", () => {
    const historyState = makeChatHost({
      sessionKey: "agent:main:retained-input",
      currentSessionId: "retained-input-session",
    });
    applyChatPendingInputs(historyState, {
      total: 1,
      items: [
        {
          id: "retained-input",
          runId: "retained-run",
          acceptedAt: 100,
          state: "interrupted",
          message: { role: "user", content: "Retained message", timestamp: 100 },
        },
      ],
    });

    const container = renderChatView({ historyState });

    expect(container.querySelector(".chat-history-error--inline")).toBeNull();
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

  const globalHost = {
    agentsList: { defaultId: "work", mainKey: "main", scope: "global" as const },
    hello: null,
  };
  const message = [{ role: "user", content: "hi", timestamp: 1 }] satisfies Parameters<
    typeof renderChat
  >[0]["messages"];
  const avatarCase = (
    sessionKey: string,
    direct: boolean,
    overrides: Partial<Parameters<typeof renderChat>[0]> = {},
  ) => ({ props: { sessionKey, messages: message, ...overrides }, direct });

  it.each([
    {
      name: "classifies by canonical session kind even when DM rows carry sender labels",
      cases: [
        avatarCase("kind-direct", true, {
          sessions: sessionsListWithKind("kind-direct", "direct"),
          messages: labeledHistory,
        }),
        avatarCase("kind-group", false, {
          sessions: sessionsListWithKind("kind-group", "group"),
        }),
      ],
    },
    {
      name: "keeps avatars in global sessions, which can aggregate group senders",
      cases: [avatarCase("global", false)],
    },
    {
      name: "matches session metadata across equivalent alias keys",
      cases: [
        avatarCase("main", true, {
          sessions: sessionsListWithKind("agent:main:main", "direct"),
          messages: labeledHistory,
        }),
      ],
    },
    {
      name: "keeps avatars in direct sessions when the gateway attributes identities",
      cases: [
        avatarCase("kind-direct", false, {
          sessions: sessionsListWithKind("kind-direct", "direct"),
          messages: labeledHistory,
          userId: "profile-1",
        }),
      ],
    },
    {
      name: "falls back to session-key shape when session metadata is missing",
      cases: [
        avatarCase("agent:main:telegram:direct:2", true, { messages: labeledHistory }),
        avatarCase("agent:main:telegram:group:42", false),
      ],
    },
    {
      name: "keeps avatars when a main alias selects the canonical global row",
      cases: [
        avatarCase("agent:work:main", false, {
          sessions: sessionsListWithKind("global", "global"),
          sessionHost: globalHost,
        }),
      ],
    },
    {
      name: "classifies global-scope main aliases without a listed global row",
      cases: [avatarCase("agent:work:main", false, { sessionHost: globalHost })],
    },
    {
      name: "ignores stray global rows for main aliases outside global scope",
      cases: [
        avatarCase("agent:work:main", true, {
          sessions: sessionsListWithKind("global", "global"),
          sessionHost: {
            agentsList: { defaultId: "work", mainKey: "main", scope: "per-sender" as const },
            hello: null,
          },
        }),
      ],
    },
    {
      name: "prefers the equivalent direct row over a global row for main aliases",
      cases: [
        avatarCase("agent:work:main", true, {
          sessions: createSessionsResultFromRows([
            { key: "global", kind: "global", updatedAt: 2 },
            { key: "agent:work:main", kind: "direct", updatedAt: 1 },
          ]),
          sessionHost: globalHost,
        }),
      ],
    },
    {
      name: "treats explicit agent global keys as global even without a session row",
      cases: [avatarCase("agent:work:global", false)],
    },
    {
      name: "keeps avatars when a forwarded cross-session message joins a direct thread",
      cases: [
        avatarCase("kind-direct", false, {
          sessions: sessionsListWithKind("kind-direct", "direct"),
          messages: [
            { role: "user", content: "hi", timestamp: 1 },
            {
              role: "assistant",
              content: "forwarded report",
              timestamp: 2,
              senderLabel: "Forwarded from scout",
              senderSession: { sessionKey: "agent:scout:main", agentId: "scout" },
              provenance: {
                kind: "inter_session",
                sourceSessionKey: "agent:scout:main",
                sourceTool: "sessions_send",
              },
            },
          ],
        }),
      ],
    },
  ])("$name", ({ cases }) => {
    for (const { props, direct } of cases) {
      const container = renderChatView(props);
      expect(
        requireElement(container, ".chat-thread", "chat thread").classList.contains(
          "chat-thread--direct",
        ),
      ).toBe(direct);
    }
  });
});

describe("chat code-block copy", () => {
  it.each([
    { name: "keeps legacy raw data-code payloads copyable", payload: "legacy text" },
    {
      name: "does not decode unmarked raw data-code payloads that start with the block-art prefix",
      payload: 'openclaw:block-art-code:"literal"',
    },
  ])("$name", async ({ payload }) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderChatView();
    const thread = requireElement(container, ".chat-thread", "chat thread");
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

describe("chat transcript rendering", () => {
  it("refreshes cached inline reply handlers when the callback identity changes", () => {
    const transcript = createTestTranscript();
    const firstReply = vi.fn();
    const currentReply = vi.fn();
    const message = { role: "assistant", content: "Reply target", timestamp: 1 };
    const messages = [message];
    const stableChatItems = [
      {
        kind: "group",
        key: "group:assistant:reply-callback-cache",
        role: "assistant",
        visibleContent: "text",
        messages: [{ key: "message:reply-callback-cache", message }],
        timestamp: 1,
        isStreaming: false,
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>;
    const defaultBuildChatItems = buildChatItemsMock.getMockImplementation();
    const defaultRenderMessageGroup = renderMessageGroupMock.getMockImplementation();
    buildChatItemsMock.mockReturnValue(stableChatItems);
    renderMessageGroupMock.mockImplementation(
      (
        ...[_group, opts]: Parameters<typeof chatMessage.renderMessageGroup>
      ): ReturnType<typeof chatMessage.renderMessageGroup> => html`
        <button
          aria-label="Reply to message"
          @click=${() =>
            opts.onReply?.({
              messageId: "assistant-message",
              senderLabel: "Val",
              text: "Reply target",
            })}
        >
          Reply
        </button>
      `,
    );
    const container = document.createElement("div");
    const renderWithReply = (onSetReply: typeof firstReply) => {
      render(
        renderChat(
          createChatProps({
            paneId: "reply-callback-cache",
            transcript,
            messages,
            onSetReply,
          }),
        ),
        container,
      );
    };

    renderWithReply(firstReply);
    renderWithReply(currentReply);
    expect(renderMessageGroupMock).toHaveBeenCalledOnce();
    requireElement(
      container,
      '[aria-label="Reply to message"]',
      "inline reply button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    if (defaultRenderMessageGroup) {
      renderMessageGroupMock.mockImplementation(defaultRenderMessageGroup);
    }
    if (defaultBuildChatItems) {
      buildChatItemsMock.mockImplementation(defaultBuildChatItems);
    }

    expect(firstReply).not.toHaveBeenCalled();
    expect(currentReply).toHaveBeenCalledOnce();
  });

  it("passes the full loaded history to one render path and leaves scroll ownership to the pane", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));
    const onRequestUpdate = vi.fn();
    const onChatScroll = vi.fn();

    const container = renderChatView({ messages, onRequestUpdate, onChatScroll });

    const input = buildChatItemsMock.mock.lastCall?.[0] as Record<string, unknown>;
    expect(input.messages).toBe(messages);
    expect(input).not.toHaveProperty("historyRenderLimit");

    onRequestUpdate.mockClear();
    const thread = requireElement(container, ".chat-thread", "chat thread");
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(onChatScroll).toHaveBeenCalledOnce();
    expect(onRequestUpdate).not.toHaveBeenCalled();
  });

  it("mounts a bounded end-anchored range for long transcripts", () => {
    const messages = Array.from({ length: 500 }, (_, index) => ({
      testVirtualRow: true,
      content: `message ${index}`,
    }));

    const container = renderChatView({ messages });
    const rows = [...container.querySelectorAll(".chat-virtual-row")];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(40);
    expect(container.textContent).toContain("message 499");
    expect(container.textContent).not.toContain("message 0");
    expect(container.querySelector(".chat-thread")?.getAttribute("aria-live")).toBe("off");
    expect(rows.every((row) => row.getAttribute("aria-live") === null)).toBe(true);
    const announcement = requireElement(
      container,
      ".chat-transcript-announcement",
      "chat transcript announcement",
    );
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(announcement.getAttribute("aria-atomic")).toBe("true");
    expect(announcement.textContent).toBe("");
  });

  it("announces only a genuinely appended assistant row", () => {
    const transcript = createTestTranscript();
    const container = document.createElement("div");
    const message = (key: string, role: "user" | "assistant", content: string) => ({
      testVirtualRow: true,
      testVirtualKey: key,
      testVirtualRole: role,
      content,
    });
    const renderMessages = (messages: unknown[]) =>
      renderChatInto(container, { transcript, messages });

    const existing = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Existing answer"),
    ];
    renderMessages(existing);
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");

    renderMessages([
      message("older-user", "user", "Older question"),
      message("older-assistant", "assistant", "Older answer"),
      ...existing,
    ]);
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");

    renderMessages([
      message("older-user", "user", "Older question"),
      message("older-assistant", "assistant", "Older answer"),
      ...existing,
      message("user-2", "user", "New question"),
      message("assistant-2", "assistant", "New answer"),
    ]);
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "New answer",
    );
  });

  it.each(["ordinary", "active", "completed"])(
    "announces named attachment failures within the cap in %s assistant rows",
    (flow) => {
      const transcript = createTestTranscript();
      const container = document.createElement("div");
      const existing = {
        testVirtualRow: true,
        testVirtualKey: "assistant-existing",
        testVirtualRole: "assistant",
        role: "assistant",
        content: "Existing answer",
      };
      const renderMessages = (messages: unknown[]) =>
        renderChatInto(container, { transcript, messages });

      renderMessages([existing]);
      expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");
      const attachmentOnly = {
        testVirtualRow: true,
        testVirtualKey: "assistant-missing-attachment",
        testVirtualRole: "assistant",
        role: "assistant",
        content: [
          {
            type: "attachment_error",
            attachment: { code: "file-not-found", kind: "document", label: "missing.pdf" },
          },
        ],
      };
      renderMessages([existing, attachmentOnly]);
      expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
        "missing.pdf: Not sent. File not found. Check the path and try again.",
      );

      const mixed = {
        testVirtualRow: true,
        testVirtualKey: "assistant-mixed-attachments",
        testVirtualRole: "assistant",
        role: "assistant",
        content: [
          { type: "text", text: "Partial result" },
          {
            type: "attachment_error",
            attachment: {
              code: "unsupported-format",
              kind: "document",
              label: "settings.toml",
            },
          },
        ],
      };
      renderMessages([existing, attachmentOnly, mixed]);
      const mixedAnnouncement = container.querySelector(
        ".chat-transcript-announcement",
      )?.textContent;

      const runBoundary = {
        kind: "group" as const,
        key: "group:user:attachment-run",
        role: "user" as const,
        visibleContent: "text" as const,
        messages: [
          {
            key: "user:attachment-run",
            message: {
              role: "user",
              content: "Send the attachment",
              __openclaw: {
                id: "user:attachment-run",
                idempotencyKey: "attachment-run:user",
              },
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      };
      const completedFailure = {
        kind: "group" as const,
        key: "group:assistant:attachment-run",
        role: "assistant" as const,
        visibleContent: "non-text" as const,
        messages: [
          {
            key: "assistant:attachment-run",
            message: {
              role: "assistant",
              content: attachmentOnly.content,
              runId: "attachment-run",
            },
          },
        ],
        timestamp: 2,
        isStreaming: false,
        runId: "attachment-run",
      };
      vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
        runBoundary,
        completedFailure,
      ] as ReturnType<typeof chatThread.buildCachedChatItems>);
      renderChatInto(container, {
        transcript,
        messages: [runBoundary, completedFailure],
      });
      expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
        "missing.pdf: Not sent. File not found. Check the path and try again.",
      );

      for (const [index, prose] of [
        "Here is the requested summary. ".repeat(25),
        `${"x".repeat(430)}🦞${"y".repeat(100)}`,
      ].entries()) {
        const message = {
          role: "assistant",
          content: [{ type: "text", text: prose }, ...attachmentOnly.content],
          runId: "attachment-run",
        };
        const reply = {
          ...completedFailure,
          key: `group:assistant:long-${index}`,
          messages: [{ key: `assistant:long-${index}`, message }],
          isStreaming: flow === "active",
        };
        const items = flow === "ordinary" ? [reply] : [runBoundary, reply];
        vi.mocked(chatThread.buildCachedChatItems).mockReturnValue(items);
        renderChatInto(container, { transcript, messages: items });
        const announcement = expectDefined(
          container.querySelector(".chat-transcript-announcement")?.textContent,
          "attachment failure announcement",
        );
        expect(announcement).toContain(
          "missing.pdf: Not sent. File not found. Check the path and try again.",
        );
        expect(announcement).toContain(prose.slice(0, 30));
        expect(announcement.length).toBe(index === 0 ? 500 : 499);
        expect(announcement).not.toMatch(/[\uD800-\uDFFF]/u);

        vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
          ...items.slice(0, -1),
          { ...reply, messages: [{ key: `assistant:long-${index}`, message: mixed }] },
        ]);
        renderChatInto(container, { transcript, messages: [mixed] });
        expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
          announcement,
        );
      }
      expect(mixedAnnouncement).toBe(
        "settings.toml: Not sent. Rejected by the local attachment allowlist. Send a supported file type. Partial result",
      );
    },
  );

  it("announces a run preamble and its later terminal answer separately", () => {
    const transcript = createTestTranscript();
    const container = document.createElement("div");
    const user = {
      kind: "group",
      key: "group:user:announcement",
      role: "user",
      visibleContent: "text",
      messages: [
        {
          key: "message:user:announcement",
          message: {
            role: "user",
            content: "Start",
            __openclaw: { id: "user:announcement", idempotencyKey: "run-announcement:user" },
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const renderItems = (items: ReturnType<typeof chatThread.buildCachedChatItems>) => {
      vi.mocked(chatThread.buildCachedChatItems).mockReturnValue(items);
      renderChatInto(container, { transcript, messages: items });
    };

    renderItems([user] as ReturnType<typeof chatThread.buildCachedChatItems>);
    const stream = {
      kind: "stream" as const,
      key: "stream:announcement",
      text: "Latest streamed narration",
      startedAt: 2,
      isStreaming: true,
      runId: "run-announcement",
      boundaryId: "send:run-announcement",
    };
    renderItems([
      user,
      stream,
      {
        kind: "reading-indicator",
        key: "reading:announcement",
        startedAt: 2,
        runId: "run-announcement",
        boundaryId: "send:run-announcement",
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);

    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "Latest streamed narration",
    );

    renderItems([
      user,
      {
        kind: "group",
        key: "group:assistant:persisted-announcement",
        role: "assistant",
        visibleContent: "text",
        messages: [
          {
            key: "assistant:persisted-announcement",
            message: {
              role: "assistant",
              content: "Persisted narration while the run continues",
              runId: "run-announcement",
            },
          },
        ],
        timestamp: 3,
        isStreaming: false,
        runId: "run-announcement",
      },
      {
        kind: "reading-indicator",
        key: "reading:persisted-announcement",
        startedAt: 4,
        runId: "run-announcement",
        boundaryId: "send:run-announcement",
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);

    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "Persisted narration while the run continues",
    );

    renderItems([
      user,
      { ...stream, isStreaming: false },
      {
        kind: "group",
        key: "group:tool:announcement",
        role: "tool",
        visibleContent: "text",
        messages: [
          {
            key: "tool:announcement",
            message: {
              role: "toolResult",
              content: "Tool output",
              runId: "run-announcement",
            },
          },
        ],
        timestamp: 3,
        isStreaming: false,
        runId: "run-announcement",
      },
      {
        kind: "group",
        key: "group:assistant:announcement",
        role: "assistant",
        visibleContent: "text",
        messages: [
          {
            key: "assistant:announcement",
            message: {
              role: "assistant",
              phase: "final_answer",
              content: "Terminal answer",
              runId: "run-announcement",
            },
          },
        ],
        timestamp: 4,
        isStreaming: false,
        runId: "run-announcement",
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);

    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "Terminal answer",
    );
  });

  it("does not announce appended rows from an inactive split pane", () => {
    const transcript = createTestTranscript();
    const container = document.createElement("div");
    const existing = {
      testVirtualRow: true,
      testVirtualKey: "assistant-1",
      testVirtualRole: "assistant",
      content: "Existing answer",
    };
    const appended = {
      testVirtualRow: true,
      testVirtualKey: "assistant-2",
      testVirtualRole: "assistant",
      content: "New answer",
    };

    renderChatInto(container, { announceTranscript: false, transcript, messages: [existing] });
    renderChatInto(container, {
      announceTranscript: false,
      transcript,
      messages: [existing, appended],
    });

    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");
  });
});

describe("chat goal status", () => {
  function goalSession(
    goal: Partial<NonNullable<GatewaySessionRow["goal"]>> = {},
  ): GatewaySessionRow {
    return {
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
    };
  }

  it("renders the goal pill with status, objective, and elapsed time", () => {
    const container = renderChatView({ selectedSession: goalSession() });

    const goal = container.querySelector(".agent-chat__goal");
    expect(goal?.querySelector(".agent-chat__goal-label")?.textContent).toBe("Pursuing goal");
    expect(goal?.querySelector(".agent-chat__goal-objective")?.textContent).toBe(
      "Land the web goal UI",
    );
    expect(goal?.querySelector(".agent-chat__goal-elapsed")?.textContent).toBe("15s");
    expect(goal?.getAttribute("aria-label")).toBe("Pursuing goal (12k/50k): Land the web goal UI");
    expect(goal?.closest(".agent-chat__goal-float")).not.toBeNull();
    expect(goal?.closest(".agent-chat__composer-status-stack")).toBeNull();
  });

  it("dispatches typed goal actions from the pill controls", () => {
    const onGoalAction = vi.fn();
    const container = renderChatView({ selectedSession: goalSession(), onGoalAction });

    container.querySelector<HTMLButtonElement>('button[aria-label="Pause goal"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Clear goal"]')?.click();

    expect(onGoalAction).toHaveBeenNthCalledWith(1, "goal-1", "pause");
    expect(onGoalAction).toHaveBeenNthCalledWith(2, "goal-1", "clear");
    expect(container.querySelector('button[aria-label="Resume goal"]')).toBeNull();
  });

  it("offers resume instead of pause for paused goals", () => {
    const onGoalAction = vi.fn();
    const container = renderChatView({
      selectedSession: goalSession({ status: "paused", pausedAt: Date.now() }),
      onGoalAction,
    });

    expect(container.querySelector('button[aria-label="Pause goal"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('button[aria-label="Resume goal"]')?.click();
    expect(onGoalAction).toHaveBeenCalledWith("goal-1", "resume");
  });

  it("edits the plain objective and restores the conversation draft on cancellation", () => {
    let draft = "Keep my conversation draft";
    const container = document.createElement("div");
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const draw = () =>
      renderChatInto(container, {
        selectedSession: goalSession(),
        draft,
        getDraft: () => draft,
        onGoalAction: vi.fn(),
        onGoalSubmit: vi.fn(async () => true),
        onDraftChange,
        onRequestUpdate: draw,
      });
    draw();

    container.querySelector<HTMLButtonElement>('button[aria-label="Edit goal"]')?.click();

    expect(onDraftChange).toHaveBeenCalledWith("Land the web goal UI", undefined);
    expect(container.querySelector(".agent-chat__goal-mode")?.textContent).toContain("Edit goal");
    container.querySelector<HTMLButtonElement>('button[aria-label="Cancel goal entry"]')?.click();
    expect(draft).toBe("Keep my conversation draft");
    expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
  });

  it("expands goal details on demand", () => {
    const props = createChatProps({
      selectedSession: goalSession({ lastStatusNote: "Waiting for CI" }),
      onGoalAction: vi.fn(),
    });
    const container = document.createElement("div");
    render(renderChat(props), container);

    expect(container.querySelector(".agent-chat__goal-detail")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show goal details"]',
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.click();
    render(renderChat(props), container);

    const detail = container.querySelector(".agent-chat__goal-detail");
    expect(detail?.getAttribute("aria-hidden")).toBe("false");
    expect(detail?.querySelector(".agent-chat__goal-detail-objective")?.textContent).toBe(
      "Land the web goal UI",
    );
    expect(detail?.querySelector(".agent-chat__goal-detail-note")?.textContent).toBe(
      "Waiting for CI",
    );
    expect(
      Array.from(detail?.querySelectorAll(".agent-chat__goal-detail-meta > span") ?? []).map(
        (element) => element.textContent?.trim(),
      ),
    ).toEqual(["12k/50k", "·", "15s"]);
    expect(
      container
        .querySelector('button[aria-label="Hide goal details"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("hides goal action buttons when the composer cannot send", () => {
    const container = renderChatView({
      selectedSession: goalSession(),
      onGoalAction: vi.fn(),
      connected: false,
    });

    expect(container.querySelector('button[aria-label="Pause goal"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Show goal details"]')).not.toBeNull();
  });
});

describe("chat scroll-to-bottom affordance", () => {
  it("anchors immediately after the transcript and above every rendered footer surface", () => {
    const onScrollToBottom = vi.fn();
    const container = renderChatView({
      showNewMessages: true,
      onScrollToBottom,
      inlineApproval: {
        id: "approval-below-scroll-anchor",
        kind: "exec",
        request: {
          command: "pnpm test",
          agentId: "main",
          sessionKey: "agent:main:current",
          commandSpans: [],
        },
        createdAtMs: 1,
        expiresAtMs: 61_000,
      },
      onApprovalDecision: vi.fn(),
      queue: [{ id: "queued-below-scroll-anchor", text: "queued message", createdAt: 1 }],
    });

    const button = container.querySelector<HTMLButtonElement>(".chat-scroll-to-bottom");
    const wrapper = button?.closest(".chat-scroll-to-bottom-wrap");
    expect(button?.getAttribute("aria-label")).toBe("Scroll to latest");
    expect(wrapper?.previousElementSibling?.classList.contains("chat-thread")).toBe(true);
    expect(wrapper?.nextElementSibling?.classList.contains("chat-inline-approval")).toBe(true);
    for (const surface of container.querySelectorAll(
      ".chat-inline-approval, .chat-queue, .agent-chat__composer-shell",
    )) {
      expect(wrapper?.compareDocumentPosition(surface) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
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

    const wrapper = requireElement(container, ".chat-scroll-to-bottom-wrap", "scroll affordance");
    const shell = requireElement(container, ".agent-chat__composer-shell", "composer shell");
    const queue = requireElement(container, ".chat-queue", "composer queue");
    const composer = requireElement(shell, ".agent-chat__input", "composer");
    expect(wrapper.nextElementSibling).toBe(shell);
    expect(queue.closest(".agent-chat__composer-shell")).toBe(shell);
    expect(queue.compareDocumentPosition(composer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

  it("renders session controls in the composer without owning side-panel content", () => {
    const container = renderChatView({
      composerControls: html`<button class="test-composer-control">Model</button>`,
      permissionPicker: {
        canSelectFull: true,
        mode: "workspace",
        onSelect: vi.fn(),
      },
    });

    const composerControl = container.querySelector(
      ".agent-chat__composer-controls .test-composer-control",
    );
    const permissionControl = container.querySelector('[data-chat-permission-select="true"]');
    expect(composerControl).not.toBeNull();
    expect(composerControl?.closest(".agent-chat__composer-footer")).not.toBeNull();
    expect(permissionControl?.closest(".agent-chat__composer-meta")).not.toBeNull();
    expect(permissionControl?.closest(".chat-composer-model-control")).toBeNull();
    expect(permissionControl!.compareDocumentPosition(composerControl!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container.querySelector(".agent-chat__composer-header")).toBeNull();
    expect(container.querySelector(".chat-workspace-rail")).toBeNull();
  });

  it("opens inline Markdown images", () => {
    const onOpenImage = vi.fn();
    const src = "data:image/png;base64,cG5n";
    const container = renderChatView({ onOpenImage });
    const trigger = document.createElement("button");
    trigger.className = "markdown-inline-image-button";
    const inlineImage = document.createElement("img");
    inlineImage.className = "markdown-inline-image";
    inlineImage.src = src;
    inlineImage.alt = "Markdown preview";
    trigger.append(inlineImage);
    container.querySelector(".chat")?.append(trigger);

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenImage).toHaveBeenCalledWith({ src, title: "Markdown preview" });

    const fallbackContainer = renderChatView();
    const fallbackTrigger = trigger.cloneNode(true) as HTMLButtonElement;
    fallbackContainer.querySelector(".chat")?.append(fallbackTrigger);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fallbackTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openSpy).toHaveBeenCalledWith(src, "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("shows the running-tasks status row after the turn settles, not while working", () => {
    const backgroundTasks = createBackgroundTasks({
      collapsed: true,
      tasks: [
        {
          id: "task-1",
          taskId: "task-1",
          status: "running" as const,
          agentId: "main",
          createdAt: 1_000,
          startedAt: 1_500,
        },
      ],
    });
    const messages = [{ role: "assistant", content: "done", timestamp: 1 }];

    const settled = renderChatView({ messages, backgroundTasks });
    const row = settled.querySelector(".chat-tasks-status");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".chat-tasks-status__link")?.textContent?.trim()).toBe(
      "1 running task",
    );

    // The working claw owns the signal while the run is live.
    const working = renderChatView({ messages, backgroundTasks, canAbort: true });
    expect(working.querySelector(".chat-tasks-status")).toBeNull();
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

  it("uses the primary action for voice with only the compact device-picker caret", () => {
    const container = renderChatView({
      onToggleRealtimeTalk: () => undefined,
    });

    const voiceButton = container.querySelector('button[aria-label="Start voice input"]');
    expect(voiceButton).not.toBeNull();
    expect(voiceButton?.closest(".agent-chat__composer-trail")).not.toBeNull();
    expect(container.querySelector('button[aria-label="Talk settings"]')).toBeNull();
    // The mic device picker is a caret on the voice button, not a separate settings button.
    const picker = container.querySelector('button[aria-label="Microphone input"]');
    expect(picker?.classList.contains("chat-talk-input-picker__trigger")).toBe(true);
  });
});

afterEach(() => {
  releaseChatAttachmentPayloads([...registeredAttachmentPayloads.values()]);
  registeredAttachmentPayloads.clear();
  vi.useRealTimers();
  buildChatItemsMock.mockClear();
  renderMessageGroupMock.mockClear();
  chatMediaRenderVersionMock.value = 0;
  resetChatViewState();
  replaceSlashCommands(buildFallbackSlashCommands());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("per-pane chat presentation state", () => {
  it("moves focus into and back out of thread search for the physical shortcut", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onRequestUpdate = vi.fn(() => renderChatInto(container, { onRequestUpdate }));
    try {
      renderChatInto(container, { onRequestUpdate });
      const composer = getComposerTextarea(container);
      composer.focus();
      const event = new KeyboardEvent("keydown", {
        key: "а",
        code: "KeyF",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });

      composer.dispatchEvent(event);
      await Promise.resolve();

      expect(event.defaultPrevented).toBe(true);
      expect(onRequestUpdate).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(
        container.querySelector<HTMLInputElement>('.agent-chat__search-bar input[type="text"]'),
      );

      const closeEvent = new KeyboardEvent("keydown", {
        key: "а",
        code: "KeyF",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement?.dispatchEvent(closeEvent);
      await Promise.resolve();

      expect(closeEvent.defaultPrevented).toBe(true);
      expect(onRequestUpdate).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(composer);
      expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
    } finally {
      container.remove();
    }
  });

  it("returns focus to the composer when the original target disappears", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onRequestUpdate = vi.fn(() => renderChatInto(container, { onRequestUpdate }));
    try {
      renderChatInto(container, { onRequestUpdate });
      const composer = getComposerTextarea(container);
      const transientTarget = document.createElement("button");
      const chat = container.querySelector<HTMLElement>(".card.chat");
      if (!chat) {
        throw new Error("expected chat section");
      }
      chat.append(transientTarget);
      transientTarget.focus();

      transientTarget.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();

      transientTarget.remove();
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();

      expect(document.activeElement).toBe(composer);
    } finally {
      container.remove();
    }
  });

  it("keeps slash menus independent and resets only the targeted pane", () => {
    const paneA = document.createElement("div");
    const paneB = document.createElement("div");
    const renderPane = (container: HTMLElement, paneId: string, draft: string) => {
      renderChatInto(container, { paneId, draft, getDraft: () => draft });
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
    const paneA = document.createElement("div");
    const paneB = document.createElement("div");
    const renderPane = (container: HTMLElement, paneId: string, draft: string) => {
      renderChatInto(container, { paneId, draft, getDraft: () => draft });
    };

    toggleTranscriptSearch("pane-a", vi.fn());
    renderPane(paneA, "pane-a", "");
    renderPane(paneB, "pane-b", "");
    expect(paneA.querySelector(".agent-chat__search-bar")).not.toBeNull();
    expect(paneB.querySelector(".agent-chat__search-bar")).toBeNull();

    toggleTranscriptSearch("pane-b", vi.fn());
    resetTranscriptSession("pane-a");
    renderPane(paneA, "pane-a", "");
    renderPane(paneB, "pane-b", "");
    expect(paneA.querySelector(".agent-chat__search-bar")).toBeNull();
    expect(paneB.querySelector(".agent-chat__search-bar")).not.toBeNull();
  });
});

describe("chat transcript rendering cache", () => {
  it("rerenders transcript groups when the current profile id arrives", () => {
    const messages = [{ role: "user", content: "hi" }];
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      {
        kind: "group",
        key: "group:user:test",
        role: "user",
        visibleContent: "text",
        messages: [{ key: "message:user:test", message: messages[0] }],
        timestamp: 1,
        isStreaming: false,
      },
    ]);
    const transcript = createTestTranscript();
    const props = createChatProps({ messages, transcript, userName: "Fuller Stack" });
    const container = document.createElement("div");

    render(renderChat(props), container);
    render(renderChat({ ...props, userId: "profile-1" }), container);

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(2);
    expect(renderMessageGroupMock.mock.calls[1]?.[1]).toMatchObject({ userId: "profile-1" });
  });

  it("rerenders transcript groups when chat media changes", () => {
    const messages = [{ role: "assistant", content: "ready" }];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const queue: ChatQueueItem[] = [];
    const container = document.createElement("div");

    renderChatInto(container, { messages, toolMessages, streamSegments, queue });
    chatMediaRenderVersionMock.value += 1;
    renderChatInto(container, { messages, toolMessages, streamSegments, queue, draft: "h" });

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(2);
  });

  it("passes assistant attachment load callbacks to transcript groups", () => {
    const onAssistantAttachmentLoaded = vi.fn();

    renderChatView({
      messages: [{ role: "assistant", content: "MEDIA:https://example.com/vector.svg" }],
      onAssistantAttachmentLoaded,
    });

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(1);
    expect(renderMessageGroupMock.mock.calls[0]?.[1]).toMatchObject({
      onAssistantAttachmentLoaded,
    });
  });

  it("passes the shared assistant media contract to active streams and continuations", () => {
    const onAssistantAttachmentLoaded = vi.fn();
    const onRequestUpdate = vi.fn();
    const onRequestOpenImage = vi.fn(() => 7);
    const onOpenImage = vi.fn();
    const onOpenWorkspaceFile = vi.fn();
    const resolveArtifactDownload = vi.fn();
    const mediaProps = {
      sessionKey: "agent:media:main",
      fullMessageAgentId: "media",
      basePath: "/control",
      resourceBasePath: "/resources",
      localMediaPreviewRoots: ["/tmp/media"],
      assistantAttachmentAuthToken: "attachment-token",
      resolveArtifactDownload,
      canvasPluginSurfaceUrl: "https://example.com/canvas",
      embedSandboxMode: "strict" as const,
      allowExternalEmbedUrls: true,
      onAssistantAttachmentLoaded,
      onRequestUpdate,
      onRequestOpenImage,
      onOpenImage,
      onOpenWorkspaceFile,
    };
    const streamPart = {
      kind: "stream" as const,
      key: "stream:media:live",
      text: "MEDIA:https://example.com/voice.ogg",
      startedAt: 1,
      isStreaming: true,
    };
    const expected = {
      sessionKey: mediaProps.sessionKey,
      agentId: mediaProps.fullMessageAgentId,
      runActive: true,
      resourceBasePath: mediaProps.resourceBasePath,
      localMediaPreviewRoots: mediaProps.localMediaPreviewRoots,
      assistantAttachmentAuthToken: mediaProps.assistantAttachmentAuthToken,
      resolveArtifactDownload,
      canvasPluginSurfaceUrl: mediaProps.canvasPluginSurfaceUrl,
      embedSandboxMode: mediaProps.embedSandboxMode,
      allowExternalEmbedUrls: true,
      onAssistantAttachmentLoaded,
      onRequestUpdate,
      onRequestOpenImage,
      onOpenWorkspaceFile,
    };

    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([streamPart]);
    renderChatView({ ...mediaProps, canAbort: true });

    expect(vi.mocked(chatMessage.renderStreamGroup).mock.calls.at(-1)?.[1]).toMatchObject(expected);
    expect(vi.mocked(chatMessage.renderStreamGroup).mock.calls.at(-1)?.[1]?.onOpenImage).toEqual(
      expect.any(Function),
    );

    const reply = {
      kind: "group" as const,
      key: "group:assistant:media",
      role: "assistant",
      visibleContent: "text" as const,
      messages: [
        {
          key: "message:assistant:media",
          message: { role: "assistant", content: "Interim answer", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      reply,
      { kind: "reading-indicator", key: "reading:media", startedAt: 1 },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    renderMessageGroupMock.mockClear();
    renderChatView({
      ...mediaProps,
      canAbort: true,
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
    });

    expect(renderMessageGroupMock.mock.calls.at(-1)?.[1].activeContinuation?.options).toMatchObject(
      expected,
    );
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
  function createPendingSend(overrides: Partial<ChatQueueItem> = {}): ChatQueueItem {
    return {
      id: "send-main",
      text: "hello",
      createdAt: 1,
      sendRunId: "run-main",
      sendState: "sending",
      sessionKey: "main",
      ...overrides,
    };
  }

  function createContextUsageSessions(): SessionsListResult {
    return {
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
    };
  }

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

  it.each([
    {
      name: "shows the skeleton while the initial history load has no rendered content",
      props: { loading: true },
      present: { "openclaw-panel-loading-skeleton": null },
      absent: [".agent-chat__welcome"],
      counts: { "openclaw-panel-loading-skeleton": 1 },
    },
    {
      name: "shows the loading skeleton for an active run with no stream",
      props: { canAbort: true, loading: true },
      present: { "openclaw-panel-loading-skeleton": null },
      absent: [".agent-chat__welcome"],
      counts: { ".chat-reading-indicator": 0 },
    },
    {
      name: "shows the reading indicator when an active run has an empty stream",
      props: { canAbort: true, stream: "" },
      present: { ".chat-reading-indicator": null },
    },
    {
      name: "keeps continuing-run status inside the rendered response",
      props: {
        canAbort: true,
        messages: [{ role: "assistant", content: "Finished answer", timestamp: 1 }],
        stream: null,
      },
      present: { ".chat-group": "Finished answer" },
      counts: { ".chat-group": 1, ".chat-stream-run": 0 },
    },
    {
      name: "drops the working spark once the run reaches a terminal status",
      props: {
        canAbort: true,
        runStatus: {
          phase: "done" as const,
          runId: "run-1",
          sessionKey: "main",
          occurredAt: Date.now(),
        },
        messages: [{ role: "assistant", content: "Finished answer", timestamp: 1 }],
        stream: null,
      },
      absent: [".chat-reading-indicator"],
    },
    {
      name: "keeps existing messages visible without the skeleton during a background reload",
      props: {
        loading: true,
        messages: [{ role: "assistant", content: "Already loaded answer", timestamp: 1 }],
      },
      present: { ".chat-group": "Already loaded answer" },
      absent: ["openclaw-panel-loading-skeleton"],
    },
    {
      name: "keeps active stream content visible without the skeleton during a background reload",
      props: { loading: true, stream: "Partial streamed answer", streamStartedAt: 1 },
      present: { ".chat-stream": "Partial streamed answer" },
      absent: ["openclaw-panel-loading-skeleton"],
    },
    {
      name: "keeps the reading indicator visible without the skeleton before stream text arrives",
      props: { loading: true, stream: "", streamStartedAt: 1 },
      absent: ["openclaw-panel-loading-skeleton"],
      counts: { ".chat-reading-indicator": 1 },
    },
  ] satisfies Array<{
    name: string;
    props: Partial<Parameters<typeof renderChat>[0]>;
    present?: Record<string, string | null>;
    absent?: string[];
    counts?: Record<string, number>;
  }>)("$name", ({ props, present = {}, absent = [], counts = {} }) => {
    const container = renderChatView(props);
    for (const [selector, text] of Object.entries(present)) {
      const element = container.querySelector(selector);
      expect(element).not.toBeNull();
      if (text !== null) {
        expect(element?.textContent?.trim()).toBe(text);
      }
    }
    for (const selector of absent) {
      expect(container.querySelector(selector)).toBeNull();
    }
    for (const [selector, count] of Object.entries(counts)) {
      expect(container.querySelectorAll(selector)).toHaveLength(count);
    }
  });

  it("routes live and completed status into the existing assistant turn", () => {
    renderChatView({
      canAbort: true,
      messages: [
        { role: "assistant", content: "Finished answer", timestamp: 1, runId: "run-composed" },
      ],
      stream: null,
    });

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(1);
    expect(renderMessageGroupMock.mock.calls[0]?.[1]).toMatchObject({
      activeContinuation: {
        parts: [{ kind: "reading-indicator", key: "reading:test", startedAt: 1 }],
      },
    });

    renderMessageGroupMock.mockClear();
    vi.spyOn(chatProgress, "resolveTurnRecap").mockReturnValue({
      runId: "run-composed",
      runtimeMs: 5_000,
      outputTokens: 42,
    });
    const container = renderChatView({
      messages: [
        { role: "assistant", content: "Finished answer", timestamp: 1, runId: "run-composed" },
      ],
    });

    expect(renderMessageGroupMock).toHaveBeenCalledTimes(1);
    expect(renderMessageGroupMock.mock.calls[0]?.[1]).toMatchObject({
      turnRecap: { runtimeMs: 5_000, outputTokens: 42 },
    });
    expect(container.querySelector(".chat-turn-recap")).toBeNull();
  });

  it("keeps a completed recap after later tool content", () => {
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValueOnce([
      {
        kind: "group",
        key: "group:assistant:test",
        role: "assistant",
        visibleContent: "text",
        messages: [
          {
            key: "message:assistant:test",
            message: { role: "assistant", content: "Interim answer", timestamp: 1 },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      },
      {
        kind: "group",
        key: "group:tool:test",
        role: "tool",
        visibleContent: "text",
        messages: [
          {
            key: "message:tool:test",
            message: { role: "tool", content: "Later tool result", timestamp: 2 },
          },
        ],
        timestamp: 2,
        isStreaming: false,
      },
    ]);
    vi.spyOn(chatProgress, "resolveTurnRecap").mockReturnValue({
      runId: "run-composed",
      runtimeMs: 5_000,
      outputTokens: 42,
    });

    const container = renderChatView({
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
    });

    expect(renderMessageGroupMock.mock.calls[0]?.[1].turnRecap).toBeUndefined();
    expect(container.querySelector(".chat-turn-recap")?.textContent).toContain("Done in");
  });

  it("releases the embedded status when later work steals ownership from an unchanged reply", () => {
    // Rows memoize on their own item identity, so an unchanged reply that
    // stops owning the status must still re-render without it.
    const replyGroup = {
      kind: "group",
      key: "group:assistant:reply",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "message:assistant:reply",
          message: { role: "assistant", content: "Interim answer", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const readingIndicator = { kind: "reading-indicator", key: "reading:test", startedAt: 1 };
    const toolGroup = {
      kind: "group",
      key: "group:tool:later",
      role: "tool",
      visibleContent: "text",
      messages: [
        {
          key: "message:tool:later",
          message: { role: "tool", content: "Later tool result", timestamp: 2 },
        },
      ],
      timestamp: 2,
      isStreaming: false,
    };
    const props = {
      canAbort: true,
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
      stream: null,
    };
    const container = document.createElement("div");

    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      replyGroup,
      readingIndicator,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    renderChatInto(container, props);
    expect(renderMessageGroupMock.mock.calls.at(-1)?.[1].activeContinuation).toBeDefined();

    renderMessageGroupMock.mockClear();
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      replyGroup,
      toolGroup,
      readingIndicator,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    renderChatInto(container, props);

    const replyCall = renderMessageGroupMock.mock.calls.find(
      ([group]) => group.key === replyGroup.key,
    );
    expect(replyCall).toBeDefined();
    expect(replyCall?.[1].activeContinuation).toBeUndefined();
  });

  it("keeps the live token counter current when only run usage changes", () => {
    // Run usage arrives on its own patches, so the transcript items, the
    // shared render context, and this row's own identity all stay put while
    // the counter ticks.
    const readingIndicator = {
      kind: "reading-indicator",
      key: "reading:test",
      startedAt: 1,
      runId: "usage-run",
    };
    const reply = {
      kind: "group",
      key: "group:assistant:reply",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "message:assistant:reply",
          message: { role: "assistant", content: "Interim answer", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const renderWithUsage = (container: HTMLElement, runOutputTokens: number) => {
      renderChatInto(container, {
        canAbort: true,
        runUsageById: new Map([["usage-run", { outputTokens: runOutputTokens, seq: 1 }]]),
        stream: null,
      });
    };

    const streamGroupSpy = vi.fn(renderStreamGroupMock);
    vi.spyOn(chatMessage, "renderStreamGroup").mockImplementation(streamGroupSpy);
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([readingIndicator] as ReturnType<
      typeof chatThread.buildCachedChatItems
    >);
    const standalone = document.createElement("div");
    renderWithUsage(standalone, 5_500);
    renderWithUsage(standalone, 7_200);
    expect(streamGroupSpy.mock.calls.at(-1)?.[1]?.runOutputTokens).toBe(7_200);

    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      reply,
      readingIndicator,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    const embedded = document.createElement("div");
    renderWithUsage(embedded, 5_500);
    renderMessageGroupMock.mockClear();
    renderWithUsage(embedded, 7_200);
    expect(
      renderMessageGroupMock.mock.calls.at(-1)?.[1].activeContinuation?.options.runOutputTokens,
    ).toBe(7_200);
  });

  it("keeps multi-part run usage current when only output tokens change", () => {
    const runId = "run-composed";
    const user = {
      kind: "group",
      key: "group:user:run-composed",
      role: "user",
      visibleContent: "text",
      messages: [
        {
          key: "message:user:run-composed",
          message: {
            role: "user",
            content: "Start the work.",
            timestamp: 0,
            __openclaw: { id: "user:run-composed", idempotencyKey: `${runId}:user` },
          },
        },
      ],
      timestamp: 0,
      isStreaming: false,
    };
    const assistant = {
      kind: "group",
      key: "group:assistant:run-start",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "message:assistant:run-start",
          message: { role: "assistant", content: "Starting the work.", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
      runId,
    };
    const tool = {
      kind: "group",
      key: "group:tool:run-work",
      role: "tool",
      visibleContent: "text",
      messages: [
        {
          key: "message:tool:run-work",
          message: { role: "toolResult", content: "Tool complete.", timestamp: 2 },
        },
      ],
      timestamp: 2,
      isStreaming: false,
      runId,
    };
    const reading = {
      kind: "reading-indicator",
      key: "reading:run-composed",
      startedAt: 1,
      runId,
    };
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      user,
      assistant,
      tool,
      reading,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    const container = document.createElement("div");
    const streamPartsSpy = vi.spyOn(chatMessage, "renderStreamGroupParts");

    renderChatInto(container, {
      canAbort: true,
      runId,
      runUsageById: new Map([[runId, { outputTokens: 5_500, seq: 1 }]]),
      stream: null,
    });
    streamPartsSpy.mockClear();
    renderChatInto(container, {
      canAbort: true,
      runId,
      runUsageById: new Map([[runId, { outputTokens: 7_200, seq: 2 }]]),
      stream: null,
    });

    expect(streamPartsSpy.mock.calls.at(-1)?.[1].runOutputTokens).toBe(7_200);
  });

  it("keeps the completed recap on one composed multi-part run", () => {
    const runId = "run-composed";
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      {
        kind: "group",
        key: "group:user:run-composed",
        role: "user",
        visibleContent: "text",
        messages: [
          {
            key: "message:user:run-composed",
            message: {
              role: "user",
              content: "Start the work.",
              timestamp: 0,
              __openclaw: { id: "user:run-composed", idempotencyKey: `${runId}:user` },
            },
          },
        ],
        timestamp: 0,
        isStreaming: false,
      },
      {
        kind: "group",
        key: "group:assistant:run-start",
        role: "assistant",
        visibleContent: "text",
        messages: [
          {
            key: "message:assistant:run-start",
            message: { role: "assistant", content: "Starting the work.", timestamp: 1 },
          },
        ],
        timestamp: 1,
        isStreaming: false,
        runId,
      },
      {
        kind: "group",
        key: "group:tool:run-work",
        role: "tool",
        visibleContent: "text",
        messages: [
          {
            key: "message:tool:run-work",
            message: { role: "toolResult", content: "Tool complete.", timestamp: 2 },
          },
        ],
        timestamp: 2,
        isStreaming: false,
        runId,
      },
      {
        kind: "group",
        key: "group:assistant:run-finish",
        role: "assistant",
        visibleContent: "text",
        messages: [
          {
            key: "message:assistant:run-finish",
            message: { role: "assistant", content: "Finished the work.", timestamp: 3 },
          },
        ],
        timestamp: 3,
        isStreaming: false,
        runId,
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    vi.spyOn(chatProgress, "resolveTurnRecap").mockReturnValue({
      runId: "run-composed",
      runtimeMs: 5_000,
      outputTokens: 42,
    });

    const container = renderChatView();

    const frameCall = renderMessageGroupMock.mock.calls.find(([group]) =>
      group.key.startsWith("agent-run:"),
    );
    expect(frameCall).toBeDefined();
    expect(frameCall?.[0].messages).toHaveLength(1);
    expect(frameCall?.[1].frameContent).toBeDefined();
    expect(frameCall?.[1].turnRecap).toEqual({
      runId,
      runtimeMs: 5_000,
      outputTokens: 42,
    });
    expect(container.querySelector(".chat-turn-recap")).toBeNull();
  });

  it("does not move a watched recap onto a later unrelated run", () => {
    const firstReply = {
      kind: "group",
      key: "group:assistant:first",
      runId: "run-composed",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "message:assistant:first",
          message: { role: "assistant", content: "First answer", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const secondReply = {
      ...firstReply,
      key: "group:assistant:second",
      runId: "foreign-run",
      messages: [
        {
          key: "message:assistant:second",
          message: { role: "assistant", content: "Second answer", timestamp: 2 },
        },
      ],
      timestamp: 2,
    };
    vi.spyOn(chatProgress, "resolveTurnRecap").mockReturnValue({
      runId: "run-composed",
      runtimeMs: 5_000,
      outputTokens: 42,
    });
    const props = { messages: [{ role: "assistant", content: "First answer", timestamp: 1 }] };
    const container = document.createElement("div");

    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([firstReply] as ReturnType<
      typeof chatThread.buildCachedChatItems
    >);
    renderChatInto(container, props);
    expect(renderMessageGroupMock.mock.calls.at(-1)?.[1].turnRecap).toBeDefined();

    renderMessageGroupMock.mockClear();
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      firstReply,
      secondReply,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    renderChatInto(container, props);

    const firstCall = renderMessageGroupMock.mock.calls.find(
      ([group]) => group.key === firstReply.key,
    );
    expect(firstCall).toBeDefined();
    expect(firstCall?.[1].turnRecap).toBeUndefined();
    expect(
      renderMessageGroupMock.mock.calls.find(([group]) => group.key === secondReply.key)?.[1]
        .turnRecap,
    ).toBeUndefined();
    expect(container.querySelector(".chat-turn-recap")).toBeNull();
  });

  it("shows prompt-bar progress beside context usage while the current session send is awaiting acknowledgement", () => {
    const container = renderChatView({
      sending: true,
      composerControls: html`<button class="chat-composer-model-control" type="button">
        Model
      </button>`,
      queue: [createPendingSend()],
      selectedSession: createContextUsageSessions().sessions[0],
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
    expect(contextUsage?.closest(".agent-chat__composer-context")).not.toBeNull();
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
      selectedSession: createContextUsageSessions().sessions[0],
    });

    const context = container.querySelector(".context-ring");
    expect(context).toBeInstanceOf(HTMLElement);
    expect(context?.closest(".agent-chat__composer-context")).not.toBeNull();
    expect(context?.closest(".agent-chat__composer-footer")).not.toBeNull();
    // The session provider matches a plan-usage group, so dollar estimates
    // yield to the subscription windows.
    expect(container.querySelector("[data-chat-usage-provider='true']")?.textContent).toContain(
      "OpenAI",
    );
    expect(container.querySelector(".agent-chat__composer-header")).toBeNull();
    const limitRow = container.querySelector(".context-usage__limit");
    expect(limitRow?.textContent?.replace(/\s+/g, " ").trim()).toBe("Weekly 72%");
    const usageLink = container.querySelector<HTMLAnchorElement>(
      ".context-usage__popover [data-chat-provider-usage='true']",
    );
    expect(usageLink?.getAttribute("href")).toBe("/rosita/usage");
  });

  it.each([
    {
      name: "does not announce progress for another session send",
      props: {
        sessionKey: "session-b",
        sending: true,
        queue: [
          createPendingSend({
            id: "send-a",
            text: "hello from A",
            sendRunId: "run-a",
            sessionKey: "session-a",
          }),
        ],
      },
      announcement: "",
      exact: true,
      spark: false,
    },
    {
      name: "shows the working spark while the current session send waits for model switching",
      props: {
        queue: [createPendingSend({ sendState: "waiting-model" })],
      },
      announcement: "Preparing model",
      exact: false,
      spark: true,
    },
    {
      name: "shows active model-switch progress over the previous run's terminal status",
      props: {
        runStatus: {
          phase: "done" as const,
          runId: "run-previous",
          sessionKey: "main",
          occurredAt: 1_000,
        },
        queue: [createPendingSend({ createdAt: 999, sendState: "waiting-model" })],
      },
      announcement: "Preparing model",
      exact: false,
      spark: true,
    },
    {
      name: "keeps terminal status for the submitted run while its acknowledgement is pending",
      props: {
        runStatus: {
          phase: "done" as const,
          runId: "run-main",
          sessionKey: "main",
          occurredAt: Date.now(),
        },
        queue: [createPendingSend({ createdAt: 999 })],
      },
      announcement: "Done",
      exact: true,
      spark: false,
    },
    {
      name: "does not announce progress for reconnect-waiting sends",
      props: {
        queue: [createPendingSend({ sendState: "waiting-reconnect" })],
      },
      announcement: "",
      exact: true,
      spark: false,
    },
  ])("$name", ({ props, announcement, exact, spark }) => {
    const container = renderChatView(props);
    const announcementElement = container.querySelector(".agent-chat__run-status-announcement");
    expect(announcementElement).not.toBeNull();
    const actual = announcementElement?.textContent?.trim() ?? "";
    if (exact) {
      expect(actual).toBe(announcement);
    } else {
      expect(actual).toContain(announcement);
    }
    expect(container.querySelector(".chat-reading-indicator") !== null).toBe(spark);
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

  it("floats interrupted chrome above the composer", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const container = renderChatView({
        messages: [{ role: "assistant", content: "Partial response" }],
        composerControls: html`<button class="chat-composer-model-control" type="button">
          Model
        </button>`,
        runStatus: {
          phase: "interrupted",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 1_000,
        },
      });

      expect(
        container
          .querySelector(".agent-chat__composer-run-status")
          ?.closest(".agent-chat__composer-overlay"),
      ).not.toBeNull();
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

  it("shows one mic button for starting realtime talk", () => {
    const container = renderChatView();

    requireElement(container, '[aria-label="Start voice input"]', "voice input button");
    expect(container.querySelector('[aria-label="Start video talk"]')).toBeNull();
    expect(container.querySelector('[aria-label="Voice input"]')).toBeNull();
  });

  it("toggles camera inside a video-capable voice session and renders the preview", () => {
    const onToggleRealtimeCamera = vi.fn();
    const stream = {} as MediaStream;
    let container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
      onToggleRealtimeCamera,
    });

    requireElement(container, '[aria-label="Turn camera on"]', "camera on button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onToggleRealtimeCamera).toHaveBeenCalledOnce();

    container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
      realtimeTalkVideoStream: stream,
      onToggleRealtimeCamera,
    });
    requireElement(container, '[aria-label="Turn camera off"]', "camera off button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    const preview = requireElement(
      container,
      'video[aria-label="Camera preview"]',
      "camera preview",
    ) as HTMLVideoElement;

    expect(onToggleRealtimeCamera).toHaveBeenCalledTimes(2);
    expect(preview.srcObject).toBe(stream);
    expect(preview.autoplay).toBe(true);
    expect(preview.muted).toBe(true);
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
  ] as const)("renders %s voice activity with the appropriate status region", (status, label) => {
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
    const statusRegion = container.querySelector(
      status === "connecting"
        ? '[role="status"].agent-chat__talk-status'
        : '[role="status"].agent-chat__voice-status',
    );
    expect(statusRegion?.getAttribute("aria-live")).toBe("polite");
    expect(statusRegion?.getAttribute("aria-atomic")).toBe("true");
    expect(statusRegion?.textContent?.trim()).toBe(label);
    if (status !== "connecting") {
      expect(container.querySelector(".agent-chat__talk-status")).toBeNull();
    }
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

  it("renders composer labels from the active locale map", async () => {
    await i18n.setLocale("zh-CN");
    const container = renderChatView();
    const startTalkLabel = t("chat.composer.startVoiceInput");

    const talkButton = requireElement(
      container,
      `[aria-label="${startTalkLabel}"]`,
      "localized voice input button",
    );
    const tooltip = talkButton.parentElement as (HTMLElement & { content?: string }) | null;
    expect(talkButton.getAttribute("title")).toBeNull();
    expect(tooltip?.localName).toBe("openclaw-tooltip");
    expect(tooltip?.content).toBe(t("chat.composer.voiceGestureHint"));
    expect(talkButton.textContent?.trim()).toBe(startTalkLabel);
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
    const textarea = getComposerTextarea(container);
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
    const textarea = getComposerTextarea(container);
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

describe("chat composer render invalidation", () => {
  it("keeps steady ordinary edits and direction changes local", () => {
    const container = document.createElement("div");
    let draft = "a";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let props = createChatProps({
      draft,
      getDraft: () => draft,
      onDraftChange,
    });
    const onRequestUpdate = vi.fn(() => {
      props = { ...props, draft, getDraft: () => draft };
      render(renderChat(props), container);
    });
    props = { ...props, onRequestUpdate };
    render(renderChat(props), container);

    const textarea = getComposerTextarea(container);
    onRequestUpdate.mockClear();
    vi.mocked(chatThread.buildCachedChatItems).mockClear();

    textarea.value = "ab";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    textarea.value = "abc";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(draft).toBe("abc");
    expect(onRequestUpdate).not.toHaveBeenCalled();
    expect(chatThread.buildCachedChatItems).not.toHaveBeenCalled();

    textarea.value = "مرحبا";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(onRequestUpdate).not.toHaveBeenCalled();
    expect(chatThread.buildCachedChatItems).not.toHaveBeenCalled();
    expect(textarea.dir).toBe("rtl");

    render(renderChat(props), container);
    expect(getComposerTextarea(container).dir).toBe("rtl");
  });

  it("invalidates when offline slash eligibility changes", () => {
    const container = document.createElement("div");
    let draft = "queue this offline";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let props = createChatProps({
      connected: false,
      draft,
      getDraft: () => draft,
      onDraftChange,
    });
    const onRequestUpdate = vi.fn(() => {
      props = { ...props, draft, getDraft: () => draft };
      render(renderChat(props), container);
    });
    props = { ...props, onRequestUpdate };
    render(renderChat(props), container);

    const sendButton = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(sendButton()?.disabled).toBe(false);
    onRequestUpdate.mockClear();

    let textarea = getComposerTextarea(container);
    textarea.value = "/status";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(onRequestUpdate).toHaveBeenCalled();
    expect(sendButton()?.disabled).toBe(true);
    onRequestUpdate.mockClear();

    textarea = getComposerTextarea(container);
    textarea.value = "queue this instead";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(onRequestUpdate).toHaveBeenCalled();
    expect(sendButton()?.disabled).toBe(false);
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
    const textarea = getComposerTextarea(container);

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
    expect(onDraftChange).toHaveBeenLastCalledWith("当前", undefined);
  });

  it("preserves composing text across host rerenders with stale draft props", () => {
    const onDraftChange = vi.fn();
    const onRequestUpdate = vi.fn();
    const container = document.createElement("div");
    const props = createChatProps({ draft: "", onDraftChange, onRequestUpdate });

    render(renderChat(props), container);
    const textarea = getComposerTextarea(container);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "dangqian";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);

    render(renderChat({ ...props, draft: "" }), container);

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("dangqian");

    const rerenderedTextarea = getComposerTextarea(container);
    rerenderedTextarea.value = "当前";
    rerenderedTextarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenLastCalledWith("当前", undefined);
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
    const textarea = getComposerTextarea(container);

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

  it("recovers Enter-send after a composition is abandoned via blur", () => {
    // Browsers can drop compositionend (detach/blur mid-IME). The composing
    // flag persists across renders, so without the blur reset Enter, history
    // keys, and command menus stay dead until the Send button is clicked.
    const onSend = vi.fn();
    const container = renderChatView({ onSend, draft: "hello" });
    const textarea = getComposerTextarea(container);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "hello";
    textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(enterEvent);

    expect(enterEvent.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledOnce();
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
    const textarea = getComposerTextarea(container);
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
    const textarea = getComposerTextarea(container);

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
    const textarea = getComposerTextarea(container);
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
    const textarea = getComposerTextarea(container);
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

  it("resizes the draft when responsive layout changes the textarea width", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    let animationFrameCallback: FrameRequestCallback | undefined;
    let nextAnimationFrameId = 0;
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      animationFrameCallback = callback;
      nextAnimationFrameId += 1;
      return nextAnimationFrameId;
    });
    const cancelAnimationFrameMock = vi.fn();
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
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);

    let width = 320;
    let scrollHeight = 42;
    let clientHeight = 42;
    vi.spyOn(HTMLTextAreaElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      bottom: clientHeight,
      height: clientHeight,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    const container = renderChatView({});
    const textarea = getComposerTextarea(container);
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
    });
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(textarea.style.height).toBe("42px");
    expect(textarea.style.overflowY).toBe("hidden");

    scrollHeight = 180;
    clientHeight = 150;
    resizeCallback?.([], {} as ResizeObserver);
    expect(textarea.style.overflowY).toBe("auto");
    expect(requestAnimationFrameMock).not.toHaveBeenCalled();

    width = 180;
    scrollHeight = 120;
    clientHeight = 120;
    resizeCallback?.([], {} as ResizeObserver);
    expect(requestAnimationFrameMock).toHaveBeenCalledOnce();
    expect(textarea.style.height).toBe("42px");

    animationFrameCallback?.(0);
    expect(textarea.style.height).toBe("120px");
    expect(textarea.style.overflowY).toBe("hidden");

    width = 160;
    resizeCallback?.([], {} as ResizeObserver);
    render(html``, container);
    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(2);
  });
});

describe("chat slash menu accessibility", () => {
  function replaceSkillCommands(
    ...skills: Array<{ key: string; name?: string; skillDisplayName?: string; description: string }>
  ) {
    replaceSlashCommands([
      ...buildFallbackSlashCommands(),
      ...skills.map(({ key, name = key, skillDisplayName, description }) => ({
        key,
        name,
        skillDisplayName,
        description,
        source: "skill" as const,
        skillModelVisible: true,
      })),
    ]);
  }

  function inputDraft(container: HTMLElement, value: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.value = value;
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function inputDraftAtEnd(container: HTMLElement, value: string) {
    const textarea = getComposerTextarea(container);
    textarea.value = value;
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }

  function keydownComposer(container: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    const event = new KeyboardEvent("keydown", { ...init, key, bubbles: true, cancelable: true });
    textarea!.dispatchEvent(event);
    return event;
  }

  function replayInput(textarea: HTMLTextAreaElement, value: string, type = "input") {
    if (type === "input") {
      textarea.value = value;
    }
    textarea.dispatchEvent(
      new InputEvent(type, { bubbles: true, data: value, inputType: "insertText" }),
    );
  }

  function createDraftHarness() {
    let draft = "";
    const container = document.createElement("div");
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn(() => {
      draft = "";
    });
    renderChatInto(container, { draft, getDraft: () => draft, onDraftChange, onSend });
    return { container, onDraftChange, onSend };
  }

  function createReactiveDraftHarness({
    onDraftChange: observeDraftChange,
    ...overrides
  }: Partial<ChatProps> = {}) {
    let draft = "";
    let currentOverrides = overrides;
    const container = document.createElement("div");
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
      observeDraftChange?.(next);
    });
    const renderCurrent = (nextOverrides: Partial<ChatProps> = {}) => {
      currentOverrides = { ...currentOverrides, ...nextOverrides };
      renderChatInto(container, {
        draft,
        getDraft: () => draft,
        onDraftChange,
        onRequestUpdate: renderCurrent,
        ...currentOverrides,
      });
    };
    renderCurrent();
    return { container, renderCurrent };
  }

  function createSlashRerenderHarness() {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const renderCurrent = () => renderChatView({ draft, onDraftChange });
    return {
      container: renderCurrent(),
      inputAndRender(container: HTMLElement, value: string) {
        inputDraft(container, value);
        return renderCurrent();
      },
      renderCurrent,
    };
  }

  function createSessionDraftHarness(prefix: string) {
    const drafts: Record<string, string> = { [`${prefix}-a`]: "", [`${prefix}-b`]: "" };
    const onDraftChange = vi.fn((sessionKey: string, next: string) => {
      drafts[sessionKey] = next;
    });
    const container = document.createElement("div");
    const renderSession = (sessionKey: string) => {
      renderChatInto(container, {
        currentAgentId: `${prefix}-agent`,
        draft: expectDefined(drafts[sessionKey], "session draft"),
        getDraft: () => expectDefined(drafts[sessionKey], "session draft"),
        onDraftChange: (next) => onDraftChange(sessionKey, next),
        onSend: () => {
          drafts[sessionKey] = "";
        },
        sessionKey,
      });
    };
    return { container, drafts, onDraftChange, renderSession };
  }

  it("requests slash command hydration only after slash intent", () => {
    const onSlashIntent = vi.fn(async () => undefined);
    const container = renderChatView({ onSlashIntent });

    inputDraft(container, "plain first message");

    expect(onSlashIntent).not.toHaveBeenCalled();

    inputDraft(container, "/");

    expect(onSlashIntent).toHaveBeenCalledTimes(1);
  });

  it.each(["keyboard", "pointer"])(
    "collects a literal Goal objective after %s selection and retains a rejected draft",
    async (selection) => {
      const onGoalSubmit = vi.fn(async () => false);
      const onSend = vi.fn();
      const { container } = createReactiveDraftHarness({ onGoalSubmit, onSend });
      inputDraftAtEnd(container, "/goal");
      if (selection === "keyboard") {
        keydownComposer(container, "Enter");
      } else {
        container.querySelector<HTMLElement>('.slash-menu-item[role="option"]')?.click();
      }
      expect(container.querySelector(".agent-chat__goal-mode")).not.toBeNull();
      expect(container.querySelector(".slash-menu")).toBeNull();
      expect(onGoalSubmit).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      const objective = "  /stop the flaky tests\nthen preserve   every space  ";
      inputDraftAtEnd(container, objective);
      expect(container.querySelector(".slash-menu")).toBeNull();
      keydownComposer(container, "Enter");
      await vi.waitFor(() =>
        expect(onGoalSubmit).toHaveBeenCalledExactlyOnceWith(
          { action: "start", objective },
          expect.any(KeyboardEvent),
        ),
      );
      expect(getComposerTextarea(container).value).toBe(objective);
      expect(container.querySelector(".agent-chat__goal-mode")).not.toBeNull();
      expect(onSend).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(getComposerTextarea(container).readOnly).toBe(false));
      keydownComposer(container, "Escape");
      expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
      expect(getComposerTextarea(container).value).toBe(objective);
    },
  );

  it("keeps Tab completion textual and preserves explicit goal command submission", () => {
    const onGoalSubmit = vi.fn(async () => true);
    const onSend = vi.fn();
    const { container } = createReactiveDraftHarness({ onGoalSubmit, onSend });
    inputDraftAtEnd(container, "/goal");
    keydownComposer(container, "Tab");
    expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
    inputDraftAtEnd(container, "/goal start Fix the tests");
    keydownComposer(container, "Enter");
    expect(onSend).toHaveBeenCalledOnce();
    expect(onGoalSubmit).not.toHaveBeenCalled();
  });

  it("keeps a new session draft intact when an earlier Goal edit finishes", async () => {
    const pending = createDeferred<boolean>();
    const onModeChange = vi.fn();
    const { container, renderCurrent } = createReactiveDraftHarness({
      sessionKey: "session-a",
      goalDraftMode: {
        action: "edit",
        sessionId: "id-a",
        goalId: "goal-a",
        previousDraft: "Previous session draft",
      },
      onGoalDraftModeChange: onModeChange,
      onGoalSubmit: () => pending.promise,
    });
    inputDraftAtEnd(container, "Updated objective");
    keydownComposer(container, "Enter");
    renderCurrent({ sessionKey: "session-b", goalDraftMode: null });
    inputDraftAtEnd(container, "New session draft");
    pending.resolve(true);
    await pending.promise;
    await vi.waitFor(() => expect(getComposerTextarea(container).readOnly).toBe(false));
    expect(getComposerTextarea(container).value).toBe("New session draft");
    expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("executes an inline command separately and removes only its token from the draft", () => {
    let draft = "";
    const onTypingChange = vi.fn();
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn(() => {
      expect(onTypingChange).toHaveBeenLastCalledWith(true, "hello ");
    });
    const { container } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
      onTypingChange,
    });

    inputDraftAtEnd(container, "hello /statu");

    expect(container.querySelector(".slash-menu")).not.toBeNull();
    expect(container.querySelector(".slash-menu-name")?.textContent?.trim()).toBe("/status");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/status");
    expect(draft).toBe("hello ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
    expect(onTypingChange).toHaveBeenLastCalledWith(true, "hello ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("hides inline commands when the active composer has no command owner", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const { container } = createReactiveDraftHarness({ onDraftChange });

    inputDraftAtEnd(container, "catalog /statu");
    expect(container.querySelector(".slash-menu")).toBeNull();

    inputDraftAtEnd(container, "catalog /verb");
    expect(container.querySelector(".slash-menu")).toBeNull();
    expect(draft).toBe("catalog /verb");
  });

  it("executes a selected inline command argument and preserves the surrounding draft", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend, onSlashCommand });

    inputDraftAtEnd(container, "hello /verb");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(draft).toBe("hello /verb");
    const fullOption = Array.from(container.querySelectorAll<HTMLElement>(".slash-menu-item")).find(
      (item) => item.querySelector(".slash-menu-name")?.textContent?.trim() === "full",
    );
    expect(fullOption).toBeInstanceOf(HTMLElement);
    fullOption?.click();

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/verbose full");
    expect(draft).toBe("hello ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("executes a typed inline command argument separately and preserves surrounding prose", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend, onSlashCommand });

    inputDraftAtEnd(container, "hello /thin");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(draft).toBe("hello /think ");

    inputDraftAtEnd(container, "hello /think high");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(draft).toBe("hello ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("preserves a typed inline command alias when dispatching its argument", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend, onSlashCommand });

    inputDraftAtEnd(container, "hello /t high");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(draft).toBe("hello ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    ["think", "high"],
    ["verbose", "full"],
  ])(
    "executes a directly typed inline /%s argument without requiring completion",
    (command, argument) => {
      let draft = "";
      const onDraftChange = vi.fn((next: string) => {
        draft = next;
      });
      const onSend = vi.fn();
      const onSlashCommand = vi.fn();
      const { container } = createReactiveDraftHarness({
        onDraftChange,
        onSend,
        onSlashCommand,
      });

      inputDraftAtEnd(container, `hello /${command} ${argument}`);
      keydownComposer(container, "Enter");

      expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith(`/${command} ${argument}`);
      expect(draft).toBe("hello ");
      expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
      expect(onSend).not.toHaveBeenCalled();
    },
  );

  it("keeps a typed inline argument on plain Enter in modifier-enter mode", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
      sendShortcut: "modifier-enter",
    });

    inputDraftAtEnd(container, "hello /think high");
    const plainEnter = keydownComposer(container, "Enter");

    expect(plainEnter.defaultPrevented).toBe(false);
    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("hello /think high");

    const modifierEnter = keydownComposer(container, "Enter", { ctrlKey: true });

    expect(modifierEnter.defaultPrevented).toBe(true);
    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("hello ");
  });

  it("keeps a typed inline argument on Shift+Enter", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
    });

    inputDraftAtEnd(container, "hello /think high");
    const shiftedEnter = keydownComposer(container, "Enter", { shiftKey: true });

    expect(shiftedEnter.defaultPrevented).toBe(false);
    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("hello /think high");
  });

  it("preserves typed inline argument mode across command hydration", async () => {
    let draft = "";
    let resolveRefresh: (() => void) | undefined;
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const onSlashIntent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { container } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
      onSlashIntent,
    });

    inputDraftAtEnd(container, "hello /thin");
    keydownComposer(container, "Enter");
    expect(draft).toBe("hello /think ");

    resolveRefresh?.();
    await Promise.resolve();
    await Promise.resolve();
    inputDraftAtEnd(container, "hello /think high");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(draft).toBe("hello ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("removes a typed inline command argument without consuming trailing prose", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSlashCommand });
    const textarea = getComposerTextarea(container);
    const initial = "before /thin after";
    const commandEnd = initial.indexOf("/thin") + "/thin".length;
    textarea.value = initial;
    textarea.setSelectionRange(commandEnd, commandEnd);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    keydownComposer(container, "Enter");
    expect(draft).toBe("before /think  after");

    const withArgument = "before /think high after";
    const argumentEnd = withArgument.indexOf("high") + "high".length;
    textarea.value = withArgument;
    textarea.setSelectionRange(argumentEnd, argumentEnd);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(draft).toBe("before after");
    expect(textarea.value).toBe(draft);
  });

  it("does not consume trailing prose as a directly typed inline argument", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend, onSlashCommand });

    inputDraftAtEnd(container, "before /think high then answer concisely");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledOnce();
    expect(draft).toBe("before /think high then answer concisely");
  });

  it("tab-completes an inline command argument without replacing surrounding prose", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSlashCommand });

    inputDraftAtEnd(container, "hello /verb");
    keydownComposer(container, "Tab");
    keydownComposer(container, "Tab");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(draft).toBe("hello /verbose on ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
  });

  it("keeps inline skill selection in the draft for the eventual model turn", () => {
    replaceSkillCommands({ key: "weather", description: "Check the weather." });
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSlashCommand });

    inputDraftAtEnd(container, "Please use /wea");
    expect(container.querySelector(".slash-menu-name")?.textContent?.trim()).toBe("/weather");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(draft).toBe("Please use $weather ");
  });

  it("uses a trailing colon to select only an inline skill reference", () => {
    replaceSkillCommands({ key: "weather", description: "Check the weather." });
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSlashCommand });

    inputDraftAtEnd(container, "Please use /weather:");
    expect(container.querySelector(".slash-menu-name")?.textContent?.trim()).toBe("/weather");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(draft).toBe("Please use $weather ");
  });

  it.each([
    ["reset", "/reset"],
    ["exec gateway", "/exec gateway"],
  ])("executes inline /%s like its standalone command", (typedCommand, dispatchedCommand) => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend, onSlashCommand });

    inputDraftAtEnd(container, `Please /${typedCommand}`);
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith(dispatchedCommand);
    expect(draft).toBe("Please ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("hydrates the skill catalog once per active $ reference", async () => {
    replaceSkillCommands({ key: "prose", description: "Prose skill." });
    const onSlashIntent = vi.fn(async () => undefined);
    const { container } = createReactiveDraftHarness({ onSlashIntent });
    const type = async (value: string) => {
      inputDraftAtEnd(container, value);
      await Promise.resolve();
      await Promise.resolve();
    };

    await type("Use $");
    await type("Use $p");
    await type("Use $pro");

    expect(onSlashIntent).toHaveBeenCalledOnce();
  });

  it("opens a skill picker for $ references anywhere in a normal prompt", async () => {
    replaceSkillCommands({
      key: "prose_writer",
      skillDisplayName: "Prose Writer",
      description: "Draft polished prose.",
    });
    const onSlashIntent = vi.fn(async () => undefined);
    const { container } = createReactiveDraftHarness({ onSlashIntent });

    inputDraftAtEnd(container, "Polish this with $pro:");
    await Promise.resolve();
    await Promise.resolve();

    const listbox = container.querySelector<HTMLElement>("#chat-single-skill-menu-listbox");
    const renderedTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(listbox?.getAttribute("aria-label")).toBe("Skill references");
    expect(listbox?.querySelector(".slash-menu-name")?.textContent).toBe("Prose Writer");
    expect(renderedTextarea?.getAttribute("aria-controls")).toBe("chat-single-skill-menu-listbox");
    expect(renderedTextarea?.getAttribute("aria-expanded")).toBe("true");
    expect(onSlashIntent).toHaveBeenCalledOnce();
  });

  it("shows skills after commands in the slash picker and highlights typed prefixes", () => {
    replaceSkillCommands({
      key: "status_report",
      skillDisplayName: "Status Report",
      description: "Prepare a detailed status report.",
    });
    const { container } = createReactiveDraftHarness();

    inputDraftAtEnd(container, "/sta");

    const options = Array.from(container.querySelectorAll<HTMLElement>("[role='option']"));
    const skillHeader = container.querySelector(
      ".slash-menu-group--skills .slash-menu-group__label",
    );
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]?.textContent).toContain("/status");
    expect(options.at(-1)?.textContent).toContain("/status_report");
    expect(skillHeader?.textContent).toBe("Skills");
    expect(options[0]?.querySelector("mark")?.textContent).toBe("sta");
    expect(options.at(-1)?.querySelector("mark")?.textContent).toBe("sta");
  });

  it("uses the grouped slash menu order for keyboard selection", () => {
    replaceSlashCommands([
      {
        key: "status-report",
        name: "status-report",
        description: "Prepare a status report.",
        source: "skill",
        skillModelVisible: true,
      },
      {
        key: "status-check",
        name: "status-check",
        description: "Check current status.",
        source: "plugin",
      },
    ]);
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/status");

    const optionNames = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
        (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
      );
    expect(optionNames()).toEqual(["/status-check", "/status-report"]);

    keydownComposer(container, "Enter");
    container = harness.renderCurrent();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/status-check ");
  });

  it("dismisses invocation sheets on an outside pointer press", () => {
    const { container } = createReactiveDraftHarness();
    document.body.append(container);
    inputDraftAtEnd(container, "/sta");
    expect(container.querySelector(".slash-menu")).not.toBeNull();

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(container.querySelector(".slash-menu")).toBeNull();
    container.remove();
  });

  it("keeps confirmed skill references as raw textarea text with native selection", () => {
    replaceSkillCommands({
      key: "prose_writer",
      skillDisplayName: "Prose Writer",
      description: "Draft polished prose.",
    });
    const { container } = createReactiveDraftHarness();
    inputDraftAtEnd(container, "Use $prose_writer: next");

    const textarea = getComposerTextarea(container);
    expect(textarea.value).toBe("Use $prose_writer: next");
    expect(container.querySelector(".agent-chat__skill-token")).toBeNull();
    expect(container.querySelector(".agent-chat__composer-draft-overlay")).toBeNull();
    expect(textarea.classList.contains("agent-chat__composer-textarea--rich")).toBe(false);

    textarea.setSelectionRange(8, 8);
    textarea.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(textarea.selectionStart).toBe(8);

    textarea.setSelectionRange(8, 8);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    expect(textarea.selectionStart).toBe(8);

    textarea.setSelectionRange("Use $prose_writer".length, "Use $prose_writer".length);
    expect(keydownComposer(container, "ArrowLeft").defaultPrevented).toBe(false);
    expect(keydownComposer(container, "Backspace").defaultPrevented).toBe(false);
    expect(textarea.value).toBe("Use $prose_writer: next");
  });

  it("fills a selected $ skill without submitting the surrounding prompt", async () => {
    replaceSkillCommands({
      key: "prose_writer",
      skillDisplayName: "Prose Writer",
      description: "Draft polished prose.",
    });
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend });
    inputDraftAtEnd(container, "Polish this with $pro:");

    keydownComposer(container, "Enter");

    expect(draft).toBe("Polish this with $prose_writer:");
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector(".skill-menu")).toBeNull();
    await Promise.resolve();
    const completed = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(completed?.selectionStart).toBe("Polish this with $prose_writer:".length);
  });

  it("consumes a trailing hyphen from an incomplete skill query", () => {
    replaceSkillCommands({ key: "release_notes", description: "Draft release notes." });
    let draft = "";
    const { container } = createReactiveDraftHarness({
      onDraftChange: (next) => {
        draft = next;
      },
    });
    inputDraftAtEnd(container, "Use $release-");

    keydownComposer(container, "Enter");

    expect(draft).toBe("Use $release_notes ");
  });

  it("does not treat common uppercase shell variables as skill references", () => {
    replaceSkillCommands(
      { key: "home", description: "Home skill." },
      { key: "editor", description: "Editor skill." },
    );
    const { container } = createReactiveDraftHarness();
    for (const variable of ["HOME", "EDITOR"]) {
      inputDraftAtEnd(container, `Inspect $${variable}`);
      expect(container.querySelector(".skill-menu")).toBeNull();
    }
  });

  it("does not offer skill references inside a slash-command draft", () => {
    replaceSkillCommands({ key: "prose", description: "Prose skill." });
    const { container } = createReactiveDraftHarness();
    inputDraftAtEnd(container, "/status $pro");

    expect(container.querySelector(".skill-menu")).toBeNull();
  });

  it("does not submit an incomplete skill reference while the catalog is loading", () => {
    replaceSlashCommands(buildFallbackSlashCommands());
    const refresh = createDeferred();
    let draft = "";
    const onSend = vi.fn();
    const { container } = createReactiveDraftHarness({
      onDraftChange: (next) => {
        draft = next;
      },
      onSend,
      onSlashIntent: () => refresh.promise,
    });
    inputDraftAtEnd(container, "Use $pro");
    expect(container.querySelector(".skill-menu")?.textContent).toContain("Loading skills");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(send?.disabled).toBe(true);

    keydownComposer(container, "Enter");
    send?.click();

    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("Use $pro");
  });

  it("keeps skill keyboard navigation and selection on the same highlighted item", () => {
    replaceSkillCommands(
      { key: "alpha", description: "Alpha skill." },
      { key: "beta", description: "Beta skill." },
    );
    let draft = "";
    const { container } = createReactiveDraftHarness({
      onDraftChange: (next) => {
        draft = next;
      },
    });
    inputDraftAtEnd(container, "Use $");

    keydownComposer(container, "ArrowDown");
    expect(
      container.querySelector(".skill-menu .slash-menu-item--active .slash-menu-name")?.textContent,
    ).toBe("beta");
    keydownComposer(container, "Enter");

    expect(draft).toBe("Use $beta ");
    expect(container.querySelector(".skill-menu")).toBeNull();
  });

  it("scrolls the keyboard-active skill inside the nested menu viewport", () => {
    replaceSkillCommands(
      ...Array.from({ length: 8 }, (_, index) => ({
        key: `skill_${index + 1}`,
        description: `Skill ${index + 1}.`,
      })),
    );
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const height = 28;
        let top = 0;
        if (this.classList.contains("slash-menu-item")) {
          const scrollRegion = this.closest<HTMLElement>(".slash-menu__scroll");
          const options = Array.from(
            scrollRegion?.querySelectorAll<HTMLElement>(".slash-menu-item") ?? [],
          );
          top = options.indexOf(this) * height - (scrollRegion?.scrollTop ?? 0);
        }
        const bottom = this.classList.contains("slash-menu__scroll") ? height * 2 : top + height;
        return {
          bottom,
          height: bottom - top,
          left: 0,
          right: 240,
          top,
          width: 240,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      },
    );
    const { container } = createReactiveDraftHarness();
    document.body.append(container);
    inputDraftAtEnd(container, "Use $");
    animationFrames.length = 0;

    for (let index = 0; index < 4; index += 1) {
      keydownComposer(container, "ArrowDown");
    }
    animationFrames.at(-1)?.(0);

    const scrollRegion = container.querySelector<HTMLElement>(".skill-menu .slash-menu__scroll");
    const outerMenu = container.querySelector<HTMLElement>(".skill-menu");
    const activeOption = container.querySelector<HTMLElement>(".slash-menu-item--active");
    const viewportBounds = scrollRegion?.getBoundingClientRect();
    const optionBounds = activeOption?.getBoundingClientRect();
    expect(scrollRegion?.scrollTop).toBeGreaterThan(0);
    expect(outerMenu?.scrollTop).toBe(0);
    expect(optionBounds?.top).toBeGreaterThanOrEqual(viewportBounds?.top ?? 0);
    expect(optionBounds?.bottom).toBeLessThanOrEqual(viewportBounds?.bottom ?? 0);
    container.remove();
  });

  it("does not reopen a dismissed skill picker after a slow refresh", async () => {
    replaceSkillCommands({ key: "prose", description: "Prose skill." });
    const refresh = createDeferred();
    const { container } = createReactiveDraftHarness({
      onSlashIntent: () => refresh.promise,
    });
    inputDraftAtEnd(container, "$pro");
    expect(container.querySelector(".skill-menu")?.textContent).toContain("Loading skills");
    expect(container.querySelectorAll(".skill-menu [role='option']")).toHaveLength(0);

    keydownComposer(container, "Escape");
    expect(container.querySelector(".skill-menu")).toBeNull();
    refresh.resolve();
    await refresh.promise;
    await Promise.resolve();

    expect(container.querySelector(".skill-menu")).toBeNull();
  });

  it("closes a stale skill picker when the caret leaves its token", () => {
    replaceSkillCommands({ key: "prose", description: "Prose skill." });
    const { container } = createReactiveDraftHarness();
    let textarea = getComposerTextarea(container);
    textarea.value = "Use $pro then continue";
    textarea.setSelectionRange("Use $pro".length, "Use $pro".length);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(container.querySelector(".skill-menu")).not.toBeNull();

    textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));

    expect(container.querySelector(".skill-menu")).toBeNull();
  });

  it("matches backend escape parity and absorbs rejected skill refreshes", async () => {
    replaceSkillCommands({ key: "prose", description: "Prose skill." });
    const { container } = createReactiveDraftHarness({
      onSlashIntent: async () => {
        throw new Error("catalog unavailable");
      },
    });
    inputDraftAtEnd(container, String.raw`Use \\$pro`);
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector(".skill-menu")).not.toBeNull();
  });

  it("does not reopen slash suggestions when command hydration finishes after plain typing", async () => {
    const hydration = createDeferred();
    const onSlashIntent = vi.fn(() => hydration.promise);
    const { container } = createReactiveDraftHarness({ onSlashIntent });

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
      renderChatInto(container, {
        connected,
        draft,
        getDraft: () => draft,
        onDraftChange,
        onSend,
      });
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

  it("does not dispatch a stale inline command selection after disconnect", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container, renderCurrent } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
    });

    inputDraftAtEnd(container, "hello /statu");
    const statusOption = container.querySelector<HTMLElement>(".slash-menu-item");
    expect(statusOption?.querySelector(".slash-menu-name")?.textContent?.trim()).toBe("/status");

    renderCurrent({ connected: false });
    statusOption?.click();

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("hello /statu");
  });

  it("clears the visible local draft immediately when send clears the host draft", () => {
    const { container, onDraftChange, onSend } = createDraftHarness();
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    expect(onDraftChange).toHaveBeenCalledWith("submitted message", undefined);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
  });

  it("ignores a stale native InputEvent replay after send clears the host draft", () => {
    const { container, onDraftChange } = createDraftHarness();
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    replayInput(textarea!, "submitted message");

    expect(textarea?.value).toBe("");
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a new same-session draft when a delayed stale replay arrives", () => {
    const { container } = createDraftHarness();
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    replayInput(textarea!, "new draft", "beforeinput");
    replayInput(textarea!, "new draft");
    expect(textarea?.value).toBe("new draft");

    replayInput(textarea!, "submitted message");

    expect(textarea?.value).toBe("new draft");
  });

  it("does not apply a stale submitted draft replay to another session", () => {
    const { container, drafts, onDraftChange, renderSession } =
      createSessionDraftHarness("stale-replay");

    renderSession("stale-replay-a");
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");

    renderSession("stale-replay-b");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    replayInput(textarea!, "submitted message");

    expect(textarea?.value).toBe("");
    expect(drafts["stale-replay-b"]).toBe("");
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an intervening session draft with a delayed stale replay", () => {
    const { container, drafts, renderSession } = createSessionDraftHarness("delayed-replay");

    renderSession("delayed-replay-a");
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");

    renderSession("delayed-replay-b");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("");

    replayInput(textarea!, "session b draft", "beforeinput");
    replayInput(textarea!, "session b draft");
    expect(textarea?.value).toBe("session b draft");

    replayInput(textarea!, "submitted message");

    expect(textarea?.value).toBe("session b draft");
    expect(drafts["delayed-replay-b"]).toBe("session b draft");
  });

  it("commits local draft input before Enter sends", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const container = renderChatView({ onDraftChange, onSend });

    inputDraft(container, "send from enter");
    keydownComposer(container, "Enter");

    expect(onDraftChange).toHaveBeenCalledWith("send from enter", undefined);
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
    container
      .querySelector("textarea")
      ?.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    inputDraft(container, "compose across lines");
    keydownComposer(container, "Enter", { metaKey: true });

    expect(onDraftChange).toHaveBeenCalledWith("compose across lines", undefined);
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

    expect(onDraftChange).toHaveBeenCalledWith("persist before leaving composer", undefined);
  });

  it("commits plain draft input while a send is active", () => {
    const onDraftChange = vi.fn();
    const container = renderChatView({ onDraftChange, sending: true });

    inputDraft(container, "do not let failed send restore over this");

    expect(onDraftChange).toHaveBeenCalledWith(
      "do not let failed send restore over this",
      undefined,
    );
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
    const harness = createSlashRerenderHarness();
    const container = harness.inputAndRender(harness.container, "/");

    const wrapper = container.querySelector<HTMLElement>(".agent-chat__composer-combobox");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const listbox = container.querySelector<HTMLElement>("#chat-single-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(wrapper?.hasAttribute("role")).toBe(false);
    expect(wrapper?.hasAttribute("aria-expanded")).toBe(false);
    expect(wrapper?.hasAttribute("aria-haspopup")).toBe(false);
    expect(wrapper?.hasAttribute("aria-controls")).toBe(false);
    expect(textarea?.hasAttribute("role")).toBe(false);
    expect(textarea?.getAttribute("aria-expanded")).toBe("true");
    expect(textarea?.hasAttribute("aria-haspopup")).toBe(false);
    expect(textarea?.getAttribute("aria-controls")).toBe("chat-single-slash-menu-listbox");
    expect(textarea?.getAttribute("aria-autocomplete")).toBe("list");
    expect(listbox?.getAttribute("role")).toBe("listbox");
    expect(activeId).toMatch(/^chat-single-slash-option-command-/u);
    expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("role")).toBe("option");
  });

  it("removes secondary implementation and option-count badges", () => {
    const harness = createSlashRerenderHarness();
    const container = harness.inputAndRender(harness.container, "/");
    const stopOption = Array.from(
      container.querySelectorAll<HTMLElement>(".slash-menu [role='option']"),
    ).find((option) => option.querySelector(".slash-menu-name")?.textContent?.trim() === "/stop");

    expect(stopOption).toBeDefined();
    expect(stopOption?.querySelector(".slash-menu-badge")).toBeNull();
    expect(container.querySelector(".slash-menu-badge")).toBeNull();
  });

  it("shows every command directly without an expander or keyboard footer", () => {
    replaceSlashCommands([
      {
        key: "standard-command",
        name: "standard-command",
        description: "Standard command.",
        tier: "standard",
        category: "session",
      },
      {
        key: "power-command",
        name: "power-command",
        description: "Power command.",
        tier: "power",
        category: "tools",
      },
    ]);
    const harness = createSlashRerenderHarness();
    const container = harness.inputAndRender(harness.container, "/");

    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
        (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
      ),
    ).toEqual(["/standard-command", "/power-command"]);
    expect(container.querySelector(".slash-menu-show-more")).toBeNull();
    expect(container.querySelector(".slash-menu-footer")).toBeNull();
  });

  it("keeps filtered command DOM and keyboard order aligned with relevance", () => {
    replaceSlashCommands([
      {
        key: "pair",
        name: "pair",
        description: "Pair a device.",
        tier: "power",
        category: "tools",
      },
      {
        key: "pair-device",
        name: "pair-device",
        description: "Pair a specific device.",
        tier: "standard",
        category: "session",
      },
      {
        key: "openclaw",
        name: "openclaw",
        description: "Run the setup and repair helper.",
        tier: "essential",
        category: "tools",
      },
    ]);
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/pair");

    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
        (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
      ),
    ).toEqual(["/pair", "/pair-device", "/openclaw"]);
    expect(
      Array.from(container.querySelectorAll(".slash-menu-group__label")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Tools", "Session", "Tools"]);

    keydownComposer(container, "ArrowDown");
    container = harness.renderCurrent();
    const options = container.querySelectorAll<HTMLElement>(".slash-menu [role='option']");
    const activeId = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");
    expect(options[1]?.id).toBe(activeId);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    keydownComposer(container, "Enter");
    container = harness.renderCurrent();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/pair-device ");
    expect(container.querySelector(".slash-menu")).toBeNull();
  });

  it("keeps a stable composer name when attachments change its placeholder", () => {
    const harness = createReactiveDraftHarness();
    const textarea = requireElement(
      harness.container,
      "textarea",
      "chat composer",
    ) as HTMLTextAreaElement;
    const initialPlaceholder = textarea.placeholder;
    expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
    expect(textarea.hasAttribute("role")).toBe(false);

    harness.renderCurrent({
      attachments: [
        {
          id: "image",
          fileName: "sample.png",
          mimeType: "image/png",
          previewUrl: "blob:sample-image",
          sizeBytes: 3,
        },
      ],
    });
    expect(harness.container.querySelector(".chat-attachment-thumb")).not.toBeNull();
    expect(textarea.placeholder).not.toBe(initialPlaceholder);
    expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
    expect(textarea.hasAttribute("role")).toBe(false);

    harness.renderCurrent({ attachments: [] });
    expect(textarea.placeholder).toBe(initialPlaceholder);
    expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
  });

  it("updates the active descendant and live announcement during command navigation", () => {
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/");
    const initialActiveId = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");

    keydownComposer(container, "ArrowDown");
    container = harness.renderCurrent();

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
      const harness = createSlashRerenderHarness();
      const container = harness.inputAndRender(harness.container, "/clear");

      const status = container.querySelector<HTMLElement>("#chat-single-slash-active-announcement");
      expect(status?.textContent?.trim()).toBe(`/clear ${t("common.health")}`);
    } finally {
      clearCommand.descriptionKey = originalDescriptionKey;
      await i18n.setLocale("en");
    }
  });

  it("wires fixed argument suggestions with command-and-argument option ids", () => {
    const harness = createSlashRerenderHarness();
    const container = harness.inputAndRender(harness.container, "/tools ");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const listbox = container.querySelector<HTMLElement>("#chat-single-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(listbox?.getAttribute("aria-label")).toBe("Command arguments");
    expect(activeId).toBe("chat-single-slash-option-arg-tools-compact");
    expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("aria-selected")).toBe("true");
  });

  it.each([
    { name: "direct", sessionKey: "main", rowKey: "main" },
    { name: "global alias", sessionKey: "agent:work:main", rowKey: "global" },
  ])(
    "opens model-supported thinking arguments after tab-completing /think ($name)",
    ({ sessionKey, rowKey }) => {
      const sessions = createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
      });
      const session = expectDefined(sessions.sessions[0], "active session");
      session.key = rowKey;
      session.thinkingLevels = [
        { id: "off", label: "off" },
        { id: "minimal", label: "minimal" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
        { id: "ultra", label: "ultra" },
      ];
      const { container } = createReactiveDraftHarness({
        sessions,
        sessionKey,
        selectedSession: session,
      });

      inputDraft(container, "/think");
      keydownComposer(container, "Tab");

      expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/think ");
      expect(
        Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
          (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
        ),
      ).toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    },
  );

  it("suppresses thinking arguments while the active model is switching", () => {
    const sessions = createSessionsListResult({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    });
    const session = expectDefined(sessions.sessions[0], "active session");
    session.thinkingLevels = [
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ];
    const { container } = createReactiveDraftHarness({
      modelSwitching: true,
      sessions,
      selectedSession: session,
    });

    inputDraft(container, "/think");
    keydownComposer(container, "Tab");

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/think ");
    expect(container.querySelector(".slash-menu")).toBeNull();
  });

  it("closes open thinking arguments when the active model starts switching", () => {
    const sessions = createSessionsListResult({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    });
    const session = expectDefined(sessions.sessions[0], "active session");
    session.thinkingLevels = [
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ];
    const { container, renderCurrent } = createReactiveDraftHarness({
      sessions,
      selectedSession: session,
    });

    inputDraft(container, "/think");
    keydownComposer(container, "Tab");
    expect(container.querySelector(".slash-menu")).not.toBeNull();
    expect(
      container
        .querySelector<HTMLTextAreaElement>("textarea")
        ?.getAttribute("aria-activedescendant"),
    ).toBe("chat-single-slash-option-arg-think-default");

    renderCurrent({ modelSwitching: true });

    expect(container.querySelector(".slash-menu")).toBeNull();
    expect(
      container
        .querySelector<HTMLTextAreaElement>("textarea")
        ?.hasAttribute("aria-activedescendant"),
    ).toBe(false);
  });

  it("clears active descendant when suggestions close", () => {
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/");
    const activeDescendant = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");
    if (!activeDescendant) {
      throw new Error("Expected slash suggestions to set aria-activedescendant");
    }

    container = harness.inputAndRender(container, "plain message");

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
  function renderAttachmentHarness(
    getAttachments: () => ChatAttachment[],
    onAttachmentsChange: (attachments: ChatAttachment[]) => void,
  ) {
    return renderChatView({
      attachments: getAttachments(),
      getAttachments,
      onAttachmentsChange,
    });
  }

  function selectFile(input: HTMLInputElement, file: File) {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getAttachmentMenuOption(container: Element, label: string) {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>(".agent-chat__attach-menu-option"),
    ).find((button) => button.textContent?.trim() === label);
  }

  function requireAttachmentInput(container: Element, selector: string, label: string) {
    return requireElement(container, selector, label) as HTMLInputElement;
  }

  function selectAttachmentMenuOption(button: HTMLButtonElement | undefined) {
    button
      ?.closest("wa-dropdown")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: button }, bubbles: true }));
  }

  it.each(["clipboard", "file picker", "drop"] as const)(
    "waits for an in-flight %s attachment before accepting an immediate send",
    async (entry) => {
      const readers: FileReader[] = [];
      vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(
        function (this: FileReader) {
          readers.push(this);
        },
      );
      const container = document.createElement("div");
      const file = new File(["attachment proof"], "proof.png", { type: "image/png" });
      const draft = "Send the attachment with this message";
      let attachments: ChatAttachment[] = [];
      const onSend = vi.fn(() => {
        expect(attachments.map((attachment) => attachment.fileName)).toEqual(["proof.png"]);
      });
      const redraw = () => {
        const readSignal = reads.readSignal;
        render(
          renderChat(
            createChatProps({
              attachments,
              draft,
              getAttachments: () => attachments,
              getDraft: () => draft,
              getPendingAttachmentReads: () => reads.pendingReads,
              onAttachmentsChange: (next) => {
                attachments = next;
              },
              onPendingReadsChange: (delta) => reads.updatePending(readSignal, delta),
              onSend,
              pendingAttachmentReads: reads.pendingReads,
              readSignal,
            }),
          ),
          container,
        );
      };
      const reads = new ChatAttachmentReadLifecycle(redraw);
      redraw();

      if (entry === "clipboard") {
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", {
          value: {
            items: [{ type: file.type, getAsFile: () => file }],
            getData: () => "",
          },
        });
        getComposerTextarea(container).dispatchEvent(paste);
      } else if (entry === "file picker") {
        const input = requireAttachmentInput(
          container,
          ".agent-chat__file-input",
          "attachment file input",
        );
        selectFile(input, file);
      } else {
        const drop = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(drop, "dataTransfer", {
          value: { files: [file], types: ["Files"] },
        });
        requireElement(container, "section.card.chat", "chat drop target").dispatchEvent(drop);
      }

      expect(readers).toHaveLength(1);
      expect(reads.pendingReads).toBe(1);
      expect(getComposerTextarea(container).disabled).toBe(false);
      const send = requireElement(
        container,
        'button[aria-label="Send message"]',
        "send button",
      ) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      getComposerTextarea(container).dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
      expect(onSend).not.toHaveBeenCalled();

      const reader = expectDefined(readers[0], "deferred attachment reader");
      Object.defineProperty(reader, "result", {
        configurable: true,
        value: `data:image/png;base64,${btoa("attachment proof")}`,
      });
      reader.dispatchEvent(new ProgressEvent("load"));

      await waitForFast(() => {
        expect(reads.pendingReads).toBe(0);
        expect(attachments.map((attachment) => attachment.fileName)).toEqual(["proof.png"]);
      });
      const readySend = requireElement(
        container,
        'button[aria-label="Send message"]',
        "ready send button",
      ) as HTMLButtonElement;
      expect(readySend.disabled).toBe(false);
      readySend.click();
      expect(onSend).toHaveBeenCalledOnce();
    },
  );

  it("does not attach an aborted file read to a newly selected session", async () => {
    const readers: FileReader[] = [];
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      readers.push(this);
    });
    const reads = new ChatAttachmentReadLifecycle(() => undefined);
    const oldSignal = reads.readSignal;
    const onAttachmentsChange = vi.fn();
    const file = new File(["private session A"], "private.png", { type: "image/png" });
    const container = renderChatView({
      getPendingAttachmentReads: () => reads.pendingReads,
      onAttachmentsChange,
      onPendingReadsChange: (delta) => reads.updatePending(oldSignal, delta),
      pendingAttachmentReads: reads.pendingReads,
      readSignal: oldSignal,
      sessionKey: "agent:main:session-a",
    });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    requireElement(container, "section.card.chat", "session A drop target").dispatchEvent(drop);

    expect(readers).toHaveLength(1);
    expect(reads.pendingReads).toBe(1);
    reads.abortReads();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldSignal.aborted).toBe(true);
    expect(reads.pendingReads).toBe(0);
    expect(reads.readSignal).not.toBe(oldSignal);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

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

  it("cancels non-file drops outside the composer textarea but keeps them native inside it", () => {
    const container = renderChatView();
    const chat = requireElement(container, "section.card.chat", "chat drop target");
    const textarea = getComposerTextarea(container);

    const outsideDrop = createDragEvent("drop", ["text/uri-list"]);
    chat.dispatchEvent(outsideDrop);
    expect(outsideDrop.defaultPrevented).toBe(true);

    const textareaDrop = createDragEvent("drop", ["text/uri-list"]);
    textarea.dispatchEvent(textareaDrop);
    expect(textareaDrop.defaultPrevented).toBe(false);

    const range = document.createElement("input");
    range.type = "range";
    chat.append(range);
    const rangeDrop = createDragEvent("drop", ["text/uri-list"]);
    range.dispatchEvent(rangeDrop);
    expect(rangeDrop.defaultPrevented).toBe(true);
  });

  it("turns large pasted plain text into a compact attachment", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({
      draft: "intro",
      getDraft: () => "intro",
      onAttachmentsChange,
    });
    const textarea = getComposerTextarea(container);
    const pastedText = "large paste\n" + "x".repeat(1100);
    const allowed = textarea.dispatchEvent(createPasteEvent(pastedText));

    expect(allowed).toBe(false);
    await waitForFast(() => {
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
    const textarea = getComposerTextarea(container);
    const pastedText = `large rich-text paste ${"x".repeat(1100)}`;
    expect(
      textarea.dispatchEvent(
        createPasteEvent(pastedText, ["text/plain", "text/html"], {
          "text/html": "<p>rich text</p>",
        }),
      ),
    ).toBe(false);
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
    const textarea = getComposerTextarea(container);
    const pastedText = `large paste ${"x".repeat(1100)}`;
    textarea.dispatchEvent(createPasteEvent(pastedText));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onSend).toHaveBeenCalledOnce();
  });

  it("merges successive large pastes into the current attachment state", () => {
    let attachments: ChatAttachment[] = [];
    const onAttachmentsChange = vi.fn((next: ChatAttachment[]) => {
      attachments = next;
    });
    const container = renderAttachmentHarness(() => attachments, onAttachmentsChange);
    const textarea = getComposerTextarea(container);
    const paste = (text: string) => {
      textarea.dispatchEvent(createPasteEvent(text));
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
    const container = renderAttachmentHarness(() => attachments, onAttachmentsChange);
    const textarea = getComposerTextarea(container);
    const chat = requireElement(container, "section.card.chat", "chat drop target");
    const pastedText = `large paste ${"x".repeat(1100)}`;
    const droppedFile = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [droppedFile], types: ["Files"] },
    });

    try {
      textarea.dispatchEvent(createPasteEvent(pastedText));
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

      await waitForFast(() => expect(attachments).toHaveLength(2));
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
    const textarea = getComposerTextarea(pasteTarget);
    textarea.dispatchEvent(createPasteEvent(`large paste ${"x".repeat(1100)}`));

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
    let container = renderAttachmentHarness(
      () => attachments,
      (next) => {
        attachments = next;
      },
    );
    const textarea = getComposerTextarea(container);
    const text = `First words from a long pasted note ${"x".repeat(1100)}`;
    textarea.dispatchEvent(createPasteEvent(text));
    container = renderChatView({ attachments });

    expect(container.querySelector(".chat-attachment-file__name")?.textContent).toContain(
      "First words from a l...",
    );
    expect(container.querySelector(".chat-attachment-text-action")?.textContent?.trim()).toBe(
      "Show in text field",
    );
  });

  it("preserves pasted-text presentation and restore behavior across handoff", () => {
    let attachments: ChatAttachment[] = [];
    const producer = renderAttachmentHarness(
      () => attachments,
      (next) => {
        attachments = next;
      },
    );
    const pastedText = `First words from a remounted paste ${"x".repeat(1100)}`;
    getComposerTextarea(producer).dispatchEvent(createPasteEvent(pastedText));
    const original = expectDefined(attachments[0], "pasted attachment");
    const originalDataUrl = getChatAttachmentDataUrl(original);

    const handoff = createChatAttachmentHandoff();
    const owner = {} as GatewayBrowserClient;
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments,
      fallbacks: {},
    });
    attachments = expectDefined(
      handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" }),
      "restored attachments",
    ).attachments;

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toBe(original);
    expect(getChatAttachmentDataUrl(original)).toBe(originalDataUrl);

    const onAttachmentsChange = vi.fn();
    const onDraftChange = vi.fn();
    const remounted = renderChatView({
      attachments,
      getAttachments: () => attachments,
      draft: "intro",
      getDraft: () => "intro",
      onAttachmentsChange,
      onDraftChange,
    });
    expect(remounted.querySelector(".chat-attachment-file__name")?.textContent).toContain(
      "First words from a r...",
    );
    requireElement(
      remounted,
      '[aria-label="Show in text field"]',
      "show pasted text button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
    expect(onDraftChange).toHaveBeenCalledWith(`intro\n\n${pastedText}`);
    expect(getChatAttachmentDataUrl(original)).toBeNull();
  });

  it("keeps large paste previews UTF-16 well-formed at the display boundary", () => {
    let attachments: ChatAttachment[] = [];
    let container = renderAttachmentHarness(
      () => attachments,
      (next) => {
        attachments = next;
      },
    );
    const textarea = getComposerTextarea(container);
    const text = `${"a".repeat(19)}🦞${"x".repeat(1100)}`;
    textarea.dispatchEvent(createPasteEvent(text));
    container = renderChatView({ attachments });

    expect(container.querySelector(".chat-attachment-file__name")?.textContent).toBe(
      `${"a".repeat(19)}...`,
    );
  });

  it("keeps normal short plain-text paste in the textarea", () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const textarea = getComposerTextarea(container);
    const allowed = textarea.dispatchEvent(createPasteEvent("short paste"));

    expect(allowed).toBe(true);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("shows a pasted text attachment in the composer text field", async () => {
    const onAttachmentsChange = vi.fn();
    const firstRender = renderChatView({ onAttachmentsChange });
    const textarea = getComposerTextarea(firstRender);
    const pastedText = "large paste\n" + "x".repeat(1100);
    textarea.dispatchEvent(createPasteEvent(pastedText));

    await waitForFast(() => {
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
    const showInTextFieldButton = requireElement(
      preview,
      '[aria-label="Show in text field"]',
      "show pasted text in text field button",
    ) as HTMLButtonElement;

    showInTextFieldButton.click();

    expect(onShowAttachmentsChange).toHaveBeenCalledWith([]);
    expect(onDraftChange).toHaveBeenCalledWith(`intro\n\n${pastedText}`);
    expect(
      getChatAttachmentDataUrl(expectDefined(attachment, "attachment test invariant")),
    ).toBeNull();
  });

  it("converts pasted data image text into an attachment", () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const textarea = getComposerTextarea(container);
    const base64 = btoa("png");
    const dataUrl = ` data:image/PNG;base64,${base64.slice(0, 2)}\n${base64.slice(2)} `;
    const allowed = textarea.dispatchEvent(createPasteEvent(dataUrl, []));

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

  it("renders multiple browser annotations as bounded, accessible cards", () => {
    const annotations: ChatAttachment[] = [
      {
        id: "annotation-title",
        mimeType: "image/png",
        previewUrl: "blob:annotation-title",
        browserAnnotation: {
          modelContext: "Context for the model",
          title: "Checkout page with a deliberately long title",
          displayUrl: "shop.example.test/checkout",
          markedRegionCount: 2,
          inspectedElement: true,
        },
      },
      {
        id: "annotation-url",
        mimeType: "image/png",
        previewUrl: "blob:annotation-url",
        browserAnnotation: {
          modelContext: "Second context",
          title: "",
          displayUrl: "docs.example.test/narrow-layout",
          markedRegionCount: 1,
          inspectedElement: false,
        },
      },
    ];

    const container = renderChatView({ attachments: annotations });
    const cards = container.querySelectorAll<HTMLElement>(
      ".chat-attachment-thumb--browser-annotation",
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]?.dataset.attachmentId).toBe("annotation-title");
    expect(cards[0]?.getAttribute("role")).toBe("group");
    expect(cards[0]?.getAttribute("aria-label")).toBe(
      "Browser annotation: Checkout page with a deliberately long title",
    );
    expect(cards[0]?.querySelector("img")?.getAttribute("alt")).toBe("Browser annotation preview");
    expect(cards[0]?.querySelector(".chat-browser-annotation-card__identity")?.textContent).toBe(
      "Checkout page with a deliberately long title",
    );
    expect(cards[0]?.querySelector(".chat-browser-annotation-card__meta")?.textContent).toContain(
      "2 marked regions",
    );
    expect(cards[0]?.textContent).not.toContain("Element inspected");
    expect(cards[1]?.querySelector(".chat-browser-annotation-card__identity")?.textContent).toBe(
      "docs.example.test/narrow-layout",
    );
    expect(cards[1]?.textContent).toContain("1 marked region");
    expect(cards[1]?.textContent).not.toContain("Element inspected");
    expect(
      cards[0]?.querySelector(
        '[aria-label="Remove browser annotation: Checkout page with a deliberately long title"]',
      ),
    ).toBeInstanceOf(HTMLButtonElement);
    for (const card of cards) {
      expect(card.querySelector(".chat-browser-annotation-card__preview")).not.toBeNull();
      expect(card.querySelector(".chat-browser-annotation-card__body")).not.toBeNull();
    }
  });

  it("delegates browser annotation removal without releasing its payload", () => {
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "annotation-remove",
        fileName: "annotation.png",
        mimeType: "image/png",
        browserAnnotation: {
          modelContext: "Context",
          title: "Account settings",
          displayUrl: "example.test/settings",
          markedRegionCount: 0,
          inspectedElement: false,
        },
      },
      dataUrl: "data:image/png;base64,YW5ub3RhdGlvbg==",
      file: new File(["annotation"], "annotation.png", { type: "image/png" }),
    });
    const onRemoveAttachment = vi.fn();
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({
      attachments: [attachment],
      onAttachmentsChange,
      onRemoveAttachment,
    });

    requireElement(
      container,
      '[aria-label="Remove browser annotation: Account settings"]',
      "browser annotation remove button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onRemoveAttachment).toHaveBeenCalledWith(attachment);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
  });

  it("keeps ordinary attachment removal immediate when an annotation callback exists", () => {
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "ordinary-remove",
        fileName: "ordinary.png",
        mimeType: "image/png",
      },
      dataUrl: "data:image/png;base64,b3JkaW5hcnk=",
      file: new File(["ordinary"], "ordinary.png", { type: "image/png" }),
    });
    const onRemoveAttachment = vi.fn();
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({
      attachments: [attachment],
      onAttachmentsChange,
      onRemoveAttachment,
    });

    requireElement(
      container,
      '[aria-label="Remove attachment"]',
      "ordinary attachment remove button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onRemoveAttachment).not.toHaveBeenCalled();
    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("opens the scoped file input from the attachment menu", () => {
    const container = renderChatView();
    const input = requireAttachmentInput(
      container,
      ".agent-chat__file-input",
      "attachment file input",
    );
    const attachButton = getAttachmentMenuOption(container, t("chat.composer.attachFileOption"));
    const clickInput = vi.spyOn(input, "click").mockImplementation(() => undefined);

    expect(attachButton).toBeInstanceOf(HTMLElement);
    selectAttachmentMenuOption(attachButton);

    expect(clickInput).toHaveBeenCalledTimes(1);
  });

  it("keeps attachment-only composers free of capability rows", () => {
    const container = renderChatView();

    expect(container.querySelectorAll(".agent-chat__attach-menu-option")).toHaveLength(3);
    expect(container.querySelector(".agent-chat__capability-menu-item")).toBeNull();
  });

  it("opens the camera input from the attachment menu and attaches the captured photo", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = requireAttachmentInput(
      container,
      ".agent-chat__camera-input",
      "camera capture input",
    );
    const cameraButton = getAttachmentMenuOption(container, t("chat.composer.takePhoto"));
    const clickInput = vi.spyOn(input, "click").mockImplementation(() => undefined);

    expect(input.accept).toBe("image/*");
    expect(input.getAttribute("capture")).toBe("environment");
    expect(cameraButton).toBeInstanceOf(HTMLElement);
    expect(container.querySelector(".agent-chat__camera-btn")).toBeNull();
    selectAttachmentMenuOption(cameraButton);
    expect(clickInput).toHaveBeenCalledTimes(1);

    const photo = new File(["photo"], "camera.jpg", { type: "image/jpeg" });
    selectFile(input, photo);

    await waitForFast(() => {
      const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.fileName).toBe("camera.jpg");
      expect(attachments[0]?.mimeType).toBe("image/jpeg");
    });
  });

  it("keeps the camera attachment option available when the composer has text", () => {
    const container = renderChatView({ draft: "Ready to send" });
    const cameraButton = getAttachmentMenuOption(container, t("chat.composer.takePhoto"));

    expect(cameraButton).toBeInstanceOf(HTMLElement);
    expect(container.querySelector(".agent-chat__camera-btn")).toBeNull();
    expect(container.querySelector('button[aria-label="Send message"]')).not.toBeNull();
  });

  it("accepts and previews file attachments", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = container.querySelector<HTMLInputElement>(".agent-chat__file-input");
    const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });

    expect(input).toBeInstanceOf(HTMLInputElement);
    selectFile(input!, file);

    await waitForFast(() => {
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

  it("infers video preview glyphs from filenames when MIME is absent", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = container.querySelector<HTMLInputElement>(".agent-chat__file-input");
    const file = new File(["video"], "clip.mp4");

    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.accept).toContain("video/*");
    selectFile(input!, file);

    await waitForFast(() => {
      const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.fileName).toBe("clip.mp4");
      expect(attachments[0]?.mimeType).toBe("application/octet-stream");
      expect(attachments[0]?.sizeBytes).toBe(file.size);
    });

    const nextAttachments = requireFirstAttachmentsChange(onAttachmentsChange);
    const preview = renderChatView({ attachments: nextAttachments });
    expect(preview.querySelectorAll(".chat-attachment-thumb--file")).toHaveLength(1);
    expect(preview.querySelector(".chat-attachment-file__name")?.textContent).toBe("clip.mp4");
    expect(preview.querySelector(".chat-attachment-file__icon")?.getAttribute("data-family")).toBe(
      "video",
    );
    expect(preview.querySelector(".chat-attachment-file__type")?.textContent).toBe("MP4");
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
    modelSetupRequired?: boolean;
    onModelSetup?: () => void;
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
        modelSetupRequired: params.modelSetupRequired,
        onModelSetup: params.onModelSetup,
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
    expect(clawd?.querySelector("openclaw-mascot")?.getAttribute("mood")).toBe("idle");
    expect(container.querySelector(".agent-chat__badge")).toBeNull();
  });

  it("replaces sendable welcome actions with model setup", () => {
    const onModelSetup = vi.fn();
    const container = renderWelcome({
      assistantAvatar: null,
      modelSetupRequired: true,
      onModelSetup,
    });

    expect(container.textContent).toContain("No AI provider configured");
    expect(container.querySelector(".agent-chat__suggestions")).toBeNull();

    container.querySelector<HTMLButtonElement>(".agent-chat__welcome button")?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("omits the composer footer behind the empty model setup splash", () => {
    const container = renderChatView({
      canSend: false,
      disabledBanner: {
        kind: "composer-replacement",
        text: "We couldn't find a provider and model configured for this agent. Choose a supported connection; OpenClaw will test it before enabling chat.",
        actionLabel: "Connect an AI provider",
        onAction: () => undefined,
      },
      modelSetupRequired: true,
    });

    expect(container.querySelector(".agent-chat__welcome--setup")).not.toBeNull();
    expect(container.querySelector(".agent-chat__composer-shell")).toBeNull();
  });

  it("teases and catches file drags with the welcome mascot", () => {
    const container = renderWelcome({ assistantAvatar: null, assistantAvatarUrl: null });
    const welcome = requireElement(container, ".agent-chat__welcome", "welcome screen");
    const mascot = requireElement(
      container,
      ".agent-chat__welcome-clawd openclaw-mascot",
      "welcome mascot",
    ) as HTMLElement & { tease: boolean; catchOnce: () => void };
    const catchOnce = vi.spyOn(mascot, "catchOnce");

    welcome.dispatchEvent(createDragEvent("dragenter"));
    expect(mascot.tease).toBe(true);

    welcome.dispatchEvent(createDragEvent("drop"));
    expect(mascot.tease).toBe(false);
    expect(catchOnce).toHaveBeenCalledOnce();
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
    const container = renderModelControls(state);

    const modelSelect = getChatModelSelect(container);
    expect(modelSelect.getAttribute("aria-disabled")).toBe("true");
  });

  it("renders an accessible skeleton and reserves hidden effort geometry before the snapshot", () => {
    const { state } = createChatHeaderState();
    const container = renderModelControls(state, {
      modelCatalogState: { hasSnapshot: false, status: "loading" },
      modelsLoading: true,
    });
    const trigger = getChatModelSelect(container);

    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.getAttribute("aria-disabled")).toBe("false");
    expect(trigger.querySelector(".chat-controls__model-trigger-skeleton")).not.toBeNull();
    expect(trigger.textContent).not.toContain("Loading models");
    const effort = container.querySelector(".chat-controls__effort-picker");
    expect(effort?.getAttribute("aria-hidden")).toBe("true");
    expect(effort?.hasAttribute("inert")).toBe(true);
  });

  it.each([
    { name: "session selection", overrides: {}, expected: "openai/gpt-5.6-sol" },
    {
      name: "pending local selection",
      overrides: { main: "openai/gpt-5.6-luna" },
      expected: "openai/gpt-5.6-luna",
    },
    { name: "explicit default reset", overrides: { main: null }, expected: "gpt-5 · openai" },
  ])("keeps the $name visible while its catalog loads", ({ overrides, expected }) => {
    const { state } = createChatHeaderState({ model: "gpt-5.6-sol", models: [] });
    const container = renderModelControls(state, {
      modelCatalogState: { hasSnapshot: false, status: "loading" },
      modelOverrides: overrides,
      modelsLoading: true,
    });
    const trigger = getChatModelSelect(container);

    expect(trigger.textContent).toContain(expected);
    expect(trigger.getAttribute("aria-label")).toBe(`Chat model: ${expected}`);
    expect(trigger.getAttribute("aria-busy")).toBe("false");
    expect(trigger.querySelector(".chat-controls__model-trigger-skeleton")).toBeNull();
    expect(container.querySelector('[data-chat-model-catalog-state="loading"]')).not.toBeNull();
    expect(container.querySelector("[data-chat-model-option]")).toBeNull();
  });

  it("shows disabled configured models and model setup when no model has authentication", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          contextWindow: 1_000_000,
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          contextWindow: 1_000_000,
          available: false,
          unavailableReason: "missing-auth",
        },
      ],
    });
    const onModelSetup = vi.fn();
    const container = renderModelControls(state, {
      agentDefaultModel: "openai/gpt-5.6-sol",
      onModelSetup,
    });

    const options = container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]");
    expect([...options].map((option) => option.dataset.chatModelOption)).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-luna",
    ]);
    expect(options[0]?.textContent).toContain("GPT-5.6 Sol");
    expect(options[0]?.textContent).toContain("Default");
    expect([...options].every((option) => !option.disabled)).toBe(true);
    expect([...options].every((option) => option.dataset.chatModelSetup === "true")).toBe(true);
    for (const option of options) {
      const warning = option.querySelector("[data-chat-model-auth-warning]");
      expect(warning?.textContent?.trim()).toBe("Sign-in needed");
      expect(warning?.querySelector("svg")).not.toBeNull();
      expect(option.querySelector(".chat-controls__model-option-meta")).toBeNull();
      expect(option.textContent).not.toContain("1M");
    }
    expect(
      container.querySelector('[data-chat-model-catalog-state="ready"]')?.textContent,
    ).toContain("No models available");
    expect(container.textContent).toContain("Manage models");
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("keeps each alias's auth action tied to its own availability reason", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "codex",
          available: false,
          unavailableReason: "cooldown",
        },
      ],
    });
    const onModelSetup = vi.fn();
    const container = renderModelControls(state, { onModelSetup });
    const cold = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.6-luna"]',
    );
    const recovering = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="codex/gpt-5.6-luna"]',
    );
    expect(cold?.dataset.chatModelSetup).toBe("true");
    expect(recovering?.disabled).toBe(true);
    expect(recovering?.textContent).not.toContain("Sign-in needed");
    recovering?.click();
    expect(onModelSetup).not.toHaveBeenCalled();
    cold?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("shows a successful empty catalog without authentication guidance", () => {
    const { state } = createChatHeaderState({ models: [] });
    const onModelSetup = vi.fn();
    const container = renderModelControls(state, {
      modelCatalogState: { hasSnapshot: true, status: "ready" },
      onModelSetup,
    });

    expect(
      container.querySelector('[data-chat-model-catalog-state="ready"]')?.textContent,
    ).toContain("No models available");
    expect(container.textContent).not.toContain("Authentication failed");
    expect(container.textContent).toContain("Manage models");
    expect(container.textContent).not.toContain("Review connection");
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it.each([
    { status: "offline", catalogState: "offline", triggerLabel: "GPT-5.6 Sol" },
    { status: "error", catalogState: null, triggerLabel: "GPT-5.6 Sol" },
  ] as const)(
    "renders $status over a stale all-cold catalog",
    ({ status, catalogState, triggerLabel }) => {
      const { state } = createChatHeaderState({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai",
            available: false,
          },
        ],
      });
      const container = renderModelControls(state, {
        modelCatalogState: {
          hasSnapshot: true,
          status,
        },
      });

      expect(
        container
          .querySelector("[data-chat-model-catalog-state]")
          ?.getAttribute("data-chat-model-catalog-state") ?? null,
      ).toBe(catalogState);
      expect(container.querySelector(".chat-controls__inline-select-label")?.textContent).toContain(
        triggerLabel,
      );
      expect(container.textContent).not.toContain("Authentication failed");
      expect(container.querySelector('[data-chat-model-setup="true"]')).toBeNull();
      if (status === "offline") {
        expect(container.querySelector(".chat-controls__effort-picker")).toBeNull();
      }
    },
  );

  it("applies a model selection immediately", () => {
    const { state } = createOpenAiHeaderState();
    const onModelSelect = vi.fn(async () => true);
    const container = renderModelControls(state, { onModelSelect });
    const modelOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).find((button) => button.getAttribute("aria-selected") === "false");
    expect(modelOption).toBeInstanceOf(HTMLButtonElement);
    modelOption?.click();

    expect(onModelSelect).toHaveBeenCalledWith(modelOption?.dataset.chatModelOption, "main");
  });

  it.each([
    ["session", "Selecting a model changes only this session."],
    ["agent", "Selecting a model updates this agent's default."],
    ["global", "Selecting a model updates the global default."],
  ] as const)(
    "keeps the $target write target accessible without rendering a status row",
    (target, scopeDescription) => {
      const { state } = createOpenAiHeaderState();
      state.sessionsResult = {
        ...expectDefined(state.sessionsResult, "sessions result"),
        defaults: {
          ...expectDefined(state.sessionsResult, "sessions result").defaults,
          modelSelectionTarget: target,
        },
      };
      const onModelSelect = vi.fn(async () => true);
      const container = renderModelControls(state, { onModelSelect });

      expect(container.querySelector("[data-chat-model-selection-target]")).toBeNull();
      const trigger = getChatModelSelect(container);
      expect(trigger.title).toBe(scopeDescription);
      expect(trigger.getAttribute("aria-label")).toContain(scopeDescription);
      expect(container.querySelector("[data-chat-model-selection-scope]")).toBeNull();
      const modelOption = Array.from(
        container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
      ).find((button) => button.getAttribute("aria-selected") === "false");
      modelOption?.click();

      expect(onModelSelect).toHaveBeenCalledWith(modelOption?.dataset.chatModelOption, "main");
    },
  );

  it("renders and applies selectable context windows inside the model picker", () => {
    const { state } = createChatHeaderState({
      model: "claude-fable-5",
      modelProvider: "claude-cli",
      models: [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "claude-cli",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ],
    });
    const session = state.sessionsResult?.sessions[0];
    if (!state.sessionsResult || !session) {
      throw new Error("Expected session fixture");
    }
    state.sessionsResult = {
      ...state.sessionsResult,
      defaults: {
        ...state.sessionsResult.defaults,
        contextWindow: "1m",
        contextWindowDefault: "1m",
        contextWindows: state.chatModelCatalog[0]?.contextWindows,
      },
      sessions: [
        {
          ...session,
          contextWindow: "1m",
          contextWindowDefault: "1m",
          contextWindows: state.chatModelCatalog[0]?.contextWindows,
        },
      ],
    };
    const onContextWindowSelect = vi.fn(async () => true);
    const container = renderModelControls(state, { onContextWindowSelect });
    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    expect(picker).toBeInstanceOf(HTMLDetailsElement);
    if (!picker) {
      throw new Error("Expected model picker");
    }
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));

    const toggle = container.querySelector<HTMLButtonElement>("[data-chat-context-window-toggle]");
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(toggle?.dataset.chatContextWindowToggle).toBe("200k");
    expect(container.querySelector("[data-chat-model-context-badge]")).toBeNull();
    toggle?.click();
    expect(onContextWindowSelect).toHaveBeenCalledWith("200k", "main");
    expect(picker.open).toBe(true);

    const activeRow = expectDefined(state.sessionsResult.sessions[0], "active session");
    state.sessionsResult.sessions[0] = { ...activeRow, contextWindow: "200k" };
    renderModelControls(state, { onContextWindowSelect }, container);
    expect(container.querySelector("[data-chat-model-context-badge]")?.textContent?.trim()).toBe(
      "200K",
    );
    expect(
      container.querySelector("[data-chat-context-window-toggle]")?.getAttribute("aria-checked"),
    ).toBe("false");

    const { state: unsupportedState } = createOpenAiHeaderState();
    renderModelControls(unsupportedState, {}, container);
    expect(container.querySelector("[data-chat-context-window-toggle]")).toBeNull();
  });

  it("hides the context-window switch when the active session's model declares none", () => {
    const { state } = createChatHeaderState({
      model: "claude-fable-5",
      modelProvider: "claude-cli",
      models: [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "claude-cli",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ],
    });
    const session = state.sessionsResult?.sessions[0];
    if (!state.sessionsResult || !session) {
      throw new Error("Expected session fixture");
    }
    // Defaults row advertises selectable windows, but the active session runs an
    // override model without any: the switch must not fall back field-by-field
    // to the defaults row and offer options the session's model cannot honor.
    state.sessionsResult = {
      ...state.sessionsResult,
      defaults: {
        ...state.sessionsResult.defaults,
        contextWindow: "1m",
        contextWindowDefault: "1m",
        contextWindows: state.chatModelCatalog[0]?.contextWindows,
      },
      sessions: [{ ...session, model: "gpt-5.6-luna", modelProvider: "openai" }],
    };
    const container = renderModelControls(state, {});
    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    if (!picker) {
      throw new Error("Expected model picker");
    }
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));

    expect(container.querySelector("[data-chat-context-window-toggle]")).toBeNull();
    expect(container.querySelector("[data-chat-model-context-badge]")).toBeNull();
  });

  it("requests live wildcard discovery when the model picker opens", () => {
    const { state } = createOpenAiHeaderState();
    const onModelPickerOpen = vi.fn();
    const container = renderModelControls(state, { onModelPickerOpen });

    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    expect(picker).toBeInstanceOf(HTMLDetailsElement);
    picker!.open = true;
    picker!.dispatchEvent(new Event("toggle"));

    expect(onModelPickerOpen).toHaveBeenCalledOnce();
  });

  it("keeps the model picker geometry stable when its open catalog resolves", () => {
    const { state } = createOpenAiHeaderState();
    const container = renderModelControls(state, {
      modelCatalog: [],
      modelCatalogState: { hasSnapshot: false, status: "loading" },
      modelPickerOpen: true,
      modelsLoading: true,
    });
    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    const effort = container.querySelector<HTMLDetailsElement>(".chat-controls__effort-picker");
    expect(picker?.open).toBe(true);
    expect(effort?.getAttribute("aria-hidden")).toBe("true");
    expect(effort?.hasAttribute("inert")).toBe(true);

    renderModelControls(state, { modelPickerOpen: true }, container);

    expect(container.querySelector(".chat-controls__model-picker")).toBe(picker);
    expect(picker?.open).toBe(true);
    expect(container.querySelector(".chat-controls__effort-picker")).toBe(effort);
    expect(effort?.getAttribute("aria-hidden")).toBe("false");
    expect(effort?.hasAttribute("inert")).toBe(false);
    expect(effort?.textContent).toContain("Medium");
  });

  it("keeps model enabled while write-only access disables effort controls", () => {
    const { state } = createOpenAiHeaderState();
    const onFastModeSelect = vi.fn(async () => true);
    const onModelSelect = vi.fn(async () => true);
    const onThinkingSelect = vi.fn(async () => true);
    const reason = "Operator admin access is required.";
    const container = renderModelControls(state, {
      effortMutationDisabledReason: reason,
      onFastModeSelect,
      onModelSelect,
      onThinkingSelect,
    });

    const modelSelect = getChatModelSelect(container);
    expect(modelSelect.getAttribute("aria-disabled")).toBe("false");
    expect(modelSelect.getAttribute("title")).not.toBe(reason);
    const modelOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).find((button) => button.getAttribute("aria-selected") === "false");
    modelOption?.click();
    container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")?.click();
    getThinkingSlider(container)?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onFastModeSelect).not.toHaveBeenCalled();
    expect(onModelSelect).toHaveBeenCalledWith(modelOption?.dataset.chatModelOption, "main");
    expect(onThinkingSelect).not.toHaveBeenCalled();
  });

  it("hides the provenance footer for an inherited default and resets a recorded pin", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5",
      modelProvider: "openai",
      modelOverrideSource: null,
      models: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }, ...createOpenAiModelCatalog()],
    });
    const onModelSelect = vi.fn(async () => true);
    const container = renderModelControls(state);

    expect(container.querySelector(".chat-controls__model-provenance")).toBeNull();
    expect(container.querySelector("[data-chat-model-reset]")).toBeNull();

    state.sessionsResult = createSessionsListResult({
      model: "gpt-5.4",
      modelProvider: "openai",
      modelOverrideSource: "user",
    });
    renderModelControls(state, { onModelSelect }, container);

    const reset = container.querySelector<HTMLButtonElement>("[data-chat-model-reset]");
    const modelSelect = getChatModelSelect(container);
    const details = modelSelect.closest<HTMLDetailsElement>("details");
    document.body.append(container);
    if (details) {
      details.open = true;
    }
    expect(reset).toBeInstanceOf(HTMLButtonElement);
    expect(reset?.textContent?.trim()).toBe("Reset session model");
    expect(reset?.title).toBe("Use default (GPT-5) for this session");
    reset?.focus();
    reset?.click();
    expect(onModelSelect).toHaveBeenCalledWith("", "main");
    expect(details?.open).toBe(false);
    expect(document.activeElement).toBe(modelSelect);
    container.remove();
  });

  it.each(["agent", "global"] as const)(
    "keeps a pinned reset session-only while model rows write to the $target target",
    (target) => {
      const { state } = createChatHeaderState({
        model: "gpt-5.4",
        modelOverrideSource: "user",
        modelProvider: "openai",
        models: createOpenAiModelCatalog(),
      });
      state.sessionsResult = {
        ...expectDefined(state.sessionsResult, "sessions result"),
        defaults: {
          ...expectDefined(state.sessionsResult, "sessions result").defaults,
          modelSelectionTarget: target,
        },
      };
      const onModelSelect = vi.fn(async () => true);
      const container = renderModelControls(state, { onModelSelect });

      expect(container.querySelector("[data-chat-model-selection-target]")).toBeNull();
      const reset = container.querySelector<HTMLButtonElement>("[data-chat-model-reset]");
      expect(reset?.textContent?.trim()).toBe("Reset session model");
      expect(reset?.title).toContain("for this session");
      reset?.click();

      expect(onModelSelect).toHaveBeenCalledWith("", "main");
    },
  );

  // Settings can move the agent default onto — and back off — a session's pinned
  // model. Provenance must survive both moves, and the default row must stay a live
  // way to clear the pin while the two values coincide.
  it("keeps a session pin selectable and clearable when the agent default becomes the pinned model", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.4",
      modelProvider: "openai",
      modelOverrideSource: "user",
      models: createOpenAiModelCatalog(),
    });
    const onModelSelect = vi.fn(async () => true);
    // The agent default moves onto the very model this session pinned.
    state.sessionsResult = {
      ...expectDefined(state.sessionsResult, "sessions result"),
      defaults: {
        ...expectDefined(state.sessionsResult, "sessions result").defaults,
        model: "gpt-5.4",
        modelProvider: "openai",
      },
    };
    const container = renderModelControls(state, { onModelSelect });
    document.body.append(container);

    expect(container.querySelector("[data-chat-model-reset]")).not.toBeNull();
    const defaultRow = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.4"]',
    );
    expect(defaultRow?.dataset.chatModelDefault).toBe("true");
    // Pre-fix this row was already the selected "inherited" sentinel, so the click
    // was swallowed and the stored pin survived forever.
    defaultRow?.click();
    expect(onModelSelect).toHaveBeenCalledWith("", "main");

    // The default moves away again; the untouched pin is still a pin.
    onModelSelect.mockClear();
    state.sessionsResult = {
      ...expectDefined(state.sessionsResult, "sessions result"),
      defaults: {
        ...expectDefined(state.sessionsResult, "sessions result").defaults,
        model: "gpt-5",
        modelProvider: "openai",
      },
    };
    renderModelControls(state, { onModelSelect }, container);
    expect(container.querySelector("[data-chat-model-reset]")).not.toBeNull();
    container.remove();
  });

  it("hides model choices for locked sessions while preserving reasoning and speed", () => {
    const { state } = createReasoningHeaderState({
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    });
    const session = expectDefined(state.sessionsResult?.sessions[0], "selected session");
    session.model = "gpt-5.5";
    session.modelProvider = "openai";
    session.modelSelectionLocked = true;
    session.agentRuntime = { id: "codex", source: "model" };
    const onModelSelect = vi.fn(async () => true);
    const onThinkingSelect = vi.fn(async () => true);
    const onFastModeSelect = vi.fn(async () => true);
    const container = renderModelControls(state, {
      onFastModeSelect,
      onModelSelect,
      onThinkingSelect,
    });

    const modelSelect = getChatModelSelect(container);
    expect(modelSelect.dataset.chatModelLocked).toBe("true");
    expect(modelSelect.getAttribute("aria-disabled")).toBe("false");
    expect(container.querySelector(".chat-controls__locked-model-value")?.textContent).toBe(
      "GPT-5.5",
    );
    expect(container.querySelector(".chat-controls__inline-select-label")?.textContent).toContain(
      "GPT-5.5",
    );
    expect(container.querySelectorAll("[data-chat-model-provider]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
    expect(container.querySelector("[data-chat-model-reset]")).toBeNull();
    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    picker!.open = true;
    picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
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

  describe.each(["codex", "openclaw", "claude-cli", undefined])(
    "locked model labels with runtime %s",
    (runtimeId) => {
      it.each([
        {
          name: "catalog label",
          model: "gpt-5.6-sol",
          catalog: "known",
          loading: false,
          expected: "GPT-5.6 Sol",
        },
        {
          name: "missing catalog entry",
          model: "gpt-5.6-sol",
          catalog: "other",
          loading: false,
          expected: "openai/gpt-5.6-sol",
        },
        {
          name: "empty catalog",
          model: "gpt-5.6-sol",
          catalog: "empty",
          loading: false,
          expected: "openai/gpt-5.6-sol",
        },
        {
          name: "refreshing catalog",
          model: "gpt-5.6-sol",
          catalog: "known",
          loading: true,
          expected: "GPT-5.6 Sol",
        },
        {
          name: "loading catalog without a snapshot",
          model: "gpt-5.6-sol",
          catalog: "empty",
          loading: true,
          expected: "openai/gpt-5.6-sol",
        },
        {
          name: "no current model despite an unrelated default",
          model: null,
          catalog: "other",
          loading: false,
          expected: "Session model",
        },
      ])("preserves the $name", ({ model, catalog, loading, expected }) => {
        const { state } = createChatHeaderState({
          model,
          modelProvider: model ? "openai" : null,
          models:
            catalog === "empty"
              ? []
              : [
                  {
                    id: catalog === "known" ? "gpt-5.6-sol" : "gpt-5.6-luna",
                    name: catalog === "known" ? "GPT-5.6 Sol" : "GPT-5.6 Luna",
                    provider: "openai",
                  },
                ],
        });
        const session = expectDefined(state.sessionsResult?.sessions[0], "selected session");
        session.modelSelectionLocked = true;
        session.agentRuntime = runtimeId ? { id: runtimeId, source: "model" } : undefined;
        const container = renderModelControls(state, {
          agentDefaultModel: "openai/gpt-5.6-luna",
          modelCatalogState: {
            hasSnapshot: catalog !== "empty" || !loading,
            status: loading ? "loading" : "ready",
          },
        });

        expect(container.querySelector(".chat-controls__locked-model-value")?.textContent).toBe(
          expected,
        );
        const trigger = getChatModelSelect(container);
        expect(
          trigger.querySelector(".chat-controls__inline-select-label")?.textContent?.trim(),
        ).toBe(expected);
        expect(trigger.getAttribute("aria-label")).toBe(`Chat model: ${expected}`);
        expect(trigger.title).toBe(expected);
        expect(trigger.dataset.chatModelLocked).toBe("true");
        expect(
          container.querySelector(".chat-controls__locked-model-badge")?.textContent?.trim(),
        ).toBe("Locked");
      });
    },
  );

  it("does not patch the model for a locked session", async () => {
    const { state, request } = createOpenAiHeaderState();
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
    const { state } = createOpenAiHeaderState();
    state.chatRunId = "run-123";
    state.chatStream = "Working";
    const onModelSelect = vi.fn(async () => true);
    const container = renderModelControls(state, { onModelSelect });
    const modelOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).find((button) => button.getAttribute("aria-selected") === "false");
    expect(modelOption?.disabled).toBe(true);
    modelOption?.click();

    expect(onModelSelect).not.toHaveBeenCalled();
  });

  it("groups models and filters them with keyboard selection", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const onModelSetup = vi.fn();
    const container = renderModelControls(state, {
      onModelSelect,
      onModelSetup,
    });
    document.body.append(container);

    const providerHeadings = Array.from(
      container.querySelectorAll<HTMLElement>("[data-chat-model-provider]"),
    );
    expect(
      providerHeadings.map((heading) =>
        heading.querySelector(".chat-controls__provider-label")?.textContent?.trim(),
      ),
    ).toEqual(["OpenAI", "Anthropic", "Google"]);
    const providerSettings = providerHeadings[0]?.querySelector<HTMLButtonElement>(
      "[data-chat-model-provider-settings]",
    );
    expect(providerSettings?.getAttribute("aria-label")).toBe("Configure models");
    expect(providerSettings?.closest("openclaw-tooltip")).toBeNull();
    expect(providerSettings?.closest('[role="listbox"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).every(
        (option) => option.closest('[role="listbox"]') !== null,
      ),
    ).toBe(true);
    providerSettings?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
    const anthropicModels = container.querySelector<HTMLElement>(
      '[data-chat-model-provider-group="anthropic"]',
    );
    expect(anthropicModels?.textContent).toContain("Claude Sonnet 4.6");
    const details = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
    details!.open = true;
    expect(container.querySelector("[data-chat-model-selection-target]")).toBeNull();
    search!.value = "anth";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));

    const visibleOptions = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).filter((option) => !option.hidden);
    expect(visibleOptions.map((option) => option.dataset.chatModelOption)).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(visibleOptions[0]?.hasAttribute("data-chat-model-highlighted")).toBe(true);
    expect(
      visibleOptions[0]
        ?.querySelector("[data-chat-model-shortcut]")
        ?.getAttribute("data-chat-model-shortcut-number"),
    ).toBe("1");
    expect(
      visibleOptions[0]?.querySelector(".chat-controls__model-option-provider"),
    ).not.toBeNull();

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const highlighted = container.querySelector<HTMLButtonElement>("[data-chat-model-highlighted]");
    expect(highlighted?.id).not.toBe("");
    expect(search?.getAttribute("aria-activedescendant")).toBe(highlighted?.id);

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6", "main");
    expect(details?.open).toBe(false);
    container.remove();
  });

  it("matches the default model by its localized marker", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    });
    state.sessionsResult = createSessionsListResult({
      model: "gpt-5.5",
      modelProvider: "openai",
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
    });
    const container = renderModelControls(state);
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");

    search!.value = "default";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));

    const visibleOptions = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).filter((option) => !option.hidden);
    expect(visibleOptions).toHaveLength(1);
    expect(visibleOptions[0]?.dataset.chatModelDefault).toBe("true");
  });

  it("leaves digit keys to nested controls and selects the numbered row from the picker", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const container = renderModelControls(state, {
      onModelSelect,
    });
    document.body.append(container);

    const details = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
    details!.open = true;
    search!.value = "claude";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).not.toHaveBeenCalled();
    expect(search!.value).toBe("claude");

    const nestedPicker = document.createElement("wa-dropdown");
    const nestedTrigger = document.createElement("button");
    nestedPicker.append(nestedTrigger);
    details!.append(nestedPicker);
    nestedTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).not.toHaveBeenCalled();

    details!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6", "main");
    container.remove();
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
    const container = renderModelControls(state);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    expect(
      providerButtons.map((button) =>
        button.querySelector(".chat-controls__provider-label")?.textContent?.trim(),
      ),
    ).toEqual(["OpenAI"]);
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
        { id: "kimi-k3", name: "Kimi K3", provider: "moonshot" },
        { id: "kimi-k2.7", name: "Kimi K2.7", provider: "moonshot-ai" },
        { id: "kimi-k2.6", name: "Kimi K2.6", provider: "moonshotai" },
      ],
    });
    const container = renderModelControls(state);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    const providerLabels = providerButtons.map((button) =>
      button.querySelector(".chat-controls__provider-label")?.textContent?.trim(),
    );
    expect(providerLabels).toEqual(["Google", "OpenCode", "Moonshot AI"]);
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
    const moonshotModels = container.querySelector(
      '[data-chat-model-provider-group="moonshot"]',
    )?.textContent;
    expect(moonshotModels).toContain("Kimi K3");
    expect(moonshotModels).toContain("Kimi K2.7");
    expect(moonshotModels).toContain("Kimi K2.6");
    expect(container.querySelector('[data-chat-model-provider-group="moonshot-ai"]')).toBeNull();
    expect(container.querySelector('[data-chat-model-provider-group="moonshotai"]')).toBeNull();
  });

  it("removes a provider suffix already represented by the model group", () => {
    const { state } = createChatHeaderState({
      model: "kimi-k2.5",
      modelProvider: "nvidia",
      models: [{ id: "kimi-k2.5", name: "Kimi K2.5 (NVIDIA)", provider: "nvidia" }],
    });
    const container = renderModelControls(state);

    expect(container.querySelector(".chat-controls__model-option-name")?.textContent).toBe(
      "Kimi K2.5",
    );
  });

  it("keeps active context in picker details without crowding the compact trigger", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          contextWindow: 1_050_000,
          agentRuntime: { id: "openclaw", source: "model" },
        },
      ],
    });
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        agentRuntime: { id: "openclaw", source: "model" },
        contextTokens: 1_000_000,
      },
    ]);
    const container = renderModelControls(state);
    const modelOption = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.6-sol"]',
    );

    expect(modelOption?.querySelector(".chat-controls__model-option-meta")?.textContent).toBe(
      "1M active · 1M max · OpenClaw",
    );
    expect(modelOption?.textContent).not.toContain("700k");
    expect(getChatModelSelect(container).querySelector(".chat-controls__trigger-meta")).toBeNull();
    expect(modelOption?.closest("openclaw-tooltip")).toBeNull();
  });

  it("uses the default selection runtime for an implicit Codex model", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          contextWindow: 1_050_000,
        },
      ],
    });
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        agentRuntime: { id: "codex", source: "implicit" },
        contextTokens: 1_000_000,
      },
    ]);
    state.sessionsResult.defaults = {
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      contextTokens: 1_000_000,
      agentRuntime: { id: "codex", source: "implicit" },
    };

    const container = renderModelControls(state);
    const modelOption = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.6-sol"]',
    );

    expect(modelOption?.querySelector(".chat-controls__model-option-meta")?.textContent).toBe(
      "1M active · 1M max",
    );
    expect(modelOption?.textContent).not.toContain("700k");
  });

  it("rejects stale active context after an implicit default runtime change", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          contextWindow: 1_050_000,
        },
      ],
    });
    state.sessionsResult = createSessionsResultFromRows([
      {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        agentRuntime: { id: "openclaw", source: "session" },
        contextTokens: 272_000,
      },
    ]);
    state.sessionsResult.defaults = {
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      contextTokens: 1_000_000,
      agentRuntime: { id: "codex", source: "implicit" },
    };

    const container = renderModelControls(state);
    const modelOption = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.6-sol"]',
    );

    expect(modelOption?.querySelector(".chat-controls__model-option-meta")?.textContent).toBe("1M");
    expect(modelOption?.textContent).not.toContain("272k active");
  });

  it.each([
    {
      name: "a pending same-model switch",
      modelSwitching: true,
      sessionRuntimeId: "codex",
      optionRuntimeId: "codex",
    },
    {
      name: "a different session runtime",
      modelSwitching: false,
      sessionRuntimeId: "openclaw",
      optionRuntimeId: "codex",
    },
    {
      name: "missing session runtime provenance",
      modelSwitching: false,
      sessionRuntimeId: undefined,
      optionRuntimeId: "codex",
    },
    {
      name: "missing catalog runtime provenance",
      modelSwitching: false,
      sessionRuntimeId: "codex",
      optionRuntimeId: undefined,
    },
  ])(
    "does not pair a stale session budget with $name",
    ({ modelSwitching, optionRuntimeId, sessionRuntimeId }) => {
      const { state } = createChatHeaderState({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai",
            contextWindow: 1_050_000,
            ...(optionRuntimeId
              ? { agentRuntime: { id: optionRuntimeId, source: "model" as const } }
              : {}),
          },
        ],
      });
      state.sessionsResult = createSessionsResultFromRows([
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          ...(sessionRuntimeId
            ? { agentRuntime: { id: sessionRuntimeId, source: "session" as const } }
            : {}),
          contextTokens: 272_000,
        },
      ]);

      const container = renderModelControls(state, {
        modelOverrides: { main: "openai/gpt-5.6-sol" },
        modelSwitching,
      });
      const selectedModelOption = container.querySelector<HTMLButtonElement>(
        '[data-chat-model-option="openai/gpt-5.6-sol"]',
      );

      expect(
        selectedModelOption?.querySelector(".chat-controls__model-option-meta")?.textContent,
      ).toBe(optionRuntimeId ? "1M · Codex" : "1M");
    },
  );

  it("synthesizes a selectable row for a persisted override missing from the catalog", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.2-retired",
      modelProvider: "openai",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" }],
    });
    const container = renderModelControls(state);

    const optionValues = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).map((option) => option.getAttribute("data-chat-model-option"));
    const overrideValue = optionValues.find((value) => value?.includes("gpt-5.2-retired"));
    expect(overrideValue).toBeDefined();
    const overrideOption = container.querySelector<HTMLButtonElement>(
      `[data-chat-model-option="${overrideValue}"]`,
    );
    expect(overrideOption?.querySelector(".chat-controls__inline-select-check")).not.toBeNull();
  });

  it("distinguishes model rows that use different agent runtimes", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6",
          name: "GPT-5.6",
          provider: "openai",
          contextWindow: 1_000_000,
          agentRuntime: { id: "openclaw", source: "model" },
        },
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          contextWindow: 1_000_000,
          agentRuntime: { id: "codex", source: "model" },
        },
        {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          provider: "anthropic",
          contextWindow: 200_000,
          agentRuntime: { id: "claude-cli", source: "model" },
        },
        {
          id: "gemini-3-pro",
          name: "Gemini 3 Pro",
          provider: "google",
          contextWindow: 1_000_000,
          agentRuntime: { id: "google-gemini-cli", source: "model" },
        },
        {
          id: "gpt-5.6-terra",
          name: "GPT-5.6 Terra",
          provider: "openai",
          contextWindow: 1_000_000,
          agentRuntime: { id: "openclaw", source: "implicit" },
        },
      ],
    });
    const container = renderModelControls(state);
    const metaFor = (value: string) =>
      container.querySelector(
        `[data-chat-model-option="${value}"] .chat-controls__model-option-meta`,
      )?.textContent;

    expect(metaFor("openai/gpt-5.6")).toBe("1M · OpenClaw");
    expect(metaFor("openai/gpt-5.6")).not.toContain("Codex");
    expect(metaFor("openai/gpt-5.6-sol")).toBe("1M · Codex");
    // Known CLI runtime ids map to their product labels, not capitalized ids.
    expect(metaFor("anthropic/claude-opus-4-5")).toBe("200k · Claude CLI");
    expect(metaFor("google/gemini-3-pro")).toBe("1M · Gemini CLI");
    // Implicitly resolved runtimes stay unlabeled; only operator-pinned
    // (source model/provider) rows carry the runtime meta.
    expect(metaFor("openai/gpt-5.6-terra")).toBe("1M");
  });

  it("marks chat-only models in the active control and picker", () => {
    const { state } = createChatHeaderState({
      model: "qwen3-8b",
      modelProvider: "lmstudio",
      models: [
        {
          id: "qwen3-8b",
          name: "Qwen3 8B",
          provider: "lmstudio",
          contextWindow: 32_768,
          supportsTools: false,
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          supportsTools: true,
        },
      ],
    });
    const container = renderModelControls(state);
    const trigger = getChatModelSelect(container);

    expect(trigger.dataset.chatModelTools).toBe("unavailable");
    expect(
      trigger.querySelector(".chat-controls__model-capability-badge")?.textContent?.trim(),
    ).toBe("Chat only");
    expect(trigger.querySelector(".chat-controls__model-capability-alert")).toBeNull();
    expect(trigger.getAttribute("aria-label")).toContain("Chat only");
    expect(
      container
        .querySelector('[data-chat-model-option="lmstudio/qwen3-8b"]')
        ?.querySelector(".chat-controls__model-option-meta")
        ?.textContent?.trim(),
    ).toBe("32.8k");
    expect(
      container.querySelector(
        '[data-chat-model-option="lmstudio/qwen3-8b"] .chat-controls__model-chat-only-info svg',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-chat-model-option="openai/gpt-5.5"]')?.textContent,
    ).not.toContain("Chat only");
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
    const container = renderModelControls(state);

    expect(
      getChatModelSelect(container)
        .querySelector(".chat-controls__inline-select-label")
        ?.textContent?.trim(),
    ).toBe("GPT-5.5");
    expect(
      getThinkingSelect(container)
        .querySelector(".chat-controls__inline-select-label")
        ?.textContent?.trim(),
    ).toBe("High");
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
    renderModelControls(state, { modelOverrides: { main: null } }, container);

    expect(
      getChatModelSelect(container)
        .querySelector(".chat-controls__inline-select-label")
        ?.textContent?.trim(),
    ).toBe("GPT-5.5");
    const defaultOptions = container.querySelectorAll<HTMLButtonElement>(
      '[data-chat-model-default="true"]',
    );
    expect(defaultOptions).toHaveLength(1);
    const defaultOption = defaultOptions[0];
    expect(defaultOption?.dataset.chatModelOption).toBe("openai/gpt-5.5");
    expect(defaultOption?.getAttribute("aria-selected")).toBe("true");
    expect(defaultOption?.textContent).toContain("GPT-5.5");
    expect(defaultOption?.textContent).toContain("Default");
    expect(defaultOption?.querySelector(".chat-controls__inline-select-check")).not.toBeNull();
    expect(container.querySelector('[data-chat-model-option=""]')).toBeNull();
  });

  it.each([
    {
      name: "clears a different model override from the actual default model row",
      model: "gpt-5.4",
      models: createOpenAiModelCatalog(),
      sessionKey: "default-clear",
      selected: "false",
    },
    {
      name: "clears an explicit override that matches the default model",
      model: "gpt-5.5",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      sessionKey: "explicit-default",
      selected: "true",
    },
  ])("$name", async ({ model, models, sessionKey, selected }) => {
    const { state } = createChatHeaderState({ model, modelProvider: "openai", models });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
      model,
      modelProvider: "openai",
    });
    const onModelSelect = vi.fn(async () => true);
    const container = renderModelControls(state, {
      sessionKey,
      modelOverrides: { [sessionKey]: `openai/${model}` },
      onModelSelect,
    });

    const defaultOption = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.5"][data-chat-model-default="true"]',
    );
    expect(defaultOption).toBeInstanceOf(HTMLButtonElement);
    expect(defaultOption?.getAttribute("aria-selected")).toBe(selected);
    expect(defaultOption?.textContent).toContain("Default");
    const currentOption = container.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    expect(currentOption?.querySelector(".chat-controls__inline-select-check")).not.toBeNull();
    defaultOption?.click();

    await waitForFast(() => {
      expect(onModelSelect).toHaveBeenCalledWith("", sessionKey);
    });
  });

  it("uses the session provider for slash-containing raw model ids", () => {
    const { state } = createChatHeaderState();
    state.chatModelCatalog = [
      {
        id: "google/gemma-4-26b-a4b-it",
        name: "Gemma 4",
        provider: "google",
        agentRuntime: { id: "openclaw", source: "implicit" },
      },
      {
        id: "google/gemma-4-26b-a4b-it",
        name: "Gemma 4",
        provider: "openrouter",
        contextWindow: 1_000_000,
        agentRuntime: { id: "openclaw", source: "implicit" },
      },
    ];
    state.sessionsResult = createSessionsListResult({
      model: "google/gemma-4-26b-a4b-it",
      modelProvider: "openrouter",
      defaultsModel: "google/gemma-4-26b-a4b-it",
      defaultsProvider: "openrouter",
    });
    state.sessionsResult.sessions[0]!.agentRuntime = {
      id: "openclaw",
      source: "implicit",
    };
    state.sessionsResult.sessions[0]!.contextTokens = 272_000;
    const container = renderModelControls(state);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    expect(
      providerButtons.map((button) =>
        button.querySelector(".chat-controls__provider-label")?.textContent?.trim(),
      ),
    ).toEqual(["OpenRouter", "Google"]);
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="google"]')
        ?.textContent,
    ).toContain("Gemma 4");
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="openrouter"]')
        ?.textContent,
    ).toContain("272k active · 1M max");
  });

  it("uses selected global session model and speed instead of agent defaults", () => {
    const { state } = createChatHeaderState({
      model: "gpt-default",
      modelProvider: "openai",
      models: [
        { id: "gpt-default", name: "Default GPT", provider: "openai" },
        { id: "gpt-session", name: "Session GPT", provider: "openai" },
      ],
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-default",
      defaultsProvider: "openai",
      model: "gpt-session",
      modelProvider: "openai",
      modelOverrideSource: "user",
    });
    const selectedSession = expectDefined(state.sessionsResult.sessions[0], "selected session");
    selectedSession.key = "global";
    selectedSession.kind = "global";
    selectedSession.fastMode = true;
    selectedSession.effectiveFastMode = true;

    const container = renderModelControls(state, {
      agentDefaultModel: "openai/gpt-default",
      sessionKey: "agent:work:main",
      selectedSession,
    });

    expect(getChatModelSelect(container).dataset.chatSelectValue).toBe("openai/gpt-session");
    expect(
      container
        .querySelector('[data-chat-thinking-select="true"]')
        ?.getAttribute("data-chat-fast-mode"),
    ).toBe("true");
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
    const container = renderModelControls(state, {
      modelOverrides: { main: "moonshotai/kimi-k2.5" },
    });

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
    const { state } = createReasoningHeaderState({
      levels: [
        { id: "adaptive", label: "adaptive" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ],
    });
    const container = renderModelControls(state);

    const slider = getThinkingSlider(container);
    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");

    expect(getThinkingSliderValues(container)).toEqual(["adaptive", "low", "medium", "high"]);
    expect(slider?.value).toBe("3");
    expect(slider?.getAttribute("aria-valuetext")).toBe("Default (High)");
    const effortValue = container.querySelector<HTMLElement>(".chat-controls__effort-value");
    expect(effortValue).toBeInstanceOf(HTMLElement);
    expect(effortValue?.classList.contains("sr-only")).toBe(false);
    expect(getThinkingReasoningValueLabel(container)).toBe("High");
    expect(container.querySelector(".chat-controls__fast-mode-title")?.textContent?.trim()).toBe(
      "Fast mode",
    );
    expect(speedToggle?.getAttribute("aria-checked")).toBe("false");
    expect(speedToggle?.dataset.chatSpeedToggle).toBe("on");
    expect(
      container.querySelector('[data-chat-model-select="true"] .chat-controls__provider-icon'),
    ).toBeNull();
    expect(
      container.querySelector("[data-chat-model-option] .chat-controls__provider-icon"),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-chat-model-provider="openai"] [data-provider-icon]'),
    ).not.toBeNull();
  });

  it("keeps fast-only controls separately named and out of the model picker", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          reasoning: false,
        },
      ],
    });
    const sessionsResult = expectDefined(state.sessionsResult, "fast-only session");
    const session = expectDefined(sessionsResult.sessions[0], "fast-only session row");
    state.sessionsResult = {
      ...sessionsResult,
      defaults: {
        ...sessionsResult.defaults,
        thinkingLevels: [],
      },
      sessions: [
        {
          ...session,
          thinkingLevels: [],
        },
      ],
    };

    const container = renderModelControls(state);
    const effortTrigger = container.querySelector('[data-chat-thinking-select="true"]');
    const modelTrigger = container.querySelector('[data-chat-model-select="true"]');

    expect(effortTrigger?.getAttribute("aria-label")).toBe("Fast mode: Standard");
    expect(modelTrigger?.getAttribute("aria-label")).not.toContain("Fast mode");
    expect(container.querySelector(".chat-controls__model-menu")?.textContent).not.toMatch(
      /Effort|Fast mode/,
    );
    expect(modelTrigger?.getAttribute("aria-label")).not.toContain("Thinking level");
    expect(getThinkingSlider(container)).toBeNull();
    expect(container.querySelector("[data-chat-speed-toggle]")).not.toBeNull();
  });

  it("applies model, reasoning, and speed for the session that opened the picker", async () => {
    const { state } = createReasoningHeaderState({
      models: createOpenAiModelCatalog(),
    });
    const onModelSelect = vi.fn(async () => true);
    const onThinkingSelect = vi.fn(async () => true);
    const onFastModeSelect = vi.fn(async () => true);
    const container = renderModelControls(state, {
      onFastModeSelect,
      onModelSelect,
      onThinkingSelect,
    });

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
      expect(slider.getAttribute("aria-valuetext")).toBe("Low");
      expect(getThinkingReasoningValueLabel(container)).toBe("Low");
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      expect(getThinkingReasoningValueLabel(container)).toBe("High");

      slider.value = "0";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("pointercancel"));
      expect(slider.value).toBe(String(getThinkingSliderValues(container).indexOf("high")));
      expect(getThinkingReasoningValueLabel(container)).toBe("High");
    }
    expect(onThinkingSelect).toHaveBeenCalledWith("low", "main");

    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    await waitForFast(() => expect(speedToggle?.disabled).toBe(false));
    speedToggle?.click();
    expect(onFastModeSelect).toHaveBeenCalledWith("on", "main");
  });

  it("locks reasoning and speed while a model switch is pending", () => {
    const { state } = createReasoningHeaderState({
      models: createOpenAiModelCatalog(),
    });
    const container = renderModelControls(state, { modelSwitching: true });

    // The session row still describes the previous model while the switch is
    // pending, so committing reasoning/speed then would target stale levels.
    expect(getThinkingSlider(container)?.disabled).toBe(true);
    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    expect(speedToggle?.disabled).toBe(true);
  });

  it("orders model-dependent patches after a pending model switch", async () => {
    const modelPatch = createDeferred<unknown>();
    const thinkingUpdate = createDeferred<unknown>();
    const patches: Array<Record<string, unknown>> = [];
    const patchResult = {
      ok: true,
      path: "",
      key: "main",
      entry: { sessionId: "main" },
    };
    const sessions = {
      state: { modelOverrides: {} },
      patch: vi.fn(
        async (_key: string, patch: Record<string, unknown>, options?: SessionPatchOptions) => {
          if (options?.waitFor) {
            await options.waitFor;
          }
          patches.push(patch);
          if (Object.hasOwn(patch, "model")) {
            return modelPatch.promise;
          }
          if (Object.hasOwn(patch, "thinkingLevel")) {
            return thinkingUpdate.promise;
          }
          return patchResult;
        },
      ),
      refresh: async () => {},
      patchRowLocal: vi.fn(),
    };
    const host = {
      client: {},
      connected: true,
      sessionKey: "main",
      chatModelCatalog: [],
      chatModelSwitchPromises: {},
      chatThinkingLevel: "high",
      sessions,
      sessionsResult: createSessionsResultFromRows([
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          model: "claude-fable-5",
          modelProvider: "anthropic",
          thinkingLevel: "high",
          fastMode: false,
          effectiveFastMode: false,
        },
      ]),
    } as unknown as Parameters<typeof switchChatModel>[0];

    const modelSwitch = switchChatModel(host, "openai/gpt-5.6-sol");
    const thinkingPatch = switchChatThinkingLevel(host, "ultra");
    const fastModePatch = switchChatFastMode(host, "on");
    const laterModelSwitch = switchChatModel(host, "google/gemini-3-pro");

    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }]);
    modelPatch.resolve(patchResult);
    await expect(modelSwitch).resolves.toBe(true);
    await waitForFast(() => expect(patches).toHaveLength(2));
    expect(patches.at(-1)).toEqual({ thinkingLevel: "ultra" });
    thinkingUpdate.resolve(patchResult);
    await expect(thinkingPatch).resolves.toBe(true);
    await waitForFast(() => expect(patches).toHaveLength(4));
    await expect(Promise.all([fastModePatch, laterModelSwitch])).resolves.toEqual([true, true]);
    expect(patches.at(-1)).toEqual({ model: "google/gemini-3-pro" });
    expect(patches).toEqual([
      { model: "openai/gpt-5.6-sol" },
      { thinkingLevel: "ultra" },
      { fastMode: true },
      { model: "google/gemini-3-pro" },
    ]);
  });

  it("keeps reconciliation inside the session settings lane", async () => {
    const reconciliationStarted = createDeferred();
    const releaseReconciliation = createDeferred();
    const patches: Array<Record<string, unknown>> = [];
    const patchResult = {
      ok: true,
      path: "",
      key: "main",
      entry: { sessionId: "main" },
    };
    const sessions = {
      state: { modelOverrides: {} },
      patch: vi.fn(
        async (_key: string, patch: Record<string, unknown>, options?: SessionPatchOptions) => {
          if (options?.waitFor) {
            await options.waitFor;
          }
          patches.push(patch);
          return patchResult;
        },
      ),
      // The list refresh is the reconcile step switchChatModel awaits; holding
      // it open models a slow reconciliation inside the settings lane.
      refresh: async () => {
        reconciliationStarted.resolve();
        await releaseReconciliation.promise;
      },
      patchRowLocal: vi.fn(),
    };
    const host = {
      client: {},
      connected: true,
      sessionKey: "main",
      chatModelCatalog: [],
      chatModelSwitchPromises: {},
      chatThinkingLevel: "high",
      sessions,
      sessionsResult: createSessionsResultFromRows([
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          model: "claude-fable-5",
          modelProvider: "anthropic",
          thinkingLevel: "high",
        },
      ]),
    } as unknown as Parameters<typeof switchChatModel>[0];

    const modelSwitch = switchChatModel(host, "openai/gpt-5.6-sol");
    await reconciliationStarted.promise;
    const thinkingPatch = switchChatThinkingLevel(host, "ultra");
    await Promise.resolve();
    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }]);

    releaseReconciliation.resolve();
    await expect(Promise.all([modelSwitch, thinkingPatch])).resolves.toEqual([true, true]);
    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }, { thinkingLevel: "ultra" }]);
  });

  it("validates queued settings independently after a model switch fails", async () => {
    const modelPatch = createDeferred<unknown>();
    const patches: Array<Record<string, unknown>> = [];
    const sessions = {
      state: { modelOverrides: {} },
      patch: vi.fn(
        async (_key: string, patch: Record<string, unknown>, options?: SessionPatchOptions) => {
          if (options?.waitFor) {
            await options.waitFor;
          }
          patches.push(patch);
          return modelPatch.promise;
        },
      ),
      refresh: async () => {},
      patchRowLocal: vi.fn(),
    };
    const host = {
      client: {},
      connected: true,
      sessionKey: "main",
      chatModelCatalog: [],
      chatModelSwitchPromises: {},
      chatThinkingLevel: "high",
      sessions,
      sessionsResult: createSessionsResultFromRows([
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          model: "claude-fable-5",
          modelProvider: "anthropic",
          thinkingLevel: "high",
        },
      ]),
    } as unknown as Parameters<typeof switchChatModel>[0];

    const modelSwitch = switchChatModel(host, "openai/gpt-5.6-sol");
    const thinkingPatch = switchChatThinkingLevel(host, "ultra");
    modelPatch.resolve(null);

    await expect(modelSwitch).resolves.toBe(false);
    await expect(thinkingPatch).resolves.toBe(false);
    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }, { thinkingLevel: "ultra" }]);
    expect(host.chatThinkingLevel).toBe("high");
  });

  it.each([
    { sessionKey: "global", mainKey: "main" },
    { sessionKey: "agent:work:main", mainKey: "main" },
    { sessionKey: "agent:work:home", mainKey: "home" },
  ])(
    "does not report a failed selected-global model switch after the selected agent changes for $sessionKey",
    async ({ sessionKey, mainKey }) => {
      const modelPatch = createDeferred<unknown>();
      const modelOverrides: Record<string, string | null> = {
        [sessionKey]: "openai/gpt-agent-a-old",
      };
      let patchOptions: SessionPatchOptions | undefined;
      const sessions = {
        state: { modelOverrides },
        patch: vi.fn(
          async (_key: string, _patch: Record<string, unknown>, options?: SessionPatchOptions) => {
            patchOptions = options;
            return await modelPatch.promise;
          },
        ),
        refresh: async () => {},
        patchRowLocal: vi.fn(),
      };
      const host = {
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey, scope: "global" },
        client: {},
        connected: true,
        sessionKey,
        chatModelCatalog: [],
        chatModelSwitchPromises: {},
        chatThinkingLevel: null,
        sessions,
        sessionsResult: createSessionsResultFromRows([
          {
            key: sessionKey,
            kind: "direct",
            updatedAt: 1,
            model: "gpt-agent-a-old",
            modelProvider: "openai",
          },
        ]),
      } as unknown as Parameters<typeof switchChatModel>[0];

      const switching = switchChatModel(host, "openai/gpt-agent-a-new");
      await waitForFast(() => expect(patchOptions).toBeDefined());
      expect(patchOptions?.ownsModelOverride?.()).toBe(true);

      host.assistantAgentId = "main";
      modelPatch.reject(new Error("agent A patch failed"));

      await expect(switching).resolves.toBe(false);
      expect(patchOptions?.ownsModelOverride?.()).toBe(false);
      expect(modelOverrides[sessionKey]).toBe("openai/gpt-agent-a-old");
      expect(host.lastError ?? null).toBeNull();
      expect(host.chatError ?? null).toBeNull();
    },
  );

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
        patch: async (
          _key: string,
          _patch: Record<string, unknown>,
          options?: SessionPatchOptions,
        ) => {
          if (options?.waitFor) {
            await options.waitFor;
          }
          return new Promise((resolve, reject) => {
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
          });
        },
        refresh: async () => {},
        patchRowLocal: () => {},
      },
    } as unknown as Parameters<typeof switchChatFastMode>[0];

    const first = switchChatFastMode(host, "on");
    await waitForFast(() => expect(pendingPatches).toHaveLength(1));
    const second = switchChatFastMode(host, "off");

    pendingPatches[0]?.reject(new Error("boom"));
    await expect(first).resolves.toBe(false);
    await waitForFast(() => expect(pendingPatches).toHaveLength(2));
    pendingPatches[1]?.resolve();
    await expect(second).resolves.toBe(true);

    // The newer selection keeps its own validation turn after the older failure.
    const row = host.sessionsResult?.sessions.find((entry) => entry.key === "main");
    expect(row?.fastMode).toBe(false);
  });

  it("renders the committed model selection when a model switch fails", async () => {
    const { state } = createOpenAiHeaderState();
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

    await waitForFast(() => {
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
    const container = renderModelControls(state);

    const speedToggle = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]");
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    expect(speedToggle?.getAttribute("aria-label")).toContain("Default");
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
    const container = renderModelControls(state);

    expect(getThinkingSliderValues(container)).toEqual(["off", "adaptive", "xhigh", "max"]);
    expect(container.querySelector('[data-chat-thinking-option=""]')).toBeNull();
  });

  it("shows a reasoning override without a separate reset action", () => {
    const { state } = createReasoningHeaderState();
    const sessionsResult = expectDefined(state.sessionsResult, "reasoning sessions");
    sessionsResult.sessions[0] = {
      ...sessionsResult.sessions[0]!,
      thinkingLevel: "low",
    };
    const container = renderModelControls(state);

    expect(getThinkingReasoningValueLabel(container)).toBe("Low");
    expect(container.querySelector('[data-chat-thinking-option=""]')).toBeNull();
  });

  it("lets an unanchored slider select its first stop directly", async () => {
    const { state, request } = createChatHeaderState({
      model: "gemma4:hermes-e4b",
      modelProvider: "ollama",
      thinkingDefault: "adaptive",
    });
    const container = renderModelControls(state);

    const thinkingSelect = getThinkingSelect(container);

    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(getThinkingReasoningValueLabel(container)).toBe("Adaptive");
    expect(getThinkingSliderValues(container)).not.toContain("adaptive");
    const slider = getThinkingSlider(container);
    expect(slider?.classList.contains("chat-controls__reasoning-range--unanchored")).toBe(true);
    slider?.click();

    await waitForFast(() => {
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
    const container = renderModelControls(state);

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
    const container = renderModelControls(state);

    expect(getThinkingSlider(container)).toBeNull();
    const only = container.querySelector<HTMLButtonElement>(
      '[data-chat-thinking-option="adaptive"]',
    );
    expect(only).toBeInstanceOf(HTMLButtonElement);
    expect(only?.getAttribute("aria-pressed")).toBe("false");
    only?.click();

    await waitForFast(() => {
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
    const container = renderModelControls(state);

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
    const container = renderModelControls(state);

    expect(container.querySelector('[data-chat-thinking-select="true"]')).toBeNull();
    expect(getThinkingSlider(container)).toBeNull();
    expect(container.querySelector("[data-chat-speed-toggle]")).toBeNull();
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
    const container = renderModelControls(state);

    expect(getThinkingReasoningValueLabel(container)).toBe("Low");
  });

  it("always renders full thinking labels", () => {
    const { state } = createReasoningHeaderState({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
      ],
    });
    const container = renderModelControls(state);

    const thinkingSelect = getThinkingSelect(container);
    const triggerLabel = thinkingSelect.querySelector(".chat-controls__inline-select-label");

    expect(container.querySelector('[data-chat-thinking-select-compact="true"]')).toBeNull();
    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(triggerLabel?.textContent?.trim()).toBe("High");
    expect(getThinkingSliderValues(container)).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(getThinkingSlider(container)?.value).toBe("3");
    expect(getThinkingReasoningValueLabel(container)).toBe("High");
  });

  it("labels chat thinking default from session defaults when the row is absent", () => {
    const { state } = createChatHeaderState({
      defaultsThinkingDefault: "adaptive",
      omitSessionFromList: true,
    });
    const container = renderModelControls(state);

    const thinkingSelect = getThinkingSelect(container);

    expect(getChatThinkingValue(thinkingSelect)).toBe("");
    expect(getThinkingReasoningValueLabel(container)).toBe("Adaptive");
  });
});

describe("right-click Reply", () => {
  const replyTarget = { messageId: "msg-1", text: "quoted", senderLabel: "User" };
  const renderReply = (overrides: Partial<ChatProps> = {}) =>
    renderChatView({ replyTarget, ...overrides });

  function dispatchContextMenu(target: EventTarget): MouseEvent {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  function getContextMenuAction(name: string): HTMLButtonElement {
    const matches = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.chat-reply-context-menu button[role="menuitem"]',
      ),
    ].filter((button) => button.textContent?.trim() === name);
    expect(matches).toHaveLength(1);
    const button = expectDefined(matches[0], `${name} context-menu action`);
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.getAttribute("aria-labelledby")).toBeNull();
    return button;
  }

  function renderChatBubble(
    chatOverrides: Partial<ChatProps> = {},
    bubbleOverrides: Parameters<typeof appendChatBubble>[1] = {},
  ) {
    const container = renderChatView(chatOverrides);
    return { container, ...appendChatBubble(container, bubbleOverrides) };
  }

  it("keeps inline actions in the context menu alongside user rewind and fork", () => {
    const onRewindMessage = vi.fn().mockResolvedValue(true);
    const onForkMessage = vi.fn();
    const onCopy = vi.fn();
    const { bubble, group } = renderChatBubble(
      { onRewindMessage, onForkMessage, onSetReply: vi.fn() },
      {
        entryId: "persisted-user",
        groupClass: "chat-group user",
        messageId: "message-1",
        text: "hello",
      },
    );
    group.dataset.chatRowKey = "group:user:persisted";

    dispatchContextMenu(bubble);

    const labels = [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(["Reply", "Rewind to here", "Fork from here"]);
    getContextMenuAction("Fork from here").click();
    expect(onForkMessage).toHaveBeenCalledWith("persisted-user");

    group.className = "chat-group assistant";
    const siblingActionOwner = document.createElement("div");
    siblingActionOwner.dataset.messageActionsFor = "message-0";
    const copyButton = document.createElement("button");
    copyButton.className = "chat-copy-btn";
    copyButton.addEventListener("click", onCopy);
    const actionOwner = document.createElement("div");
    actionOwner.dataset.messageActionsFor = "message-1";
    actionOwner.append(copyButton);
    group.append(siblingActionOwner, actionOwner);
    dispatchContextMenu(bubble);
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Reply", "Copy as markdown"]);
    expect(
      document.querySelector('.chat-reply-context-menu [aria-label="Reply to message"] svg'),
    ).toBeNull();

    dispatchContextMenu(bubble);
    getContextMenuAction("Copy as markdown").click();
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("offers Reply only for the bubble that owns the frame actions", () => {
    const onSetReply = vi.fn();
    const { bubble, group } = renderChatBubble(
      { onSetReply },
      { messageId: "commentary", text: "Intermediate commentary" },
    );
    const actionOwner = document.createElement("div");
    actionOwner.dataset.messageActionsFor = "terminal";
    group.append(actionOwner);
    group.dataset.chatRowKey = 'agent-run:["run-1","send:send-1"]';

    const event = dispatchContextMenu(bubble);

    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("dismisses an inline confirmation before opening the reply context menu", () => {
    const container = renderChatView({ onSetReply: vi.fn() });
    document.body.appendChild(container);
    const section = container.querySelector<HTMLElement>(".card.chat")!;
    const confirmationOwner = document.createElement("span");
    confirmationOwner.className = "chat-confirm-wrap";
    const confirmationTrigger = document.createElement("button");
    confirmationOwner.appendChild(confirmationTrigger);
    section.appendChild(confirmationOwner);
    window.localStorage.removeItem("openclaw:skip-rewind-confirm");
    chatMessage.openChatRewindConfirmation(confirmationTrigger, vi.fn());
    const confirmation = document.querySelector<HTMLElement>(".chat-confirm-popover");
    const { bubble } = appendChatBubble(container, { text: "open message actions" });

    try {
      expect(confirmation?.isConnected).toBe(true);
      dispatchContextMenu(bubble);

      expect(confirmation?.isConnected).toBe(false);
      expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();
    } finally {
      chatMessage.dismissConfirmedActionPopovers(confirmationOwner);
      confirmationOwner.remove();
      container.remove();
    }
  });

  it("disables rewind and fork context actions during an active run", () => {
    const { bubble } = renderChatBubble(
      { canAbort: true, onRewindMessage: vi.fn(), onForkMessage: vi.fn() },
      { entryId: "persisted-user", groupClass: "chat-group user" },
    );

    dispatchContextMenu(bubble);

    expect(getContextMenuAction("Rewind to here").disabled).toBe(true);
    expect(getContextMenuAction("Fork from here").disabled).toBe(true);
    expect(getContextMenuAction("Rewind to here").closest("openclaw-tooltip")?.content).toBe(
      "Rewind is unavailable while the agent is working",
    );
  });

  it("opens context menu and calls onSetReply when Reply is selected", () => {
    const onSetReply = vi.fn();
    const { bubble } = renderChatBubble(
      { onSetReply },
      {
        messageId: "msg-stable-1",
        senderLabel: "User",
        text: "hello world",
      },
    );

    dispatchContextMenu(bubble);

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
    const { bubble } = renderChatBubble({ onSetReply }, { text: "x".repeat(499) + "🧠tail" });

    dispatchContextMenu(bubble);
    document.querySelector<HTMLButtonElement>(".chat-reply-context-menu button")!.click();

    const target = itemAt(
      itemAt(onSetReply.mock.calls, 0, "reply callback call"),
      0,
      "reply target",
    );
    expect(target.text).toBe("x".repeat(499));
  });

  it("keeps the native context menu for links inside a replyable bubble", () => {
    const { bubble } = renderChatBubble({ onSetReply: vi.fn() }, { text: "hello world" });
    const link = document.createElement("a");
    link.href = "https://example.com";
    link.textContent = "Example";
    bubble.appendChild(link);

    const evt = dispatchContextMenu(link);

    expect(evt.defaultPrevented).toBe(false);
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("keeps the native context menu when Reply is unavailable", () => {
    const { bubble } = renderChatBubble({}, { text: "still streaming" });
    bubble.classList.add("streaming");

    const evt = dispatchContextMenu(bubble);

    expect(evt.defaultPrevented).toBe(false);
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("dismisses the reply context menu with Escape after delayed listeners register", () => {
    const onSetReply = vi.fn();
    const flushFrames = stubAnimationFrames();
    const { bubble } = renderChatBubble({ onSetReply }, { text: "hello world" });

    dispatchContextMenu(bubble);
    flushFrames();

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

  it("dismisses a context-menu Rewind confirmation with Escape before closing the menu", () => {
    const flushFrames = stubAnimationFrames();
    const { bubble } = renderChatBubble(
      { paneId: "pane-a", onRewindMessage: vi.fn() },
      { entryId: "persisted-user", groupClass: "chat-group user", text: "hello" },
    );

    dispatchContextMenu(bubble);
    flushFrames();
    const rewindButton = getContextMenuAction("Rewind to here");
    expect(rewindButton).toBeInstanceOf(HTMLButtonElement);
    rewindButton.click();
    flushFrames();

    const cancel = document.querySelector<HTMLButtonElement>(".chat-confirm-popover__cancel");
    expect(cancel).toBeInstanceOf(HTMLButtonElement);
    expect(document.activeElement).toBe(cancel);
    const confirmationEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    cancel!.dispatchEvent(confirmationEscape);

    expect(confirmationEscape.defaultPrevented).toBe(true);
    expect(document.querySelector(".chat-confirm-popover")).toBeNull();
    expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();
    expect(document.activeElement).toBe(rewindButton);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("removes a portaled Rewind confirmation only when its owning pane resets", () => {
    const flushFrames = stubAnimationFrames();
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const onRewindMessage = vi.fn();
    const { bubble } = renderChatBubble(
      { paneId: "pane-a", onRewindMessage },
      { entryId: "persisted-user", groupClass: "chat-group user", text: "hello" },
    );

    dispatchContextMenu(bubble);
    flushFrames();
    getContextMenuAction("Rewind to here").click();
    flushFrames();

    resetThreadPresentation("pane-b");
    expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();
    expect(document.querySelector(".chat-confirm-popover")).not.toBeNull();

    resetThreadPresentation("pane-a");

    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
    expect(document.querySelector(".chat-confirm-popover")).toBeNull();
    expect(onRewindMessage).not.toHaveBeenCalled();
    expect(removeDocumentListener).toHaveBeenCalledWith("click", expect.any(Function), true);
    expect(removeWindowListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
  });

  it("dismisses the reply context menu before a later context menu opens", () => {
    const flushFrames = stubAnimationFrames();
    const { bubble } = renderChatBubble({ onSetReply: vi.fn() }, { text: "hello world" });
    dispatchContextMenu(bubble);
    flushFrames();
    expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();

    dispatchContextMenu(document.body);

    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("renders reply preview bar with quote text and dismiss button", () => {
    const container = renderReply({ replyTarget: { ...replyTarget, text: "quoted message" } });

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
    const container = renderReply({ onClearReply });

    container.querySelector<HTMLButtonElement>(".chat-reply-preview__dismiss")!.click();
    expect(onClearReply).toHaveBeenCalledTimes(1);
  });

  it("clears reply target on Escape when no other handler intercepted", () => {
    const onClearReply = vi.fn();
    const container = renderReply({ onClearReply });

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
    const container = renderReply({ onClearReply });

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
    const { bubble } = renderChatBubble({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    });

    // Without onSetReply, the handler returns early and no menu is created
    dispatchContextMenu(bubble);
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("adds Copy for an intersecting selection without changing the unselected menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderChatView({ onSetReply: vi.fn() });
    const section = container.querySelector<HTMLElement>(".card.chat");
    expect(section).not.toBeNull();

    const { bubble, group } = appendChatBubble(container, {
      messageId: "msg-1",
      text: "selectable text",
    });
    bubble.textContent = "selectable text";
    const otherBubble = document.createElement("div");
    otherBubble.className = "chat-bubble";
    otherBubble.dataset.messageText = "other text";
    otherBubble.textContent = "other text";
    group.append(otherBubble);

    const bubbleText = expectDefined(bubble.firstChild, "bubble text node");
    const otherText = expectDefined(otherBubble.firstChild, "other bubble text node");
    let selectedRange = document.createRange();
    selectedRange.setStart(bubbleText, 0);
    selectedRange.setEnd(otherText, otherText.textContent?.length ?? 0);
    const mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => selectedRange,
      toString: () => "selectable",
    } as unknown as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(mockSelection);

    const selectedEvent = dispatchContextMenu(bubble);

    expect(selectedEvent.defaultPrevented).toBe(true);
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Copy", "Reply"]);
    getContextMenuAction("Copy").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("selectable"));

    selectedRange = document.createRange();
    selectedRange.selectNodeContents(otherBubble);
    const disjointEvent = dispatchContextMenu(bubble);

    expect(disjointEvent.defaultPrevented).toBe(true);
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Reply"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
