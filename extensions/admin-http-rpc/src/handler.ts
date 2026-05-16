import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { isAdminHttpRpcAllowedMethod, listAdminHttpRpcAllowedMethods } from "./methods.js";

const DEFAULT_RPC_BODY_BYTES = 1024 * 1024;

const ErrorCodes = {
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_LINKED: "NOT_LINKED",
  NOT_PAIRED: "NOT_PAIRED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

type RpcBody = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type RpcError = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

type RpcResponse =
  | { id: string; ok: true; payload: unknown; meta?: Record<string, unknown> }
  | { id: string; ok: false; error: RpcError; meta?: Record<string, unknown> };

type ParsedRequest = {
  id: string;
  method: string;
  params?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createError(code: string, message: string): RpcError {
  return { code, message };
}

function rpcHttpStatus(response: RpcResponse): number {
  if (response.ok) {
    return 200;
  }
  switch (response.error.code) {
    case ErrorCodes.INVALID_REQUEST:
      return 400;
    case ErrorCodes.APPROVAL_NOT_FOUND:
      return 404;
    case ErrorCodes.UNAVAILABLE:
      return 503;
    case ErrorCodes.AGENT_TIMEOUT:
      return 504;
    case ErrorCodes.NOT_LINKED:
    case ErrorCodes.NOT_PAIRED:
      return 409;
    default:
      return 500;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: { type: string; message: string }) {
  sendJson(res, status, { ok: false, error });
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        return { ok: false, status: 413, message: "Payload too large" };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, message: "failed to read request body" };
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return { ok: false, status: 400, message: "request body must be JSON" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, message: "request body must be valid JSON" };
  }
}

function readRpcRequestBody(body: unknown):
  | { ok: true; request: ParsedRequest }
  | {
      ok: false;
      message: string;
    } {
  if (!isRecord(body)) {
    return { ok: false, message: "request body must be an object" };
  }
  const rpcBody = body as RpcBody;
  if (typeof rpcBody.method !== "string" || rpcBody.method.trim().length === 0) {
    return { ok: false, message: "method must be a non-empty string" };
  }
  const id =
    typeof rpcBody.id === "string" && rpcBody.id.trim().length > 0
      ? rpcBody.id.trim()
      : randomUUID();
  return {
    ok: true,
    request: {
      id,
      method: rpcBody.method.trim(),
      ...(Object.prototype.hasOwnProperty.call(rpcBody, "params")
        ? { params: rpcBody.params }
        : {}),
    },
  };
}

function methodNotAllowed(id: string, method: string): RpcResponse {
  return {
    id,
    ok: false,
    error: createError(
      ErrorCodes.INVALID_REQUEST,
      `admin HTTP RPC method is not supported: ${method}`,
    ),
  };
}

function commandsList(id: string): RpcResponse {
  return {
    id,
    ok: true,
    payload: {
      methods: listAdminHttpRpcAllowedMethods(),
    },
  };
}

async function dispatchAdminRpc(request: ParsedRequest): Promise<RpcResponse> {
  try {
    const response = await dispatchGatewayMethod(request.method, request.params);
    if (response.ok) {
      return {
        id: request.id,
        ok: true,
        payload: response.payload,
        ...(response.meta ? { meta: response.meta } : {}),
      };
    }
    return {
      id: request.id,
      ok: false,
      error:
        response.error ??
        createError(ErrorCodes.UNAVAILABLE, "gateway method failed before returning a response"),
      ...(response.meta ? { meta: response.meta } : {}),
    };
  } catch {
    return {
      id: request.id,
      ok: false,
      error: createError(
        ErrorCodes.UNAVAILABLE,
        "gateway method failed before returning a response",
      ),
    };
  }
}

export async function handleAdminHttpRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    sendError(res, 405, {
      type: "method_not_allowed",
      message: "Method Not Allowed",
    });
    return true;
  }

  const body = await readJsonBody(req, DEFAULT_RPC_BODY_BYTES);
  if (!body.ok) {
    sendError(res, body.status, {
      type: "invalid_request",
      message: body.message,
    });
    return true;
  }

  const parsed = readRpcRequestBody(body.value);
  if (!parsed.ok) {
    sendError(res, 400, {
      type: "invalid_request",
      message: parsed.message,
    });
    return true;
  }

  if (!isAdminHttpRpcAllowedMethod(parsed.request.method)) {
    const response = methodNotAllowed(parsed.request.id, parsed.request.method);
    sendJson(res, rpcHttpStatus(response), response);
    return true;
  }

  if (parsed.request.method === "commands.list") {
    const response = commandsList(parsed.request.id);
    sendJson(res, 200, response);
    return true;
  }

  const response = await dispatchAdminRpc(parsed.request);
  sendJson(res, rpcHttpStatus(response), response);
  return true;
}
