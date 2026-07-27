/* @vitest-environment jsdom */

// Regression: re-stamping the transcript into a new container (the
// chat<->dashboard face switch) must keep every rendered row observed for
// size changes. A synchronous measureElement(null) prune during the commit
// unobserved just-registered sibling rows, freezing their heights at the old
// pane width and overlapping the bubbles in the dashboard chat dock.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatThreadState } from "../chat-thread.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderChatThread, resetChatThreadPresentationState } from "./chat-thread.ts";

const observedElements = new Set<Element>();

class RecordingResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();
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
  }
}

function threadProps(paneId: string) {
  return {
    paneId,
    sessionKey: "agent:main:main",
    loading: false,
    messages: [
      { role: "user", content: "message one", timestamp: 1_000 },
      { role: "assistant", content: "reply one", timestamp: 2_000 },
      { role: "user", content: "message two", timestamp: 3_000 },
      { role: "assistant", content: "reply two", timestamp: 4_000 },
    ],
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
});
