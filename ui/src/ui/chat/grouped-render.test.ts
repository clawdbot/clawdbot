/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageGroup } from "../types/chat-types.ts";
import {
  formatChatTimestampForDisplay,
  renderMessageGroup,
  renderStreamingGroup,
  resetAssistantAttachmentAvailabilityCacheForTest,
} from "./grouped-render.ts";
import { normalizeMessage } from "./message-normalizer.ts";

const localStorageValues = vi.hoisted(() => new Map<string, string>());

vi.mock("../../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
}));

vi.mock("../markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

vi.mock("../icons.ts", () => ({
  icons: {},
}));

function requireFirstMockArg(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
    throw new Error(`expected ${label} payload`);
  }
  return arg as Record<string, unknown>;
}

vi.mock("../views/agents-utils.ts", () => {
  const isRenderableControlUiAvatarUrl = (value: string) =>
    /^data:image\//i.test(value) || (value.startsWith("/") && !value.startsWith("//"));

  return {
    assistantAvatarFallbackUrl: () => "/openclaw-molty.png",
    agentLogoUrl: () => "/openclaw-logo.svg",
    isRenderableControlUiAvatarUrl,
    resolveAssistantTextAvatar: (value: string | null | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed || trimmed === "A") {
        return null;
      }
      if (trimmed.startsWith("blob:") || isRenderableControlUiAvatarUrl(trimmed)) {
        return null;
      }
      if (
        trimmed.length > 8 ||
        /\s/.test(trimmed) ||
        /[\\/.:]/.test(trimmed) ||
        /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(trimmed)
      ) {
        return null;
      }
      return trimmed;
    },
    resolveChatAvatarRenderUrl: (
      candidate: string | null | undefined,
      agent: { identity?: { avatar?: string; avatarUrl?: string } },
    ) => {
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
  };
});

vi.mock("./chat-avatar.ts", () => ({
  renderChatAvatar: (role: string) => {
    const element = document.createElement("div");
    element.className = `chat-avatar ${role}`;
    return element;
  },
}));

vi.mock("../tool-display.ts", () => ({
  formatToolDetail: () => undefined,
  resolveToolDisplay: ({ name }: { name: string }) => ({
    name,
    label: name,
    icon: "zap",
  }),
}));

type RenderMessageGroupOptions = Parameters<typeof renderMessageGroup>[1];

function expectElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

function requireFetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const call = fetchMock.mock.calls[index] as unknown as [string, RequestInit?] | undefined;
  if (!call) {
    throw new Error(`Expected fetch call ${index}`);
  }
  return call;
}

function requireFetchCallForUrl(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string) {
  const call = fetchMock.mock.calls.find(([url]) => url === expectedUrl) as
    | [string, RequestInit?]
    | undefined;
  if (!call) {
    throw new Error(`Expected fetch call for ${expectedUrl}`);
  }
  return call;
}

function expectSameOriginGet(init: RequestInit | undefined) {
  expect(init?.credentials).toBe("same-origin");
  expect(init?.method).toBe("GET");
}

function renderAssistantMessage(
  container: HTMLElement,
  message: unknown,
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  renderGroupedMessage(container, message, "assistant", opts);
}

