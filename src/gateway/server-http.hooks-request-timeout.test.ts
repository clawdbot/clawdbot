import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createHookRequest,
  createHooksHandler,
  createResponse,
} from "./server-http.test-harness.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./hooks.js")>("./hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

function expectRetryAfterHeader(setHeader: ReturnType<typeof vi.fn>): void {
  const retryAfterCall = setHeader.mock.calls.find(([name]) => name === "Retry-After");
  expect(retryAfterCall).toBeDefined();
  const retryAfterValue = retryAfterCall?.[1];
  expect(typeof retryAfterValue).toBe("string");
  expect(Number.parseInt(String(retryAfterValue), 10)).toBeGreaterThan(0);
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn(() => "run-1");
    const handler = createHooksHandler({ dispatchWakeHook, dispatchAgentHook });
    const req = createHookRequest();
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "request body timeout" }));
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("shares hook auth rate-limit bucket across ipv4 and ipv4-mapped ipv6 forms", async () => {
    const handler = createHooksHandler({ bindHost: "127.0.0.1" });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "1.2.3.4",
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const mappedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "::ffff:1.2.3.4",
    });
    const { res: mappedRes, setHeader } = createResponse();
    const handled = await handler(mappedReq, mappedRes);

    expect(handled).toBe(true);
    expect(mappedRes.statusCode).toBe(429);
    expectRetryAfterHeader(setHeader);
  });

  test("uses trusted proxy forwarded client ip for hook auth throttling", async () => {
    const handler = createHooksHandler({
      getClientIpConfig: () => ({ trustedProxies: ["10.0.0.1"] }),
    });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const forwardedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });
    const { res: forwardedRes, setHeader } = createResponse();
    const handled = await handler(forwardedReq, forwardedRes);

    expect(handled).toBe(true);
    expect(forwardedRes.statusCode).toBe(429);
    expectRetryAfterHeader(setHeader);
  });

  test.each(["0.0.0.0", "::"])(
    "returns unhandled when bindHost=%s sees a non-hook request URL",
    async (bindHost) => {
      const handler = createHooksHandler({ bindHost });
      const req = createHookRequest({ url: "/" });
      const { res, end } = createResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
      expect(end).not.toHaveBeenCalled();
    },
  );
});
