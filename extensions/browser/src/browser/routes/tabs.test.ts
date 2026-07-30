// Browser tests cover tabs plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBrowserErrorResponse } from "../errors.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

const { registerBrowserTabRoutes } = await import("./tabs.js");

type ProfileContext = ReturnType<typeof createProfileContext>;
type TabFixture = {
  targetId: string;
  suggestedTargetId?: string;
  tabId?: string;
  label?: string;
  title: string;
  url: string;
  type: "page";
};

const publicTab = (overrides: Partial<TabFixture> = {}): TabFixture => ({
  targetId: "T1",
  title: "Public",
  url: "https://example.com",
  type: "page",
  ...overrides,
});

const internalTab = (overrides: Partial<TabFixture> = {}): TabFixture => ({
  targetId: "T2",
  title: "Internal",
  url: "http://169.254.169.254/latest/meta-data/",
  type: "page",
  ...overrides,
});

function ssrfBlockedError() {
  return Object.assign(new Error("blocked"), { name: "SsrFBlockedError" });
}

const createProfileWithTabs = (tabs: TabFixture[]) =>
  createProfileContext({
    listTabs: vi.fn(async () => tabs),
  });

async function expectBrowserNotRunningAction(action: "close" | "select") {
  vi.useFakeTimers();
  const profileCtx = createProfileContext({
    isReachable: vi.fn(async () => false),
  });

  try {
    const pending = callTabsAction({
      body: { action, index: 0 },
      profileCtx,
    });
    await vi.runAllTimersAsync();
    const response = await pending;

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: "browser not running" });
    expect(profileCtx.listTabs).not.toHaveBeenCalled();
    expect(action === "close" ? profileCtx.closeTab : profileCtx.focusTab).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
}

function createProfileContext(overrides?: Partial<ReturnType<typeof baseProfileContext>>) {
  return {
    ...baseProfileContext(),
    ...overrides,
  };
}

