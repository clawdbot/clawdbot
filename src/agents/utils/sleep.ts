import { sleepWithAbort } from "@openclaw/retry";
/**
 * Sleep helper that respects abort signal.
 */
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sleepWithAbort(resolveTimerTimeoutMs(ms, 0), signal);
}
