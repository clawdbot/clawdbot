/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import { renderReadOnlyTranscript } from "./chat-read-only-transcript.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  ChatTranscriptController,
  type ChatTranscriptSession,
} from "./chat-transcript-controller.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  observedElements,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
  transcriptRows,
} from "./chat-transcript.test-support.ts";

function transcriptSize(container: ParentNode): number {
  const sizer = expectDefined(
    container.querySelector<HTMLElement>(".chat-virtual-sizer"),
    "transcript extent",
  );
  return Number.parseFloat(sizer.style.height);
}

type TestContentRow = Extract<TranscriptRow, { kind: "content" }>;

function stubMcpAppLifecycle(
  container: ParentNode,
  teardown: () => Promise<void> = () => Promise.resolve(),
) {
  const app = expectDefined(
    container.querySelector<HTMLElement>("mcp-app-view"),
    "mounted MCP app",
  );
  const lifecycle = {
    restartAfterTeardown: vi.fn(),
    teardown: vi.fn(teardown),
  };
  return { app: Object.assign(app, lifecycle), ...lifecycle };
}

async function mountTestTranscript(paneId: string, initialRows: readonly TestContentRow[]) {
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  let currentSession: ChatTranscriptSession;
  container.addEventListener("focusin", (event) => currentSession.handleFocusIn(event));
  container.addEventListener("focusout", (event) => currentSession.handleFocusOut(event));
  const renderRows = (rows: readonly TestContentRow[]) => {
    const view = transcript.renderSession(paneId, `agent:main:${paneId}`, (session) => {
      currentSession = session;
      return session.render(
        rows,
        (row) => (row.kind === "content" ? row.content : nothing),
        null,
        false,
      );
    });
    render(view, container);
    transcript.hostUpdated();
  };
  transcript.hostConnected();
  renderRows(initialRows);
  await flushDeferredRowPrune();
  return { container, renderRows, transcript };
}

function mcpRangeRows(appContent: unknown): TestContentRow[] {
  return Array.from({ length: 24 }, (_, index) => ({
    kind: "content" as const,
    key: `row:${index}`,
    content: index === 17 ? appContent : html`<div>row ${index}</div>`,
  }));
}

