export { resolveChunkMode } from "../auto-reply/chunk.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "../auto-reply/reply/provider-dispatcher.types.js";

export type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "../auto-reply/reply/provider-dispatcher.types.js";
export type { ReplyPayload } from "./reply-payload.js";

export const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher =
  async (params) => {
    const { dispatchReplyWithBufferedBlockDispatcher: dispatch } =
      await import("../auto-reply/reply/provider-dispatcher.js");
    return await dispatch(params);
  };

export const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher = async (params) => {
  const { dispatchReplyWithDispatcher: dispatch } =
    await import("../auto-reply/reply/provider-dispatcher.js");
  return await dispatch(params);
};
