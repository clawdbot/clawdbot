import type { IncomingMessage, ServerResponse } from "node:http";

import { readJsonBody } from "./hooks.js";

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendText(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

export function sendMethodNotAllowed(res: ServerResponse, allow = "POST") {
  res.setHeader("Allow", allow);
  sendText(res, 405, "Method Not Allowed");
}

export function sendUnauthorized(res: ServerResponse) {
  sendJson(res, 401, {
    error: { message: "Unauthorized", type: "unauthorized" },
  });
}

export function sendRateLimited(res: ServerResponse) {
  sendJson(res, 429, {
    error: { message: "Too many requests", type: "rate_limited" },
  });
}

export function sendInvalidRequest(res: ServerResponse, message: string) {
  sendJson(res, 400, {
    error: { message, type: "invalid_request_error" },
  });
}

export async function readJsonBodyOrError(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<unknown> {
  const body = await readJsonBody(req, maxBytes);
  if (!body.ok) {
    sendInvalidRequest(res, body.error);
    return undefined;
  }
  return body.value;
}

export function writeDone(res: ServerResponse) {
  res.write("data: [DONE]\n\n");
}

export function setSseHeaders(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}
