// Browser tests cover pw tools core ssrf guard plugin behavior.
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
  isBrowserObservedDialogBlockedError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn((_err: unknown) => false),
  markObservedDialogsHandledRemotelyForPage: vi.fn(() => ({})),
  quarantineBlockedNavigationTarget: vi.fn(async () => {}),
  refLocator: vi.fn(() => {
    if (!pageState.locator) {
      throw new Error("missing locator");
    }
    return pageState.locator;
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  storeRoleRefsForTarget: vi.fn(() => {}),
  wasBrowserNavigationSourcePreservedAfterPolicyDenial: vi.fn((_err: unknown) => false),
  withPageNavigationRequestGuard: vi.fn(
    async ({
      action,
      page,
    }: {
      action: (url: string) => Promise<unknown>;
      page: { url: () => string };
    }) => await action(page.url()),
  ),
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

  it.each([
    {
      name: "hover",
      method: "hover",
      run: async () =>
        await interactions.hoverViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "drag",
      method: "dragTo",
      run: async () =>
        await interactions.dragViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          startRef: "1",
          endRef: "2",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "scrollIntoView",
      method: "scrollIntoViewIfNeeded",
      run: async () =>
        await interactions.scrollIntoViewViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
  ])(
    "guards $name document requests and runs the canonical post-check",
    async ({ method, run }) => {
      let currentUrl = "https://example.com";
      pageState.page = { url: vi.fn(() => currentUrl) };
      pageState.locator = {
        [method]: vi.fn(async () => {
          currentUrl = "https://93.184.216.34/target";
        }),
      };

      await run();

      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith({
        action: expect.any(Function),
        onPolicyCheckStarted: expect.any(Function),
        onPolicyDenied: expect.any(Function),
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
        browserProxyMode: "explicit-browser-proxy",
      });
      expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page: pageState.page,
        response: null,
        ssrfPolicy: { allowPrivateNetwork: false },
        browserProxyMode: "explicit-browser-proxy",
        targetId: "tab-1",
      });
    },
  );

  it.each([
    {
      name: "click",
      run: async () =>
        await interactions.clickViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "clickCoords",
      run: async () =>
        await interactions.clickCoordsViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          x: 10,
          y: 20,
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "type",
      run: async () =>
        await interactions.typeViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          text: "value",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "type-submit",
      run: async () =>
        await interactions.typeViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          text: "value",
          submit: true,
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "press",
      run: async () =>
        await interactions.pressKeyViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          key: "Enter",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "select",
      run: async () =>
        await interactions.selectOptionViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          values: ["one"],
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "fill",
      run: async () =>
        await interactions.fillFormViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          fields: [{ ref: "1", type: "text", value: "value" }],
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "evaluate",
      run: async () =>
        await interactions.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          fn: "() => true",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
    {
      name: "evaluate-ref",
      run: async () =>
        await interactions.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          fn: "(el) => Boolean(el)",
          ssrfPolicy: { allowPrivateNetwork: false },
          browserProxyMode: "explicit-browser-proxy",
        }),
    },
  ])("guards $name document requests and preserves proxy policy", async ({ run }) => {
    let currentUrl = "https://example.com";
    const navigate = vi.fn(async () => {
      currentUrl = "https://93.184.216.34/target";
    });
    pageState.page = {
      url: vi.fn(() => currentUrl),
      mouse: { click: navigate },
      keyboard: { press: navigate },
      evaluate: navigate,
      waitForFunction: navigate,
    };
    pageState.locator = {
      click: navigate,
      fill: navigate,
      press: navigate,
      selectOption: navigate,
      setChecked: navigate,
      evaluate: navigate,
    };

    await run();

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page: pageState.page,
      ssrfPolicy: { allowPrivateNetwork: false },
      browserProxyMode: "explicit-browser-proxy",
    });
    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      browserProxyMode: "explicit-browser-proxy",
      targetId: "tab-1",
    });
  });

  it("keeps wait operations outside the action-owned request guard", async () => {
    const waitForFunction = vi.fn(async () => {});
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      waitForFunction,
    };

    await interactions.waitForViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      fn: "() => true",
    });

    expect(waitForFunction).toHaveBeenCalledWith("() => true", { timeout: expect.any(Number) });
    expect(sessionMocks.withPageNavigationRequestGuard).not.toHaveBeenCalled();
  });

  it("keeps the request guard alive until an aborted hover actually settles", async () => {
    const ctrl = new AbortController();
    let hoverStarted!: () => void;
    let releaseHover!: () => void;
    const started = new Promise<void>((resolve) => {
      hoverStarted = resolve;
    });
    const pendingHover = new Promise<void>((resolve) => {
      releaseHover = resolve;
    });
    let guardSettled = false;
    pageState.page = { url: vi.fn(() => "https://example.com") };
    pageState.locator = {
      hover: vi.fn(() => {
        hoverStarted();
        return pendingHover;
      }),
    };
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        page: { url: () => string };
      }) => {
        try {
          return await action(page.url());
        } finally {
          guardSettled = true;
        }
      },
    );

    const task = interactions.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });
    await started;
    ctrl.abort(new Error("aborted by test"));

    await expect(task).rejects.toThrow("aborted by test");
    expect(guardSettled).toBe(false);

    releaseHover();
    await vi.waitFor(() => expect(guardSettled).toBe(true));
  });

  it("lets a request-policy denial observed before abort win", async () => {
    const ctrl = new AbortController();
    let releaseHover!: () => void;
    const pendingHover = new Promise<void>((resolve) => {
      releaseHover = resolve;
    });
    let policyObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      policyObserved = resolve;
    });
    let releaseFulfill!: () => void;
    const pendingFulfill = new Promise<void>((resolve) => {
      releaseFulfill = resolve;
    });
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    let guardSettled = false;
    pageState.page = { url: vi.fn(() => "about:blank") };
    pageState.locator = { hover: vi.fn(() => pendingHover) };
    sessionMocks.isPolicyDenyNavigationError.mockImplementationOnce(
      (err: unknown) => err === blocked,
    );
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockReturnValueOnce(true);
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        onPolicyDenied,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        onPolicyDenied?: (event: {
          state: "detected" | "handled";
          error: unknown;
          sourcePreserved?: boolean;
        }) => void;
        page: { url: () => string };
      }) => {
        const actionTask = action(page.url());
        onPolicyDenied?.({ state: "detected", error: blocked });
        policyObserved();
        await pendingFulfill;
        onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: true });
        try {
          await actionTask;
          throw blocked;
        } finally {
          guardSettled = true;
        }
      },
    );

    const task = interactions.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });
    await observed;
    ctrl.abort(new Error("aborted after policy denial"));

    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFulfill();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(guardSettled).toBe(false);
    releaseHover();
    await expect(task).rejects.toBe(blocked);
    await vi.waitFor(() => expect(guardSettled).toBe(true));
  });

  it("waits for an in-flight policy decision before returning abort", async () => {
    const ctrl = new AbortController();
    let releaseHover!: () => void;
    const pendingHover = new Promise<void>((resolve) => {
      releaseHover = resolve;
    });
    let rejectPolicy!: (err: unknown) => void;
    const policyPending = new Promise<void>((_resolve, reject) => {
      rejectPolicy = reject;
    });
    let policyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      policyStarted = resolve;
    });
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    pageState.page = { url: vi.fn(() => "about:blank") };
    pageState.locator = { hover: vi.fn(() => pendingHover) };
    sessionMocks.isPolicyDenyNavigationError.mockImplementation((err: unknown) => err === blocked);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      (err: unknown) => err === blocked,
    );
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        onPolicyCheckStarted,
        onPolicyDenied,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        onPolicyCheckStarted?: (check: Promise<void>) => void;
        onPolicyDenied?: (event: {
          state: "detected" | "handled";
          error: unknown;
          sourcePreserved?: boolean;
        }) => void;
        page: { url: () => string };
      }) => {
        const actionTask = action(page.url());
        onPolicyCheckStarted?.(policyPending);
        policyStarted();
        try {
          await policyPending;
        } catch (err) {
          onPolicyDenied?.({ state: "detected", error: err });
          onPolicyDenied?.({ state: "handled", error: err, sourcePreserved: true });
        }
        await actionTask;
        throw blocked;
      },
    );

    const task = interactions.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });
    await started;
    ctrl.abort(new Error("aborted while policy pending"));
    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);

    rejectPolicy(blocked);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseHover();
    await expect(task).rejects.toBe(blocked);
    sessionMocks.isPolicyDenyNavigationError.mockImplementation(() => false);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      () => false,
    );
  });

  it("returns abort once an in-flight policy decision allows the request", async () => {
    const ctrl = new AbortController();
    let releaseHover!: () => void;
    const pendingHover = new Promise<void>((resolve) => {
      releaseHover = resolve;
    });
    let allowPolicy!: () => void;
    const policyPending = new Promise<void>((resolve) => {
      allowPolicy = resolve;
    });
    let policyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      policyStarted = resolve;
    });
    pageState.page = { url: vi.fn(() => "about:blank") };
    pageState.locator = { hover: vi.fn(() => pendingHover) };
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        onPolicyCheckStarted,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        onPolicyCheckStarted?: (check: Promise<void>) => void;
        page: { url: () => string };
      }) => {
        const actionTask = action(page.url());
        onPolicyCheckStarted?.(policyPending);
        policyStarted();
        await policyPending;
        return await actionTask;
      },
    );

    const task = interactions.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });
    await started;
    ctrl.abort(new Error("aborted while policy pending"));
    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);

    allowPolicy();
    await expect(task).rejects.toThrow("aborted while policy pending");
    releaseHover();
  });

  it("quarantines immediately when a preserved denied source later becomes unsafe", async () => {
    const ctrl = new AbortController();
    let releaseHover!: () => void;
    const pendingHover = new Promise<void>((resolve) => {
      releaseHover = resolve;
    });
    let reportUnsafe!: () => void;
    const unsafeReported = new Promise<void>((resolve) => {
      reportUnsafe = resolve;
    });
    let policyDetected!: () => void;
    const detected = new Promise<void>((resolve) => {
      policyDetected = resolve;
    });
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    pageState.page = { url: vi.fn(() => "about:blank") };
    pageState.locator = { hover: vi.fn(() => pendingHover) };
    sessionMocks.isPolicyDenyNavigationError.mockImplementation((err: unknown) => err === blocked);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      (err: unknown) => err === blocked,
    );
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        onPolicyDenied,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        onPolicyDenied?: (event: {
          state: "detected" | "handled";
          error: unknown;
          sourcePreserved?: boolean;
        }) => void;
        page: { url: () => string };
      }) => {
        const actionTask = action(page.url());
        onPolicyDenied?.({ state: "detected", error: blocked });
        policyDetected();
        onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: true });
        await unsafeReported;
        onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: false });
        await actionTask;
        throw blocked;
      },
    );

    const task = interactions.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });
    await detected;
    ctrl.abort(new Error("aborted after policy denial"));
    reportUnsafe();

    await vi.waitFor(() =>
      expect(sessionMocks.quarantineBlockedNavigationTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page: pageState.page,
        targetId: "tab-1",
      }),
    );
    releaseHover();
    await expect(task).rejects.toBe(blocked);
    sessionMocks.isPolicyDenyNavigationError.mockImplementation(() => false);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      () => false,
    );
  });

  it("keeps the request guard for the full grace after an early safe post-check", async () => {
    vi.useFakeTimers();
    try {
      let currentUrl = "https://example.com";
      let guardSettled = false;
      pageState.page = { url: vi.fn(() => currentUrl) };
      pageState.locator = {
        hover: vi.fn(async () => {
          currentUrl = "https://example.org";
        }),
      };
      sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
        async ({
          action,
          page,
        }: {
          action: (url: string) => Promise<unknown>;
          page: { url: () => string };
        }) => {
          try {
            return await action(page.url());
          } finally {
            guardSettled = true;
          }
        },
      );

      const task = interactions.hoverViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(249);
      expect(guardSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(guardSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not add a navigation grace without a policy", async () => {
    vi.useFakeTimers();
    try {
      pageState.page = { url: vi.fn(() => "about:blank") };
      pageState.locator = { hover: vi.fn(async () => {}) };
      let settled = false;

      const task = interactions
        .hoverViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
        })
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(0);
      await task;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a late unpreserved policy failure after abort already returned", async () => {
    const ctrl = new AbortController();
    let hoverStarted!: () => void;
    let releaseHover!: () => void;
    const started = new Promise<void>((resolve) => {
      hoverStarted = resolve;
    });
    const pendingHover = new Promise<void>((resolve) => {
      releaseHover = resolve;
    });
    const blocked = new Error("late browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    pageState.page = { url: vi.fn(() => "https://example.com") };
    pageState.locator = {
      hover: vi.fn(() => {
        hoverStarted();
        return pendingHover;
      }),
    };
    sessionMocks.isPolicyDenyNavigationError.mockImplementationOnce(
      (err: unknown) => err instanceof Error && err.name === "SsrFBlockedError",
    );
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        page: { url: () => string };
      }) => {
        await action(page.url());
        throw blocked;
      },
    );

    const task = interactions.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });
    await started;
    ctrl.abort(new Error("aborted by test"));
    await expect(task).rejects.toThrow("aborted by test");

    releaseHover();
    await vi.waitFor(() =>
      expect(sessionMocks.quarantineBlockedNavigationTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page: pageState.page,
        targetId: "tab-1",
      }),
    );
  });

  it("preserves SSRF policy when aborting a pending click", async () => {
    const ctrl = new AbortController();
    let clickStarted: () => void = () => {};
    const clickStartedPromise = new Promise<void>((resolve) => {
      clickStarted = resolve;
    });
    pageState.page = { url: vi.fn(() => "https://example.com") };
    pageState.locator = {
      click: vi.fn(() => {
        clickStarted();
        return new Promise(() => {});
      }),
    };

    const task = interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    await clickStartedPromise;
    ctrl.abort(new Error("aborted by test"));

    await expect(task).rejects.toThrow("aborted by test");
    expect(sessionMocks.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      reason: "click aborted",
    });
  });

  it.each([
    { label: "fill before submit", slowly: false, firstMethod: "fill" as const },
    { label: "click before slow type", slowly: true, firstMethod: "click" as const },
  ])("stops a multi-step type action after aborting $label", async ({ slowly, firstMethod }) => {
    const ctrl = new AbortController();
    let firstStepStarted!: () => void;
    let releaseFirstStep!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStepStarted = resolve;
    });
    const pendingFirstStep = new Promise<void>((resolve) => {
      releaseFirstStep = resolve;
    });
    const click = vi.fn(async () => {});
    const fill = vi.fn(async () => {});
    const type = vi.fn(async () => {});
    const press = vi.fn(async () => {});
    const firstStep = vi.fn(() => {
      firstStepStarted();
      return pendingFirstStep;
    });
    if (firstMethod === "click") {
      click.mockImplementation(firstStep);
    } else {
      fill.mockImplementation(firstStep);
    }
    let guardSettled = false;
    pageState.page = { url: vi.fn(() => "https://example.com") };
    pageState.locator = { click, fill, type, press };
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        page: { url: () => string };
      }) => {
        try {
          return await action(page.url());
        } finally {
          guardSettled = true;
        }
      },
    );

    const task = interactions.typeViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      text: "value",
      submit: true,
      slowly,
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    await started;
    ctrl.abort(new Error("aborted by test"));
    await expect(task).rejects.toThrow("aborted by test");

    releaseFirstStep();
    await vi.waitFor(() => expect(guardSettled).toBe(true));
    expect(type).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
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

  it("stops form filling when the first field's request guard denies navigation", async () => {
    const fill = vi.fn(async () => {});
    const blocked = new Error("blocked field navigation");
    blocked.name = "SsrFBlockedError";
    pageState.page = { url: vi.fn(() => "https://example.com") };
    pageState.locator = { fill };
    sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
      async ({
        action,
        page,
      }: {
        action: (url: string) => Promise<unknown>;
        page: { url(): string };
      }) => {
        await action(page.url());
        throw blocked;
      },
    );

    await expect(
      interactions.fillFormViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        fields: [
          { ref: "1", type: "text", value: "first" },
          { ref: "2", type: "text", value: "second" },
        ],
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toThrow("blocked field navigation");

    expect(fill).toHaveBeenCalledOnce();
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
  });

  it("installs the request guard before evaluating page content", async () => {
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

    expect(sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      evaluate.mock.invocationCallOrder[0],
    );
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
