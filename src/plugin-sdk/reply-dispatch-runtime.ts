export { resolveChunkMode } from "../auto-reply/chunk.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
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

let providerDispatcherRuntimeModulePromise: Promise<
  typeof import("../auto-reply/reply/provider-dispatcher.runtime.js")
> | null = null;

const loadProviderDispatcherRuntimeModule = async () => {
  providerDispatcherRuntimeModulePromise ??=
    import("../auto-reply/reply/provider-dispatcher.runtime.js");
  return await providerDispatcherRuntimeModulePromise;
};

export const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher =
  async (params) => {
    const { dispatchReplyWithBufferedBlockDispatcher: dispatch } =
      await loadProviderDispatcherRuntimeModule();
    return await dispatch(params);
  };

export const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher = async (params) => {
  const { dispatchReplyWithDispatcher: dispatch } = await loadProviderDispatcherRuntimeModule();
  return await dispatch(params);
};
