export {
  downloadMSTeamsBotFrameworkAttachment,
  downloadMSTeamsBotFrameworkAttachments,
  isBotFrameworkPersonalChatId,
} from "./attachments/bot-framework.js";
export {
  downloadMSTeamsAttachments,
  /** @deprecated Use `downloadMSTeamsAttachments` instead. */
  downloadMSTeamsImageAttachments,
} from "./attachments/download.js";
export { buildMSTeamsGraphMessageUrls, downloadMSTeamsGraphMedia } from "./attachments/graph.js";
export {
  buildMSTeamsAttachmentPlaceholder,
  extractMSTeamsHtmlAttachmentIds,
  summarizeMSTeamsHtmlAttachments,
} from "./attachments/html.js";
export { buildMSTeamsMediaPayload } from "./attachments/payload.js";
export type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsGraphMediaResult,
  MSTeamsHtmlAttachmentSummary,
  MSTeamsInboundMedia,
} from "./attachments/types.js";
