// Mattermost plugin module registers interactive callback transport handling.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import { createMattermostInteractionHandler } from "./interactions.js";
import { authorizeMattermostCommandInvocation } from "./monitor-auth.js";
import {
  buildMattermostButtonInteractionMessageSid,
  resolveMattermostInteractionReplyRootId,
} from "./monitor-context.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type {
  MattermostIngressInteraction,
  MattermostIngressLifecycle,
} from "./monitor-ingress.js";
import type { MattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type { ReplyPayload } from "./runtime-api.js";
import { registerPluginHttpRoute } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

/**
 * Resolve whether this sender may act on this channel right now.
 *
 * The transport asks before recording a click and the drain asks again before the
 * agent sees it: a recorded click carries no authority of its own, so a press taken
 * before an allowlist narrowed must not still act after it.
 */
async function resolveMattermostInteractionAccess(
  monitor: MattermostMonitorContext,
  params: { senderId: string; senderName: string; channelId: string },
) {
  const { account, cfg, core, pairing, resources } = monitor;
  return await authorizeMattermostCommandInvocation({
    account,
    cfg,
    senderId: params.senderId,
    senderName: params.senderName,
    channelId: params.channelId,
    channelInfo: await resources.resolveChannelInfo(params.channelId),
    readStoreAllowFrom: pairing.readAllowFromStore,
    allowTextCommands: core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    }),
    hasControlCommand: false,
  });
}

export function registerMattermostInteractions(params: {
  monitor: MattermostMonitorContext;
  interactionPath: string;
  allowedSourceIps: string[];
  handleModelPickerInteraction: MattermostModelPickerInteractionHandler;
  admitInteraction: (interaction: MattermostIngressInteraction) => Promise<void>;
}): () => void {
  const { monitor } = params;
  const { account, botUserId, cfg, client, runtime } = monitor;
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
        const decision = await resolveMattermostInteractionAccess(monitor, {
          senderId: payload.user_id,
          senderName: payload.user_name ?? "",
          channelId: payload.channel_id,
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
      admitInteraction: params.admitInteraction,
      log: (message) => runtime.log?.(message),
    }),
    pluginId: "mattermost",
    source: "mattermost-interactions",
    accountId: account.accountId,
    log: (message: string) => runtime.log?.(message),
    throwOnFailure: true,
  });
}

/** Whether a recorded click was handed to a turn, or settled without reaching one. */
export type MattermostInteractionDispatchOutcome = "dispatched" | "dropped";

/**
 * Answer a recorded button click.
 *
 * The transport records the click and returns; this runs from the durable drain,
 * so a restart, a crash, or a throwing turn replays it instead of losing it.
 */
export function createMattermostInteractionDispatch(
  monitor: MattermostMonitorContext,
): (
  interaction: MattermostIngressInteraction,
  turnAdoptionLifecycle: MattermostIngressLifecycle,
) => Promise<MattermostInteractionDispatchOutcome> {
  const { account, cfg, core, runtime } = monitor;
  return async (interaction, turnAdoptionLifecycle) => {
    // A stored click is evidence that a press happened, never a standing grant.
    const access = await resolveMattermostInteractionAccess(monitor, {
      senderId: interaction.userId,
      senderName: interaction.userName,
      channelId: interaction.channelId,
    });
    if (!access.ok) {
      runtime.log?.(
        `mattermost: dropping recorded button click for ${interaction.userName} (${access.roomLabel})`,
      );
      return "dropped";
    }
    const interactionMessageSid = buildMattermostButtonInteractionMessageSid({
      postId: interaction.postId,
      actionId: interaction.actionId,
      eventId: interaction.eventId,
    });
    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId: interaction.channelId,
      senderId: interaction.userId,
      postId: interaction.postId,
      threadRootId: interaction.rootId,
      dropLabel: "interaction dispatch",
    });
    if (!eventPlan) {
      return "dropped";
    }
    const { channelDisplay, channelId, kind, route, thread, to } = eventPlan;
    core.system.enqueueSystemEvent(
      `Mattermost button click: action="${interaction.actionId}" ` +
        `by ${interaction.userName} in channel ${interaction.channelId}`,
      { sessionKey: thread.sessionKey, contextKey: `mattermost:${interactionMessageSid}` },
    );
    const bodyText = `[Button click: user @${interaction.userName} selected "${interaction.actionName}"]`;
    const ctxPayload = eventPlan.finalizeContext({
      Body: bodyText,
      BodyForAgent: bodyText,
      RawBody: bodyText,
      CommandBody: bodyText,
      ConversationLabel: `mattermost:${interaction.userName}`,
      GroupSubject: kind !== "direct" ? channelDisplay || interaction.channelId : undefined,
      SenderName: interaction.userName,
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
              sourcePostId: interaction.postId,
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
      // The claim belongs to the drain until the turn adopts it, so an interrupted
      // click is replayed rather than completed by having merely been started.
      replyOptions: {
        ...replyOptions,
        ...bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle),
      },
    });
    return "dispatched";
  };
}
