// Msteams plugin module materializes inbound media and agent content.
import type { MSTeamsHtmlAttachmentSummary, MSTeamsInboundMedia } from "../attachments.js";
import { formatUnknownError } from "../errors.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import type { MSTeamsRequestDeadline } from "../request-timeout.js";
import { withMSTeamsRequestDeadline } from "../request-timeout.js";
import type { MSTeamsDebounceEntry } from "./inbound-facts.js";
import {
  mergeMSTeamsMediaFacts,
  resolveMSTeamsInboundMedia,
  resolveMSTeamsInboundMediaBody,
  shouldAttemptMSTeamsGraphMediaFallback,
} from "./inbound-media.js";

export async function prepareMSTeamsInboundContent(params: {
  entry: MSTeamsDebounceEntry;
  rawBody: string;
  advertisedMedia: MSTeamsInboundMedia[];
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  conversationType: string;
  conversationId: string;
  conversationMessageId?: string;
  teamAadGroupId?: string;
  resolveTeamAadGroupId: () => Promise<string | undefined>;
  mediaMaxBytes: number;
  tokenProvider: MSTeamsMessageHandlerDeps["tokenProvider"];
  mediaAllowHosts?: Parameters<typeof resolveMSTeamsInboundMedia>[0]["allowHosts"];
  mediaAuthAllowHosts?: Parameters<typeof resolveMSTeamsInboundMedia>[0]["authAllowHosts"];
  graphMediaFallback?: boolean;
  deadline: MSTeamsRequestDeadline;
  log: MSTeamsMessageHandlerDeps["log"];
}) {
  const activity = params.entry.context.activity;
  const mayRecoverGraphMedia =
    Boolean(params.htmlSummary?.attachmentIds.length) ||
    shouldAttemptMSTeamsGraphMediaFallback({
      conversationType: params.conversationType,
      htmlSummary: params.htmlSummary,
      graphMediaFallback: params.graphMediaFallback,
    });
  if (!params.rawBody && params.advertisedMedia.length === 0 && !mayRecoverGraphMedia) {
    params.log.debug?.("skipping empty message after stripping mentions");
    return null;
  }

  let mediaList = [] as Awaited<ReturnType<typeof resolveMSTeamsInboundMedia>>;
  try {
    mediaList = await withMSTeamsRequestDeadline({
      deadline: params.deadline,
      label: "MS Teams inbound media",
      work: () =>
        resolveMSTeamsInboundMedia({
          attachments: params.entry.attachments,
          htmlSummary: params.htmlSummary,
          maxBytes: params.mediaMaxBytes,
          tokenProvider: params.tokenProvider,
          allowHosts: params.mediaAllowHosts,
          authAllowHosts: params.mediaAuthAllowHosts,
          graphMediaFallback: params.graphMediaFallback,
          conversationType: params.conversationType,
          conversationId: params.conversationId,
          conversationMessageId: params.conversationMessageId,
          teamAadGroupId: params.teamAadGroupId,
          resolveTeamAadGroupId: params.resolveTeamAadGroupId,
          serviceUrl: activity.serviceUrl,
          activity: {
            id: activity.id,
            replyToId: activity.replyToId,
            channelData: activity.channelData,
          },
          log: params.log,
          deadline: params.deadline,
          preserveFilenames: false,
        }),
    });
  } catch (err) {
    params.log.debug?.("failed to resolve inbound Teams media", {
      error: formatUnknownError(err),
    });
  }

  const inboundMedia = mergeMSTeamsMediaFacts(params.advertisedMedia, mediaList);
  const nativeMediaForComparison = [
    ...params.advertisedMedia,
    ...mediaList.slice(params.advertisedMedia.length).map((media) => ({
      contentType: media.contentType,
      kind: media.kind,
    })),
  ];
  const agentBody = resolveMSTeamsInboundMediaBody({
    body: params.rawBody,
    nativeMedia: nativeMediaForComparison,
    materializedMedia: inboundMedia,
  });
  if (!agentBody && inboundMedia.length === 0) {
    params.log.debug?.("skipping empty message after Graph media recovery");
    return null;
  }

  return { agentBody, inboundMedia };
}
