/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { setUiTimeFormatPreference } from "../../../lib/format.ts";
import { renderMessageGroup, renderStreamGroup } from "./chat-message.ts";

const localStorageValues = vi.hoisted(() => new Map<string, string>());
const markdownRenderMock = vi.hoisted(() =>
  vi.fn(
    (value: string, _options?: { codeBlockChrome?: "copy" | "none"; fileLinks?: boolean }) => value,
  ),
);
const streamingMarkdownRenderMock = vi.hoisted(() =>
  vi.fn(
    (value: string, _options?: { codeBlockChrome?: "copy" | "none"; fileLinks?: boolean }) =>
      `<div class="streaming-markdown">${value}</div>`,
  ),
);

vi.mock("../../../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
}));

vi.mock("../../../components/markdown.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../components/markdown.ts")>();
  return {
    ...actual,
    toSanitizedMarkdownHtml: markdownRenderMock,
    toStreamingMarkdownHtml: streamingMarkdownRenderMock,
  };
});

vi.mock("../../../components/icons.ts", () => ({
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

vi.mock("./chat-avatar.ts", () => ({
  renderChatAvatar: (role: string) => {
    const element = document.createElement("div");
    element.className = `chat-avatar ${role}`;
    return element;
  },
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

function stubDeleteConfirmGeometry(params: {
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
      if (this.classList.contains("chat-group-delete")) {
        return domRect(params.trigger);
      }
      if (this.classList.contains("chat-delete-confirm")) {
        return domRect(params.popover);
      }
      return domRect({});
    },
  );
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
  markdownRenderMock.mockClear();
  document.querySelectorAll("[data-delete-confirm-fixture]").forEach((element) => {
    element.remove();
  });
  clearDeleteConfirmSkip();
  setUiTimeFormatPreference("auto");
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

  it("renders assistant message actions in the footer row", () => {
    const container = document.createElement("div");
    renderAssistantMessage(container, {
      role: "assistant",
      content: "Short reply",
      timestamp: 1000,
    });

    const assistantGroup = expectElement(container, ".chat-group.assistant", HTMLElement);
    expect(assistantGroup.querySelector(".chat-bubble-actions")).toBeNull();
    expect(
      assistantGroup.querySelector(".chat-group-footer-actions .chat-copy-btn"),
    ).toBeInstanceOf(HTMLElement);

    renderGroupedMessage(
      container,
      {
        role: "user",
        content: "Short reply",
        timestamp: 1001,
      },
      "user",
    );

    const userBubble = expectElement(container, ".chat-group.user .chat-bubble", HTMLElement);
    expect(userBubble.classList.contains("has-copy")).toBe(false);
    expect(userBubble.querySelector(".chat-bubble-actions")).toBeNull();
  });

  it("uses the displayed answer for assistant message actions", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: "<think>internal reasoning</think>\nVisible answer",
        timestamp: 1000,
      },
      {
        onOpenSidebar,
        showReasoning: false,
      },
    );

    container.querySelector<HTMLButtonElement>(".chat-expand-btn")?.click();

    expect(requireFirstMockArg(onOpenSidebar, "sidebar open")).toMatchObject({
      kind: "markdown",
      content: "Visible answer",
    });
  });

  it("renders user markdown without code-block copy chrome", () => {
    const container = document.createElement("div");
    const markdown = "```bash\npython3 - <<'PY'\nprint('ok')\nPY\n```";

    renderGroupedMessage(
      container,
      {
        role: "user",
        content: markdown,
        timestamp: 1001,
      },
      "user",
    );

    expect(markdownRenderMock).toHaveBeenCalledWith(markdown, {
      codeBlockChrome: "none",
      fileLinks: true,
    });
  });

  it("keeps assistant markdown code-block copy chrome enabled", () => {
    const container = document.createElement("div");
    const markdown = "```bash\necho ok\n```";

    renderAssistantMessage(container, {
      role: "assistant",
      content: markdown,
      timestamp: 1000,
    });

    expect(markdownRenderMock).toHaveBeenCalledWith(markdown, {
      codeBlockChrome: "copy",
      fileLinks: true,
    });
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

  it("places the delete confirm below the trigger near the top viewport edge", () => {
    stubDeleteConfirmGeometry({
      trigger: { left: 20, top: 4, width: 24, height: 24 },
      popover: { width: 200, height: 96 },
      viewport: { width: 320, height: 240 },
    });
    const fixture = renderDeleteConfirmFixture();

    openDeleteConfirm(fixture.deleteButton);

    const popover = expectElement(fixture.container, ".chat-delete-confirm", HTMLElement);
    expect(popover.dataset.placement).toBe("below");
    expect(popover.style.top).toBe("34px");
    expect(popover.style.left).toBe("20px");
  });

  it("places the delete confirm above the trigger near the bottom viewport edge", () => {
    stubDeleteConfirmGeometry({
      trigger: { left: 20, top: 190, width: 24, height: 24 },
      popover: { width: 200, height: 80 },
      viewport: { width: 320, height: 240 },
    });
    const fixture = renderDeleteConfirmFixture();

    openDeleteConfirm(fixture.deleteButton);

    const popover = expectElement(fixture.container, ".chat-delete-confirm", HTMLElement);
    expect(popover.dataset.placement).toBe("above");
    expect(popover.style.top).toBe("104px");
    expect(popover.style.left).toBe("20px");
  });

  it("clamps the delete confirm horizontally inside narrow viewports", () => {
    stubDeleteConfirmGeometry({
      trigger: { left: 260, top: 120, width: 24, height: 24 },
      popover: { width: 200, height: 80 },
      viewport: { width: 320, height: 240 },
    });
    const fixture = renderDeleteConfirmFixture();

    openDeleteConfirm(fixture.deleteButton);

    const popover = expectElement(fixture.container, ".chat-delete-confirm", HTMLElement);
    expect(popover.style.left).toBe("112px");
  });

  it("clamps the delete confirm inside shifted visual viewports", () => {
    stubDeleteConfirmGeometry({
      trigger: { left: 620, top: 540, width: 24, height: 24 },
      popover: { width: 200, height: 80 },
      viewport: { left: 320, top: 300, width: 320, height: 240 },
    });
    const fixture = renderDeleteConfirmFixture();

    openDeleteConfirm(fixture.deleteButton);

    const popover = expectElement(fixture.container, ".chat-delete-confirm", HTMLElement);
    expect(popover.dataset.placement).toBe("above");
    expect(popover.style.left).toBe("432px");
    expect(popover.style.top).toBe("452px");
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
  });

  it("previews message context from the timestamp and pins it on click", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: "Done",
        usage: { input: 12_000, output: 300 },
        model: "openai/gpt-5.5",
        timestamp: 1000,
      },
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

  it("renders relative labels while preserving absolute message and streaming timestamps", () => {
    vi.useFakeTimers();
    const timestamp = Date.UTC(2026, 3, 24, 18, 30);
    vi.setSystemTime(timestamp + 5 * 60 * 1000);
    const container = document.createElement("div");

    renderAssistantMessage(container, {
      role: "assistant",
      content: "Done",
      timestamp,
    });

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
      renderAssistantMessage(container, { role: "assistant", content: "Done", timestamp });
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

  it.each([
    { preference: "12" as const, expected: /AM|PM/i },
    { preference: "24" as const, expected: /^(?!.*(?:AM|PM))/i },
  ])(
    "honors the $preference-hour clock preference in timestamp tooltips",
    ({ preference, expected }) => {
      setUiTimeFormatPreference(preference);
      const container = document.createElement("div");
      renderAssistantMessage(container, {
        role: "assistant",
        content: "Done",
        timestamp: Date.UTC(2026, 0, 15, 19, 30),
      });

      expect(container.querySelector("openclaw-tooltip")?.getAttribute("content")).toMatch(
        expected,
      );
    },
  );

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
      codeBlockChrome: "copy",
      fileLinks: true,
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
    expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
      "Working…",
    );
    expect(container.querySelector(".chat-group-footer")).toBeNull();
  });

  it("keeps the avatar once a stream part joins the reading indicator", () => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([
        { kind: "stream", key: "stream:s:live", text: "reply", startedAt: 10, isStreaming: true },
        { kind: "reading-indicator", key: "reading", startedAt: 10 },
      ]),
      container,
    );

    const group = container.querySelector(".chat-group.assistant");
    expect(group?.classList.contains("chat-group--working")).toBe(false);
    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
  });

  it("seeds a stable punch stance per reading-indicator key", () => {
    const stanceFor = (key: string) => {
      const container = document.createElement("div");
      render(renderStreamGroup([{ kind: "reading-indicator", key, startedAt: 1 }]), container);
      const bubble = container.querySelector(".chat-reading-indicator");
      return [...(bubble?.classList ?? [])].filter((cls) =>
        cls.startsWith("chat-reading-indicator--"),
      );
    };

    const first = stanceFor("stream:agent:main:pending");
    // Stable across re-renders: same key always fights the same style.
    expect(stanceFor("stream:agent:main:pending")).toEqual(first);
    // At most one stance modifier; orthodox is the unmarked default.
    expect(first.length).toBeLessThanOrEqual(1);
    for (const cls of first) {
      expect([
        "chat-reading-indicator--southpaw",
        "chat-reading-indicator--flurry",
        "chat-reading-indicator--haymaker",
      ]).toContain(cls);
    }
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

  it("uses assistant senderLabel for forwarded assistant-side groups", () => {
    const container = document.createElement("div");
    const group: MessageGroup = {
      kind: "group",
      key: "forwarded-group",
      role: "assistant",
      senderLabel: "Forwarded from main",
      messages: [
        {
          key: "forwarded-message",
          message: { role: "assistant", content: "forwarded report", timestamp: 1000 },
        },
      ],
      timestamp: 1000,
      isStreaming: false,
    };

    render(
      renderMessageGroup(group, {
        showReasoning: true,
        showToolCalls: true,
        assistantName: "OpenClaw",
        assistantAvatar: null,
      }),
      container,
    );

    const sender = container.querySelector<HTMLElement>(".chat-group.assistant .chat-sender-name");
    expect(sender?.textContent).toBe("Forwarded from main");
  });

  it("collapses consecutive tool results into an activity group", () => {
    const container = document.createElement("div");
    const group: MessageGroup = {
      kind: "group",
      key: "tool-group",
      role: "tool",
      messages: [
        {
          key: "tool-message-1",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            content: "File one",
            timestamp: 1000,
          },
        },
        {
          key: "tool-message-2",
          message: {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "run_command",
            content: "Command output",
            timestamp: 1001,
          },
        },
      ],
      timestamp: 1000,
      isStreaming: false,
    };

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

  it("collapses paired parallel tool cards from one message into an activity group", () => {
    const container = document.createElement("div");
    const group: MessageGroup = {
      kind: "group",
      key: "parallel-tool-group",
      role: "tool",
      messages: [
        {
          key: "parallel-tool-message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-a",
                name: "read",
                arguments: { path: "/repo/a.ts" },
              },
              {
                type: "toolCall",
                id: "call-b",
                name: "read",
                arguments: { path: "/repo/b.ts" },
              },
              {
                type: "tool_result",
                id: "call-a",
                name: "read",
                text: "File A",
              },
              {
                type: "tool_result",
                id: "call-b",
                name: "read",
                text: "File B",
              },
            ],
            timestamp: 1000,
          },
        },
      ],
      timestamp: 1000,
      isStreaming: false,
    };

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

  it("uses the running mutation verb in an active group summary", () => {
    const container = document.createElement("div");
    const group: MessageGroup = {
      kind: "group",
      key: "running-tool-group",
      role: "tool",
      messages: [
        {
          key: "finished-read",
          message: {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: "done",
          },
        },
        {
          key: "running-edit",
          message: {
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
          },
        },
      ],
      timestamp: 1000,
      isStreaming: true,
    };

    renderMessageGroups(container, [group], { runActive: true });

    expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
      "Editing a.ts…",
    );
  });

  it("passes the effective default-expanded activity state to the toggle handler", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onToggleToolMessageExpanded = vi.fn();
    const group: MessageGroup = {
      kind: "group",
      key: "tool-group",
      role: "tool",
      messages: [
        {
          key: "tool-message-1",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            isError: true,
            content: JSON.stringify({ error: "Read failed" }),
            timestamp: 1000,
          },
        },
        {
          key: "tool-message-2",
          message: {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "run_command",
            content: "Command output",
            timestamp: 1001,
          },
        },
      ],
      timestamp: 1000,
      isStreaming: false,
    };

    renderMessageGroups(container, [group], { onToggleToolMessageExpanded });

    expect(container.querySelector(".chat-activity-group.is-open")).toBeInstanceOf(HTMLElement);
    const activitySummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(true);
    expect(activitySummary.getAttribute("aria-label")).toBe("Activity: 2 tools, includes errors.");
    expect(activitySummary.querySelector(".chat-activity-group__badge")).toBeNull();
    const errorSummary = expectElement(
      container,
      ".chat-tool-msg-summary--error",
      HTMLButtonElement,
    );
    expect(errorSummary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Tool error",
    );
    expect(errorSummary.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
    selectText(expectElement(activitySummary, ".chat-activity-group__label", HTMLElement));
    pointerClick(activitySummary);
    expect(onToggleToolMessageExpanded).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
    activitySummary.click();

    expect(onToggleToolMessageExpanded).toHaveBeenCalledWith("activity:tool-group", true);
    container.remove();
  });

  it("keeps recovered grouped activity collapsed while retaining its failure summary", () => {
    const container = document.createElement("div");
    const group: MessageGroup = {
      kind: "group",
      key: "tool-group",
      role: "tool",
      turnSucceeded: true,
      messages: [
        {
          key: "tool-message-1",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "web_search",
            isError: true,
            content: JSON.stringify({ error: "No matches" }),
            timestamp: 1000,
          },
        },
        {
          key: "tool-message-2",
          message: {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "read_file",
            content: "Fallback context",
            timestamp: 1001,
          },
        },
      ],
      timestamp: 1000,
      isStreaming: false,
    };

    renderMessageGroups(container, [group]);

    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    expect(container.querySelector(".chat-activity-group__summary--error")).toBeNull();
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toContain(
      "1 failed",
    );
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("keeps recovered coalesced tool failures neutral in the activity list", () => {
    const container = document.createElement("div");
    const group: MessageGroup = {
      kind: "group",
      key: "recovered-tool-group",
      role: "tool",
      turnSucceeded: true,
      messages: [
        {
          key: "recovered-tool-message",
          message: {
            role: "assistant",
            isError: true,
            content: [
              {
                type: "tool_use",
                id: "call-recovered",
                name: "bash",
                input: { command: "run fallback" },
              },
              {
                type: "tool_result",
                id: "call-recovered",
                name: "bash",
                text: "Primary path failed",
                isError: true,
              },
            ],
            timestamp: 1000,
          },
        },
        {
          key: "recovered-followup",
          message: {
            role: "toolResult",
            toolCallId: "call-followup",
            toolName: "read_file",
            content: "Fallback context",
            timestamp: 1001,
          },
        },
      ],
      timestamp: 1000,
      isStreaming: false,
    };

    renderMessageGroups(container, [group], {
      isToolMessageExpanded: (id) => id === "activity:recovered-tool-group",
    });

    const summaries = container.querySelectorAll(".chat-tool-msg-summary");
    expect(summaries).toHaveLength(2);
    expect(container.querySelector(".chat-activity-group__summary--error")).toBeNull();
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toContain(
      "1 failed",
    );
    expect(container.querySelectorAll(".chat-tool-msg-summary--error")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-row__badge")?.textContent).toBe("failed");
    // Command calls render a `$ command` row instead of the tool-name label.
    expect(summaries[0]?.querySelector(".chat-tool-row__cmd")?.textContent).toBe("run fallback");
  });

  it("hides grouped tool activity when tool calls are disabled", () => {
    const container = document.createElement("div");
    const group: MessageGroup = {
      kind: "group",
      key: "tool-group",
      role: "tool",
      messages: [
        {
          key: "tool-message-1",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            content: "File one",
            timestamp: 1000,
          },
        },
        {
          key: "tool-message-2",
          message: {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "run_command",
            content: "Command output",
            timestamp: 1001,
          },
        },
      ],
      timestamp: 1000,
      isStreaming: false,
    };

    renderMessageGroups(container, [group], { showToolCalls: false });

    expect(container.querySelector(".chat-activity-group")).toBeNull();
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
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool output"]);
    expect(blocks[0]?.querySelector("code")?.textContent).toBe("Opened page");
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
    const message = {
      id: "assistant-tool-content",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-content-only",
          name: "bash",
          input: { command: "bash" },
        },
      ],
      timestamp: Date.now(),
    };

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
      {
        role: "assistant",
        toolName: "bash",
        content: "A long tool result that should stay behind the disclosure.",
        timestamp: Date.now(),
      },
      { isToolMessageExpanded: () => false },
    );

    expectElement(container, ".chat-bubble--tool-shell", HTMLElement);
    expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(container.querySelector(".chat-text")).toBeNull();
  });

  it("omits normalized duplicate names from standalone tool results", () => {
    const container = document.createElement("div");
    const message = {
      role: "toolResult",
      toolCallId: "call-heartbeat",
      toolName: "heartbeat_respond",
      content: [
        {
          type: "tool_result",
          name: "heartbeat_respond",
          text: "Acknowledged",
        },
      ],
      timestamp: Date.now(),
    };

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
    const message = {
      id: "assistant-string-tool",
      role: "assistant",
      toolCallId: "call-string-tool",
      content: [
        {
          type: "toolcall",
          id: "call-string-tool",
          name: "presentation_create",
          arguments: "with Example Deck",
        },
      ],
      timestamp: Date.now(),
    };
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
          {
            id: "tool-error-collapsed",
            role: "toolResult",
            toolCallId: "call-error-collapsed",
            toolName: "web_search",
            isError: false,
            content: JSON.stringify({
              error: "missing_brave_api_key",
              message: "BRAVE_API_KEY is not configured",
            }),
            timestamp: Date.now(),
          },
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
          {
            id: "tool-error-collapsed-mcp",
            role: "toolResult",
            toolCallId: "call-error-collapsed-mcp",
            toolName: "memory_forget",
            isError: false,
            content: JSON.stringify({
              isError: true,
              content: [{ type: "text", text: "Tool error: boom" }],
            }),
            timestamp: Date.now(),
          },
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

  it("marks status-only standalone tool-result summaries as errors", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onToggleToolMessageExpanded = vi.fn();
    const groups = [
      createMessageGroup(
        {
          id: "tool-status-error",
          role: "toolResult",
          toolCallId: "call-status-error",
          toolName: "sessions_spawn",
          content: JSON.stringify({ status: "error" }, null, 2),
          timestamp: Date.now(),
        },
        "tool",
      ),
    ];

    renderMessageGroups(container, groups, {
      isToolMessageExpanded: () => false,
      onToggleToolMessageExpanded,
    });

    let summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(true);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool error");
    expect(summary.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe("Sub-agent");
    expect(summary.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
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
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(true);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool error");
    expect(
      JSON.parse(container.querySelector(".chat-json-content code")?.textContent ?? "{}"),
    ).toEqual({ status: "error" });
    container.remove();
  });

  it("keeps succeeded standalone tool-result summaries collapsed without error styling", () => {
    const container = document.createElement("div");
    const groups = [
      {
        ...createMessageGroup(
          {
            id: "tool-status-error",
            role: "toolResult",
            toolCallId: "call-status-error",
            toolName: "sessions_spawn",
            content: JSON.stringify({ status: "error" }, null, 2),
            timestamp: Date.now(),
          },
          "tool",
        ),
        turnSucceeded: true,
      },
    ];

    renderMessageGroups(container, groups, {
      isToolMessageExpanded: () => false,
    });

    const summary = expectElement(container, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    expect(summary.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
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

  it("notifies when assistant audio and video attachment metadata loads", () => {
    const container = document.createElement("div");
    const onAssistantAttachmentLoaded = vi.fn();

    renderAssistantMessage(
      container,
      {
        id: "assistant-media-layout",
        role: "assistant",
        content:
          "Audio and video\nMEDIA:https://example.com/voice.ogg\nMEDIA:https://example.com/clip.mp4",
        timestamp: Date.now(),
      },
      { showToolCalls: false, onAssistantAttachmentLoaded },
    );

    expectElement(container, "audio", HTMLAudioElement).dispatchEvent(
      new Event("loadedmetadata", { bubbles: true }),
    );
    expectElement(container, "video", HTMLVideoElement).dispatchEvent(
      new Event("loadedmetadata", { bubbles: true }),
    );

    expect(onAssistantAttachmentLoaded).toHaveBeenCalledTimes(2);
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
        {
          id: "assistant-local-media-inline",
          role: "assistant",
          content: `Local image\nMEDIA:${source}`,
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
          basePath: "/openclaw",
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

    await vi.advanceTimersByTimeAsync(1_001);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toContain("mediaTicket=ticket-new");
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

    renderWithToken("test-token-placeholder");
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      expectElement(container, ".chat-message-image", HTMLImageElement).getAttribute("src"),
    ).toContain("mediaTicket=ticket-fresh");
  });

  it("retries unavailable local assistant media after the retry window", async () => {
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
          basePath: "/openclaw",
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
    rerender();
    await flushAssistantAttachmentAvailabilityChecks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      expectElement(container, ".chat-message-image", HTMLImageElement).getAttribute("src"),
    ).toContain("mediaTicket=ticket-retry");
  });

  it("preserves same-origin assistant attachments without local preview rewriting", () => {
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
    const blocked = container.querySelector(".chat-assistant-attachment-card--blocked");
    expect(blocked?.querySelector(".chat-assistant-attachment-card__title")?.textContent).toBe(
      "private.pdf",
    );
    expect(
      blocked?.querySelector(".chat-assistant-attachment-card__reason")?.textContent?.trim(),
    ).toBe("Outside allowed folders");
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("Blocked\nDone");
  });

  it("renders transcript video URLs with encoded extensions", () => {
    const container = document.createElement("div");
    const mediaUrl = "https://cdn.example/clip%2Emp4?download=1";

    renderGroupedMessage(
      container,
      {
        id: "user-encoded-video",
        role: "user",
        content: "",
        MediaPath: mediaUrl,
        timestamp: Date.now(),
      },
      "user",
      { showToolCalls: false },
    );

    expect(expectElement(container, "video", HTMLVideoElement).src).toBe(mediaUrl);
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
          basePath: "/openclaw",
          assistantAttachmentAuthToken: "test-auth-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate: rerender,
        });
      rerender();
    };

    renderUserMedia({
      id: "user-history-image-octet-stream",
      role: "user",
      content: "",
      MediaPath: firstSource,
      MediaType: "application/octet-stream",
      timestamp: Date.now(),
    });
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toContain(`source=${encodeURIComponent(firstSource)}`);

    renderUserMedia({
      id: "user-history-images",
      role: "user",
      content: "",
      MediaPaths: [firstSource, secondSource],
      MediaTypes: ["image/png", "application/octet-stream"],
      timestamp: Date.now(),
    });
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      [...container.querySelectorAll<HTMLImageElement>(".chat-message-image")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([
      expect.stringContaining(`source=${encodeURIComponent(firstSource)}`),
      expect.stringContaining(`source=${encodeURIComponent(secondSource)}`),
    ]);

    renderAssistantMessage(container, {
      role: "assistant",
      content: [{ type: "input_image", image_url: "data:image/png;base64,cG5n" }],
      timestamp: Date.now(),
    });
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
        {
          id: "user-inbound-media-ref",
          role: "user",
          content: "",
          MediaPath: source,
          MediaType: "image/png",
          timestamp: Date.now(),
        },
        "user",
        {
          showToolCalls: false,
          basePath: "/openclaw",
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
      {
        role: "assistant",
        content: [
          {
            type: "openclaw_pairing_qr",
            image_url: "data:image/png;base64,cXJwbmc=",
            alt: "OpenClaw pairing QR code",
            expiresAtMs: Date.now() + 1_000,
          },
        ],
        timestamp: Date.now(),
      },
      { showToolCalls: false, onRequestUpdate },
    );

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,cXJwbmc=");
    expect(image?.getAttribute("alt")).toBe("OpenClaw pairing QR code");
    await vi.advanceTimersByTimeAsync(999);
    expect(onRequestUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);

    renderAssistantMessage(container, {
      role: "assistant",
      content: [
        {
          type: "openclaw_pairing_qr",
          image_url: "data:image/png;base64,ZXhwaXJlZA==",
          alt: "OpenClaw pairing QR code",
          expiresAtMs: Date.now() - 1,
        },
      ],
      timestamp: Date.now(),
    });
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
      {
        id: "user-invalid-inbound-media-ref",
        role: "user",
        content: "",
        MediaPath: source,
        MediaType: "image/png",
        timestamp: Date.now(),
      },
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
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [
          {
            type: "image",
            url: managedChatImageUrl,
            alt: "Generated image 1",
            width: 1,
            height: 1,
          },
        ],
        timestamp: Date.now(),
      },
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "test-auth-token",
      },
    );

    await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image?.getAttribute("src")).toBe(objectUrl);
      expect(image?.getAttribute("alt")).toBe("Generated image 1");
    });
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, managedChatImageUrl);
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

  it("renders direct tool-result image data inline", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [
          {
            type: "image",
            data: "cG5n",
            mimeType: "image/png",
          },
        ],
        timestamp: Date.now(),
      },
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
      {
        role: "assistant",
        content: [
          {
            type: "image",
            data: "data:image/png;base64,cG5n",
          },
        ],
        timestamp: Date.now(),
      },
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

  it("keeps lifted assistant canvas previews beside flat tool rows", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        id: "assistant-tool-canvas",
        role: "assistant",
        toolName: "bash",
        content: [
          {
            type: "tool_use",
            id: "call-tool-canvas",
            name: "bash",
            input: { command: "render preview" },
          },
          createAssistantCanvasBlock({ suffix: "tool_canvas" }),
        ],
        timestamp: Date.now(),
      },
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
    renderAssistantMessage(container, {
      id: "assistant-action-space",
      role: "assistant",
      content: "Copyable assistant text.",
      timestamp: Date.now(),
    });

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

  it("recreates canvas preview iframes when the sandbox policy changes", () => {
    const container = document.createElement("div");
    const renderCanvas = (embedSandboxMode: "strict" | "scripts") =>
      renderMessageGroups(
        container,
        [
          createMessageGroup(
            {
              id: "assistant-canvas-inline-sandbox-change",
              role: "assistant",
              content: [
                { type: "text", text: "Inline canvas result." },
                createAssistantCanvasBlock({ suffix: "sandbox-change" }),
              ],
              timestamp: Date.now(),
            },
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

  it("adds a full-message request when opening a truncated assistant message", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "text", text: "abcde\n...(truncated)..." }],
        __openclaw: { id: "msg-truncated-1", seq: 1 },
      },
      {
        sessionKey: "global",
        agentId: "work",
        onOpenSidebar,
      },
    );

    const expandButton = container.querySelector<HTMLButtonElement>(".chat-expand-btn");
    expect(expandButton).toBeInstanceOf(HTMLButtonElement);
    expandButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar.kind).toBe("markdown");
    expect(sidebar.fullMessageRequest).toEqual({
      sessionKey: "global",
      agentId: "work",
      messageId: "msg-truncated-1",
      kind: "assistant_message",
    });
  });

  it("does not add a full-message request for non-truncated assistant messages", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "text", text: "full visible message" }],
        __openclaw: { id: "msg-visible-1", seq: 1 },
      },
      {
        sessionKey: "global",
        agentId: "work",
        onOpenSidebar,
      },
    );

    const expandButton = container.querySelector<HTMLButtonElement>(".chat-expand-btn");
    expect(expandButton).toBeInstanceOf(HTMLButtonElement);
    expandButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar.kind).toBe("markdown");
    expect(sidebar.fullMessageRequest).toBeUndefined();
  });

  it("does not add a full-message request for mirrored message-tool replies", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
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
        agentId: "work",
        onOpenSidebar,
      },
    );

    const expandButton = container.querySelector<HTMLButtonElement>(".chat-expand-btn");
    expect(expandButton).toBeInstanceOf(HTMLButtonElement);
    expandButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar.kind).toBe("markdown");
    expect(sidebar.fullMessageRequest).toBeUndefined();
  });
});
