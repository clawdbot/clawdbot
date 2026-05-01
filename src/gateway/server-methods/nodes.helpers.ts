import type { ErrorObject } from "ajv";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
export { safeParseJson } from "../server-json.js";
import { formatForLog } from "../ws-log.js";
import type { RespondFn } from "./types.js";

type ValidatorFn = ((value: unknown) => boolean) & {
  errors?: ErrorObject[] | null;
};

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

export async function respondUnavailableOnThrow(respond: RespondFn, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  }
}

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
