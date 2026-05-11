import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createBrowserControlContextMock,
  createBrowserRouteDispatcherMock,
  loadConfigMock,
  startBrowserControlServiceFromConfigMock,
  withTimeoutMock,
} = vi.hoisted(() => ({
  createBrowserControlContextMock: vi.fn(() => ({ ok: true })),
  createBrowserRouteDispatcherMock: vi.fn(),
  loadConfigMock: vi.fn(),
  startBrowserControlServiceFromConfigMock: vi.fn(),
  withTimeoutMock: vi.fn(),
}));

vi.mock("../core-api.js", async () => {
  const actual = await vi.importActual<typeof import("../core-api.js")>("../core-api.js");
  return {
    ...actual,
    createBrowserControlContext: createBrowserControlContextMock,
    createBrowserRouteDispatcher: createBrowserRouteDispatcherMock,
    loadConfig: loadConfigMock,
    startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
    withTimeout: withTimeoutMock,
  };
});

import { browserHandlers } from "./browser-request.js";

describe("browser.request local timeout", () => {
  beforeEach(() => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "off" } } },
    });
    startBrowserControlServiceFromConfigMock.mockResolvedValue(true);
    createBrowserRouteDispatcherMock.mockReturnValue({
      dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    });
    withTimeoutMock.mockImplementation(async () => {
      throw new Error("browser request timed out");
    });
  });

  it("applies timeoutMs to local browser dispatches", async () => {
    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        timeoutMs: 4321,
      },
      respond: respond as never,
      context: {
        nodeRegistry: { listConnected: () => [] },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(withTimeoutMock).toHaveBeenCalledTimes(1);
    const [dispatchTask, timeoutMs, timeoutLabel] = withTimeoutMock.mock.calls[0];
    expect(dispatchTask).toBeTypeOf("function");
    expect(timeoutMs).toBe(4321);
    expect(timeoutLabel).toBe("browser request");
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Error: browser request timed out",
    });
  });
});
