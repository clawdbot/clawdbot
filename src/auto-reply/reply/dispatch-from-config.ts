import type { ClawdbotConfig } from "../../config/config.js";
import { getReplyFromConfig } from "../reply.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";

type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function dispatchReplyFromConfig(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
    params.ctx,
    {
      ...params.replyOptions,
      onToolResult: (payload: ReplyPayload) => {
        params.dispatcher.sendToolResult(payload);
      },
      onBlockReply: (payload: ReplyPayload) => {
        params.dispatcher.sendBlockReply(payload);
      },
    },
    params.cfg,
  );

  const replies = replyResult
    ? Array.isArray(replyResult)
      ? replyResult
      : [replyResult]
    : [];

  let queuedFinal = false;
  for (const reply of replies) {
    queuedFinal = params.dispatcher.sendFinalReply(reply) || queuedFinal;
  }
  await params.dispatcher.waitForIdle();

  return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
}
