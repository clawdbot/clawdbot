import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = vi.hoisted(() => ({
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
    pw: { setDeviceViaPlaywright: typeof routeState.setDeviceViaPlaywright };
  }) => Promise<unknown>;
};

function getSetDeviceHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, {} as never);
  const handler = postHandlers.get("/set/device");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("browser device route", () => {
  beforeEach(() => {
    routeState.setDeviceViaPlaywright.mockClear();
    routeState.withPlaywrightRouteContext
      .mockReset()
      .mockImplementation(async (params: PlaywrightRouteParams) => {
        await params.run({
          cdpUrl: "http://127.0.0.1:18800",
          tab: { targetId: "tab-1" },
          signal: params.req.signal ?? new AbortController().signal,
          pw: { setDeviceViaPlaywright: routeState.setDeviceViaPlaywright },
        });
      });
  });

  it("forwards the route lease signal into the atomic device transition", async () => {
    const controller = new AbortController();
    const response = createBrowserRouteResponse();

    await getSetDeviceHandler()?.(
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
