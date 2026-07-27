// Mattermost plugin module registers interactive callback transport handling.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveMattermostReplyToMode } from "./accounts.js";
import { createMattermostInteractionHandler } from "./interactions.js";
import {
  authorizeMattermostCommandInvocation,
  mapMattermostChannelTypeToChatType,
} from "./monitor-auth.js";
import {
  resolveMattermostReplyRootId,
  resolveMattermostThreadSessionContext,
} from "./monitor-context.js";
import type { MattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import {
  createMattermostReplyDeliveryBarrier,
  deliverMattermostReplyPayload,
  toMattermostChannelDeliveryResult,
} from "./reply-delivery.js";
import type { ReplyPayload } from "./runtime-api.js";
import { logTypingFailure, registerPluginHttpRoute } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

export function registerMattermostInteractions(params: {
  monitor: MattermostMonitorContext;
  interactionPath: string;
  allowedSourceIps: string[];
  handleModelPickerInteraction: MattermostModelPickerInteractionHandler;
}): (() => void) | undefined {
  const { monitor } = params;
  const { account, botUserId, cfg, client, core, pairing, resources, runtime } = monitor;
  const { resolveChannelInfo, sendTypingIndicator } = resources;
  return registerPluginHttpRoute({
    path: params.interactionPath,
    fallbackPath: "/mattermost/interactions/default",
    auth: "plugin",
    handler: createMattermostInteractionHandler({
      client,
      botUserId,
      accountId: account.accountId,
      allowedSourceIps: params.allowedSourceIps,
      trustedProxies: cfg.gateway?.trustedProxies,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
      handleInteraction: params.handleModelPickerInteraction,
      authorizeButtonClick: async ({ payload, post }) => {
        const channelInfo = await resolveChannelInfo(payload.channel_id);
        const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
          cfg,
          surface: "mattermost",
        });
        const decision = await authorizeMattermostCommandInvocation({
          account,
          cfg,
          senderId: payload.user_id,
          senderName: payload.user_name ?? "",
          channelId: payload.channel_id,
          channelInfo,
          readStoreAllowFrom: pairing.readAllowFromStore,
          allowTextCommands,
          hasControlCommand: false,
        });
        if (decision.ok) {
          return { ok: true };
        }
        return {
          ok: false,
          response: {
            update: {
              message: post.message ?? "",
              props: post.props ?? undefined,
            },
            ephemeral_text: `OpenClaw ignored this action for ${decision.roomLabel}.`,
          },
        };
      },
      resolveSessionKey: async ({ channelId, userId, post }) => {
        const channelInfo = await resolveChannelInfo(channelId);
        if (!channelInfo?.type) {
          monitor.logVerboseMessage(
            `mattermost: drop interaction session event (cannot resolve channel type for ${channelId})`,
          );
          throw new Error("Mattermost channel type could not be resolved");
        }
        const kind = mapMattermostChannelTypeToChatType(channelInfo.type);
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId: channelInfo.team_id ?? undefined,
          peer: {
            kind,
            id: kind === "direct" ? userId : channelId,
          },
        });
        return resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: post.id || undefined,
          replyToMode: resolveMattermostReplyToMode(account, kind),
          threadRootId: post.root_id,
        }).sessionKey;
      },
      dispatchButtonClick: async (button) => {
        const channelInfo = await resolveChannelInfo(button.channelId);
        if (!channelInfo?.type) {
          monitor.logVerboseMessage(
            `mattermost: drop interaction dispatch (cannot resolve channel type for ${button.channelId})`,
          );
          return;
        }
        const kind = mapMattermostChannelTypeToChatType(channelInfo.type);
        const teamId = channelInfo.team_id ?? undefined;
        const channelName = channelInfo.name ?? undefined;
        const channelDisplay = channelInfo.display_name ?? channelName ?? button.channelId;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? button.userId : button.channelId,
          },
        });
        const threadContext = resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: button.post.id || button.postId,
          replyToMode: resolveMattermostReplyToMode(account, kind),
          threadRootId: button.post.root_id,
        });
        const to = kind === "direct" ? `user:${button.userId}` : `channel:${button.channelId}`;
        const bodyText = `[Button click: user @${button.userName} selected "${button.actionName}"]`;
        const ctxPayload = finalizeInboundContext({
          Body: bodyText,
          BodyForAgent: bodyText,
          RawBody: bodyText,
          CommandBody: bodyText,
          From:
            kind === "direct"
              ? `mattermost:${button.userId}`
              : kind === "group"
                ? `mattermost:group:${button.channelId}`
                : `mattermost:channel:${button.channelId}`,
          To: to,
          SessionKey: threadContext.sessionKey,
          DmScope: route.dmScope,
          ParentSessionKey: threadContext.parentSessionKey,
          AccountId: route.accountId,
          ChatType: kind,
          ConversationLabel: `mattermost:${button.userName}`,
          GroupSubject: kind !== "direct" ? channelDisplay : undefined,
          GroupChannel: channelName ? `#${channelName}` : undefined,
          GroupSpace: teamId,
          SenderName: button.userName,
          SenderId: button.userId,
          Provider: "mattermost" as const,
          Surface: "mattermost" as const,
          MessageSid: `interaction:${button.postId}:${button.actionId}`,
          ReplyToId: threadContext.effectiveReplyToId,
          MessageThreadId: threadContext.effectiveReplyToId,
          WasMentioned: true,
          CommandAuthorized: false,
          OriginatingChannel: "mattermost" as const,
          OriginatingTo: to,
        });

        const textLimit = core.channel.text.resolveTextChunkLimit(
          cfg,
          "mattermost",
          account.accountId,
          { fallbackLimit: account.textChunkLimit ?? 4000 },
        );
        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
        });
        const deliveryBarrier = createMattermostReplyDeliveryBarrier({
          isDirect: kind === "direct",
          dmRetryOptions: account.config.dmChannelRetry,
        });
        await core.channel.inbound.dispatch({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          route: {
            agentId: route.agentId,
            dmScope: route.dmScope,
            sessionKey: threadContext.sessionKey,
          },
          ctxPayload,
          delivery: {
            deliver: async (payload: ReplyPayload) => {
              const result = toMattermostChannelDeliveryResult(
                await deliverMattermostReplyPayload({
                  core,
                  cfg,
                  payload,
                  to,
                  accountId: account.accountId,
                  agentId: route.agentId,
                  replyToId: resolveMattermostReplyRootId({
                    kind,
                    threadRootId: threadContext.effectiveReplyToId,
                    replyToId: payload.replyToId,
                  }),
                  textLimit,
                  tableMode,
                  sendMessage: sendMessageMattermost,
                  onDmChannelResolution: deliveryBarrier.trackDmChannelResolution,
                }),
              );
              if (result.visibleReplySent) {
                runtime.log?.(`delivered button-click reply to ${to}`);
              }
              return result;
            },
            onError: (err, info) => {
              runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
            },
          },
          replyPipeline: {
            typing: {
              start: () => sendTypingIndicator(button.channelId, threadContext.effectiveReplyToId),
              onStartError: (err) => {
                logTypingFailure({
                  log: monitor.logDebugMessage,
                  channel: "mattermost",
                  target: button.channelId,
                  error: err,
                });
              },
            },
          },
          dispatcherOptions: {
            resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
            onDeliverySettled: deliveryBarrier.markDeliverySettled,
            humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
          },
          replyOptions: {
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          },
        });
      },
      log: (message) => runtime.log?.(message),
    }),
    pluginId: "mattermost",
    source: "mattermost-interactions",
    accountId: account.accountId,
    log: (message: string) => runtime.log?.(message),
  });
}
