// Mattermost plugin module registers interactive callback transport handling.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { parseMattermostQuestionContext } from "../normalize.js";
import {
  createMattermostInteractionHandler,
  type MattermostInteractionResponse,
} from "./interactions.js";
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

/**
 * Answer an ask_user question from the button its own prompt offered.
 *
 * The Gateway owns the answer, so this consumes the click instead of letting it
 * fall through to the synthetic `[Button click: ...]` message the generic path
 * sends; that message would reach the agent as prose while the question stayed
 * open.
 */
type MattermostInteractionDispatch = NonNullable<
  Parameters<typeof createMattermostInteractionHandler>[0]["handleInteraction"]
>;

export function createMattermostQuestionInteractionHandler(
  monitor: MattermostMonitorContext,
): MattermostInteractionDispatch {
  const { account, cfg, core, pairing, resources, runtime } = monitor;
  return async (interaction) => {
    const selection = parseMattermostQuestionContext(interaction.context);
    if (!selection) {
      return null;
    }
    // Resolving the question is a privileged Gateway write, so it takes its own
    // current-policy decision at the point of effect, the same way the
    // model-picker handler does, instead of leaning on the transport's earlier
    // check.
    const channelInfo = await resources.resolveChannelInfo(interaction.payload.channel_id);
    const auth = await authorizeMattermostCommandInvocation({
      account,
      cfg,
      senderId: interaction.payload.user_id,
      senderName: interaction.userName,
      channelId: interaction.payload.channel_id,
      channelInfo,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands: core.channel.commands.shouldHandleTextCommands({
        cfg,
        surface: "mattermost",
      }),
      hasControlCommand: false,
    });
    if (!auth.ok) {
      // No Gateway I/O for a click current policy refuses; the prompt stays usable.
      return { ephemeral_text: `OpenClaw ignored this action for ${auth.roomLabel}.` };
    }
    try {
      const result = await questionGatewayRuntime.resolveOption({
        cfg,
        questionId: selection.questionId,
        optionIndex: selection.optionIndex,
        senderId: interaction.payload.user_id,
        clientDisplayName: `Mattermost question (${account.accountId})`,
      });
      if (result.status !== "answered") {
        return { ephemeral_text: "This question was already answered." };
      }
    } catch (err) {
      runtime.error?.(`mattermost question interaction failed: ${String(err)}`);
      // The buttons survive an unaccepted click so it can be retried.
      return { ephemeral_text: "Could not submit this answer." };
    }
    // Only an accepted answer retires the prompt.
    const response: MattermostInteractionResponse = {
      update: {
        message: interaction.post.message ?? "",
        props: {
          attachments: [
            { text: `✓ **${interaction.actionName}** selected by @${interaction.userName}` },
          ],
        },
      },
      ephemeral_text: "Answer submitted.",
    };
    return response;
  };
}

export function registerMattermostInteractions(params: {
  monitor: MattermostMonitorContext;
  interactionPath: string;
  allowedSourceIps: string[];
  handleModelPickerInteraction: MattermostModelPickerInteractionHandler;
}): () => void {
  const { monitor } = params;
  const { account, botUserId, cfg, client, core, pairing, resources, runtime } = monitor;
  const { resolveChannelInfo } = resources;
  const handleQuestionInteraction = createMattermostQuestionInteractionHandler(monitor);
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
      handleInteraction: async (interaction) =>
        (await handleQuestionInteraction(interaction)) ??
        (await params.handleModelPickerInteraction(interaction)),
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
