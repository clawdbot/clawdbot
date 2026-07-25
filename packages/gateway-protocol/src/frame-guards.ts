import type { EventFrame, ResponseFrame } from "./schema/frames.js";
export type {
  ConnectParams,
  ErrorShape,
  EventFrame,
  GatewayFrame,
  HelloOk,
  RequestFrame,
  ResponseFrame,
} from "./schema/frames.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGatewayErrorShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!isNonEmptyString(value.code) || !isNonEmptyString(value.message)) {
    return false;
  }
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    return false;
  }
  return value.retryAfterMs === undefined || isNonNegativeInteger(value.retryAfterMs);
}

// These lightweight guards validate dispatch-critical envelope fields without
// compiling the full schemas or rejecting additive payload fields.
export function isGatewayEventFrame(value: unknown): value is EventFrame {
  if (!isRecord(value) || value.type !== "event" || !isNonEmptyString(value.event)) {
    return false;
  }
  return value.seq === undefined || isNonNegativeInteger(value.seq);
}

export function isGatewayResponseFrame(value: unknown): value is ResponseFrame {
  if (
    !isRecord(value) ||
    value.type !== "res" ||
    !isNonEmptyString(value.id) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.error === undefined || isGatewayErrorShape(value.error);
}
