import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";
import { runReplyDispatchHook } from "./dispatch-from-config.reply-dispatch-hook.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";

export async function handleAcpDispatchTailAfterReset(
  state: PrepareDispatchExecutionReadyState,
): Promise<{ status: "complete"; result: DispatchFromConfigResult } | undefined> {
  if (state.ctx.AcpDispatchTailAfterReset !== true) {
    return undefined;
  }
  // Command handling prepared a trailing prompt after ACP in-place reset.
  // Route that tail through ACP now (same turn) instead of embedded dispatch.
  state.ctx.AcpDispatchTailAfterReset = false;
  const tailDispatchResult = await runReplyDispatchHook(state, {
    shouldSendToolSummaries: state.shouldSendToolSummaries,
    isTailDispatch: true,
  });
  if (!tailDispatchResult?.handled) {
    return undefined;
  }
  state.recordAgentDispatchCompleted("completed");
  state.completeDispatchReplyOperation();
  return {
    status: "complete",
    result: state.attachSourceReplyDeliveryMode({
      queuedFinal: tailDispatchResult.queuedFinal,
      counts: tailDispatchResult.counts,
      ...(state.routeState.sessionMetadataChangesForResult
        ? { sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult }
        : {}),
    }),
  };
}
