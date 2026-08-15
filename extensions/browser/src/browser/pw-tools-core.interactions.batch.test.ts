// Browser tests cover pw tools core.interactions.batch plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

let page: {
  evaluate: ReturnType<typeof vi.fn>;
  keyboard: { press: ReturnType<typeof vi.fn> };
  isClosed: ReturnType<typeof vi.fn>;
  mainFrame: ReturnType<typeof vi.fn>;
  mouse: { click: ReturnType<typeof vi.fn> };
  off: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
} | null = null;
let locator: Record<string, ReturnType<typeof vi.fn>> | null = null;
let setPageClosed: (closed: boolean) => void = () => {};
let setPageUrl: (url: string) => void = () => {};

const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const isBrowserObservedDialogBlockedError = vi.fn(() => false);
const isPolicyDenyNavigationError = vi.fn(() => false);
const markObservedDialogsHandledRemotelyForPage = vi.fn(() => ({}));
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});
const restoreRoleRefsForTarget = vi.fn(() => {});
const wasBrowserNavigationSourcePreservedAfterPolicyDenial = vi.fn(() => false);
const withPageNavigationRequestGuard = vi.fn(
  async ({
    action,
    page: actionPage,
  }: {
    action: (url: string) => Promise<unknown>;
    page: { url: () => string };
  }) => await action(actionPage.url()),
);

const closePageViaPlaywright = vi.fn(async () => {});
const resizeViewportViaPlaywright = vi.fn(async () => {});

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
  markObservedDialogsHandledRemotelyForPage,
  refLocator,
  restoreRoleRefsForTarget,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
}));

vi.mock("./pw-tools-core.snapshot.js", () => ({
  closePageViaPlaywright,
  resizeViewportViaPlaywright,
}));

const { batchViaPlaywright } = await import("./pw-tools-core.interactions.js");

function firstEvaluateCall(): [unknown, { fnSource?: string; timeoutMs?: number }] {
  if (!page) {
    throw new Error("expected test page");
  }
  const [call] = page.evaluate.mock.calls;
  if (!call) {
    throw new Error("expected page.evaluate call");
  }
  return call as [unknown, { fnSource?: string; timeoutMs?: number }];
}

