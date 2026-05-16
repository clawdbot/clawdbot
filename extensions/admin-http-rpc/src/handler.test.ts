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
  const { res, captured } = createResponse();
  const handled = await handleAdminHttpRpcRequest(createRequest(body, method), res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as unknown) : undefined,
  };
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
});
