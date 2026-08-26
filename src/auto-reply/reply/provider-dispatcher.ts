// Dispatch adapters that bridge provider reply resolution into inbound dispatchers.
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

/** Dispatch a reply using the buffered block dispatcher path. */
export const dispatchReplyWithBufferedBlockDispatcherCore: DispatchReplyWithBufferedBlockDispatcher =
  async (params) => {
    return await dispatchInboundMessageWithBufferedDispatcher({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcherOptions: params.dispatcherOptions,
      toolsAllow: params.toolsAllow,
      replyResolver: params.replyResolver,
      replyOptions: params.replyOptions,
      dispatchReplyFromConfig: params.dispatchReplyFromConfig,
    });
  };

/** Dispatch a reply using the standard dispatcher path. */
export const dispatchReplyWithDispatcherCore: DispatchReplyWithDispatcher = async (params) => {
  return await dispatchInboundMessageWithDispatcher({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcherOptions: params.dispatcherOptions,
    toolsAllow: params.toolsAllow,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
};
