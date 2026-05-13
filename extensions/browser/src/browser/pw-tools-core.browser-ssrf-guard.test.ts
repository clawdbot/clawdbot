import { beforeEach, describe, expect, it, vi } from "vitest";

const pageState = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  locator: null as Record<string, unknown> | null,
}));

const sessionMocks = vi.hoisted(() => ({
  assertPageNavigationCompletedSafely: vi.fn(async () => {}),
  closeBlockedNavigationTarget: vi.fn(async () => {}),
  ensurePageState: vi.fn(() => ({})),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => {
    if (!pageState.page) {
      throw new Error("missing page");
    }
    return pageState.page;
  }),
  gotoPageWithNavigationGuard: vi.fn(async () => null),
  isPolicyDenyNavigationError: vi.fn(() => false),
  refLocator: vi.fn(() => {
    if (!pageState.locator) {
      throw new Error("missing locator");
    }
    return pageState.locator;
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  storeRoleRefsForTarget: vi.fn(() => {}),
}));

const pageCdpMocks = vi.hoisted(() => ({
  markBackendDomRefsOnPage: vi.fn(async () => new Set<string>()),
  withPageScopedCdpClient: vi.fn(
    async ({ fn }: { fn: (send: () => Promise<unknown>) => unknown }) =>
      await fn(async () => ({ nodes: [] })),
  ),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./pw-session.page-cdp.js", () => pageCdpMocks);

const interactions = await import("./pw-tools-core.interactions.js");
const snapshots = await import("./pw-tools-core.snapshot.js");

describe("pw-tools-core browser SSRF guards", () => {
  beforeEach(() => {
    pageState.page = null;
    pageState.locator = null;
    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(pageCdpMocks)) {
      fn.mockClear();
    }
  });

  it("re-checks click-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://example.com";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      click: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("re-checks select-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://example.com";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      selectOption: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.selectOptionViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      values: ["go"],
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("re-checks form fill-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://example.com";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      fill: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.fillFormViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      fields: [{ ref: "1", type: "text", value: "go" }],
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("re-checks the current page before evaluating page content", async () => {
    const evaluate = vi.fn(async () => "ok");
    pageState.page = {
      evaluate,
      url: vi.fn(() => "https://example.com"),
    };

    await interactions.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      fn: "() => document.body.innerText",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
    expect(
      sessionMocks.assertPageNavigationCompletedSafely.mock.invocationCallOrder[0],
    ).toBeLessThan(evaluate.mock.invocationCallOrder[0]);
  });

  it("preserves helper compatibility when no ssrfPolicy is provided", async () => {
    pageState.page = { url: vi.fn(() => "https://example.com") };
    pageState.locator = { click: vi.fn(async () => {}) };

    await interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      // no ssrfPolicy: direct helper callers keep previous compatibility semantics
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
  });

  it("re-checks batched click-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://example.com";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      click: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      actions: [{ kind: "click", ref: "1" }],
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("re-checks current page URL before snapshotting AI content", async () => {
    const ariaSnapshot = vi.fn(async () => 'button "Save"');
    pageState.page = {
      ariaSnapshot,
      url: vi.fn(() => "https://example.com"),
    };

    await snapshots.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
    expect(
      sessionMocks.assertPageNavigationCompletedSafely.mock.invocationCallOrder[0],
    ).toBeLessThan(ariaSnapshot.mock.invocationCallOrder[0]);
  });

  it("re-checks current page URL before role snapshots", async () => {
    const ariaSnapshot = vi.fn(async () => "");
    pageState.page = {
      locator: vi.fn(() => ({ ariaSnapshot })),
      url: vi.fn(() => "https://example.com"),
    };

    await snapshots.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
    expect(
      sessionMocks.assertPageNavigationCompletedSafely.mock.invocationCallOrder[0],
    ).toBeLessThan(ariaSnapshot.mock.invocationCallOrder[0]);
  });

  it("re-checks current page URL before aria snapshots", async () => {
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
    };

    await snapshots.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
    expect(
      sessionMocks.assertPageNavigationCompletedSafely.mock.invocationCallOrder[0],
    ).toBeLessThan(pageCdpMocks.withPageScopedCdpClient.mock.invocationCallOrder[0]);
  });
});