function renderAssistantMessages(
  container: HTMLElement,
  messages: unknown[],
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const timestamp =
    typeof messages[0] === "object" &&
    messages[0] !== null &&
    typeof (messages[0] as { timestamp?: unknown }).timestamp === "number"
      ? (messages[0] as { timestamp: number }).timestamp
      : Date.now();
  const group: MessageGroup = {
    kind: "group",
    key: "assistant-group",
    role: "assistant",
    messages: messages.map((message, index) => ({
      key: `assistant-message-${index}`,
      message,
    })),
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

function renderAssistantMessageEntries(
  container: HTMLElement,
  entries: MessageGroup["messages"],
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const group: MessageGroup = {
    kind: "group",
    key: "assistant-group",
    role: "assistant",
    messages: entries,
    timestamp: Date.now(),
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

function renderGroupedMessage(
  container: HTMLElement,
  message: unknown,
  role: string,
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
    key: `${role}-group`,
    role,
    messages: [{ key: `${role}-message`, message }],
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

function createMessageGroup(message: unknown, role: string): MessageGroup {
  const timestamp =
    typeof message === "object" &&
    message !== null &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  return {
    kind: "group",
    key: `${role}:${timestamp}`,
    role,
    messages: [{ key: `${role}:${timestamp}:message`, message }],
    timestamp,
    isStreaming: false,
  };
}

function createAssistantCanvasBlock(params: {
  suffix: string;
  title?: string;
  url?: string;
  preferredHeight?: number;
  presentationTarget?: "assistant_message" | "tool_card";
}) {
  const viewId = `cv_inline_${params.suffix}`;
  const url = params.url ?? `/__openclaw__/canvas/documents/${viewId}/index.html`;
  const title = params.title ?? "Inline demo";
  const preferredHeight = params.preferredHeight ?? 360;
  return {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId,
      title,
      url,
      preferredHeight,
    },
    rawText: JSON.stringify({
      kind: "canvas",
      view: {
        backend: "canvas",
        id: viewId,
        url,
        title,
        preferred_height: preferredHeight,
      },
      presentation: {
        target: params.presentationTarget ?? "assistant_message",
      },
    }),
  };
}

function renderMessageGroups(
  container: HTMLElement,
  groups: MessageGroup[],
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  render(
    html`${groups.map((group) =>
      renderMessageGroup(group, {
        showReasoning: true,
        showToolCalls: true,
        assistantName: "OpenClaw",
        assistantAvatar: null,
        ...opts,
      }),
    )}`,
    container,
  );
}

function clearDeleteConfirmSkip() {
  localStorageValues.delete("openclaw:skipDeleteConfirm");
}

function stubAnimationFrameQueue() {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return () => {
    const pending = callbacks.splice(0);
    for (const callback of pending) {
      callback(performance.now());
    }
  };
}

function getLastCaptureClickListener(calls: readonly unknown[][]) {
  for (let index = calls.length - 1; index >= 0; index--) {
    const [type, listener, options] = calls[index] ?? [];
    if (type === "click" && options === true && listener) {
      return listener;
    }
  }
  return null;
}

function expectLastCaptureClickListener(calls: readonly unknown[][]): unknown {
  const listener = getLastCaptureClickListener(calls);
  expect(typeof listener).toBe("function");
  if (typeof listener !== "function") {
    throw new Error("Expected capture click listener");
  }
  return listener;
}

function countCaptureClickListenerRemovals(calls: readonly unknown[][], listener: unknown) {
  return calls.filter(
    ([type, removedListener, options]) =>
      type === "click" && options === true && removedListener === listener,
  ).length;
}

function renderDeleteConfirmFixture() {
  const container = document.createElement("div");
  container.dataset.deleteConfirmFixture = "true";
  document.body.appendChild(container);
  const onDelete = vi.fn();
  clearDeleteConfirmSkip();
  renderMessageGroups(
    container,
    [
      createMessageGroup(
        {
          role: "assistant",
          content: "hello from assistant",
          timestamp: 1000,
        },
        "assistant",
      ),
    ],
    { onDelete },
  );
  const deleteButton = container.querySelector<HTMLButtonElement>(".chat-group-delete");
  expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
  return { container, deleteButton: deleteButton!, onDelete };
}

function openDeleteConfirm(deleteButton: HTMLButtonElement) {
  deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function clickDeleteButtonIconPath(deleteButton: HTMLButtonElement) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  icon.appendChild(path);
  deleteButton.appendChild(icon);
  path.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function setupArmedDeleteConfirm() {
  const flushAnimationFrames = stubAnimationFrameQueue();
  const addListenerSpy = vi.spyOn(document, "addEventListener");
  const removeListenerSpy = vi.spyOn(document, "removeEventListener");
  const fixture = renderDeleteConfirmFixture();

  openDeleteConfirm(fixture.deleteButton);
  flushAnimationFrames();

  const outsideClickListener = expectLastCaptureClickListener(addListenerSpy.mock.calls);
  expect(fixture.container.querySelectorAll(".chat-delete-confirm")).toHaveLength(1);

  return { ...fixture, outsideClickListener, removeListenerSpy };
}

function expectDeleteConfirmDismissed(params: {
  container: HTMLElement;
  outsideClickListener: unknown;
  removeListenerSpy: ReturnType<typeof vi.spyOn>;
}) {
  expect(params.container.querySelector(".chat-delete-confirm")).toBeNull();
  expect(
    countCaptureClickListenerRemovals(
      params.removeListenerSpy.mock.calls,
      params.outsideClickListener,
    ),
  ).toBe(1);
}

async function flushAssistantAttachmentAvailabilityChecks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function mediaTicketPayload(mediaTicket: string, ttlMs = 5 * 60 * 1000) {
  return {
    available: true,
    mediaTicket,
    mediaTicketExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

afterEach(() => {
  document.querySelectorAll("[data-delete-confirm-fixture]").forEach((element) => {
    element.remove();
  });
  clearDeleteConfirmSkip();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("grouped chat rendering", () => {
  it("renders a compact count for collapsed duplicate messages", () => {
    const container = document.createElement("div");
    renderAssistantMessageEntries(container, [
      {
        key: "assistant-heartbeat",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "HEARTBEAT_OK" }],
          timestamp: 1,
        },
        duplicateCount: 4,
      },
    ]);

    const badge = container.querySelector(".chat-duplicate-count");
    expect(badge?.textContent?.trim()).toBe("×4");
    expect(badge?.getAttribute("aria-label")).toBe("4 consecutive identical messages collapsed");
  });

  it("does not render the stale assistant read-aloud footer action", () => {
    const container = document.createElement("div");
    renderAssistantMessage(container, {
      role: "assistant",
      content: "hello from assistant",
      timestamp: 1000,
    });

    expect(container.querySelector(".chat-tts-btn")).toBeNull();
    expect(container.querySelector('[aria-label="Read aloud"]')).toBeNull();
  });

  it("positions delete confirm by message side", () => {
    const container = document.createElement("div");
    clearDeleteConfirmSkip();
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          {
            role: "user",
            content: "hello from user",
            timestamp: 1000,
          },
          "user",
        ),
        createMessageGroup(
          {
            role: "assistant",
            content: "hello from assistant",
            timestamp: 1001,
          },
          "assistant",
        ),
      ],
      { onDelete: vi.fn() },
    );

    const userDeleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.user .chat-group-delete",
    );
    expect(userDeleteButton).toBeInstanceOf(HTMLButtonElement);
    userDeleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const userConfirm = container.querySelector<HTMLElement>(
      ".chat-group.user .chat-delete-confirm",
    );
    expect(userConfirm).toBeInstanceOf(HTMLElement);
    expect([...userConfirm!.classList]).toEqual([
      "chat-delete-confirm",
      "chat-delete-confirm--left",
    ]);

    const assistantDeleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.assistant .chat-group-delete",
    );
    expect(assistantDeleteButton).toBeInstanceOf(HTMLButtonElement);
    assistantDeleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const assistantConfirm = container.querySelector<HTMLElement>(
      ".chat-group.assistant .chat-delete-confirm",
    );
    expect(assistantConfirm).toBeInstanceOf(HTMLElement);
    expect([...assistantConfirm!.classList]).toEqual([
      "chat-delete-confirm",
      "chat-delete-confirm--right",
    ]);
  });

  it("removes the delete confirm outside-click listener when Cancel dismisses it", () => {
    const fixture = setupArmedDeleteConfirm();
    const cancel = fixture.container.querySelector<HTMLButtonElement>(
      ".chat-delete-confirm__cancel",
    );

    expect(cancel).toBeInstanceOf(HTMLButtonElement);
    cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectDeleteConfirmDismissed(fixture);
    expect(fixture.onDelete).not.toHaveBeenCalled();
  });

  it("removes the delete confirm outside-click listener when Delete dismisses it", () => {
    const fixture = setupArmedDeleteConfirm();
    const confirm = fixture.container.querySelector<HTMLButtonElement>(".chat-delete-confirm__yes");

    expect(confirm).toBeInstanceOf(HTMLButtonElement);
    confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectDeleteConfirmDismissed(fixture);
    expect(fixture.onDelete).toHaveBeenCalledTimes(1);
  });

  it("removes the delete confirm outside-click listener when an outside click dismisses it", () => {
    const fixture = setupArmedDeleteConfirm();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectDeleteConfirmDismissed(fixture);
    expect(fixture.onDelete).not.toHaveBeenCalled();
  });

  it("removes the delete confirm outside-click listener when the delete button toggles it", () => {
    const fixture = setupArmedDeleteConfirm();

    openDeleteConfirm(fixture.deleteButton);

    expectDeleteConfirmDismissed(fixture);
    expect(fixture.onDelete).not.toHaveBeenCalled();
  });

  it("removes the delete confirm outside-click listener when the delete button icon toggles it", () => {
    const fixture = setupArmedDeleteConfirm();

    clickDeleteButtonIconPath(fixture.deleteButton);

    expectDeleteConfirmDismissed(fixture);
    expect(fixture.onDelete).not.toHaveBeenCalled();
  });

  it("does not attach the delete confirm outside-click listener after an immediate toggle", () => {
    const flushAnimationFrames = stubAnimationFrameQueue();
    const addListenerSpy = vi.spyOn(document, "addEventListener");
    const fixture = renderDeleteConfirmFixture();

    openDeleteConfirm(fixture.deleteButton);
    openDeleteConfirm(fixture.deleteButton);
    flushAnimationFrames();

    expect(fixture.container.querySelector(".chat-delete-confirm")).toBeNull();
    expect(getLastCaptureClickListener(addListenerSpy.mock.calls)).toBeNull();
    expect(fixture.onDelete).not.toHaveBeenCalled();
  });

  it("renders assistant context usage from input and cache tokens", () => {
    const renderUsage = (usage: Record<string, number>, contextWindow: number) => {
      const container = document.createElement("div");
      renderAssistantMessage(
        container,
        {
          role: "assistant",
          content: "Done",
          usage,
          model: "anthropic/claude-opus-4-7",
          timestamp: 1000,
        },
        { contextWindow },
      );
      return container;
    };

    const cached = renderUsage(
      {
        input: 1,
        output: 1200,
        cacheRead: 438_400,
        cacheWrite: 307,
      },
      1_000_000,
    );
    const meta = cached.querySelector<HTMLDetailsElement>("details.msg-meta");
    expect(meta?.open).toBe(false);
    expect(meta?.querySelector(".msg-meta__summary span:last-child")?.textContent).toBe("Context");
    expect(cached.querySelector(".msg-meta__ctx")?.textContent).toBe("44% ctx");
    expect(
      Array.from(cached.querySelectorAll(".msg-meta__cache")).map((node) => node.textContent),
    ).toEqual(["R438.4k", "W307"]);

    const outputHeavy = renderUsage(
      {
        input: 1_000,
        output: 9_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      10_000,
    );
    expect(outputHeavy.querySelector(".msg-meta__ctx")?.textContent).toBe("10% ctx");
  });

  it("uses the largest single assistant call for grouped context usage", () => {
    const container = document.createElement("div");

    renderAssistantMessages(
      container,
      [
        {
          role: "assistant",
          content: "Checking",
          usage: { input: 105_944, output: 100 },
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: "Done",
          usage: { input: 108_577, output: 100 },
          timestamp: 1001,
        },
      ],
      { contextWindow: 258_400 },
    );

    expect(container.querySelector(".msg-meta__ctx")?.textContent).toBe("42% ctx");
    expect(container.querySelector(".msg-meta__tokens")?.textContent).toBe("↑214.5k");
  });

  it("renders full dates with message and streaming timestamps", () => {
    const container = document.createElement("div");
    const timestamp = Date.UTC(2026, 3, 24, 18, 30);

    renderAssistantMessage(container, {
      role: "assistant",
      content: "Done",
      timestamp,
    });

    const time = container.querySelector<HTMLTimeElement>(".chat-group-timestamp");
    const display = formatChatTimestampForDisplay(timestamp);
    expect(time?.dateTime).toBe(display.dateTime);
    expect(time?.textContent?.trim()).toBe(display.label);
    expect(time?.getAttribute("title")).toBe(display.title);

    render(renderStreamingGroup("Working", timestamp), container);

    const streamingTime = container.querySelector<HTMLTimeElement>(".chat-group-timestamp");
    expect(streamingTime?.textContent?.trim()).toBe(display.label);
  });

  it("renders configured local user names", () => {
    const renderUser = (opts: Partial<RenderMessageGroupOptions>) => {
      const container = document.createElement("div");
      renderGroupedMessage(
        container,
        {
          role: "user",
          content: "hello",
          timestamp: 1000,
        },
        "user",
        opts,
      );
      return container;
    };

    const named = renderUser({ userName: "Buns" });
    const sender = named.querySelector<HTMLElement>(".chat-group.user .chat-sender-name");
    expect(sender?.textContent).toBe("Buns");

    const avatar = named.querySelector<HTMLElement>(".chat-avatar.user");
    expect(avatar?.tagName).toBe("DIV");
  });

  it("keeps inline tool cards collapsed by default and renders expanded state", () => {
    const container = document.createElement("div");
    const message = {
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
    };
    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => false,
    });

    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => true,
    });

    const blocks = Array.from(container.querySelectorAll(".chat-tool-card__block"));
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool input", "Tool output"]);
    expect(blocks.map((block) => block.querySelector("code")?.textContent)).toEqual([
      '{\n  "url": "https://example.com"\n}',
      "Opened page",
    ]);
  });

  it("renders expanded standalone tool-call rows", () => {
    const container = document.createElement("div");
    const message = {
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
    };
    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => false,
    });

    expectElement(container, ".chat-bubble--tool-shell", HTMLElement);
    const summary = container.querySelector<HTMLElement>(".chat-tool-msg-summary");
    expect(summary?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "sessions_spawn",
    );
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => true,
    });

    expect(container.querySelector(".chat-tool-card__block-label")?.textContent).toBe("Tool input");
    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(
      '{\n  "mode": "session",\n  "thread": true\n}',
    );
  });

  it("renders expanded tool output rows and their json content", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
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
          "assistant",
        ),
        createMessageGroup(
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
          "tool",
        ),
      ],
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
      },
    );

    const blocks = Array.from(container.querySelectorAll(".chat-tool-card__block"));
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool input", "Tool output"]);
    expect(blocks[0]?.querySelector("code")?.textContent).toBe(
      '{\n  "mode": "session",\n  "thread": true\n}',
    );
    expect(JSON.parse(blocks[1]?.querySelector("code")?.textContent ?? "{}")).toEqual({
      status: "error",
      error: "Session mode is unavailable for this target.",
      childSessionKey: "agent:test:subagent:abc123",
    });
  });

  it("collapses an inline tool call while keeping matching tool output visible", () => {
    const container = document.createElement("div");
    const groups = [
      createMessageGroup(
        {
          id: "assistant-tool-messages",
          role: "assistant",
          toolCallId: "call-tool-messages",
          content: [
            {
              type: "toolcall",
              id: "call-tool-messages",
              name: "sessions_spawn",
              arguments: { mode: "session", thread: true },
            },
          ],
          timestamp: Date.now(),
        },
        "assistant",
      ),
      createMessageGroup(
        {
          id: "tool-tool-messages",
          role: "tool",
          toolCallId: "call-tool-messages",
          toolName: "sessions_spawn",
          content: JSON.stringify({ status: "error" }, null, 2),
          timestamp: Date.now() + 1,
        },
        "tool",
      ),
    ];
    renderMessageGroups(container, groups, {
      isToolMessageExpanded: () => true,
    });

    expect(container.querySelector(".chat-tool-card__block-label")?.textContent).toBe("Tool input");
    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(
      '{\n  "mode": "session",\n  "thread": true\n}',
    );
    expect(
      JSON.parse(container.querySelector(".chat-json-content code")?.textContent ?? "{}"),
    ).toEqual({
      status: "error",
    });

    renderMessageGroups(container, groups, {
      isToolMessageExpanded: (messageId) => !messageId.startsWith("toolmsg:assistant:"),
    });

    expect(container.querySelector(".chat-tool-card__block")).toBeNull();
    expect(
      JSON.parse(container.querySelector(".chat-json-content code")?.textContent ?? "{}"),
    ).toEqual({
      status: "error",
    });
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

    expect(container.querySelector(".chat-reply-pill__label")?.textContent?.trim()).toBe(
      "Replying to current message",
    );
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("Here is the image.");
    expect(expectElement(container, ".chat-message-image", HTMLImageElement).src).toBe(
      "https://example.com/photo.png",
    );
    expect(expectElement(container, "audio", HTMLAudioElement).src).toBe(
      "https://example.com/voice.ogg",
    );
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Voice note",
    );
  });

  it("renders allowed transcript and content image variants", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.pathname).toBe("/openclaw/__openclaw__/assistant-media");
      expect([...mediaUrl.searchParams.keys()].toSorted()).toEqual(["meta", "source"]);
      expect(mediaUrl.searchParams.get("meta")).toBe("1");
      expect(mediaUrl.searchParams.get("source")).toMatch(/^\/tmp\/openclaw\/.+\.(png|jpg)$/u);
      const headers = init?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer session-token");
      return {
        ok: true,
        json: async () => mediaTicketPayload("ticket-user"),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const renderUserMedia = (message: unknown) => {
      const container = document.createElement("div");
      const renderMessage = () =>
        renderGroupedMessage(container, message, "user", {
          showToolCalls: false,
          basePath: "/openclaw",
          assistantAttachmentAuthToken: "session-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: renderMessage,
        });
      renderMessage();
      return container;
    };

    let container = renderUserMedia({
      id: "user-history-image",
      role: "user",
      content: "",
      MediaPath: "/tmp/openclaw/user-upload.png",
      timestamp: Date.now(),
    });
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Fuser-upload.png&mediaTicket=ticket-user",
    );

    container = renderUserMedia({
      id: "user-history-image-octet-stream",
      role: "user",
      content: "",
      MediaPath: "/tmp/openclaw/user-upload.png",
      MediaType: "application/octet-stream",
      timestamp: Date.now(),
    });
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Fuser-upload.png&mediaTicket=ticket-user",
    );

    container = renderUserMedia({
      id: "user-history-images",
      role: "user",
      content: "",
      MediaPaths: ["/tmp/openclaw/first.png", "/tmp/openclaw/second.jpg"],
      MediaTypes: ["image/png", "application/octet-stream"],
      timestamp: Date.now(),
    });
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      [...container.querySelectorAll<HTMLImageElement>(".chat-message-image")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ffirst.png&mediaTicket=ticket-user",
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Fsecond.jpg&mediaTicket=ticket-user",
    ]);

    const assistantContainer = document.createElement("div");
    renderAssistantMessage(
      assistantContainer,
      {
        role: "assistant",
        content: [{ type: "input_image", image_url: "data:image/png;base64,cG5n" }],
        timestamp: Date.now(),
      },
      { showToolCalls: false },
    );
    expect(
      assistantContainer
        .querySelector<HTMLImageElement>(".chat-message-image")
        ?.getAttribute("src"),
    ).toBe("data:image/png;base64,cG5n");

    container = renderUserMedia({
      id: "user-history-image-blocked",
      role: "user",
      content: "",
      MediaPath: "/Users/test/Documents/private.png",
      MediaType: "image/png",
      timestamp: Date.now(),
    });
    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(container.querySelector(".chat-bubble")).toBeNull();

    container = renderUserMedia({
      id: "user-history-document",
      role: "user",
      content: "",
      MediaPath: "/__openclaw__/media/user-upload.pdf",
      MediaType: "application/pdf",
      timestamp: Date.now(),
    });
    expect(container.querySelector(".chat-message-image")).toBeNull();
    const documentLink = container.querySelector<HTMLAnchorElement>(
      ".chat-assistant-attachment-card__link",
    );
    expect(documentLink?.textContent?.trim()).toBe("user-upload.pdf");
    expect(documentLink?.getAttribute("href")).toBe("/__openclaw__/media/user-upload.pdf");
    vi.unstubAllGlobals();
  });

  it("fetches managed chat images with auth and renders blob previews", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const objectUrl = "blob:managed-image";
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => objectUrl),
        revokeObjectURL: vi.fn(),
      }),
    );
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer session-token");
      expect(headers.get("x-openclaw-requester-session-key")).toBe("agent:main:main");
      return {
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [
          {
            type: "image",
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full",
            alt: "Generated image 1",
            width: 1,
            height: 1,
          },
        ],
        timestamp: Date.now(),
      },
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "session-token",
      },
    );

    await vi.waitFor(
      () => {
        const image = container.querySelector<HTMLImageElement>(".chat-message-image");
        expect(image?.getAttribute("src")).toBe(objectUrl);
        expect(image?.getAttribute("alt")).toBe("Generated image 1");
      },
      { interval: 1, timeout: 100 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchInit] = requireFetchCall(fetchMock);
    expect(fetchUrl).toBe(
      "/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full",
    );
    expectSameOriginGet(fetchInit);
  });

  it("does not send auth to cross-origin managed-image-looking URLs", () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("cross-origin image URL should not be fetched with Control UI auth");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [
          {
            type: "image",
            url: "https://evil.example/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full",
            alt: "Untrusted image",
          },
        ],
        timestamp: Date.now(),
      },
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "session-token",
      },
    );

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image?.getAttribute("src")).toBe(
      "https://evil.example/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders canvas-only [embed] shortcodes inside the assistant bubble", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
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
      { showToolCalls: false },
    );

    expectElement(container, ".chat-bubble", HTMLElement);
    const iframe = expectElement(container, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("title")).toBe("Tic-Tac-Toe");
    expect(container.querySelector(".chat-tool-card__preview-label")?.textContent?.trim()).toBe(
      "Tic-Tac-Toe",
    );
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
      expect(image).toBeInstanceOf(HTMLImageElement);
      image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com/cat.png",
        "_blank",
        "noopener,noreferrer",
      );

      openSpy.mockClear();
      renderAssistantImage("javascript:alert(1)");
      image = container.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image).toBeInstanceOf(HTMLImageElement);
      image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(openSpy).not.toHaveBeenCalled();

      renderAssistantImage("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />");
      image = container.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image).toBeInstanceOf(HTMLImageElement);
      image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("renders verified local assistant attachments through the Control UI media route", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("meta=1")) {
        const headers = init?.headers as Headers;
        expect(headers.get("Authorization")).toBe("Bearer session-token");
        return {
          ok: true,
          json: async () => mediaTicketPayload("ticket-local"),
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
    expect(
      Array.from(container.querySelectorAll(".chat-assistant-attachment-badge")).map((badge) =>
        badge.textContent?.trim(),
      ),
    ).toEqual(["Checking...", "Checking..."]);
    await flushAssistantAttachmentAvailabilityChecks();

    const [, fetchInit] = requireFetchCallForUrl(
      fetchMock,
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&meta=1",
    );
    expectSameOriginGet(fetchInit);

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    const docLink = container.querySelector<HTMLAnchorElement>(
      ".chat-assistant-attachment-card__link",
    );
    expect(image?.getAttribute("src")).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&mediaTicket=ticket-local",
    );
    expect(docLink?.getAttribute("href")).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest-doc.pdf&mediaTicket=ticket-local",
    );
    expect(image?.getAttribute("alt")).toBe("test image.png");
    expect(container.querySelector(".chat-assistant-attachment-card__title")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("refreshes cached local assistant media tickets before they expire without another render", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const fetchMock = vi
      .fn<
        (url: string, init?: RequestInit) => Promise<{ ok: true; json: () => Promise<unknown> }>
      >()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mediaTicketPayload("ticket-old", 31_000),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mediaTicketPayload("ticket-new"),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const renderMessage = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-media-ticket-refresh",
          role: "assistant",
          content: "Local image\nMEDIA:/tmp/openclaw/test image.png",
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
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&mediaTicket=ticket-old",
    );

    vi.advanceTimersByTime(1_001);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&mediaTicket=ticket-new",
    );
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rechecks local assistant attachment availability when the auth token changes", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes("meta=1")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const headers = init?.headers as Headers;
      const authorized = headers.get("Authorization") === "Bearer fresh-token";
      return {
        ok: true,
        json: async () => (authorized ? mediaTicketPayload("ticket-fresh") : { available: false }),
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
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Unavailable",
    );
    expect(
      container.querySelector(".chat-assistant-attachment-card__reason")?.textContent?.trim(),
    ).toBe("Attachment unavailable");

    renderWithToken("fresh-token");
    await flushAssistantAttachmentAvailabilityChecks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstFetchUrl, firstFetchInit] = requireFetchCall(fetchMock, 0);
    expect(firstFetchUrl).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&meta=1",
    );
    expectSameOriginGet(firstFetchInit);
    const [secondFetchUrl, secondFetchInit] = requireFetchCall(fetchMock, 1);
    expect(secondFetchUrl).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&meta=1",
    );
    expectSameOriginGet(secondFetchInit);
    const image = expectElement(container, ".chat-message-image", HTMLImageElement);
    expect(image.getAttribute("src")).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&mediaTicket=ticket-fresh",
    );
    expect(container.querySelector(".chat-assistant-attachment-badge")).toBeNull();
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
    expect(container.querySelector(".chat-assistant-attachment-badge")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).toBeNull();
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
    const blockedCard = container.querySelector(".chat-assistant-attachment-card--blocked");
    expect(blockedCard?.querySelector(".chat-assistant-attachment-card__title")?.textContent).toBe(
      "private.pdf",
    );
    expect(blockedCard?.querySelector(".chat-assistant-attachment-badge")?.textContent).toBe(
      "Unavailable",
    );
    expect(
      blockedCard?.querySelector(".chat-assistant-attachment-card__reason")?.textContent?.trim(),
    ).toBe("Outside allowed folders");
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("Blocked\nDone");
  });

  it("allows platform-specific local assistant attachments inside preview roots", async () => {
    resetAssistantAttachmentAvailabilityCacheForTest();
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("meta=1")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return {
        ok: true,
        json: async () => mediaTicketPayload("ticket-platform"),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");

    const renderCase = (params: { expectedUrl: string; message: unknown; roots: string[] }) => {
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

    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
    for (const [index, expectedUrl] of cases.entries()) {
      const [fetchUrl, fetchInit] = requireFetchCall(fetchMock, index);
      expect(fetchUrl).toBe(expectedUrl);
      expectSameOriginGet(fetchInit);
    }
    expect(
      Array.from(container.querySelectorAll(".chat-assistant-attachment-badge")).map((badge) =>
        badge.textContent?.trim(),
      ),
    ).toEqual(["Checking..."]);
    expect(container.querySelector(".chat-assistant-attachment-card__reason")).toBeNull();
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
        json: async () => mediaTicketPayload("ticket-retry"),
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
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Unavailable",
    );
    expect(
      container.querySelector(".chat-assistant-attachment-card__reason")?.textContent?.trim(),
    ).toBe("Attachment unavailable");

    vi.advanceTimersByTime(5_001);
    renderMessage();
    await flushAssistantAttachmentAvailabilityChecks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      expectElement(container, ".chat-message-image", HTMLImageElement).getAttribute("src"),
    ).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ftest+image.png&mediaTicket=ticket-retry",
    );
    expect(container.querySelector(".chat-assistant-attachment-badge")).toBeNull();

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
        canvasPluginSurfaceUrl: "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
      },
    );

    const iframe = container.querySelector(".chat-tool-card__preview-frame");
    expect(iframe?.getAttribute("src")).toBe(
      "http://127.0.0.1:19003/__openclaw__/cap/cap_123/__openclaw__/canvas/documents/cv_inline_scoped/index.html",
    );
  });

  it("renders server-history canvas blocks for the live toolResult sequence after history reload", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
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
      { showToolCalls: true },
    );

    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(1);
    const bubble = expectElement(container, ".chat-group.assistant .chat-bubble", HTMLElement);
    const iframe = expectElement(bubble, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("src")).toBe(
      "/__openclaw__/canvas/documents/cv_canvas_live_history/index.html",
    );
    expect(bubble.querySelector(".chat-text")?.textContent?.trim()).toBe("This item is ready.");
    expect(bubble.querySelector(".chat-tool-card__preview-label")?.textContent?.trim()).toBe(
      "Live history preview",
    );
  });

  it("renders hidden assistant_message canvas results with the configured sandbox", () => {
    const container = document.createElement("div");
    const renderCanvas = (params: { embedSandboxMode?: "trusted"; suffix: string }) =>
      renderMessageGroups(
        container,
        [
          createMessageGroup(
            {
              id: `assistant-canvas-inline-${params.suffix}`,
              role: "assistant",
              content: [
                { type: "text", text: "Inline canvas result." },
                createAssistantCanvasBlock({ suffix: params.suffix }),
              ],
              timestamp: Date.now(),
            },
            "assistant",
          ),
        ],
        {
          embedSandboxMode: params.embedSandboxMode ?? "scripts",
        },
      );

    renderCanvas({ suffix: "default" });

    let iframe = expectElement(container, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("src")).toBe(
      "/__openclaw__/canvas/documents/cv_inline_default/index.html",
    );
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe(
      "Inline canvas result.",
    );
    expect(container.querySelector(".chat-tool-card__preview-label")?.textContent?.trim()).toBe(
      "Inline demo",
    );
    expect(container.querySelector(".chat-tool-card__raw-toggle")?.textContent?.trim()).toBe(
      "Raw details",
    );

    renderCanvas({ embedSandboxMode: "trusted", suffix: "trusted" });
    iframe = expectElement(container, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("renders assistant_message canvas results in the assistant bubble even when tool rows are visible", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          {
            id: "assistant-canvas-inline-visible",
            role: "assistant",
            content: [
              { type: "text", text: "Inline canvas result." },
              createAssistantCanvasBlock({ suffix: "visible" }),
            ],
            timestamp: Date.now(),
          },
          "assistant",
        ),
        createMessageGroup(
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
          "tool",
        ),
      ],
      {
        isToolMessageExpanded: () => true,
      },
    );

    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(1);
    const bubble = expectElement(container, ".chat-group.assistant .chat-bubble", HTMLElement);
    const iframe = expectElement(bubble, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("src")).toBe(
      "/__openclaw__/canvas/documents/cv_inline_visible/index.html",
    );
    expect(bubble.querySelector(".chat-text")?.textContent?.trim()).toBe("Inline canvas result.");
    expect(bubble.querySelector(".chat-tool-card__preview-label")?.textContent?.trim()).toBe(
      "Inline demo",
    );
    expect(
      container.querySelector(".chat-group.tool .chat-tool-msg-summary__label")?.textContent,
    ).toBe("Tool output");
    expect(
      container.querySelector(".chat-group.tool .chat-tool-msg-summary__names")?.textContent,
    ).toBe("canvas_render");
  });

  it("opens generic tool details instead of a canvas preview from tool rows", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          {
            id: "assistant-canvas-sidebar",
            role: "assistant",
            content: [{ type: "text", text: "Sidebar canvas result." }],
            timestamp: Date.now(),
          },
          "assistant",
        ),
        createMessageGroup(
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
          "tool",
        ),
      ],
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
        onOpenSidebar,
      },
    );

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");
    expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
    sidebarButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    expect(requireFirstMockArg(onOpenSidebar, "sidebar open").kind).toBe("markdown");
  });
});
