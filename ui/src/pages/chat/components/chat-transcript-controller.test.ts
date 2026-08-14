/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderChatThread } from "./chat-thread.ts";
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

    transcriptDomState.measuredRowHeight = 180;
    for (const observer of resizeObservers) {
      if (scrollElement && observer.observes(scrollElement)) {
        observer.emit(640, 600);
      }
    }
    await renderTranscript();

    expect(transcriptRows(container)[1]?.style.transform).toBe("translateY(180px)");
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
});
