// Whatsapp plugin module implements inbound dispatch behavior.
export {
  createChannelMessageReplyPipeline,
  getAgentScopedMediaLocalRoots,
  jidToE164,
  logVerbose,
  resolveChunkMode,
  resolveIdentityNamePrefix,
  resolveInboundLastRouteSessionKey,
  resolveMarkdownTableMode,
  resolveSendableOutboundReplyParts,
  resolveTextChunkLimit,
  shouldLogVerbose,
  type getChildLogger,
  type getReplyFromConfig,
  type LoadConfigFn,
  type ReplyPayload,
  type resolveAgentRoute,
} from "./runtime-api.js";
