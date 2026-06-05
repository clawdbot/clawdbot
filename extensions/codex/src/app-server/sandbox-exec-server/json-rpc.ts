/**
 * JSON-RPC parsing, validation, and response helpers for the sandbox
 * exec-server WebSocket protocol.
 */
import type { RawData, WebSocket } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";
import type { HttpHeader, JsonRpcRequest } from "./types.js";

/** JSON-RPC error code used when a sandbox exec-server method is unknown. */
export const JSON_RPC_NOT_FOUND = -32004;

/** Protocol-level error carrying the JSON-RPC error code to send to the client. */
export class JsonRpcProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Parses raw WebSocket data into a JSON-RPC request object. */
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

/** Validates that a JSON value is a non-array object. */
export function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

/** Validates a non-empty string JSON-RPC parameter. */
export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

/** Validates a base64 payload parameter as a string; decoding happens at call sites. */
export function requireBase64String(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

/** Validates a finite numeric JSON-RPC parameter. */
export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

/** Validates a non-empty string-array JSON-RPC parameter. */
export function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

/** Reads HTTP headers from JSON-RPC params, defaulting to an empty header list. */
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

/** Sends a JSON-RPC success response over the WebSocket. */
export function sendResult(
  socket: WebSocket,
  id: string | number,
  result: JsonValue | undefined,
): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: result === undefined ? {} : result }));
}

/** Sends a JSON-RPC error response over the WebSocket. */
export function sendError(
  socket: WebSocket,
  id: string | number | undefined,
  code: number,
  message: string,
): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
}