describe("batchViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let currentUrl = "https://example.com";
    let closed = false;
    setPageClosed = (next) => {
      closed = next;
    };
    const frameNavigatedHandlers = new Set<(frame: unknown) => void>();
    const mainFrame = { url: () => currentUrl };
    setPageUrl = (next) => {
      currentUrl = next;
      for (const handler of frameNavigatedHandlers) {
        handler(mainFrame);
      }
    };
    page = {
      evaluate: vi.fn(async () => {}),
      isClosed: vi.fn(() => closed),
      keyboard: { press: vi.fn(async () => {}) },
      mainFrame: vi.fn(() => mainFrame),
      mouse: { click: vi.fn(async () => {}) },
      off: vi.fn((event: string, handler: (frame: unknown) => void) => {
        if (event === "framenavigated") {
          frameNavigatedHandlers.delete(handler);
        }
      }),
      on: vi.fn((event: string, handler: (frame: unknown) => void) => {
        if (event === "framenavigated") {
          frameNavigatedHandlers.add(handler);
        }
      }),
      url: vi.fn(() => currentUrl),
    };
    locator = {
      click: vi.fn(async () => {}),
      dragTo: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      selectOption: vi.fn(async () => {}),
      setChecked: vi.fn(async () => {}),
    };
    closePageViaPlaywright.mockImplementation(async () => setPageClosed(true));
  });

  it("aborts remaining actions after a navigation", async () => {
    locator!.click!.mockImplementationOnce(() => {
      setPageUrl("https://example.com/next");
    });

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
        { kind: "press", key: "Enter" },
      ],
    });

    expect(result).toEqual({
      results: [{ ok: true, navigated: true, url: "https://example.com/next" }],
      aborted: {
        reason: "navigation",
        afterAction: 1,
        url: "https://example.com/next",
        skipped: 2,
      },
    });
    expect(locator!.hover).not.toHaveBeenCalled();
    expect(page!.keyboard.press).not.toHaveBeenCalled();
  });

  it("aborts remaining actions after a same-URL reload", async () => {
    locator!.click!.mockImplementationOnce(() => {
      setPageUrl("https://example.com");
    });

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
      ],
    });

    expect(result).toEqual({
      results: [{ ok: true, navigated: true, url: "https://example.com" }],
      aborted: {
        reason: "navigation",
        afterAction: 1,
        url: "https://example.com",
        skipped: 1,
      },
    });
    expect(locator!.hover).not.toHaveBeenCalled();
    expect(page!.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
  });

  it("aborts when a navigation commits after an action settles but before the next dispatch", async () => {
    let closedChecks = 0;
    page!.isClosed.mockImplementation(() => {
      closedChecks += 1;
      if (closedChecks === 2) {
        setPageUrl("https://example.com/late");
      }
      return false;
    });

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
      ],
    });

    expect(result).toEqual({
      results: [{ ok: true, navigated: true, url: "https://example.com/late" }],
      aborted: {
        reason: "navigation",
        afterAction: 1,
        url: "https://example.com/late",
        skipped: 1,
      },
    });
    expect(locator!.hover).not.toHaveBeenCalled();
  });

  it("runs every action when the page URL stays unchanged", async () => {
    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
        { kind: "press", key: "Enter" },
      ],
    });

    expect(result).toEqual({ results: [{ ok: true }, { ok: true }, { ok: true }] });
  });

  it("keeps stopOnError=false until a later navigation aborts the batch", async () => {
    locator!.click!.mockRejectedValueOnce(new Error("click failed"));
    locator!.hover!.mockImplementationOnce(() => {
      setPageUrl("https://example.com/next");
    });

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      stopOnError: false,
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
        { kind: "press", key: "Enter" },
      ],
    });

    expect(result).toEqual({
      results: [
        { ok: false, error: "click failed" },
        { ok: true, navigated: true, url: "https://example.com/next" },
      ],
      aborted: {
        reason: "navigation",
        afterAction: 2,
        url: "https://example.com/next",
        skipped: 1,
      },
    });
    expect(page!.keyboard.press).not.toHaveBeenCalled();
  });

  it("aborts when the page closes during an action", async () => {
    locator!.click!.mockImplementationOnce(() => setPageClosed(true));

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      stopOnError: false,
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
      ],
    });

    expect(result).toEqual({
      results: [{ ok: true }],
      aborted: {
        reason: "closed",
        afterAction: 1,
        url: "https://example.com",
        skipped: 1,
      },
    });
    expect(locator!.hover).not.toHaveBeenCalled();
  });

  it("propagates evaluate timeouts through batched execution", async () => {
    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      evaluateEnabled: true,
      actions: [{ kind: "evaluate", fn: "() => 1", timeoutMs: 5000 }],
    });

    expect(result).toEqual({ results: [{ ok: true }] });
    const [evaluateFn, evaluateOptions] = firstEvaluateCall();
    expect(typeof evaluateFn).toBe("function");
    expect(evaluateOptions?.fnSource).toBe("() => 1");
    expect(evaluateOptions?.timeoutMs).toBe(4500);
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

  it.each([
    { name: "hover", action: { kind: "hover", ref: "1" } as const },
    { name: "scrollIntoView", action: { kind: "scrollIntoView", ref: "1" } as const },
    {
      name: "drag",
      action: { kind: "drag", startRef: "1", endRef: "2" } as const,
    },
  ])("forwards navigation policy to batched $name actions", async ({ action }) => {
    const ssrfPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [action],
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });

    expect(result).toEqual({ results: [{ ok: true }] });
    expect(withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });
  });

  it.each([
    { name: "click", action: { kind: "click", ref: "1" } as const },
    { name: "clickCoords", action: { kind: "clickCoords", x: 10, y: 20 } as const },
    { name: "type", action: { kind: "type", ref: "1", text: "value" } as const },
    { name: "press", action: { kind: "press", key: "Enter" } as const },
    {
      name: "select",
      action: { kind: "select" as const, ref: "1", values: ["one"] },
    },
    {
      name: "fill",
      action: {
        kind: "fill" as const,
        fields: [{ ref: "1", type: "text", value: "value" }],
      },
    },
    { name: "evaluate", action: { kind: "evaluate", fn: "() => true" } as const },
  ])("guards batched $name document requests with the proxy policy", async ({ action }) => {
    const ssrfPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [action],
      evaluateEnabled: true,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });

    expect(result).toEqual({ results: [{ ok: true }] });
    expect(withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });
    expect(assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      page,
      response: null,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
      targetId: "tab-1",
    });
  });

  it("preserves proxy policy through nested batches", async () => {
    const ssrfPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [
        {
          kind: "batch",
          actions: [{ kind: "click", ref: "1" }],
        },
      ],
      evaluateEnabled: true,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });

    expect(result).toEqual({ results: [{ ok: true }] });
    expect(withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });
  });
});
