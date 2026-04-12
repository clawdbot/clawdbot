// Shared agent/reply runtime helpers for channel plugins. Keep channel plugins
// off direct src/auto-reply imports by routing common reply primitives here.

export {
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
export type { ChunkMode } from "../auto-reply/chunk.js";
export {
  dispatchInboundMessage,
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher,
} from "../auto-reply/dispatch.js";
export {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../auto-reply/group-activation.js";
export {
  HEARTBEAT_PROMPT,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
export { resolveHeartbeatReplyPayload } from "../auto-reply/heartbeat-reply-payload.js";
export { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
export { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export { isAbortRequestText } from "../auto-reply/reply/abort.js";
export { isBtwRequestText } from "../auto-reply/reply/btw-command.js";
export { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
export { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
export {
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchReplyWithDispatcher,
} from "../auto-reply/reply/provider-dispatcher.js";
export {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
} from "../auto-reply/reply/reply-dispatcher.js";
export type {
  ReplyDispatchKind,
  ReplyDispatcher,
} from "../auto-reply/reply/reply-dispatcher.types.js";
export type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "../auto-reply/reply/reply-dispatcher.js";
export { createReplyReferencePlanner } from "../auto-reply/reply/reply-reference.js";
export type { GetReplyOptions, BlockReplyContext } from "../auto-reply/get-reply-options.types.js";
export type { ReplyPayload } from "../auto-reply/reply-payload.js";
export type { FinalizedMsgContext, MsgContext } from "../auto-reply/templating.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export type { ConversationLabelParams } from "../auto-reply/reply/conversation-label-generator.js";
