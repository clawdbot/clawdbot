/* @vitest-environment jsdom */

// Regression: re-stamping the transcript into a new container (the
// chat<->dashboard face switch) must keep every rendered row observed for
// size changes. A synchronous measureElement(null) prune during the commit
// unobserved just-registered sibling rows, freezing their heights at the old
// pane width and overlapping the bubbles in the dashboard chat dock.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import { resolveAssistantAttachmentAuthToken } from "../chat-pane-state.ts";
import { createTestChatPane } from "../chat-pane.test-support.ts";
import * as chatThreadBuild from "../chat-thread-build.ts";
import { buildCachedChatItems, resetChatThreadState } from "../chat-thread.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import {
  isChatMediaResourceCurrent,
  observeChatMediaResource,
  releaseChatMediaResourceSubscriber,
} from "./chat-message-media.ts";
import {
  renderChatThread,
  resetChatThreadPresentationState,
  resetChatThreadSessionPresentationState,
} from "./chat-thread.ts";

const observedElements = new Set<Element>();
const resizeObservers = new Set<RecordingResizeObserver>();
let measuredRowHeight = 100;

class RecordingResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
    observedElements.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
    observedElements.delete(target);
  }
  disconnect(): void {
    for (const target of this.targets) {
      observedElements.delete(target);
    }
    this.targets.clear();
    resizeObservers.delete(this);
  }
  emit(width: number, height: number): void {
    const entries = [...this.targets].map(
      (target) =>
        ({
          target,
          borderBoxSize: [{ inlineSize: width, blockSize: height }],
        }) as unknown as ResizeObserverEntry,
    );
    if (entries.length > 0) {
      this.callback(entries, this);
    }
  }

  observes(target: Element): boolean {
    return this.targets.has(target);
  }
}

const defaultMessages = [
  { role: "user", content: "message one", timestamp: 1_000 },
  { role: "assistant", content: "reply one", timestamp: 2_000 },
  { role: "user", content: "message two", timestamp: 3_000 },
  { role: "assistant", content: "reply two", timestamp: 4_000 },
];

function threadProps(
  paneId: string,
  sessionKey = "agent:main:main",
  messages: unknown[] = defaultMessages,
) {
  return {
    paneId,
    sessionKey,
    loading: false,
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showThinking: false,
    showToolCalls: false,
    sessions: null,
    assistantName: "Molty",
    assistantAvatar: null,
    onDraftChange: () => {},
    onSend: () => {},
  };
}

function transcriptRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".chat-virtual-row")];
}

