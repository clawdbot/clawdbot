// Browser tests cover pw tools core.interactions.batch plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

let page: {
  evaluate: ReturnType<typeof vi.fn>;
  keyboard: { press: ReturnType<typeof vi.fn> };
  mouse: { click: ReturnType<typeof vi.fn> };
  url: ReturnType<typeof vi.fn>;
} | null = null;
let locator: Record<string, ReturnType<typeof vi.fn>> | null = null;

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
    const navigate = vi.fn(async () => {
      currentUrl = "https://93.184.216.34/target";
    });
    page = {
      evaluate: navigate,
      keyboard: { press: navigate },
      mouse: { click: navigate },
      url: vi.fn(() => currentUrl),
    };
    locator = {
      click: navigate,
      dragTo: navigate,
      fill: navigate,
      hover: navigate,
      press: navigate,
      scrollIntoViewIfNeeded: navigate,
      selectOption: navigate,
      setChecked: navigate,
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
