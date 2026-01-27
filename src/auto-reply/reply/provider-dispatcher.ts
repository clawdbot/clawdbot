import type { MoltbotConfig } from "../../config/config.js";
import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { DispatchInboundResult } from "../dispatch.js";
import {
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher,
} from "../dispatch.js";
import type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "./reply-dispatcher.js";

export async function dispatchReplyWithBufferedBlockDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: MoltbotConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("../reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return await dispatchInboundMessageWithBufferedDispatcher({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcherOptions: params.dispatcherOptions,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}

export async function dispatchReplyWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: MoltbotConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("../reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return await dispatchInboundMessageWithDispatcher({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcherOptions: params.dispatcherOptions,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
