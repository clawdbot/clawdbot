// Response-coupled webhook body reads keep a rejected connection alive until its answer is flushed.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  closeRequestAfterResponse,
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  type ReadJsonBodyOptions,
  type ReadJsonBodyResult,
  type ReadRequestBodyOptions,
} from "../infra/http-body.js";

type ResponseBodyReadOptions = Omit<ReadRequestBodyOptions, "destroyOnLimit">;

/** Keep a limited request alive until its caller can write the rejection response. */
export async function readWebhookBodyForResponse(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResponseBodyReadOptions,
): Promise<string> {
  try {
    return await readRequestBodyWithLimit(req, {
      ...options,
      destroyOnLimit: false,
    });
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      closeRequestAfterResponse(req, res);
    }
    throw error;
  }
}

type ResponseJsonBodyReadOptions = Omit<ReadJsonBodyOptions, "destroyOnLimit">;

/** Read JSON while preserving the caller's response for size and timeout failures. */
export async function readJsonWebhookBodyForResponse(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResponseJsonBodyReadOptions,
): Promise<ReadJsonBodyResult> {
  const result = await readJsonBodyWithLimit(req, { ...options, destroyOnLimit: false });
  if (
    !result.ok &&
    (result.code === "PAYLOAD_TOO_LARGE" || result.code === "REQUEST_BODY_TIMEOUT")
  ) {
    closeRequestAfterResponse(req, res);
  }
  return result;
}
