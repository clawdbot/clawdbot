// Browser tests cover pw tools core ssrf guard plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

function requireInvocationOrder(mock: { invocationCallOrder: number[] }, context: string): number {
  return expectDefined(mock.invocationCallOrder[0], context);
}

const pageState = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  locator: null as Record<string, unknown> | null,
}));

type NavigationGuardCall = {
  action: (url: string) => Promise<unknown>;
  onPolicyCheckStarted?: (check: Promise<void>) => void;
  onPolicyDenied?: (event: {
    state: "detected" | "handled";
    error: unknown;
    sourcePreserved?: boolean;
  }) => void;
  page: { url: () => string };
};

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
    async ({ action, page }: NavigationGuardCall) => await action(page.url()),
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
const { clickCoordsViaPlaywright } = await import("./pw-tools-core.interactions.actions.js");
const snapshots = await import("./pw-tools-core.snapshot.js");

const strictNavigationOptions = () =>
  ({
    cdpUrl: "http://127.0.0.1:18792",
    targetId: "tab-1",
    ssrfPolicy: { allowPrivateNetwork: false },
  }) as const;

const proxiedNavigationOptions = () =>
  ({
    ...strictNavigationOptions(),
    browserProxyMode: "explicit-browser-proxy",
  }) as const;

function completedNavigationExpectation(proxied = false) {
  return {
    ...strictNavigationOptions(),
    page: pageState.page,
    response: null,
    ...(proxied ? { browserProxyMode: "explicit-browser-proxy" as const } : {}),
  };
}

function installInteractionPage(
  page: Record<string, unknown>,
  locator: Record<string, unknown>,
): void {
  pageState.page = page;
  pageState.locator = locator;
}

function mockNavigationGuardOnce(
  implementation: (args: NavigationGuardCall) => Promise<unknown>,
): void {
  sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(implementation);
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  await run().finally(() => vi.useRealTimers());
}

