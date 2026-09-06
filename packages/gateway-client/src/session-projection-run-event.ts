import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionRun,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "./session-projection.js";

export type SessionProjectionGatewayRunEvent = {
  state?: unknown;
  yielded?: unknown;
  seq?: unknown;
} & Partial<Record<"runId" | "message" | "stopReason" | "errorKind" | "errorMessage", unknown>>;

export type SessionProjectionRunTransition = {
  projection: SessionProjectionState;
  previousRun: SessionProjectionRun | undefined;
  currentRun: SessionProjectionRun | undefined;
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
  const messageStopReason = isRecord(message) ? readNonemptyString(message.stopReason) : null;
  const stopReason = readNonemptyString(event.stopReason) ?? messageStopReason;
  const errorKind = readNonemptyString(event.errorKind);
  const base = {
    runId,
    seq: typeof event.seq === "number" ? event.seq : undefined,
    ...(message === undefined ? {} : { message }),
    scope,
  };
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
