// Mattermost plugin module prepares shared routing and reply facts for monitor events.
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveMattermostReplyToMode } from "./accounts.js";
import type { MattermostChannel } from "./client.js";
import { resolveMattermostTrustedChatKind } from "./monitor-auth.js";
import { resolveMattermostThreadSessionContext } from "./monitor-context.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { createMattermostReplyDeliveryBarrier } from "./reply-delivery.js";
import { logTypingFailure } from "./runtime-api.js";

type MattermostEventPlanParams = {
  channelId: string;
  senderId: string;
  postId?: string | null;
  threadRootId?: string | null;
  channelInfo?: MattermostChannel | null;
  channelTypeFallback?: string | null;
  teamId?: string | null;
  channelName?: string | null;
  channelDisplay?: string | null;
  dropLabel: string;
};

export async function buildMattermostEventPlan(
  monitor: MattermostMonitorContext,
  params: MattermostEventPlanParams,
) {
  // Gather transport metadata once, normalize its optional labels, then decide
  // the route/thread identity every event consumer must share.
  const channelInfo =
    params.channelInfo ?? (await monitor.resources.resolveChannelInfo(params.channelId));
  const channelType = channelInfo?.type?.trim() || params.channelTypeFallback?.trim();
  if (!channelType) {
    monitor.logVerboseMessage(
      `mattermost: drop ${params.dropLabel} (cannot resolve channel type for ${params.channelId})`,
    );
    return null;
  }
  const kind = resolveMattermostTrustedChatKind({ channelType });
  const teamId = params.teamId ?? channelInfo?.team_id ?? undefined;
  const channelName = params.channelName ?? channelInfo?.name ?? "";
  const channelDisplay = params.channelDisplay ?? channelInfo?.display_name ?? channelName;
  const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${params.channelId}`;
  const route = monitor.core.channel.routing.resolveAgentRoute({
    cfg: monitor.cfg,
    channel: "mattermost",
    accountId: monitor.account.accountId,
    teamId,
    peer: {
      kind,
      id: kind === "direct" ? params.senderId : params.channelId,
    },
  });
  const thread = resolveMattermostThreadSessionContext({
    baseSessionKey: route.sessionKey,
    kind,
    postId: params.postId,
    replyToMode: resolveMattermostReplyToMode(monitor.account, kind),
    threadRootId: params.threadRootId,
  });
  const to = kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;

  return {
    channelId: params.channelId,
    senderId: params.senderId,
    channelInfo,
    kind,
    teamId,
    channelName,
    channelDisplay,
    roomLabel,
    route,
    thread,
    to,
    finalizeContext: <T extends Record<string, unknown>>(context: T) =>
      finalizeInboundContext({
        ...context,
        From:
          kind === "direct"
            ? `mattermost:${params.senderId}`
            : kind === "group"
              ? `mattermost:group:${params.channelId}`
              : `mattermost:channel:${params.channelId}`,
        To: to,
        SessionKey: thread.sessionKey,
        DmScope: route.dmScope,
        ParentSessionKey: thread.parentSessionKey,
        AccountId: route.accountId,
        ChatType: kind,
        GroupChannel: channelName ? `#${channelName}` : undefined,
        GroupSpace: teamId,
        SenderId: params.senderId,
        Provider: "mattermost" as const,
        Surface: "mattermost" as const,
        ReplyToId: thread.effectiveReplyToId,
        MessageThreadId: thread.effectiveReplyToId,
        OriginatingChannel: "mattermost" as const,
        OriginatingTo: to,
      }),
    createReplyPlan: () => {
      const deliveryBarrier = createMattermostReplyDeliveryBarrier({
        isDirect: kind === "direct",
        dmRetryOptions: monitor.account.config.dmChannelRetry,
      });
      return {
        textLimit: monitor.core.channel.text.resolveTextChunkLimit(
          monitor.cfg,
          "mattermost",
          monitor.account.accountId,
          { fallbackLimit: monitor.account.textChunkLimit ?? 4000 },
        ),
        tableMode: monitor.core.channel.text.resolveMarkdownTableMode({
          cfg: monitor.cfg,
          channel: "mattermost",
          accountId: monitor.account.accountId,
        }),
        deliveryBarrier,
        replyPipeline: {
          typing: {
            start: () =>
              monitor.resources.sendTypingIndicator(params.channelId, thread.effectiveReplyToId),
            onStartError: (error: unknown) => {
              logTypingFailure({
                log: monitor.logDebugMessage,
                channel: "mattermost",
                target: params.channelId,
                error,
              });
            },
          },
        },
        replyOptions: {
          disableBlockStreaming:
            typeof monitor.account.blockStreaming === "boolean"
              ? !monitor.account.blockStreaming
              : undefined,
        },
      };
    },
  };
}

export type MattermostEventPlan = NonNullable<Awaited<ReturnType<typeof buildMattermostEventPlan>>>;
