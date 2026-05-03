/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { ChatQueueItem } from "../ui-types.ts";
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
          const matchingProviders = catalog
            .filter((entry) => entry.id === normalized)
            .map((entry) => entry.provider)
            .filter(Boolean);
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
      canvasHostUrl: null,
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

    expect(container.textContent).toContain("Compacted history");
    expect(container.textContent).toContain("Earlier turns are preserved");
    const button = container.querySelector<HTMLButtonElement>(".chat-divider__action");
    expect(button?.textContent).toContain("Open checkpoints");

    button?.click();

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

    expect(container.querySelector(".chat-loading-skeleton")).not.toBeNull();
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
    expect(container.textContent).toContain("Already loaded answer");
  });

  it("keeps active stream content visible without the skeleton during a background reload", () => {
    const container = renderChatView({
      loading: true,
      stream: "Partial streamed answer",
      streamStartedAt: 1,
    });

    expect(container.querySelector(".chat-loading-skeleton")).toBeNull();
    expect(container.textContent).toContain("Partial streamed answer");
  });

  it("keeps the reading indicator visible without the skeleton before stream text arrives", () => {
    const container = renderChatView({
      loading: true,
      stream: "",
      streamStartedAt: 1,
    });

    expect(container.querySelector(".chat-loading-skeleton")).toBeNull();
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
  });
});

describe("chat voice controls", () => {
  it("keeps Talk visible without the stale browser dictation button", () => {
    const container = renderChatView();

    expect(container.querySelector('[aria-label="Start Talk"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Voice input"]')).toBeNull();
  });
});

describe("chat slash menu accessibility", () => {
  function inputDraft(container: HTMLElement, value: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    textarea!.value = value;
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function keydownComposer(container: HTMLElement, key: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
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

    expect(nextActiveId).toBeTruthy();
    expect(nextActiveId).not.toBe(initialActiveId);
    expect(activeOption?.getAttribute("aria-selected")).toBe("true");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent?.trim()).toBeTruthy();
    expect(status?.textContent).toContain(activeOption?.textContent?.trim().split(/\s+/u)[0]);
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
    expect(
      container
        .querySelector<HTMLTextAreaElement>("textarea")
        ?.getAttribute("aria-activedescendant"),
    ).toBeTruthy();

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

    expect(input).not.toBeNull();
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [file],
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(onAttachmentsChange).toHaveBeenCalledWith([
        expect.objectContaining({
          fileName: "brief.pdf",
          mimeType: "application/pdf",
          sizeBytes: file.size,
        }),
      ]);
    });

    const nextAttachments = onAttachmentsChange.mock.calls[0]?.[0] ?? [];
    expect(getChatAttachmentDataUrl(nextAttachments[0])).toMatch(/^data:application\/pdf;base64,/);
    const preview = renderChatView({ attachments: nextAttachments });
    expect(preview.querySelector(".chat-attachment-thumb--file")).not.toBeNull();
    expect(preview.textContent).toContain("brief.pdf");
  });

  it("filters video file attachments", () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = container.querySelector<HTMLInputElement>(".agent-chat__file-input");
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });

    expect(input).not.toBeNull();
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [file],
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

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
    expect(avatar).not.toBeNull();
    expect(avatar?.tagName).toBe("DIV");
    expect(avatar?.textContent).toContain("VC");
    expect(avatar?.getAttribute("aria-label")).toBe("Val");

    container = renderWelcome({
      assistantAvatar: "avatars/val.png",
      assistantAvatarUrl: "blob:identity-avatar",
    });

    const imageAvatar = container.querySelector<HTMLImageElement>("img");
    expect(imageAvatar).not.toBeNull();
    expect(imageAvatar?.getAttribute("src")).toBe("blob:identity-avatar");
    expect(imageAvatar?.getAttribute("alt")).toBe("Val");

    container = renderWelcome({ assistantAvatar: null, assistantAvatarUrl: null });

    const fallbackAvatar = container.querySelector<HTMLImageElement>(
      ".agent-chat__avatar--logo img",
    );
    expect(fallbackAvatar).not.toBeNull();
    expect(fallbackAvatar?.getAttribute("src")).toBe("apple-touch-icon.png");
    expect(fallbackAvatar?.getAttribute("alt")).toBe("Val");
  });
});

describe("chat session controls", () => {
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

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("");

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "openai/gpt-5-mini",
    });
    expect(request).not.toHaveBeenCalledWith("chat.history", expect.anything());
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

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("openai/gpt-5-mini");

    modelSelect!.value = "";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));

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

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.disabled).toBe(true);
  });

  it("keeps the selected model visible when the active session is absent from sessions.list", async () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();
    render(renderChatSessionSelect(state), container);

    const rerendered = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(rerendered?.value).toBe("openai/gpt-5-mini");
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
    const options = [...(thinkingSelect?.options ?? [])].map((option) => option.value);

    expect(options).toContain("adaptive");
    expect(options).toContain("xhigh");
    expect(options).toContain("max");
    expect(
      [...(thinkingSelect?.options ?? [])]
        .find((option) => option.value === "max")
        ?.textContent?.trim(),
    ).toBe("maximum");
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
    expect(thinkingSelect?.options[0]?.textContent?.trim()).toBe("Default (adaptive)");
    expect(thinkingSelect?.title).toBe("Default (adaptive)");
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
    expect(thinkingSelect?.options[0]?.textContent?.trim()).toBe("Default (adaptive)");
    expect(thinkingSelect?.title).toBe("Default (adaptive)");
  });
});
