// Mattermost plugin module owns native model-picker interactions.
import type { MattermostPost } from "./client.js";
import type { MattermostInteractionResponse } from "./interactions.js";
import {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
} from "./model-picker.js";
import { authorizeMattermostCommandInvocation } from "./monitor-auth.js";
import {
  buildMattermostModelPickerSelectMessageSid,
  resolveMattermostReplyRootId,
} from "./monitor-context.js";
import { buildMattermostEventPlan, type MattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import {
  deliverMattermostReplyPayload,
  toMattermostChannelDeliveryResult,
} from "./reply-delivery.js";
import type { ReplyPayload } from "./runtime-api.js";
import { buildModelsProviderData } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

type RunModelPickerCommandParams = {
  commandText: string;
  commandAuthorized: boolean;
  eventPlan: MattermostEventPlan;
  senderName: string;
  messageSid: string;
};

export type MattermostModelPickerInteractionHandler = (params: {
  payload: {
    channel_id: string;
    post_id: string;
    team_id?: string;
    user_id: string;
  };
  userName: string;
  context: Record<string, unknown>;
  post: MattermostPost;
}) => Promise<MattermostInteractionResponse | null>;

export function createMattermostModelPickerInteractionHandler(
  monitor: MattermostMonitorContext,
): MattermostModelPickerInteractionHandler {
  const { account, cfg, core, pairing, resources, runtime } = monitor;
  const { resolveChannelInfo, updateModelPickerPost } = resources;

  const runModelPickerCommand = async (params: RunModelPickerCommandParams): Promise<void> => {
    const { channelDisplay, kind, roomLabel, route, thread, to } = params.eventPlan;
    const fromLabel =
      kind === "direct"
        ? `Mattermost DM from ${params.senderName}`
        : `Mattermost message in ${roomLabel} from ${params.senderName}`;
    const ctxPayload = params.eventPlan.finalizeContext({
      Body: params.commandText,
      BodyForAgent: params.commandText,
      RawBody: params.commandText,
      CommandBody: params.commandText,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
      SenderName: params.senderName,
      MessageSid: params.messageSid,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: params.commandAuthorized,
      CommandSource: "native" as const,
    });
    const { deliveryBarrier, replyOptions, replyPipeline, tableMode, textLimit } =
      params.eventPlan.createReplyPlan();
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
        // Picker-triggered confirmations should stay immediate.
        deliver: async (payload: ReplyPayload) => {
          const trimmedPayload = {
            ...payload,
            text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode).trim(),
          };
          return toMattermostChannelDeliveryResult(
            await deliverMattermostReplyPayload({
              core,
              cfg,
              payload: trimmedPayload,
              to,
              accountId: account.accountId,
              agentId: route.agentId,
              replyToId: resolveMattermostReplyRootId({
                kind,
                threadRootId: thread.effectiveReplyToId,
                replyToId: trimmedPayload.replyToId,
              }),
              textLimit,
              // The picker path already converts and trims text before delivery.
              tableMode: "off",
              sendMessage: sendMessageMattermost,
              onDmChannelResolution: deliveryBarrier.trackDmChannelResolution,
            }),
          );
        },
        onError: (err, info) => {
          runtime.error?.(`mattermost model picker ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyPipeline,
      dispatcherOptions: {
        resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
        onDeliverySettled: deliveryBarrier.markDeliverySettled,
      },
      replyOptions,
    });
  };

  return async (params) => {
    const pickerState = parseMattermostModelPickerContext(params.context);
    if (!pickerState) {
      return null;
    }
    if (pickerState.ownerUserId !== params.payload.user_id) {
      return { ephemeral_text: "Only the person who opened this picker can use it." };
    }
    const updatePickerPost = (message: string, buttons?: Array<unknown>) =>
      updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message,
        buttons,
      });

    const channelInfo = await resolveChannelInfo(params.payload.channel_id);
    const pickerCommandText =
      pickerState.action === "select"
        ? `/model ${pickerState.provider}/${pickerState.model}`
        : pickerState.action === "list"
          ? `/models ${pickerState.provider}`
          : "/models";
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const auth = await authorizeMattermostCommandInvocation({
      account,
      cfg,
      senderId: params.payload.user_id,
      senderName: params.userName,
      channelId: params.payload.channel_id,
      channelInfo,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(pickerCommandText, cfg),
    });
    if (!auth.ok) {
      if (auth.denyReason === "dm-pairing") {
        const { code } = await pairing.upsertPairingRequest({
          id: params.payload.user_id,
          meta: { name: params.userName },
        });
        return {
          ephemeral_text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${params.payload.user_id}`,
            code,
          }),
        };
      }
      const denyText =
        auth.denyReason === "unknown-channel"
          ? "Temporary error: unable to determine channel type. Please try again."
          : auth.denyReason === "dm-disabled"
            ? "This bot is not accepting direct messages."
            : auth.denyReason === "channels-disabled"
              ? "Model picker actions are disabled in channels."
              : auth.denyReason === "channel-no-allowlist"
                ? "Model picker actions are not configured for this channel."
                : "Unauthorized.";
      return { ephemeral_text: denyText };
    }

    const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? undefined;
    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId: params.payload.channel_id,
      senderId: params.payload.user_id,
      postId: params.post.id || params.payload.post_id,
      threadRootId: params.post.root_id,
      channelInfo: auth.channelInfo,
      teamId,
      channelName: auth.channelName,
      channelDisplay: auth.channelDisplay,
      dropLabel: "model picker event",
    });
    if (!eventPlan) {
      return {
        ephemeral_text: "Temporary error: unable to determine channel type. Please try again.",
      };
    }
    const modelSessionRoute = {
      agentId: eventPlan.route.agentId,
      sessionKey: eventPlan.thread.sessionKey,
    };
    const data = await buildModelsProviderData(cfg, eventPlan.route.agentId);
    if (data.providers.length === 0) {
      return await updatePickerPost("No models available.");
    }

    if (pickerState.action === "providers" || pickerState.action === "back") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
      });
      const view = renderMattermostProviderPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        currentModel,
      });
      return await updatePickerPost(view.text, view.buttons);
    }

    if (pickerState.action === "list") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
      });
      const view = renderMattermostModelsPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        provider: pickerState.provider,
        page: pickerState.page,
        currentModel,
      });
      return await updatePickerPost(view.text, view.buttons);
    }

    const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
    if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) {
      return { ephemeral_text: `That model is no longer available: ${targetModelRef}` };
    }

    void (async () => {
      try {
        await runModelPickerCommand({
          commandText: `/model ${targetModelRef}`,
          commandAuthorized: auth.commandAuthorized,
          eventPlan,
          senderName: params.userName,
          messageSid: buildMattermostModelPickerSelectMessageSid({
            postId: params.payload.post_id,
            provider: pickerState.provider,
            model: pickerState.model,
          }),
        });
        const currentModel = resolveMattermostModelPickerCurrentModel({
          cfg,
          route: modelSessionRoute,
          data,
          readConsistency: "latest",
        });
        const view = renderMattermostModelsPickerView({
          ownerUserId: pickerState.ownerUserId,
          data,
          provider: pickerState.provider,
          page: pickerState.page,
          currentModel,
        });
        await updatePickerPost(view.text, view.buttons);
      } catch (err) {
        runtime.error?.(`mattermost model picker select failed: ${String(err)}`);
      }
    })();

    return {};
  };
}
