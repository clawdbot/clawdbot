/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { MessageGroup } from "../types/chat-types.ts";
import { buildChatItems, type BuildChatItemsProps } from "./build-chat-items.ts";
import {
  renderMessageGroup,
  resetAssistantAttachmentAvailabilityCacheForTest,
} from "./grouped-render.ts";
import { normalizeMessage } from "./message-normalizer.ts";

vi.mock("../markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

vi.mock("../views/agents-utils.ts", () => ({
  agentLogoUrl: () => "/openclaw-logo.svg",
  isRenderableControlUiAvatarUrl: (value: string) =>
    /^data:image\//i.test(value) || (value.startsWith("/") && !value.startsWith("//")),
}));

vi.mock("./speech.ts", () => ({
  isTtsSpeaking: () => false,
  isTtsSupported: () => false,
  speakText: () => false,
  stopTts: () => undefined,
}));

type RenderMessageGroupOptions = Parameters<typeof renderMessageGroup>[1];

function renderAssistantMessage(
  container: HTMLElement,
  message: unknown,
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  renderGroupedMessage(container, message, "assistant", opts);
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

function renderBuiltMessageGroups(
  container: HTMLElement,
  props: Partial<BuildChatItemsProps>,
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const groups = buildChatItems({
    sessionKey: "main",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...props,
  }).filter((item) => item.kind === "group");
  renderMessageGroups(container, groups, opts);
}

function clearDeleteConfirmSkip() {
  try {
    getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
  } catch {
    /* noop */
  }
}

async function flushAssistantAttachmentAvailabilityChecks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("grouped chat rendering", () => {
  it("falls back to the logo while authenticated avatar routes are loading", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        assistantAvatar: "/avatar/main",
        assistantAttachmentAuthToken: "session-token",
      },
    );

    const img = container.querySelector("img.chat-avatar");
    expect(img?.getAttribute("src")).toBe("/openclaw-logo.svg");
  });

  it("positions delete confirm by message side", () => {
    const renderDeletable = (role: "user" | "assistant") => {
      const container = document.createElement("div");
      clearDeleteConfirmSkip();
      renderGroupedMessage(
        container,
        {
          role,
          content: `hello from ${role}`,
          timestamp: 1000,
        },
        role,
        { onDelete: vi.fn() },
      );
      return container;
    };

    const userContainer = renderDeletable("user");
    const userDeleteButton = userContainer.querySelector<HTMLButtonElement>(
      ".chat-group.user .chat-group-delete",
    );
    expect(userDeleteButton).not.toBeNull();
    userDeleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const userConfirm = userContainer.querySelector<HTMLElement>(
      ".chat-group.user .chat-delete-confirm",
    );
    expect(userConfirm).not.toBeNull();
    expect(userConfirm?.classList.contains("chat-delete-confirm--left")).toBe(true);

    const assistantContainer = renderDeletable("assistant");
    const assistantDeleteButton = assistantContainer.querySelector<HTMLButtonElement>(
      ".chat-group.assistant .chat-group-delete",
    );
    expect(assistantDeleteButton).not.toBeNull();
    assistantDeleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const assistantConfirm = assistantContainer.querySelector<HTMLElement>(
      ".chat-group.assistant .chat-delete-confirm",
    );
    expect(assistantConfirm).not.toBeNull();
    expect(assistantConfirm?.classList.contains("chat-delete-confirm--right")).toBe(true);
  });

  it("falls back to the local logo when the assistant avatar is a remote URL", () => {
    const container = document.createElement("div");

    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: "hello",
        timestamp: 1000,
      },
      { assistantAvatar: "https://example.com/avatar.png" },
    );

    const avatar = container.querySelector<HTMLImageElement>(".chat-avatar.assistant");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("src")).toBe("/openclaw-logo.svg");
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

    expect(container.textContent).not.toContain("Input");
    expect(container.textContent).not.toContain("Output");

    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => true,
    });

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("https://example.com");
    expect(container.textContent).toContain("Opened page");
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

    const summary = container.querySelector<HTMLElement>(".chat-tool-msg-summary");
    expect(summary?.textContent).toContain("Tool call");
    expect(container.textContent).not.toContain('"thread": true');

    renderAssistantMessage(container, message, {
      isToolMessageExpanded: () => true,
    });

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
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

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain('"status": "error"');
    expect(container.textContent).toContain('"childSessionKey": "agent:test:subagent:abc123"');
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

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
    expect(container.textContent).toContain('"status": "error"');

    renderMessageGroups(container, groups, {
      isToolMessageExpanded: (messageId) => !messageId.startsWith("toolmsg:assistant:"),
    });

    expect(container.textContent).not.toContain("Tool input");
    expect(container.textContent).toContain('"status": "error"');
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

  it("renders allowed transcript images and skips blocked/non-image media", () => {
    const renderUserMedia = (message: unknown) => {
      const container = document.createElement("div");
      renderGroupedMessage(container, message, "user", {
        showToolCalls: false,
        basePath: "/openclaw",
        assistantAttachmentAuthToken: "session-token",
        localMediaPreviewRoots: ["/tmp/openclaw"],
      });
      return container;
    };

    let container = renderUserMedia({
      id: "user-history-image",
      role: "user",
      content: "",
      MediaPath: "/tmp/openclaw/user-upload.png",
      timestamp: Date.now(),
    });
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Fuser-upload.png&token=session-token",
    );

    container = renderUserMedia({
      id: "user-history-image-octet-stream",
      role: "user",
      content: "",
      MediaPath: "/tmp/openclaw/user-upload.png",
      MediaType: "application/octet-stream",
      timestamp: Date.now(),
    });
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Fuser-upload.png&token=session-token",
    );

    container = renderUserMedia({
      id: "user-history-images",
      role: "user",
      content: "",
      MediaPaths: ["/tmp/openclaw/first.png", "/tmp/openclaw/second.jpg"],
      MediaTypes: ["image/png", "application/octet-stream"],
      timestamp: Date.now(),
    });
    expect(
      [...container.querySelectorAll<HTMLImageElement>(".chat-message-image")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Ffirst.png&token=session-token",
      "/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fopenclaw%2Fsecond.jpg&token=session-token",
    ]);

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
      MediaPath: "/tmp/openclaw/user-upload.pdf",
      MediaType: "application/pdf",
      timestamp: Date.now(),
    });
    expect(container.querySelector(".chat-message-image")).toBeNull();
  });

  it("renders legacy input_image image_url blocks", () => {
    const container = document.createElement("div");

    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: [{ type: "input_image", image_url: "data:image/png;base64,cG5n" }],
        timestamp: Date.now(),
      },
      { showToolCalls: false },
    );

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,cG5n");
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

    expect(container.querySelector(".chat-bubble")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(container.textContent).toContain("Tic-Tac-Toe");
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

    const assistantBubble = container.querySelector(".chat-group.assistant .chat-bubble");
    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(1);
    expect(assistantBubble?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(assistantBubble?.textContent).toContain("This item is ready.");
    expect(assistantBubble?.textContent).toContain("Live history preview");
  });

  it("renders hidden assistant_message canvas results with the configured sandbox", () => {
    const container = document.createElement("div");
    const renderCanvas = (params: { embedSandboxMode?: "trusted"; suffix: string }) =>
      renderBuiltMessageGroups(
        container,
        {
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
        },
        {
          embedSandboxMode: params.embedSandboxMode ?? "scripts",
        },
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
    renderBuiltMessageGroups(
      container,
      {
        showToolCalls: true,
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
      },
      {
        isToolMessageExpanded: () => true,
      },
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

  it("opens generic tool details instead of a canvas preview from tool rows", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    renderBuiltMessageGroups(
      container,
      {
        showToolCalls: true,
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
      },
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
        onOpenSidebar,
      },
    );

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
});