describe("chat transcript controller", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

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

  it("measures newly inserted rows after Lit connects them", async () => {
    // Lit invokes ref callbacks while a new row is still detached. Browsers
    // report a zero offsetHeight there, which must not become the row's
    // durable virtual size before the following user bubble is positioned.
    transcriptDomState.detachedRowHeight = 0;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-commentary-insert", "agent:main:session-a", [
      { role: "assistant", content: "commentary", timestamp: 1_000 },
      { role: "user", content: "next turn", timestamp: 2_000 },
    ]);

    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    render(renderChatThread(props, transcript), container);

    expect(transcriptSize(container)).toBe(200);
  });

  it("keeps retained MCP rows and the virtual row model atomic through teardown", async () => {
    const teardownPending = createDeferred();
    transcriptDomState.measuredRowHeight = 180;
    const initialRows = [
      { kind: "content" as const, key: "app", content: html`<mcp-app-view></mcp-app-view>` },
      { kind: "content" as const, key: "group:tool", content: html`<div>tool</div>` },
      { kind: "content" as const, key: "group:reply", content: html`<div>reply</div>` },
    ];
    const regroupedRows = [
      { kind: "content" as const, key: "history", content: html`<div>history</div>` },
      {
        kind: "content" as const,
        key: "group:reply",
        content: html`<div>regrouped</div>`,
      },
      { kind: "content" as const, key: "group:next", content: html`<div>next</div>` },
    ];
    const { container, renderRows } = await mountTestTranscript("pane-mcp-rows", initialRows);
    stubMcpAppLifecycle(container, () => teardownPending.promise);

    renderRows(regroupedRows);
    const retainedRows = transcriptRows(container);
    expect(retainedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
      "app",
      "group:tool",
      "group:reply",
    ]);

    // Deliver an old-tree resize while teardown keeps that tree connected.
    // Its data-index values must still resolve through the old key model.
    Object.defineProperty(retainedRows[1]!, "offsetHeight", { configurable: true, value: 40 });
    for (const observer of resizeObservers) {
      observer.emitTarget(retainedRows[1]!, 800, 40);
    }
    teardownPending.resolve();
    await teardownPending.promise;
    await Promise.resolve();
    renderRows(regroupedRows);
    await flushDeferredRowPrune();
    renderRows(regroupedRows);

    const committedRows = transcriptRows(container);
    expect(committedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
      "history",
      "group:reply",
      "group:next",
    ]);
    // The old tool's 40px delivery must not resize the retained reply key.
    expect(transcriptSize(container)).toBe(540);
  });

  it("does not teardown an MCP row retained by an append", async () => {
    const initialRows = [
      { kind: "content" as const, key: "app", content: html`<mcp-app-view></mcp-app-view>` },
      { kind: "content" as const, key: "reply", content: html`<div>reply</div>` },
    ];
    const { container, renderRows } = await mountTestTranscript("pane-mcp-append", initialRows);
    const { app, teardown } = stubMcpAppLifecycle(container);

    renderRows([...initialRows, { kind: "content", key: "next", content: html`<div>next</div>` }]);

    expect(teardown).not.toHaveBeenCalled();
    expect(container.querySelector("mcp-app-view")).toBe(app);
  });

  it("tears down a retained MCP key that leaves the next virtual range", async () => {
    const initialRows = mcpRangeRows(html`<mcp-app-view></mcp-app-view>`);
    const { container, renderRows } = await mountTestTranscript("pane-mcp-range", initialRows);
    const { app, teardown } = stubMcpAppLifecycle(container);

    renderRows([initialRows[17]!, ...initialRows.slice(0, 17), ...initialRows.slice(18)]);

    expect(teardown).toHaveBeenCalledOnce();
    expect(app.isConnected).toBe(true);
  });

  it("keeps a focused MCP key at its next-model index", async () => {
    const initialRows = mcpRangeRows(
      html`<mcp-app-view
        ><iframe title="Retained application"></iframe><button>focus app</button></mcp-app-view
      >`,
    );
    const { container, renderRows } = await mountTestTranscript(
      "pane-mcp-focused-range",
      initialRows,
    );
    const { app, teardown } = stubMcpAppLifecycle(container);
    const frame = expectDefined(app.querySelector("iframe"), "retained application frame");
    const rowParent = expectDefined(app.parentElement?.parentElement, "retained row parent");
    const button = expectDefined(container.querySelector("button"), "MCP app focus target");
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    renderRows([initialRows[17]!, ...initialRows.slice(0, 17), ...initialRows.slice(18)]);

    expect(teardown).not.toHaveBeenCalled();
    expect(app.isConnected).toBe(true);
    expect(container.querySelector("mcp-app-view")).toBe(app);
    expect(app.querySelector("iframe")).toBe(frame);
    expect(app.parentElement?.parentElement).toBe(rowParent);
  });

  it("reconciles an implicit end anchor when committed content has no scroll range", () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const messages = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index + 1,
    }));
    const props = threadProps("pane-underfill-anchor", "agent:main:underfill", messages);
    render(renderChatThread(props, transcript), container);
    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 600 },
    });

    transcript.hostConnected();
    transcript.scrollToEnd({ source: "auto" });
    transcript.hostUpdated();
    render(renderChatThread(props, transcript), container);
    expect(transcriptRows(container)[0]?.dataset.index).toBe("0");
    expect(container.textContent).toContain("message 0");
  });

  it("pauses an unmeasurable restore until loading commits an empty transcript", () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-loading-scroll", "agent:main:session-a", []);
    render(renderChatThread({ ...props, loading: true }, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    const onSettled = vi.fn();
    transcript.scrollToOffset(420, onSettled);
    transcript.hostUpdated();

    expect(onSettled).not.toHaveBeenCalled();

    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();
    expect(onSettled).toHaveBeenCalledWith({ scrollTop: 0, anchorToEnd: true });
  });

  it("settles a restored offset when loaded rows no longer overflow", () => {
    const flushFrames = stubAnimationFrames();
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-short-scroll", "agent:main:session-a");
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    const onSettled = vi.fn();
    transcript.scrollToOffset(420, onSettled);

    for (let index = 0; index <= 60; index += 1) {
      transcript.hostUpdated();
      flushFrames();
    }

    expect(onSettled).toHaveBeenCalledWith({ scrollTop: 0, anchorToEnd: true });
  });

  it("updates transcript extent from freshly wrapped heights while scrolling", async () => {
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
    for (const observer of resizeObservers) {
      for (const row of transcriptRows(container)) {
        observer.emitTarget(row, 800, 100);
      }
    }
    await renderTranscript();
    expect(transcriptSize(container)).toBe(400);

    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    // Establish the real viewport baseline first: zero rects from jsdom's
    // 0-width offsetWidth are ignored as hide transitions, matching browsers
    // where the initial attach rect is the true width.
    for (const observer of resizeObservers) {
      if (observer.observes(scrollElement!)) {
        observer.emit(800, 600);
      }
    }
    scrollElement!.scrollTop = 40;
    scrollElement!.dispatchEvent(new Event("scroll"));

    transcriptDomState.measuredRowHeight = 180;
    for (const observer of resizeObservers) {
      if (scrollElement && observer.observes(scrollElement)) {
        observer.emit(640, 600);
      }
    }
    await renderTranscript();

    expect(transcriptSize(container)).toBe(720);
    transcript.hostDisconnected();
  });

  it.each([
    { behavior: "auto", resizeBefore: true, deltaY: -100 },
    { behavior: "smooth", resizeBefore: true, deltaY: -100 },
    { behavior: "smooth", resizeBefore: false, deltaY: -100 },
    { behavior: "smooth", resizeBefore: true, deltaY: 100 },
  ] as const)(
    "recovers $behavior measurements with resizeBeforeInterruption=$resizeBefore and wheel=$deltaY",
    async ({ behavior, resizeBefore, deltaY }) => {
      const flushFrames = stubAnimationFrames();
      transcriptDomState.measuredRowHeight = 120;
      const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
        kind: "content",
        key: `row:${index}`,
        content: html`<div>row ${index}</div>`,
      }));
      const { container, renderRows, transcript } = await mountTestTranscript(
        `pane-${behavior}-${resizeBefore}-resize`,
        rows,
      );
      try {
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 600 },
          scrollHeight: { configurable: true, value: 4000 },
        });
        for (const observer of resizeObservers) {
          observer.emitTarget(container, 800, 600);
        }
        transcript.scrollToOffset(0);
        renderRows(rows);
        container.dispatchEvent(new Event("scroll"));
        renderRows(rows);
        await flushDeferredRowPrune();
        flushFrames();
        renderRows(rows);
        const first = expectDefined(
          container.querySelector<HTMLElement>('[data-index="0"]'),
          "first row",
        );
        const initialSize = transcriptSize(container);
        const resize = () => {
          Object.defineProperty(first, "offsetHeight", { configurable: true, value: 200 });
          for (const observer of resizeObservers) {
            observer.emitTarget(first, 800, 200);
          }
        };
        transcript.scrollToEnd({ behavior });
        if (resizeBefore) {
          resize();
        }
        container.dispatchEvent(new WheelEvent("wheel", { deltaY }));
        container.scrollTop = 0;
        container.dispatchEvent(new Event("scroll"));
        if (!resizeBefore) {
          resize();
        }
        flushFrames();
        renderRows(rows);
        expect(transcriptSize(container)).toBe(initialSize + 80);
        expect(container.scrollTop).toBe(0);
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("keeps a smooth latest command through an idle observer delivery before reaching its target", async () => {
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row:${index}`,
      content: html`<div>row ${index}</div>`,
    }));
    const { container, transcript } = await mountTestTranscript("idle-latest", rows);
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4800 },
    });
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    vi.useFakeTimers();
    try {
      container.scrollTop = 1000;
      container.dispatchEvent(new Event("scroll"));
      transcript.scrollToEnd({ behavior: "smooth" });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 4200, behavior: "smooth" });
      container.scrollTop = 1500;
      container.dispatchEvent(new Event("scroll"));
      Object.defineProperty(container, "scrollHeight", { configurable: true, value: 4900 });
      vi.advanceTimersByTime(16);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 4300, behavior: "smooth" });
      scrollTo.mockClear();

      // A retargeted native animation can pause between offset events. Core's
      // idle debounce still fires, but the requested end has not been reached.
      vi.advanceTimersByTime(150);
      expect(transcript.isProgrammaticScroll).toBe(true);
      expect(scrollTo).not.toHaveBeenCalled();

      // The 8px UI-follow boundary does not complete the native end command.
      container.scrollTop = 4296;
      container.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(150);
      expect(transcript.isProgrammaticScroll).toBe(false);
      expect(scrollTo).not.toHaveBeenCalled();

      container.scrollTop = 4300;
      container.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(150);
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 4300, behavior: "instant" });
      expect(transcript.isProgrammaticScroll).toBe(false);
    } finally {
      transcript.hostDisconnected();
      vi.useRealTimers();
    }
  });

  it("remeasures every visible pane transcript while preserving hidden transcript rows", async () => {
    const host = Object.assign(document.body.appendChild(document.createElement("div")), {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    });
    const viewportChanged = vi.fn();
    const main = new ChatTranscriptController(host, { onViewportResize: viewportChanged });
    const detail = new ChatTranscriptController(host);
    // Task tabs may precede main chat in DOM order; neither observer nor
    // scroll commands may rediscover the first thread under the shared host.
    const detailPanel = host.appendChild(document.createElement("div"));
    const mainPanel = host.appendChild(document.createElement("div"));
    const mainProps = threadProps("pane-geometry-main", "agent:main:geometry-main");
    const detailProps = threadProps("pane-geometry-detail", "agent:main:geometry-detail");
    const renderTranscripts = () => {
      render(renderChatThread(mainProps, main), mainPanel);
      render(
        renderReadOnlyTranscript({
          chat: detailProps,
          messages: detailProps.messages,
          paneId: detailProps.paneId,
          sessionKey: detailProps.sessionKey,
          transcript: detail,
        }),
        detailPanel,
      );
      main.hostUpdated();
      detail.hostUpdated();
    };

    renderTranscripts();
    main.hostConnected();
    detail.hostConnected();
    await flushDeferredRowPrune();
    renderTranscripts();

    const mainScroller = expectDefined(
      mainPanel.querySelector<HTMLElement>(".chat-thread"),
      "main transcript scroll element",
    );
    const detailScroller = expectDefined(
      detailPanel.querySelector<HTMLElement>(".chat-thread"),
      "detail transcript scroll element",
    );
    mainScroller.getBoundingClientRect = () => new DOMRect(0, 0, 640, 600);
    detailScroller.getBoundingClientRect = () =>
      detailPanel.hidden ? new DOMRect() : new DOMRect(0, 0, 640, 600);
    expect(main.scrollElement).toBe(mainScroller);
    expect(detail.scrollElement).toBe(detailScroller);
    for (const width of [800, 640]) {
      for (const observer of resizeObservers) {
        observer.emitTarget(detailScroller, width, 600);
      }
    }
    expect(viewportChanged).not.toHaveBeenCalled();
    for (const width of [800, 640]) {
      for (const observer of resizeObservers) {
        observer.emitTarget(mainScroller, width, 600);
      }
    }
    expect(viewportChanged).toHaveBeenCalledOnce();

    transcriptDomState.measuredRowHeight = 180;
    detailPanel.dispatchEvent(new Event(SIDEBAR_GEOMETRY_COMMIT_EVENT, { bubbles: true }));
    renderTranscripts();
    expect(transcriptSize(mainPanel)).toBe(720);
    expect(transcriptSize(detailPanel)).toBe(720);

    detailPanel.hidden = true;
    for (const row of transcriptRows(detailPanel)) {
      Object.defineProperty(row, "offsetHeight", { configurable: true, value: 0 });
    }
    transcriptDomState.measuredRowHeight = 240;
    detailPanel.dispatchEvent(new Event(SIDEBAR_GEOMETRY_COMMIT_EVENT, { bubbles: true }));
    renderTranscripts();

    expect(transcriptSize(mainPanel)).toBe(960);
    expect(transcriptSize(detailPanel)).toBe(720);
    main.hostDisconnected();
    detail.hostDisconnected();
    expect(main.scrollElement).toBeNull();
    expect(detail.scrollElement).toBeNull();
  });

  it.each([
    "wheel",
    "downward wheel",
    "stationary wheel",
    "pointer",
    "latest",
    "automatic follow",
  ] as const)("resolves pending restoration ownership for %s", async (command) => {
    const flushFrames = stubAnimationFrames();
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row:${index}`,
      content: html`<div>row ${index}</div>`,
    }));
    const { container, renderRows, transcript } = await mountTestTranscript(
      `restore-${command}`,
      rows,
    );
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4800 },
    });
    const writes: ScrollToOptions[] = [];
    container.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") {
        writes.push(options);
        container.scrollTop = options.top ?? container.scrollTop;
      }
    };
    const settled = vi.fn();
    transcript.scrollToOffset(420, settled);
    renderRows(rows);
    expect(container.scrollTop).toBe(420);
    if (["wheel", "downward wheel", "stationary wheel", "pointer"].includes(command)) {
      container.dispatchEvent(
        command === "pointer"
          ? new PointerEvent("pointerdown")
          : new WheelEvent("wheel", { deltaY: command === "wheel" ? -100 : 100 }),
      );
      if (command !== "stationary wheel") {
        container.scrollTop = command === "downward wheel" ? 520 : 300;
        container.dispatchEvent(new Event("scroll"));
      }
    } else if (command === "automatic follow") {
      expect(transcript.scrollToEnd({ source: "auto" })).toBe(false);
    } else {
      expect(transcript.scrollToEnd()).toBe(true);
    }
    const expectedOffset = container.scrollTop;
    writes.length = 0;
    for (let frame = 0; frame < 15; frame++) {
      flushFrames();
      renderRows(rows);
    }
    if (command === "automatic follow") {
      expect(settled).toHaveBeenCalledWith({ scrollTop: 420, anchorToEnd: false });
    } else {
      expect(settled).not.toHaveBeenCalled();
      expect(writes.some((write) => write.top === 420)).toBe(false);
    }
    expect(container.scrollTop).toBe(expectedOffset);
    transcript.hostDisconnected();
  });

  it.each([
    { label: "end-pinned", distanceFromEnd: 0, expectedCalls: 1 },
    { label: "scrolled away", distanceFromEnd: 100, expectedCalls: 0 },
  ])(
    "$label transcript preserves its resize anchor",
    async ({ distanceFromEnd, expectedCalls }) => {
      transcriptDomState.measuredRowHeight = 240;
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const messages = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
        timestamp: index + 1,
      }));
      const props = threadProps(
        `pane-height-resize-${distanceFromEnd}`,
        "agent:main:resize",
        messages,
      );
      render(renderChatThread(props, transcript), container);
      transcript.hostConnected();
      transcript.hostUpdated();
      await flushDeferredRowPrune();

      const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
      expect(scrollElement).not.toBeNull();
      const virtualizer = (
        transcript as unknown as {
          sessionVirtualizer: {
            virtualizerController: {
              getVirtualizer: () => {
                scrollOffset: number | null;
                getTotalSize: () => number;
                scrollToEnd: (options?: { behavior?: ScrollBehavior }) => void;
              };
            };
          };
        }
      ).sessionVirtualizer.virtualizerController.getVirtualizer();
      const scrollToEnd = vi.spyOn(virtualizer, "scrollToEnd");
      const emitViewportResize = (height: number) => {
        for (const observer of resizeObservers) {
          if (scrollElement && observer.observes(scrollElement)) {
            observer.emit(800, height);
          }
        }
      };

      emitViewportResize(600);
      scrollToEnd.mockClear();
      expect(virtualizer.getTotalSize()).toBeGreaterThan(700);
      virtualizer.scrollOffset = Math.max(0, virtualizer.getTotalSize() - 600 - distanceFromEnd);
      emitViewportResize(560);

      expect(scrollToEnd).toHaveBeenCalledTimes(expectedCalls);
      if (expectedCalls > 0) {
        expect(scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
      }
      transcript.hostDisconnected();
    },
  );

  it("re-attaches the virtualizer when a foreign host re-stamps the transcript", async () => {
    const transcript = createTestTranscript();
    const props = threadProps("pane-foreign-stamp");
    const chatFace = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), chatFace);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    const chatScroller = chatFace.querySelector<HTMLElement>(".chat-thread");
    expect(chatScroller).not.toBeNull();
    expect(observedElements.has(chatScroller!)).toBe(true);

    // Dashboard face: the pane unmounts the transcript and finishes its update.
    render(nothing, chatFace);
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    // Split restore: the sidebar region — a different Lit host that receives
    // the chat template as a property — stamps the transcript in its own
    // update cycle. The pane does not update again, so attachment must follow
    // the ref-recorded DOM identity rather than the pane's render cycle.
    const dock = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), dock);
    await flushDeferredRowPrune();

    const dockScroller = dock.querySelector<HTMLElement>(".chat-thread");
    expect(dockScroller).not.toBeNull();
    expect(observedElements.has(dockScroller!)).toBe(true);
    expect(transcriptRows(dock).length).toBeGreaterThan(0);
    transcript.hostDisconnected();
  });

  it("keeps rendering rows after a hide-transition zero rect", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index + 1,
    }));
    const props = threadProps("pane-zero-rect", "agent:main:zero-rect", messages);
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    expect(transcriptRows(container).length).toBeGreaterThan(0);

    // A pane cache or face switch hiding the transcript reports a 0x0 rect.
    // It must not become the virtualizer's viewport (an empty range renders a
    // blank transcript) nor count as a width change that wipes measurements.
    for (const observer of resizeObservers) {
      if (observer.observes(scrollElement!)) {
        observer.emit(0, 0);
      }
    }
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();

    expect(transcriptRows(container).length).toBeGreaterThan(0);
    transcript.hostDisconnected();
  });
});
