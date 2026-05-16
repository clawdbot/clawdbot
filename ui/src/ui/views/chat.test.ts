/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
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
import type { ModelCatalogEntry } from "../types.ts";
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
  buildChatItems: (props: {
    messages: unknown[];
    stream: string | null;
    streamStartedAt: number | null;
  }) => {
    if (
      props.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { __testDivider?: unknown }).__testDivider === true,
      )
    ) {
      return [
        {
          kind: "divider",
          key: "divider:compaction:test",
          label: "Compacted history",
          description:
            "Earlier turns are preserved in a compaction checkpoint. Open session checkpoints to branch or restore that pre-compaction view.",
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
            },
          ]
        : [{ kind: "reading-indicator", key: "reading:test" }];
    }
    return [];
  },
}));

vi.mock("../chat/grouped-render.ts", () => ({
  renderMessageGroup: (group: { messages: Array<{ message: unknown }> }) => {
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
  onQueueSteer?: (id: string) => void;
}) {
  const container = document.createElement("div");
  render(
    renderChatQueue({
      queue: params.queue,
      canAbort: params.canAbort ?? true,
      onQueueSteer: params.onQueueSteer,
      onQueueRemove: () => undefined,
    }),
    container,
  );
  return container;
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
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
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
      chatFocusMode: false,
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
    loadAssistantIdentity: vi.fn(),
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

function getChatModelSelect(container: Element): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>(
    'select[data-chat-model-select="true"]',
  );
  expect(select).toBeInstanceOf(HTMLSelectElement);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("Expected chat model select");
  }
  return select;
}

function requireElement(container: Element, selector: string, label: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`expected ${label}`);
  }
  return element;
}

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]> = {}) {
  const container = document.createElement("div");
  render(
    renderChat({
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
      focusMode: false,
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
      onToggleFocusMode: () => undefined,
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
    }),
    container,
  );
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
      "Earlier turns are preserved in a compaction checkpoint. Open session checkpoints to branch or restore that pre-compaction view.",
    );
    const button = container.querySelector<HTMLButtonElement>(".chat-divider__action");
    expect(button?.textContent?.trim()).toBe("Open checkpoints");

    expect(button).toBeInstanceOf(HTMLButtonElement);
    button!.click();

    expect(onOpenSessionCheckpoints).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  loadSessionsMock.mockClear();
  refreshVisibleToolsEffectiveForCurrentSessionMock.mockClear();
  resetChatViewState();
  resetChatAttachmentPayloadStoreForTest();
  vi.unstubAllGlobals();
});

