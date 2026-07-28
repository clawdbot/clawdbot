type ReplyOperationAdmissionSnapshot =
  | { status: "owned" }
  | { status: "skipped"; reason: "active-run" | "aborted" | "lifecycle-invalidated" };

export type ReplyOperationRunState = {
  admission?: ReplyOperationAdmissionSnapshot;
};

// Carries this invocation's admission decision through reply option spreads so
// heartbeat cleanup never infers it from whichever operation is active later.
export const REPLY_OPERATION_RUN_STATE = Symbol("openclaw.replyOperationRunState");

type ReplyOptionsWithOperationRunState = {
  [REPLY_OPERATION_RUN_STATE]?: ReplyOperationRunState;
};

export function resolveReplyOperationRunState(
  options: object | undefined,
): ReplyOperationRunState | undefined {
  return (options as ReplyOptionsWithOperationRunState | undefined)?.[REPLY_OPERATION_RUN_STATE];
}
