/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderChatSessionSelect } from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../chat-model.test-helpers.ts";
import { resetAssistantAttachmentAvailabilityCacheForTest } from "../chat/grouped-render.ts";
import { normalizeMessage } from "../chat/message-normalizer.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

function createChatHeaderState(
  overrides: {
    model?: string | null;
    modelProvider?: string | null;
    models?: ModelCatalogEntry[];
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

function flushTasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: false,
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
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: createSessions(),
    focusMode: false,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    localMediaPreviewRoots: [],
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onDismissSideResult: () => undefined,
    onNewSession: () => undefined,
    agentsList: null,
    currentAgentId: "",
    onAgentChange: () => undefined,
    ...overrides,
  };
}

function createOverviewProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    warnQueryToken: false,
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      locale: "en",
    },
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
    usageResult: null,
    sessionsResult: null,
    skillsReport: null,
    cronJobs: [],
    cronStatus: null,
    attentionItems: [],
    eventLog: [],
    overviewLogLines: [],
    showGatewayToken: false,
    showGatewayPassword: false,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewayTokenVisibility: () => undefined,
    onToggleGatewayPasswordVisibility: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onNavigate: () => undefined,
    onRefreshLogs: () => undefined,
    ...overrides,
  };
}

describe("chat view", () => {
  it("renders BTW side results outside transcript history", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Saved transcript message" }],
              timestamp: 1,
            },
          ],
          sideResult: {
            kind: "btw",
            runId: "btw-run-1",
            sessionKey: "main",
            question: "what changed?",
            text: "The web UI now renders **BTW** separately.",
            isError: false,
            ts: 2,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-side-result")).not.toBeNull();
    expect(container.textContent).toContain("BTW");
    expect(container.textContent).toContain("what changed?");
    expect(container.textContent).toContain("Not saved to chat history");
    expect(container.textContent).toContain("Saved transcript message");
    expect(container.querySelectorAll(".chat-side-result")).toHaveLength(1);
  });

  it("dismisses BTW side results from the dismiss button", () => {
    const container = document.createElement("div");
    const onDismissSideResult = vi.fn();
    render(
      renderChat(
        createProps({
          sideResult: {
            kind: "btw",
            runId: "btw-run-2",
            sessionKey: "main",
            question: "what changed?",
            text: "Dismiss me",
            isError: false,
            ts: 3,
          },
          onDismissSideResult,
        }),
      ),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>(".chat-side-result__dismiss");
    expect(button).not.toBeNull();
    button?.click();
    expect(onDismissSideResult).toHaveBeenCalledTimes(1);
  });

  it("renders BTW errors with the error variant", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sideResult: {
            kind: "btw",
            runId: "btw-run-3",
            sessionKey: "main",
            question: "what failed?",
            text: "The side question could not be answered.",
            isError: true,
            ts: 4,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-side-result--error")).not.toBeNull();
  });

  it("hides the context notice when only cumulative inputTokens exceed the limit", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 757_300,
                totalTokens: 46_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
    expect(container.textContent).not.toContain("757.3k / 200k");
  });

  it("uses totalTokens for the context notice detail when current usage is high", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 757_300,
                totalTokens: 190_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("95% context used");
    expect(container.textContent).toContain("190k / 200k");
    expect(container.textContent).not.toContain("757.3k / 200k");
  });

  it("hides the context notice when totalTokens is missing even if inputTokens is high", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 500_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
  });

  it("hides the context notice when totalTokens is marked stale", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                totalTokens: 190_000,
                totalTokensFresh: false,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
    expect(container.textContent).not.toContain("190k / 200k");
  });

  it("uses the assistant avatar URL for the welcome state when the identity avatar is only initials", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: "/avatar/main",
        }),
      ),
      container,
    );

    const welcomeImage = container.querySelector<HTMLImageElement>(".agent-chat__welcome > img");
    expect(welcomeImage).not.toBeNull();
    expect(welcomeImage?.getAttribute("src")).toBe("/avatar/main");
  });

  it("falls back to the bundled logo in the welcome state when the assistant avatar is not a URL", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: null,
        }),
      ),
      container,
    );

    const welcomeImage = container.querySelector<HTMLImageElement>(".agent-chat__welcome > img");
    const logoImage = container.querySelector<HTMLImageElement>(
      ".agent-chat__welcome .agent-chat__avatar--logo img",
    );
    expect(welcomeImage).toBeNull();
    expect(logoImage).not.toBeNull();
    expect(logoImage?.getAttribute("src")).toBe("favicon.svg");
  });

  it("keeps the welcome logo fallback under the mounted base path", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: null,
          basePath: "/openclaw/",
        }),
      ),
      container,
    );

    const logoImage = container.querySelector<HTMLImageElement>(
      ".agent-chat__welcome .agent-chat__avatar--logo img",
    );
    expect(logoImage).not.toBeNull();
    expect(logoImage?.getAttribute("src")).toBe("/openclaw/favicon.svg");
  });

  it("keeps grouped assistant avatar fallbacks under the mounted base path", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: null,
          basePath: "/openclaw/",
          messages: [
            {
              role: "assistant",
              content: "hello",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const groupedLogo = container.querySelector<HTMLImageElement>(
      ".chat-group.assistant .chat-avatar--logo",
    );
    expect(groupedLogo).not.toBeNull();
    expect(groupedLogo?.getAttribute("src")).toBe("/openclaw/favicon.svg");
  });

  it("keeps the persisted overview locale selected before i18n hydration finishes", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      settings: {
        ...createOverviewProps().settings,
        locale: "zh-CN",
      },
    });

    getSafeLocalStorage()?.clear();
    await i18n.setLocale("en");

    render(renderOverview(props), container);
    await Promise.resolve();

    let select = container.querySelector<HTMLSelectElement>("select");
    expect(i18n.getLocale()).toBe("en");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (Simplified Chinese)");

    await i18n.setLocale("zh-CN");
    render(renderOverview(props), container);
    await Promise.resolve();

    select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (简体中文)");

    await i18n.setLocale("en");
  });

  it("renders compacting indicator as a badge", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          compactionStatus: {
            phase: "active",
            runId: "run-1",
            startedAt: Date.now(),
            completedAt: null,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--active");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Compacting context...");
  });

  it("renders completion indicator shortly after compaction", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            phase: "complete",
            runId: "run-1",
            startedAt: 900,
            completedAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--complete");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Context compacted");
    nowSpy.mockRestore();
  });

  it("hides stale compaction completion indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            phase: "complete",
            runId: "run-1",
            startedAt: 0,
            completedAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".compaction-indicator")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders fallback indicator shortly after fallback event", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            selected: "fireworks/minimax-m2p5",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: ["fireworks/minimax-m2p5: rate limit"],
            occurredAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--fallback");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");
    nowSpy.mockRestore();
  });

  it("hides stale fallback indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(20_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            selected: "fireworks/minimax-m2p5",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".compaction-indicator--fallback")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders fallback-cleared indicator shortly after transition", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            phase: "cleared",
            selected: "fireworks/minimax-m2p5",
            active: "fireworks/minimax-m2p5",
            previous: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--fallback-cleared");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");
    nowSpy.mockRestore();
  });

  it("shows a stop button when aborting is available", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: true,
          sending: true,
          onAbort,
        }),
      ),
      container,
    );

    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeUndefined();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");
  });

  it("keeps the stop button visible for abortable non-streaming runs", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          canAbort: true,
          sending: false,
          stream: null,
          onAbort: vi.fn(),
        }),
      ),
      container,
    );

    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeNull();
    expect(container.textContent).not.toContain("New session");
  });

  it("shows a new session button when aborting is unavailable", () => {
    const container = document.createElement("div");
    const onNewSession = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: false,
          onNewSession,
        }),
      ),
      container,
    );

    const newSessionButton = container.querySelector<HTMLButtonElement>(
      'button[title="New session"]',
    );
    expect(newSessionButton).not.toBeUndefined();
    newSessionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Stop");
  });

  it("shows sender labels from sanitized gateway messages instead of generic You", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "hello from topic",
              senderLabel: "Iris",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const senderLabels = Array.from(container.querySelectorAll(".chat-sender-name")).map((node) =>
      node.textContent?.trim(),
    );
    expect(senderLabels).toContain("Iris");
    expect(senderLabels).not.toContain("You");
  });

  it("keeps consecutive user messages from different senders in separate groups", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "first",
              senderLabel: "Iris",
              timestamp: 1000,
            },
            {
              role: "user",
              content: "second",
              senderLabel: "Joaquin De Rojas",
              timestamp: 1001,
            },
          ],
        }),
      ),
      container,
    );

    const groups = container.querySelectorAll(".chat-group.user");
    expect(groups).toHaveLength(2);
    const senderLabels = Array.from(container.querySelectorAll(".chat-sender-name")).map((node) =>
      node.textContent?.trim(),
    );
    expect(senderLabels).toContain("Iris");
    expect(senderLabels).toContain("Joaquin De Rojas");
  });

  it("opens delete confirm on the left for user messages", () => {
    try {
      getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
    } catch {
      /* noop */
    }
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "hello from user",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const deleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.user .chat-group-delete",
    );
    expect(deleteButton).not.toBeNull();
    deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const confirm = container.querySelector<HTMLElement>(".chat-group.user .chat-delete-confirm");
    expect(confirm).not.toBeNull();
    expect(confirm?.classList.contains("chat-delete-confirm--left")).toBe(true);
  });

  it("opens delete confirm on the right for assistant messages", () => {
    try {
      getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
    } catch {
      /* noop */
    }
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: "hello from assistant",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const deleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.assistant .chat-group-delete",
    );
    expect(deleteButton).not.toBeNull();
    deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const confirm = container.querySelector<HTMLElement>(
      ".chat-group.assistant .chat-delete-confirm",
    );
    expect(confirm).not.toBeNull();
    expect(confirm?.classList.contains("chat-delete-confirm--right")).toBe(true);
  });

  it("patches the current session model from the chat header picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("");

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "openai/gpt-5-mini",
    });
    expect(request).not.toHaveBeenCalledWith("chat.history", expect.anything());
    expect(state.sessionsResult?.sessions[0]?.model).toBe("gpt-5-mini");
    expect(state.sessionsResult?.sessions[0]?.modelProvider).toBe("openai");
    vi.unstubAllGlobals();
  });

  it("reloads effective tools after a chat-header model switch for the active tools panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
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

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5-mini");
    vi.unstubAllGlobals();
  });

  it("clears the session model override back to the default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
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
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: null,
    });
    expect(state.sessionsResult?.sessions[0]?.model).toBeUndefined();
    vi.unstubAllGlobals();
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
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
    vi.unstubAllGlobals();
  });

  it("normalizes cached bare /model overrides to the matching catalog option", () => {
    const { state } = createChatHeaderState();
    state.chatModelOverrides = { main: { kind: "raw", value: "gpt-5-mini" } };

    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("openai/gpt-5-mini");

    const optionValues = Array.from(modelSelect?.querySelectorAll("option") ?? []).map(
      (option) => option.value,
    );
    expect(optionValues).toContain("openai/gpt-5-mini");
    expect(optionValues).not.toContain("gpt-5-mini");
  });

  it("prefers the catalog provider when the active session reports a stale provider", () => {
    const { state } = createChatHeaderState({
      model: "deepseek-chat",
      modelProvider: "zai",
      models: createModelCatalog(DEEPSEEK_CHAT_MODEL),
    });

    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect?.value).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified session model when catalog lookup fails", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5-mini",
      models: [],
    });

    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect?.value).toBe("openai/gpt-5-mini");

    const optionValues = Array.from(modelSelect?.querySelectorAll("option") ?? []).map(
      (option) => option.value,
    );
    expect(optionValues).toContain("openai/gpt-5-mini");
    expect(optionValues).not.toContain("gpt-5-mini");
  });

  it("prefers the session label over displayName in the grouped chat session selector", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
          displayName: "webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("Subagent: cron-config-check");
    expect(labels).not.toContain(state.sessionKey);
    expect(labels).not.toContain(
      "subagent:4f2146de-887b-4176-9abe-91140082959b · webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
    );
  });

  it("keeps a unique scoped fallback when the current grouped session is missing from sessions.list", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("subagent:4f2146de-887b-4176-9abe-91140082959b");
    expect(labels).not.toContain("Subagent:");
  });

  it("keeps a unique scoped fallback when a grouped session row has no label or displayName", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: null,
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("subagent:4f2146de-887b-4176-9abe-91140082959b");
    expect(labels).not.toContain("Subagent:");
  });

  it("disambiguates duplicate grouped labels with the scoped key suffix", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
        },
        {
          key: "agent:main:subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:4f2146de-887b-4176-9abe-91140082959b",
    );
    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
    );
    expect(labels).not.toContain("Subagent: cron-config-check");
  });

  it("prefixes duplicate agent session labels with the agent name", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:alpha:main";
    state.settings.sessionKey = state.sessionKey;
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
        {
          key: "agent:alpha:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:beta:main",
          kind: "direct",
          updatedAt: null,
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("Deep Chat (alpha) / main");
    expect(labels).toContain("Coding (beta) / main");
    expect(labels).not.toContain("main");
  });

  it("keeps agent-prefixed labels unique when a custom label already matches the prefix", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:alpha:main";
    state.settings.sessionKey = state.sessionKey;
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
        {
          key: "agent:alpha:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:beta:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:alpha:named-main",
          kind: "direct",
          updatedAt: null,
          label: "Deep Chat (alpha) / main",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels.filter((label) => label === "Deep Chat (alpha) / main")).toHaveLength(1);
    expect(labels).toContain("Deep Chat (alpha) / main · named-main");
    expect(labels).toContain("Coding (beta) / main");
  });

  it("keeps tool cards collapsed by default and expands them inline on demand", async () => {
    const container = document.createElement("div");
    const props = createProps({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          toolCallId: "call-1",
          content: [
            {
              type: "toolcall",
              id: "call-1",
              name: "browser.open",
              arguments: { url: "https://example.com" },
            },
            {
              type: "toolresult",
              id: "call-1",
              name: "browser.open",
              text: "Opened page",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    const rerender = () => {
      render(renderChat({ ...props, onRequestUpdate: rerender }), container);
    };
    rerender();

    expect(container.textContent).not.toContain("Input");
    expect(container.textContent).not.toContain("Output");

    container
      .querySelector<HTMLElement>(".chat-tool-msg-summary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushTasks();

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("https://example.com");
    expect(container.textContent).toContain("Opened page");

    container
      .querySelector<HTMLElement>(".chat-tool-msg-summary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushTasks();

    expect(container.textContent).not.toContain("Tool input");
    expect(container.textContent).not.toContain("Opened page");
  });

  it("auto-expands new tool cards inline when the preference is enabled", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          autoExpandToolCalls: true,
          messages: [
            {
              id: "assistant-2",
              role: "assistant",
              toolCallId: "call-2",
              content: [
                {
                  type: "toolcall",
                  id: "call-2",
                  name: "browser.open",
                  arguments: { url: "https://example.com" },
                },
                {
                  type: "toolresult",
                  id: "call-2",
                  name: "browser.open",
                  text: "Opened page",
                },
              ],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("https://example.com");
  });

  it("expands already-visible tool cards when auto-expand is turned on", () => {
    const container = document.createElement("div");
    const baseProps = createProps({
      messages: [
        {
          id: "assistant-3",
          role: "assistant",
          toolCallId: "call-3",
          content: [
            {
              type: "toolcall",
              id: "call-3",
              name: "browser.open",
              arguments: { url: "https://example.com" },
            },
            {
              type: "toolresult",
              id: "call-3",
              name: "browser.open",
              text: "Opened page",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    render(renderChat(baseProps), container);
    expect(container.textContent).not.toContain("Input");

    render(renderChat({ ...baseProps, autoExpandToolCalls: true }), container);
    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain("Tool output");
  });

  it("lets an auto-expanded tool call collapse again from the summary row", async () => {
    const container = document.createElement("div");
    const props = createProps({
      autoExpandToolCalls: true,
      messages: [
        {
          id: "assistant-3b",
          role: "assistant",
          toolCallId: "call-3b",
          content: [
            {
              type: "toolcall",
              id: "call-3b",
              name: "browser.open",
              arguments: { url: "https://example.com" },
            },
            {
              type: "toolresult",
              id: "call-3b",
              name: "browser.open",
              text: "Opened page",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    const rerender = () => {
      render(renderChat({ ...props, onRequestUpdate: rerender }), container);
    };
    rerender();

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain("Opened page");

    container
      .querySelector<HTMLElement>(".chat-tool-msg-summary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushTasks();

    expect(container.textContent).not.toContain("Tool input");
    expect(container.textContent).not.toContain("Opened page");
  });

  it("keeps expanded input-only tool calls from rendering a redundant output block", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          autoExpandToolCalls: true,
          messages: [
            {
              id: "assistant-4",
              role: "assistant",
              toolCallId: "call-4",
              content: [
                {
                  type: "toolcall",
                  id: "call-4",
                  name: "sessions_spawn",
                  arguments: { mode: "session", thread: true },
                },
              ],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
    expect(container.textContent).not.toContain("Tool output");
    expect(container.textContent).not.toContain("No output");
  });

  it("routes standalone tool-call rows through the same top-level disclosure as tool output", async () => {
    const container = document.createElement("div");
    const props = createProps({
      messages: [
        {
          id: "assistant-4b",
          role: "assistant",
          toolCallId: "call-4b",
          content: [
            {
              type: "toolcall",
              id: "call-4b",
              name: "sessions_spawn",
              arguments: { mode: "session", thread: true },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    const rerender = () => {
      render(renderChat({ ...props, onRequestUpdate: rerender }), container);
    };
    rerender();

    const summary = container.querySelector<HTMLElement>(".chat-tool-msg-summary");
    expect(summary?.textContent).toContain("Tool call");
    expect(container.textContent).not.toContain('"thread": true');

    summary?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushTasks();

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');

    summary?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushTasks();

    expect(container.textContent).not.toContain("Tool input");
    expect(container.textContent).not.toContain('"thread": true');
  });

  it("auto-expand opens separate tool output rows and their json content", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          autoExpandToolCalls: true,
          messages: [
            {
              id: "assistant-5",
              role: "assistant",
              toolCallId: "call-5",
              content: [
                {
                  type: "toolcall",
                  id: "call-5",
                  name: "sessions_spawn",
                  arguments: { mode: "session", thread: true },
                },
              ],
              timestamp: Date.now(),
            },
            {
              id: "tool-5",
              role: "tool",
              toolCallId: "call-5",
              toolName: "sessions_spawn",
              content: JSON.stringify(
                {
                  status: "error",
                  error: "Session mode is unavailable for this target.",
                  childSessionKey: "agent:test:subagent:abc123",
                },
                null,
                2,
              ),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain('"status": "error"');
    expect(container.textContent).toContain('"childSessionKey": "agent:test:subagent:abc123"');
  });

  it("does not render tool-row canvas previews", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          autoExpandToolCalls: true,
          messages: [
            {
              id: "tool-anki-1",
              role: "tool",
              toolCallId: "call-anki-1",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                source: {
                  type: "html",
                  content: "<div>Front card</div>",
                },
                presentation: {
                  target: "tool_card",
                  title: "Status view",
                },
              }),
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(container.textContent).toContain("Status view");
    expect(container.textContent).toContain("Tool output");
  });

  it("renders [embed] shortcodes inside the assistant bubble", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          messages: [
            {
              id: "assistant-anki-inline",
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: 'Still the same current card.\n[embed ref="cv_shortcode" title="Shortcode view" /]',
                },
              ],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(container.textContent).toContain("Still the same current card.");
    expect(container.textContent).toContain("Shortcode view");
  });

  it("renders canvas-only assistant bubbles", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          messages: [
            {
              id: "assistant-canvas-only",
              role: "assistant",
              content: [{ type: "text", text: '[embed ref="cv_tictactoe" title="Tic-Tac-Toe" /]' }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-bubble")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(container.textContent).toContain("Tic-Tac-Toe");
  });

  it("renders assistant_message canvas results inside the assistant bubble when tool rows are hidden", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          messages: [
            {
              id: "assistant-canvas-inline",
              role: "assistant",
              content: [{ type: "text", text: "Inline canvas result." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-artifact-inline",
              role: "tool",
              toolCallId: "call-artifact-inline",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_inline",
                  url: "/__openclaw__/canvas/documents/cv_inline/index.html",
                  title: "Inline demo",
                  preferred_height: 360,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    const iframe = container.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("src")).toBe("/__openclaw__/canvas/documents/cv_inline/index.html");
    expect(container.textContent).toContain("Inline canvas result.");
    expect(container.textContent).toContain("Inline demo");
    expect(container.textContent).toContain("Raw details");
  });

  it("uses trusted embed sandbox mode when configured", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          embedSandboxMode: "trusted",
          messages: [
            {
              id: "assistant-canvas-isolated",
              role: "assistant",
              content: [{ type: "text", text: "Inline canvas result." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-artifact-inline-isolated",
              role: "tool",
              toolCallId: "call-artifact-inline-isolated",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_inline_isolated",
                  url: "/__openclaw__/canvas/documents/cv_inline_isolated/index.html",
                  title: "Inline demo",
                  preferred_height: 360,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    const iframe = container.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("renders assistant_message canvas results in the assistant bubble even when tool rows are visible", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          autoExpandToolCalls: true,
          messages: [
            {
              id: "assistant-canvas-inline-visible",
              role: "assistant",
              content: [{ type: "text", text: "Inline canvas result." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-artifact-inline-visible",
              role: "tool",
              toolCallId: "call-artifact-inline-visible",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_inline_visible",
                  url: "/__openclaw__/canvas/documents/cv_inline_visible/index.html",
                  title: "Inline demo",
                  preferred_height: 360,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubble = container.querySelector(".chat-group.assistant .chat-bubble");
    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(1);
    expect(assistantBubble?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("canvas_render");
    expect(container.textContent).toContain("Inline canvas result.");
    expect(container.textContent).toContain("Inline demo");
  });

  it("keeps lifted canvas previews attached to the nearest assistant turn", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              id: "assistant-with-canvas",
              role: "assistant",
              content: [{ type: "text", text: "First reply." }],
              timestamp: 1_000,
            },
            {
              id: "assistant-without-canvas",
              role: "assistant",
              content: [{ type: "text", text: "Later unrelated reply." }],
              timestamp: 2_000,
            },
          ],
          toolMessages: [
            {
              id: "tool-canvas-for-first-reply",
              role: "tool",
              toolCallId: "call-canvas-old",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_nearest_turn",
                  url: "/__openclaw__/canvas/documents/cv_nearest_turn/index.html",
                  title: "Nearest turn demo",
                  preferred_height: 320,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
              timestamp: 1_001,
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubbles = Array.from(
      container.querySelectorAll<HTMLElement>(".chat-group.assistant .chat-bubble"),
    );
    expect(assistantBubbles).toHaveLength(2);
    expect(assistantBubbles[0]?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(assistantBubbles[1]?.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(assistantBubbles[1]?.textContent).toContain("Later unrelated reply.");
  });

  it("does not auto-render generic view handles from non-canvas payloads", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              id: "assistant-generic-inline",
              role: "assistant",
              content: [{ type: "text", text: "Rendered the item inline." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-generic-inline",
              role: "tool",
              toolCallId: "call-generic-inline",
              toolName: "plugin_card_details",
              content: JSON.stringify({
                selected_item: {
                  summary: {
                    label: "Alpha",
                    meaning: "Generic example",
                  },
                  view: {
                    backend: "canvas",
                    id: "cv_generic_inline",
                    url: "/__openclaw__/canvas/documents/cv_generic_inline/index.html",
                    title: "Inline generic preview",
                    preferred_height: 420,
                  },
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubble = container.querySelector(".chat-group.assistant .chat-bubble");
    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(0);
    expect(assistantBubble?.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("plugin_card_details");
    expect(container.textContent).toContain("Rendered the item inline.");
    expect(container.textContent).not.toContain("Inline generic preview");
  });

  it("renders assistant MEDIA attachments, voice-note badge, and reply pill", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          messages: [
            {
              id: "assistant-media-inline",
              role: "assistant",
              content:
                "[[reply_to_current]]Here is the image.\nMEDIA:https://example.com/photo.png\nMEDIA:https://example.com/voice.ogg\n[[audio_as_voice]]",
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-reply-pill")?.textContent).toContain(
      "Replying to current message",
    );
    expect(container.querySelector(".chat-message-image")).not.toBeNull();
    expect(container.querySelector("audio")).not.toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent).toContain(
      "Voice note",
    );
    expect(container.textContent).toContain("Here is the image.");
    expect(container.textContent).not.toContain("[[reply_to_current]]");
    expect(container.textContent).not.toContain("[[audio_as_voice]]");
    expect(container.textContent).not.toContain("MEDIA:https://example.com/photo.png");
  });

  it("renders verified local assistant attachments through the Control UI media route", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("meta=1")) {
        return {
          ok: true,
          json: async () => ({ available: true }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const template = () =>
      renderChat(
        createProps({
          showToolCalls: false,
          basePath: "/openclaw",
          assistantAttachmentAuthToken: "session-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: () => render(template(), container),
          messages: [
            {
              id: "assistant-local-media-inline",
              role: "assistant",
              content:
                "Local image\nMEDIA:/tmp/openclaw/test image.png\nMEDIA:/tmp/openclaw/test-doc.pdf",
              timestamp: Date.now(),
            },
          ],
        }),
      );

    render(template(), container);
    expect(container.textContent).toContain("Checking...");
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&token=session-token&meta=1",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    const docLink = container.querySelector<HTMLAnchorElement>(
      ".chat-assistant-attachment-card__link",
    );
    expect(image?.getAttribute("src")).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&token=session-token",
    );
    expect(docLink?.getAttribute("href")).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest-doc.pdf&token=session-token",
    );
    expect(container.textContent).not.toContain("test image.png");
    vi.unstubAllGlobals();
  });

  it("rechecks local assistant attachment availability when the auth token changes", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("meta=1")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return {
        ok: true,
        json: async () => ({ available: url.includes("token=fresh-token") }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");

    const renderWithToken = (token: string | null) =>
      render(
        renderChat(
          createProps({
            showToolCalls: false,
            basePath: "/openclaw",
            assistantAttachmentAuthToken: token,
            localMediaPreviewRoots: ["/tmp/openclaw"],
            onRequestUpdate: () => renderWithToken(token),
            messages: [
              {
                id: "assistant-local-media-auth-refresh",
                role: "assistant",
                content: "Local image\nMEDIA:/tmp/openclaw/test image.png",
                timestamp: Date.now(),
              },
            ],
          }),
        ),
        container,
      );

    renderWithToken(null);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Unavailable");

    renderWithToken("fresh-token");
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&meta=1",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&token=fresh-token&meta=1",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(container.querySelector(".chat-message-image")).not.toBeNull();
    expect(container.textContent).not.toContain("Unavailable");
    vi.unstubAllGlobals();
  });

  it("preserves same-origin assistant attachments without local preview rewriting", () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          basePath: "/openclaw",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          messages: [
            {
              id: "assistant-same-origin-media-inline",
              role: "assistant",
              content:
                "Inline\nMEDIA:/media/inbound/test-image.png\nMEDIA:/__openclaw__/media/test-doc.pdf",
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    const docLink = container.querySelector<HTMLAnchorElement>(
      ".chat-assistant-attachment-card__link",
    );
    expect(image?.getAttribute("src")).toBe("/media/inbound/test-image.png");
    expect(docLink?.getAttribute("href")).toBe("/__openclaw__/media/test-doc.pdf");
    expect(container.textContent).not.toContain("Unavailable");
  });

  it("renders blocked local assistant files as unavailable with a reason", () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          basePath: "/openclaw",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          messages: [
            {
              id: "assistant-blocked-local-media",
              role: "assistant",
              content: "Blocked\nMEDIA:/Users/test/Documents/private.pdf\nDone",
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-assistant-attachment-card__link")).toBeNull();
    expect(container.textContent).toContain("private.pdf");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Outside allowed folders");
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).toContain("Done");
  });

  it("allows Windows file URLs inside allowed preview roots", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("meta=1")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return {
        ok: true,
        json: async () => ({ available: true }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          basePath: "/openclaw",
          localMediaPreviewRoots: ["C:\\tmp\\openclaw"],
          onRequestUpdate: () => undefined,
          messages: [
            {
              id: "assistant-windows-file-url",
              role: "assistant",
              content: "Windows image\nMEDIA:file:///C:/tmp/openclaw/test%20image.png",
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/__openclaw__/assistant-media?source=%2FC%3A%2Ftmp%2Fopenclaw%2Ftest%2520image.png&meta=1",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(container.textContent).not.toContain("Outside allowed folders");
    vi.unstubAllGlobals();
  });

  it("allows Windows local assistant attachments when path casing differs", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("meta=1")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return {
        ok: true,
        json: async () => ({ available: true }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          basePath: "/openclaw",
          localMediaPreviewRoots: ["c:\\users\\test\\pictures"],
          onRequestUpdate: () => undefined,
          messages: [
            {
              id: "assistant-windows-path-case-differs",
              role: "assistant",
              content: "Windows image\nMEDIA:C:\\Users\\Test\\Pictures\\test image.png",
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/__openclaw__/assistant-media?source=C%3A%5CUsers%5CTest%5CPictures%5Ctest+image.png&meta=1",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(container.textContent).not.toContain("Outside allowed folders");
    vi.unstubAllGlobals();
  });

  it("revalidates cached unavailable local assistant attachments after retry window", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<(url: string) => Promise<{ ok: true; json: () => Promise<{ available: boolean }> }>>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ available: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ available: true }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");

    const renderMessage = () =>
      render(
        renderChat(
          createProps({
            showToolCalls: false,
            basePath: "/openclaw",
            localMediaPreviewRoots: ["/tmp/openclaw"],
            onRequestUpdate: renderMessage,
            messages: [
              {
                id: "assistant-local-media-retry-after-unavailable",
                role: "assistant",
                content: "Local image\nMEDIA:/tmp/openclaw/test image.png",
                timestamp: Date.now(),
              },
            ],
          }),
        ),
        container,
      );

    renderMessage();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Unavailable");

    vi.advanceTimersByTime(5_001);
    renderMessage();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-message-image")).not.toBeNull();
    expect(container.textContent).not.toContain("Unavailable");

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("allows tilde local assistant attachments inside home-based preview roots", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("meta=1")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return {
        ok: true,
        json: async () => ({ available: true }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          basePath: "/openclaw",
          localMediaPreviewRoots: ["/Users/test/Pictures"],
          onRequestUpdate: () => undefined,
          messages: [
            normalizeMessage({
              id: "assistant-tilde-local-media",
              role: "assistant",
              content: [
                { type: "text", text: "Home image" },
                {
                  type: "attachment",
                  attachment: {
                    url: "~/Pictures/test image.png",
                    kind: "image",
                    label: "test image.png",
                    mimeType: "image/png",
                  },
                },
              ],
              timestamp: Date.now(),
            }),
          ],
        }),
      ),
      container,
    );

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/__openclaw__/assistant-media?source=%7E%2FPictures%2Ftest+image.png&meta=1",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(container.textContent).not.toContain("Outside allowed folders");
    vi.unstubAllGlobals();
  });

  it("routes inline canvas blocks through the scoped canvas host when available", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          canvasHostUrl: "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
          messages: [
            {
              id: "assistant-scoped-canvas",
              role: "assistant",
              content: [
                { type: "text", text: "Rendered inline." },
                {
                  type: "canvas",
                  preview: {
                    kind: "canvas",
                    surface: "assistant_message",
                    render: "url",
                    viewId: "cv_inline_scoped",
                    title: "Scoped preview",
                    url: "/__openclaw__/canvas/documents/cv_inline_scoped/index.html",
                    preferredHeight: 320,
                  },
                },
              ],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const iframe = container.querySelector(".chat-tool-card__preview-frame");
    expect(iframe?.getAttribute("src")).toBe(
      "http://127.0.0.1:19003/__openclaw__/cap/cap_123/__openclaw__/canvas/documents/cv_inline_scoped/index.html",
    );
  });

  it("renders server-history canvas blocks for the live toolResult sequence after history reload", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              id: "assistant-toolcall-live-shape",
              role: "assistant",
              content: [
                { type: "thinking", thinking: "", thinkingSignature: "sig-1" },
                {
                  type: "toolCall",
                  id: "call_live_canvas",
                  name: "canvas_tool_result",
                  arguments: {},
                  partialJson: "{}",
                },
              ],
              timestamp: Date.now(),
            },
            {
              id: "toolresult-live-shape",
              role: "toolResult",
              toolCallId: "call_live_canvas",
              toolName: "canvas_tool_result",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    kind: "canvas",
                    view: {
                      backend: "canvas",
                      id: "cv_canvas_live_history",
                      url: "/__openclaw__/canvas/documents/cv_canvas_live_history/index.html",
                      title: "Live history preview",
                      preferred_height: 420,
                    },
                    presentation: {
                      target: "assistant_message",
                    },
                  }),
                },
              ],
              timestamp: Date.now() + 1,
            },
            {
              id: "assistant-final-live-shape",
              role: "assistant",
              content: [
                { type: "thinking", thinking: "", thinkingSignature: "sig-2" },
                { type: "text", text: "This item is ready." },
                {
                  type: "canvas",
                  preview: {
                    kind: "canvas",
                    surface: "assistant_message",
                    render: "url",
                    viewId: "cv_canvas_live_history",
                    title: "Live history preview",
                    url: "/__openclaw__/canvas/documents/cv_canvas_live_history/index.html",
                    preferredHeight: 420,
                  },
                  rawText: JSON.stringify({
                    kind: "canvas",
                    view: {
                      backend: "canvas",
                      id: "cv_canvas_live_history",
                      url: "/__openclaw__/canvas/documents/cv_canvas_live_history/index.html",
                    },
                    presentation: {
                      target: "assistant_message",
                    },
                  }),
                },
              ],
              timestamp: Date.now() + 2,
            },
          ],
          toolMessages: [],
        }),
      ),
      container,
    );

    const assistantBubbles = container.querySelectorAll(".chat-group.assistant .chat-bubble");
    const finalAssistantBubble = assistantBubbles[assistantBubbles.length - 1];
    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(1);
    expect(finalAssistantBubble?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(finalAssistantBubble?.textContent).toContain("This item is ready.");
    expect(finalAssistantBubble?.textContent).toContain("Live history preview");
  });

  it("lifts streamed canvas tool messages with toolresult blocks into the assistant bubble", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              id: "assistant-streamed-artifact",
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-streamed-artifact",
              role: "assistant",
              toolCallId: "call_streamed_artifact",
              timestamp: Date.now() - 1,
              content: [
                {
                  type: "toolcall",
                  name: "canvas_render",
                  arguments: { source: { type: "handle", id: "cv_streamed_artifact" } },
                },
                {
                  type: "toolresult",
                  name: "canvas_render",
                  text: JSON.stringify({
                    kind: "canvas",
                    view: {
                      backend: "canvas",
                      id: "cv_streamed_artifact",
                      url: "/__openclaw__/canvas/documents/cv_streamed_artifact/index.html",
                      title: "Streamed demo",
                      preferred_height: 320,
                    },
                    presentation: {
                      target: "assistant_message",
                    },
                  }),
                },
              ],
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubble = container.querySelector(".chat-group.assistant .chat-bubble");
    expect(assistantBubble?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(container.textContent).toContain("Streamed demo");
    expect(container.textContent).toContain("Done.");
    expect(
      Array.from(container.querySelectorAll(".chat-tool-msg-summary__label")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toContain("Tool output");
  });

  it("opens generic tool details instead of a canvas preview from tool rows", async () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          autoExpandToolCalls: true,
          onOpenSidebar,
          messages: [
            {
              id: "assistant-canvas-sidebar",
              role: "assistant",
              content: [{ type: "text", text: "Sidebar canvas result." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-artifact-sidebar",
              role: "tool",
              toolCallId: "call-artifact-sidebar",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_sidebar",
                  url: "https://example.com/canvas",
                  title: "Sidebar demo",
                  preferred_height: 420,
                },
                presentation: {
                  target: "tool_card",
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    await Promise.resolve();

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");

    sidebarButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(sidebarButton).not.toBeNull();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "markdown",
      }),
    );
  });

  it("lets a split tool call collapse even when a separate tool output shares its toolCallId", async () => {
    const container = document.createElement("div");
    const props = createProps({
      autoExpandToolCalls: true,
      messages: [
        {
          id: "assistant-6",
          role: "assistant",
          toolCallId: "call-6",
          content: [
            {
              type: "toolcall",
              id: "call-6",
              name: "sessions_spawn",
              arguments: { mode: "session", thread: true },
            },
          ],
          timestamp: Date.now(),
        },
        {
          id: "tool-6",
          role: "tool",
          toolCallId: "call-6",
          toolName: "sessions_spawn",
          content: JSON.stringify({ status: "error" }, null, 2),
          timestamp: Date.now() + 1,
        },
      ],
    });

    const rerender = () => {
      render(renderChat({ ...props, onRequestUpdate: rerender }), container);
    };
    rerender();

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
    expect(container.textContent).toContain('"status": "error"');

    const summaries = container.querySelectorAll<HTMLElement>(".chat-tool-msg-summary");
    summaries[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushTasks();

    expect(container.textContent).not.toContain("Tool input");
    expect(container.textContent).toContain('"status": "error"');
  });

  it("lets a tool call collapse when the matching tool output comes from toolMessages", async () => {
    const container = document.createElement("div");
    const props = createProps({
      autoExpandToolCalls: true,
      messages: [
        {
          id: "assistant-7",
          role: "assistant",
          toolCallId: "call-7",
          content: [
            {
              type: "toolcall",
              id: "call-7",
              name: "sessions_spawn",
              arguments: { mode: "session", thread: true },
            },
          ],
          timestamp: Date.now(),
        },
      ],
      toolMessages: [
        {
          id: "tool-7",
          role: "tool",
          toolCallId: "call-7",
          toolName: "sessions_spawn",
          content: JSON.stringify({ status: "error" }, null, 2),
          timestamp: Date.now() + 1,
        },
      ],
    });

    const rerender = () => {
      render(renderChat({ ...props, onRequestUpdate: rerender }), container);
    };
    rerender();

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
    expect(container.textContent).toContain('"status": "error"');

    const summaries = container.querySelectorAll<HTMLElement>(".chat-tool-msg-summary");
    expect(summaries.length).toBeGreaterThan(1);
    summaries[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushTasks();

    expect(container.textContent).not.toContain("Tool input");
    expect(container.textContent).toContain('"status": "error"');
  });
});
