/** Active-run queue admission for prepared reply turns. */
import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import type { ActiveRunQueueAction } from "./queue-policy.js";
import type { QueueSettings } from "./queue.js";

/** Snapshot of the active reply run state used by queue admission. */
export type ReplyRunQueueBusyState = {
  activeSessionId: string | undefined;
  isActive: boolean;
  isStreaming: boolean;
};

export const REPLY_RUN_STILL_SHUTTING_DOWN_TEXT =
  "⚠️ Previous run is still shutting down. Please try again in a moment.";

/** Resolves whether a new reply may continue after active-run queue handling. */
export async function resolvePreparedReplyQueueState(params: {
  activeRunQueueAction: ActiveRunQueueAction;
  activeSessionId: string | undefined;
  queueMode: QueueSettings["mode"];
  sessionKey: string | undefined;
  sessionId: string;
  abortActiveRun: (sessionId: string) => boolean;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => ReplyRunQueueBusyState;
}): Promise<
  { kind: "continue"; busyState: ReplyRunQueueBusyState } | { kind: "reply"; reply: ReplyPayload }
> {
  if (params.activeRunQueueAction !== "run-now" || !params.activeSessionId) {
    return { kind: "continue", busyState: params.resolveBusyState() };
  }

  if (params.queueMode === "interrupt") {
    // Interrupt mode asks the active run to abort before waiting for teardown.
    const aborted = params.abortActiveRun(params.activeSessionId);
    logVerbose(
      `Interrupting active run for ${params.sessionKey ?? params.sessionId} (aborted=${aborted})`,
    );
  }

  await params.waitForActiveRunEnd(params.activeSessionId);
  await params.refreshPreparedState();
  const refreshedBusyState = params.resolveBusyState();
  if (refreshedBusyState.isActive) {
    return {
      kind: "reply",
      reply: {
        text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      },
    };
  }
  return { kind: "continue", busyState: refreshedBusyState };
}
