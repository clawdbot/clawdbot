/**
 * HTTP handler for the Admin RPC endpoint. It validates JSON requests, enforces
 * the method allowlist, dispatches gateway methods, and maps errors to HTTP.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readJsonBodyWithLimit,
  WEBHOOK_BODY_READ_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { isAdminHttpRpcAllowedMethod, listAdminHttpRpcAllowedMethods } from "./methods.js";

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

type RequestBodyLimitFailureCode =
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_BODY_TIMEOUT"
  | "CONNECTION_CLOSED";

type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      status: number;
      message: string;
      closeAfterResponse?: boolean;
    };

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

function statusForBodyErrorCode(code: RequestBodyLimitFailureCode): number {
  switch (code) {
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "REQUEST_BODY_TIMEOUT":
      return 408;
    case "CONNECTION_CLOSED":
      return 400;
  }
  return 400;
}

async function readAdminJsonBody(req: IncomingMessage): Promise<ReadJsonBodyResult> {
  const body = await readJsonBodyWithLimit(req, {
    ...WEBHOOK_BODY_READ_DEFAULTS.postAuth,
    emptyObjectOnEmpty: false,
    // Admin responses are part of the client contract. Defer destruction so
    // closeRequestAfterResponse can flush the JSON error before closing.
    destroyOnLimit: false,
  });
  if (body.ok) {
    return body;
  }
  if (body.code === "INVALID_JSON") {
    return {
      ok: false,
      status: 400,
      message:
        body.error === "empty payload"
          ? "request body must be JSON"
          : "request body must be valid JSON",
    };
  }
  return {
    ok: false,
    status: statusForBodyErrorCode(body.code),
    message: body.error,
    closeAfterResponse: body.code !== "CONNECTION_CLOSED",
  };
}

function closeRequestAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  const once = (res as { once?: ServerResponse["once"] }).once;
  if (typeof once !== "function") {
    return;
  }
  res.setHeader("Connection", "close");
  once.call(res, "finish", () => {
    // Timeout/size failures must flush JSON first; destroying before finish drops
    // the HTTP response on real partial-body sockets.
    if (!req.destroyed) {
      req.destroy();
    }
  });
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
      ...(Object.hasOwn(rpcBody, "params") ? { params: rpcBody.params } : {}),
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

/** Handle one gateway-authenticated Admin HTTP RPC request. */
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

  const body = await readAdminJsonBody(req);
  if (!body.ok) {
    if (body.closeAfterResponse) {
      closeRequestAfterResponse(req, res);
    }
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
