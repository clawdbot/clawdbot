import {
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { formatForLog } from "../ws-log.js";
import type { RespondFn } from "./types.js";

export function respondUnavailable(respond: RespondFn, err: unknown): void {
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
}

export async function respondUnavailableOnThrow(respond: RespondFn, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    respondUnavailable(respond, err);
  }
}
