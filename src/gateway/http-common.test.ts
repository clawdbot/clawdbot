import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  readJsonBodyOrError,
  sendGatewayAuthFailure,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendRateLimited,
  sendText,
  sendUnauthorized,
  setDefaultSecurityHeaders,
  setSseHeaders,
  watchClientDisconnect,
  writeDone,
} from "./http-common.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const readJsonBodyMock = vi.hoisted(() => vi.fn());

vi.mock("./hooks.js", () => ({
  readJsonBody: readJsonBodyMock,
}));

beforeEach(() => {
  readJsonBodyMock.mockReset();
  resetDiagnosticEventsForTest();
});

describe("setDefaultSecurityHeaders", () => {
  it("sets X-Content-Type-Options", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
  });

  it("sets Referrer-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });

  it("sets Permissions-Policy that allows microphone for same-origin", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(), microphone=(self), geolocation=()",
    );
  });

  it("sets Strict-Transport-Security when provided", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    });
    expect(setHeader).toHaveBeenCalledWith(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("does not set Strict-Transport-Security when not provided", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).not.toHaveBeenCalledWith("Strict-Transport-Security", expect.anything());
  });

  it("does not set Strict-Transport-Security for empty string", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, { strictTransportSecurity: "" });
    expect(setHeader).not.toHaveBeenCalledWith("Strict-Transport-Security", expect.anything());
  });

  it("does not set Strict-Transport-Security when opts is omitted", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, undefined);
    expect(setHeader).not.toHaveBeenCalledWith("Strict-Transport-Security", expect.anything());
  });
});

describe("sendJson", () => {
  it("sets status, content-type and writes JSON body", () => {
    const { res, setHeader, end } = makeMockHttpResponse();
    sendJson(res, 201, { ok: true });
    expect(res.statusCode).toBe(201);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });
});

describe("sendText", () => {
  it("sets status, content-type and writes plain-text body", () => {
    const { res, setHeader, end } = makeMockHttpResponse();
    sendText(res, 202, "hello");
    expect(res.statusCode).toBe(202);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("hello");
  });
});

describe("sendMethodNotAllowed", () => {
  it("defaults the Allow header to POST and responds 405", () => {
    const { res, setHeader, end } = makeMockHttpResponse();
    sendMethodNotAllowed(res);
    expect(setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.statusCode).toBe(405);
    expect(end).toHaveBeenCalledWith("Method Not Allowed");
  });

  it("honours a custom Allow header value", () => {
    const { res, setHeader } = makeMockHttpResponse();
    sendMethodNotAllowed(res, "GET, POST");
    expect(setHeader).toHaveBeenCalledWith("Allow", "GET, POST");
  });
});

describe("sendUnauthorized", () => {
  it("responds with 401 and a structured unauthorized payload", () => {
    const { res, end } = makeMockHttpResponse();
    sendUnauthorized(res);
    expect(res.statusCode).toBe(401);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized" } }),
    );
  });
});

describe("sendRateLimited", () => {
  it("responds with 429 and no Retry-After when retryAfterMs is omitted", () => {
    const { res, setHeader, end } = makeMockHttpResponse();
    sendRateLimited(res);
    expect(res.statusCode).toBe(429);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        error: {
          message: "Too many failed authentication attempts. Please try again later.",
          type: "rate_limited",
        },
      }),
    );
  });

  it("responds with 429 and no Retry-After when retryAfterMs is zero", () => {
    const { res, setHeader } = makeMockHttpResponse();
    sendRateLimited(res, 0);
    expect(res.statusCode).toBe(429);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
  });

  it("responds with 429 and no Retry-After when retryAfterMs is negative", () => {
    const { res, setHeader } = makeMockHttpResponse();
    sendRateLimited(res, -500);
    expect(res.statusCode).toBe(429);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
  });

  it("sets Retry-After (seconds, ceiled) when retryAfterMs is positive", () => {
    const { res, setHeader } = makeMockHttpResponse();
    sendRateLimited(res, 1500);
    expect(res.statusCode).toBe(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "2");
  });
});

describe("sendGatewayAuthFailure", () => {
  it("delegates to sendRateLimited when the auth result is rate limited", () => {
    const { res, setHeader, end } = makeMockHttpResponse();
    const authResult = { ok: false, rateLimited: true, retryAfterMs: 3000 } as GatewayAuthResult;
    sendGatewayAuthFailure(res, authResult);
    expect(res.statusCode).toBe(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "3");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("delegates to sendUnauthorized when the auth result is not rate limited", () => {
    const { res, end } = makeMockHttpResponse();
    const authResult = { ok: false, rateLimited: false } as GatewayAuthResult;
    sendGatewayAuthFailure(res, authResult);
    expect(res.statusCode).toBe(401);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized" } }),
    );
  });
});

describe("sendInvalidRequest", () => {
  it("responds with 400 and includes the supplied message", () => {
    const { res, end } = makeMockHttpResponse();
    sendInvalidRequest(res, "bad input");
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: { message: "bad input", type: "invalid_request_error" } }),
    );
  });
});

