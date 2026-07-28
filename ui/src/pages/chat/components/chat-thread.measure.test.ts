/* @vitest-environment jsdom */

// Regression: re-stamping the transcript into a new container (the
// chat<->dashboard face switch) must keep every rendered row observed for
// size changes. A synchronous measureElement(null) prune during the commit
// unobserved just-registered sibling rows, freezing their heights at the old
// pane width and overlapping the bubbles in the dashboard chat dock.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import * as chatThreadBuild from "../chat-thread-build.ts";
import { buildCachedChatItems, resetChatThreadState } from "../chat-thread.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import {
  renderChatThread,
  resetChatThreadPresentationState,
  resetChatThreadSessionPresentationState,
} from "./chat-thread.ts";

const observedElements = new Set<Element>();
const resizeObservers = new Set<RecordingResizeObserver>();

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
    vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
    // jsdom reports 0x0 rects and offsetHeight 0; keep the virtualizer
    // viewport and measured row sizes non-zero so re-renders keep producing
    // virtual rows.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
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

  it("keeps an unsettled restored offset with its cached session host", () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index,
    }));
    const renderSession = (sessionKey: string) => {
      render(
        renderChatThread(threadProps("pane-pending-scroll", sessionKey, messages), transcript),
        container,
      );
    };
    renderSession("agent:main:session-a");
    transcript.hostConnected();
    transcript.hostUpdated();
    transcript.scrollToOffset(420);
    expect(transcript.pendingScrollOffsetFor("agent:main:session-a")).toBe(420);

    renderSession("agent:main:session-b");
    transcript.hostUpdated();
    expect(transcript.pendingScrollOffsetFor("agent:main:session-b")).toBeNull();

    renderSession("agent:main:session-a");
    expect(transcript.pendingScrollOffsetFor("agent:main:session-a")).toBe(420);
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

  it("reuses measured hosts, remeasures width changes, and tears down evictions", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const renderSession = async (sessionKey: string) => {
      render(renderChatThread(threadProps("pane-host-cache", sessionKey), transcript), container);
      transcript.hostUpdated();
      await flushDeferredRowPrune();
    };
    await renderSession("agent:main:session-a");
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    type VirtualizerInternals = {
      itemSizeCache: Map<unknown, number>;
      measure: () => void;
    };
    type SessionHostInternals = {
      connected: boolean;
      measureRowRefs: Map<string, unknown>;
      virtualizerController: { getVirtualizer: () => VirtualizerInternals };
    };
    const controllerInternals = transcript as unknown as {
      sessionVirtualizers: Map<string, SessionHostInternals>;
    };
    const hostA = controllerInternals.sessionVirtualizers.get("agent:main:session-a");
    expect(hostA).toBeDefined();
    const virtualizerA = hostA?.virtualizerController.getVirtualizer();
    expect(virtualizerA?.itemSizeCache.size).toBeGreaterThan(0);
    const measuredSizes = new Map(virtualizerA?.itemSizeCache);

    await renderSession("agent:main:session-b");
    await renderSession("agent:main:session-a");
    expect(controllerInternals.sessionVirtualizers.get("agent:main:session-a")).toBe(hostA);
    expect(virtualizerA?.itemSizeCache).toEqual(measuredSizes);

    const measure = vi.spyOn(virtualizerA as VirtualizerInternals, "measure");
    for (const observer of resizeObservers) {
      observer.emit(640, 600);
    }
    expect(measure).toHaveBeenCalled();

    await renderSession("agent:main:session-c");
    await renderSession("agent:main:session-d");
    expect(controllerInternals.sessionVirtualizers.size).toBe(3);
    expect(controllerInternals.sessionVirtualizers.has("agent:main:session-b")).toBe(false);
    expect(hostA?.connected).toBe(false);

    await renderSession("agent:main:session-e");
    expect(controllerInternals.sessionVirtualizers.has("agent:main:session-a")).toBe(false);
    expect(hostA?.measureRowRefs.size).toBe(0);
    transcript.hostDisconnected();
    expect(observedElements.size).toBe(0);
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
