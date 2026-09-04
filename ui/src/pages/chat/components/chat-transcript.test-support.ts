import { vi } from "vitest";
import { resetChatThreadState } from "../chat-thread.ts";
import { resetThreadPresentation, type ChatThreadProps } from "./chat-thread-interactions.ts";

export const observedElements = new Set<Element>();
export const resizeObservers = new Set<RecordingResizeObserver>();
export const transcriptDomState = { measuredRowHeight: 100, detachedRowHeight: 100 };

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
    const entries = [...this.targets].map((target) => this.entry(target, width, height));
    if (entries.length > 0) {
      this.callback(entries, this);
    }
  }

  emitTarget(target: Element, width: number, height: number): void {
    if (this.targets.has(target)) {
      this.callback([this.entry(target, width, height)], this);
    }
  }

  observes(target: Element): boolean {
    return this.targets.has(target);
  }

  private entry(target: Element, width: number, height: number): ResizeObserverEntry {
    return {
      target,
      borderBoxSize: [{ inlineSize: width, blockSize: height }],
    } as unknown as ResizeObserverEntry;
  }
}

const defaultMessages = [
  { role: "user", content: "message one", timestamp: 1_000 },
  { role: "assistant", content: "reply one", timestamp: 2_000 },
  { role: "user", content: "message two", timestamp: 3_000 },
  { role: "assistant", content: "reply two", timestamp: 4_000 },
];

export function threadProps(
  paneId: string,
  sessionKey = "agent:main:main",
  messages: unknown[] = defaultMessages,
): ChatThreadProps {
  return {
    paneId,
    sessionKey,
    selectedSession: undefined,
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

export function transcriptRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".chat-virtual-row")];
}

export async function flushDeferredRowPrune(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function installTranscriptDomMocks(): void {
  observedElements.clear();
  resizeObservers.clear();
  transcriptDomState.measuredRowHeight = 100;
  transcriptDomState.detachedRowHeight = 100;
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.isConnected
        ? transcriptDomState.measuredRowHeight
        : transcriptDomState.detachedRowHeight;
    },
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
}

export function resetTranscriptTestDom(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetThreadPresentation();
  resetChatThreadState();
  document.body.replaceChildren();
}
