import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = vi.hoisted(() => ({
  driver: "openclaw",
  cookiesGetViaPlaywright: vi.fn(async () => ({ cookies: [] })),
  cookiesSetManyViaPlaywright: vi.fn(async () => ({ added: 2 })),
  setDeviceViaPlaywright: vi.fn(async () => {}),
  setHttpCredentialsViaPlaywright: vi.fn(async () => {}),
  storageSetViaPlaywright: vi.fn(async () => {}),
  storageClearViaPlaywright: vi.fn(async () => {}),
  withPlaywrightRouteContext: vi.fn(),
}));

vi.mock("./agent.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent.shared.js")>()),
  resolveProfileContext: () => ({ profile: { driver: routeState.driver } }),
  withPlaywrightRouteContext: routeState.withPlaywrightRouteContext,
}));

const { registerBrowserAgentStorageRoutes } = await import("./agent.storage.js");

type PlaywrightRouteParams = {
  req: BrowserRequest;
  run: (ctx: {
    cdpUrl: string;
    tab: { targetId: string };
    signal: AbortSignal;
    pw: {
      cookiesGetViaPlaywright: typeof routeState.cookiesGetViaPlaywright;
      cookiesSetManyViaPlaywright: typeof routeState.cookiesSetManyViaPlaywright;
      setDeviceViaPlaywright: typeof routeState.setDeviceViaPlaywright;
      setHttpCredentialsViaPlaywright: typeof routeState.setHttpCredentialsViaPlaywright;
      storageSetViaPlaywright: typeof routeState.storageSetViaPlaywright;
      storageClearViaPlaywright: typeof routeState.storageClearViaPlaywright;
    };
  }) => Promise<unknown>;
};

function getPostHandler(route: string) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, {} as never);
  const handler = postHandlers.get(route);
  expect(handler).toBeTypeOf("function");
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeState.driver = "openclaw";
  routeState.withPlaywrightRouteContext
    .mockReset()
    .mockImplementation(async (params: PlaywrightRouteParams) => {
      await params.run({
        cdpUrl: "http://127.0.0.1:18800",
        tab: { targetId: "tab-1" },
        signal: params.req.signal ?? new AbortController().signal,
        pw: routeState,
      });
    });
});

describe("browser device route", () => {
  it.each([
    { route: "/set/device", body: { name: "iPhone 15" } },
    { route: "/set/media", body: { colorScheme: "dark" } },
    { route: "/set/timezone", body: { timezoneId: "America/New_York" } },
    { route: "/set/locale", body: { locale: "en-US" } },
  ])("rejects existing-session $route with a supported alternative", async ({ route, body }) => {
    routeState.driver = "existing-session";
    const response = createBrowserRouteResponse();
    await getPostHandler(route)?.({ params: {}, query: {}, body }, response.res);
    expect(response.statusCode).toBe(501);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("managed browser profile"),
    });
    expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
  });

  it("forwards the route lease signal into the atomic device transition", async () => {
    const controller = new AbortController();
    const response = createBrowserRouteResponse();

    await getPostHandler("/set/device")?.(
      {
        params: {},
        query: {},
        body: { targetId: "tab-1", name: "iPhone 14" },
        signal: controller.signal,
      },
      response.res,
    );

    expect(routeState.setDeviceViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      name: "iPhone 14",
      signal: controller.signal,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1" });
    expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "device emulation" }),
    );
    expect(routeState.withPlaywrightRouteContext.mock.calls[0]?.[0]).not.toHaveProperty(
      "enforceCurrentUrlAllowed",
    );
  });

  it("never publishes a successful mutation after its route lease is canceled", async () => {
    const controller = new AbortController();
    const response = createBrowserRouteResponse();
    routeState.setDeviceViaPlaywright.mockImplementationOnce(async () => controller.abort());

    await expect(
      getPostHandler("/set/device")?.(
        {
          params: {},
          query: {},
          body: { name: "iPhone 14" },
          signal: controller.signal,
        },
        response.res,
      ),
    ).rejects.toThrow();

    expect(response.body).toBeUndefined();
  });
});

