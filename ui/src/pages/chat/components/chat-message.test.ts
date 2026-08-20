/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as markdown from "../../../components/markdown.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { setAvatarGatewayOrigin } from "../../../lib/identity-avatar.ts";
import * as localStorageModule from "../../../local-storage.ts";
import * as chatAvatar from "../chat-avatar.ts";
import { buildCachedChatItems } from "../chat-thread.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { renderChatNotice } from "./chat-divider.ts";
import { isTextyDocumentAttachment } from "./chat-message-document-preview.ts";
import {
  getChatMediaRenderVersion,
  releaseChatMediaResourceSubscriber,
} from "./chat-message-media.ts";
import {
  dismissConfirmedActionPopovers,
  renderActivityGroup,
  renderMessageGroup,
  renderStreamGroup,
} from "./chat-message.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

const localStorageValues = new Map<string, string>();
const documentPreviewSubscribers = new Set<() => void>();
const renderMarkdownHtml = markdown.toSanitizedMarkdownHtml;
const markdownRenderMock = vi.fn(
  (value: string, _options?: { codeBlockChrome?: "copy" | "none"; fileLinks?: boolean }) => value,
);
const streamingMarkdownRenderMock = vi.fn(
  (value: string, _options?: { codeBlockChrome?: "copy" | "none"; fileLinks?: boolean }) =>
    `<div class="streaming-markdown">${value}</div>`,
);

function getSafeLocalStorageMock(): Storage {
  return {
    get length() {
      return localStorageValues.size;
    },
    clear: () => localStorageValues.clear(),
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  };
}

function renderChatAvatarMock(
  ...[role]: Parameters<typeof chatAvatar.renderChatAvatar>
): ReturnType<typeof chatAvatar.renderChatAvatar> {
  return html`<div class="chat-avatar ${role}"></div>`;
}

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
  return arg;
}

function selectText(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function pointerClick(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

beforeEach(() => {
  vi.spyOn(localStorageModule, "getSafeLocalStorage").mockImplementation(getSafeLocalStorageMock);
  vi.spyOn(markdown, "toSanitizedMarkdownHtml").mockImplementation(markdownRenderMock);
  vi.spyOn(markdown, "toStreamingMarkdownHtml").mockImplementation(streamingMarkdownRenderMock);
  vi.spyOn(chatAvatar, "renderChatAvatar").mockImplementation(renderChatAvatarMock);
});

type RenderMessageGroupOptions = Parameters<typeof renderMessageGroup>[1];
type TestMessage = Record<string, unknown>;

function messageTimestamp(message: unknown): number {
  return typeof message === "object" &&
    message !== null &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
    ? (message as { timestamp: number }).timestamp
    : Date.now();
}

function createAssistantMessage(content: unknown, overrides: TestMessage = {}): TestMessage {
  const timestamp = typeof overrides.timestamp === "number" ? overrides.timestamp : Date.now();
  return { role: "assistant", content, timestamp, ...overrides };
}

function createUserMessage(content: unknown, overrides: TestMessage = {}): TestMessage {
  const timestamp = typeof overrides.timestamp === "number" ? overrides.timestamp : Date.now();
  return { role: "user", content, timestamp, ...overrides };
}

function createToolCall(id: string, name: string, args: unknown, overrides: TestMessage = {}) {
  return { type: "toolcall", id, name, arguments: args, ...overrides };
}

function createToolResultBlock(
  id: string,
  name: string,
  text: string,
  overrides: TestMessage = {},
) {
  return { type: "tool_result", id, name, text, ...overrides };
}

function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  content: unknown,
  overrides: TestMessage = {},
): TestMessage {
  const timestamp = typeof overrides.timestamp === "number" ? overrides.timestamp : Date.now();
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    timestamp,
    ...overrides,
  };
}

function createMediaBlock(overrides: TestMessage) {
  return { type: "image", ...overrides };
}

function createAssistantImageMessage(
  url: string,
  alt: string,
  imageOverrides: TestMessage = {},
  messageOverrides: TestMessage = {},
) {
  return createAssistantMessage(
    [createMediaBlock({ url, alt, ...imageOverrides })],
    messageOverrides,
  );
}

function createAssistantAudioMessage(
  url: string,
  audioOverrides: TestMessage = {},
  messageOverrides: TestMessage = {},
) {
  return createAssistantMessage([{ type: "audio", url, ...audioOverrides }], messageOverrides);
}

function createAttachmentBlock(
  url: string,
  kind: "audio" | "video" | "document",
  label: string,
  mimeType: string,
  attachmentOverrides: TestMessage = {},
) {
  return {
    type: "attachment",
    attachment: { url, kind, label, mimeType, ...attachmentOverrides },
  };
}

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

function rejectWhenAborted<T>(signal: AbortSignal, rejection: () => Error): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(rejection()), { once: true });
  });
}

function renderTestMessageGroup(
  group: MessageGroup,
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  return renderMessageGroup(group, {
    showReasoning: true,
    showToolCalls: true,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    ...opts,
  });
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
  const group = createMessageGroup(messages[0], "assistant", {
    key: "assistant-group",
    messages: messages.map((message, index) => ({
      key: `assistant-message-${index}`,
      message,
    })),
  });
  render(renderTestMessageGroup(group, opts), container);
}

function renderAssistantMessageEntries(
  container: HTMLElement,
  entries: MessageGroup["messages"],
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const group = createMessageGroup(entries[0]?.message, "assistant", {
    key: "assistant-group",
    messages: entries,
    timestamp: Date.now(),
  });
  render(renderTestMessageGroup(group, opts), container);
}

function renderGroupedMessage(
  container: HTMLElement,
  message: unknown,
  role: string,
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const group = createMessageGroup(message, role, {
    key: `${role}-group`,
    messages: [{ key: `${role}-message`, message }],
  });
  render(renderTestMessageGroup(group, opts), container);
}

function createMessageGroup(
  message: unknown,
  role: string,
  overrides: Partial<MessageGroup> = {},
): MessageGroup {
  const timestamp = overrides.timestamp ?? messageTimestamp(message);
  return {
    kind: "group",
    key: `${role}:${timestamp}`,
    role,
    messages: [{ key: `${role}:${timestamp}:message`, message }],
    timestamp,
    isStreaming: false,
    ...overrides,
  };
}

function createMessageEntry(key: string, message: unknown): MessageGroup["messages"][number] {
  return { key, message };
}

function createToolGroup(
  key: string,
  messages: MessageGroup["messages"],
  overrides: Partial<MessageGroup> = {},
): MessageGroup {
  return createMessageGroup(messages[0]?.message, "tool", { key, messages, ...overrides });
}

