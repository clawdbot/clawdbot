/**
 * Tests timeout behavior for gateway HTTP hook request handling.
 */
import { createServer } from "node:http";
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
  if (!retryAfterCall) {
    throw new Error("Expected Retry-After header call");
  }
  const retryAfterValue = retryAfterCall[1];
  expect(typeof retryAfterValue).toBe("string");
  expect(Number.parseInt(String(retryAfterValue), 10)).toBeGreaterThan(0);
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn(() => ({ eventOutcome: "queued" as const }));
    const dispatchAgentHook = vi.fn(() => ({ ok: true as const, runId: "run-1" }));
    const handler = createHooksHandler({ dispatchWakeHook, dispatchAgentHook });
    const tasks: Promise<boolean>[] = [];
    const server = createServer((req, res) => {
      tasks.push(handler(req, res));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing listener");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/hooks/wake`, {
        method: "POST",
        headers: { Authorization: "Bearer hook-secret" },
        body: "{}",
      });
      expect(response.status).toBe(408);
      expect(response.headers.get("connection")).toBe("close");
      expect(await response.json()).toEqual({ ok: false, error: "request body timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(await Promise.all(tasks)).toEqual([true]);
    }
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test.each([
    [409, "session changed"],
    [502, "provider preparation failed"],
    [503, "hook agent run did not start before admission timeout"],
  ] as const)("returns %s for typed agent admission failures", async (statusCode, error) => {
    readJsonBodyMock.mockResolvedValue({ ok: true, value: { message: "Dispatch" } });
    const dispatchAgentHook = vi.fn(async () => ({
      ok: false as const,
      statusCode,
      error,
      runId: "run-1",
    }));
    const handler = createHooksHandler({ dispatchAgentHook });
    const req = createHookRequest({ url: "/hooks/agent" });
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(statusCode);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error, runId: "run-1" }));
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
