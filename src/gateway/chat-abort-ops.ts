// Keep exact-run abort wiring independent from session-wide cancellation orchestration.
import type { ChatAbortOps } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export function createChatAbortOps(
  context: Omit<ChatAbortOps, "onRunAborted"> &
    Pick<GatewayRequestContext, "cancelRunBoundApprovals">,
): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunState: context.chatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    getRuntimeConfig: context.getRuntimeConfig,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
    onRunAborted: context.cancelRunBoundApprovals,
  };
}
