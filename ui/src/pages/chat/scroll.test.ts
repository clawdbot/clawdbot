// Control UI tests cover app scroll behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAutoScrollMode } from "../../app/settings.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import {
  cancelChatScroll,
  handleChatScroll,
  resetChatScroll,
  scheduleChatScroll,
} from "./scroll.ts";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Minimal ScrollHost stub for unit tests. */
function createScrollHost(
  overrides: {
    scrollHeight?: number;
    scrollTop?: number;
    clientHeight?: number;
    overflowY?: string;
    chatAutoScroll?: ChatAutoScrollMode;
  } = {},
) {
  const {
    scrollHeight = 2000,
    scrollTop = 1500,
    clientHeight = 500,
    overflowY = "auto",
    chatAutoScroll,
  } = overrides;

  const container = {
    scrollHeight,
    scrollTop,
    clientHeight,
    style: { overflowY } as unknown as CSSStyleDeclaration,
  };

  // Make getComputedStyle return the overflowY value
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    overflowY,
  } as unknown as CSSStyleDeclaration);

  const settings: { chatAutoScroll?: ChatAutoScrollMode } = {};
  if (chatAutoScroll) {
    settings.chatAutoScroll = chatAutoScroll;
  }

  const renderLifecycle: RenderLifecycle = {
    invalidate: vi.fn(),
    afterCommit: vi.fn((effect) => {
      renderLifecycle.invalidate();
      effect(() => undefined);
      return vi.fn();
    }),
  };
  const host = {
    renderLifecycle,
    updateComplete: Promise.resolve(),
    querySelector: vi.fn().mockReturnValue(container),
    style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
    chatScrollCommitCleanup: null as (() => void) | null,
    chatScrollFrame: null as number | null,
    chatScrollGuardFrame: null as number | null,
    chatScrollTimeout: null as number | null,
    chatScrollGeneration: 0,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: false,
    chatProgrammaticScrollTarget: 0,
    settings,
  };

  return { host, container };
}

function createScrollEvent(scrollHeight: number, scrollTop: number, clientHeight: number) {
  return {
    currentTarget: { scrollHeight, scrollTop, clientHeight },
  } as unknown as Event;
}

/* ------------------------------------------------------------------ */
/*  handleChatScroll – threshold tests                                 */
/* ------------------------------------------------------------------ */

