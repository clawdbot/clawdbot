// Msteams plugin module implements attachments behavior.
export {
  downloadMSTeamsBotFrameworkAttachments,
  isBotFrameworkPersonalChatId,
} from "./attachments/bot-framework.js";
export { downloadMSTeamsAttachments } from "./attachments/download.js";
export { buildMSTeamsGraphMessageUrl, downloadMSTeamsGraphMedia } from "./attachments/graph.js";
export {
  extractMSTeamsHtmlAttachmentIds,
  resolveMSTeamsAdvertisedMedia,
  summarizeMSTeamsHtmlAttachments,
} from "./attachments/html.js";
export type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsHtmlAttachmentSummary,
  MSTeamsInboundMedia,
} from "./attachments/types.js";
