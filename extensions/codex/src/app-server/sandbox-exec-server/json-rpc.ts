import type { RawData, WebSocket } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";
import type { HttpHeader, JsonRpcRequest } from "./types.js";

export const JSON_RPC_NOT_FOUND = -32004;

export class JsonRpcProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseRequest(data: RawData): JsonRpcRequest {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  const text = buffer.toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  return requireObject(parsed, "JSON-RPC request") as JsonRpcRequest;
}

export function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function requireBase64String(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

export function readHttpHeaders(value: unknown): HttpHeader[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const record = requireObject(entry as JsonValue, `header ${index}`);
    return {
      name: requireString(record.name, "header name"),
      value: requireString(record.value, "header value"),
    };
  });
}

export function sendResult(
  socket: WebSocket,
  id: string | number,
  result: JsonValue | undefined,
): void {
  socket.send(
    JSON.stringify({ jsonrpc: "2.0", id, result: result === undefined ? {} : result }),
  );
}

export function sendError(
  socket: WebSocket,
  id: string | number | undefined,
  code: number,
  message: string,
): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
}
