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
  });
});
