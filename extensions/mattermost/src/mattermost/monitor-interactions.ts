// Mattermost plugin module registers interactive callback transport handling.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { createMattermostInteractionHandler } from "./interactions.js";
import { authorizeMattermostCommandInvocation } from "./monitor-auth.js";
import {
  buildMattermostButtonInteractionMessageSid,
  resolveMattermostInteractionReplyRootId,
} from "./monitor-context.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type { ReplyPayload } from "./runtime-api.js";
import { registerPluginHttpRoute } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

export function registerMattermostInteractions(params: {
  monitor: MattermostMonitorContext;
  interactionPath: string;
  allowedSourceIps: string[];
  handleModelPickerInteraction: MattermostModelPickerInteractionHandler;
}): () => void {
  const { monitor } = params;
  const { account, botUserId, cfg, client, core, pairing, resources, runtime } = monitor;
  const { resolveChannelInfo } = resources;
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
        const eventPlan = await buildMattermostEventPlan(monitor, {
          channelId,
          senderId: userId,
          postId: post.id,
          threadRootId: post.root_id,
          dropLabel: "interaction session event",
        });
        if (!eventPlan) {
          throw new Error("Mattermost channel type could not be resolved");
        }
        return eventPlan.thread.sessionKey;
      },
      dispatchButtonClick: async (button) => {
        const sourcePostId = button.post.id || button.postId;
        const interactionMessageSid = buildMattermostButtonInteractionMessageSid({
          postId: button.postId,
          actionId: button.actionId,
        });
        const eventPlan = await buildMattermostEventPlan(monitor, {
          channelId: button.channelId,
          senderId: button.userId,
          postId: sourcePostId,
          threadRootId: button.post.root_id,
          dropLabel: "interaction dispatch",
        });
        if (!eventPlan) {
          return;
        }
        const { channelDisplay, channelId, kind, route, thread, to } = eventPlan;
        const bodyText = `[Button click: user @${button.userName} selected "${button.actionName}"]`;
        const ctxPayload = eventPlan.finalizeContext({
          Body: bodyText,
          BodyForAgent: bodyText,
          RawBody: bodyText,
          CommandBody: bodyText,
          ConversationLabel: `mattermost:${button.userName}`,
          GroupSubject: kind !== "direct" ? channelDisplay || button.channelId : undefined,
          SenderName: button.userName,
          MessageSid: interactionMessageSid,
          WasMentioned: true,
          CommandAuthorized: false,
        });
        const { replyOptions, replyPipeline, tableMode, textLimit } = eventPlan.createReplyPlan();
        await core.channel.inbound.dispatch({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          route: {
            agentId: route.agentId,
            dmScope: route.dmScope,
            sessionKey: thread.sessionKey,
          },
          ctxPayload,
          delivery: {
            observeMessageSent: true,
            deliver: async (payload: ReplyPayload) => {
              const result = await deliverMattermostReplyPayload({
                core,
                cfg,
                payload,
                channelId,
                accountId: account.accountId,
                agentId: route.agentId,
                replyToId: resolveMattermostInteractionReplyRootId({
                  kind,
                  threadRootId: thread.effectiveReplyToId,
                  replyToId: payload.replyToId,
                  interactionMessageSid,
                  sourcePostId,
                }),
                textLimit,
                tableMode,
                sendMessage: sendMessageMattermost,
              });
              if (result.visibleReplySent) {
                runtime.log?.(`delivered button-click reply to ${to}`);
              }
              return result;
            },
            onError: (err, info) => {
              runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
            },
          },
          replyPipeline,
          dispatcherOptions: {
            humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
          },
          replyOptions,
        });
      },
      log: (message) => runtime.log?.(message),
    }),
    pluginId: "mattermost",
    source: "mattermost-interactions",
    accountId: account.accountId,
    log: (message: string) => runtime.log?.(message),
    throwOnFailure: true,
  });
}
