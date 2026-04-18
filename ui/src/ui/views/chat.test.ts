/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  renderMessageGroup,
  resetAssistantAttachmentAvailabilityCacheForTest,
} from "../chat/grouped-render.ts";
import { normalizeMessage } from "../chat/message-normalizer.ts";
import type { SessionsListResult } from "../types.ts";
import type { MessageGroup } from "../types/chat-types.ts";
import { renderChat, type ChatProps } from "./chat.ts";

vi.mock("../markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

vi.mock("./markdown-sidebar.ts", async () => {
  const { html } = await import("lit");
  return {
    renderMarkdownSidebar: (props: { content?: { content?: string; title?: string } | null }) =>
      html`<div class="sidebar-panel" data-mocked-sidebar>
        ${props.content?.title ?? props.content?.content ?? ""}
      </div>`,
  };
});

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

function flushTasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function flushAssistantAttachmentAvailabilityChecks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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

type RenderMessageGroupOptions = Parameters<typeof renderMessageGroup>[1];

function renderAssistantMessage(
  container: HTMLElement,
  message: unknown,
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const timestamp =
    typeof message === "object" &&
    message !== null &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  const group: MessageGroup = {
    kind: "group",
    key: "assistant-group",
    role: "assistant",
    messages: [{ key: "assistant-message", message }],
    timestamp,
    isStreaming: false,
  };
  render(
    renderMessageGroup(group, {
      showReasoning: true,
      showToolCalls: true,
      assistantName: "OpenClaw",
      assistantAvatar: null,
      ...opts,
    }),
    container,
  );
}

function clearDeleteConfirmSkip() {
  try {
    getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
  } catch {
    /* noop */
  }
}

describe("chat view", () => {
  it("uses the assistant avatar URL or bundled logo fallbacks", () => {
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
    expect(container.querySelector<HTMLImageElement>(".agent-chat__welcome > img")).toBeNull();
    expect(logoImage).not.toBeNull();
    expect(
      container
        .querySelector<HTMLImageElement>(".agent-chat__welcome .agent-chat__avatar--logo img")
        ?.getAttribute("src"),
    ).toBe("/openclaw/favicon.svg");

    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: "hello",
        timestamp: 1000,
      },
      { basePath: "/openclaw/" },
    );
    const groupedLogo = container.querySelector<HTMLImageElement>(
      ".chat-group.assistant .chat-avatar--logo",
    );
    expect(groupedLogo).not.toBeNull();
    expect(groupedLogo?.getAttribute("src")).toBe("/openclaw/favicon.svg");
  });

  it("renders compaction and fallback indicators while they are fresh", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(1_000);
      render(
        renderChat(
          createProps({
            compactionStatus: {
              phase: "active",
              runId: "run-1",
              startedAt: 1_000,
              completedAt: null,
            },
          }),
        ),
        container,
      );

      let indicator = container.querySelector(".compaction-indicator--active");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Compacting context...");

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
      indicator = container.querySelector(".compaction-indicator--complete");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Context compacted");

      nowSpy.mockReturnValue(10_000);
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

      nowSpy.mockReturnValue(1_000);
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
      indicator = container.querySelector(".compaction-indicator--fallback");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");

      nowSpy.mockReturnValue(20_000);
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

      nowSpy.mockReturnValue(1_000);
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
      indicator = container.querySelector(".compaction-indicator--fallback-cleared");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("renders the run action button for abortable and idle states", () => {
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

    let stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeUndefined();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");

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
    stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeNull();
    expect(container.textContent).not.toContain("New session");

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
    expect(senderLabels).not.toContain("You");
  });

  it("positions delete confirm by message side", () => {
    clearDeleteConfirmSkip();
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

    const userDeleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.user .chat-group-delete",
    );
    expect(userDeleteButton).not.toBeNull();
    userDeleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const userConfirm = container.querySelector<HTMLElement>(
      ".chat-group.user .chat-delete-confirm",
    );
    expect(userConfirm).not.toBeNull();
    expect(userConfirm?.classList.contains("chat-delete-confirm--left")).toBe(true);

    clearDeleteConfirmSkip();
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

    const assistantDeleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.assistant .chat-group-delete",
    );
    expect(assistantDeleteButton).not.toBeNull();
    assistantDeleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const assistantConfirm = container.querySelector<HTMLElement>(
      ".chat-group.assistant .chat-delete-confirm",
    );
    expect(assistantConfirm).not.toBeNull();
    expect(assistantConfirm?.classList.contains("chat-delete-confirm--right")).toBe(true);
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

  it("renders canvas-only [embed] shortcodes inside the assistant bubble", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: false,
          messages: [
            {
              id: "assistant-canvas-only",
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: '[embed ref="cv_tictactoe" title="Tic-Tac-Toe" /]',
                },
              ],
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

  it("renders hidden assistant_message canvas results with the configured sandbox", () => {
    const container = document.createElement("div");
    const renderCanvas = (params: { embedSandboxMode?: "trusted"; suffix: string }) =>
      render(
        renderChat(
          createProps({
            ...(params.embedSandboxMode ? { embedSandboxMode: params.embedSandboxMode } : {}),
            showToolCalls: false,
            messages: [
              {
                id: `assistant-canvas-inline-${params.suffix}`,
                role: "assistant",
                content: [{ type: "text", text: "Inline canvas result." }],
                timestamp: Date.now(),
              },
            ],
            toolMessages: [
              {
                id: `tool-artifact-inline-${params.suffix}`,
                role: "tool",
                toolCallId: `call-artifact-inline-${params.suffix}`,
                toolName: "canvas_render",
                content: JSON.stringify({
                  kind: "canvas",
                  view: {
                    backend: "canvas",
                    id: `cv_inline_${params.suffix}`,
                    url: `/__openclaw__/canvas/documents/cv_inline_${params.suffix}/index.html`,
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

    renderCanvas({ suffix: "default" });

    let iframe = container.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("src")).toBe(
      "/__openclaw__/canvas/documents/cv_inline_default/index.html",
    );
    expect(container.textContent).toContain("Inline canvas result.");
    expect(container.textContent).toContain("Inline demo");
    expect(container.textContent).toContain("Raw details");

    renderCanvas({ embedSandboxMode: "trusted", suffix: "trusted" });
    iframe = container.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
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
    renderAssistantMessage(
      container,
      {
        id: "assistant-media-inline",
        role: "assistant",
        content:
          "[[reply_to_current]]Here is the image.\nMEDIA:https://example.com/photo.png\nMEDIA:https://example.com/voice.ogg\n[[audio_as_voice]]",
        timestamp: Date.now(),
      },
      { showToolCalls: false },
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

  it("opens only safe assistant image URLs in a hardened new tab", () => {
    const container = document.createElement("div");
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const renderAssistantImage = (url: string) =>
      renderAssistantMessage(container, {
        role: "assistant",
        content: [{ type: "image_url", image_url: { url } }],
        timestamp: Date.now(),
      });

    try {
      renderAssistantImage("https://example.com/cat.png");
      let image = container.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image).not.toBeNull();
      image?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com/cat.png",
        "_blank",
        "noopener,noreferrer",
      );

      openSpy.mockClear();
      renderAssistantImage("javascript:alert(1)");
      image = container.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image).not.toBeNull();
      image?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(openSpy).not.toHaveBeenCalled();

      renderAssistantImage("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />");
      image = container.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image).not.toBeNull();
      image?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
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
    const renderMessage = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-media-inline",
          role: "assistant",
          content:
            "Local image\nMEDIA:/tmp/openclaw/test image.png\nMEDIA:/tmp/openclaw/test-doc.pdf",
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          basePath: "/openclaw",
          assistantAttachmentAuthToken: "session-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: renderMessage,
        },
      );

    renderMessage();
    expect(container.textContent).toContain("Checking...");
    await flushAssistantAttachmentAvailabilityChecks();

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
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-media-auth-refresh",
          role: "assistant",
          content: "Local image\nMEDIA:/tmp/openclaw/test image.png",
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          basePath: "/openclaw",
          assistantAttachmentAuthToken: token,
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: () => renderWithToken(token),
        },
      );

    renderWithToken(null);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(container.textContent).toContain("Unavailable");

    renderWithToken("fresh-token");
    await flushAssistantAttachmentAvailabilityChecks();

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
    renderAssistantMessage(
      container,
      {
        id: "assistant-same-origin-media-inline",
        role: "assistant",
        content:
          "Inline\nMEDIA:/media/inbound/test-image.png\nMEDIA:/__openclaw__/media/test-doc.pdf",
        timestamp: Date.now(),
      },
      {
        showToolCalls: false,
        basePath: "/openclaw",
        localMediaPreviewRoots: ["/tmp/openclaw"],
      },
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
    renderAssistantMessage(
      container,
      {
        id: "assistant-blocked-local-media",
        role: "assistant",
        content: "Blocked\nMEDIA:/Users/test/Documents/private.pdf\nDone",
        timestamp: Date.now(),
      },
      {
        showToolCalls: false,
        basePath: "/openclaw",
        localMediaPreviewRoots: ["/tmp/openclaw"],
      },
    );

    expect(container.querySelector(".chat-assistant-attachment-card__link")).toBeNull();
    expect(container.textContent).toContain("private.pdf");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Outside allowed folders");
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).toContain("Done");
  });

  it("allows platform-specific local assistant attachments inside preview roots", async () => {
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

    const renderCase = (params: {
      expectedUrl: string;
      message: ChatProps["messages"][number];
      roots: string[];
    }) => {
      renderAssistantMessage(container, params.message, {
        showToolCalls: false,
        basePath: "/openclaw",
        localMediaPreviewRoots: params.roots,
        onRequestUpdate: () => undefined,
      });
      return params.expectedUrl;
    };

    const cases = [
      renderCase({
        roots: ["C:\\tmp\\openclaw"],
        message: {
          id: "assistant-windows-file-url",
          role: "assistant",
          content: "Windows image\nMEDIA:file:///C:/tmp/openclaw/test%20image.png",
          timestamp: Date.now(),
        },
        expectedUrl:
          "/openclaw/__openclaw__/assistant-media?source=%2FC%3A%2Ftmp%2Fopenclaw%2Ftest%2520image.png&meta=1",
      }),
      renderCase({
        roots: ["c:\\users\\test\\pictures"],
        message: {
          id: "assistant-windows-path-case-differs",
          role: "assistant",
          content: "Windows image\nMEDIA:C:\\Users\\Test\\Pictures\\test image.png",
          timestamp: Date.now(),
        },
        expectedUrl:
          "/openclaw/__openclaw__/assistant-media?source=C%3A%5CUsers%5CTest%5CPictures%5Ctest+image.png&meta=1",
      }),
      renderCase({
        roots: ["/Users/test/Pictures"],
        message: normalizeMessage({
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
        expectedUrl:
          "/openclaw/__openclaw__/assistant-media?source=%7E%2FPictures%2Ftest+image.png&meta=1",
      }),
    ];

    await flushAssistantAttachmentAvailabilityChecks();

    for (const expectedUrl of cases) {
      expect(fetchMock).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({ credentials: "same-origin", method: "GET" }),
      );
    }
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
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-media-retry-after-unavailable",
          role: "assistant",
          content: "Local image\nMEDIA:/tmp/openclaw/test image.png",
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          basePath: "/openclaw",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: renderMessage,
        },
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

  it("routes inline canvas blocks through the scoped canvas host when available", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
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
      {
        canvasHostUrl: "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
      },
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

  it("lets a tool call collapse while keeping matching tool output visible", async () => {
    const container = document.createElement("div");

    const renderCase = (params: { outputInToolMessages: boolean; id: string }) => {
      const props = createProps({
        autoExpandToolCalls: true,
        messages: [
          {
            id: `assistant-${params.id}`,
            role: "assistant",
            toolCallId: `call-${params.id}`,
            content: [
              {
                type: "toolcall",
                id: `call-${params.id}`,
                name: "sessions_spawn",
                arguments: { mode: "session", thread: true },
              },
            ],
            timestamp: Date.now(),
          },
          ...(params.outputInToolMessages
            ? []
            : [
                {
                  id: `tool-${params.id}`,
                  role: "tool" as const,
                  toolCallId: `call-${params.id}`,
                  toolName: "sessions_spawn",
                  content: JSON.stringify({ status: "error" }, null, 2),
                  timestamp: Date.now() + 1,
                },
              ]),
        ],
        toolMessages: params.outputInToolMessages
          ? [
              {
                id: `tool-${params.id}`,
                role: "tool",
                toolCallId: `call-${params.id}`,
                toolName: "sessions_spawn",
                content: JSON.stringify({ status: "error" }, null, 2),
                timestamp: Date.now() + 1,
              },
            ]
          : [],
      });
      const rerender = () => {
        render(renderChat({ ...props, onRequestUpdate: rerender }), container);
      };
      rerender();
    };

    for (const outputInToolMessages of [false, true]) {
      renderCase({ id: outputInToolMessages ? "tool-messages" : "split", outputInToolMessages });
      expect(container.textContent).toContain("Tool input");
      expect(container.textContent).toContain('"thread": true');
      expect(container.textContent).toContain('"status": "error"');

      const summaries = container.querySelectorAll<HTMLElement>(".chat-tool-msg-summary");
      if (outputInToolMessages) {
        expect(summaries.length).toBeGreaterThan(1);
      }
      summaries[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushTasks();

      expect(container.textContent).not.toContain("Tool input");
      expect(container.textContent).toContain('"status": "error"');
    }
  });
});
