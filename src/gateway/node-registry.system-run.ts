import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PendingSystemRunEvent } from "./node-registry.invoke-stream.js";

/** Normalize system.run timeout values, preserving null for no expiry. */
export function normalizeSystemRunTimeoutMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const timeoutMs = Math.trunc(value);
  return timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 1) : null;
}

export function resolvePendingSystemRunEvent(params: {
  command: string;
  params?: unknown;
}): PendingSystemRunEvent | undefined {
  if (params.command !== "system.run" || !params.params || typeof params.params !== "object") {
    return undefined;
  }
  const obj = params.params as Record<string, unknown>;
  const runId = normalizeOptionalString(obj.runId) ?? "";
  if (!runId) {
    return undefined;
  }
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  const sessionKey = normalizeOptionalString(obj.sessionKey) ?? "";
  return {
    runId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function normalizeSystemRunInvokeParams(params: {
  command: string;
  params?: unknown;
}): unknown {
  if (
    params.command !== "system.run" ||
    !params.params ||
    typeof params.params !== "object" ||
    Array.isArray(params.params)
  ) {
    return params.params;
  }
  const obj = params.params as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    ...obj,
    runId: normalizeOptionalString(obj.runId) || randomUUID(),
  };
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  if (timeoutMs === undefined) {
    delete normalized.timeoutMs;
  } else {
    normalized.timeoutMs = timeoutMs;
  }
  return normalized;
}
