// Admin Http Rpc tests cover handler plugin behavior.
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminHttpRpcRequest } from "./handler.js";
import { listAdminHttpRpcAllowedMethods } from "./methods.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string | number | readonly string[]>;
  body: string;
};

function createRequest(body: unknown, method = "POST") {
  const req = Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
  Object.assign(req, {
    method,
    url: "/api/v1/admin/rpc",
    headers: {
      "content-type": "application/json",
    },
  });
  return req as import("node:http").IncomingMessage;
}

function createHangingRequest() {
  const req = new Readable({
    read() {
      // Keep the body open so the handler's request-body timeout owns settlement.
    },
  });
  Object.assign(req, {
    method: "POST",
    url: "/api/v1/admin/rpc",
    headers: {
      "content-type": "application/json",
    },
  });
  return req as import("node:http").IncomingMessage;
}

function createResponse() {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: "",
  };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as import("node:http").ServerResponse;
  return { res, captured };
}

async function invoke(body: unknown, method = "POST") {
  return invokeRequest(createRequest(body, method));
}

async function invokeRequest(req: import("node:http").IncomingMessage) {
  const { res, captured } = createResponse();
  const handled = await handleAdminHttpRpcRequest(req, res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as unknown) : undefined,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return address.port;
}

async function readSocketResponse(socket: Socket): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });
}

describe("admin-http-rpc plugin handler", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
  });

  it("returns the allowlist without dispatching through the Gateway", async () => {
    const result = await invoke({ id: "1", method: "commands.list" });

    expect(result.handled).toBe(true);
    expect(result.captured.statusCode).toBe(200);
    expect(result.json).toEqual({
      id: "1",
      ok: true,
      payload: {
        methods: listAdminHttpRpcAllowedMethods(),
      },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("dispatches allowed methods through the authenticated plugin request scope", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: { status: "ok" },
      meta: { requestId: "abc" },
    });

    const result = await invoke({
      id: "cfg",
      method: "config.get",
      params: { path: "gateway" },
    });

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("config.get", { path: "gateway" });
    expect(result.captured.statusCode).toBe(200);
    expect(result.json).toEqual({
      id: "cfg",
      ok: true,
      payload: { status: "ok" },
      meta: { requestId: "abc" },
    });
  });

  it.each([
    ["web.login.start", { force: true, timeoutMs: 1000 }],
    ["web.login.wait", { timeoutMs: 1000 }],
  ] as const)(
    "allows web QR login method %s through the authenticated plugin request scope",
    async (method, params) => {
      dispatchGatewayMethod.mockResolvedValueOnce({
        ok: true,
        payload: { status: "ok" },
      });

      const result = await invoke({
        id: "web-login",
        method,
        params,
      });

      expect(dispatchGatewayMethod).toHaveBeenCalledWith(method, params);
      expect(result.captured.statusCode).toBe(200);
      expect(result.json).toEqual({
        id: "web-login",
        ok: true,
        payload: { status: "ok" },
      });
    },
  );

  it.each([
    ["gateway.suspend.prepare", { requestId: "host-request-1" }],
    ["gateway.suspend.status", { suspensionId: "suspension-1" }],
    ["gateway.suspend.resume", { suspensionId: "suspension-1" }],
  ] as const)("dispatches suspension method %s through Admin HTTP", async (method, params) => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: { status: "ok" },
    });

    const result = await invoke({ id: "suspension", method, params });

    expect(dispatchGatewayMethod).toHaveBeenCalledWith(method, params);
    expect(result.captured.statusCode).toBe(200);
    expect(result.json).toEqual({
      id: "suspension",
      ok: true,
      payload: { status: "ok" },
    });
  });

  it("rejects methods outside the admin HTTP RPC allowlist", async () => {
    const result = await invoke({ id: "bad", method: "sessions.send" });

    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(result.captured.statusCode).toBe(400);
    expect(result.json).toEqual({
      id: "bad",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "admin HTTP RPC method is not supported: sessions.send",
      },
    });
  });

  it("maps Gateway errors to HTTP status codes", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: false,
      error: { code: "NOT_PAIRED", message: "pair first" },
    });

    const result = await invoke({ id: "node", method: "node.list" });

    expect(result.captured.statusCode).toBe(409);
    expect(result.json).toEqual({
      id: "node",
      ok: false,
      error: { code: "NOT_PAIRED", message: "pair first" },
    });
  });

  it("rejects invalid request bodies before dispatch", async () => {
    const result = await invoke({ id: "missing" });

    expect(result.captured.statusCode).toBe(400);
    expect(result.json).toEqual({
      ok: false,
      error: {
        type: "invalid_request",
        message: "method must be a non-empty string",
      },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("only accepts POST", async () => {
    const result = await invoke({ method: "status" }, "GET");

    expect(result.captured.statusCode).toBe(405);
    expect(result.captured.headers.allow).toBe("POST");
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("times out incomplete request bodies before dispatch", async () => {
    vi.useFakeTimers();
    try {
      const resultPromise = invokeRequest(createHangingRequest());
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;

      expect(result.handled).toBe(true);
      expect(result.captured.statusCode).toBe(408);
      expect(result.json).toEqual({
        ok: false,
        error: {
          type: "invalid_request",
          message: "Request body timeout",
        },
      });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a real HTTP 408 response before closing timed-out partial bodies", async () => {
    vi.useFakeTimers();
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const server = createServer((req, res) => {
      void handleAdminHttpRpcRequest(req, res);
      markRequestStarted?.();
    });
    let socket: Socket | undefined;
    try {
      const port = await listen(server);
      socket = connect({ host: "127.0.0.1", port });
      await new Promise<void>((resolve) => {
        socket?.once("connect", resolve);
      });

      socket.write(
        [
          "POST /api/v1/admin/rpc HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Content-Length: 64",
          "Connection: close",
          "",
          "{",
        ].join("\r\n"),
      );

      await requestStarted;
      const responsePromise = readSocketResponse(socket);
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await responsePromise;
      const [, rawBody = ""] = response.split("\r\n\r\n", 2);

      expect(response).toContain("HTTP/1.1 408");
      expect(response).toContain("Connection: close");
      expect(JSON.parse(rawBody) as unknown).toEqual({
        ok: false,
        error: {
          type: "invalid_request",
          message: "Request body timeout",
        },
      });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      socket?.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
