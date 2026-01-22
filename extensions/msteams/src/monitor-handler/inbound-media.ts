import {
  buildMSTeamsGraphMessageUrls,
  downloadMSTeamsAttachments,
  downloadMSTeamsGraphMedia,
  type MSTeamsAccessTokenProvider,
  type MSTeamsAttachmentLike,
  type MSTeamsHtmlAttachmentSummary,
  type MSTeamsInboundMedia,
} from "../attachments.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type MSTeamsLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

export async function resolveMSTeamsInboundMedia(params: {
  attachments: MSTeamsAttachmentLike[];
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  maxBytes: number;
  allowHosts?: string[];
  tokenProvider: MSTeamsAccessTokenProvider;
  conversationType: string;
  conversationId: string;
  conversationMessageId?: string;
  activity: Pick<MSTeamsTurnContext["activity"], "id" | "replyToId" | "channelData">;
  log: MSTeamsLogger;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia[]> {
  const {
    attachments,
    htmlSummary,
    maxBytes,
    tokenProvider,
    allowHosts,
    conversationType,
    conversationId,
    conversationMessageId,
    activity,
    log,
    preserveFilenames,
  } = params;

  let mediaList = await downloadMSTeamsAttachments({
    attachments,
    maxBytes,
    tokenProvider,
    allowHosts,
    preserveFilenames,
  });

  if (mediaList.length === 0) {
    const onlyHtmlAttachments =
      attachments.length > 0 &&
      attachments.every((att) => String(att.contentType ?? "").startsWith("text/html"));

    if (onlyHtmlAttachments) {
      const messageUrls = buildMSTeamsGraphMessageUrls({
        conversationType,
        conversationId,
        messageId: activity.id ?? undefined,
        replyToId: activity.replyToId ?? undefined,
        conversationMessageId,
        channelData: activity.channelData,
      });
      if (messageUrls.length === 0) {
        log.debug("graph message url unavailable", {
          conversationType,
          hasChannelData: Boolean(activity.channelData),
          messageId: activity.id ?? undefined,
          replyToId: activity.replyToId ?? undefined,
        });
      } else {
        const attempts: Array<{
          url: string;
          hostedStatus?: number;
          attachmentStatus?: number;
          hostedCount?: number;
          attachmentCount?: number;
          tokenError?: boolean;
        }> = [];
        for (const messageUrl of messageUrls) {
          const graphMedia = await downloadMSTeamsGraphMedia({
            messageUrl,
            tokenProvider,
            maxBytes,
            allowHosts,
            preserveFilenames,
          });
          attempts.push({
            url: messageUrl,
            hostedStatus: graphMedia.hostedStatus,
            attachmentStatus: graphMedia.attachmentStatus,
            hostedCount: graphMedia.hostedCount,
            attachmentCount: graphMedia.attachmentCount,
            tokenError: graphMedia.tokenError,
          });
          if (graphMedia.media.length > 0) {
            mediaList = graphMedia.media;
            break;
          }
          if (graphMedia.tokenError) break;
        }
        if (mediaList.length === 0) {
          log.debug("graph media fetch empty", { attempts });
        }
      }
    }
  }

  if (mediaList.length > 0) {
    log.debug("downloaded attachments", { count: mediaList.length });
  } else if (htmlSummary?.imgTags) {
    log.debug("inline images detected but none downloaded", {
      imgTags: htmlSummary.imgTags,
      srcHosts: htmlSummary.srcHosts,
      dataImages: htmlSummary.dataImages,
      cidImages: htmlSummary.cidImages,
    });
  }

  return mediaList;
}