describe("browser cookie batch route", () => {
  it("parses and injects a non-empty cookie batch", async () => {
    const controller = new AbortController();
    const response = createBrowserRouteResponse();
    const cookies = [
      {
        name: "session",
        value: "secret",
        domain: ".example.com",
        path: "/",
        expires: 1_700_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      { name: "theme", value: "dark", url: "https://example.com" },
    ];

    await getPostHandler("/cookies/set-many")?.(
      {
        params: {},
        query: {},
        body: { targetId: "requested-tab", cookies },
        signal: controller.signal,
      },
      response.res,
    );

    expect(routeState.cookiesSetManyViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      cookies,
      signal: controller.signal,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1", added: 2 });
  });

  it.each([
    ["missing", {}],
    ["empty", { cookies: [] }],
    ["non-array", { cookies: {} }],
  ])("rejects a %s cookies payload", async (_label, body) => {
    const response = createBrowserRouteResponse();

    await getPostHandler("/cookies/set-many")?.({ params: {}, query: {}, body }, response.res);

    expect(response.statusCode).toBe(400);
    expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
    expect(routeState.cookiesSetManyViaPlaywright).not.toHaveBeenCalled();
  });
});

describe("browser storage route boundaries", () => {
  it.each([
    { kind: "local", operation: "set", value: "  preserved  " },
    { kind: "session", operation: "set", value: "" },
    { kind: "local", operation: "clear", value: undefined },
    { kind: "session", operation: "clear", value: undefined },
  ] as const)(
    "parses $kind storage $operation before dispatch",
    async ({ kind, operation, value }) => {
      const response = createBrowserRouteResponse();
      await getPostHandler(`/storage/:kind/${operation}`)?.(
        {
          params: { kind: ` ${kind} ` },
          query: {},
          body: { targetId: " requested-tab ", key: " key ", value },
        },
        response.res,
      );

      expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ targetId: "requested-tab", feature: `storage ${operation}` }),
      );
      const mutation =
        operation === "set"
          ? routeState.storageSetViaPlaywright
          : routeState.storageClearViaPlaywright;
      expect(mutation).toHaveBeenCalledExactlyOnceWith({
        cdpUrl: "http://127.0.0.1:18800",
        targetId: "tab-1",
        kind,
        ...(operation === "set" ? { key: "key", value } : {}),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ ok: true, targetId: "tab-1" });
    },
  );

  it.each(["set", "clear"])(
    "rejects an invalid storage kind before %s dispatch",
    async (operation) => {
      const response = createBrowserRouteResponse();
      await getPostHandler(`/storage/:kind/${operation}`)?.(
        {
          params: { kind: "invalid" },
          query: {},
          body: {
            key: "",
            targetId: " requested-tab ",
          },
        },
        response.res,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: "kind must be local|session" });
      expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
      expect(routeState.storageSetViaPlaywright).not.toHaveBeenCalled();
      expect(routeState.storageClearViaPlaywright).not.toHaveBeenCalled();
    },
  );

  it("keeps cookie reads behind the current-tab URL guard", async () => {
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserAgentStorageRoutes(app, {} as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/cookies")?.({ params: {}, query: {} }, response.res);

    expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "cookies", enforceCurrentUrlAllowed: true }),
    );
    expect(response.body).toEqual({ ok: true, targetId: "tab-1", cookies: [] });
  });

  it("applies HTTP credentials without ever returning the password", async () => {
    const response = createBrowserRouteResponse();

    await getPostHandler("/set/credentials")?.(
      {
        params: {},
        query: {},
        body: { username: "browser-user", password: "sensitive-browser-password" },
      },
      response.res,
    );

    expect(routeState.setHttpCredentialsViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      username: "browser-user",
      password: "sensitive-browser-password",
      clear: false,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1" });
    expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "http credentials" }),
    );
  });
});
