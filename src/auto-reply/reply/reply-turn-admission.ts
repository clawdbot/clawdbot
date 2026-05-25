import {
  createReplyOperation,
  replyRunRegistry,
  ReplyRunAlreadyActiveError,
  type ReplyOperation,
} from "./reply-run-registry.js";

export type ReplyTurnKind = "visible" | "heartbeat" | "queued_followup" | "control_abort";

export type ReplyTurnAdmission =
  | { status: "owned"; operation: ReplyOperation }
  | {
      status: "skipped";
      reason: "active-run" | "aborted";
      activeOperation?: ReplyOperation;
    };

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function admitReplyTurn(params: {
  sessionKey: string;
  sessionId: string;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  upstreamAbortSignal?: AbortSignal;
  waitTimeoutMs?: number;
  waitForActive?: boolean;
}): Promise<ReplyTurnAdmission> {
  let sessionId = params.sessionId;
  while (true) {
    if (isAbortSignalAborted(params.upstreamAbortSignal)) {
      return { status: "skipped", reason: "aborted" };
    }
    try {
      return {
        status: "owned",
        operation: createReplyOperation({
          sessionKey: params.sessionKey,
          sessionId,
          resetTriggered: params.resetTriggered,
          upstreamAbortSignal: params.upstreamAbortSignal,
        }),
      };
    } catch (error) {
      if (!(error instanceof ReplyRunAlreadyActiveError)) {
        throw error;
      }
      const activeOperation = replyRunRegistry.get(params.sessionKey);
      if (params.kind === "heartbeat" || params.kind === "control_abort") {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      if (params.waitForActive === false) {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      const ended = await replyRunRegistry.waitForIdle(params.sessionKey, params.waitTimeoutMs, {
        signal: params.upstreamAbortSignal,
      });
      if (!ended) {
        return {
          status: "skipped",
          reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          activeOperation,
        };
      }
      if (activeOperation) {
        sessionId = activeOperation.sessionId;
      }
    }
  }
}

export function resolveReplyTurnKind(opts?: { isHeartbeat?: boolean }): ReplyTurnKind {
  return opts?.isHeartbeat === true ? "heartbeat" : "visible";
}
