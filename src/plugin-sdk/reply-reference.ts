/**
 * Public SDK subpath for reply reference planning and reply threading policy.
 */
export {
  createReplyReferencePlanner,
  isSingleUseReplyToMode,
} from "../auto-reply/reply/reply-reference.js";
export { resolveBatchedReplyThreadingPolicy } from "../auto-reply/reply/reply-threading.js";
export type { ReplyThreadingPolicy } from "../auto-reply/get-reply-options.types.js";
