import { beforeEach, describe, expect, it, vi } from "vitest";

let page: {
  evaluate: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
} | null = null;

const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const refLocator = vi.fn(() => {
  throw new Error("test: refLocator should not be called");
});
const restoreRoleRefsForTarget = vi.fn(() => {});

const closePageViaPlaywright = vi.fn(async () => {});
const resizeViewportViaPlaywright = vi.fn(async () => {});

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
}));

vi.mock("./pw-tools-core.snapshot.js", () => ({
  closePageViaPlaywright,
  resizeViewportViaPlaywright,
}));

const { batchViaPlaywright } = await import("./pw-tools-core.interactions.js");

describe("batchViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = {
      evaluate: vi.fn(async () => "ok"),
      url: vi.fn(() => "about:blank"),
    };
  });

  it("propagates evaluate timeouts through batched execution", async () => {
    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      evaluateEnabled: true,
      actions: [{ kind: "evaluate", fn: "() => 1", timeoutMs: 5000 }],
    });

    expect(result).toEqual({ results: [{ ok: true }] });
    expect(page?.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        fnBody: "() => 1",
        timeoutMs: 4500,
      }),
    );
  });

  it("supports resize and close inside a batch", async () => {
    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [{ kind: "resize", width: 800, height: 600 }, { kind: "close" }],
    });

    expect(result).toEqual({ results: [{ ok: true }, { ok: true }] });
    expect(resizeViewportViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      width: 800,
      height: 600,
    });
    expect(closePageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });
  });
});
