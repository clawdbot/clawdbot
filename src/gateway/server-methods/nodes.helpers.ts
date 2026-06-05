// Node method helpers centralize validation failures, unavailable responses,
// safe JSON parsing, and node-invoke error mapping.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ValidationError } from "../../../packages/gateway-protocol/src/index.js";
export { safeParseJson } from "../server-json.js";
import { formatForLog } from "../ws-log.js";
import type { RespondFn } from "./types.js";

/**
 * Shared response adapters for node-related gateway methods.
 */
type ValidatorFn = ((value: unknown) => boolean) & {
  errors?: ValidationError[] | null;
};

/** Responds with the protocol validation error for invalid method params. */
export function respondInvalidParams(params: {
  respond: RespondFn;
  method: string;
  validator: ValidatorFn;
}) {
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${params.method} params: ${formatValidationErrors(params.validator.errors)}`,
    ),
  );
}

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
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: { nodeError: res.error ?? null },
    }),
  );
  return false;
}
