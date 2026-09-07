// Tests HTTP body reading and size-limit handling.
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import {
  installRequestBodyLimitGuard,
  RequestBodyLimitError,
  type RequestBodyLimitErrorCode,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  testApi,
} from "./http-body.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: (error?: Error) => MockIncomingMessage;
  __unhandledDestroyError?: unknown;
};

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

async function expectRequestBodyLimitError(
  promise: Promise<unknown>,
  expected: {
    code: RequestBodyLimitErrorCode;
    message: string;
    statusCode: number;
  },
) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RequestBodyLimitError);
    if (!(error instanceof RequestBodyLimitError)) {
      throw error;
    }
    expect({
      name: error.name,
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
    }).toEqual({
      name: "RequestBodyLimitError",
      message: expected.message,
      code: expected.code,
      statusCode: expected.statusCode,
    });
    return;
  }
  throw new Error("Expected request body reader to reject");
}

async function expectReadPayloadTooLarge(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  maxBytes: number;
}) {
  const req = createMockRequest({
    chunks: params.chunks,
    headers: params.headers,
    emitEnd: false,
  });
  await expectRequestBodyLimitError(readRequestBodyWithLimit(req, { maxBytes: params.maxBytes }), {
    code: "PAYLOAD_TOO_LARGE",
    message: "PayloadTooLarge",
    statusCode: 413,
  });
  await waitForMicrotaskTurn();
  expect(req["__unhandledDestroyError"]).toBeUndefined();
}

async function readJsonBody(params: {
  chunks?: string[];
  maxBytes: number;
  emptyObjectOnEmpty?: boolean;
}) {
  const req = createMockRequest({ chunks: params.chunks });
  return await readJsonBodyWithLimit(req, {
    maxBytes: params.maxBytes,
    ...(params.emptyObjectOnEmpty === undefined
      ? {}
      : { emptyObjectOnEmpty: params.emptyObjectOnEmpty }),
  });
}

function createMockRequest(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  emitEnd?: boolean;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.destroyed = false;
  req.socket = new Socket();
  req.headers = params.headers ?? {};
  req.destroy = ((error?: Error) => {
    req.destroyed = true;
    if (error) {
      // Simulate Node's async 'error' emission on destroy(err). If no listener is
      // present at that time, EventEmitter throws; capture that as "unhandled".
      queueMicrotask(() => {
        try {
          req.emit("error", error);
        } catch (err) {
          req["__unhandledDestroyError"] = err;
        }
      });
    }
    return req;
  }) as MockIncomingMessage["destroy"];

  if (params.chunks) {
    void Promise.resolve().then(() => {
      for (const chunk of params.chunks ?? []) {
        req.emit("data", Buffer.from(chunk, "utf-8"));
        if (req.destroyed) {
          return;
        }
      }
      if (params.emitEnd !== false) {
        req.emit("end");
      }
    });
  }

  return req;
}

