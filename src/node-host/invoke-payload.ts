import type { NodeInvokeRequestPayload } from "./invoke-types.js";

const MAX_INVOKE_INPUT_BYTES = 16 * 1024;

export function coerceNodeInvokePayload(payload: unknown): NodeInvokeRequestPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !nodeId || !command) {
    return null;
  }
  const paramsJSON =
    typeof obj.paramsJSON === "string"
      ? obj.paramsJSON
      : obj.params !== undefined
        ? JSON.stringify(obj.params)
        : null;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : null;
  const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null;
  return {
    id,
    nodeId,
    command,
    paramsJSON,
    timeoutMs,
    idempotencyKey,
  };
}

export function coerceNodeInvokeCancelPayload(
  payload: unknown,
): { invokeId: string; nodeId: string } | null {
  const value =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  return value && typeof value.invokeId === "string" && typeof value.nodeId === "string"
    ? { invokeId: value.invokeId, nodeId: value.nodeId }
    : null;
}

export function coerceNodeInvokeInputPayload(
  payload: unknown,
): { invokeId: string; nodeId: string; seq: number; payloadJSON: string } | null {
  const value =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.nodeId !== "string" ||
    !Number.isInteger(value.seq) ||
    (value.seq as number) < 0 ||
    typeof value.payloadJSON !== "string" ||
    Buffer.byteLength(value.payloadJSON, "utf8") > MAX_INVOKE_INPUT_BYTES
  ) {
    return null;
  }
  return {
    invokeId: value.id,
    nodeId: value.nodeId,
    seq: value.seq as number,
    payloadJSON: value.payloadJSON,
  };
}
