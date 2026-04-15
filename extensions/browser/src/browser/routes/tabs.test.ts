import { beforeEach, describe, expect, it, vi } from "vitest";
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
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    resetProfile: vi.fn(async () => ({ moved: false, from: "" })),
  };
}

function createRouteContext(
  profileCtx: ReturnType<typeof createProfileContext>,
  options?: { ssrfPolicy?: unknown },
) {
  return {
    state: () => ({ resolved: { ssrfPolicy: options?.ssrfPolicy } }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn((err: unknown) => {
      if (!(err instanceof Error)) {
        return null;
      }
      const status = "status" in err && typeof err.status === "number" ? err.status : 400;
      return { status, message: err.message };
    }),
    ensureBrowserAvailable: profileCtx.ensureBrowserAvailable,
    ensureTabAvailable: profileCtx.ensureTabAvailable,
    isHttpReachable: profileCtx.isHttpReachable,
    isReachable: profileCtx.isReachable,
    listTabs: profileCtx.listTabs,
    openTab: profileCtx.openTab,
    focusTab: profileCtx.focusTab,
    closeTab: profileCtx.closeTab,
    stopRunningBrowser: profileCtx.stopRunningBrowser,
    resetProfile: profileCtx.resetProfile,
  };
}

async function callTabsAction(params: {
  body: Record<string, unknown>;
  profileCtx: ReturnType<typeof createProfileContext>;
  ssrfPolicy?: unknown;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(
    app,
    createRouteContext(params.profileCtx, { ssrfPolicy: params.ssrfPolicy }) as never,
  );
  const handler = postHandlers.get("/tabs/action");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: {}, body: params.body }, response.res);
  return response;
}

async function callTabsList(params: {
  profileCtx: ReturnType<typeof createProfileContext>;
  ssrfPolicy?: unknown;
}) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(
    app,
    createRouteContext(params.profileCtx, { ssrfPolicy: params.ssrfPolicy }) as never,
  );
  const handler = getHandlers.get("/tabs");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: {}, body: {} }, response.res);
  return response;
}

async function callTabsFocus(params: {
  profileCtx: ReturnType<typeof createProfileContext>;
  body: Record<string, unknown>;
  ssrfPolicy?: unknown;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(
    app,
    createRouteContext(params.profileCtx, { ssrfPolicy: params.ssrfPolicy }) as never,
  );
  const handler = postHandlers.get("/tabs/focus");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: {}, body: params.body }, response.res);
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

  it("returns browser-not-running for close when the browser is not reachable", async () => {
    const profileCtx = createProfileContext({
      isReachable: vi.fn(async () => false),
    });

    const response = await callTabsAction({
      body: { action: "close", index: 0 },
      profileCtx,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: "browser not running" });
    expect(profileCtx.listTabs).not.toHaveBeenCalled();
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it("returns browser-not-running for select when the browser is not reachable", async () => {
    const profileCtx = createProfileContext({
      isReachable: vi.fn(async () => false),
    });

    const response = await callTabsAction({
      body: { action: "select", index: 0 },
      profileCtx,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: "browser not running" });
    expect(profileCtx.listTabs).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
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
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [
        {
          targetId: "T1",
          title: "Public",
          url: "https://example.com",
          type: "page",
        },
        {
          targetId: "T2",
          title: "Internal",
          url: "http://169.254.169.254/latest/meta-data/",
          type: "page",
        },
      ]),
    });

    const response = await callTabsList({
      profileCtx,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      running: true,
      tabs: [
        {
          targetId: "T1",
          title: "Public",
          url: "https://example.com",
          type: "page",
        },
        {
          targetId: "T2",
          title: "Internal",
          url: "",
          type: "page",
        },
      ],
    });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(2);
  });

  it("blocks /tabs/focus when target tab URL fails SSRF checks", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new Error("blocked"),
    );
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [
        {
          targetId: "T2",
          title: "Internal",
          url: "http://169.254.169.254/latest/meta-data/",
          type: "page",
        },
      ]),
    });

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

  it("blocks /tabs/action select when target tab URL fails SSRF checks", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new Error("blocked"),
    );
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [
        {
          targetId: "T1",
          title: "Public",
          url: "https://example.com",
          type: "page",
        },
        {
          targetId: "T2",
          title: "Internal",
          url: "http://169.254.169.254/latest/meta-data/",
          type: "page",
        },
      ]),
    });

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
      listTabs: vi.fn(async () => [
        {
          targetId: "T2",
          title: "Internal",
          url: "http://169.254.169.254/latest/meta-data/",
          type: "page",
        },
      ]),
    });

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T2" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(profileCtx.focusTab).toHaveBeenCalledWith("T2");
    expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("does not run SSRF result validation for /tabs/action select when policy is not configured", async () => {
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [
        {
          targetId: "T1",
          title: "Public",
          url: "https://example.com",
          type: "page",
        },
        {
          targetId: "T2",
          title: "Internal",
          url: "http://169.254.169.254/latest/meta-data/",
          type: "page",
        },
      ]),
    });

    const response = await callTabsAction({
      body: { action: "select", index: 1 },
      profileCtx,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, targetId: "T2" });
    expect(profileCtx.focusTab).toHaveBeenCalledWith("T2");
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
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
        {
          targetId: "T1",
          title: "Public",
          url: "https://example.com",
          type: "page",
        },
        {
          targetId: "T2",
          title: "Private Admin",
          url: "http://10.0.0.5/admin",
          type: "page",
        },
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
          targetId: "T1",
          title: "Public",
          url: "https://example.com",
          type: "page",
        },
        {
          targetId: "T2",
          title: "Private Admin",
          url: "",
          type: "page",
        },
      ],
    });
  });
});
