import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleChatSelectionPointerUp, removeChatSelectionPopup } from "./chat-selection-popup.ts";

// jsdom Ranges have no layout (and no getBoundingClientRect at all); stub the
// rect the popup positions against and remove the stub afterwards.
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({ top: 100, left: 100, bottom: 120, right: 200, width: 100, height: 20 }) as DOMRect,
  });
});
afterAll(() => {
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

function buildThreadWithBubble(text: string) {
  const thread = document.createElement("div");
  thread.className = "chat-thread";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text;
  bubble.appendChild(body);
  thread.appendChild(bubble);
  document.body.appendChild(thread);
  return { thread, textNode: body.firstChild as Text };
}

function selectRange(node: Text, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function pointerUp(thread: HTMLElement) {
  handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
    onAskSideChat: onAskSideChatSpy,
  });
  vi.runAllTimers();
}

const onAskSideChatSpy = vi.fn();

describe("chat selection popup", () => {
  afterEach(() => {
    removeChatSelectionPopup();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    onAskSideChatSpy.mockReset();
    vi.useRealTimers();
  });

  it("shows one text-only side-chat action over bubble selections", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("Let's Encrypt cert is valid");
    selectRange(textNode, 0, 18);
    pointerUp(thread);

    const popup = document.body.querySelector(".chat-selection-popup");
    expect(popup).not.toBeNull();
    expect(popup?.getAttribute("aria-label")).toBe("Selection actions");
    const buttons = [...(popup?.querySelectorAll("button") ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual(["Ask in side chat"]);
    expect(buttons[0]?.querySelector("svg")).toBeNull();

    buttons[0]?.click();
    expect(onAskSideChatSpy).toHaveBeenCalledWith("Let's Encrypt cert");
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });

  it("ignores selections outside chat bubbles and collapsed selections", () => {
    vi.useFakeTimers();
    const { thread } = buildThreadWithBubble("bubble text");
    const outside = document.createElement("p");
    outside.textContent = "outside text";
    document.body.appendChild(outside);
    selectRange(outside.firstChild as Text, 0, 7);
    pointerUp(thread);
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();

    window.getSelection()?.removeAllRanges();
    pointerUp(thread);
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });

  it("does not restore the popup after its owner tears down", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("tear down before the selection settles");
    selectRange(textNode, 0, 9);
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      onAskSideChat: onAskSideChatSpy,
    });

    removeChatSelectionPopup();
    vi.runAllTimers();

    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });

  it("keeps only the latest pending selection popup", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("replacement selection");
    const firstAskSideChat = vi.fn();
    const secondAskSideChat = vi.fn();
    selectRange(textNode, 0, 11);
    const pendingTimerCount = vi.getTimerCount();
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      onAskSideChat: firstAskSideChat,
    });
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      onAskSideChat: secondAskSideChat,
    });

    expect(vi.getTimerCount()).toBe(pendingTimerCount + 1);
    vi.advanceTimersToNextTimer();
    (document.body.querySelector(".chat-selection-popup button") as HTMLButtonElement).click();

    expect(firstAskSideChat).not.toHaveBeenCalled();
    expect(secondAskSideChat).toHaveBeenCalledWith("replacement");
  });

  it("dismisses when the selection collapses", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("dismiss me later");
    selectRange(textNode, 0, 7);
    pointerUp(thread);
    expect(document.body.querySelector(".chat-selection-popup")).not.toBeNull();

    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });
});
