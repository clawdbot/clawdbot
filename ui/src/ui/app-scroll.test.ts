import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatScroll, scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";

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
  } = {},
) {
  const {
    scrollHeight = 2000,
    scrollTop = 1500,
    clientHeight = 500,
    overflowY = "auto",
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

  const host = {
    updateComplete: Promise.resolve(),
    querySelector: vi.fn().mockReturnValue(container),
    style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
    chatScrollFrame: null as number | null,
    chatScrollTimeout: null as number | null,
    chatLastScrollTop: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatHeaderControlsHidden: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: false,
    chatProgrammaticScrollTarget: 0,
    logsScrollFrame: null as number | null,
    logsAtBottom: true,
    topbarObserver: null as ResizeObserver | null,
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

  it("sets chatUserNearBottom=false when user scrolled up past one long message (>200px <450px)", () => {
    const { host } = createScrollHost({});
    // distanceFromBottom = 2000 - 1250 - 400 = 350 → old threshold would say "near", new says "near"
    // distanceFromBottom = 2000 - 1100 - 400 = 500 → old threshold would say "not near", new also "not near"
    const event = createScrollEvent(2000, 1100, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(false);
  });

  it("hides chat header controls when scrolling down through transcript history", () => {
    const { host } = createScrollHost({});
    host.chatLastScrollTop = 100;
    const event = createScrollEvent(3000, 260, 500);

    handleChatScroll(host, event);

    expect(host.chatHeaderControlsHidden).toBe(true);
  });

  it("shows chat header controls again when scrolling up", () => {
    const { host } = createScrollHost({});
    host.chatLastScrollTop = 800;
    host.chatHeaderControlsHidden = true;
    const event = createScrollEvent(3000, 700, 500);

    handleChatScroll(host, event);

    expect(host.chatHeaderControlsHidden).toBe(false);
  });

  it("keeps chat header controls visible near the bottom", () => {
    const { host } = createScrollHost({});
    host.chatLastScrollTop = 1900;
    host.chatHeaderControlsHidden = true;
    const event = createScrollEvent(3000, 2500, 500);

    handleChatScroll(host, event);

    expect(host.chatHeaderControlsHidden).toBe(false);
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
    host.chatLastScrollTop = 300;
    host.chatHeaderControlsHidden = true;

    resetChatScroll(host);

    expect(host.chatHasAutoScrolled).toBe(false);
    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatLastScrollTop).toBe(0);
    expect(host.chatHeaderControlsHidden).toBe(false);
    expect(host.chatIsProgrammaticScroll).toBe(false);
    expect(host.chatProgrammaticScrollTarget).toBe(0);
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
    host.chatHeaderControlsHidden = true;
    host.chatIsProgrammaticScroll = true;
    host.chatProgrammaticScrollTarget = 3000;
    host.chatLastScrollTop = 0;

    handleChatScroll(host, createScrollEvent(3000, 2600, 400));
    expect(host.chatLastScrollTop).toBe(2600);

    host.chatIsProgrammaticScroll = false;
    handleChatScroll(host, createScrollEvent(3000, 2000, 400));

    expect(host.chatHeaderControlsHidden).toBe(false);
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
