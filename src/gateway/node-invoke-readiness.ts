import { sleep } from "../utils/sleep.js";
import { NODE_INVOKE_NOT_READY } from "./node-registry.invoke-stream.js";
import type { NodeInvokeResult, NodeRegistry } from "./node-registry.js";

const READINESS_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

/** Recover only an explicit rejection before native execution, inside the RPC's authority. */
export async function invokeNodeWithReadinessRetry(
  registry: Pick<NodeRegistry, "invoke">,
  request: Parameters<NodeRegistry["invoke"]>[0],
): Promise<NodeInvokeResult> {
  let deadlineAtMs =
    request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
      ? Date.now() + request.timeoutMs
      : undefined;
  const timedOut = (): NodeInvokeResult => ({
    ok: false,
    error: { code: "TIMEOUT", message: "node invoke timed out" },
  });
  for (let attempt = 0; ; attempt += 1) {
    const timeoutMs =
      deadlineAtMs === undefined ? request.timeoutMs : Math.max(0, deadlineAtMs - Date.now());
    if (deadlineAtMs !== undefined && timeoutMs === 0) {
      return timedOut();
    }
    const result = await registry.invoke({
      ...request,
      timeoutMs,
      onDispatchReady: (invokeId, dispatchDeadlineAtMs) => {
        // The omitted timeout starts at registry dispatch, not at RPC admission.
        // Capture that first armed deadline so retries cannot replenish its budget.
        if (
          dispatchDeadlineAtMs !== undefined &&
          (deadlineAtMs === undefined || dispatchDeadlineAtMs < deadlineAtMs)
        ) {
          deadlineAtMs = dispatchDeadlineAtMs;
        }
        request.onDispatchReady?.(invokeId, dispatchDeadlineAtMs);
      },
    });
    const delayMs = READINESS_RETRY_DELAYS_MS[attempt];
    if (result.ok || result.error?.code !== NODE_INVOKE_NOT_READY || delayMs === undefined) {
      return result;
    }
    try {
      await sleep(
        deadlineAtMs === undefined
          ? delayMs
          : Math.min(delayMs, Math.max(0, deadlineAtMs - Date.now())),
        request.signal,
      );
    } catch (error) {
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
        return timedOut();
      }
      if (request.signal?.aborted) {
        return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
      }
      throw error;
    }
  }
}
