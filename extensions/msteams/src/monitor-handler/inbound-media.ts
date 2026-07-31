// Msteams plugin module implements inbound media behavior.
import {
  formatInboundMediaUnavailableText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  buildMSTeamsGraphMessageUrl,
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  extractMSTeamsHtmlAttachmentIds,
  isBotFrameworkPersonalChatId,
  type MSTeamsAccessTokenProvider,
  type MSTeamsAttachmentLike,
  type MSTeamsHtmlAttachmentSummary,
  type MSTeamsInboundMedia,
} from "../attachments.js";
import type { MSTeamsAttachmentDownloadLogger } from "../attachments/shared.js";
import type { MSTeamsRequestDeadline } from "../request-timeout.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

export function shouldAttemptMSTeamsGraphMediaFallback(params: {
  conversationType: string;
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  graphMediaFallback?: boolean;
}): boolean {
  const conversationType = params.conversationType.trim().toLowerCase();
  return (
    params.graphMediaFallback === true &&
    (conversationType === "channel" || conversationType === "groupchat") &&
    (params.htmlSummary?.htmlAttachments ?? 0) > 0
  );
}

export function resolveMSTeamsInboundMediaBody(params: {
  body: string;
  nativeMedia: readonly MediaPlaceholderTextFact[];
  materializedMedia: readonly MediaPlaceholderTextFact[];
}): string {
  const unavailableCount =
    params.materializedMedia.filter((media) => !media.path).length +
    Math.max(0, params.nativeMedia.length - params.materializedMedia.length);
  if (unavailableCount === 0) {
    return params.body;
  }
  return formatInboundMediaUnavailableText({
    body: params.body,
    notice: `[msteams ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]`,
  });
}

function hasDefinitiveContentType(media: MSTeamsInboundMedia): boolean {
  const contentType = media.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(
    contentType &&
    contentType !== "application/octet-stream" &&
    contentType !== "binary/octet-stream",
  );
}

export function mergeMSTeamsMediaFacts(
  nativeMedia: readonly MSTeamsInboundMedia[],
  materializedMedia: readonly MSTeamsInboundMedia[],
  options: { positionallyAligned?: boolean } = {},
): MSTeamsInboundMedia[] {
  // Direct downloads share advertised order; Graph/Bot Framework subsets do not.
  // Fallback results may replace only their matching transport resource identity.
  const merged = [...nativeMedia];
  const nativeSlotCount = nativeMedia.length;
  const nativeIndexBySourceId = new Map<string, number>();
  nativeMedia.forEach((media, index) => {
    if (media.sourceId && !nativeIndexBySourceId.has(media.sourceId)) {
      nativeIndexBySourceId.set(media.sourceId, index);
    }
  });
  for (const [index, materialized] of materializedMedia.entries()) {
    const sourceIndex = materialized.sourceId
      ? nativeIndexBySourceId.get(materialized.sourceId)
      : undefined;
    const positionalIndex =
      options.positionallyAligned === false || index >= nativeMedia.length ? undefined : index;
    const mayUseFallbackOrder = options.positionallyAligned === false;
    const isEligibleUnresolved = (media: MSTeamsInboundMedia) => !media.path && !media.sourceId;
    const sameKindUnresolvedIndexes = mayUseFallbackOrder
      ? merged
          .slice(0, nativeSlotCount)
          .flatMap((media, mediaIndex) =>
            isEligibleUnresolved(media) && media.kind === materialized.kind ? [mediaIndex] : [],
          )
      : [];
    const unresolvedIndexes =
      sameKindUnresolvedIndexes.length === 0 && mayUseFallbackOrder
        ? merged
            .slice(0, nativeSlotCount)
            .flatMap((media, mediaIndex) => (isEligibleUnresolved(media) ? [mediaIndex] : []))
        : [];
    const fallbackIndex =
      sameKindUnresolvedIndexes.length > 0
        ? sameKindUnresolvedIndexes[0]
        : unresolvedIndexes.length === 1
          ? unresolvedIndexes[0]
          : undefined;
    const targetIndex = sourceIndex ?? positionalIndex ?? fallbackIndex;
    if (targetIndex === undefined) {
      if (materialized.sourceId) {
        nativeIndexBySourceId.set(materialized.sourceId, merged.length);
      }
      merged.push(materialized);
    } else {
      if (materialized.sourceId) {
        nativeIndexBySourceId.set(materialized.sourceId, targetIndex);
      }
      const current = merged[targetIndex];
      if (materialized.path) {
        merged[targetIndex] = materialized;
      } else if (!current?.path) {
        merged[targetIndex] = {
          ...current,
          ...materialized,
          kind:
            hasDefinitiveContentType(materialized) || !current?.kind
              ? materialized.kind
              : current.kind,
        };
      }
    }
  }
  return merged;
}

function hasMaterializedMedia(media: readonly MSTeamsInboundMedia[]): boolean {
  return media.some((entry) => Boolean(entry.path));
}