function baseProfileContext() {
  return {
    profile: {
      name: "openclaw",
    },
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    isHttpReachable: vi.fn(async () => true),
    isReachable: vi.fn(async () => true),
    listTabs: vi.fn(async () => [
      {
        targetId: "T1",
        title: "Tab 1",
        url: "https://example.com",
        type: "page",
      },
    ]),
    openTab: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    labelTab: vi.fn(async (_targetId: string, label: string) => ({
      suggestedTargetId: label,
      targetId: "T1",
      tabId: "t1",
      label,
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    resetProfile: vi.fn(async () => ({ moved: false, from: "" })),
  };
}

function createRouteContext(
  profileCtx: ProfileContext,
  options?: { actionTimeoutMs?: number; ssrfPolicy?: unknown },
) {
  return {
    state: () => ({
      resolved: {
        actionTimeoutMs: options?.actionTimeoutMs ?? 45_000,
        extraArgs: [],
        ssrfPolicy: options?.ssrfPolicy,
      },
    }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn(toBrowserErrorResponse),
    ensureBrowserAvailable: profileCtx.ensureBrowserAvailable,
    ensureTabAvailable: profileCtx.ensureTabAvailable,
    isHttpReachable: profileCtx.isHttpReachable,
    isReachable: profileCtx.isReachable,
    listTabs: profileCtx.listTabs,
    openTab: profileCtx.openTab,
    labelTab: profileCtx.labelTab,
    focusTab: profileCtx.focusTab,
    closeTab: profileCtx.closeTab,
    stopRunningBrowser: profileCtx.stopRunningBrowser,
    resetProfile: profileCtx.resetProfile,
  };
}

async function callTabsRoute(params: {
  method: "get" | "post";
  path: "/tabs" | "/tabs/action" | "/tabs/focus" | "/tabs/open";
  body?: Record<string, unknown>;
  profileCtx: ProfileContext;
  actionTimeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: unknown;
}) {
  const { app, getHandlers, postHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(
    app,
    createRouteContext(params.profileCtx, {
      actionTimeoutMs: params.actionTimeoutMs,
      ssrfPolicy: params.ssrfPolicy,
    }) as never,
  );
  const handler =
    params.method === "get" ? getHandlers.get(params.path) : postHandlers.get(params.path);
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: {},
      query: {},
      body: params.body ?? {},
      ...(params.signal ? { signal: params.signal } : {}),
    },
    response.res,
  );
  return response;
}

it("returns the profile that actually handled tab open", async () => {
  const profileCtx = createProfileContext({
    profile: { name: "hot-profile" },
    openTab: vi.fn(async () => ({
      targetId: "HOT-TAB",
      title: "Hot",
      url: "https://example.com",
      type: "page" as const,
      ownership: {
        status: "durable" as const,
        nativeTargetId: "HOT-NATIVE",
        profileFingerprint: "sha256:profile",
        browserInstanceFingerprint: "sha256:browser",
      },
    })),
  });

  const response = await callTabsRoute({
    method: "post",
    path: "/tabs/open",
    body: { url: "https://example.com" },
    profileCtx,
  });

  expect(response.body).toEqual({
    targetId: "HOT-TAB",
    title: "Hot",
    url: "https://example.com",
    type: "page",
    ownership: {
      status: "durable",
      nativeTargetId: "HOT-NATIVE",
      profileFingerprint: "sha256:profile",
      browserInstanceFingerprint: "sha256:browser",
    },
    resolvedProfile: "hot-profile",
  });
});

async function callTabsAction(params: {
  body: Record<string, unknown>;
  profileCtx: ProfileContext;
  actionTimeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: unknown;
}) {
  return await callTabsRoute({ ...params, method: "post", path: "/tabs/action" });
}

async function callTabsList(params: {
  profileCtx: ProfileContext;
  actionTimeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: unknown;
}) {
  return await callTabsRoute({ ...params, method: "get", path: "/tabs" });
}

async function callTabsFocus(params: {
  profileCtx: ProfileContext;
  body: Record<string, unknown>;
  ssrfPolicy?: unknown;
}) {
  return await callTabsRoute({ ...params, method: "post", path: "/tabs/focus" });
}

async function callTabsDelete(params: {
  profileCtx: ProfileContext;
  targetId: string;
  query?: Record<string, unknown>;
}) {
  const { app, deleteHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(app, createRouteContext(params.profileCtx) as never);
  const handler = deleteHandlers.get("/tabs/:targetId");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: { targetId: params.targetId },
      query: params.query ?? {},
      body: {},
    },
    response.res,
  );
  return response;
}

describe("browser tab routes", () => {
  beforeEach(() => {
    navigationGuardMocks.assertBrowserNavigationAllowed.mockReset();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockReset();
    navigationGuardMocks.withBrowserNavigationPolicy.mockReset();
    navigationGuardMocks.withBrowserNavigationPolicy.mockImplementation((ssrfPolicy?: unknown) =>
      ssrfPolicy ? { ssrfPolicy } : {},
    );
  });

  it("validates tab-open input before resolving or leasing a profile", async () => {
    const profileCtx = createProfileContext();
    const routeCtx = createRouteContext(profileCtx);
    const forProfile = vi.fn(routeCtx.forProfile);
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserTabRoutes(app, { ...routeCtx, forProfile } as never);
    const response = createBrowserRouteResponse();

    await postHandlers.get("/tabs/open")?.({ params: {}, query: {}, body: {} }, response.res);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "url is required" });
    expect(forProfile).not.toHaveBeenCalled();
  });

  it("returns browser-not-running for close when the browser is not reachable", async () => {
    await expectBrowserNotRunningAction("close");
  });

  it("returns browser-not-running for select when the browser is not reachable", async () => {
    await expectBrowserNotRunningAction("select");
  });

  it("closes an internally selected raw target through the exact namespace", async () => {
    const profileCtx = createProfileContext();

    const response = await callTabsDelete({
      profileCtx,
      targetId: "T1",
      query: { targetIdMode: "raw" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(profileCtx.closeTab).toHaveBeenCalledWith("T1", { exactTargetId: true });
  });

  it("rejects unknown target id modes before mutating a tab", async () => {
    const profileCtx = createProfileContext();

    const response = await callTabsDelete({
      profileCtx,
      targetId: "T1",
      query: { targetIdMode: "friendly" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'targetIdMode must be "raw"' });
    expect(profileCtx.isReachable).not.toHaveBeenCalled();
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it("retries a transient reachability miss before mutating a tab", async () => {
    vi.useFakeTimers();
    const isReachable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const profileCtx = createProfileContext({ isReachable });

    try {
      const pending = callTabsAction({
        body: { action: "close", index: 0 },
        profileCtx,
      });
      await vi.runAllTimersAsync();
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(isReachable).toHaveBeenCalledTimes(2);
      expect(profileCtx.closeTab).toHaveBeenCalledWith("T1", { exactTargetId: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry or mutate after cancellation during the retry delay", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const isReachable = vi.fn(async () => false);
    const profileCtx = createProfileContext({ isReachable });

    try {
      const pending = callTabsAction({
        body: { action: "close", index: 0 },
        profileCtx,
        signal: abort.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(isReachable).toHaveBeenCalledTimes(1);

      const abortReason = new Error("cancelled");
      abort.abort(abortReason);
      await vi.runAllTimersAsync();
      const response = await pending;

      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({ error: "Error: cancelled" });
      expect(isReachable).toHaveBeenCalledTimes(1);
      expect(profileCtx.closeTab).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured action timeout for existing-session tab reachability", async () => {
    const isReachable = vi.fn(async () => true);
    const abort = new AbortController();
    const profileCtx = createProfileContext({
      profile: {
        ...baseProfileContext().profile,
        driver: "existing-session",
      } as never,
      isReachable,
    });

    const listResponse = await callTabsList({ profileCtx, signal: abort.signal });
    const actionResponse = await callTabsAction({
      profileCtx,
      body: { action: "list" },
      signal: abort.signal,
    });

    expect(listResponse.statusCode).toBe(200);
    expect(actionResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenNthCalledWith(1, 45_000, { signal: abort.signal });
    expect(isReachable).toHaveBeenNthCalledWith(2, 45_000, { signal: abort.signal });
  });

  it("keeps the short reachability probe for non-Chrome-MCP tab routes", async () => {
    const isReachable = vi.fn(async () => true);
    const profileCtx = createProfileContext({ isReachable });

    const response = await callTabsList({ profileCtx });

    expect(response.statusCode).toBe(200);
    expect(isReachable).toHaveBeenCalledWith(300, { signal: expect.any(AbortSignal) });
  });

  it("normalizes configured existing-session tab reachability timeouts", async () => {
    const isReachable = vi.fn(async () => true);
    const profileCtx = createProfileContext({
      profile: {
        ...baseProfileContext().profile,
        driver: "existing-session",
      } as never,
      isReachable,
    });

    const zeroResponse = await callTabsList({ profileCtx, actionTimeoutMs: 0 });
    expect(zeroResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenLastCalledWith(300, { signal: expect.any(AbortSignal) });

    const hugeResponse = await callTabsList({
      profileCtx,
      actionTimeoutMs: Number.MAX_SAFE_INTEGER,
    });
    expect(hugeResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenLastCalledWith(MAX_TIMER_TIMEOUT_MS, {
      signal: expect.any(AbortSignal),
    });
  });

  it("redacts blocked tab URLs from GET /tabs", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        const url = opts?.url ?? "";
        if (url.includes("169.254.169.254")) {
          throw new Error("blocked");
        }
      },
    );
    const profileCtx = createProfileWithTabs([publicTab(), internalTab()]);

    const response = await callTabsList({
      profileCtx,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      running: true,
      tabs: [
        {
          ...publicTab(),
        },
        {
          ...internalTab(),
          url: "",
        },
      ],
    });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(2);
  });

  it("blocks /tabs/focus when target tab URL fails SSRF checks", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      ssrfBlockedError(),
    );
    const profileCtx = createProfileWithTabs([internalTab()]);

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T2" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(400);
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("does not create a tab for /tabs/focus when target is missing", async () => {
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => []),
    });

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T404" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(404);
    expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("returns conflict for ambiguous target-id prefixes in /tabs/focus", async () => {
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [
        {
          targetId: "T1abc",
          title: "Tab 1",
          url: "https://example.com",
          type: "page",
        },
        {
          targetId: "T1def",
          title: "Tab 2",
          url: "https://example.org",
          type: "page",
        },
      ]),
    });

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T1" },
    });

    expect(response.statusCode).toBe(409);
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("returns conflict when an exact tab reference identifies different tabs", async () => {
    const profileCtx = createProfileWithTabs([
      publicTab({
        targetId: "T1_RAW",
        suggestedTargetId: "T2_RAW",
        tabId: "t1",
        label: "T2_RAW",
      }),
      publicTab({
        targetId: "T2_RAW",
        suggestedTargetId: "t2",
        tabId: "t2",
        url: "https://example.org",
      }),
    ]);

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T2_RAW" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: "ambiguous browser tab reference" });
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("resolves friendly tab references before focusing tabs", async () => {
    const profileCtx = createProfileWithTabs([
      publicTab({
        targetId: "T1_RAW",
        suggestedTargetId: "docs",
        tabId: "t1",
        label: "docs",
      }),
      publicTab({
        targetId: "T2_RAW",
        suggestedTargetId: "T1_RAW",
        tabId: "t2",
        label: "T1_RAW",
        url: "https://example.org",
      }),
    ]);

    const labelResponse = await callTabsFocus({
      profileCtx,
      body: { targetId: "docs" },
    });
    const tabIdResponse = await callTabsFocus({
      profileCtx,
      body: { targetId: "t1" },
    });

    expect(labelResponse.statusCode).toBe(200);
    expect(tabIdResponse.statusCode).toBe(200);
    expect(profileCtx.focusTab).toHaveBeenNthCalledWith(1, "T1_RAW", {
      exactTargetId: true,
    });
    expect(profileCtx.focusTab).toHaveBeenNthCalledWith(2, "T1_RAW", {
      exactTargetId: true,
    });
  });

  it("blocks /tabs/action select when target tab URL fails SSRF checks", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      ssrfBlockedError(),
    );
    const profileCtx = createProfileWithTabs([publicTab(), internalTab()]);

    const response = await callTabsAction({
      body: { action: "select", index: 1 },
      profileCtx,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(400);
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("does not run SSRF result validation for /tabs/focus when policy is not configured", async () => {
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [internalTab()]),
    });

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T2" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, targetId: "T2" });
    expect(profileCtx.focusTab).toHaveBeenCalledWith("T2", { exactTargetId: true });
    expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("does not run SSRF result validation for /tabs/action select when policy is not configured", async () => {
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [publicTab(), internalTab()]),
    });

    const response = await callTabsAction({
      body: { action: "select", index: 1 },
      profileCtx,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, targetId: "T2" });
    expect(profileCtx.focusTab).toHaveBeenCalledWith("T2", { exactTargetId: true });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("rejects invalid tab action indexes instead of treating them as omitted", async () => {
    const profileCtx = createProfileContext();

    const closeResponse = await callTabsAction({
      body: { action: "close", index: "nope" },
      profileCtx,
    });
    const selectResponse = await callTabsAction({
      body: { action: "select", index: "1e0" },
      profileCtx,
    });
    const nullSelectResponse = await callTabsAction({
      body: { action: "select", index: null },
      profileCtx,
    });

    expect(closeResponse.statusCode).toBe(400);
    expect(closeResponse.body).toEqual({ error: "index must be a non-negative integer" });
    expect(selectResponse.statusCode).toBe(400);
    expect(selectResponse.body).toEqual({ error: "index must be a non-negative integer" });
    expect(nullSelectResponse.statusCode).toBe(400);
    expect(nullSelectResponse.body).toEqual({ error: "index must be a non-negative integer" });
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("labels tabs by friendly target handles", async () => {
    const profileCtx = createProfileContext();

    const response = await callTabsAction({
      body: { action: "label", targetId: "t1", label: "meet" },
      profileCtx,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      tab: {
        targetId: "T1",
        suggestedTargetId: "meet",
        tabId: "t1",
        label: "meet",
        title: "Tab 1",
        url: "https://example.com",
        type: "page",
      },
    });
    expect(profileCtx.labelTab).toHaveBeenCalledWith("t1", "meet");
  });

  it("redacts blocked tab URLs for /tabs/action list", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        const url = opts?.url ?? "";
        if (url.includes("10.0.0.5")) {
          throw new Error("blocked");
        }
      },
    );
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [
        publicTab(),
        internalTab({
          title: "Private Admin",
          url: "http://10.0.0.5/admin",
        }),
      ]),
    });

    const response = await callTabsAction({
      body: { action: "list" },
      profileCtx,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      tabs: [
        {
          ...publicTab(),
        },
        {
          ...internalTab({ title: "Private Admin" }),
          url: "",
        },
      ],
    });
  });
});