describe("chat loading skeleton", () => {
  it("shows the skeleton while the initial history load has no rendered content", () => {
    const container = renderChatView({ loading: true });

    expect(container.querySelectorAll(".chat-loading-skeleton")).toHaveLength(1);
    expect(container.querySelector(".agent-chat__welcome")).toBeNull();
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
});

describe("chat voice controls", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("keeps Talk visible without the stale browser dictation button", () => {
    const container = renderChatView();

    requireElement(container, '[aria-label="Start Talk"]', "Start Talk button");
    requireElement(container, '[aria-label="Talk options"]', "Talk options button");
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
      '.agent-chat__talk-options input[placeholder="gpt-realtime-2"]',
    );
    const voice = container.querySelector<HTMLSelectElement>(
      ".agent-chat__talk-options label:nth-of-type(4) select",
    );
    const voiceOptions = Array.from(
      container.querySelectorAll<HTMLOptionElement>(
        ".agent-chat__talk-options label:nth-of-type(4) option",
      ),
    ).map((option) => option.value);
    const reasoningOptions = Array.from(
      container.querySelectorAll<HTMLOptionElement>(
        ".agent-chat__talk-options label:nth-of-type(5) option",
      ),
    ).map((option) => option.value);

    if (voice === null) {
      throw new Error("expected Talk voice select");
    }
    expect(voiceOptions).toEqual([
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
    expect(reasoningOptions).toEqual(["", "minimal", "low", "medium", "high"]);
    if (model === null) {
      throw new Error("expected Talk model input");
    }
    model.value = "gpt-realtime-mini";
    model.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onRealtimeTalkOptionsChange).toHaveBeenCalledWith({ model: "gpt-realtime-mini" });
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

  it("filters chat sessions by agent and switches to that agent's recent session", () => {
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
      count: 4,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        { key: "agent:alpha:main", kind: "direct", updatedAt: 4 },
        { key: "agent:alpha:dashboard:alpha-recent", kind: "direct", updatedAt: 3 },
        { key: "agent:beta:dashboard:beta-recent", kind: "direct", updatedAt: 2 },
        { key: "agent:beta:main", kind: "direct", updatedAt: 1 },
      ],
    };

    const container = document.createElement("div");
    render(renderChatSessionSelect(state, onSwitchSession), container);

    const agentSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-agent-filter="true"]',
    );
    const sessionSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-session-select="true"]',
    );

    expect(agentSelect?.value).toBe("alpha");
    expect([...sessionSelect!.options].map((option) => option.value)).toEqual([
      "agent:alpha:main",
      "agent:alpha:dashboard:alpha-recent",
    ]);

    agentSelect!.value = "beta";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onSwitchSession).toHaveBeenCalledWith(state, "agent:beta:dashboard:beta-recent");
  });

  it("renders selector labels from the active locale", async () => {
    await i18n.setLocale("zh-CN");
    const { state } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    expect(
      [...container.querySelectorAll("select")].map((select) => select.getAttribute("aria-label")),
    ).toEqual([
      t("chat.selectors.session"),
      t("chat.selectors.model"),
      t("chat.selectors.thinkingLevel"),
    ]);
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

    const sessionSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-session-select="true"]',
    );

    expect(sessionSelect?.value).toBe("agent:main:main");
    expect([...sessionSelect!.options].map((option) => option.value)).toEqual(["agent:main:main"]);
    expect(sessionSelect?.selectedOptions[0]?.textContent?.trim()).toBe("main");
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
    expect(modelSelect.value).toBe("");

    modelSelect.value = "openai/gpt-5-mini";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));

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
    expect(modelSelect.value).toBe("openai/gpt-5-mini");

    modelSelect.value = "";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: null,
    });
    await flushTasks();
    expect(loadSessionsMock).toHaveBeenCalledTimes(1);
    expect(state.sessionsResult?.sessions[0]?.model).toBeUndefined();
  });

  it("disables the chat header model picker while a run is active", () => {
    const { state } = createChatHeaderState();
    state.chatRunId = "run-123";
    state.chatStream = "Working";
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = getChatModelSelect(container);
    expect(modelSelect.disabled).toBe(true);
  });

  it("keeps the selected model visible when the active session is absent from sessions.list", async () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = getChatModelSelect(container);

    modelSelect.value = "openai/gpt-5-mini";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();
    render(renderChatSessionSelect(state), container);

    const rerendered = getChatModelSelect(container);
    expect(rerendered.value).toBe("openai/gpt-5-mini");
  });

  it("uses default thinking options when the active session is absent", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai-codex",
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

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );

    expect([...(thinkingSelect?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      "off",
      "adaptive",
      "xhigh",
      "max",
    ]);
    expect(
      [...(thinkingSelect?.options ?? [])].map((option) => option.textContent?.trim()),
    ).toEqual(["Off", "Off", "Override: adaptive", "Override: xhigh", "Override: maximum"]);
  });

  it("labels chat thinking default from the active session row", () => {
    const { state } = createChatHeaderState({
      model: "gemma4:hermes-e4b",
      modelProvider: "ollama",
      thinkingDefault: "adaptive",
    });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );

    expect(thinkingSelect?.value).toBe("");
    expect(thinkingSelect?.options[0]?.textContent?.trim()).toBe("Inherited: adaptive");
    expect(thinkingSelect?.title).toBe("Inherited: adaptive");
  });

  it("always renders full thinking labels", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai-codex",
      thinkingDefault: "high",
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai-codex",
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

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );

    expect(container.querySelector('select[data-chat-thinking-select-compact="true"]')).toBeNull();
    expect(thinkingSelect?.value).toBe("");
    expect(thinkingSelect?.title).toBe("Inherited: high");
    expect([...thinkingSelect!.options].map((option) => option.textContent?.trim())).toEqual([
      "Inherited: high",
      "Off",
      "Override: low",
      "Override: medium",
      "Override: high",
      "Override: xhigh",
    ]);
  });

  it("labels chat thinking default from session defaults when the row is absent", () => {
    const { state } = createChatHeaderState({
      defaultsThinkingDefault: "adaptive",
      omitSessionFromList: true,
    });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );

    expect(thinkingSelect?.value).toBe("");
    expect(thinkingSelect?.options[0]?.textContent?.trim()).toBe("Inherited: adaptive");
    expect(thinkingSelect?.title).toBe("Inherited: adaptive");
  });
});
