import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = vi.hoisted(() => ({
  cookiesSetManyViaPlaywright: vi.fn(async () => ({ added: 2 })),
  setDeviceViaPlaywright: vi.fn(async () => {}),
  withPlaywrightRouteContext: vi.fn(),
}));

vi.mock("./agent.shared.js", () => ({
  readBody: (req: BrowserRequest) => req.body ?? {},
  resolveTargetIdFromBody: (body: Record<string, unknown>) =>
    typeof body.targetId === "string" ? body.targetId : undefined,
  resolveTargetIdFromQuery: () => undefined,
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
      cookiesSetManyViaPlaywright: typeof routeState.cookiesSetManyViaPlaywright;
      setDeviceViaPlaywright: typeof routeState.setDeviceViaPlaywright;
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

describe("browser device route", () => {
  beforeEach(() => {
    routeState.cookiesSetManyViaPlaywright.mockClear();
    routeState.setDeviceViaPlaywright.mockClear();
    routeState.withPlaywrightRouteContext
      .mockReset()
      .mockImplementation(async (params: PlaywrightRouteParams) => {
        await params.run({
          cdpUrl: "http://127.0.0.1:18800",
          tab: { targetId: "tab-1" },
          signal: params.req.signal ?? new AbortController().signal,
          pw: {
            cookiesSetManyViaPlaywright: routeState.cookiesSetManyViaPlaywright,
            setDeviceViaPlaywright: routeState.setDeviceViaPlaywright,
          },
        });
      });
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
  });
});

describe("browser cookie batch route", () => {
  beforeEach(() => {
    routeState.cookiesSetManyViaPlaywright.mockClear();
    routeState.withPlaywrightRouteContext
      .mockReset()
      .mockImplementation(async (params: PlaywrightRouteParams) => {
        await params.run({
          cdpUrl: "http://127.0.0.1:18800",
          tab: { targetId: "tab-1" },
          signal: params.req.signal ?? new AbortController().signal,
          pw: {
            cookiesSetManyViaPlaywright: routeState.cookiesSetManyViaPlaywright,
            setDeviceViaPlaywright: routeState.setDeviceViaPlaywright,
          },
        });
      });
  });

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