describe("handleChatScroll", () => {
  it("sets chatUserNearBottom=true when within the 450px threshold", () => {
    const { host } = createScrollHost({});
    // distanceFromBottom = 2000 - 1600 - 400 = 0 → clearly near bottom
    const event = createScrollEvent(2000, 1600, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(true);
  });

  it("sets chatUserNearBottom=true when distance is just under threshold", () => {
    const { host } = createScrollHost({});
    // distanceFromBottom = 2000 - 1151 - 400 = 449 → just under threshold
    const event = createScrollEvent(2000, 1151, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(true);
  });

  it("sets chatUserNearBottom=false when distance is exactly at threshold", () => {
    const { host } = createScrollHost({});
    // distanceFromBottom = 2000 - 1150 - 400 = 450 → at threshold (uses strict <)
    const event = createScrollEvent(2000, 1150, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(false);
  });

  it("sets chatUserNearBottom=false when scrolled well above threshold", () => {
    const { host } = createScrollHost({});
    // distanceFromBottom = 2000 - 500 - 400 = 1100 → way above threshold
    const event = createScrollEvent(2000, 500, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(false);
  });

  it("sets chatUserNearBottom=false when scrolled past the near-bottom threshold", () => {
    const { host } = createScrollHost({});
    // distanceFromBottom = 2000 - 1100 - 400 = 500 → beyond threshold
    const event = createScrollEvent(2000, 1100, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(false);
  });

  it("publishes the indicator transition when the user returns to bottom", () => {
    const { host } = createScrollHost({});
    host.chatNewMessagesBelow = true;
    const invalidate = vi.fn();
    host.renderLifecycle.invalidate = invalidate;

    handleChatScroll(host, createScrollEvent(2000, 1600, 400));

    expect(host.chatNewMessagesBelow).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */
/*  scheduleChatScroll – respects user scroll position                 */
/* ------------------------------------------------------------------ */

describe("scheduleChatScroll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not read layout until the requested render commits", () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    let commit: (() => void) | undefined;
    host.renderLifecycle.afterCommit = vi.fn((effect) => {
      host.renderLifecycle.invalidate();
      commit = () => effect(() => undefined);
      return vi.fn();
    });

    scheduleChatScroll(host);

    expect(host.querySelector).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(1600);
    commit?.();
    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it("cancels a pending commit before it can touch detached DOM", () => {
    const { host } = createScrollHost({});
    let commit: (() => void) | undefined;
    const cancelCommit = vi.fn();
    host.renderLifecycle.afterCommit = vi.fn((effect) => {
      commit = () => effect(() => undefined);
      return cancelCommit;
    });

    scheduleChatScroll(host);
    cancelChatScroll(host);
    commit?.();

    expect(cancelCommit).toHaveBeenCalledOnce();
    expect(host.querySelector).not.toHaveBeenCalled();
  });

  it("scrolls to bottom when user is near bottom (no force)", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    // distanceFromBottom = 2000 - 1600 - 400 = 0 → near bottom
    host.chatUserNearBottom = true;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it("does NOT scroll when user is scrolled up and no force", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    // distanceFromBottom = 2000 - 500 - 400 = 1100 → not near bottom
    host.chatUserNearBottom = false;
    const originalScrollTop = container.scrollTop;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(originalScrollTop);
  });

  it("does NOT scroll with force=true when user has explicitly scrolled up", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    // User has scrolled up — chatUserNearBottom is false
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true; // Already past initial load
    const originalScrollTop = container.scrollTop;

    scheduleChatScroll(host, true);
    await host.updateComplete;

    // force=true should still NOT override explicit user scroll-up after initial load
    expect(container.scrollTop).toBe(originalScrollTop);
  });

  it("DOES scroll with force=true on initial load (chatHasAutoScrolled=false)", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = false; // Initial load

    scheduleChatScroll(host, true);
    await host.updateComplete;

    // On initial load, force should work regardless
    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it("uses force=true on initial load even after a previous follow lock", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatHasAutoScrolled = false;

    scheduleChatScroll(host, true);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
    expect(host.chatFollowLocked).toBe(false);
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("sets chatNewMessagesBelow when not scrolling due to user position", async () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    host.chatNewMessagesBelow = false;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("does not show new messages for a resize when the thread height did not grow", async () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    host.chatLastScrollHeight = 2000;

    scheduleChatScroll(host, false, false, { source: "resize" });
    await host.updateComplete;

    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("shows new messages for content changes that do not increase thread height", async () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    host.chatLastScrollHeight = 2000;

    scheduleChatScroll(host, false, false, { contentChanged: true });
    await host.updateComplete;

    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("does not re-stick streaming after a user scrolls slightly up near the bottom", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1540,
      clientHeight: 400,
    });
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = true;
    host.chatProgrammaticScrollTarget = 1800;
    host.chatLastScrollTop = 1600;

    handleChatScroll(host, createScrollEvent(2000, 1540, 400));

    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatUserNearBottom).toBe(false);

    container.scrollHeight = 2050;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(1540);
    expect(host.chatNewMessagesBelow).toBe(true);

    host.chatIsProgrammaticScroll = false;
    container.scrollTop = 1600;
    handleChatScroll(host, createScrollEvent(2000, 1600, 400));

    expect(host.chatFollowLocked).toBe(false);
    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("does not re-stick streaming after a small user scroll-up near the bottom", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1589,
      clientHeight: 400,
    });
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = true;
    host.chatProgrammaticScrollTarget = 1800;
    host.chatLastScrollTop = 1600;

    handleChatScroll(host, createScrollEvent(2000, 1589, 400));

    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatUserNearBottom).toBe(false);

    container.scrollHeight = 2050;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(1589);
    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("does NOT scroll automatically when chat auto-scroll is off", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
      chatAutoScroll: "off",
    });
    host.chatUserNearBottom = true;
    const originalScrollTop = container.scrollTop;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(originalScrollTop);
    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("scrolls from the manual scroll-to-bottom action when chat auto-scroll is off", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
      chatAutoScroll: "off",
    });
    host.chatUserNearBottom = false;

    scheduleChatScroll(host, true, false, { source: "manual" });
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("scrolls even when user is scrolled up when chat auto-scroll is always", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
      chatAutoScroll: "always",
    });
    host.chatUserNearBottom = false;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
  });
});

/* ------------------------------------------------------------------ */
/*  Streaming: rapid chatStream changes should not reset scroll        */
/* ------------------------------------------------------------------ */

describe("streaming scroll behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("multiple rapid scheduleChatScroll calls do not scroll when user is scrolled up", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    const originalScrollTop = container.scrollTop;

    // Simulate rapid streaming token updates
    scheduleChatScroll(host);
    scheduleChatScroll(host);
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(originalScrollTop);
  });

  it("streaming scrolls correctly when user IS at bottom", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatHasAutoScrolled = true;

    // Simulate streaming
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
  });
});