function createSnapshotPage(overrides: Record<string, unknown>) {
  const mainFrame = {};
  return {
    mainFrame: vi.fn(() => mainFrame),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

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
    installInteractionPage(
      { url: vi.fn(() => currentUrl) },
      {
        click: vi.fn(async () => {
          currentUrl = "https://target.example";
        }),
      },
    );

    await interactions.clickViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
  });

  it.each([
    {
      name: "hover",
      method: "hover",
      run: async () =>
        await interactions.hoverViaPlaywright({
          ...proxiedNavigationOptions(),
          ref: "1",
        }),
    },
    {
      name: "drag",
      method: "dragTo",
      run: async () =>
        await interactions.dragViaPlaywright({
          ...proxiedNavigationOptions(),
          startRef: "1",
          endRef: "2",
        }),
    },
    {
      name: "scrollIntoView",
      method: "scrollIntoViewIfNeeded",
      run: async () =>
        await interactions.scrollIntoViewViaPlaywright({
          ...proxiedNavigationOptions(),
          ref: "1",
        }),
    },
  ])(
    "guards $name document requests and runs the canonical post-check",
    async ({ method, run }) => {
      let currentUrl = "https://example.com";
      installInteractionPage(
        { url: vi.fn(() => currentUrl) },
        {
          [method]: vi.fn(async () => {
            currentUrl = "https://93.184.216.34/target";
          }),
        },
      );

      await run();

      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith({
        action: expect.any(Function),
        onPolicyCheckStarted: expect.any(Function),
        onPolicyDenied: expect.any(Function),
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
        browserProxyMode: "explicit-browser-proxy",
      });
      expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        completedNavigationExpectation(true),
      );
    },
  );

  it.each([
    {
      name: "click",
      run: async () =>
        await interactions.clickViaPlaywright({
          ...proxiedNavigationOptions(),
          ref: "1",
        }),
    },
    {
      name: "clickCoords",
      run: async () =>
        await clickCoordsViaPlaywright({
          ...proxiedNavigationOptions(),
          x: 10,
          y: 20,
        }),
    },
    {
      name: "type",
      run: async () =>
        await interactions.typeViaPlaywright({
          ...proxiedNavigationOptions(),
          ref: "1",
          text: "value",
        }),
    },
    {
      name: "type-submit",
      run: async () =>
        await interactions.typeViaPlaywright({
          ...proxiedNavigationOptions(),
          ref: "1",
          text: "value",
          submit: true,
        }),
    },
    {
      name: "press",
      run: async () =>
        await interactions.pressKeyViaPlaywright({
          ...proxiedNavigationOptions(),
          key: "Enter",
        }),
    },
    {
      name: "select",
      run: async () =>
        await interactions.selectOptionViaPlaywright({
          ...proxiedNavigationOptions(),
          ref: "1",
          values: ["one"],
        }),
    },
    {
      name: "fill",
      run: async () =>
        await interactions.fillFormViaPlaywright({
          ...proxiedNavigationOptions(),
          fields: [{ ref: "1", type: "text", value: "value" }],
        }),
    },
    {
      name: "evaluate",
      run: async () =>
        await interactions.evaluateViaPlaywright({
          ...proxiedNavigationOptions(),
          fn: "() => true",
        }),
    },
    {
      name: "evaluate-ref",
      run: async () =>
        await interactions.evaluateViaPlaywright({
          ...proxiedNavigationOptions(),
          ref: "1",
          fn: "(el) => Boolean(el)",
        }),
    },
  ])("guards $name document requests and preserves proxy policy", async ({ run }) => {
    let currentUrl = "https://example.com";
    const navigate = vi.fn(async () => {
      currentUrl = "https://93.184.216.34/target";
    });
    installInteractionPage(
      {
        url: vi.fn(() => currentUrl),
        mouse: { click: navigate },
        keyboard: { press: navigate },
        evaluate: navigate,
        evaluateHandle: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
        waitForFunction: navigate,
      },
      {
        click: navigate,
        fill: navigate,
        press: navigate,
        selectOption: navigate,
        setChecked: navigate,
        evaluate: navigate,
      },
    );

    await run();

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page: pageState.page,
      ssrfPolicy: { allowPrivateNetwork: false },
      browserProxyMode: "explicit-browser-proxy",
    });
    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith(
      completedNavigationExpectation(true),
    );
    expect(sessionMocks.getPageForTargetId).toHaveBeenCalledWith(
      expect.objectContaining(proxiedNavigationOptions()),
    );
  });

  it("does not restore role references for keyboard-only actions", async () => {
    const press = vi.fn(async () => {});
    installInteractionPage({ url: vi.fn(() => "https://example.com"), keyboard: { press } }, {});

    await interactions.pressKeyViaPlaywright({ cdpUrl: "http://127.0.0.1:18792", key: "Enter" });

    expect(press).toHaveBeenCalledWith("Enter", { delay: 0 });
    expect(sessionMocks.ensurePageState).toHaveBeenCalledOnce();
    expect(sessionMocks.restoreRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it("preserves raw coordinate-click failures and removes the abort listener", async () => {
    const failure = new Error("coordinate click failed");
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    installInteractionPage(
      {
        url: vi.fn(() => "https://example.com"),
        mouse: {
          click: vi.fn(async () => {
            throw failure;
          }),
        },
      },
      {},
    );

    await expect(
      clickCoordsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        x: 10,
        y: 20,
        signal: controller.signal,
      }),
    ).rejects.toBe(failure);

    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("guards executable wait predicates and preserves proxy policy", async () => {
    let currentUrl = "https://example.com";
    const order: string[] = [];
    mockNavigationGuardOnce(async ({ action, page }) => {
      order.push("guard");
      return await action(page.url());
    });
    const documentHandle = { dispose: vi.fn(async () => {}) };
    const waitForFunction = vi.fn(
      async (
        predicate: (state: { document: unknown }) => boolean,
        state: { document: unknown },
      ) => {
        order.push("predicate");
        expect(predicate({ ...state, document: globalThis.document })).toBe(true);
        currentUrl = "https://93.184.216.34/target";
      },
    );
    pageState.page = {
      url: vi.fn(() => currentUrl),
      evaluateHandle: vi.fn(async () => documentHandle),
      waitForTimeout: vi.fn(async () => {
        order.push("passive");
      }),
      waitForFunction,
    };

    await interactions.waitForViaPlaywright({
      ...proxiedNavigationOptions(),
      timeMs: 1,
      fn: "() => true",
    });

    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      { document: documentHandle },
      { timeout: expect.any(Number) },
    );
    expect(order).toEqual(["guard", "passive", "predicate"]);
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page: pageState.page,
      ssrfPolicy: { allowPrivateNetwork: false },
      browserProxyMode: "explicit-browser-proxy",
    });
    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith(
      completedNavigationExpectation(true),
    );
  });

  it("preserves declared async wait predicates", async () => {
    const documentHandle = { dispose: vi.fn(async () => {}) };
    const waitForFunction = vi.fn(async () => {});
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      evaluateHandle: vi.fn(async () => documentHandle),
      waitForFunction,
    };

    await interactions.waitForViaPlaywright({
      ...strictNavigationOptions(),
      fn: "async () => true",
    });

    expect(waitForFunction).toHaveBeenCalledOnce();
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("preserves synchronous wait predicates that return a promise", async () => {
    const documentHandle = { dispose: vi.fn(async () => {}) };
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      evaluateHandle: vi.fn(async () => documentHandle),
      waitForFunction: vi.fn(
        async (
          predicate: (state: { document: unknown }) => boolean,
          state: { document: unknown },
        ) => {
          const browserState = { ...state, document: globalThis.document };
          expect(predicate(browserState)).toBe(false);
          await Promise.resolve();
          expect(predicate(browserState)).toBe(true);
        },
      ),
    };

    await interactions.waitForViaPlaywright({
      ...strictNavigationOptions(),
      fn: "() => Promise.resolve(true)",
    });

    expect(sessionMocks.closeBlockedNavigationTarget).not.toHaveBeenCalled();
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("does not recreate a wait predicate in a replacement document", async () => {
    const documentHandle = { dispose: vi.fn(async () => {}) };
    pageState.page = {
      url: vi.fn(() => "https://example.com/next"),
      evaluateHandle: vi.fn(async () => documentHandle),
      waitForFunction: vi.fn(
        async (
          predicate: (state: { document: unknown }) => boolean,
          state: { document: unknown },
        ) => predicate({ ...state, document: {} }),
      ),
    };

    await expect(
      interactions.waitForViaPlaywright({
        ...strictNavigationOptions(),
        fn: "() => document.cookie",
      }),
    ).rejects.toThrow("Wait predicate document changed");

    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("does not start a predicate after aborting an earlier wait condition", async () => {
    const ctrl = new AbortController();
    sessionMocks.isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
    const waitForFunction = vi.fn(async () => {});
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      waitForTimeout: vi.fn(async () => {
        ctrl.abort(new Error("aborted during passive wait"));
      }),
      waitForFunction,
    };

    await expect(
      interactions.waitForViaPlaywright({
        ...strictNavigationOptions(),
        timeMs: 1,
        fn: "() => true",
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted during passive wait");
    await Promise.resolve();
    expect(waitForFunction).not.toHaveBeenCalled();
    expect(sessionMocks.markObservedDialogsHandledRemotelyForPage).toHaveBeenCalledWith(
      pageState.page,
    );
  });

  it("does not start a predicate when document capture finishes after abort", async () => {
    const ctrl = new AbortController();
    const documentHandle = { dispose: vi.fn(async () => {}) };
    const waitForFunction = vi.fn(async () => {});
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      evaluateHandle: vi.fn(async () => {
        ctrl.abort(new Error("aborted during document capture"));
        return documentHandle;
      }),
      waitForFunction,
    };

    await expect(
      interactions.waitForViaPlaywright({
        ...strictNavigationOptions(),
        fn: "() => true",
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted during document capture");

    expect(waitForFunction).not.toHaveBeenCalled();
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("joins an aborted native hover before returning and releasing its request guard", async () => {
    const ctrl = new AbortController();
    const started = createDeferred<void>();
    const hover = createDeferred<void>();
    let guardSettled = false;
    installInteractionPage(
      { url: vi.fn(() => "https://example.com") },
      {
        hover: vi.fn(() => {
          started.resolve();
          return hover.promise;
        }),
      },
    );
    mockNavigationGuardOnce(async ({ action, page }) => {
      try {
        return await action(page.url());
      } finally {
        guardSettled = true;
      }
    });

    const task = interactions.hoverViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      signal: ctrl.signal,
    });
    await started.promise;
    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    ctrl.abort(new Error("aborted by test"));

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(guardSettled).toBe(false);

    hover.resolve();
    await expect(task).rejects.toThrow("aborted by test");
    expect(guardSettled).toBe(true);
  });

  it("lets a request-policy denial observed before abort win", async () => {
    const ctrl = new AbortController();
    const hover = createDeferred<void>();
    const observed = createDeferred<void>();
    const fulfill = createDeferred<void>();
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    let guardSettled = false;
    installInteractionPage(
      { url: vi.fn(() => "about:blank") },
      {
        hover: vi.fn(() => hover.promise),
      },
    );
    sessionMocks.isPolicyDenyNavigationError.mockImplementationOnce(
      (err: unknown) => err === blocked,
    );
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockReturnValueOnce(true);
    mockNavigationGuardOnce(async ({ action, onPolicyDenied, page }) => {
      const actionTask = action(page.url());
      onPolicyDenied?.({ state: "detected", error: blocked });
      observed.resolve();
      await fulfill.promise;
      onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: true });
      try {
        await actionTask;
        throw blocked;
      } finally {
        guardSettled = true;
      }
    });

    const task = interactions.hoverViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      signal: ctrl.signal,
    });
    await observed.promise;
    ctrl.abort(new Error("aborted after policy denial"));

    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    fulfill.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(guardSettled).toBe(false);
    hover.resolve();
    await expect(task).rejects.toBe(blocked);
    await vi.waitFor(() => expect(guardSettled).toBe(true));
  });

  it("waits for an in-flight policy decision before returning abort", async () => {
    const ctrl = new AbortController();
    const hover = createDeferred<void>();
    const policy = createDeferred<void>();
    const started = createDeferred<void>();
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    installInteractionPage(
      { url: vi.fn(() => "about:blank") },
      {
        hover: vi.fn(() => hover.promise),
      },
    );
    sessionMocks.isPolicyDenyNavigationError.mockImplementation((err: unknown) => err === blocked);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      (err: unknown) => err === blocked,
    );
    mockNavigationGuardOnce(async ({ action, onPolicyCheckStarted, onPolicyDenied, page }) => {
      const actionTask = action(page.url());
      onPolicyCheckStarted?.(policy.promise);
      started.resolve();
      try {
        await policy.promise;
      } catch (err) {
        onPolicyDenied?.({ state: "detected", error: err });
        onPolicyDenied?.({ state: "handled", error: err, sourcePreserved: true });
      }
      await actionTask;
      throw blocked;
    });

    const task = interactions.hoverViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      signal: ctrl.signal,
    });
    await started.promise;
    ctrl.abort(new Error("aborted while policy pending"));
    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);

    policy.reject(blocked);
    await Promise.resolve();
    expect(settled).toBe(false);
    hover.resolve();
    await expect(task).rejects.toBe(blocked);
    sessionMocks.isPolicyDenyNavigationError.mockImplementation(() => false);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      () => false,
    );
  });

  it("returns abort once an in-flight policy decision allows the request", async () => {
    const ctrl = new AbortController();
    const hover = createDeferred<void>();
    const policy = createDeferred<void>();
    const started = createDeferred<void>();
    installInteractionPage(
      { url: vi.fn(() => "about:blank") },
      {
        hover: vi.fn(() => hover.promise),
      },
    );
    mockNavigationGuardOnce(async ({ action, onPolicyCheckStarted, page }) => {
      const actionTask = action(page.url());
      onPolicyCheckStarted?.(policy.promise);
      started.resolve();
      await policy.promise;
      return await actionTask;
    });

    const task = interactions.hoverViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      signal: ctrl.signal,
    });
    await started.promise;
    ctrl.abort(new Error("aborted while policy pending"));
    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);

    policy.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    hover.resolve();
    await expect(task).rejects.toThrow("aborted while policy pending");
  });

  it("quarantines immediately when a preserved denied source later becomes unsafe", async () => {
    const ctrl = new AbortController();
    const hover = createDeferred<void>();
    const unsafeReported = createDeferred<void>();
    const detected = createDeferred<void>();
    const blocked = new Error("browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    installInteractionPage(
      { url: vi.fn(() => "about:blank") },
      {
        hover: vi.fn(() => hover.promise),
      },
    );
    sessionMocks.isPolicyDenyNavigationError.mockImplementation((err: unknown) => err === blocked);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      (err: unknown) => err === blocked,
    );
    mockNavigationGuardOnce(async ({ action, onPolicyDenied, page }) => {
      const actionTask = action(page.url());
      onPolicyDenied?.({ state: "detected", error: blocked });
      detected.resolve();
      onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: true });
      await unsafeReported.promise;
      onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: false });
      await actionTask;
      throw blocked;
    });

    const task = interactions.hoverViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      signal: ctrl.signal,
    });
    await detected.promise;
    ctrl.abort(new Error("aborted after policy denial"));
    unsafeReported.resolve();

    await vi.waitFor(() =>
      expect(sessionMocks.quarantineBlockedNavigationTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page: pageState.page,
        targetId: "tab-1",
      }),
    );
    hover.resolve();
    await expect(task).rejects.toBe(blocked);
    sessionMocks.isPolicyDenyNavigationError.mockImplementation(() => false);
    sessionMocks.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
      () => false,
    );
  });

  it("keeps the request guard for the full grace after an early safe post-check", async () => {
    await withFakeTimers(async () => {
      let currentUrl = "https://example.com";
      let guardSettled = false;
      pageState.page = { url: vi.fn(() => currentUrl) };
      pageState.locator = {
        hover: vi.fn(async () => {
          currentUrl = "https://example.org";
        }),
      };
      mockNavigationGuardOnce(async ({ action, page }) => {
        try {
          return await action(page.url());
        } finally {
          guardSettled = true;
        }
      });

      const task = interactions.hoverViaPlaywright({
        ...strictNavigationOptions(),
        ref: "1",
      });

      await vi.advanceTimersByTimeAsync(249);
      expect(guardSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(guardSettled).toBe(true);
    });
  });

  it("does not add a navigation grace without a policy", async () => {
    await withFakeTimers(async () => {
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
    });
  });

  it("quarantines a late unpreserved policy failure before returning cancellation", async () => {
    const ctrl = new AbortController();
    const started = createDeferred<void>();
    const hover = createDeferred<void>();
    const blocked = new Error("late browser navigation blocked by policy");
    blocked.name = "SsrFBlockedError";
    installInteractionPage(
      { url: vi.fn(() => "https://example.com") },
      {
        hover: vi.fn(() => {
          started.resolve();
          return hover.promise;
        }),
      },
    );
    sessionMocks.isPolicyDenyNavigationError.mockImplementationOnce(
      (err: unknown) => err instanceof Error && err.name === "SsrFBlockedError",
    );
    mockNavigationGuardOnce(async ({ action, page }) => {
      await action(page.url());
      throw blocked;
    });

    const task = interactions.hoverViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      signal: ctrl.signal,
    });
    await started.promise;
    ctrl.abort(new Error("aborted by test"));
    hover.resolve();
    await expect(task).rejects.toBe(blocked);
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
    const clickStarted = createDeferred<void>();
    const click = createDeferred<void>();
    let nativeSignal: AbortSignal | undefined;
    installInteractionPage(
      { url: vi.fn(() => "https://example.com") },
      {
        click: vi.fn((options: { signal?: AbortSignal }) => {
          nativeSignal = options.signal;
          clickStarted.resolve();
          return click.promise;
        }),
      },
    );

    const task = interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    await clickStarted.promise;
    ctrl.abort(new Error("aborted by test"));
    expect(nativeSignal?.aborted).toBe(true);
    click.reject(
      Object.assign(new Error("cancelled", { cause: nativeSignal?.reason }), {
        name: "AbortError",
      }),
    );

    await expect(task).rejects.toThrow("aborted by test");
    expect(sessionMocks.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    );
  });

  it.each([
    { label: "fill before submit", slowly: false, firstMethod: "fill" as const },
    { label: "click before slow type", slowly: true, firstMethod: "click" as const },
  ])("stops a multi-step type action after aborting $label", async ({ slowly, firstMethod }) => {
    const ctrl = new AbortController();
    const started = createDeferred<void>();
    const firstStepPending = createDeferred<void>();
    const click = vi.fn(async () => {});
    const fill = vi.fn(async () => {});
    const type = vi.fn(async () => {});
    const press = vi.fn(async () => {});
    const firstStep = vi.fn(() => {
      started.resolve();
      return firstStepPending.promise;
    });
    if (firstMethod === "click") {
      click.mockImplementation(firstStep);
    } else {
      fill.mockImplementation(firstStep);
    }
    let guardSettled = false;
    installInteractionPage(
      { url: vi.fn(() => "https://example.com") },
      {
        click,
        fill,
        type,
        press,
      },
    );
    mockNavigationGuardOnce(async ({ action, page }) => {
      try {
        return await action(page.url());
      } finally {
        guardSettled = true;
      }
    });

    const task = interactions.typeViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      text: "value",
      submit: true,
      slowly,
      signal: ctrl.signal,
    });

    await started.promise;
    ctrl.abort(new Error("aborted by test"));
    expect(guardSettled).toBe(false);
    firstStepPending.resolve();
    await expect(task).rejects.toThrow("aborted by test");
    expect(guardSettled).toBe(true);
    expect(type).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it("re-checks select-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://example.com";
    installInteractionPage(
      { url: vi.fn(() => currentUrl) },
      {
        selectOption: vi.fn(async () => {
          currentUrl = "https://target.example";
        }),
      },
    );

    await interactions.selectOptionViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      values: ["go"],
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
  });

  it("re-checks form fill-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://example.com";
    installInteractionPage(
      { url: vi.fn(() => currentUrl) },
      {
        fill: vi.fn(async () => {
          currentUrl = "https://target.example";
        }),
      },
    );

    await interactions.fillFormViaPlaywright({
      ...strictNavigationOptions(),
      fields: [{ ref: "1", type: "text", value: "go" }],
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
  });

  it("stops form filling when the first field's request guard denies navigation", async () => {
    const fill = vi.fn(async () => {});
    const blocked = new Error("blocked field navigation");
    blocked.name = "SsrFBlockedError";
    installInteractionPage({ url: vi.fn(() => "https://example.com") }, { fill });
    mockNavigationGuardOnce(async ({ action, page }) => {
      await action(page.url());
      throw blocked;
    });

    await expect(
      interactions.fillFormViaPlaywright({
        ...strictNavigationOptions(),
        fields: [
          { ref: "1", type: "text", value: "first" },
          { ref: "2", type: "text", value: "second" },
        ],
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
      ...strictNavigationOptions(),
      fn: "() => document.body.innerText",
    });

    expect(
      requireInvocationOrder(
        sessionMocks.withPageNavigationRequestGuard.mock,
        "request guard invocation",
      ),
    ).toBeLessThan(requireInvocationOrder(evaluate.mock, "page evaluation invocation"));
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
    installInteractionPage(
      { url: vi.fn(() => currentUrl) },
      {
        click: vi.fn(async () => {
          currentUrl = "https://target.example";
        }),
      },
    );

    await interactions.batchViaPlaywright({
      ...strictNavigationOptions(),
      actions: [{ kind: "click", ref: "1" }],
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
  });

  it("re-checks current page URL before snapshotting AI content", async () => {
    const ariaSnapshot = vi.fn(async () => 'button "Save"');
    pageState.page = createSnapshotPage({
      ariaSnapshot,
      url: vi.fn(() => "https://example.com"),
    });

    await snapshots.snapshotAiViaPlaywright({
      ...strictNavigationOptions(),
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
    expect(
      requireInvocationOrder(
        sessionMocks.assertPageNavigationCompletedSafely.mock,
        "safe-navigation assertion invocation",
      ),
    ).toBeLessThan(requireInvocationOrder(ariaSnapshot.mock, "ARIA snapshot invocation"));
  });

  it("re-checks current page URL before role snapshots", async () => {
    const ariaSnapshot = vi.fn(async () => "");
    pageState.page = createSnapshotPage({
      locator: vi.fn(() => ({ ariaSnapshot })),
      url: vi.fn(() => "https://example.com"),
    });

    await snapshots.snapshotRoleViaPlaywright({
      ...strictNavigationOptions(),
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
    expect(
      requireInvocationOrder(
        sessionMocks.assertPageNavigationCompletedSafely.mock,
        "safe-navigation assertion invocation",
      ),
    ).toBeLessThan(requireInvocationOrder(ariaSnapshot.mock, "ARIA snapshot invocation"));
  });

  it("re-checks current page URL before aria snapshots", async () => {
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
    };

    await snapshots.snapshotAriaViaPlaywright({
      ...strictNavigationOptions(),
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
    expect(
      requireInvocationOrder(
        sessionMocks.assertPageNavigationCompletedSafely.mock,
        "safe-navigation assertion invocation",
      ),
    ).toBeLessThan(
      requireInvocationOrder(
        pageCdpMocks.withPageScopedCdpClient.mock,
        "page-scoped CDP invocation",
      ),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
