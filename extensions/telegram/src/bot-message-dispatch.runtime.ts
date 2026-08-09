// Telegram plugin module implements bot message dispatch behavior.
export { getSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
export { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
export { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
export { resolveChunkMode } from "openclaw/plugin-sdk/reply-dispatch-runtime";
export {
  generateTelegramTopicLabel as generateTopicLabel,
  resolveAutoTopicLabelConfig,
} from "./auto-topic-label.js";
