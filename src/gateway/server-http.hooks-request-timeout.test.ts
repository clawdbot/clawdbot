/**
 * Tests timeout behavior for gateway HTTP hook request handling.
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HookMappingResolved } from "./hooks-mapping.js";
import { createHooksConfig } from "./hooks-test-helpers.js";
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
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn(() => ({ ok: true as const, runId: "run-1" }));
    const handler = createHooksHandler({ dispatchWakeHook, dispatchAgentHook });
    const req = createHookRequest() as ReturnType<typeof createHookRequest> & {
      destroyed: boolean;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.destroyed = false;
    req.destroy = vi.fn(() => {
      req.destroyed = true;
      return req;
    });
    const res = new EventEmitter() as ServerResponse;
    res.statusCode = 200;
    const setHeader = vi.fn();
    res.setHeader = setHeader;
    const end = vi.fn();
    res.end = end;

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "request body timeout" }));
    expect(setHeader).toHaveBeenCalledWith("Connection", "close");
    expect(req.destroy).not.toHaveBeenCalled();
    res.emit("finish");
    expect(req.destroy).not.toHaveBeenCalled();
    res.emit("close");
    expect(req.destroy).toHaveBeenCalledOnce();
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

  test.each(["request abort", "response close"] as const)(
    "cancels pending agent admission on %s",
    async (disconnect) => {
      readJsonBodyMock.mockResolvedValue({ ok: true, value: { message: "Dispatch" } });
      let dispatchSignal: AbortSignal | undefined;
      const dispatchAgentHook = vi.fn(
        async (_value: unknown, context: { abortSignal: AbortSignal }) => {
          dispatchSignal = context.abortSignal;
          await new Promise<void>((resolve) => {
            context.abortSignal.addEventListener("abort", () => resolve());
          });
          return {
            ok: false as const,
            statusCode: 503 as const,
            error: "hook request disconnected before agent run started",
          };
        },
      );
      const handler = createHooksHandler({ dispatchAgentHook });
      const req = createHookRequest({ url: "/hooks/agent" });
      const { res } = createResponse();

      const handled = handler(req, res);
      await vi.waitFor(() => expect(dispatchSignal).toBeDefined());
      if (disconnect === "request abort") {
        req.emit("aborted");
      } else {
        res.emit("close");
      }

      await expect(handled).resolves.toBe(true);
      expect(dispatchSignal?.aborted).toBe(true);
    },
  );

  test("retries one disconnected idempotent request without duplicating execution", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: true, value: { message: "Dispatch" } });
    let releaseAdmission!: () => void;
    const admissionReleased = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let executionCount = 0;
    const dispatchAgentHook = vi.fn(
      async (_value: unknown, context: { abortSignal: AbortSignal }) => {
        const admitted = await Promise.race([
          admissionReleased.then(() => true),
          new Promise<false>((resolve) => {
            context.abortSignal.addEventListener("abort", () => resolve(false));
          }),
        ]);
        if (!admitted) {
          return {
            ok: false as const,
            statusCode: 503 as const,
            error: "hook request disconnected before agent run started",
          };
        }
        executionCount += 1;
        return { ok: true as const, runId: "run-retry" };
      },
    );
    const handler = createHooksHandler({ dispatchAgentHook });
    const headers = { "idempotency-key": "gmail-message-1" };
    const firstReq = createHookRequest({ url: "/hooks/agent", headers });
    const { res: firstRes } = createResponse();

    const firstHandled = handler(firstReq, firstRes);
    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));
    firstReq.emit("aborted");
    await expect(firstHandled).resolves.toBe(true);
    expect(executionCount).toBe(0);

    releaseAdmission();
    const retryReq = createHookRequest({ url: "/hooks/agent", headers });
    const { res: retryRes, end: retryEnd } = createResponse();
    await expect(handler(retryReq, retryRes)).resolves.toBe(true);

    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
    expect(executionCount).toBe(1);
    expect(retryEnd).toHaveBeenCalledWith(JSON.stringify({ ok: true, runId: "run-retry" }));
  });

  test.each([
    { name: "direct", path: "/hooks/agent", body: { message: "Dispatch" }, mappings: [] },
    {
      name: "mapped",
      path: "/hooks/mapped-retry",
      body: { subject: "Email" },
      mappings: [
        {
          id: "mapped-retry",
          matchPath: "mapped-retry",
          action: "agent" as const,
          wakeMode: "now" as const,
          messageTemplate: "Mapped: {{payload.subject}}",
        },
      ],
    },
  ])("retires an aborted $name replay before its provider settles", async (testCase) => {
    readJsonBodyMock.mockResolvedValue({ ok: true, value: testCase.body });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAborted!: () => void;
    const firstAbortObserved = new Promise<void>((resolve) => {
      firstAborted = resolve;
    });
    const dispatchAgentHook = vi
      .fn()
      .mockImplementationOnce(async (_value, context: { abortSignal: AbortSignal }) => {
        context.abortSignal.addEventListener("abort", firstAborted, { once: true });
        await firstReleased;
        return {
          ok: false as const,
          statusCode: 503 as const,
          error: "first request disconnected",
        };
      })
      .mockResolvedValueOnce({ ok: true as const, runId: "run-retry" });
    const hooksConfig = {
      ...createHooksConfig(),
      mappings: testCase.mappings as HookMappingResolved[],
    };
    const handler = createHooksHandler({ dispatchAgentHook, getHooksConfig: () => hooksConfig });
    const headers = { "idempotency-key": `retry-${testCase.name}` };
    const firstReq = createHookRequest({ url: testCase.path, headers });
    const { res: firstRes } = createResponse();
    const firstHandled = handler(firstReq, firstRes);

    try {
      await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));
      firstReq.emit("aborted");
      await firstAbortObserved;

      const retryReq = createHookRequest({ url: testCase.path, headers });
      const { res: retryRes, end: retryEnd } = createResponse();
      const retryHandled = handler(retryReq, retryRes);
      await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(2));
      await expect(retryHandled).resolves.toBe(true);
      expect(retryEnd).toHaveBeenCalledWith(JSON.stringify({ ok: true, runId: "run-retry" }));
    } finally {
      releaseFirst();
      await firstHandled;
    }
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
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