describe("readJsonBodyOrError", () => {
  const makeRequest = () => ({}) as IncomingMessage;

  it("returns the parsed body on success", async () => {
    readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: { hello: "world" } });
    const { res } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(makeRequest(), res, 1024);
    expect(result).toEqual({ hello: "world" });
    expect(readJsonBodyMock).toHaveBeenCalledWith(expect.anything(), 1024);
  });

  it("responds with 413 when the body is too large", async () => {
    readJsonBodyMock.mockResolvedValueOnce({ ok: false, error: "payload too large" });
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const { res, end } = makeMockHttpResponse();
    const req = { headers: { "content-length": "2048" } } as IncomingMessage;
    const result = await readJsonBodyOrError(req, res, 1024);
    stop();
    expect(result).toBeUndefined();
    expect(res.statusCode).toBe(413);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        error: { message: "Payload too large", type: "invalid_request_error" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "payload.large",
        surface: "gateway.http.json",
        action: "rejected",
        bytes: 2048,
        limitBytes: 1024,
        reason: "json_body_limit",
      }),
    );
  });

  it("responds with 408 when the request body times out", async () => {
    readJsonBodyMock.mockResolvedValueOnce({ ok: false, error: "request body timeout" });
    const { res, end } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(makeRequest(), res, 1024);
    expect(result).toBeUndefined();
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        error: { message: "Request body timeout", type: "invalid_request_error" },
      }),
    );
  });

  it("responds with 400 for other parse failures", async () => {
    readJsonBodyMock.mockResolvedValueOnce({ ok: false, error: "bad json" });
    const { res, end } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(makeRequest(), res, 1024);
    expect(result).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: { message: "bad json", type: "invalid_request_error" } }),
    );
  });
});

describe("writeDone", () => {
  it("writes the SSE termination sentinel to the response stream", () => {
    const { res } = makeMockHttpResponse();
    const write = vi.spyOn(res, "write");
    writeDone(res);
    expect(write).toHaveBeenCalledWith("data: [DONE]\n\n");
  });
});

describe("setSseHeaders", () => {
  it("sets the SSE headers and calls flushHeaders when present", () => {
    const { res, setHeader } = makeMockHttpResponse();
    const flushHeaders = vi.fn();
    (res as unknown as { flushHeaders: () => void }).flushHeaders = flushHeaders;
    setSseHeaders(res);
    expect(res.statusCode).toBe(200);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream; charset=utf-8");
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(flushHeaders).toHaveBeenCalledTimes(1);
  });

  it("skips flushHeaders gracefully when the response does not expose one", () => {
    const { res, setHeader } = makeMockHttpResponse();
    // Ensure flushHeaders is not defined on the mock response.
    expect((res as unknown as { flushHeaders?: () => void }).flushHeaders).toBeUndefined();
    expect(() => setSseHeaders(res)).not.toThrow();
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream; charset=utf-8");
  });
});

describe("watchClientDisconnect", () => {
  function buildReqRes(
    reqSocket: EventEmitter | null,
    resSocket: EventEmitter | null,
  ): { req: IncomingMessage; res: ServerResponse } {
    return {
      req: { socket: reqSocket } as unknown as IncomingMessage,
      res: { socket: resSocket } as unknown as ServerResponse,
    };
  }

  it("returns a no-op cleanup when no sockets are available", () => {
    const { req, res } = buildReqRes(null, null);
    const controller = new AbortController();
    const cleanup = watchClientDisconnect(req, res, controller);
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts the controller and calls onDisconnect when a socket closes", () => {
    const socket = new EventEmitter();
    const { req, res } = buildReqRes(socket, socket);
    const controller = new AbortController();
    const onDisconnect = vi.fn();
    watchClientDisconnect(req, res, controller, onDisconnect);
    socket.emit("close");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not double-abort when the controller is already aborted", () => {
    const socket = new EventEmitter();
    const { req, res } = buildReqRes(socket, null);
    const controller = new AbortController();
    controller.abort();
    const abortSpy = vi.spyOn(controller, "abort");
    const onDisconnect = vi.fn();
    watchClientDisconnect(req, res, controller, onDisconnect);
    socket.emit("close");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("works without an onDisconnect callback", () => {
    const socket = new EventEmitter();
    const { req, res } = buildReqRes(null, socket);
    const controller = new AbortController();
    watchClientDisconnect(req, res, controller);
    socket.emit("close");
    expect(controller.signal.aborted).toBe(true);
  });

  it("deduplicates identical request and response sockets", () => {
    const socket = new EventEmitter();
    const onSpy = vi.spyOn(socket, "on");
    const { req, res } = buildReqRes(socket, socket);
    const controller = new AbortController();
    watchClientDisconnect(req, res, controller);
    expect(onSpy).toHaveBeenCalledTimes(1);
  });

  it("registers handlers on distinct request and response sockets", () => {
    const reqSocket = new EventEmitter();
    const resSocket = new EventEmitter();
    const reqOn = vi.spyOn(reqSocket, "on");
    const resOn = vi.spyOn(resSocket, "on");
    const { req, res } = buildReqRes(reqSocket, resSocket);
    const controller = new AbortController();
    watchClientDisconnect(req, res, controller);
    expect(reqOn).toHaveBeenCalledWith("close", expect.any(Function));
    expect(resOn).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("cleanup detaches the close listener from each socket", () => {
    const socket = new EventEmitter();
    const { req, res } = buildReqRes(socket, null);
    const controller = new AbortController();
    const cleanup = watchClientDisconnect(req, res, controller);
    expect(socket.listenerCount("close")).toBe(1);
    cleanup();
    expect(socket.listenerCount("close")).toBe(0);
  });
});