export async function resolveMSTeamsInboundMedia(params: {
  attachments: MSTeamsAttachmentLike[];
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  tokenProvider: MSTeamsAccessTokenProvider;
  conversationType: string;
  conversationId: string;
  conversationMessageId?: string;
  teamAadGroupId?: string;
  /** Resolve canonical channel identity only if direct media recovery misses. */
  resolveTeamAadGroupId?: () => Promise<string | undefined>;
  serviceUrl?: string;
  activity: Pick<MSTeamsTurnContext["activity"], "id" | "replyToId" | "channelData">;
  log: MSTeamsAttachmentDownloadLogger;
  deadline?: MSTeamsRequestDeadline;
  /** Opt into Graph lookup when Teams strips file markers from channel/group HTML. */
  graphMediaFallback?: boolean;
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
    teamAadGroupId,
    serviceUrl,
    activity,
    log,
    preserveFilenames,
  } = params;

  let mediaList = await downloadMSTeamsAttachments({
    attachments,
    maxBytes,
    tokenProvider,
    allowHosts,
    authAllowHosts: params.authAllowHosts,
    preserveFilenames,
    deadline: params.deadline,
    logger: log,
  });

  if (!hasMaterializedMedia(mediaList)) {
    // Explicit attachment markers remain the fallback gate for personal chats.
    // Channel and group-chat activities can omit them while Graph holds a file.
    const attachmentIds = extractMSTeamsHtmlAttachmentIds(attachments);
    const hasHtmlFileAttachment = attachmentIds.length > 0;
    const hasChannelOrGroupHtml = shouldAttemptMSTeamsGraphMediaFallback({
      conversationType,
      htmlSummary,
      graphMediaFallback: params.graphMediaFallback,
    });
    const shouldFetchGraphMessage = hasHtmlFileAttachment || hasChannelOrGroupHtml;
    const isBotFrameworkPersonalChat = isBotFrameworkPersonalChatId(conversationId);

    // Personal DMs with the bot use Bot Framework conversation IDs (`a:...`
    // or `8:orgid:...`) which Graph's `/chats/{id}` endpoint rejects with
    // "Invalid ThreadId". Fetch media via the Bot Framework v3 attachments
    // endpoint instead, which speaks the same identifier space.
    if (hasHtmlFileAttachment && isBotFrameworkPersonalChat) {
      if (!serviceUrl) {
        log.debug?.("bot framework attachment skipped (missing serviceUrl)", {
          conversationType,
          conversationId,
        });
      } else {
        const bfMedia = await downloadMSTeamsBotFrameworkAttachments({
          serviceUrl,
          attachmentIds,
          tokenProvider,
          maxBytes,
          allowHosts,
          authAllowHosts: params.authAllowHosts,
          preserveFilenames,
          deadline: params.deadline,
        });
        if (bfMedia.media.length > 0) {
          mediaList = mergeMSTeamsMediaFacts(mediaList, bfMedia.media, {
            positionallyAligned: false,
          });
        }
        if (!hasMaterializedMedia(bfMedia.media)) {
          log.debug?.("bot framework attachments fetch empty", {
            conversationType,
            attachmentCount: bfMedia.attachmentCount ?? attachmentIds.length,
          });
        }
      }
    }

    if (
      shouldFetchGraphMessage &&
      !hasMaterializedMedia(mediaList) &&
      !isBotFrameworkPersonalChat
    ) {
      const graphTeamAadGroupId =
        conversationType.trim().toLowerCase() === "channel" && !teamAadGroupId
          ? await params.resolveTeamAadGroupId?.()
          : teamAadGroupId;
      const messageUrl = buildMSTeamsGraphMessageUrl({
        conversationType,
        conversationId,
        messageId: activity.id ?? undefined,
        threadRootMessageId: conversationMessageId ?? activity.replyToId,
        teamAadGroupId: graphTeamAadGroupId,
        channelId: activity.channelData?.channel?.id,
      });
      if (!messageUrl) {
        log.debug?.("graph message url unavailable", {
          conversationType,
          hasChannelData: Boolean(activity.channelData),
          messageId: activity.id ?? undefined,
          replyToId: activity.replyToId ?? undefined,
        });
      } else {
        const graphMedia = await downloadMSTeamsGraphMedia({
          messageUrl,
          tokenProvider,
          maxBytes,
          allowHosts,
          authAllowHosts: params.authAllowHosts,
          preserveFilenames,
          deadline: params.deadline,
          logger: log,
        });
        if (graphMedia.media.length > 0) {
          mediaList = mergeMSTeamsMediaFacts(mediaList, graphMedia.media, {
            positionallyAligned: false,
          });
        }
        if (!hasMaterializedMedia(mediaList)) {
          log.debug?.("graph media fetch empty", {
            messageUrl,
            hostedStatus: graphMedia.hostedStatus,
            attachmentStatus: graphMedia.attachmentStatus,
            hostedCount: graphMedia.hostedCount,
            attachmentCount: graphMedia.attachmentCount,
            tokenError: graphMedia.tokenError,
            attachmentIdCount: attachmentIds.length,
          });
        }
      }
    }
  }

  const materializedCount = mediaList.filter((media) => Boolean(media.path)).length;
  if (materializedCount > 0) {
    log.debug?.("downloaded attachments", { count: materializedCount });
  } else if (htmlSummary?.imgTags) {
    log.debug?.("inline images detected but none downloaded", {
      imgTags: htmlSummary.imgTags,
      srcHosts: htmlSummary.srcHosts,
      dataImages: htmlSummary.dataImages,
      cidImages: htmlSummary.cidImages,
    });
  }

  return mediaList;
}