async function flushDeferredRowPrune(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("chat transcript row measurement", () => {
  beforeEach(() => {
    observedElements.clear();
    resizeObservers.clear();
    measuredRowHeight = 100;
    vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
    // jsdom reports 0x0 rects and offsetHeight 0; keep the virtualizer
    // viewport and measured row sizes non-zero so re-renders keep producing
    // virtual rows.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      () => measuredRowHeight,
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetChatThreadPresentationState();
    resetChatThreadState();
    document.body.replaceChildren();
  });

  it("keeps every re-stamped row observed after moving containers", async () => {
    const transcript = createTestTranscript();
    const props = threadProps("pane-measure");
    const chatFace = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), chatFace);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const chatRows = transcriptRows(chatFace);
    expect(chatRows.length).toBeGreaterThanOrEqual(4);
    for (const row of chatRows) {
      expect(observedElements.has(row)).toBe(true);
    }

    // Re-stamp the same session transcript into a new container while the old
    // tree is still tracked, mirroring the dashboard face-switch commit.
    const dashboardDock = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), dashboardDock);
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const dockRows = transcriptRows(dashboardDock);
    expect(dockRows.length).toBe(chatRows.length);
    for (const row of dockRows) {
      expect(observedElements.has(row)).toBe(true);
    }
    for (const row of chatRows) {
      expect(observedElements.has(row)).toBe(false);
    }
  });

  it("loads a truncated assistant message once across inline collapse and re-expansion", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const loadFullAssistantMessage = vi.fn().mockResolvedValue({
      ok: true,
      message: { role: "assistant", content: "Complete assistant content." },
    });
    function rerender() {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    }
    const props = {
      ...threadProps("pane-assistant-expand", "agent:work:main", [
        {
          role: "assistant",
          content: "Preview\n...(truncated)...",
          __openclaw: { id: "assistant-full-1" },
          timestamp: 1_000,
        },
      ]),
      fullMessageAgentId: "work",
      loadFullAssistantMessage,
      onRequestUpdate: rerender,
    };
    rerender();
    transcript.hostConnected();
    transcript.hostUpdated();

    const showMore = container.querySelector<HTMLButtonElement>(".chat-message-disclosure__toggle");
    expect(showMore?.textContent?.trim()).toBe("Show more");
    showMore?.click();

    await vi.waitFor(() => expect(container.textContent).toContain("Complete assistant content."));
    expect(loadFullAssistantMessage).toHaveBeenCalledOnce();
    expect(loadFullAssistantMessage).toHaveBeenCalledWith({
      sessionKey: "agent:work:main",
      agentId: "work",
      messageId: "assistant-full-1",
      kind: "assistant_message",
    });

    const showLess = container.querySelector<HTMLButtonElement>(".chat-message-disclosure__toggle");
    expect(showLess?.textContent?.trim()).toBe("Show less");
    showLess?.click();
    expect(container.textContent).toContain("...(truncated)...");
    expect(container.textContent).not.toContain("Complete assistant content.");

    container.querySelector<HTMLButtonElement>(".chat-message-disclosure__toggle")?.click();
    expect(container.textContent).toContain("Complete assistant content.");
    expect(loadFullAssistantMessage).toHaveBeenCalledOnce();
    transcript.hostDisconnected();
  });

  it("shows a retryable inline error when full assistant content cannot be loaded", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const loadFullAssistantMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        message: { role: "assistant", content: "Recovered full content." },
      });
    function rerender() {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    }
    const props = {
      ...threadProps("pane-assistant-retry", "agent:main:main", [
        {
          role: "assistant",
          content: "Preview\n...(truncated)...",
          __openclaw: { id: "assistant-retry-1" },
          timestamp: 1_000,
        },
      ]),
      loadFullAssistantMessage,
      onRequestUpdate: rerender,
    };
    rerender();
    transcript.hostConnected();
    transcript.hostUpdated();

    container.querySelector<HTMLButtonElement>(".chat-message-disclosure__toggle")?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Could not load the full message."),
    );
    const retry = container.querySelector<HTMLButtonElement>(".chat-message-disclosure__toggle");
    expect(retry?.textContent?.trim()).toBe("Show more");
    expect(retry?.disabled).toBe(false);

    retry?.click();
    await vi.waitFor(() => expect(container.textContent).toContain("Recovered full content."));
    expect(loadFullAssistantMessage).toHaveBeenCalledTimes(2);
    transcript.hostDisconnected();
  });

  it.each(["Enter", " "])("opens focused transcript file links with %j", async (key) => {
    const transcript = createTestTranscript();
    const onOpenWorkspaceFile = vi.fn();
    const onHistoryIntent = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const props = {
      ...threadProps("pane-file-link", "agent:main:main", [
        { role: "assistant", content: "Inspect `src/chat.ts:17`", timestamp: 1_000 },
      ]),
      onOpenWorkspaceFile,
      onHistoryIntent,
    };
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const link = container.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    link?.focus();
    expect(document.activeElement).toBe(link);
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: "src/chat.ts", line: 17 });
    expect(onHistoryIntent).not.toHaveBeenCalled();
    transcript.hostDisconnected();
  });

  it("keeps built row identities across an A to B to A presentation reset", () => {
    const paneId = "pane-session-items";
    const messagesA = [{ role: "assistant", content: "session A", timestamp: 1_000 }];
    const messagesB = [{ role: "assistant", content: "session B", timestamp: 2_000 }];
    const stableInputs = {
      paneId,
      runId: null,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    };
    const buildSpy = vi.spyOn(chatThreadBuild, "buildChatItems");
    const itemsA = buildCachedChatItems({
      ...stableInputs,
      sessionKey: "agent:main:session-a",
      messages: messagesA,
    });

    resetChatThreadSessionPresentationState(paneId);
    buildCachedChatItems({
      ...stableInputs,
      sessionKey: "agent:main:session-b",
      messages: messagesB,
    });
    resetChatThreadSessionPresentationState(paneId);
    const restoredItemsA = buildCachedChatItems({
      ...stableInputs,
      sessionKey: "agent:main:session-a",
      messages: messagesA,
    });

    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(restoredItemsA).toBe(itemsA);
    expect(restoredItemsA.every((item, index) => item === itemsA[index])).toBe(true);
  });

  it("pauses an unmeasurable restore until loading commits an empty transcript", () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-loading-scroll", "agent:main:session-a", []);
    render(renderChatThread({ ...props, loading: true }, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    transcript.scrollToOffset(420);
    transcript.hostUpdated();

    expect(transcript.pendingScrollOffsetFor(props.sessionKey)).toBe(420);

    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();
    expect(transcript.pendingScrollOffsetFor(props.sessionKey)).toBeNull();
  });

  it("settles a restored offset when loaded rows no longer overflow", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-short-scroll", "agent:main:session-a");
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    transcript.scrollToOffset(420);

    for (let index = 0; index <= 60; index += 1) {
      transcript.hostUpdated();
      for (const frame of frames.splice(0)) {
        frame(0);
      }
    }

    expect(transcript.pendingScrollOffsetFor(props.sessionKey)).toBeNull();
  });

  it("updates rendered row offsets from freshly wrapped heights while scrolling", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-width-remeasure");
    const renderTranscript = async () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
      await flushDeferredRowPrune();
    };

    await renderTranscript();
    transcript.hostConnected();
    await renderTranscript();
    expect(transcriptRows(container)[1]?.style.transform).toBe("translateY(100px)");

    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    scrollElement!.scrollTop = 40;
    scrollElement!.dispatchEvent(new Event("scroll"));
    const virtualizer = (
      transcript as unknown as {
        sessionVirtualizer: {
          virtualizerController: { getVirtualizer: () => { isScrolling: boolean } };
        };
      }
    ).sessionVirtualizer.virtualizerController.getVirtualizer();
    expect(virtualizer.isScrolling).toBe(true);

    measuredRowHeight = 180;
    for (const observer of resizeObservers) {
      if (scrollElement && observer.observes(scrollElement)) {
        observer.emit(640, 600);
      }
    }
    await renderTranscript();

    expect(transcriptRows(container)[1]?.style.transform).toBe("translateY(180px)");
    transcript.hostDisconnected();
  });

  it("rebinds guarded transcript images when the gateway rotates its auth token", async () => {
    const NativeUrl = URL;
    const blobUrl = `blob:transcript-media-${crypto.randomUUID()}`;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => blobUrl);
        static override revokeObjectURL = vi.fn();
      },
    );

    let previousSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_source: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          previousSignal = init?.signal ?? undefined;
          previousSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("media scope changed", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const client = {
      request: vi.fn(async () => null),
    } as unknown as Parameters<typeof createTestChatPane>[0]["client"];
    const sessions = {} as Parameters<typeof createTestChatPane>[0]["sessions"];
    const { pane, state } = createTestChatPane({ client, sessions });
    state.hello = {
      auth: { deviceToken: "old-token" },
    } as typeof state.hello;
    const messages = [
      {
        role: "assistant",
        content: [{ type: "image", url: source }],
        timestamp: 1_000,
      },
    ];
    const renderPane = () => {
      render(
        renderChatThread(
          {
            ...threadProps("pane-gateway-media-auth", state.sessionKey, messages),
            assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
            onRequestUpdate: renderPane,
          },
          transcript,
        ),
        container,
      );
      transcript.hostUpdated();
    };
    state.requestUpdate = renderPane;

    renderPane();
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const thumbnailSource = source.replace(/\/full$/u, "/thumbnail");
    const previousResource = observeChatMediaResource<string | null>(
      "managed-image",
      `${thumbnailSource}::old-token::`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(previousResource.subscribers.size).toBe(1);

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "connected",
      hello: {
        ...pane.context.gateway.snapshot.hello,
        auth: { deviceToken: "next-token" },
      } as typeof pane.context.gateway.snapshot.hello,
    });
    expect(previousSignal?.aborted).toBe(true);
    expect(isChatMediaResourceCurrent(previousResource)).toBe(false);
    await flushDeferredRowPrune();

    const nextResource = observeChatMediaResource<string | null>(
      "managed-image",
      `${thumbnailSource}::next-token::`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer next-token",
    );
    expect(isChatMediaResourceCurrent(nextResource)).toBe(true);
    expect(nextResource.subscribers.size).toBe(1);
    expect(container.querySelector<HTMLImageElement>(".chat-message-image")?.src).toBe(blobUrl);

    releaseChatMediaResourceSubscriber(renderPane);
    transcript.hostDisconnected();
  });

  it("reconciles guarded local attachments when pane preview roots change", async () => {
    let previousSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_source: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          previousSignal = init?.signal ?? undefined;
          previousSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("preview roots changed", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "root-restored-ticket",
          mediaTicketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = {
      request: vi.fn(async () => null),
    } as unknown as Parameters<typeof createTestChatPane>[0]["client"];
    const sessions = {} as Parameters<typeof createTestChatPane>[0]["sessions"];
    const { pane, state } = createTestChatPane({ client, sessions });
    const configPane = pane as typeof pane & {
      applyApplicationConfig: (config: typeof pane.context.config.current) => void;
    };
    state.hello = {
      auth: { deviceToken: "old-token" },
    } as typeof state.hello;
    state.localMediaPreviewRoots = ["/tmp/openclaw"];
    state.embedSandboxMode = "scripts";
    state.allowExternalEmbedUrls = false;

    const source = `/tmp/openclaw/${crypto.randomUUID()}.pdf`;
    const messages = [
      {
        role: "assistant",
        content: `Local document\nMEDIA:${source}`,
        timestamp: 1_000,
      },
    ];
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const renderPane = () => {
      render(
        renderChatThread(
          {
            ...threadProps("pane-local-media-roots", state.sessionKey, messages),
            assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
            localMediaPreviewRoots: state.localMediaPreviewRoots,
            onRequestUpdate: renderPane,
          },
          transcript,
        ),
        container,
      );
      transcript.hostUpdated();
    };
    state.requestUpdate = renderPane;

    renderPane();
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const previousResource = observeChatMediaResource(
      "assistant-attachment",
      `::old-token::${source}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(previousResource.subscribers.size).toBe(1);

    const config = {
      ...pane.context.config.current,
      localMediaPreviewRoots: ["/tmp/elsewhere"],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
    };
    configPane.applyApplicationConfig(config);
    await flushDeferredRowPrune();

    expect(previousSignal?.aborted).toBe(true);
    expect(isChatMediaResourceCurrent(previousResource)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(".chat-assistant-attachment-card__reason")?.textContent,
    ).toContain("Outside allowed folders");

    configPane.applyApplicationConfig({
      ...config,
      localMediaPreviewRoots: ["/tmp/openclaw"],
    });
    await flushDeferredRowPrune();

    const restoredResource = observeChatMediaResource(
      "assistant-attachment",
      `::old-token::${source}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer old-token",
    );
    expect(isChatMediaResourceCurrent(restoredResource)).toBe(true);
    expect(restoredResource.subscribers.size).toBe(1);
    expect(
      container.querySelector(".chat-assistant-attachment-card__link")?.getAttribute("href"),
    ).toContain("mediaTicket=root-restored-ticket");

    releaseChatMediaResourceSubscriber(renderPane);
    transcript.hostDisconnected();
  });

  it("updates MCP App pinning when the same provider's capability changes", async () => {
    const provider = {
      sessionKey: "agent:main:main",
      canPinWidgets: true,
      canPinMcpApps: false,
      pinMcpApp: vi.fn(async () => undefined),
      snapshot$: {
        value: {
          sessionKey: "agent:main:main",
          revision: 1,
          tabs: [],
          widgets: [],
        },
        subscribe: () => () => undefined,
      },
    };
    const props = {
      ...threadProps("pane-mcp-capability"),
      boardProvider: provider as unknown as BoardProvider,
      messages: [
        {
          role: "assistant",
          timestamp: 1_000,
          content: [
            { type: "text", text: "Here is the dashboard app." },
            {
              type: "canvas",
              preview: {
                kind: "canvas",
                surface: "assistant_message",
                render: "url",
                title: "Dashboard app",
                viewId: "outer-view-must-not-be-pinned",
                mcpApp: {
                  viewId: "view-dashboard-app",
                  serverName: "dashboard",
                  toolName: "show",
                  uiResourceUri: "ui://dashboard/app.html",
                  toolCallId: "call-dashboard-app",
                  originSessionKey: "agent:main:main",
                },
              },
            },
          ],
        },
      ],
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));

    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    expect(container.querySelector('[data-content-kind="mcp-app"]')).not.toBeNull();
    expect(container.querySelector("[data-pin-widget]")).toBeNull();

    provider.canPinMcpApps = true;
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();

    expect(container.querySelector("[data-pin-widget]")).not.toBeNull();
    expect(provider.snapshot$.value.revision).toBe(1);

    provider.canPinMcpApps = false;
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();

    expect(container.querySelector("[data-pin-widget]")).toBeNull();
    expect(provider.snapshot$.value.revision).toBe(1);
  });
});