describe("http body limits", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads body within max bytes", async () => {
    const req = createMockRequest({ chunks: ['{"ok":true}'] });
    await expect(readRequestBodyWithLimit(req, { maxBytes: 1024 })).resolves.toBe('{"ok":true}');
  });

  it.each([
    {
      name: "rejects oversized streamed body",
      chunks: ["x".repeat(512)],
      maxBytes: 64,
    },
    {
      name: "declared oversized content-length does not emit unhandled error",
      headers: { "content-length": "9999" },
      maxBytes: 128,
    },
    {
      name: "declared unsafe-integer content-length remains oversized",
      headers: { "content-length": "999999999999999999999999" },
      maxBytes: 128,
    },
  ])("$name", async ({ chunks, headers, maxBytes }) => {
    await expectReadPayloadTooLarge({ chunks, headers, maxBytes });
  });

  it.each([
    {
      name: "returns json parse error when body is invalid",
      params: { chunks: ["{bad json"], maxBytes: 1024, emptyObjectOnEmpty: false },
      assertResult: (result: Awaited<ReturnType<typeof readJsonBody>>) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("INVALID_JSON");
        }
      },
    },
    {
      name: "returns empty object for an empty body by default",
      params: { chunks: ["   "], maxBytes: 1024 },
      assertResult: (result: Awaited<ReturnType<typeof readJsonBody>>) => {
        expect(result).toEqual({ ok: true, value: {} });
      },
    },
    {
      name: "returns payload-too-large for json body",
      params: { chunks: ["x".repeat(1024)], maxBytes: 10 },
      assertResult: (result: Awaited<ReturnType<typeof readJsonBody>>) => {
        expect(result).toEqual({
          ok: false,
          code: "PAYLOAD_TOO_LARGE",
          error: "Payload too large",
        });
      },
    },
  ])("$name", async ({ params, assertResult }) => {
    const result = await readJsonBody(params);
    assertResult(result);
  });

  it("timeout surfaces typed error when timeoutMs is clamped", async () => {
    const req = createMockRequest({ emitEnd: false });
    const promise = readRequestBodyWithLimit(req, { maxBytes: 128, timeoutMs: 0 });
    await expectRequestBodyLimitError(promise, {
      code: "REQUEST_BODY_TIMEOUT",
      message: "RequestBodyTimeout",
      statusCode: 408,
    });
    expect(req["__unhandledDestroyError"]).toBeUndefined();
  });

  it("does not overflow oversized request body timeouts into immediate failures", async () => {
    expect(
      testApi.resolveRequestBodyLimitValues({
        maxBytes: 128,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      maxBytes: 128,
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });

  it("surfaces connection-closed as a typed limit error", async () => {
    const req = createMockRequest({ emitEnd: false });
    const promise = readRequestBodyWithLimit(req, { maxBytes: 128 });
    queueMicrotask(() => req.emit("close"));
    await expectRequestBodyLimitError(promise, {
      code: "CONNECTION_CLOSED",
      message: "RequestBodyConnectionClosed",
      statusCode: 400,
    });
    for (const event of ["data", "end", "error", "close"] as const) {
      expect(req.listenerCount(event), event).toBe(0);
    }
  });

  it("immediately classifies a request closed before its body reader starts", async () => {
    const req = createMockRequest({ emitEnd: false });
    req.complete = true;
    Object.defineProperty(req, "readableEnded", { value: false });
    req.destroy();
    req.emit("close");

    await expectRequestBodyLimitError(
      readRequestBodyWithLimit(req, { maxBytes: 128, timeoutMs: 1 }),
      {
        code: "CONNECTION_CLOSED",
        message: "RequestBodyConnectionClosed",
        statusCode: 400,
      },
    );
    for (const event of ["data", "end", "error", "close"] as const) {
      expect(req.listenerCount(event), event).toBe(0);
    }
  });

  it("disposes a body guard immediately when its request was already closed", () => {
    const req = createMockRequest({
      headers: { "content-length": "9999" },
      emitEnd: false,
    });
    req.complete = true;
    Object.defineProperty(req, "readableEnded", { value: false });
    req.destroy();
    req.emit("close");
    const res = createMockServerResponse();

    const guard = installRequestBodyLimitGuard(req, res, { maxBytes: 128, timeoutMs: 1 });
    try {
      expect(guard.isTripped()).toBe(false);
      expect(guard.code()).toBeNull();
      expect(res.headersSent).toBe(false);
      expect(res.body).toBeUndefined();
      for (const event of ["data", "end", "error", "close"] as const) {
        expect(req.listenerCount(event), event).toBe(0);
      }
    } finally {
      guard.dispose();
    }
  });

  it("keeps concurrent body guards, readers, and foreign request listeners independent", async () => {
    const req = createMockRequest({ chunks: ['{"ok":true}'] });
    const res = createMockServerResponse();
    const events = ["data", "end", "error", "close"] as const;
    const foreignListener = () => {};
    for (const event of events) {
      req.on(event, foreignListener);
    }

    const guard = installRequestBodyLimitGuard(req, res, { maxBytes: 128 });
    await expect(readRequestBodyWithLimit(req, { maxBytes: 128 })).resolves.toBe('{"ok":true}');

    expect(guard.isTripped()).toBe(false);
    expect(res.headersSent).toBe(false);
    for (const event of events) {
      expect(req.listeners(event)).toEqual([foreignListener]);
    }
    guard.dispose();
  });

  it("classifies request stream errors as a closed connection", async () => {
    const req = createMockRequest({ emitEnd: false });
    const promise = readJsonBodyWithLimit(req, { maxBytes: 128 });
    queueMicrotask(() => req.emit("error", new Error("socket reset")));
    await expect(promise).resolves.toEqual({
      ok: false,
      code: "CONNECTION_CLOSED",
      error: "Connection closed",
    });
  });

  it("can defer destructive limit cleanup until a response flushes", async () => {
    const req = createMockRequest({
      headers: { "content-length": "129" },
      emitEnd: false,
    });
    const pause = vi.fn();
    req.pause = pause;

    await expectRequestBodyLimitError(
      readRequestBodyWithLimit(req, { maxBytes: 128, destroyOnLimit: false }),
      {
        code: "PAYLOAD_TOO_LARGE",
        message: "PayloadTooLarge",
        statusCode: 413,
      },
    );

    expect(req.destroyed).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    req.socket.destroy();
  });
});