describe("cloud workspace conflict transcript messages", () => {
  it("renders the custom event as a bounded structured status card", () => {
    const container = document.createElement("div");
    renderGroupedMessage(
      container,
      {
        role: "custom",
        customType: "cloud-workspace-conflict",
        content: "fallback summary that should not render as plain text",
        details: {
          paths: [
            "src/one.ts",
            "src/two.ts",
            "src/three.ts",
            "src/four.ts",
            "src/five.ts",
            "src/six.ts",
          ],
          stagedResultRef: "refs/openclaw/worker-results/claim-456",
          totalCount: 7,
        },
        timestamp: 1,
      },
      "custom",
    );

    expect(container.querySelector(".chat-group.workspace-conflict")).not.toBeNull();
    const card = expectElement(container, ".chat-workspace-conflict-event", HTMLDivElement);
    expect(card.textContent).toContain("Cloud result applied with 7 conflicts");
    expect(card.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
    expect(card.textContent).toContain("+2 more paths");
    expect(card.textContent).toContain("refs/openclaw/worker-results/claim-456");
    expect(card.querySelector(".chat-text")).toBeNull();
    expect(container.querySelector(".chat-sender-name")?.textContent).toBe("Cloud workspace");
  });

  it("renders terminal-control filenames as escaped durable history", () => {
    const container = document.createElement("div");
    renderGroupedMessage(
      container,
      {
        role: "custom",
        customType: "cloud-workspace-conflict",
        content: "fallback summary",
        details: {
          paths: ["src/line\nbreak.ts"],
          stagedResultRef: "refs/openclaw/worker-results/claim-control",
        },
        timestamp: 1,
      },
      "custom",
    );

    expect(container.querySelector(".chat-workspace-conflict-paths code")?.textContent).toBe(
      "src/line\\u{000a}break.ts",
    );
    expect(container.textContent).toContain("refs/openclaw/worker-results/claim-control");
  });
});

function createCanvasPreview(params: {
  viewId: string;
  title?: string;
  url?: string;
  preferredHeight?: number;
}) {
  return {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    viewId: params.viewId,
    title: params.title ?? "Inline demo",
    url: params.url ?? `/__openclaw__/canvas/documents/${params.viewId}/index.html`,
    preferredHeight: params.preferredHeight ?? 360,
  };
}

function createAssistantCanvasBlock(params: {
  suffix: string;
  title?: string;
  url?: string;
  preferredHeight?: number;
  presentationTarget?: "assistant_message" | "tool_card";
  mcpApp?: { viewId: string };
}) {
  const viewId = `cv_inline_${params.suffix}`;
  const preview = {
    ...createCanvasPreview({ ...params, viewId }),
    ...(params.mcpApp ? { mcpApp: params.mcpApp } : {}),
  };
  return {
    type: "canvas",
    preview,
    rawText: JSON.stringify({
      kind: "canvas",
      view: {
        backend: "canvas",
        id: viewId,
        url: preview.url,
        title: preview.title,
        preferred_height: preview.preferredHeight,
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
  render(html`${groups.map((group) => renderTestMessageGroup(group, opts))}`, container);
}

function clearConfirmedActionSkip() {
  localStorageValues.delete("openclaw:skip-rewind-confirm");
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

function getLastCaptureContextMenuListener(calls: readonly unknown[][]) {
  for (let index = calls.length - 1; index >= 0; index--) {
    const [type, listener, options] = calls[index] ?? [];
    if (type === "contextmenu" && options === true && listener) {
      return listener;
    }
  }
  return null;
}

function countCaptureClickListenerRemovals(calls: readonly unknown[][], listener: unknown) {
  return calls.filter(
    ([type, removedListener, options]) =>
      type === "click" && options === true && removedListener === listener,
  ).length;
}

function countCaptureContextMenuListenerRemovals(calls: readonly unknown[][], listener: unknown) {
  return calls.filter(
    ([type, removedListener, options]) =>
      type === "contextmenu" && options === true && removedListener === listener,
  ).length;
}

function getLastCaptureKeydownListener(calls: readonly unknown[][]) {
  for (let index = calls.length - 1; index >= 0; index--) {
    const [type, listener, options] = calls[index] ?? [];
    if (type === "keydown" && options === true && listener) {
      return listener;
    }
  }
  return null;
}

function countCaptureKeydownListenerRemovals(calls: readonly unknown[][], listener: unknown) {
  return calls.filter(
    ([type, removedListener, options]) =>
      type === "keydown" && options === true && removedListener === listener,
  ).length;
}

function renderConfirmedActionFixture() {
  const container = document.createElement("div");
  container.dataset.confirmedActionFixture = "true";
  document.body.appendChild(container);
  const onAction = vi.fn();
  clearConfirmedActionSkip();
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
    ],
    { onRewind: onAction },
  );
  const actionButton = container.querySelector<HTMLButtonElement>(".chat-group-rewind");
  expect(actionButton).toBeInstanceOf(HTMLButtonElement);
  return { actionButton: actionButton!, container, onAction };
}

function openConfirmedAction(actionButton: HTMLButtonElement) {
  actionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function domRect(params: {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}): DOMRect {
  const left = params.left ?? 0;
  const top = params.top ?? 0;
  const width = params.width ?? 0;
  const height = params.height ?? 0;
  const rect = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => rect,
  };
  return rect as DOMRect;
}

function stubConfirmedActionGeometry(params: {
  trigger: { left: number; top: number; width: number; height: number };
  popover: { width: number; height: number };
  viewport: { left?: number; top?: number; width: number; height: number };
}) {
  vi.stubGlobal("innerWidth", params.viewport.width);
  vi.stubGlobal("innerHeight", params.viewport.height);
  vi.stubGlobal("visualViewport", {
    height: params.viewport.height,
    offsetLeft: params.viewport.left ?? 0,
    offsetTop: params.viewport.top ?? 0,
    width: params.viewport.width,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("chat-group-rewind")) {
        return domRect(params.trigger);
      }
      if (this.classList.contains("chat-confirm-popover")) {
        return domRect(params.popover);
      }
      return domRect({});
    },
  );
}

function clickConfirmedActionIconPath(actionButton: HTMLButtonElement) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  icon.appendChild(path);
  actionButton.appendChild(icon);
  path.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function setupArmedConfirmedAction() {
  const flushAnimationFrames = stubAnimationFrameQueue();
  const addListenerSpy = vi.spyOn(document, "addEventListener");
  const removeListenerSpy = vi.spyOn(document, "removeEventListener");
  const addKeyListenerSpy = vi.spyOn(window, "addEventListener");
  const removeKeyListenerSpy = vi.spyOn(window, "removeEventListener");
  const fixture = renderConfirmedActionFixture();

  openConfirmedAction(fixture.actionButton);
  flushAnimationFrames();

  const outsideClickListener = expectLastCaptureClickListener(addListenerSpy.mock.calls);
  const outsideContextMenuListener = getLastCaptureContextMenuListener(addListenerSpy.mock.calls);
  const escapeListener = getLastCaptureKeydownListener(addKeyListenerSpy.mock.calls);
  const popover = expectElement(document.body, ".chat-confirm-popover", HTMLElement);
  expect(typeof outsideContextMenuListener).toBe("function");
  expect(typeof escapeListener).toBe("function");

  return {
    ...fixture,
    escapeListener,
    outsideClickListener,
    outsideContextMenuListener,
    popover,
    removeKeyListenerSpy,
    removeListenerSpy,
  };
}

function expectConfirmedActionDismissed(params: {
  escapeListener: unknown;
  outsideClickListener: unknown;
  outsideContextMenuListener: unknown;
  popover: HTMLElement;
  removeKeyListenerSpy: ReturnType<typeof vi.spyOn>;
  removeListenerSpy: ReturnType<typeof vi.spyOn>;
}) {
  expect(params.popover.isConnected).toBe(false);
  expect(
    countCaptureClickListenerRemovals(
      params.removeListenerSpy.mock.calls,
      params.outsideClickListener,
    ),
  ).toBe(1);
  expect(
    countCaptureContextMenuListenerRemovals(
      params.removeListenerSpy.mock.calls,
      params.outsideContextMenuListener,
    ),
  ).toBe(1);
  expect(
    countCaptureKeydownListenerRemovals(
      params.removeKeyListenerSpy.mock.calls,
      params.escapeListener,
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

async function requireAudioPlayer(container: HTMLElement) {
  const player = expectElement(
    container,
    "openclaw-chat-audio-player",
    HTMLElement,
  ) as HTMLElement & { updateComplete: Promise<unknown> };
  await player.updateComplete;
  return player;
}

async function requireVideoPlayer(container: HTMLElement) {
  const player = expectElement(
    container,
    "openclaw-chat-video-player",
    HTMLElement,
  ) as HTMLElement & { updateComplete: Promise<unknown> };
  await player.updateComplete;
  return player;
}

afterEach(() => {
  for (const subscriber of documentPreviewSubscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  documentPreviewSubscribers.clear();
  markdownRenderMock.mockClear();
  document.querySelectorAll("[data-media-player-test-fixture]").forEach((element) => {
    element.remove();
  });
  document.querySelectorAll("[data-confirmed-action-fixture]").forEach((element) => {
    dismissConfirmedActionPopovers(element);
    element.remove();
  });
  clearConfirmedActionSkip();
  setAvatarGatewayOrigin(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("grouped chat rendering", () => {
  it.each([
    ["text/plain MIME", { label: "note.bin", mimeType: "text/plain" }, true],
    ["JSON MIME", { label: "data.bin", mimeType: "application/json" }, true],
    ["NDJSON MIME", { label: "data.bin", mimeType: "application/x-ndjson" }, true],
    ["XML MIME", { label: "data.bin", mimeType: "application/xml" }, true],
    ["YAML MIME", { label: "data.bin", mimeType: "application/yaml" }, true],
    ["x-yaml MIME", { label: "data.bin", mimeType: "application/x-yaml" }, true],
    ["TOML MIME", { label: "data.bin", mimeType: "application/toml" }, true],
    ["missing MIME text extension", { label: "README.markdown" }, true],
    [
      "octet-stream text extension",
      { label: "changes.patch", mimeType: "application/octet-stream" },
      true,
    ],
    ["non-text MIME", { label: "renamed.txt", mimeType: "application/pdf" }, false],
    ["non-text extension", { label: "report.pdf" }, false],
  ] as const)("detects texty documents from $0", (_name, attachment, expected) => {
    expect(isTextyDocumentAttachment(attachment)).toBe(expected);
  });

  it("preserves paragraph breaks around assistant attachments in rendered markdown", () => {
    const container = document.createElement("div");

    renderAssistantMessage(
      container,
      createAssistantMessage(
        "First paragraph\n \nMEDIA:https://example.com/image.png\n\t\nSecond paragraph",
        { timestamp: 1000 },
      ),
    );

    expect(markdownRenderMock).toHaveBeenCalledWith(
      "First paragraph\n\nSecond paragraph",
      expect.any(Object),
    );
  });

  it("renders a compact count for collapsed duplicate messages", () => {
    const container = document.createElement("div");
    renderAssistantMessageEntries(container, [
      {
        key: "assistant-heartbeat",
        message: createAssistantMessage([{ type: "text", text: "HEARTBEAT_OK" }], {
          timestamp: 1,
        }),
        duplicateCount: 4,
      },
    ]);

    const badge = container.querySelector(".chat-duplicate-count");
    expect(badge?.textContent?.trim()).toBe("×4");
    expect(badge?.getAttribute("aria-label")).toBe("4 consecutive identical messages collapsed");
  });

  it.each([
    { markdown: "Final paragraph", owner: "p" },
    { markdown: "- first\n- final", owner: "li:last-child" },
    { markdown: "> quoted ending", owner: "blockquote p" },
  ])(
    "attaches a duplicate marker to the terminal textual owner in $owner",
    ({ markdown: markdownText, owner }) => {
      const container = document.createElement("div");
      markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
      renderAssistantMessageEntries(container, [
        {
          key: "assistant-duplicate",
          message: createAssistantMessage(markdownText, { timestamp: 1 }),
          duplicateCount: 3,
        },
      ]);

      const target = expectElement(container, owner, HTMLElement);
      expect(target.querySelector(":scope > .chat-duplicate-count")?.textContent).toBe("×3");
    },
  );

  it.each([
    { label: "fence", markdown: "Paragraph\n\n```ts\nconst value = 1;\n```", terminal: "pre" },
    {
      label: "compact details",
      markdown: "<details><summary>More</summary>body</details>",
      terminal: "details",
    },
    {
      label: "block details",
      markdown: "<details>\n<summary>More</summary>\n\nbody\n</details>",
      terminal: "details",
    },
    {
      label: "table",
      markdown: "| Name | Value |\n| --- | --- |\n| one | two |",
      terminal: ".markdown-table",
    },
  ])(
    "keeps a duplicate marker outside terminal $label content",
    ({ markdown: markdownText, terminal }) => {
      const container = document.createElement("div");
      markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
      renderAssistantMessageEntries(container, [
        {
          key: "assistant-duplicate",
          message: createAssistantMessage(markdownText, { timestamp: 1 }),
          duplicateCount: 3,
        },
      ]);

      const chatText = expectElement(container, ".chat-text", HTMLDivElement);
      const terminalBlock = expectElement(chatText, terminal, HTMLElement);
      expect(terminalBlock.querySelector(".chat-duplicate-count")).toBeNull();
      expect(chatText.querySelector(":scope > .chat-duplicate-count")?.textContent).toBe("×3");
      expect(chatText.querySelector("summary")?.textContent ?? "").not.toContain("×3");
      expect(chatText.querySelector("td:last-child")?.textContent ?? "").not.toContain("×3");
    },
  );

  it("does not render the stale assistant read-aloud footer action", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage("hello from assistant", { timestamp: 1000 }),
    );

    expect(container.querySelector(".chat-tts-btn")).toBeNull();
    expect(container.querySelector('[aria-label="Read aloud"]')).toBeNull();
  });

  it("renders assistant messages without an avatar and keeps actions in the footer row", () => {
    const container = document.createElement("div");
    renderAssistantMessage(container, createAssistantMessage("Short reply", { timestamp: 1000 }), {
      showAssistantAvatar: false,
    });

    const assistantGroup = expectElement(container, ".chat-group.assistant", HTMLElement);
    expect(assistantGroup.classList.contains("chat-group--with-footer")).toBe(true);
    expect(assistantGroup.querySelector(".chat-avatar")).toBeNull();
    expect(assistantGroup.querySelector(".chat-bubble-actions")).toBeNull();
    expect(
      assistantGroup.querySelector(".chat-group-footer-actions .chat-copy-btn"),
    ).toBeInstanceOf(HTMLElement);

    renderGroupedMessage(container, createUserMessage("Short reply", { timestamp: 1001 }), "user");

    const userBubble = expectElement(container, ".chat-group.user .chat-bubble", HTMLElement);
    expect(userBubble.classList.contains("has-copy")).toBe(false);
    expect(userBubble.querySelector(".chat-bubble-actions")).toBeNull();
  });

  it("adds Reply to the inline message actions and forwards persisted reply context", () => {
    const container = document.createElement("div");
    const onReply = vi.fn();
    renderAssistantMessage(
      container,
      createAssistantMessage("Reply with this context.", {
        timestamp: 1000,
        __openclaw: { id: "assistant-entry-1" },
      }),
      { onReply },
    );

    const actions = container.querySelectorAll<HTMLButtonElement>(
      ".chat-group-footer-actions button",
    );
    expect([...actions].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Reply to message",
      "Copy as markdown",
    ]);

    container.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')?.click();

    expect(onReply).toHaveBeenCalledWith({
      messageId: "assistant-message",
      senderLabel: "OpenClaw",
      sourceMessageId: "assistant-entry-1",
      text: "Reply with this context.",
    });

    const userContainer = document.createElement("div");
    renderGroupedMessage(
      userContainer,
      createUserMessage("User reply context.", {
        timestamp: 1001,
        __openclaw: { id: "user-entry-1" },
      }),
      "user",
      { onReply, userName: "Jason" },
    );
    userContainer.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')?.click();

    expect(onReply).toHaveBeenLastCalledWith({
      messageId: "user-message",
      senderLabel: "Jason",
      sourceMessageId: "user-entry-1",
      text: "User reply context.",
    });
  });

  it("orders user footer actions before the sender name and timestamp", () => {
    const container = document.createElement("div");
    renderGroupedMessage(container, createUserMessage("User footer order."), "user", {
      onReply: vi.fn(),
      onRewind: vi.fn(),
      userName: "Jason",
    });

    const footer = expectElement(container, ".chat-group.user .chat-group-footer", HTMLElement);
    const order = [
      ...footer.querySelectorAll<HTMLElement>("button, .chat-sender-name, .chat-group-timestamp"),
    ].map((element) => {
      if (element.classList.contains("chat-sender-name")) {
        return "name";
      }
      if (element.classList.contains("chat-group-timestamp")) {
        return "time";
      }
      return element.getAttribute("aria-label");
    });

    expect(order).toEqual(["Reply to message", "Rewind", "name", "time"]);
  });

  it("orders peer footer actions after the sender name and timestamp", () => {
    const container = document.createElement("div");
    const message = createUserMessage("Peer footer order.");
    const group = createMessageGroup(message, "user", {
      sender: { id: "peer-user", name: "Peer User" },
      senderLabel: "Peer User",
    });
    render(
      renderTestMessageGroup(group, {
        onReply: vi.fn(),
        onRewind: vi.fn(),
        userId: "current-user",
      }),
      container,
    );

    const footer = expectElement(container, ".chat-group--peer .chat-group-footer", HTMLElement);
    const order = [
      ...footer.querySelectorAll<HTMLElement>("button, .chat-sender-name, .chat-group-timestamp"),
    ].map((element) => {
      if (element.classList.contains("chat-sender-name")) {
        return "name";
      }
      if (element.classList.contains("chat-group-timestamp")) {
        return "time";
      }
      return element.getAttribute("aria-label");
    });

    expect(order).toEqual(["name", "time", "Reply to message", "Rewind"]);
  });

  it("keeps hidden assistant thinking out of inline reply context", () => {
    const container = document.createElement("div");
    const onReply = vi.fn();
    renderAssistantMessage(
      container,
      createAssistantMessage("<thinking>private reasoning</thinking>Visible answer.", {
        timestamp: 1000,
      }),
      { onReply },
    );

    container.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')?.click();
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: "Visible answer." }));

    renderAssistantMessage(
      container,
      createAssistantMessage("<thinking>private reasoning only</thinking>", { timestamp: 1001 }),
      { onReply },
    );
    expect(container.querySelector('[aria-label="Reply to message"]')).toBeNull();
  });

  it("does not replay an arrival animation when a message row mounts", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage("Stable transcript row", { timestamp: 1000 }),
    );

    const bubble = expectElement(container, ".chat-bubble", HTMLElement);
    expect(bubble.classList.contains("fade-in")).toBe(false);
    expect(expectElement(container, ".chat-group", HTMLElement).dataset.chatRowKey).toBeTruthy();
  });

  it("renders user markdown without nested code-block chrome", () => {
    const container = document.createElement("div");
    const markdownContent = "```bash\npython3 - <<'PY'\nprint('ok')\nPY\n```";

    renderGroupedMessage(
      container,
      createUserMessage(markdownContent, { timestamp: 1001 }),
      "user",
    );

    expect(markdownRenderMock).toHaveBeenCalledWith(markdownContent, {
      assistantTranscriptRoleHeaders: false,
      codeBlockChrome: "none",
      codeBlockInteraction: "static",
      fileLinks: true,
      interactiveImages: false,
      linkFavicons: false,
      sessionLinks: true,
      tableInteractions: "enabled",
    });
  });

  it("collapses long user messages and toggles their disclosure state", () => {
    const container = document.createElement("div");
    const collapsedLines = [
      "Inspect AGENTS.md:188 first.",
      ...Array.from({ length: 11 }, (_, index) => `Prompt line ${index}`),
    ];
    const expandedTail = "Full prompt tail after the disclosure boundary.";
    const markdownContent = [...collapsedLines, expandedTail].join("\n");
    const onToggleUserMessageExpanded = vi.fn();
    markdownRenderMock
      .mockImplementationOnce(renderMarkdownHtml)
      .mockImplementationOnce(renderMarkdownHtml);

    renderGroupedMessage(
      container,
      createUserMessage(markdownContent, { timestamp: 1001 }),
      "user",
      {
        isUserMessageExpanded: () => false,
        onToggleUserMessageExpanded,
      },
    );

    const disclosure = expectElement(container, ".chat-message-disclosure", HTMLDivElement);
    const toggle = expectElement(disclosure, ".chat-message-disclosure__toggle", HTMLButtonElement);
    const collapsedText = expectElement(disclosure, ".chat-text", HTMLDivElement);
    const collapsedFileLink = expectElement(
      collapsedText,
      "a.markdown-file-link",
      HTMLAnchorElement,
    );
    expect(disclosure.classList.contains("is-expanded")).toBe(false);
    expect(collapsedText.textContent).toContain(expandedTail);
    expect(collapsedFileLink.dataset.filePath).toBe("AGENTS.md");
    expect(collapsedFileLink.dataset.fileLine).toBe("188");
    expect(toggle.getAttribute("aria-label")).toBe("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.click();
    expect(onToggleUserMessageExpanded).toHaveBeenCalledWith("user-message:user-message");

    renderGroupedMessage(
      container,
      createUserMessage(markdownContent, { timestamp: 1001 }),
      "user",
      {
        isUserMessageExpanded: () => true,
        onToggleUserMessageExpanded,
      },
    );

    const expandedDisclosure = expectElement(container, ".chat-message-disclosure", HTMLDivElement);
    const collapseToggle = expectElement(
      expandedDisclosure,
      ".chat-message-disclosure__toggle",
      HTMLButtonElement,
    );
    const expandedText = expectElement(expandedDisclosure, ".chat-text", HTMLDivElement);
    const expandedFileLink = expectElement(expandedText, "a.markdown-file-link", HTMLAnchorElement);
    expect(expandedDisclosure.classList.contains("is-expanded")).toBe(true);
    expect(expandedText.textContent).toContain(expandedTail);
    expect(expandedFileLink.dataset.filePath).toBe("AGENTS.md");
    expect(expandedFileLink.dataset.fileLine).toBe("188");
    expect(collapseToggle.getAttribute("aria-label")).toBe("Show less");
    expect(collapseToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses a long single-line user message without truncating its DOM", () => {
    const container = document.createElement("div");
    const markdownContent = `${"a".repeat(699)}😀`;

    renderGroupedMessage(
      container,
      { role: "user", content: markdownContent, timestamp: 1001 },
      "user",
      { onToggleUserMessageExpanded: vi.fn() },
    );

    const disclosure = expectElement(container, ".chat-message-disclosure", HTMLDivElement);
    expect(disclosure.querySelector(".chat-message-disclosure__toggle")).not.toBeNull();
    expect(expectElement(disclosure, ".chat-text", HTMLDivElement).textContent).toContain("😀");
  });

  it("does not add prompt disclosure controls to short user or assistant messages", () => {
    const container = document.createElement("div");
    const onToggleUserMessageExpanded = vi.fn();

    renderGroupedMessage(
      container,
      { role: "user", content: "Short prompt", timestamp: 1001 },
      "user",
      { onToggleUserMessageExpanded },
    );
    expect(container.querySelector(".chat-message-disclosure")).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(".chat-message-disclosure__toggle")?.hidden,
    ).toBe(true);

    renderAssistantMessage(
      container,
      createAssistantMessage("Long reply ".repeat(100), { timestamp: 1002 }),
      { onToggleUserMessageExpanded },
    );
    expect(container.querySelector(".chat-message-disclosure")).toBeNull();
  });

  it("keeps assistant markdown code-block copy chrome enabled", () => {
    const container = document.createElement("div");
    const markdownContent = "```bash\necho ok\n```";

    renderAssistantMessage(container, createAssistantMessage(markdownContent, { timestamp: 1000 }));

    expect(markdownRenderMock).toHaveBeenCalledWith(markdownContent, {
      assistantTranscriptRoleHeaders: true,
      codeBlockChrome: "copy",
      codeBlockInteraction: "interactive",
      fileLinks: true,
      interactiveImages: false,
      linkFavicons: false,
      sessionLinks: true,
      tableInteractions: "enabled",
    });
  });

  it("renders a confirmed rewind action only for user groups", () => {
    const container = document.createElement("div");
    const onRewind = vi.fn();
    localStorageValues.delete("openclaw:skip-rewind-confirm");
    renderMessageGroups(
      container,
      [
        createMessageGroup({ role: "user", content: "rewind me", timestamp: 1000 }, "user"),
        createMessageGroup({ role: "assistant", content: "answer", timestamp: 1001 }, "assistant"),
      ],
      { onRewind },
    );

    const rewindButtons = container.querySelectorAll<HTMLButtonElement>(".chat-group-rewind");
    expect(rewindButtons).toHaveLength(1);
    rewindButtons[0]!.click();
    expect(document.querySelector(".chat-confirm-popover__text")?.textContent).toBe(
      "Rewind to before this message?",
    );
    document.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!.click();
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  it("disables rewind while the agent is working", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [createMessageGroup({ role: "user", content: "busy", timestamp: 1000 }, "user")],
      { onRewind: vi.fn(), rewindDisabled: true },
    );

    const button = container.querySelector<HTMLButtonElement>(".chat-group-rewind");
    const tooltip = button?.closest("openclaw-tooltip");
    expect(button?.disabled).toBe(true);
    expect(tooltip?.content).toBe("Rewind is unavailable while the agent is working");
  });

  it.each([
    {
      name: "places the confirmation below the trigger near the top viewport edge",
      trigger: { left: 20, top: 4, width: 24, height: 24 },
      popover: { width: 200, height: 96 },
      viewport: { width: 320, height: 240 },
      placement: "below",
      top: "34px",
      left: "8px",
    },
    {
      name: "places the confirmation above the trigger near the bottom viewport edge",
      trigger: { left: 20, top: 190, width: 24, height: 24 },
      popover: { width: 200, height: 80 },
      viewport: { width: 320, height: 240 },
      placement: "above",
      top: "104px",
      left: "8px",
    },
    {
      name: "clamps the confirmation horizontally inside narrow viewports",
      trigger: { left: 260, top: 120, width: 24, height: 24 },
      popover: { width: 200, height: 80 },
      viewport: { width: 320, height: 240 },
      left: "84px",
    },
    {
      name: "clamps the confirmation inside shifted visual viewports",
      trigger: { left: 620, top: 540, width: 24, height: 24 },
      popover: { width: 200, height: 80 },
      viewport: { left: 320, top: 300, width: 320, height: 240 },
      placement: "above",
      top: "452px",
      left: "432px",
    },
  ])("$name", ({ trigger, popover, viewport, placement, top, left }) => {
    stubConfirmedActionGeometry({ trigger, popover, viewport });
    const fixture = renderConfirmedActionFixture();

    openConfirmedAction(fixture.actionButton);

    const element = expectElement(document.body, ".chat-confirm-popover", HTMLElement);
    expect(element.parentElement).toBe(document.body);
    if (placement) {
      expect(element.dataset.placement).toBe(placement);
    }
    if (top) {
      expect(element.style.top).toBe(top);
    }
    expect(element.style.left).toBe(left);
  });
  it("exposes dialog semantics and keeps keyboard focus inside the confirmation", () => {
    const fixture = renderConfirmedActionFixture();

    openConfirmedAction(fixture.actionButton);

    const popover = expectElement(document.body, ".chat-confirm-popover", HTMLElement);
    const check = expectElement(popover, ".chat-confirm-popover__check", HTMLInputElement);
    const cancel = expectElement(popover, ".chat-confirm-popover__cancel", HTMLButtonElement);
    const confirm = expectElement(popover, ".chat-confirm-popover__yes", HTMLButtonElement);
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-modal")).toBe("true");
    expect(popover.getAttribute("aria-label")).toBe(
      popover.querySelector(".chat-confirm-popover__text")?.textContent,
    );
    expect(popover.querySelector(".chat-confirm-popover__remember span")?.textContent).toBe(
      "Don't ask again",
    );
    expect(cancel.textContent).toBe("Cancel");
    expect(document.activeElement).toBe(cancel);

    confirm.focus();
    const tabForward = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    confirm.dispatchEvent(tabForward);
    expect(tabForward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(check);

    const tabBackward = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });
    check.dispatchEvent(tabBackward);
    expect(tabBackward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(confirm);
  });

  it("dismisses the confirmation with Escape before underlying keyboard handlers run", () => {
    const fixture = setupArmedConfirmedAction();
    const cancel = expectElement(
      fixture.popover,
      ".chat-confirm-popover__cancel",
      HTMLButtonElement,
    );
    const leakedKeydown = vi.fn();
    document.addEventListener("keydown", leakedKeydown);

    try {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      cancel.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(leakedKeydown).not.toHaveBeenCalled();
      expectConfirmedActionDismissed(fixture);
      expect(fixture.onAction).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(fixture.actionButton);
    } finally {
      document.removeEventListener("keydown", leakedKeydown);
    }
  });

  it("dismisses only confirmations contained by the requested owner", () => {
    const fixture = setupArmedConfirmedAction();
    const sibling = renderConfirmedActionFixture();
    openConfirmedAction(sibling.actionButton);
    const siblingPopover = [
      ...document.querySelectorAll<HTMLElement>(".chat-confirm-popover"),
    ].find((popover) => popover !== fixture.popover);

    dismissConfirmedActionPopovers(fixture.container);

    expectConfirmedActionDismissed(fixture);
    expect(siblingPopover?.isConnected).toBe(true);
    dismissConfirmedActionPopovers(sibling.container);
  });

  it("dismisses a portaled confirmation when its owner is detached", async () => {
    const fixture = setupArmedConfirmedAction();

    fixture.container.remove();
    await Promise.resolve();

    expectConfirmedActionDismissed(fixture);
  });

  it("does not attach an outside-click listener after owner cleanup before the next frame", () => {
    const flushAnimationFrames = stubAnimationFrameQueue();
    const addListenerSpy = vi.spyOn(document, "addEventListener");
    const removeListenerSpy = vi.spyOn(document, "removeEventListener");
    const addKeyListenerSpy = vi.spyOn(window, "addEventListener");
    const removeKeyListenerSpy = vi.spyOn(window, "removeEventListener");
    const fixture = renderConfirmedActionFixture();

    openConfirmedAction(fixture.actionButton);
    const contextMenuListener = getLastCaptureContextMenuListener(addListenerSpy.mock.calls);
    const escapeListener = getLastCaptureKeydownListener(addKeyListenerSpy.mock.calls);
    expect(typeof contextMenuListener).toBe("function");
    expect(typeof escapeListener).toBe("function");
    dismissConfirmedActionPopovers(fixture.container);
    flushAnimationFrames();

    expect(document.querySelector(".chat-confirm-popover")).toBeNull();
    expect(getLastCaptureClickListener(addListenerSpy.mock.calls)).toBeNull();
    expect(
      countCaptureContextMenuListenerRemovals(removeListenerSpy.mock.calls, contextMenuListener),
    ).toBe(1);
    expect(
      countCaptureKeydownListenerRemovals(removeKeyListenerSpy.mock.calls, escapeListener),
    ).toBe(1);
  });

  it("removes the confirmation outside-click listener when Cancel dismisses it", () => {
    const fixture = setupArmedConfirmedAction();
    const cancel = fixture.popover.querySelector<HTMLButtonElement>(
      ".chat-confirm-popover__cancel",
    );

    expect(cancel).toBeInstanceOf(HTMLButtonElement);
    cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConfirmedActionDismissed(fixture);
    expect(fixture.onAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(fixture.actionButton);
  });

  it("removes the confirmation outside-click listener when Rewind dismisses it", () => {
    const fixture = setupArmedConfirmedAction();
    const confirm = fixture.popover.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes");

    expect(confirm).toBeInstanceOf(HTMLButtonElement);
    confirm!.focus();
    confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConfirmedActionDismissed(fixture);
    expect(fixture.onAction).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(fixture.actionButton);
  });

  it("removes the confirmation outside-click listener when an outside click dismisses it", () => {
    const fixture = setupArmedConfirmedAction();
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);

    try {
      outsideButton.focus();
      outsideButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expectConfirmedActionDismissed(fixture);
      expect(fixture.onAction).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(outsideButton);
    } finally {
      outsideButton.remove();
    }
  });

  it("removes the confirmation outside-click listener when the action button toggles it", () => {
    const fixture = setupArmedConfirmedAction();

    openConfirmedAction(fixture.actionButton);

    expectConfirmedActionDismissed(fixture);
    expect(fixture.onAction).not.toHaveBeenCalled();
  });

  it("removes the confirmation outside-click listener when the action icon toggles it", () => {
    const fixture = setupArmedConfirmedAction();

    clickConfirmedActionIconPath(fixture.actionButton);

    expectConfirmedActionDismissed(fixture);
    expect(fixture.onAction).not.toHaveBeenCalled();
  });

  it("does not attach the confirmation outside-click listener after an immediate toggle", () => {
    const flushAnimationFrames = stubAnimationFrameQueue();
    const addListenerSpy = vi.spyOn(document, "addEventListener");
    const fixture = renderConfirmedActionFixture();

    openConfirmedAction(fixture.actionButton);
    openConfirmedAction(fixture.actionButton);
    flushAnimationFrames();

    expect(document.querySelector(".chat-confirm-popover")).toBeNull();
    expect(getLastCaptureClickListener(addListenerSpy.mock.calls)).toBeNull();
    expect(fixture.onAction).not.toHaveBeenCalled();
  });

  it("renders assistant context usage from input and cache tokens", () => {
    const renderUsage = (usage: Record<string, number>, contextWindow: number) => {
      const container = document.createElement("div");
      renderAssistantMessage(
        container,
        createAssistantMessage("Done", {
          usage,
          model: "anthropic/claude-opus-4-7",
          timestamp: 1000,
        }),
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
    const summary = meta?.querySelector<HTMLElement>(".msg-meta__summary");
    const time = summary?.querySelector<HTMLTimeElement>(".chat-group-timestamp");
    expect(time).not.toBeNull();
    expect(time?.title).toBe("");
    expect(summary?.textContent).not.toContain("Context");
    expect(summary?.getAttribute("aria-label")).toContain("Message context for");
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

    // Cost is nested under usage.cost in the canonical AssistantMessage
    // shape; the popover must surface it (it was dead reading message.cost).
    const withCost = renderUsage(
      {
        input: 1_000,
        output: 500,
        cost: { total: 0.1234 } as unknown as number,
      } as Record<string, number>,
      10_000,
    );
    expect(withCost.querySelector(".msg-meta__cost")?.textContent).toContain("$0.12");
  });

  it("previews message context from the timestamp and pins it on click", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage("Done", {
        usage: { input: 12_000, output: 300 },
        model: "openai/gpt-5.5",
        timestamp: 1000,
      }),
      { contextWindow: 100_000 },
    );

    const details = container.querySelector<HTMLDetailsElement>("details.msg-meta")!;
    const summary = details.querySelector<HTMLElement>("summary")!;
    const pointerEnter = new Event("pointerenter");
    Object.defineProperty(pointerEnter, "pointerType", { value: "mouse" });
    details.dispatchEvent(pointerEnter);
    expect(details.open).toBe(true);

    details.dispatchEvent(new Event("pointerleave"));
    expect(details.open).toBe(false);

    details.dispatchEvent(pointerEnter);
    summary.click();
    details.dispatchEvent(new Event("pointerleave"));
    expect(details.open).toBe(true);

    summary.click();
    expect(details.open).toBe(false);
  });

  it("uses the largest single assistant call for grouped context usage", () => {
    const container = document.createElement("div");

    renderAssistantMessages(
      container,
      [
        createAssistantMessage("Checking", {
          usage: { input: 105_944, output: 100 },
          timestamp: 1000,
        }),
        createAssistantMessage("Done", {
          usage: { input: 108_577, output: 100 },
          timestamp: 1001,
        }),
      ],
      { contextWindow: 258_400 },
    );

    expect(container.querySelector(".msg-meta__ctx")?.textContent).toBe("42% ctx");
    expect(container.querySelector(".msg-meta__tokens")?.textContent).toBe("↑214.5k");
  });

  it("renders relative labels while preserving absolute message and streaming timestamps", () => {
    vi.useFakeTimers();
    const timestamp = Date.UTC(2026, 3, 24, 18, 30);
    vi.setSystemTime(timestamp + 5 * 60 * 1000);
    const container = document.createElement("div");

    renderAssistantMessage(container, createAssistantMessage("Done", { timestamp }));

    let time = container.querySelector<HTMLTimeElement>(".chat-group-timestamp");
    expect(time?.dateTime).toBe(new Date(timestamp).toISOString());
    expect(time?.textContent?.trim()).toBe("5m ago");

    render(
      renderStreamGroup([
        {
          kind: "stream",
          key: `stream:${timestamp}`,
          text: "Working",
          startedAt: timestamp,
          isStreaming: true,
        },
      ]),
      container,
    );

    time = container.querySelector<HTMLTimeElement>(".chat-group-timestamp");
    expect(time?.dateTime).toBe(new Date(timestamp).toISOString());
    expect(time?.textContent?.trim()).toBe("5m ago");
  });

  it("renders compact dates for old and far-future messages while clamping clock skew", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 5, 24, 18, 30);
    vi.setSystemTime(now);
    const container = document.createElement("div");
    const renderTimestamp = (timestamp: number) => {
      renderAssistantMessage(container, createAssistantMessage("Done", { timestamp }));
      return container.querySelector<HTMLTimeElement>(".chat-group-timestamp")?.textContent?.trim();
    };

    const oldTimestamp = Date.UTC(2026, 3, 24, 18, 30);
    expect(renderTimestamp(oldTimestamp)).toBe(
      new Date(oldTimestamp).toLocaleDateString([], { month: "short", day: "numeric" }),
    );
    expect(renderTimestamp(now + 30_000)).toBe("just now");

    const nextYear = Date.UTC(2027, 3, 24, 18, 30);
    expect(renderTimestamp(nextYear)).toBe(
      new Date(nextYear).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
  });

  it("uses the earliest segment timestamp for a multi-segment stream footer", () => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([
        { kind: "stream", key: "stream-seg:s:0", text: "first", startedAt: 20, isStreaming: false },
        {
          kind: "stream",
          key: "stream-seg:s:1",
          text: "second",
          startedAt: 10,
          isStreaming: false,
        },
        { kind: "stream", key: "stream:s:live", text: "third", startedAt: 30, isStreaming: true },
      ]),
      container,
    );

    expect(container.querySelectorAll(".chat-group.assistant")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-bubble")).toHaveLength(3);
    expect(container.querySelector<HTMLTimeElement>(".chat-group-timestamp")?.dateTime).toBe(
      new Date(10).toISOString(),
    );
  });

  it("uses the browser locale for timestamp tooltips", () => {
    const timestamp = Date.UTC(2026, 0, 15, 19, 30);
    const container = document.createElement("div");
    renderAssistantMessage(container, createAssistantMessage("Done", { timestamp }));

    expect(container.querySelector("openclaw-tooltip")?.getAttribute("content")).toBe(
      new Date(timestamp).toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    );
  });

  it("omits streaming bubble class for completed stream segments", () => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([
        {
          kind: "stream",
          key: "stream:1",
          text: "Completed segment",
          startedAt: 1,
          isStreaming: false,
        },
      ]),
      container,
    );

    const bubble = container.querySelector(".chat-bubble");
    expect(bubble?.classList.contains("streaming")).toBe(false);
  });

  it("renders streaming text through the streaming markdown renderer", () => {
    const container = document.createElement("div");
    markdownRenderMock.mockClear();
    streamingMarkdownRenderMock.mockClear();

    render(
      renderStreamGroup([
        {
          kind: "stream",
          key: "stream:1",
          text: "**live**\nreply",
          startedAt: 1,
          isStreaming: true,
        },
      ]),
      container,
    );

    expect(markdownRenderMock).not.toHaveBeenCalled();
    expect(streamingMarkdownRenderMock).toHaveBeenCalledWith("**live**\nreply", {
      assistantTranscriptRoleHeaders: true,
      codeBlockChrome: "copy",
      codeBlockInteraction: "interactive",
      fileLinks: true,
      interactiveImages: false,
      linkFavicons: false,
      sessionLinks: true,
      tableInteractions: "enabled",
    });
    const text = container.querySelector(".streaming-markdown");
    expect(text?.textContent).toBe("**live**\nreply");
  });

  it("renders a reading-indicator-only run without avatar or footer", () => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }]),
      container,
    );

    const group = container.querySelector(".chat-group.assistant");
    expect(group).not.toBeNull();
    expect(group?.classList.contains("chat-group--working")).toBe(true);
    // Working runs are pure claw: the avatar only arrives with stream text.
    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(0);
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
    expect(container.querySelector(".chat-working-indicator__elapsed")).not.toBeNull();
    expect(container.querySelector(".chat-working-indicator__status > .sr-only")?.textContent).toBe(
      "Working…",
    );
    expect(
      container.querySelectorAll(".chat-working-indicator__status > span:not(.sr-only)"),
    ).toHaveLength(0);
    expect(container.querySelector(".chat-group-footer")).toBeNull();
  });

  it("morphs one assistant turn from working status to its terminal recap", () => {
    const container = document.createElement("div");
    const message = {
      role: "assistant",
      content: "First result is ready.",
      timestamp: 1_000,
    };

    renderAssistantMessage(container, message, {
      activeContinuation: {
        parts: [{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }],
        options: {},
      },
    });

    expect(container.querySelectorAll(".chat-group.assistant")).toHaveLength(1);
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    expect(container.querySelector(".chat-working-indicator--continuation")).not.toBeNull();
    expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
      "Working…",
    );

    renderAssistantMessage(container, message, {
      turnRecap: { runtimeMs: 5_000, outputTokens: 42 },
    });

    expect(container.querySelectorAll(".chat-group.assistant")).toHaveLength(1);
    expect(container.querySelector(".chat-working-indicator")).toBeNull();
    expect(container.querySelector(".chat-turn-recap--continuation")?.textContent).toContain(
      "Done in 5 seconds",
    );
    expect(container.querySelector(".chat-tasks-status__claw")).toBeNull();
  });

  it.each([
    ["provisioning_environment", "Provisioning environment…"],
    ["preparing_context", "Preparing this turn…"],
    ["starting_model", "Waiting for a response…"],
  ] as const)("renders the %s startup phase with elapsed time", (startupPhase, label) => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
        startupPhase,
      }),
      container,
    );

    expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
      label,
    );
    expect(container.querySelector(".chat-working-indicator__elapsed")).not.toBeNull();
    expect(container.querySelector(".chat-working-indicator__status > .sr-only")).toBeNull();
  });

  it("formats terminal recap durations with full localized units", () => {
    const cases = [
      { runtimeMs: 3_600_000, expected: "Done in 1 hour" },
      { runtimeMs: 10 * 60_000, expected: "Done in 10 minutes" },
      { runtimeMs: 30_000, expected: "Done in 30 seconds" },
      { runtimeMs: 86_400_000, expected: "Done in 1 day" },
      {
        runtimeMs: 4 * 3_600_000 + 2 * 60_000,
        expected: "Done in 4 hours, 2 minutes",
      },
    ];

    for (const { runtimeMs, expected } of cases) {
      const container = document.createElement("div");
      render(renderTurnRecapRow({ runtimeMs, outputTokens: null }), container);
      expect(container.querySelector(".chat-turn-recap")?.textContent?.trim()).toBe(expected);
    }

    const withTokens = document.createElement("div");
    render(renderTurnRecapRow({ runtimeMs: 30_000, outputTokens: 2_400 }), withTokens);
    expect(
      withTokens.querySelector(".chat-turn-recap")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("Done in 30 seconds · 2.4k tokens");
  });

  it("shows live output usage beside elapsed time", () => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
        runOutputTokens: 5_500,
      }),
      container,
    );

    expect(container.querySelector(".chat-working-indicator__elapsed")).not.toBeNull();
    expect(container.querySelector(".chat-working-indicator__tokens")?.textContent?.trim()).toBe(
      "5.5k tokens",
    );
    // Streaming tokens replace the whimsical phrase: one liveness signal at a time.
    expect(container.querySelector("openclaw-working-phrase")).toBeNull();
  });

  it("relabels the working indicator while the run waits for approval", () => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
        startupPhase: "starting_model",
        waitingApproval: true,
        runOutputTokens: 5_500,
      }),
      container,
    );

    expect(container.querySelector(".chat-working-indicator__status")?.textContent?.trim()).toBe(
      "Waiting for approval…",
    );
    expect(container.querySelector(".chat-working-indicator__elapsed")).toBeNull();
    expect(container.querySelector(".chat-working-indicator__tokens")).toBeNull();
  });

  it("keeps streamed assistant content in the guttered group without an avatar", () => {
    const container = document.createElement("div");

    render(
      renderStreamGroup(
        [
          {
            kind: "stream",
            key: "stream:s:live",
            text: "reply",
            startedAt: 10,
            isStreaming: true,
          },
          { kind: "reading-indicator", key: "reading", startedAt: 10 },
        ],
        { showAssistantAvatar: false },
      ),
      container,
    );

    const group = container.querySelector(".chat-group.assistant");
    expect(group?.classList.contains("chat-group--working")).toBe(false);
    expect(group?.classList.contains("chat-group--with-footer")).toBe(true);
    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(0);
    expect(container.querySelectorAll(".chat-group-footer")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-working-indicator")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-reading-indicator")).toHaveLength(1);
  });

  it("seeds at most one stable claw surprise per reading-indicator key", () => {
    const surpriseFor = (key: string) => {
      const container = document.createElement("div");
      render(renderStreamGroup([{ kind: "reading-indicator", key, startedAt: 1 }]), container);
      const bubble = container.querySelector(".chat-reading-indicator");
      return [...(bubble?.classList ?? [])].filter((cls) =>
        cls.startsWith("chat-reading-indicator--"),
      );
    };

    const first = surpriseFor("stream:agent:main:pending");
    // Stable across re-renders: the same key keeps the same surprise decision.
    expect(surpriseFor("stream:agent:main:pending")).toEqual(first);
    // The render must route exactly the picker's seeded decision — nothing
    // extra, nothing hand-rolled — so new stances can never drift this test.
    const decision = selectWorkingClawSurprise("stream:agent:main:pending");
    expect(first).toEqual(decision ? [decision] : []);
  });

  it("keeps the synthetic progress word screen-reader-only across runs", () => {
    const statusFor = (startedAt: number) => {
      const container = document.createElement("div");
      render(
        renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt }]),
        container,
      );
      const status = container.querySelector(".chat-working-indicator__status");
      return {
        hidden: status?.querySelector(".sr-only")?.textContent,
        visibleLabels: status?.querySelectorAll("span:not(.sr-only)").length,
        // The whimsical long-wait phrase rides in its own aria-hidden element,
        // never as a plain status span screen readers would announce.
        decorativePhrases: status?.querySelectorAll("openclaw-working-phrase[aria-hidden]").length,
      };
    };

    const expected = { hidden: "Working…", visibleLabels: 0, decorativePhrases: 1 };
    expect(statusFor(1_000)).toEqual(expected);
    expect(statusFor(1_500)).toEqual(expected);
    expect(statusFor(8_000)).toEqual(expected);
  });

  it("renders configured local user names", () => {
    const renderUser = (opts: Partial<RenderMessageGroupOptions>) => {
      const container = document.createElement("div");
      renderGroupedMessage(
        container,
        createUserMessage("hello", { timestamp: 1000 }),
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

  it("keeps the sender name visible without duplicating a gutter avatar", () => {
    const container = document.createElement("div");
    const message = { role: "user", content: "hello", timestamp: 1000 };
    const group = createMessageGroup(message, "user", {
      key: "attributed-user-group",
      senderLabel: "alice",
      sender: { id: "profile-1", name: "Alice Example" },
      messages: [createMessageEntry("attributed-user-message", message)],
    });

    render(
      renderTestMessageGroup(group, { userName: "Local User", showAvatarGutter: true }),
      container,
    );

    expect(
      container.querySelector<HTMLElement>(".chat-group.user .chat-sender-name")?.textContent,
    ).toBe("alice");
    expect(
      container.querySelector(".chat-group-footer--persistent-identity .chat-sender-name")
        ?.textContent,
    ).toBe("alice");
    expect(container.querySelector(".chat-avatar.user")).not.toBeNull();
    expect(container.querySelector(".chat-author-avatar")).toBeNull();
  });

  it("tints attributed user groups with the sender's stable identity hue", () => {
    const renderGroupFor = (sender?: { id: string; name: string }) => {
      const container = document.createElement("div");
      render(
        renderMessageGroup(
          createMessageGroup({ role: "user", content: "hi" }, "user", {
            key: "tint-group",
            ...(sender ? { sender, senderLabel: sender.name } : {}),
            messages: [
              createMessageEntry("tint-message", {
                role: "user",
                content: "hi",
                timestamp: 1000,
              }),
            ],
            timestamp: 1000,
          }),
          { showReasoning: true, showToolCalls: true },
        ),
        container,
      );
      return container.querySelector<HTMLElement>(".chat-group.user");
    };

    const attributed = renderGroupFor({ id: "profile-1", name: "Alice Example" });
    expect(attributed?.classList.contains("chat-group--sender-tint")).toBe(true);
    const hue = Number(attributed?.style.getPropertyValue("--chat-sender-hue"));
    expect(Number.isInteger(hue)).toBe(true);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);

    // Same sender always lands on the same hue; the local unattributed viewer
    // keeps the accent skin.
    const again = renderGroupFor({ id: "profile-1", name: "Alice Example" });
    expect(again?.style.getPropertyValue("--chat-sender-hue")).toBe(String(hue));
    const local = renderGroupFor();
    expect(local?.classList.contains("chat-group--sender-tint")).toBe(false);
    expect(local?.style.getPropertyValue("--chat-sender-hue")).toBe("");
  });

  it.each([
    { label: "foreign sender", sender: { id: "other-user" }, userId: "current-user", peer: true },
    { label: "own sender", sender: { id: "current-user" }, userId: "current-user", peer: false },
    { label: "unattributed sender", sender: undefined, userId: "current-user", peer: false },
    {
      label: "attributed sender without a viewer",
      sender: { id: "other-user" },
      userId: null,
      peer: true,
    },
  ])("sets peer alignment for $label", ({ sender, userId, peer }) => {
    const container = document.createElement("div");
    render(
      renderMessageGroup(
        createMessageGroup({ role: "user", content: "hi" }, "user", {
          key: "peer-group",
          ...(sender ? { sender } : {}),
          messages: [{ key: "peer-message", message: { role: "user", content: "hi" } }],
          timestamp: 1000,
        }),
        { showReasoning: true, showToolCalls: true, userId },
      ),
      container,
    );

    expect(
      container.querySelector(".chat-group.user")?.classList.contains("chat-group--peer"),
    ).toBe(peer);
  });

  it("renders assistant reply attribution for a multi-sender thread", () => {
    const container = document.createElement("div");
    render(
      renderMessageGroup(
        createMessageGroup({ role: "assistant", content: "hello" }, "assistant", {
          key: "reply-attribution",
          replyToSender: { id: "alice@example.com", name: "Alice" },
          messages: [{ key: "reply", message: { role: "assistant", content: "hello" } }],
          timestamp: 1000,
        }),
        { showReasoning: true, showToolCalls: true },
      ),
      container,
    );

    const attribution = container.querySelector<HTMLElement>(".chat-reply-attribution");
    expect(attribution?.textContent?.trim()).toBe("Alice");
    expect(attribution?.getAttribute("title")).toBe("Replying to Alice");
    expect(attribution?.nextElementSibling?.classList.contains("chat-bubble")).toBe(true);
  });

  it("renders multiline system notices as sanitized markdown", () => {
    const container = document.createElement("div");
    markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
    render(
      renderChatNotice({
        kind: "notice",
        key: "notice:command",
        icon: "cpu",
        label: "System",
        text: "**first line**\nsecond line\n<img src=x onerror=alert(1)><script>alert(1)</script>",
        timestamp: 1000,
      }),
      container,
    );

    const notice = container.querySelector<HTMLElement>(".chat-notice");
    expect(notice?.querySelector(".chat-divider__title")?.textContent).toBe("System");
    expect(notice?.querySelector(".chat-divider__icon svg")).not.toBeNull();
    expect(notice?.querySelector(".chat-avatar")).toBeNull();
    expect(notice?.querySelector(".chat-author-avatar")).toBeNull();
    expect(notice?.querySelector(".chat-sender-name")).toBeNull();
    expect(notice?.querySelector("strong")?.textContent).toBe("first line");
    expect(notice?.textContent).not.toContain("**");
    expect(notice?.querySelector("br")).not.toBeNull();
    expect(notice?.textContent).toContain("first line");
    expect(notice?.textContent).toContain("second line");
    expect(notice?.querySelector("script")).toBeNull();
    expect(notice?.querySelector("img[onerror]")).toBeNull();
    expect(notice?.dataset.chatRowKey).toBe("notice:command");
    expect(markdownRenderMock).toHaveBeenCalledWith(expect.any(String), {
      codeBlockChrome: "none",
    });
  });

  it("renders Codex guardian decisions and warnings in the transcript", () => {
    const container = document.createElement("div");
    const host = createHost();
    handleAgentEvent(
      host,
      agentEvent("run-guardian", 1, "codex_app_server.guardian", {
        phase: "completed",
        reviewId: "review-approved",
        status: "approved",
        command: "git status --short",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-guardian", 2, "codex_app_server.guardian", {
        phase: "completed",
        reviewId: "review-denied",
        status: "denied",
        command: "curl https://example.invalid",
        riskLevel: "high",
        rationale: "Command reaches the network.",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-guardian", 3, "codex_app_server.guardian", {
        phase: "warning",
        message: "Guardian stopped after too many rejected actions.",
      }),
    );
    const items = buildCachedChatItems({
      paneId: "guardian-render-test",
      sessionKey: "main",
      runId: "run-guardian",
      messages: [],
      toolMessages: [],
      guardianNotices: host.guardianNotices,
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    if (!items.every((item) => item.kind === "notice")) {
      throw new Error("Expected guardian notice projections");
    }
    render(html`${items.map((item) => renderChatNotice(item))}`, container);

    const notices = [...container.querySelectorAll<HTMLElement>(".chat-notice")];
    expect(notices).toHaveLength(3);
    expect(notices[0]?.textContent).toContain("Guardian approved git status --short.");
    expect(notices[0]?.classList.contains("danger")).toBe(false);
    expect(notices[1]?.classList.contains("callout")).toBe(true);
    expect(notices[1]?.classList.contains("danger")).toBe(true);
    expect(notices[1]?.getAttribute("role")).toBe("alert");
    expect(notices[1]?.textContent).toContain("Guardian denied");
    expect(notices[1]?.textContent).toContain("curl https://example.invalid · risk: high");
    expect(notices[1]?.textContent).toContain("Command reaches the network.");
    expect(notices[2]?.textContent).toContain("Guardian warning");
    expect(notices[2]?.textContent).toContain("Guardian stopped after too many rejected actions.");
  });

  it("uses the current profile display name for the signed-in user's historical messages", () => {
    const container = document.createElement("div");
    render(
      renderMessageGroup(
        createMessageGroup({ role: "user", content: "hello", timestamp: 1000 }, "user", {
          key: "current-user-group",
          senderLabel: "fullerstackd",
          sender: { id: "profile-1", username: "fullerstackd" },
          messages: [
            {
              key: "current-user-message",
              message: { role: "user", content: "hello", timestamp: 1000 },
            },
          ],
          timestamp: 1000,
        }),
        {
          showReasoning: true,
          showToolCalls: true,
          assistantName: "OpenClaw",
          userId: "profile-1",
          userName: "Fuller Stack",
          showAvatarGutter: true,
        },
      ),
      container,
    );

    expect(
      container.querySelector<HTMLElement>(".chat-group.user .chat-sender-name")?.textContent,
    ).toBe("Fuller Stack");
    expect(
      container.querySelector(".chat-group-footer--persistent-identity .chat-sender-name")
        ?.textContent,
    ).toBe("Fuller Stack");
  });

  it("renders a compact author avatar when the gutter is hidden", async () => {
    const container = document.createElement("div");
    render(
      renderMessageGroup(
        createMessageGroup({ role: "user", content: "hello", timestamp: 1000 }, "user", {
          key: "attributed-user",
          senderLabel: "Alice Example",
          sender: { id: "profile_123", name: "Alice Example" },
          messages: [
            {
              key: "attributed-message",
              message: { role: "user", content: "hello", timestamp: 1000 },
            },
          ],
          timestamp: 1000,
        }),
        {
          showReasoning: true,
          showToolCalls: true,
          assistantName: "OpenClaw",
          showAvatarGutter: false,
        },
      ),
      container,
    );

    expect(container.querySelector(".chat-avatar.user")).toBeNull();
    expect(container.querySelector(".chat-group-persistent-author")).toBeNull();
    await vi.waitFor(() => {
      expect(container.querySelector(".chat-author-avatar__initials")?.textContent?.trim()).toBe(
        "AE",
      );
    });
    expect(container.querySelector(".chat-author-avatar")?.getAttribute("title")).toBe(
      "Alice Example",
    );
  });

  it("falls back to initials when a user avatar image fails", async () => {
    const container = document.createElement("div");
    const message = { role: "user", content: "hello", timestamp: 1000 };
    const group = createMessageGroup(message, "user", {
      key: "gravatar-user",
      senderLabel: "alice",
      // profileAvatarUrl exercises the img tier; bare emails render initials
      // only (no third-party avatar fetch without a gateway proxy base).
      sender: { id: "alice@example.com", profileAvatarUrl: "/api/users/alice/avatar" },
      messages: [createMessageEntry("gravatar-message", message)],
    });
    render(
      renderMessageGroup(group, {
        showReasoning: true,
        showToolCalls: true,
        assistantName: "OpenClaw",
        showAvatarGutter: false,
      }),
      container,
    );

    const image = await vi.waitFor(() => {
      const result = container.querySelector<HTMLImageElement>(".chat-author-avatar__image");
      expect(result).not.toBeNull();
      expect(result?.getAttribute("src")).toBe("/api/users/alice/avatar");
      return result!;
    });
    image.dispatchEvent(new Event("error"));
    expect(container.querySelector(".chat-author-avatar")?.classList.contains("is-fallback")).toBe(
      true,
    );
    expect(container.querySelector(".chat-author-avatar__fallback")?.textContent?.trim()).toBe("A");
  });

  it("does not render an author avatar for a user group without sender identity", () => {
    const container = document.createElement("div");
    renderGroupedMessage(container, createUserMessage("hello", { timestamp: 1000 }), "user");
    expect(container.querySelector(".chat-author-avatar")).toBeNull();
  });

  it("never renders a user author avatar on assistant output", () => {
    const container = document.createElement("div");
    const message = { role: "assistant", content: "hello", timestamp: 1000 };
    const group = createMessageGroup(message, "assistant", {
      key: "assistant-with-sender",
      senderLabel: "Forwarded Agent",
      sender: { id: "agent@example.com", name: "Forwarded Agent" },
      messages: [createMessageEntry("assistant-message", message)],
    });
    render(
      renderMessageGroup(group, {
        showReasoning: true,
        showToolCalls: true,
        assistantName: "OpenClaw",
      }),
      container,
    );
    expect(container.querySelector(".chat-author-avatar")).toBeNull();
  });

  it("uses assistant senderLabel for forwarded assistant-side groups", () => {
    const container = document.createElement("div");
    const message = { role: "assistant", content: "forwarded report", timestamp: 1000 };
    const group = createMessageGroup(message, "assistant", {
      key: "forwarded-group",
      senderLabel: "Forwarded from main",
      messages: [createMessageEntry("forwarded-message", message)],
    });

    render(renderTestMessageGroup(group), container);

    const sender = container.querySelector<HTMLElement>(".chat-group.assistant .chat-sender-name");
    expect(sender?.textContent).toBe("Forwarded from main");
  });

  it("uses the assistant name when an assistant group has no sender label", () => {
    const container = document.createElement("div");
    renderGroupedMessage(
      container,
      createAssistantMessage("hello", { timestamp: 1000 }),
      "assistant",
      { assistantName: "OpenClaw", userName: "Fuller Stack" },
    );

    expect(
      container.querySelector<HTMLElement>(".chat-group.assistant .chat-sender-name")?.textContent,
    ).toBe("OpenClaw");
  });

  it("collapses consecutive tool results into an activity group", () => {
    const container = document.createElement("div");
    const group = createToolGroup("tool-group", [
      createMessageEntry(
        "tool-message-1",
        createToolResultMessage("call-1", "read_file", "File one", { timestamp: 1000 }),
      ),
      createMessageEntry(
        "tool-message-2",
        createToolResultMessage("call-2", "run_command", "Command output", {
          timestamp: 1001,
        }),
      ),
    ]);

    renderMessageGroups(container, [group], {
      isToolMessageExpanded: (id) => (id === "activity:tool-group" ? false : undefined),
    });

    const activity = expectElement(container, ".chat-activity-group__summary", HTMLButtonElement);
    // Aggregate summary from summarizeToolGroup replaces the old "Activity: N tools" label.
    expect(activity.textContent).toContain("Ran a command, read a file");
    expect(activity.querySelector(".chat-activity-group__preview")).toBeNull();
    expect(activity.textContent).not.toContain("read_file");
    expect(activity.textContent).not.toContain("run_command");
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("keeps a persisted tool review icon-only until its command activity expands", () => {
    const container = document.createElement("div");
    const group = createToolGroup("reviewed-tool-group", [
      createMessageEntry(
        "reviewed-tool-message",
        createToolResultMessage("call-reviewed", "run_command", "completed", {
          details: {
            approvalReviews: [
              {
                id: "review-1",
                label: "Guardian",
                status: "approved",
                riskLevel: "low",
                userAuthorization: "high",
                rationale: "Narrowly scoped to the requested file.",
              },
            ],
            approvalReviewOutcome: "approved",
          },
          timestamp: 1000,
        }),
      ),
    ]);

    renderMessageGroups(container, [group], {
      isToolMessageExpanded: (id) => (id === "activity:reviewed-tool-group" ? false : undefined),
    });
    expect(
      container.querySelector('.chat-activity-group__review-status[data-outcome="approved"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Guardian approved");

    renderMessageGroups(container, [group], {
      isToolMessageExpanded: () => true,
      isToolExpanded: () => true,
    });
    const review = container.querySelector('.chat-tool-review[data-review-status="approved"]');
    expect(review?.textContent).toContain("Guardian approved");
    expect(review?.textContent).toContain("Narrowly scoped to the requested file.");
    expect(container.querySelector(".chat-tool-msg-body")).not.toBeNull();
    expect(container.querySelectorAll(".chat-tool-review")).toHaveLength(1);
  });

  it("renders a persisted denial shield after the denied row leaves bounded review details", () => {
    const container = document.createElement("div");
    const group = createToolGroup("bounded-review-group", [
      createMessageEntry(
        "bounded-review-message",
        createToolResultMessage("call-bounded-review", "run_command", "completed", {
          details: {
            approvalReviews: [
              {
                id: "later-approved-review",
                label: "Guardian",
                status: "approved",
              },
            ],
            approvalReviewOutcome: "denied",
          },
          timestamp: 1000,
        }),
      ),
    ]);

    renderMessageGroups(container, [group], {
      isToolMessageExpanded: () => false,
    });

    expect(
      container.querySelector('.chat-activity-group__review-status[data-outcome="denied"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll(".chat-tool-review")).toHaveLength(0);
  });

  it("collapses paired parallel tool cards from one message into an activity group", () => {
    const container = document.createElement("div");
    const group = createToolGroup("parallel-tool-group", [
      createMessageEntry(
        "parallel-tool-message",
        createAssistantMessage(
          [
            createToolCall("call-a", "read", { path: "/repo/a.ts" }, { type: "toolCall" }),
            createToolCall("call-b", "read", { path: "/repo/b.ts" }, { type: "toolCall" }),
            createToolResultBlock("call-a", "read", "File A"),
            createToolResultBlock("call-b", "read", "File B"),
          ],
          { timestamp: 1000 },
        ),
      ),
    ]);

    renderMessageGroups(container, [group], {
      isToolMessageExpanded: (id) => (id === "activity:parallel-tool-group" ? false : undefined),
    });

    const activity = expectElement(container, ".chat-activity-group__summary", HTMLButtonElement);
    expect(activity.textContent).toContain("Read 2 files");
    expect(
      expectElement(activity, ".chat-activity-group__label", HTMLElement).getAttribute("title"),
    ).toBe("Read 2 files");
    expect(container.querySelectorAll(".chat-activity-group")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("renders consecutive original tool groups behind one activity summary", () => {
    const container = document.createElement("div");
    const groups = [
      createToolGroup("tool-group-1", [
        createMessageEntry(
          "tool-message-1",
          createToolResultMessage("call-1", "run_command", "one"),
        ),
        createMessageEntry("tool-message-2", createToolResultMessage("call-2", "read_file", "two")),
      ]),
      createToolGroup("tool-group-2", [
        createMessageEntry(
          "tool-message-3",
          createToolResultMessage("call-3", "write_file", "three"),
        ),
      ]),
    ];

    render(
      renderActivityGroup(groups, {
        showReasoning: true,
        showToolCalls: true,
        assistantName: "OpenClaw",
        isToolMessageExpanded: (id) => id === "activity:tool-group-1",
      }),
      container,
    );

    expect(container.querySelectorAll(".chat-activity-group")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-activity-group__summary")).toHaveLength(1);
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toContain(
      "Ran a command, read a file, created a file",
    );
    expect(container.querySelectorAll(".chat-activity-group__body > .chat-bubble")).toHaveLength(3);
    expect(
      container.querySelectorAll(".chat-activity-group__body .chat-activity-group"),
    ).toHaveLength(0);
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-message-id]")].map(
        (row) => row.dataset.messageId,
      ),
    ).toEqual(["tool-message-1", "tool-message-2", "tool-message-3"]);
  });

  it("keeps aggregate expansion and accessibility ids stable when groups append", () => {
    const container = document.createElement("div");
    const groups = [
      createToolGroup("stable-first", [
        createMessageEntry("stable-1", createToolResultMessage("call-1", "read_file", "one")),
      ]),
      createToolGroup("stable-second", [
        createMessageEntry("stable-2", createToolResultMessage("call-2", "read_file", "two")),
      ]),
      createToolGroup("stable-third", [
        createMessageEntry("stable-3", createToolResultMessage("call-3", "read_file", "three")),
      ]),
    ];
    const opts: RenderMessageGroupOptions = {
      showReasoning: true,
      showToolCalls: true,
      isToolMessageExpanded: (id) => id === "activity:stable-first",
    };

    render(renderActivityGroup(groups.slice(0, 2), opts), container);
    const initialSummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    const initialBodyId = initialSummary.getAttribute("aria-controls");
    expect(initialSummary.getAttribute("aria-expanded")).toBe("true");
    expect(initialBodyId).toMatch(/^activity-body-[0-9a-f]+$/);
    expect(container.querySelector(`[id="${initialBodyId}"]`)).not.toBeNull();

    render(renderActivityGroup(groups, opts), container);
    const appendedSummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(appendedSummary.getAttribute("aria-controls")).toBe(initialBodyId);
    expect(appendedSummary.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".chat-activity-group__body > .chat-bubble")).toHaveLength(3);
  });

  it("uses the newest group's live card label without inheriting an earlier failure", () => {
    const container = document.createElement("div");
    const groups = [
      createToolGroup("live-first", [
        createMessageEntry(
          "failed-read",
          createToolResultMessage("call-read", "read", JSON.stringify({ error: "failed" }), {
            isError: true,
          }),
        ),
      ]),
      createToolGroup(
        "live-second",
        [
          createMessageEntry("running-edit", {
            role: "assistant",
            __openclawToolStreamLive: true,
            __openclawToolStreamResultReceived: false,
            content: [
              {
                type: "tool_use",
                id: "call-edit",
                name: "edit",
                input: { path: "/repo/src/a.ts", oldText: "old", newText: "new" },
              },
            ],
          }),
        ],
        { isStreaming: true },
      ),
    ];
    const opts = { showReasoning: true, showToolCalls: true, runActive: true };

    render(renderActivityGroup(groups, opts), container);
    const activitySummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
    expect(activitySummary.getAttribute("aria-label")).toBeNull();
    expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
      "Editing a.ts…",
    );

    render(renderActivityGroup(groups, { ...opts, runActive: false }), container);
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
      "Read a file, edited a file",
    );
  });

  it("keeps cross-group activity neutral while retaining failed child badges", () => {
    const container = document.createElement("div");
    const failedMessage = (id: string) =>
      createAssistantMessage(
        [
          {
            type: "tool_use",
            id,
            name: "bash",
            input: { command: "run primary" },
          },
          createToolResultBlock(id, "bash", "Primary path failed", { isError: true }),
        ],
        { isError: true },
      );
    const failed = createToolGroup("failed", [
      createMessageEntry("failed-message", failedMessage("call-failed")),
    ]);
    const successful = createToolGroup("successful", [
      createMessageEntry("successful-message", createToolResultMessage("call-ok", "read", "ok")),
    ]);

    render(
      renderActivityGroup([failed, successful], {
        showReasoning: true,
        showToolCalls: true,
      }),
      container,
    );
    const recoveredSummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    expect(recoveredSummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(recoveredSummary.getAttribute("aria-expanded")).toBe("false");
    expect(recoveredSummary.getAttribute("aria-label")).toBeNull();
    expect(container.querySelector(".chat-activity-group__label")?.textContent).not.toContain(
      "failed",
    );

    render(
      renderActivityGroup([failed, successful], {
        showReasoning: true,
        showToolCalls: true,
        isToolMessageExpanded: (id) => id === "activity:failed",
      }),
      container,
    );
    expect(container.querySelector(".chat-activity-group__summary--error")).toBeNull();
    expect(container.querySelectorAll(".chat-tool-msg-summary--error")).toHaveLength(0);

    render(
      renderActivityGroup([successful, failed], {
        showReasoning: true,
        showToolCalls: true,
      }),
      container,
    );
    const failedSummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    expect(failedSummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(failedSummary.getAttribute("aria-expanded")).toBe("false");
    expect(failedSummary.getAttribute("aria-label")).toBeNull();
  });

  it("uses the running mutation verb in an active group summary", () => {
    const container = document.createElement("div");
    const group = createToolGroup(
      "running-tool-group",
      [
        createMessageEntry("finished-read", {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: "done",
        }),
        createMessageEntry("running-edit", {
          role: "assistant",
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: false,
          content: [
            {
              type: "tool_use",
              id: "call-edit",
              name: "edit",
              input: { path: "/repo/src/a.ts", oldText: "old", newText: "new" },
            },
          ],
        }),
      ],
      { timestamp: 1000, isStreaming: true },
    );

    renderMessageGroups(container, [group], { runActive: true });

    expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
      "Editing a.ts…",
    );
  });

  it("keeps failed activity collapsed with neutral chain chrome", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onToggleToolMessageExpanded = vi.fn();
    const group = createToolGroup("tool-group", [
      createMessageEntry(
        "tool-message-1",
        createToolResultMessage("call-1", "read_file", JSON.stringify({ error: "Read failed" }), {
          isError: true,
          timestamp: 1000,
        }),
      ),
      createMessageEntry(
        "tool-message-2",
        createToolResultMessage("call-2", "run_command", "Command output", {
          timestamp: 1001,
        }),
      ),
    ]);

    renderMessageGroups(container, [group], { onToggleToolMessageExpanded });

    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    const activitySummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(activitySummary.getAttribute("aria-label")).toBeNull();
    expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
    expect(activitySummary.textContent).not.toContain("failed");
    expect(activitySummary.querySelector(".chat-activity-group__badge")).toBeNull();
    selectText(expectElement(activitySummary, ".chat-activity-group__label", HTMLElement));
    pointerClick(activitySummary);
    expect(onToggleToolMessageExpanded).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
    activitySummary.click();

    expect(onToggleToolMessageExpanded).toHaveBeenCalledWith("activity:tool-group", false);
    container.remove();
  });

  it("keeps recovered grouped activity collapsed without a failure summary", () => {
    const container = document.createElement("div");
    const group = createToolGroup("tool-group", [
      createMessageEntry(
        "tool-message-1",
        createToolResultMessage("call-1", "web_search", JSON.stringify({ error: "No matches" }), {
          isError: true,
          timestamp: 1000,
        }),
      ),
      createMessageEntry(
        "tool-message-2",
        createToolResultMessage("call-2", "read_file", "Fallback context", {
          timestamp: 1001,
        }),
      ),
    ]);

    renderMessageGroups(container, [group]);

    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    expect(container.querySelector(".chat-activity-group__summary--error")).toBeNull();
    expect(container.querySelector(".chat-activity-group__label")?.textContent).not.toContain(
      "failed",
    );
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("keeps recovered coalesced tool failures neutral in the activity list", () => {
    const container = document.createElement("div");
    const group = createToolGroup("recovered-tool-group", [
      createMessageEntry(
        "recovered-tool-message",
        createAssistantMessage(
          [
            {
              type: "tool_use",
              id: "call-recovered",
              name: "bash",
              input: { command: "run fallback" },
            },
            createToolResultBlock("call-recovered", "bash", "Primary path failed", {
              isError: true,
            }),
          ],
          { isError: true, timestamp: 1000 },
        ),
      ),
      createMessageEntry(
        "recovered-followup",
        createToolResultMessage("call-followup", "read_file", "Fallback context", {
          timestamp: 1001,
        }),
      ),
    ]);

    renderMessageGroups(container, [group], {
      isToolMessageExpanded: (id) => id === "activity:recovered-tool-group",
    });

    const summaries = container.querySelectorAll(".chat-tool-msg-summary");
    expect(summaries).toHaveLength(2);
    expect(container.querySelector(".chat-activity-group__summary--error")).toBeNull();
    expect(container.querySelector(".chat-activity-group__label")?.textContent).not.toContain(
      "failed",
    );
    expect(container.querySelectorAll(".chat-tool-msg-summary--error")).toHaveLength(0);
    // Command calls render a `$ command` row instead of the tool-name label.
    expect(summaries[0]?.querySelector(".chat-tool-row__cmd")?.textContent).toBe("run fallback");
  });

  it("hides grouped tool activity when tool calls are disabled", () => {
    const container = document.createElement("div");
    const group = createToolGroup("tool-group", [
      createMessageEntry(
        "tool-message-1",
        createToolResultMessage("call-1", "read_file", "File one", { timestamp: 1000 }),
      ),
      createMessageEntry(
        "tool-message-2",
        createToolResultMessage("call-2", "run_command", "Command output", {
          timestamp: 1001,
        }),
      ),
    ]);

    renderMessageGroups(container, [group], { showToolCalls: false });

    expect(container.querySelector(".chat-activity-group")).toBeNull();
  });

  it("keeps inline tool cards collapsed by default and renders expanded state", () => {
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [
        createToolCall("call-1", "browser.open", { url: "https://example.com" }),
        createToolResultBlock("call-1", "browser.open", "Opened page", {
          type: "toolresult",
        }),
      ],
      { id: "assistant-1", toolCallId: "call-1" },
    );
    renderAssistantMessage(container, message, {
      isToolExpanded: () => false,
    });

    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

    renderAssistantMessage(container, message, {
      isToolExpanded: () => true,
    });

    // Simple object args render as key-value rows; only the output keeps a block.
    const kvRow = container.querySelector(".chat-tool-kv__row");
    expect(kvRow?.querySelector(".chat-tool-kv__key")?.textContent).toBe("url:");
    expect(kvRow?.querySelector(".chat-tool-kv__value")?.textContent).toBe("https://example.com");
    const blocks = Array.from(container.querySelectorAll(".chat-tool-card__block"));
    // Plain output is the block's default content, so it carries no header.
    expect(blocks[0]?.querySelector(".chat-tool-card__block-label")).toBeNull();
    expect(blocks[0]?.querySelector("code")?.textContent).toBe("Opened page");
  });

  it("renders expanded standalone tool-call rows", () => {
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [createToolCall("call-4b", "sessions_spawn", { mode: "session", thread: true })],
      { id: "assistant-4b", toolCallId: "call-4b" },
    );
    renderAssistantMessage(container, message, {
      isToolExpanded: () => false,
    });

    expectElement(container, ".chat-bubble--tool-shell", HTMLElement);
    const summary = container.querySelector<HTMLElement>(".chat-tool-msg-summary");
    expect(summary?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Sub-agent");
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

    renderAssistantMessage(container, message, {
      isToolExpanded: () => true,
    });

    // Simple object args render as key-value rows instead of a raw JSON block.
    expect(container.querySelector(".chat-tool-card__block")).toBeNull();
    const kvRows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
    expect(
      kvRows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["mode:", "session"],
      ["thread:", "true"],
    ]);
  });

  it("renders assistant tool content as a flat concise tool row without a top-level call id", () => {
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [
        {
          type: "tool_use",
          id: "call-content-only",
          name: "bash",
          input: { command: "bash" },
        },
      ],
      { id: "assistant-tool-content" },
    );

    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => false,
    });

    expectElement(container, ".chat-bubble--tool-shell", HTMLElement);
    const summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    // Command calls render a `$ command` row instead of the tool-name label.
    expect(summary.querySelector(".chat-tool-row__cmd")?.textContent).toBe("bash");
    expect(summary.querySelector(".chat-tool-msg-summary__names")).toBeNull();
  });

  it("keeps top-level tool-name results collapsed", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage("A long tool result that should stay behind the disclosure.", {
        toolName: "bash",
      }),
      { isToolMessageExpanded: () => false },
    );

    expectElement(container, ".chat-bubble--tool-shell", HTMLElement);
    expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(container.querySelector(".chat-text")).toBeNull();
  });

  it("omits normalized duplicate names from standalone tool results", () => {
    const container = document.createElement("div");
    const message = createToolResultMessage("call-heartbeat", "heartbeat_respond", [
      {
        type: "tool_result",
        name: "heartbeat_respond",
        text: "Acknowledged",
      },
    ]);

    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => false,
    });

    const summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Heartbeat Respond",
    );
    expect(summary.querySelector(".chat-tool-msg-summary__names")).toBeNull();
  });

  it("cleans collapsed tool connector copy while preserving expanded raw input", () => {
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [createToolCall("call-string-tool", "presentation_create", "with Example Deck")],
      { id: "assistant-string-tool", toolCallId: "call-string-tool" },
    );
    renderAssistantMessage(container, message, {
      isToolExpanded: () => false,
    });

    // The cleaned string-arg preview is now the primary collapsed label.
    expect(container.querySelector(".chat-tool-msg-summary__label")?.textContent?.trim()).toBe(
      "Example Deck",
    );
    expect(container.querySelector(".chat-tool-msg-summary__names")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary")?.textContent).not.toContain(
      "with Example Deck",
    );

    renderAssistantMessage(container, message, {
      isToolExpanded: () => true,
    });

    expect(container.querySelector(".chat-tool-msg-body")?.textContent).not.toContain(
      "presentation_create",
    );
    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(
      "with Example Deck",
    );
  });

  it("renders expanded tool output rows and their json content", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          createAssistantMessage(
            [createToolCall("call-5", "sessions_spawn", { mode: "session", thread: true })],
            { id: "assistant-5", toolCallId: "call-5" },
          ),
          "assistant",
        ),
        createMessageGroup(
          createToolResultMessage(
            "call-5",
            "sessions_spawn",
            JSON.stringify(
              {
                status: "error",
                error: "Session mode is unavailable for this target.",
                childSessionKey: "agent:test:subagent:abc123",
              },
              null,
              2,
            ),
            { id: "tool-5", role: "tool", timestamp: Date.now() + 1 },
          ),
          "tool",
        ),
      ],
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
      },
    );

    // The call's simple args render as key-value rows; the error keeps a block.
    const kvRows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
    expect(
      kvRows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["mode:", "session"],
      ["thread:", "true"],
    ]);
    const blocks = Array.from(container.querySelectorAll(".chat-tool-card__block"));
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool error"]);
    expect(JSON.parse(blocks[0]?.querySelector("code")?.textContent ?? "{}")).toEqual({
      status: "error",
      error: "Session mode is unavailable for this target.",
      childSessionKey: "agent:test:subagent:abc123",
    });
  });

  it("respects explicit success on collapsed standalone tool-result summaries", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          createToolResultMessage(
            "call-error-collapsed",
            "web_search",
            JSON.stringify({
              error: "missing_brave_api_key",
              message: "BRAVE_API_KEY is not configured",
            }),
            { id: "tool-error-collapsed", isError: false },
          ),
          "tool",
        ),
      ],
      {
        isToolMessageExpanded: () => false,
      },
    );

    const summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    expect(summary.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe("web_search");
    expect(summary.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("respects explicit success on MCP-style standalone tool-result summaries", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          createToolResultMessage(
            "call-error-collapsed-mcp",
            "memory_forget",
            JSON.stringify({
              isError: true,
              content: [{ type: "text", text: "Tool error: boom" }],
            }),
            { id: "tool-error-collapsed-mcp", isError: false },
          ),
          "tool",
        ),
      ],
      {
        isToolMessageExpanded: () => false,
      },
    );

    const summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    expect(summary.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "memory_forget",
    );
    expect(summary.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
  });

  it("keeps status-only standalone tool-result summaries neutral until expanded", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onToggleToolMessageExpanded = vi.fn();
    const groups = [
      createMessageGroup(
        createToolResultMessage(
          "call-status-error",
          "sessions_spawn",
          JSON.stringify({ status: "error" }, null, 2),
          { id: "tool-status-error" },
        ),
        "tool",
      ),
    ];

    renderMessageGroups(container, groups, {
      isToolMessageExpanded: () => false,
      onToggleToolMessageExpanded,
    });

    let summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    expect(summary.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "sessions_spawn",
    );
    selectText(expectElement(summary, ".chat-tool-msg-summary__label", HTMLElement));
    pointerClick(summary);
    expect(onToggleToolMessageExpanded).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
    summary.click();
    expect(onToggleToolMessageExpanded).toHaveBeenCalledOnce();

    renderMessageGroups(container, groups, {
      isToolMessageExpanded: () => true,
    });

    summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    // The failure stays recorded: the expanded body closes with the outcome.
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
    expect(
      JSON.parse(container.querySelector(".chat-json-content code")?.textContent ?? "{}"),
    ).toEqual({ status: "error" });
    container.remove();
  });

  it("surfaces a producer-reported exit code in the expanded failure outcome", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const groups = [
      createMessageGroup(
        createToolResultMessage(
          "call-exit-code",
          "shell",
          JSON.stringify({ status: "failed", exitCode: 1 }),
          { id: "tool-exit-code" },
        ),
        "tool",
      ),
    ];

    renderMessageGroups(container, groups, { isToolMessageExpanded: () => true });

    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("Exit code 1");
    container.remove();
  });

  it("renders an expanded orphan tool result without a nested disclosure", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          createToolResultMessage("call-orphan", "read", "Orphan tool output", {
            id: "orphan-tool-result",
          }),
          "tool",
        ),
      ],
      { isToolMessageExpanded: () => true },
    );

    expect(container.querySelector(".chat-tool-msg-body .chat-tool-msg-summary")).toBeNull();
    expect(container.querySelectorAll(".chat-tool-card__block code")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(
      "Orphan tool output",
    );
  });

  it("keeps text visible beside an orphan tool-result image", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          createToolResultMessage("call-image", "image", [
            { type: "text", text: "Generated image" },
            { type: "image", data: "cG5n", mimeType: "image/png", alt: "Generated preview" },
          ]),
          "tool",
        ),
      ],
      { isToolMessageExpanded: () => true },
    );

    expect(container.querySelector(".chat-text")?.textContent).toContain("Generated image");
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,cG5n");
    expect(container.querySelector(".chat-tool-msg-body .chat-tool-msg-summary")).not.toBeNull();
  });

  it("collapses an inline tool call while keeping matching tool output visible", () => {
    const container = document.createElement("div");
    const groups = [
      createMessageGroup(
        createAssistantMessage(
          [
            createToolCall("call-tool-messages", "sessions_spawn", {
              mode: "session",
              thread: true,
            }),
          ],
          { id: "assistant-tool-messages", toolCallId: "call-tool-messages" },
        ),
        "assistant",
      ),
      createMessageGroup(
        createToolResultMessage(
          "call-tool-messages",
          "sessions_spawn",
          JSON.stringify({ status: "error" }, null, 2),
          { id: "tool-tool-messages", role: "tool", timestamp: Date.now() + 1 },
        ),
        "tool",
      ),
    ];
    renderMessageGroups(container, groups, {
      isToolExpanded: () => true,
      isToolMessageExpanded: () => true,
    });

    // The call's simple args render as key-value rows while expanded.
    const kvRows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
    expect(
      kvRows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["mode:", "session"],
      ["thread:", "true"],
    ]);
    expect(
      JSON.parse(container.querySelector(".chat-json-content code")?.textContent ?? "{}"),
    ).toEqual({
      status: "error",
    });

    // Collapsing the call card must not hide the matching tool output message.
    renderMessageGroups(container, groups, {
      isToolExpanded: () => false,
      isToolMessageExpanded: () => true,
    });

    expect(container.querySelector(".chat-tool-kv")).toBeNull();
    expect(
      JSON.parse(container.querySelector(".chat-json-content code")?.textContent ?? "{}"),
    ).toEqual({
      status: "error",
    });
  });

  it("renders assistant MEDIA attachments, voice-note badge, and reply preview", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const onOpenImage = vi.fn();
    renderAssistantMessage(
      container,
      createAssistantMessage(
        "Here is the image.\nMEDIA:https://example.com/photo.png\nMEDIA:https://example.com/voice.ogg",
        {
          id: "assistant-media-inline",
          openclawDelivery: { audioAsVoice: true, replyToCurrent: true },
        },
      ),
      { showToolCalls: false, onOpenImage },
    );

    expect(container.querySelector(".chat-reply-preview__label")?.textContent?.trim()).toBe(
      "Replying to current message",
    );
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("Here is the image.");
    expect(expectElement(container, ".chat-message-image", HTMLImageElement).src).toBe(
      "https://example.com/photo.png",
    );
    expectElement(container, ".chat-message-image-button", HTMLButtonElement).click();
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "https://example.com/photo.png",
      title: "photo.png",
    });
    const audioPlayer = await requireAudioPlayer(container);
    expect(expectElement(audioPlayer, "audio", HTMLAudioElement).src).toBe(
      "https://example.com/voice.ogg",
    );
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Voice note",
    );
  });

  it("renders a clickable quoted preview for structured user replies", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenReply = vi.fn();
    renderGroupedMessage(
      container,
      createUserMessage("Follow up", {
        __openclaw: { replyToId: "transcript-123" },
      }),
      "user",
      {
        resolveReplyPreview: () => ({
          messageId: "source-message",
          sourceMessageId: "transcript-123",
          senderLabel: "Marie",
          text: "The original answer",
        }),
        onOpenReply,
      },
    );

    const preview = container.querySelector<HTMLButtonElement>(".chat-reply-preview--message");
    expect(preview?.textContent).toContain("Replying to Marie");
    expect(preview?.textContent).toContain("The original answer");
    preview?.click();
    expect(onOpenReply).toHaveBeenCalledWith("transcript-123");
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("Follow up");
  });

  it("keeps unloaded persisted previews clickable for history navigation", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenReply = vi.fn();
    renderGroupedMessage(
      container,
      createUserMessage("Follow up", {
        __openclaw: {
          replyToId: "unloaded-message",
          replyToPreview: { senderLabel: "Marie", text: "The original answer" },
        },
      }),
      "user",
      { onOpenReply },
    );

    const preview = container.querySelector<HTMLButtonElement>(".chat-reply-preview--message");
    expect(preview?.textContent).toContain("Replying to Marie");
    expect(preview?.textContent).toContain("The original answer");
    expect(preview).toBeInstanceOf(HTMLButtonElement);
    preview?.click();
    expect(onOpenReply).toHaveBeenCalledWith("unloaded-message");
  });

  it("shows a busy state while loading history for a reply target", () => {
    const container = document.body.appendChild(document.createElement("div"));
    renderGroupedMessage(
      container,
      createUserMessage("Follow up", {
        __openclaw: {
          replyToId: "unloaded-message",
          replyToPreview: { senderLabel: "Marie", text: "The original answer" },
        },
      }),
      "user",
      { onOpenReply: vi.fn(), replyNavigationId: "unloaded-message" },
    );

    const preview = container.querySelector<HTMLButtonElement>(".chat-reply-preview--message");
    expect(preview?.disabled).toBe(true);
    expect(preview?.getAttribute("aria-busy")).toBe("true");
    expect(preview?.querySelector(".session-run-spinner")).toBeInstanceOf(HTMLElement);
  });

  it("notifies when assistant audio and video attachment metadata loads", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const onAssistantAttachmentLoaded = vi.fn();

    renderAssistantMessage(
      container,
      createAssistantMessage(
        "Audio and video\nMEDIA:https://example.com/voice.ogg\nMEDIA:https://example.com/clip.mp4",
        {
          id: "assistant-media-layout",
        },
      ),
      { showToolCalls: false, onAssistantAttachmentLoaded },
    );

    const audioPlayer = await requireAudioPlayer(container);
    expectElement(audioPlayer, "audio", HTMLAudioElement).dispatchEvent(
      new Event("loadedmetadata", { bubbles: true }),
    );
    expectElement(container, "video", HTMLVideoElement).dispatchEvent(
      new Event("loadedmetadata", { bubbles: true }),
    );

    expect(onAssistantAttachmentLoaded).toHaveBeenCalledTimes(2);
  });

  it("notifies when streamed audio and video attachment metadata loads", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const onAssistantAttachmentLoaded = vi.fn();

    render(
      renderStreamGroup(
        [
          {
            kind: "stream",
            key: "stream:media:live",
            text:
              "Streaming audio and video\n" +
              "MEDIA:https://example.com/voice.ogg\n" +
              "MEDIA:https://example.com/clip.mp4",
            startedAt: 1,
            isStreaming: true,
          },
        ],
        { onAssistantAttachmentLoaded },
      ),
      container,
    );

    const audioPlayer = await requireAudioPlayer(container);
    expectElement(audioPlayer, "audio", HTMLAudioElement).dispatchEvent(
      new Event("loadedmetadata", { bubbles: true }),
    );
    expectElement(container, "video", HTMLVideoElement).dispatchEvent(
      new Event("loadedmetadata", { bubbles: true }),
    );

    expect(onAssistantAttachmentLoaded).toHaveBeenCalledTimes(2);
  });

  it("checks local assistant audio against server metadata while preview roots load", async () => {
    const source = `/home/node/.openclaw/media/outbound/${crypto.randomUUID()}.mp3`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new URL(url, "http://control.test").pathname).toBe("/__openclaw__/assistant-media");
      expect(url).toContain("meta=1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
      return {
        ok: true,
        json: async () => ({ ...mediaTicketPayload("ticket-bootstrap-audio"), durationMs: 2_345 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const renderMessage = () =>
      renderAssistantMessage(
        container,
        createAssistantMessage(`Your recording\nMEDIA:${source}`, {
          id: "assistant-local-audio-bootstrap-roots",
        }),
        {
          showToolCalls: false,
          resourceBasePath: "",
          assistantAttachmentAuthToken: "session-token",
          localMediaPreviewRoots: [],
          onRequestUpdate: renderMessage,
        },
      );

    renderMessage();
    expect(container.textContent).not.toContain("Outside allowed folders");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushAssistantAttachmentAvailabilityChecks();

    const audioPlayer = await requireAudioPlayer(container);
    const audio = expectElement(audioPlayer, "audio", HTMLAudioElement);
    expect(audio.getAttribute("src")).toBe(
      `/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-bootstrap-audio`,
    );
    expect((audioPlayer as unknown as { serverDurationMs?: number }).serverDurationMs).toBe(2_345);
  });

  it("resolves managed transcode audio through an artifact ticket", async () => {
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const ticketedUrl = `${source}?mediaTicket=managed-ticket`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${ticketedUrl}&playback=1`);
      expect(init?.method).toBe("HEAD");
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const rerender = () =>
      renderAssistantMessage(
        container,
        createAssistantAudioMessage(
          source,
          {
            artifactId,
            fileName: "voice.caf",
            mimeType: "audio/x-caf",
            playback: "transcode",
            sizeBytes: 4_096,
            durationMs: 2_345,
          },
          { id: "assistant-managed-transcode-audio" },
        ),
        {
          showToolCalls: false,
          assistantAttachmentAuthToken: "must-not-be-forwarded",
          onRequestUpdate: rerender,
          resolveArtifactDownload,
        },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    const player = await requireAudioPlayer(container);
    await flushAssistantAttachmentAvailabilityChecks();
    await player.updateComplete;

    expect(resolveArtifactDownload).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      artifactId,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(expectElement(player, "audio", HTMLAudioElement).getAttribute("src")).toBe(
      `${ticketedUrl}&playback=1`,
    );
    expect((player as unknown as { serverDurationMs?: number }).serverDurationMs).toBeUndefined();
  });

  it("keeps a valid managed media ticket while refresh retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const ticketedUrl = `${source}?mediaTicket=managed-old`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string; expiresAt: string }>>()
      .mockResolvedValueOnce({
        url: ticketedUrl,
        expiresAt: new Date(Date.now() + 31_000).toISOString(),
      })
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-managed-ticket-refresh",
          role: "assistant",
          content: [
            {
              type: "audio",
              artifactId,
              url: source,
              fileName: "voice.mp3",
              mimeType: "audio/mpeg",
              playback: "native",
            },
          ],
          timestamp: Date.now(),
        },
        { showToolCalls: false, onRequestUpdate: rerender, resolveArtifactDownload },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    const player = await requireAudioPlayer(container);
    expect(expectElement(player, "audio", HTMLAudioElement).getAttribute("src")).toBe(ticketedUrl);

    await vi.advanceTimersByTimeAsync(1_001);
    await flushAssistantAttachmentAvailabilityChecks();
    await player.updateComplete;

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).toBeNull();
    expect(expectElement(player, "audio", HTMLAudioElement).getAttribute("src")).toBe(ticketedUrl);
  });

  it("backs off stale managed ticket refreshes and eventually marks them unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    let finishSecondRequest: (() => void) | undefined;
    const resolveArtifactDownload = vi.fn(() => {
      const requestNumber = resolveArtifactDownload.mock.calls.length;
      const result = {
        url: `${source}?mediaTicket=stale-${requestNumber}`,
        expiresAt: new Date(Date.now() + (requestNumber === 1 ? 6_000 : -1_000)).toISOString(),
      };
      if (requestNumber !== 2) {
        return Promise.resolve(result);
      }
      return new Promise<typeof result>((resolve) => {
        finishSecondRequest = () => resolve(result);
      });
    });
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-managed-stale-ticket-refresh",
          role: "assistant",
          content: [
            {
              type: "audio",
              artifactId,
              url: source,
              fileName: "voice.mp3",
              mimeType: "audio/mpeg",
              playback: "native",
            },
          ],
          timestamp: Date.now(),
        },
        { showToolCalls: false, onRequestUpdate: rerender, resolveArtifactDownload },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector("openclaw-chat-audio-player")).toBeNull();
    finishSecondRequest?.();
    await flushAssistantAttachmentAvailabilityChecks();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
  });

  it("retains the current managed ticket until expiry after refresh exhaustion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const expiresAt = new Date(Date.now() + 20_000).toISOString();
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi.fn(async () => ({
      url: `${source}?mediaTicket=short-${resolveArtifactDownload.mock.calls.length}`,
      expiresAt,
    }));
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-managed-ticket-exhaustion",
          role: "assistant",
          content: [
            {
              type: "audio",
              artifactId,
              url: source,
              fileName: "voice.mp3",
              mimeType: "audio/mpeg",
              playback: "native",
            },
          ],
          timestamp: Date.now(),
        },
        { showToolCalls: false, onRequestUpdate: rerender, resolveArtifactDownload },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushAssistantAttachmentAvailabilityChecks();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
    expect(
      container.querySelector("openclaw-chat-audio-player audio")?.getAttribute("src"),
    ).toContain("mediaTicket=short-2");
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).toBeNull();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
  });

  it("retains a longer-lived incoming managed ticket after refresh exhaustion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const initialExpiry = Date.now() + 20_000;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi.fn(async () => ({
      url: `${source}?mediaTicket=short-${resolveArtifactDownload.mock.calls.length}`,
      expiresAt: new Date(
        resolveArtifactDownload.mock.calls.length === 3 ? Date.now() + 20_000 : initialExpiry,
      ).toISOString(),
    }));
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-managed-later-ticket",
          role: "assistant",
          content: [
            {
              type: "audio",
              artifactId,
              url: source,
              fileName: "voice.mp3",
              mimeType: "audio/mpeg",
              playback: "native",
            },
          ],
          timestamp: Date.now(),
        },
        { showToolCalls: false, onRequestUpdate: rerender, resolveArtifactDownload },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushAssistantAttachmentAvailabilityChecks();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
    expect(
      container.querySelector("openclaw-chat-audio-player audio")?.getAttribute("src"),
    ).toContain("mediaTicket=short-3");

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
  });

  it("refreshes a managed attachment that arrives with an initial ticket", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const rawSource = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const source = `${rawSource}?mediaTicket=initial`;
    const refreshedSource = `${rawSource}?mediaTicket=refreshed`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: refreshedSource }));
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-managed-initial-ticket",
          role: "assistant",
          content: [
            {
              type: "audio",
              artifactId,
              url: source,
              fileName: "voice.mp3",
              mimeType: "audio/mpeg",
              playback: "native",
            },
          ],
          timestamp: Date.now(),
        },
        { showToolCalls: false, onRequestUpdate: rerender, resolveArtifactDownload },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    const player = await requireAudioPlayer(container);

    expect(resolveArtifactDownload).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      artifactId,
    });
    expect(expectElement(player, "audio", HTMLAudioElement).getAttribute("src")).toBe(
      refreshedSource,
    );

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_001);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
  });

  it("does not render an unticketed managed attachment without an artifact resolver", () => {
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantAudioMessage(
        source,
        {
          artifactId: `artifact_managed_media_${crypto.randomUUID()}`,
          fileName: "voice.mp3",
          mimeType: "audio/mpeg",
          playback: "native",
        },
        { id: "assistant-managed-media-without-resolver" },
      ),
      { showToolCalls: false },
    );

    expect(container.querySelector("openclaw-chat-audio-player")).toBeNull();
    expect(
      container.querySelector(".chat-assistant-attachment-card--blocked")?.textContent,
    ).toContain("Unavailable");
  });

  it("checks local assistant images against server metadata while preview roots load", async () => {
    const source = `/home/node/.openclaw/media/outbound/${crypto.randomUUID()}.png`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("meta=1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
      return { ok: true, json: async () => mediaTicketPayload("ticket-bootstrap-image") };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    const renderMessage = () =>
      renderAssistantMessage(
        container,
        createAssistantImageMessage(
          source,
          "Local bootstrap image",
          {},
          {
            id: "assistant-local-image-bootstrap-roots",
          },
        ),
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "session-token",
          localMediaPreviewRoots: [],
          onRequestUpdate: renderMessage,
        },
      );

    renderMessage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushAssistantAttachmentAvailabilityChecks();

    const image = expectElement(container, ".chat-message-image", HTMLImageElement);
    expect(image.getAttribute("src")).toBe(
      `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-bootstrap-image`,
    );
  });

  it.each([
    {
      code: "outside-allowed-folders",
      reason: "Outside allowed folders",
      source: "/home/node/private/bootstrap-secret.mp3",
    },
    {
      code: "file-not-found",
      reason: "File not found",
      source: "/home/node/.openclaw/media/outbound/bootstrap-missing.mp3",
    },
  ] as const)(
    "keeps server-rejected $code media blocked while preview roots load",
    async ({ code, reason, source }) => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toContain("meta=1");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
        return { ok: true, json: async () => ({ available: false, code, reason }) };
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const container = document.createElement("div");
      const renderMessage = () =>
        renderAssistantMessage(
          container,
          createAssistantMessage(`Unavailable recording\nMEDIA:${source}`, {
            id: `assistant-bootstrap-blocked-${code}`,
          }),
          {
            showToolCalls: false,
            resourceBasePath: "/openclaw",
            assistantAttachmentAuthToken: "session-token",
            localMediaPreviewRoots: [],
            onRequestUpdate: renderMessage,
          },
        );

      renderMessage();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await flushAssistantAttachmentAvailabilityChecks();

      await vi.waitFor(() => {
        expect(
          container.querySelector(
            ".chat-assistant-attachment-card--blocked .chat-assistant-attachment-card__reason",
          )?.textContent,
        ).toContain(reason);
      });
      expect(container.querySelector("audio")).toBeNull();
      expect(container.querySelector(".chat-assistant-attachment-card__link")).toBeNull();
    },
  );

  it("shows the download fallback when the video element emits an error", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";

    renderAssistantMessage(
      container,
      createAssistantMessage(
        [createAttachmentBlock("https://example.com/clip.mp4", "video", "clip.mp4", "video/mp4")],
        { id: "assistant-video-unplayable" },
      ),
      { showToolCalls: false },
    );

    const videoPlayer = await requireVideoPlayer(container);
    const card = expectElement(videoPlayer, ".chat-assistant-attachment-card--video", HTMLElement);
    expectElement(card, "video", HTMLVideoElement).dispatchEvent(new Event("error"));
    await videoPlayer.updateComplete;
    expect(card.hasAttribute("data-unplayable")).toBe(true);
    expect(card.querySelector(".chat-assistant-video-fallback")?.textContent).toContain(
      "Can't play this format — download instead.",
    );
    expect(card.querySelector<HTMLAnchorElement>(".chat-assistant-video-fallback a")?.href).toBe(
      "https://example.com/clip.mp4",
    );
    expect(
      card
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
        ?.getAttribute("download"),
    ).toBe("clip.mp4");
    expect(
      card
        .querySelector<HTMLAnchorElement>(".chat-assistant-video-fallback a")
        ?.getAttribute("download"),
    ).toBe("clip.mp4");
  });

  it("renders a text document preview with an explicit download action", async () => {
    const previewText = "A pasted note\nwith a second line.";
    const fetchMock = vi.fn(async () => new Response(previewText));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [
        createAttachmentBlock(
          "blob:https://example.com/pasted-text-preview",
          "document",
          "pasted-text-1723000000000.txt",
          "text/plain",
        ),
      ],
      { id: "assistant-text-document-preview" },
    );
    const rerender = () =>
      renderAssistantMessage(container, message, {
        showToolCalls: false,
        onRequestUpdate: rerender,
      });
    documentPreviewSubscribers.add(rerender);

    rerender();

    await vi.waitFor(() => {
      expect(
        container.querySelector(".chat-assistant-attachment-card__preview-text")?.textContent,
      ).toBe(previewText);
    });
    const card = expectElement(container, ".chat-assistant-attachment-card--document", HTMLElement);
    expect(
      card
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
        ?.getAttribute("download"),
    ).toBe("pasted-text-1723000000000.txt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders a non-text document card without fetching a preview", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");

    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          createAttachmentBlock(
            "https://example.com/report.pdf",
            "document",
            "report.pdf",
            "application/pdf",
          ),
        ],
        { id: "assistant-pdf-document-card" },
      ),
      { showToolCalls: false },
    );

    const card = expectElement(container, ".chat-assistant-attachment-card--document", HTMLElement);
    expect(
      card
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
        ?.getAttribute("download"),
    ).toBe("report.pdf");
    expect(card.querySelector(".chat-assistant-attachment-card__preview-text")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch a preview for an oversized text document", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");

    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          createAttachmentBlock(
            "https://example.com/large.txt",
            "document",
            "large.txt",
            "text/plain",
            { sizeBytes: 256 * 1024 + 1 },
          ),
        ],
        { id: "assistant-oversized-text-document" },
      ),
      { showToolCalls: false },
    );

    expect(container.querySelector(".chat-assistant-attachment-card--document")).not.toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__preview-text")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates text document previews at 16 KiB", async () => {
    const prefix = "x".repeat(16 * 1024);
    const fetchMock = vi.fn(async () => new Response(`${prefix}tail`));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [
        createAttachmentBlock(
          "https://example.com/truncated.txt",
          "document",
          "truncated.txt",
          "text/plain",
        ),
      ],
      { id: "assistant-truncated-text-document" },
    );
    const rerender = () =>
      renderAssistantMessage(container, message, {
        showToolCalls: false,
        onRequestUpdate: rerender,
      });
    documentPreviewSubscribers.add(rerender);

    rerender();

    await vi.waitFor(() => {
      expect(
        container.querySelector(".chat-assistant-attachment-card__preview-text")?.textContent,
      ).toBe(`${prefix}…`);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels an unknown-size text document stream at the preview budget", async () => {
    const chunkBytes = new TextEncoder().encode("y".repeat(1024));
    let pulls = 0;
    let cancelled = false;
    const endlessBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunkBytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(endlessBody));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [
        createAttachmentBlock(
          "https://example.com/endless.txt",
          "document",
          "endless.txt",
          "text/plain",
        ),
      ],
      { id: "assistant-endless-text-document" },
    );
    const rerender = () =>
      renderAssistantMessage(container, message, {
        showToolCalls: false,
        onRequestUpdate: rerender,
      });
    documentPreviewSubscribers.add(rerender);

    rerender();

    await vi.waitFor(() => {
      expect(
        container.querySelector(".chat-assistant-attachment-card__preview-text")?.textContent,
      ).toBe(`${"y".repeat(16 * 1024)}…`);
    });
    expect(cancelled).toBe(true);
    // The preview budget is ~17 KiB of 1 KiB chunks; an unbounded read would
    // keep pulling forever. Allow generous readahead slack.
    expect(pulls).toBeLessThan(64);
  });

  it("decodes only the preview budget from a single oversized chunk", async () => {
    const giantChunk = new TextEncoder().encode("z".repeat(1024 * 1024));
    const giantBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(giantChunk);
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(giantBody));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const decodedByteLengths: number[] = [];
    class TrackingTextDecoder extends TextDecoder {
      override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
        if (input) {
          decodedByteLengths.push(input.byteLength);
        }
        return super.decode(input, options);
      }
    }
    vi.stubGlobal("TextDecoder", TrackingTextDecoder);
    const container = document.createElement("div");
    const message = createAssistantMessage(
      [
        createAttachmentBlock(
          "https://example.com/one-giant-chunk.txt",
          "document",
          "one-giant-chunk.txt",
          "text/plain",
        ),
      ],
      { id: "assistant-oversized-chunk-text-document" },
    );
    const rerender = () =>
      renderAssistantMessage(container, message, {
        showToolCalls: false,
        onRequestUpdate: rerender,
      });
    documentPreviewSubscribers.add(rerender);

    rerender();

    await vi.waitFor(() => {
      expect(
        container.querySelector(".chat-assistant-attachment-card__preview-text")?.textContent,
      ).toBe(`${"z".repeat(16 * 1024)}…`);
    });
    // The 1 MiB chunk must be sliced to the byte budget before decoding.
    expect(Math.max(...decodedByteLengths)).toBeLessThanOrEqual((16 * 1024 + 1) * 4);
  });

  it("omits attachment anchors for unsafe transcript URLs", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";

    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          createAttachmentBlock("javascript:audio()", "audio", "unsafe.mp3", "audio/mpeg"),
          createAttachmentBlock("data:text/html,video", "video", "unsafe.mp4", "video/mp4"),
          createAttachmentBlock("vbscript:document", "document", "unsafe.pdf", "application/pdf"),
        ],
        { id: "assistant-unsafe-attachment-links" },
      ),
      { showToolCalls: false },
    );

    await requireAudioPlayer(container);
    expect(container.querySelectorAll(".chat-assistant-attachments a")).toHaveLength(0);
    expect(container.textContent).toContain("unsafe.pdf");
  });

  it("renders verified local assistant attachments through the authenticated media route", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()} test image.png`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("meta=1")) {
        const headers = init?.headers as Headers;
        expect(headers.get("Authorization")).toBe("Bearer session-token");
        return { ok: true, json: async () => mediaTicketPayload("ticket-local") };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const renderMessage = () =>
      renderAssistantMessage(
        container,
        createAssistantMessage(`Local image\nMEDIA:${source}`, {
          id: "assistant-local-media-inline",
        }),
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "session-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: renderMessage,
        },
      );

    renderMessage();
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Checking...",
    );
    await flushAssistantAttachmentAvailabilityChecks();

    const expectedMetaUrl = `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source).replaceAll("%20", "+")}&meta=1`;
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, expectedMetaUrl);
    expectSameOriginGet(fetchInit);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(expectedMetaUrl.replace("&meta=1", "&mediaTicket=ticket-local"));
  });

  it("stops checking when local assistant attachment metadata fetch stalls", async () => {
    vi.useFakeTimers();
    const source = `/tmp/openclaw/${crypto.randomUUID()}-stalled.txt`;
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("aborted", "AbortError"),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const rerender = () =>
      renderAssistantMessage(
        container,
        createAssistantMessage(`Local document\nMEDIA:${source}`, {
          id: "assistant-local-media-stalled-metadata",
        }),
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: rerender,
        },
      );

    rerender();
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Checking...",
    );

    const expectedMetaUrl = `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&meta=1`;
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, expectedMetaUrl);
    await vi.advanceTimersByTimeAsync(30_001);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchInit?.signal?.aborted).toBe(true);
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Unavailable",
    );
  });

  it("refreshes local assistant media tickets before expiry without another render", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const source = `/tmp/openclaw/${crypto.randomUUID()}-refresh.png`;
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
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-media-ticket-refresh",
          role: "assistant",
          content: `Local image\nMEDIA:${source}`,
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "test-auth-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: rerender,
        },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toContain("mediaTicket=ticket-old");
    const renderVersionBeforeRefresh = getChatMediaRenderVersion();

    await vi.advanceTimersByTimeAsync(1_001);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getChatMediaRenderVersion()).not.toBe(renderVersionBeforeRefresh);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toContain("mediaTicket=ticket-new");
  });

  it("queues refreshed audio tickets until playback needs a new source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const source = `/tmp/openclaw/${crypto.randomUUID()}-refresh.mp3`;
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
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-audio-ticket-refresh",
          role: "assistant",
          content: `Local audio\nMEDIA:${source}`,
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: rerender,
        },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    const player = await requireAudioPlayer(container);
    const audio = expectElement(player, "audio", HTMLAudioElement);
    Object.defineProperties(audio, {
      paused: { configurable: true, value: true },
      currentTime: { configurable: true, writable: true, value: 24 },
      duration: { configurable: true, value: 90 },
    });
    expect(audio.getAttribute("src")).toContain("mediaTicket=ticket-old");

    await vi.advanceTimersByTimeAsync(1_001);
    await flushAssistantAttachmentAvailabilityChecks();
    await player.updateComplete;

    expect(audio.getAttribute("src")).toContain("mediaTicket=ticket-old");
    expect(
      player.querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")?.href,
    ).toContain("mediaTicket=ticket-new");

    audio.dispatchEvent(new Event("error"));
    expect(audio.getAttribute("src")).toContain("mediaTicket=ticket-new");
    audio.currentTime = 0;
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(audio.currentTime).toBe(24);
  });

  it("rechecks local assistant media when its auth token changes", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}-auth.png`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes("meta=1")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const usesUpdatedFixture =
        new Headers(init?.headers).get("Authorization") ===
        ["Bearer", "test-token-placeholder"].join(" ");
      return {
        ok: true,
        json: async () =>
          usesUpdatedFixture ? mediaTicketPayload("ticket-fresh") : { available: false },
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
          content: `Local image\nMEDIA:${source}`,
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
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

    renderWithToken("test-token-placeholder");
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      expectElement(container, ".chat-message-image", HTMLImageElement).getAttribute("src"),
    ).toContain("mediaTicket=ticket-fresh");
  });

  it("automatically retries unavailable local assistant media after the retry window", async () => {
    vi.useFakeTimers();
    const source = `/tmp/openclaw/${crypto.randomUUID()}-retry.png`;
    const fetchMock = vi
      .fn<(url: string) => Promise<{ ok: true; json: () => Promise<unknown> }>>()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: false }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mediaTicketPayload("ticket-retry"),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-media-retry-after-unavailable",
          role: "assistant",
          content: `Local image\nMEDIA:${source}`,
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: rerender,
        },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Unavailable",
    );

    await vi.advanceTimersByTimeAsync(5_001);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      expectElement(container, ".chat-message-image", HTMLImageElement).getAttribute("src"),
    ).toContain("mediaTicket=ticket-retry");
  });

  it("stops automatically retrying permanently unavailable local assistant media", async () => {
    vi.useFakeTimers();
    const source = `/tmp/openclaw/${crypto.randomUUID()}-permanently-unavailable.png`;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ available: false }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const rerender = () =>
      renderAssistantMessage(
        container,
        {
          id: "assistant-local-media-permanently-unavailable",
          role: "assistant",
          content: `Local image\nMEDIA:${source}`,
          timestamp: Date.now(),
        },
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: rerender,
        },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_001);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector(".chat-assistant-attachment-badge")?.textContent?.trim()).toBe(
      "Unavailable",
    );

    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves same-origin assistant attachments without local preview rewriting", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage(
        "Inline\nMEDIA:/media/inbound/test-image.png\nMEDIA:/__openclaw__/media/test-doc.pdf",
        {
          id: "assistant-same-origin-media-inline",
        },
      ),
      {
        showToolCalls: false,
        resourceBasePath: "/openclaw",
        localMediaPreviewRoots: ["/tmp/openclaw"],
      },
    );

    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe("/media/inbound/test-image.png");
    expect(
      container
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__link")
        ?.getAttribute("href"),
    ).toBe("/__openclaw__/media/test-doc.pdf");
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).toBeNull();
  });

  it("renders local files outside preview roots as unavailable", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage("Blocked\nMEDIA:/Users/test/Documents/private.pdf\nDone", {
        id: "assistant-blocked-local-media",
      }),
      {
        showToolCalls: false,
        resourceBasePath: "/openclaw",
        localMediaPreviewRoots: ["/tmp/openclaw"],
      },
    );

    expect(container.querySelector(".chat-assistant-attachment-card__link")).toBeNull();
    const blocked = container.querySelector(".chat-assistant-attachment-card--blocked");
    expect(blocked?.querySelector(".chat-assistant-attachment-card__title")?.textContent).toBe(
      "private.pdf",
    );
    expect(
      blocked?.querySelector(".chat-assistant-attachment-card__reason")?.textContent?.trim(),
    ).toBe("Outside allowed folders");
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("Blocked\nDone");
  });

  it("renders transcript video URLs with encoded extensions", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.dataset.mediaPlayerTestFixture = "";
    const mediaUrl = "https://cdn.example/clip%2Emp4?download=1";

    renderGroupedMessage(
      container,
      createUserMessage("", {
        id: "user-encoded-video",
        __openclaw: { media: [{ url: mediaUrl, contentType: "video/mp4" }] },
      }),
      "user",
      { showToolCalls: false },
    );

    const videoPlayer = await requireVideoPlayer(container);
    expect(expectElement(videoPlayer, "video", HTMLVideoElement).src).toBe(mediaUrl);
  });

  it("renders transcript image variants and structured image blocks", async () => {
    const firstSource = `/tmp/openclaw/${crypto.randomUUID()}-first.png`;
    const secondSource = `/tmp/openclaw/${crypto.randomUUID()}-second.jpg`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.pathname).toBe("/openclaw/__openclaw__/assistant-media");
      expect(mediaUrl.searchParams.get("meta")).toBe("1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return { ok: true, json: async () => mediaTicketPayload("ticket-transcript") };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    const renderUserMedia = (message: unknown) => {
      const rerender = () =>
        renderGroupedMessage(container, message, "user", {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "test-auth-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: rerender,
        });
      rerender();
    };

    renderUserMedia(
      createUserMessage("", {
        id: "user-history-image-octet-stream",
        __openclaw: {
          media: [{ path: firstSource, contentType: "application/octet-stream" }],
        },
      }),
    );
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toContain(`source=${encodeURIComponent(firstSource)}`);

    renderUserMedia(
      createUserMessage("", {
        id: "user-history-images",
        __openclaw: {
          media: [
            { path: firstSource, contentType: "image/png" },
            { path: secondSource, contentType: "application/octet-stream" },
          ],
        },
      }),
    );
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      [...container.querySelectorAll<HTMLImageElement>(".chat-message-image")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([
      expect.stringContaining(`source=${encodeURIComponent(firstSource)}`),
      expect.stringContaining(`source=${encodeURIComponent(secondSource)}`),
    ]);

    renderAssistantMessage(
      container,
      createAssistantMessage([{ type: "input_image", image_url: "data:image/png;base64,cG5n" }]),
    );
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,cG5n");
  });

  it("renders canonical inbound transcript images through the authenticated media route", async () => {
    const source = `media://inbound/${crypto.randomUUID()}.png`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.searchParams.get("source")).toBe(source);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return { ok: true, json: async () => mediaTicketPayload("ticket-inbound") };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    const rerender = () =>
      renderGroupedMessage(
        container,
        createUserMessage("", {
          id: "user-inbound-media-ref",
          __openclaw: { media: [{ path: source, contentType: "image/png" }] },
        }),
        "user",
        {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "test-auth-token",
          localMediaPreviewRoots: [],
          onRequestUpdate: rerender,
        },
      );

    rerender();
    await flushAssistantAttachmentAvailabilityChecks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(
      `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-inbound`,
    );
  });

  it("expires pairing QR images and requests a refresh at the expiry boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T05:45:00Z"));
    const container = document.createElement("div");
    const onRequestUpdate = vi.fn();

    renderAssistantMessage(
      container,
      createAssistantMessage([
        {
          type: "openclaw_pairing_qr",
          image_url: "data:image/png;base64,cXJwbmc=",
          alt: "OpenClaw pairing QR code",
          expiresAtMs: Date.now() + 1_000,
        },
      ]),
      { showToolCalls: false, onRequestUpdate },
    );

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,cXJwbmc=");
    expect(image?.getAttribute("alt")).toBe("OpenClaw pairing QR code");
    await vi.advanceTimersByTimeAsync(999);
    expect(onRequestUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);

    renderAssistantMessage(
      container,
      createAssistantMessage([
        {
          type: "openclaw_pairing_qr",
          image_url: "data:image/png;base64,ZXhwaXJlZA==",
          alt: "OpenClaw pairing QR code",
          expiresAtMs: Date.now() - 1,
        },
      ]),
    );
    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(container.textContent).toContain("Pairing QR expired");
  });

  it.each([
    "media://outbound/photo.png",
    "media://inbound/",
    "media://inbound/nested%2Fphoto.png",
    "media://inbound/%00.png",
    "media://inbound/nested/../photo.png",
    "media://inbound/%2e%2e/photo.png",
    "media://inbound/..",
    "media://inbound/photo.png?raw=1",
    "media://inbound/photo.png#preview",
  ])("does not proxy non-canonical inbound media ref %s", (source) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderGroupedMessage(
      container,
      createUserMessage("", {
        id: "user-invalid-inbound-media-ref",
        __openclaw: { media: [{ path: source, contentType: "image/png" }] },
      }),
      "user",
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "session-token",
        localMediaPreviewRoots: [],
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fetches managed outgoing chat images with auth and requester scope", async () => {
    const managedChatImageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const objectUrl = "blob:managed-image";
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => objectUrl);
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-auth-token");
      expect(headers.get("x-openclaw-requester-session-key")).toBe("agent:main:main");
      return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    const onOpenImage = vi.fn();
    renderAssistantMessage(
      container,
      createAssistantImageMessage(managedChatImageUrl, "Generated image 1", {
        width: 1,
        height: 1,
      }),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "test-auth-token",
        resourceBasePath: "/rosita",
        onOpenImage,
      },
    );

    await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image?.getAttribute("src")).toBe(objectUrl);
      expect(image?.getAttribute("alt")).toBe("Generated image 1");
    });
    const thumbnailUrl = `/rosita${managedChatImageUrl.replace(/\/full$/u, "/thumbnail")}`;
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, thumbnailUrl);
    expectSameOriginGet(fetchInit);
    expectElement(container, ".chat-message-image-button", HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(onOpenImage).toHaveBeenCalledWith(
        expect.objectContaining({ src: objectUrl, title: "Generated image 1" }),
      ),
    );
    const activeItem = onOpenImage.mock.calls[0]?.[0];
    activeItem?.release?.();
  });

  it("prefixes the Control UI base path on artifact tickets without forwarding the gateway bearer", async () => {
    const artifactId = `artifact_managed_image_${crypto.randomUUID()}`;
    const managedChatImageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const ticketedUrl = `${managedChatImageUrl}?mediaTicket=ticket`;
    const resolveArtifactDownload = vi.fn(async () => ({
      url: ticketedUrl,
      expiresAt: "2026-07-28T05:00:00.000Z",
    }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/rosita${ticketedUrl.replace(/\/full(?=\?)/u, "/thumbnail")}`);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("x-openclaw-requester-session-key")).toBeNull();
      return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantImageMessage(managedChatImageUrl, "Ticketed image", { artifactId }),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "must-not-be-forwarded",
        resourceBasePath: "/rosita",
        resolveArtifactDownload,
      },
    );

    await vi.waitFor(() => expect(container.querySelector(".chat-message-image")).not.toBeNull());
    expect(resolveArtifactDownload).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      artifactId,
    });
    expect(container.querySelectorAll(".chat-image-action")).toHaveLength(3);
  });

  it("reuses one full-image fetch for download and copy actions", async () => {
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_image_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${source}?mediaTicket=ticket`;
    const thumbnailUrl = ticketedUrl.replace(/\/full(?=\?)/u, "/thumbnail");
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const objectUrls = ["blob:thumbnail", "blob:full", "blob:download"];
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => objectUrls.shift() ?? "blob:extra");
        static override revokeObjectURL = vi.fn();
      },
    );
    const imageBlob = new Blob(["png"], { type: "image/png" });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      blob: async () => imageBlob,
    }));
    vi.stubGlobal("fetch", fetchMock);
    let copiedBlob: Blob | undefined;
    class ClipboardItemMock {
      constructor(readonly values: Record<string, Promise<Blob>>) {}
    }
    const write = vi.fn(async (items: ClipboardItemMock[]) => {
      copiedBlob = await items[0]?.values["image/png"];
    });
    vi.stubGlobal("ClipboardItem", ClipboardItemMock);
    vi.stubGlobal("navigator", { clipboard: { write } });
    const clickedDownloads: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownloads.push(this.download);
      });
    const toastHost = document.body.appendChild(document.createElement("openclaw-toast-host"));
    const container = document.body.appendChild(document.createElement("div"));
    renderAssistantMessage(
      container,
      createAssistantImageMessage(source, "Ticketed image", { artifactId }),
      { showToolCalls: false, resolveArtifactDownload },
    );
    await vi.waitFor(() => expect(container.querySelector(".chat-message-image")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(thumbnailUrl, expect.anything());

    expectElement(container, 'button[aria-label="Download image"]', HTMLButtonElement).click();
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(clickedDownloads[0]).toBe("Ticketed image.png");

    expectElement(container, 'button[aria-label="Copy image"]', HTMLButtonElement).click();
    await vi.waitFor(() => expect(copiedBlob?.type).toBe("image/png"));
    await vi.waitFor(() => expect(toastHost.textContent).toContain("Copied!"));
    expect(fetchMock.mock.calls.filter((call: unknown[]) => call[0] === ticketedUrl)).toHaveLength(
      1,
    );
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    toastHost.remove();
    container.remove();
  });

  it("aborts a stalled managed outgoing image fetch after the deadline", async () => {
    vi.useFakeTimers();
    const managedChatImageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing managed image signal");
      }
      return await rejectWhenAborted<Response>(signal, () => {
        const reason = signal.reason;
        return reason instanceof Error ? reason : new Error("managed image fetch aborted");
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantImageMessage(managedChatImageUrl, "Generated image timeout", {
        width: 1,
        height: 1,
      }),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "test-auth-token",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, fetchInit] = requireFetchCallForUrl(
      fetchMock,
      managedChatImageUrl.replace(/\/full$/u, "/thumbnail"),
    );
    expect(fetchInit?.signal?.aborted).toBe(false);
    expectSameOriginGet(fetchInit);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchInit?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchInit?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back when a managed outgoing image body stalls after headers", async () => {
    vi.useFakeTimers();
    const managedChatImageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing managed image signal");
      }
      return {
        ok: true,
        blob: async () =>
          await rejectWhenAborted<Blob>(
            signal,
            () => new DOMException("The operation was aborted.", "AbortError"),
          ),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantImageMessage(managedChatImageUrl, "Generated image body stall", {
        width: 1,
        height: 1,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, fetchInit] = requireFetchCallForUrl(
      fetchMock,
      managedChatImageUrl.replace(/\/full$/u, "/thumbnail"),
    );
    expect(fetchInit?.signal?.aborted).toBe(false);
    expectSameOriginGet(fetchInit);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchInit?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a failed managed outgoing image fetch as a missing preview", async () => {
    const managedChatImageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const fetchMock = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantImageMessage(managedChatImageUrl, "Unavailable generated image"),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushAssistantAttachmentAvailabilityChecks();
    expect(container.querySelector(".chat-message-image")).toBeNull();
  });

  it("bounds managed outgoing image blob URLs with least-recently-used eviction", async () => {
    const imageUrls = Array.from(
      { length: 65 },
      () => `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
    );
    let objectUrlIndex = 0;
    const createObjectURL = vi.fn(() => `blob:managed-image-${objectUrlIndex++}`);
    const revokeObjectURL = vi.fn();
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    let deferEvictedRefetch = false;
    let resolveEvictedRefetch:
      | ((response: { ok: boolean; blob: () => Promise<Blob> }) => void)
      | undefined;
    const response = { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    const fetchMock = vi.fn((url: string) => {
      if (deferEvictedRefetch && url === imageUrls[1]?.replace(/\/full$/u, "/thumbnail")) {
        return new Promise<typeof response>((resolve) => {
          resolveEvictedRefetch = resolve;
        });
      }
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(container, {
      role: "assistant",
      content: imageUrls.slice(0, 64).map((url, index) => ({
        type: "image",
        url,
        alt: `Generated image ${index + 1}`,
      })),
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(64));

    const recentContainer = document.createElement("div");
    renderAssistantMessage(recentContainer, {
      role: "assistant",
      content: [{ type: "image", url: imageUrls[0], alt: "Recently viewed image" }],
      timestamp: Date.now(),
    });
    expect(createObjectURL).toHaveBeenCalledTimes(64);

    const createsBeforeOverflow = createObjectURL.mock.calls.length;
    const overflowContainer = document.createElement("div");
    renderAssistantMessage(overflowContainer, {
      role: "assistant",
      content: [{ type: "image", url: imageUrls[64], alt: "Newest image" }],
      timestamp: Date.now(),
    });
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeOverflow),
    );
    expect(revokeObjectURL).toHaveBeenCalled();

    deferEvictedRefetch = true;
    const evictedContainer = document.createElement("div");
    renderAssistantMessage(evictedContainer, {
      role: "assistant",
      content: [{ type: "image", url: imageUrls[1], alt: "Refetched image" }],
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(resolveEvictedRefetch).toBeTypeOf("function"));

    const createsBeforeRefetch = createObjectURL.mock.calls.length;
    resolveEvictedRefetch?.(response);
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeRefetch),
    );
    expect(evictedContainer.querySelector(".chat-message-image")).not.toBeNull();
  });

  it("bounds managed outgoing image miss retention", async () => {
    const imageUrls = Array.from(
      { length: 65 },
      () => `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
    );
    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");

    renderAssistantMessage(container, {
      role: "assistant",
      content: imageUrls.map((url, index) => ({
        type: "image",
        url,
        alt: `Missing image ${index + 1}`,
      })),
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length));
    await flushAssistantAttachmentAvailabilityChecks();

    const retryContainer = document.createElement("div");
    renderAssistantMessage(retryContainer, {
      role: "assistant",
      content: [{ type: "image", url: imageUrls[0], alt: "Oldest missing image" }],
      timestamp: Date.now(),
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length + 1));
  });

  it("does not send auth to cross-origin managed-image-looking URLs", () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("cross-origin image URL should not be fetched with Control UI auth");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantImageMessage(
        "https://evil.example/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full",
        "Untrusted image",
      ),
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

  it("renders direct tool-result image data inline", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage([createMediaBlock({ data: "cG5n", mimeType: "image/png" })]),
      { showToolCalls: false },
    );
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,cG5n");
  });

  it("passes through pre-encoded data: URLs in direct tool-result image blocks", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage([createMediaBlock({ data: "data:image/png;base64,cG5n" })]),
      { showToolCalls: false },
    );
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,cG5n");
  });

  it("renders canvas-only [embed] shortcodes inside the assistant bubble", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          {
            type: "text",
            text: '[embed ref="cv_tictactoe" title="Tic-Tac-Toe" /]',
          },
        ],
        { id: "assistant-canvas-only" },
      ),
      { showToolCalls: false },
    );

    expectElement(container, ".chat-bubble", HTMLElement);
    const iframe = expectElement(container, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("title")).toBe("Tic-Tac-Toe");
  });

  it("opens only safe assistant image URLs in the lightbox", () => {
    const container = document.createElement("div");
    const onOpenImage = vi.fn();
    const renderAssistantImage = (url: string) =>
      renderAssistantMessage(
        container,
        createAssistantMessage([{ type: "image_url", image_url: { url } }]),
        { onOpenImage },
      );

    renderAssistantImage("https://example.com/cat.png");
    let image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toBeInstanceOf(HTMLImageElement);
    image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "https://example.com/cat.png",
      title: "Image",
    });

    onOpenImage.mockClear();
    renderAssistantImage("javascript:alert(1)");
    image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toBeInstanceOf(HTMLImageElement);
    image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenImage).not.toHaveBeenCalled();

    renderAssistantImage("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />");
    image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toBeInstanceOf(HTMLImageElement);
    image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenImage).not.toHaveBeenCalled();
  });

  it("routes inline canvas blocks through the scoped canvas host when available", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          { type: "text", text: "Rendered inline." },
          {
            type: "canvas",
            preview: createCanvasPreview({
              viewId: "cv_inline_scoped",
              title: "Scoped preview",
              preferredHeight: 320,
            }),
          },
        ],
        { id: "assistant-scoped-canvas" },
      ),
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
      createAssistantMessage(
        [
          { type: "thinking", thinking: "", thinkingSignature: "sig-2" },
          { type: "text", text: "This item is ready." },
          {
            type: "canvas",
            preview: createCanvasPreview({
              viewId: "cv_canvas_live_history",
              title: "Live history preview",
              preferredHeight: 420,
            }),
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
        { id: "assistant-final-live-shape", timestamp: Date.now() + 2 },
      ),
      { showToolCalls: true },
    );

    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(1);
    const bubble = expectElement(container, ".chat-group.assistant .chat-bubble", HTMLElement);
    const iframe = expectElement(bubble, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("src")).toBe(
      "/__openclaw__/canvas/documents/cv_canvas_live_history/index.html",
    );
    expect(iframe.getAttribute("title")).toBe("Live history preview");
    expect(bubble.querySelector(".chat-text")?.textContent?.trim()).toBe("This item is ready.");
  });

  it("keeps lifted assistant canvas previews beside flat tool rows", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          {
            type: "tool_use",
            id: "call-tool-canvas",
            name: "bash",
            input: { command: "render preview" },
          },
          createAssistantCanvasBlock({ suffix: "tool_canvas" }),
        ],
        { id: "assistant-tool-canvas", toolName: "bash" },
      ),
      { showToolCalls: true, isToolMessageExpanded: () => true },
    );

    expectElement(container, ".chat-bubble--tool-shell", HTMLElement);
    const iframe = expectElement(container, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("src")).toBe(
      "/__openclaw__/canvas/documents/cv_inline_tool_canvas/index.html",
    );
    expect(container.querySelector(".chat-tool-msg-summary")).not.toBeNull();
  });

  it("keeps assistant message actions outside the bubble", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      createAssistantMessage("Copyable assistant text.", { id: "assistant-action-space" }),
    );

    const bubble = container.querySelector(".chat-group.assistant .chat-bubble");
    expect(bubble?.classList.contains("chat-bubble--has-actions")).toBe(false);
    expect(bubble?.querySelector(".chat-bubble-actions")).toBeNull();
    expect(
      container.querySelector(".chat-group.assistant .chat-group-footer-actions .chat-copy-btn"),
    ).not.toBeNull();
  });

  it("renders hidden assistant_message canvas results with the configured sandbox", () => {
    const container = document.createElement("div");
    const renderCanvas = (params: { embedSandboxMode?: "trusted"; suffix: string }) =>
      renderMessageGroups(
        container,
        [
          createMessageGroup(
            createAssistantMessage(
              [
                { type: "text", text: "Inline canvas result." },
                createAssistantCanvasBlock({ suffix: params.suffix }),
              ],
              { id: `assistant-canvas-inline-${params.suffix}` },
            ),
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
    expect(iframe.getAttribute("title")).toBe("Inline demo");
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe(
      "Inline canvas result.",
    );
    expect(container.querySelector(".chat-tool-card__raw-toggle")?.textContent?.trim()).toBe(
      "Raw details",
    );

    renderCanvas({ embedSandboxMode: "trusted", suffix: "trusted" });
    iframe = expectElement(container, ".chat-tool-card__preview-frame", HTMLIFrameElement);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("recreates canvas preview iframes when the sandbox policy changes", () => {
    const container = document.createElement("div");
    const renderCanvas = (embedSandboxMode: "strict" | "scripts") =>
      renderMessageGroups(
        container,
        [
          createMessageGroup(
            createAssistantMessage(
              [
                { type: "text", text: "Inline canvas result." },
                createAssistantCanvasBlock({ suffix: "sandbox-change" }),
              ],
              { id: "assistant-canvas-inline-sandbox-change" },
            ),
            "assistant",
          ),
        ],
        { embedSandboxMode },
      );

    renderCanvas("strict");
    const strictIframe = expectElement(
      container,
      ".chat-tool-card__preview-frame",
      HTMLIFrameElement,
    );
    expect(strictIframe.getAttribute("sandbox")).toBe("");

    renderCanvas("scripts");
    const scriptsIframe = expectElement(
      container,
      ".chat-tool-card__preview-frame",
      HTMLIFrameElement,
    );
    expect(scriptsIframe).not.toBe(strictIframe);
    expect(scriptsIframe.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("renders assistant_message canvas results in the assistant bubble even when tool rows are visible", () => {
    const container = document.createElement("div");
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          createAssistantMessage(
            [
              { type: "text", text: "Inline canvas result." },
              createAssistantCanvasBlock({ suffix: "visible" }),
            ],
            { id: "assistant-canvas-inline-visible" },
          ),
          "assistant",
        ),
        createMessageGroup(
          createToolResultMessage(
            "call-artifact-inline-visible",
            "canvas_render",
            JSON.stringify({
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
            {
              id: "tool-artifact-inline-visible",
              role: "tool",
              timestamp: Date.now() + 1,
            },
          ),
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
    expect(iframe.getAttribute("title")).toBe("Inline demo");
    expect(bubble.querySelector(".chat-text")?.textContent?.trim()).toBe("Inline canvas result.");
    expect(
      container.querySelector(".chat-group.tool .chat-tool-msg-summary__label")?.textContent,
    ).toBe("Tool output");
    expect(
      container.querySelector(".chat-group.tool .chat-tool-msg-summary__names")?.textContent,
    ).toBe("canvas_render");
  });

  it("keeps MCP App raw details reachable from its widget menu", () => {
    const container = document.createElement("div");
    const canvas = createAssistantCanvasBlock({
      suffix: "mcp-raw",
      mcpApp: { viewId: "view-mcp-raw" },
    });
    renderAssistantMessage(container, createAssistantMessage([canvas]), {
      sessionKey: "agent:main:main",
    });

    const dropdown = expectElement(container, "wa-dropdown", HTMLElement);
    expect(dropdown.querySelectorAll("wa-dropdown-item")).toHaveLength(1);
    dropdown.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "raw-details" } },
      }),
    );
    expect(
      container
        .querySelector(".chat-tool-card__widget-raw .chat-tool-card__raw-toggle")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("opens generic tool details instead of a canvas preview from tool rows", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    renderMessageGroups(
      container,
      [
        createMessageGroup(
          createAssistantMessage([{ type: "text", text: "Sidebar canvas result." }], {
            id: "assistant-canvas-sidebar",
          }),
          "assistant",
        ),
        createMessageGroup(
          createToolResultMessage(
            "call-artifact-sidebar",
            "canvas_render",
            JSON.stringify({
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
            { id: "tool-artifact-sidebar", role: "tool", timestamp: Date.now() + 1 },
          ),
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

  function renderAssistantDisclosureActionFixture(
    options: Partial<RenderMessageGroupOptions> = {},
  ) {
    const container = document.createElement("div");
    const preview = "Assistant preview\n...(truncated)...";
    const fullMessage = "Complete assistant message beyond the transcript preview.";
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "text", text: preview }],
        __openclaw: { id: "assistant-disclosure-actions", seq: 1 },
      },
      {
        sessionKey: "agent:main:main",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({
          status: "loaded",
          markdown: fullMessage,
          revision: 1,
        }),
        onToggleAssistantMessageExpanded: vi.fn(),
        ...options,
      },
    );
    return { container, fullMessage, preview };
  }

  it("copies the full loaded assistant message", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const { container, fullMessage } = renderAssistantDisclosureActionFixture();

    expect(container.querySelector(".chat-text")?.textContent).toContain(fullMessage);
    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    container
      .querySelector<HTMLButtonElement>(".chat-group-footer-actions .chat-copy-btn")
      ?.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(fullMessage));
  });

  it("replies with the full loaded assistant message", () => {
    const onReply = vi.fn();
    const { container, fullMessage } = renderAssistantDisclosureActionFixture({
      onReply,
    });

    container
      .querySelector<HTMLButtonElement>(
        '.chat-group-footer-actions [aria-label="Reply to message"]',
      )
      ?.click();

    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: fullMessage }));
    expect(container.querySelector<HTMLElement>(".chat-bubble")?.dataset.messageText).toBe(
      fullMessage,
    );
  });

  it.each(["loading", "error"] as const)(
    "keeps the transcript preview in %s assistant-message actions",
    (status) => {
      const onReply = vi.fn();
      const { container, preview } = renderAssistantDisclosureActionFixture({
        onReply,
        getAssistantMessageExpansion: () => ({ status, revision: 1 }),
      });

      container
        .querySelector<HTMLButtonElement>(
          '.chat-group-footer-actions [aria-label="Reply to message"]',
        )
        ?.click();
      expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: preview }));
      expect(container.querySelector<HTMLElement>(".chat-bubble")?.dataset.messageText).toBe(
        preview,
      );
    },
  );

  it("keeps loaded assistant thinking private while bounding reply context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const onReply = vi.fn();
    const visibleMessage = `${"a".repeat(499)}😀 full loaded answer`;
    const { container } = renderAssistantDisclosureActionFixture({
      onReply,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>private loaded reasoning</thinking>${visibleMessage}`,
        revision: 1,
      }),
    });

    container
      .querySelector<HTMLButtonElement>(".chat-group-footer-actions .chat-copy-btn")
      ?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(visibleMessage));

    container
      .querySelector<HTMLButtonElement>(
        '.chat-group-footer-actions [aria-label="Reply to message"]',
      )
      ?.click();
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: "a".repeat(499) }));
    expect(container.querySelector<HTMLElement>(".chat-bubble")?.dataset.messageText).toBe(
      visibleMessage,
    );
  });

  it("does not restore a disclosure control for hidden-only loaded assistant text", () => {
    const onReply = vi.fn();
    const onToggleAssistantMessageExpanded = vi.fn();
    const privateThinking = "private expanded reasoning only";
    const { container, preview } = renderAssistantDisclosureActionFixture({
      onReply,
      onToggleAssistantMessageExpanded,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>${privateThinking}</thinking>`,
        revision: 1,
      }),
    });

    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("");
    expect(container.textContent).not.toContain(privateThinking);
    expect(container.textContent).not.toContain(preview);
    expect(container.querySelector(".chat-group-footer-actions .chat-copy-btn")).toBeNull();
    expect(container.querySelector('[aria-label="Reply to message"]')).toBeNull();
    expect(
      container.querySelector<HTMLElement>(".chat-bubble")?.hasAttribute("data-message-text"),
    ).toBe(false);

    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "marker",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "abcde\n...(truncated)..." }],
        __openclaw: { id: "msg-truncated-marker", seq: 1 },
      },
      messageId: "msg-truncated-marker",
    },
    {
      label: "metadata",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "abcde" }],
        __openclaw: { id: "msg-truncated-metadata", seq: 2, truncated: true },
      },
      messageId: "msg-truncated-metadata",
    },
  ])(
    "loads assistant truncation detected by $label without a disclosure",
    ({ message, messageId }) => {
      const container = document.createElement("div");
      const onToggleAssistantMessageExpanded = vi.fn();
      renderAssistantMessage(container, message, {
        sessionKey: "global",
        agentId: "work",
        loadFullAssistantMessage: async () => null,
        onToggleAssistantMessageExpanded,
      });

      expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith(messageId);
      expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
      expect(container.querySelector(".chat-expand-btn")).toBeNull();
    },
  );

  it.each([
    { state: { status: "error" as const, revision: 2 }, retries: true, label: "bounded error" },
    { state: { status: "error" as const, revision: 6 }, retries: false, label: "exhausted error" },
    { state: { status: "loading" as const, revision: 1 }, retries: false, label: "loading" },
  ])(
    "retries a failed full-message load only while attempts remain ($label)",
    ({ state, retries }) => {
      const container = document.createElement("div");
      const onToggleAssistantMessageExpanded = vi.fn();
      renderAssistantMessage(
        container,
        {
          role: "assistant",
          content: [{ type: "text", text: "abcde\n...(truncated)..." }],
          __openclaw: { id: "msg-retry-error", seq: 1 },
        },
        {
          sessionKey: "global",
          loadFullAssistantMessage: async () => null,
          getAssistantMessageExpansion: () => state,
          onToggleAssistantMessageExpanded,
        },
      );

      if (retries) {
        expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("msg-retry-error");
      } else {
        expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
      }
    },
  );

  it("renders a visible retry affordance once automatic full-message loads exhaust", () => {
    const container = document.createElement("div");
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "text", text: "abcde\n...(truncated)..." }],
        __openclaw: { id: "msg-retry-exhausted", seq: 1 },
      },
      {
        sessionKey: "global",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({ status: "error", revision: 6 }),
        onToggleAssistantMessageExpanded,
      },
    );

    const retry = container.querySelector<HTMLButtonElement>(".chat-message-load-error__retry");
    expect(container.querySelector(".chat-message-load-error")?.textContent).toContain(
      "Could not load the full message.",
    );
    expect(retry).not.toBeNull();
    retry?.click();
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("msg-retry-exhausted");
  });

  it("does not add disclosure or canvas actions to non-truncated assistant messages", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "text", text: "full visible message" }],
        __openclaw: { id: "msg-visible-1", seq: 1 },
      },
      {
        sessionKey: "global",
        loadFullAssistantMessage: async () => null,
        onToggleAssistantMessageExpanded: vi.fn(),
      },
    );

    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    expect(container.querySelector(".chat-expand-btn")).toBeNull();
  });

  it("does not render Show more without a full-message loader", () => {
    const container = document.createElement("div");
    renderAssistantMessage(container, {
      role: "assistant",
      content: [{ type: "text", text: "abcde\n...(truncated)..." }],
      __openclaw: { id: "msg-no-loader", seq: 1 },
    });

    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
  });

  it("does not render Show more for mirrored message-tool replies", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "text", text: "mirrored text\n...(truncated)..." }],
        openclawMessageToolMirror: { toolName: "message", toolCallId: "call-1" },
        __openclaw: { id: "msg-tool-result", seq: 2, truncated: true },
      },
      {
        sessionKey: "global",
        loadFullAssistantMessage: async () => null,
        onToggleAssistantMessageExpanded: vi.fn(),
      },
    );

    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
