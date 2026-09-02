import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { WebSocket } from "ws";
import { runOutsideGatewayRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { BoundedSerialQueue } from "../../../shared/bounded-serial-queue.js";
import type { GatewayRole } from "../../role-policy.js";
import { MAX_PAYLOAD_BYTES } from "../../server-constants.js";

type GatewayReceiver = { _maxPayload?: number; _allowSynchronousEvents?: boolean };

export function prepareGatewayReceiverHandoff(
  socket: WebSocket,
  role: GatewayRole,
): (() => void) | null {
  // SAFETY: ws owns these private per-frame fields; validate each before the handoff.
  const receiver = (socket as WebSocket & { _receiver?: GatewayReceiver })["_receiver"];
  if (
    !receiver ||
    typeof receiver["_maxPayload"] !== "number" ||
    Object.getOwnPropertyDescriptor(receiver, "_maxPayload")?.writable !== true ||
    (role === "operator" &&
      (typeof receiver["_allowSynchronousEvents"] !== "boolean" ||
        Object.getOwnPropertyDescriptor(receiver, "_allowSynchronousEvents")?.writable !== true))
  ) {
    return null;
  }
  return () => {
    receiver["_maxPayload"] = MAX_PAYLOAD_BYTES;
    if (role === "operator") {
      receiver["_allowSynchronousEvents"] = true;
    }
  };
}

// One active scheduling task is separate from these waiting budgets. Each task
// grants start permission only; it never owns the RPC or waits for its completion.
const requestStarts = new BoundedSerialQueue({
  maxPendingCount: 256,
  maxPendingWeight: 50 * 1024 * 1024,
});
const MAX_STARTS_PER_TURN = 64;
const START_WORK_BUDGET_MS = 12;
let turnStartedAt = 0;
let turnStarts = 0;

/** Grants operator router-start permission, or null when its waiting budget is exhausted. */
export function scheduleGatewayRequestStart(frameBytes: number): Promise<void> | null {
  return runOutsideGatewayRootWorkAdmission(() => {
    const wasIdle = requestStarts.isIdle;
    const admission = requestStarts.enqueue(
      async () => {
        // Observe ready caller work before granting another start, without awaiting
        // an unresolved request or capturing that caller's root admission.
        await new Promise<void>(queueMicrotask);
        if (
          wasIdle ||
          turnStarts >= MAX_STARTS_PER_TURN ||
          performance.now() - turnStartedAt >= START_WORK_BUDGET_MS
        ) {
          await nextTurn();
          turnStartedAt = performance.now();
          turnStarts = 0;
        }
        turnStarts++;
      },
      { weight: frameBytes, sealOnOverflow: false },
    );
    return admission.accepted ? admission.completion : null;
  });
}
