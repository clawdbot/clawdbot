import { createLazyPromise } from "../shared/lazy-runtime.js";
/**
 * Runtime SDK subpath for lazy reply dispatch and inbound-context helpers.
 */
export { resolveChunkMode } from "../auto-reply/chunk.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export { finalizeInboundContextForSdk as finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
import type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "../auto-reply/reply/provider-dispatcher.types.js";

export type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "../auto-reply/reply/provider-dispatcher.types.js";
export type { ReplyPayload } from "./reply-payload.js";

const loadProviderDispatcherRuntimeModule = createLazyPromise(
  () => import("../auto-reply/reply/provider-dispatcher.runtime.js"),
  { cacheRejections: true },
);

/** Dispatches a reply with buffered block support after lazy-loading the runtime dispatcher. */
export const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher =
  async (params) => {
    const { dispatchReplyWithBufferedBlockDispatcher: dispatch } =
      await loadProviderDispatcherRuntimeModule();
    return await dispatch(params);
  };

/** Dispatches a reply through the provider dispatcher after lazy-loading runtime code. */
export const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher = async (params) => {
  const { dispatchReplyWithDispatcher: dispatch } = await loadProviderDispatcherRuntimeModule();
  return await dispatch(params);
};
