import {
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "./session-projection.js";

export type SessionProjectionGatewayRunEvent = {
  state?: unknown;
  yielded?: unknown;
} & Partial<Record<"runId" | "message" | "stopReason" | "errorKind" | "errorMessage", unknown>>;

export type SessionProjectionRunTransition = {
  projection: SessionProjectionState;
  previousRun: SessionProjectionState["runs"][string] | undefined;
  currentRun: SessionProjectionState["runs"][string] | undefined;
};

function readNonemptyString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

/** Normalizes Gateway run envelopes once for every browser and terminal adapter. */
export function reduceSessionProjectionRunEvent(
  projection: SessionProjectionState,
  event: SessionProjectionGatewayRunEvent,
  scope: SessionProjectionScope = {},
): SessionProjectionRunTransition | null {
  const runId = readNonemptyString(event.runId);
  if (
    !runId ||
    typeof event.state !== "string" ||
    !["delta", "final", "error", "aborted"].includes(event.state)
  ) {
    return null;
  }
  const message = event.message;
  const messageStopReason =
    message !== null && typeof message === "object" && !Array.isArray(message)
      ? readNonemptyString((message as Record<string, unknown>).stopReason)
      : null;
  const stopReason = readNonemptyString(event.stopReason) ?? messageStopReason;
  const errorKind = readNonemptyString(event.errorKind);
  const base = { runId, ...(message === undefined ? {} : { message }), scope };
  const action: SessionProjectionEvent =
    event.state === "delta"
      ? { type: "runDelta", ...base }
      : {
          type: "runTerminal",
          ...base,
          status:
            event.state === "aborted"
              ? "aborted"
              : event.state === "error"
                ? errorKind === "timeout"
                  ? "timeout"
                  : "error"
                : event.yielded === true && stopReason === "end_turn"
                  ? "yielded"
                  : stopReason === "error"
                    ? "error"
                    : "completed",
          ...(stopReason === null ? {} : { stopReason }),
          ...(errorKind === null ? {} : { errorKind }),
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        };
  const next = reduceSessionProjection(projection, action);
  return { projection: next, previousRun: projection.runs[runId], currentRun: next.runs[runId] };
}
