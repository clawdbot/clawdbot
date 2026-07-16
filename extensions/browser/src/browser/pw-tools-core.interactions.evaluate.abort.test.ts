import { beforeEach, describe, expect, it, vi } from "vitest";

let page: { evaluate: ReturnType<typeof vi.fn>; url: ReturnType<typeof vi.fn> } | null = null;
let locator: { evaluate: ReturnType<typeof vi.fn> } | null = null;

const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const restoreRoleRefsForTarget = vi.fn(() => {});
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});

vi.mock("./pw-session.js", () => {
  return {
    assertPageNavigationCompletedSafely,
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    refLocator,
    restoreRoleRefsForTarget,
  };
});

const { evaluateViaPlaywright } = await import("./pw-tools-core.interactions.js");

function createPendingEval() {
  let evalCalled!: () => void;
  const evalCalledPromise = new Promise<void>((resolve) => {
    evalCalled = resolve;
  });
  return {
    evalCalledPromise,
    resolveEvalCalled: evalCalled,
  };
}

describe("evaluateViaPlaywright (abort)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = null;
    locator = null;
  });

  it.each([
    { label: "page.evaluate", fn: "() => 1" },
    { label: "locator.evaluate", fn: "(el) => el.textContent", ref: "e1" },
  ])("rejects when aborted after $label starts", async ({ fn, ref }) => {
    const ctrl = new AbortController();
    const pending = createPendingEval();
    const pendingPromise = new Promise(() => {});

    page = {
      evaluate: vi.fn(() => {
        if (!ref) {
          pending.resolveEvalCalled();
        }
        return pendingPromise;
      }),
      url: vi.fn(() => "https://example.com/current"),
    };
    locator = {
      evaluate: vi.fn(() => {
        if (ref) {
          pending.resolveEvalCalled();
        }
        return pendingPromise;
      }),
    };

    const p = evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      fn,
      ref,
      signal: ctrl.signal,
    });

    await pending.evalCalledPromise;
    ctrl.abort(new Error("aborted by test"));

    await expect(p).rejects.toThrow("aborted by test");
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalled();
  });
});
