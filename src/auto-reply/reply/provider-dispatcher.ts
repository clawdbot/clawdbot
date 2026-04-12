import {
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher,
} from "../dispatch.js";
import type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "./provider-dispatcher.types.js";

export type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "./provider-dispatcher.types.js";

export const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher =
  async (params) => {
    return await dispatchInboundMessageWithBufferedDispatcher({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcherOptions: params.dispatcherOptions,
      replyResolver: params.replyResolver,
      replyOptions: params.replyOptions,
    });
  };

export const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher = async (params) => {
  return await dispatchInboundMessageWithDispatcher({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcherOptions: params.dispatcherOptions,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
};
