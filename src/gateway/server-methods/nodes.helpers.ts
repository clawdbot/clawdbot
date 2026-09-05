// Node method helpers centralize unavailable responses, safe JSON parsing,
// and node-invoke error mapping.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { formatForLog } from "../ws-log.js";
import type { RespondFn } from "./types.js";
export { parseGatewayPayload } from "../server-json.js";

/** Converts thrown node-handler failures into `UNAVAILABLE` protocol errors. */
export async function respondUnavailableOnThrow(respond: RespondFn, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  }
}

/** Narrows successful node invoke results or responds with the node error details. */
export function respondUnavailableOnNodeInvokeError<T extends { ok: boolean; error?: unknown }>(
  respond: RespondFn,
  res: T,
): res is T & { ok: true } {
  return respondUnavailableOnNodeInvokeErrorWithProvenance(respond, res);
}

export function respondUnavailableOnNodeInvokeErrorWithProvenance<
  T extends { ok: boolean; error?: unknown },
>(
  respond: RespondFn,
  res: T,
  provenance?: { nodeCommandDispatched: boolean },
): res is T & { ok: true } {
  if (res.ok) {
    return true;
  }
  const nodeError =
    res.error && typeof res.error === "object"
      ? (res.error as { code?: unknown; message?: unknown })
      : null;
  const nodeCode = normalizeOptionalString(nodeError?.code) ?? "";
  const nodeMessage = normalizeOptionalString(nodeError?.message) ?? "node invoke failed";
  const message = nodeCode ? `${nodeCode}: ${nodeMessage}` : nodeMessage;
  const details = {
    nodeError: res.error ?? null,
    ...(provenance ? { nodeCommandDispatched: provenance.nodeCommandDispatched } : {}),
  };
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details,
    }),
  );
  return false;
}