/* ------------------------------------------------------------------ */
/*  resetChatScroll                                                    */
/* ------------------------------------------------------------------ */

describe("resetChatScroll", () => {
  it("resets state for new chat session", () => {
    const { host } = createScrollHost({});
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatLastScrollTop = 300;

    resetChatScroll(host);

    expect(host.chatHasAutoScrolled).toBe(false);
    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
    expect(host.chatLastScrollTop).toBe(0);
    expect(host.chatIsProgrammaticScroll).toBe(false);
    expect(host.chatProgrammaticScrollTarget).toBe(0);
  });

  it("cancels frame id zero and the late-size retry", () => {
    const { host } = createScrollHost({});
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const clearTimer = vi.spyOn(window, "clearTimeout");
    host.chatScrollFrame = 0;
    host.chatScrollGuardFrame = 7;
    host.chatScrollTimeout = 9;

    cancelChatScroll(host);

    expect(cancelFrame).toHaveBeenCalledWith(0);
    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(clearTimer).toHaveBeenCalledWith(9);
    expect(host.chatScrollFrame).toBeNull();
    expect(host.chatScrollGuardFrame).toBeNull();
    expect(host.chatScrollTimeout).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Programmatic scroll guard                                          */
/* ------------------------------------------------------------------ */

describe("programmatic scroll guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("handleChatScroll suppresses own scroll event when scrollTop is at the programmatic target", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = true;
    // Simulates scrollTo(scrollHeight=1000): expected scrollTop = 1000 - 400 = 600.
    host.chatProgrammaticScrollTarget = 1000;

    // Our own scroll event: scrollTop is at the clamped target position.
    const event = createScrollEvent(1000, 600, 400);
    handleChatScroll(host, event);

    // Must remain true — our scroll-to-bottom event must not flip near-bottom state.
    expect(host.chatUserNearBottom).toBe(true);
  });

  it("handleChatScroll processes user scroll-up that arrives during the guard window", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = true;
    // We had targeted the bottom of a 3000px page.
    host.chatProgrammaticScrollTarget = 3000;

    // User scrolled up to 500 during the guard window — far below the target (2600).
    const event = createScrollEvent(3000, 500, 400); // distanceFromBottom = 2100 > 450
    handleChatScroll(host, event);

    // Must flip to false — user intentionally scrolled up, streaming must not re-pin them.
    expect(host.chatUserNearBottom).toBe(false);
  });

  it("scheduleChatScroll sets chatIsProgrammaticScroll before scrolling and clears it after rAF", async () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatHasAutoScrolled = true;

    scheduleChatScroll(host);
    await host.updateComplete;

    // After rAF cleanup the flag must be cleared.
    expect(host.chatIsProgrammaticScroll).toBe(false);
    // Target was set to container scrollHeight before scrollTo.
    expect(host.chatProgrammaticScrollTarget).toBe(2000);
    // And scroll must have happened.
    expect(host.chatUserNearBottom).toBe(true);
  });

  it("after programmatic scroll is done, a real user scroll-up correctly flips chatUserNearBottom to false", async () => {
    const { host } = createScrollHost({
      scrollHeight: 3000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    // Flag already cleared — simulates the state after the rAF cleanup ran.
    host.chatIsProgrammaticScroll = false;

    // User genuinely scrolled far from bottom — must be respected.
    const event = createScrollEvent(3000, 500, 400); // distanceFromBottom = 2100 > 450
    handleChatScroll(host, event);

    expect(host.chatUserNearBottom).toBe(false);
  });

  it("guard boundary: scrollTop exactly one pixel below threshold is NOT suppressed (user scroll-up passes through)", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = true;
    // Programmatic target = 1000, clientHeight = 400 → threshold = 600.
    // scrollTop = 599 → 599 >= 600 is false → guard does NOT suppress the event.
    host.chatProgrammaticScrollTarget = 1000;

    const event = createScrollEvent(1000, 599, 400); // distanceFromBottom = 1
    handleChatScroll(host, event);

    // Event was processed: user is near bottom (dist=1 < 450) but the guard did not block it.
    expect(host.chatUserNearBottom).toBe(true);
    // chatLastScrollTop must have been updated — confirms the event was not short-circuited.
    expect(host.chatLastScrollTop).toBe(599);
  });

  it("guard boundary: scrollTop exactly at threshold is suppressed", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = true;
    host.chatProgrammaticScrollTarget = 1000;
    host.chatLastScrollTop = 0;

    // scrollTop = 600 → 600 >= 600 is true → guard suppresses the event.
    const event = createScrollEvent(1000, 600, 400);
    handleChatScroll(host, event);

    // Scroll bookkeeping still advances so the next user scroll has the right direction.
    expect(host.chatLastScrollTop).toBe(600);
  });

  it("suppressed programmatic scroll event does not mutate chatNewMessagesBelow", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatNewMessagesBelow = false;
    host.chatIsProgrammaticScroll = true;
    host.chatProgrammaticScrollTarget = 2000;

    // Our own scroll event at the programmatic target position.
    const event = createScrollEvent(2000, 1600, 400);
    handleChatScroll(host, event);

    // Event was suppressed — chatNewMessagesBelow must stay unchanged.
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("suppressed programmatic scroll preserves direction bookkeeping for the next user scroll-up", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = true;
    host.chatProgrammaticScrollTarget = 3000;
    host.chatLastScrollTop = 0;

    handleChatScroll(host, createScrollEvent(3000, 2600, 400));
    expect(host.chatLastScrollTop).toBe(2600);

    host.chatIsProgrammaticScroll = false;
    handleChatScroll(host, createScrollEvent(3000, 2000, 400));

    expect(host.chatUserNearBottom).toBe(false);
  });

  it("retry timeout sets and clears chatIsProgrammaticScroll", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatHasAutoScrolled = true;

    scheduleChatScroll(host);
    await host.updateComplete;

    // After the initial rAF the flag must already be cleared.
    expect(host.chatIsProgrammaticScroll).toBe(false);

    // Advance past the retry delay (120ms) — retry scrollTop assignment fires.
    vi.advanceTimersByTime(150);

    // After the retry's synchronous scrollTop assignment, the flag is set true.
    // A subsequent rAF clears it — but our mock runs rAF synchronously.
    expect(host.chatIsProgrammaticScroll).toBe(false);
    // Retry must have updated the programmatic target and scrolled.
    expect(host.chatProgrammaticScrollTarget).toBe(container.scrollHeight);
  });
});
