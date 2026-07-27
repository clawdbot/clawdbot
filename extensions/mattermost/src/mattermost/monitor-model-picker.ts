// Mattermost plugin module owns native model-picker interactions.
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveMattermostReplyToMode } from "./accounts.js";
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
  resolveMattermostThreadSessionContext,
} from "./monitor-context.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import {
  createMattermostReplyDeliveryBarrier,
  deliverMattermostReplyPayload,
  toMattermostChannelDeliveryResult,
} from "./reply-delivery.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";
import { buildModelsProviderData, logTypingFailure } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

type RunModelPickerCommandParams = {
  commandText: string;
  commandAuthorized: boolean;
  route: ResolvedAgentRoute;
  sessionKey: string;
  parentSessionKey?: string;
  channelId: string;
  senderId: string;
  senderName: string;
  kind: ChatType;
  channelName?: string;
  channelDisplay?: string;
  roomLabel: string;
  teamId?: string;
  messageSid: string;
  effectiveReplyToId?: string;
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
  const { resolveChannelInfo, sendTypingIndicator, updateModelPickerPost } = resources;

  const runModelPickerCommand = async (params: RunModelPickerCommandParams): Promise<void> => {
    const to = params.kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
    const fromLabel =
      params.kind === "direct"
        ? `Mattermost DM from ${params.senderName}`
        : `Mattermost message in ${params.roomLabel} from ${params.senderName}`;
    const ctxPayload = finalizeInboundContext({
      Body: params.commandText,
      BodyForAgent: params.commandText,
      RawBody: params.commandText,
      CommandBody: params.commandText,
      From:
        params.kind === "direct"
          ? `mattermost:${params.senderId}`
          : params.kind === "group"
            ? `mattermost:group:${params.channelId}`
            : `mattermost:channel:${params.channelId}`,
      To: to,
      SessionKey: params.sessionKey,
      DmScope: params.route.dmScope,
      ParentSessionKey: params.parentSessionKey,
      AccountId: params.route.accountId,
      ChatType: params.kind,
      ConversationLabel: fromLabel,
      GroupSubject:
        params.kind !== "direct" ? params.channelDisplay || params.roomLabel : undefined,
      GroupChannel: params.channelName ? `#${params.channelName}` : undefined,
      GroupSpace: params.teamId,
      SenderName: params.senderName,
      SenderId: params.senderId,
      Provider: "mattermost" as const,
      Surface: "mattermost" as const,
      MessageSid: params.messageSid,
      ReplyToId: params.effectiveReplyToId,
      MessageThreadId: params.effectiveReplyToId,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: params.commandAuthorized,
      CommandSource: "native" as const,
      OriginatingChannel: "mattermost" as const,
      OriginatingTo: to,
    });

    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
    });
    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "mattermost",
      account.accountId,
      { fallbackLimit: account.textChunkLimit ?? 4000 },
    );
    const deliveryBarrier = createMattermostReplyDeliveryBarrier({
      isDirect: params.kind === "direct",
      dmRetryOptions: account.config.dmChannelRetry,
    });
    await core.channel.inbound.dispatch({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      route: {
        agentId: params.route.agentId,
        dmScope: params.route.dmScope,
        sessionKey: params.sessionKey,
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
              agentId: params.route.agentId,
              replyToId: resolveMattermostReplyRootId({
                kind: params.kind,
                threadRootId: params.effectiveReplyToId,
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
      replyPipeline: {
        typing: {
          start: () => sendTypingIndicator(params.channelId, params.effectiveReplyToId),
          onStartError: (err) => {
            logTypingFailure({
              log: monitor.logDebugMessage,
              channel: "mattermost",
              target: params.channelId,
              error: err,
            });
          },
        },
      },
      dispatcherOptions: {
        resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
        onDeliverySettled: deliveryBarrier.markDeliverySettled,
      },
      replyOptions: {
        disableBlockStreaming:
          typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
      },
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

    const { channelDisplay, channelName, kind, roomLabel } = auth;
    const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? undefined;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? params.payload.user_id : params.payload.channel_id,
      },
    });
    const threadContext = resolveMattermostThreadSessionContext({
      baseSessionKey: route.sessionKey,
      kind,
      postId: params.post.id || params.payload.post_id,
      replyToMode: resolveMattermostReplyToMode(account, kind),
      threadRootId: params.post.root_id,
    });
    const modelSessionRoute = { agentId: route.agentId, sessionKey: threadContext.sessionKey };
    const data = await buildModelsProviderData(cfg, route.agentId);
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
          route,
          sessionKey: threadContext.sessionKey,
          parentSessionKey: threadContext.parentSessionKey,
          channelId: params.payload.channel_id,
          senderId: params.payload.user_id,
          senderName: params.userName,
          kind,
          channelName: channelName || undefined,
          channelDisplay: channelDisplay || channelName || params.payload.channel_id,
          roomLabel,
          teamId,
          messageSid: buildMattermostModelPickerSelectMessageSid({
            postId: params.payload.post_id,
            provider: pickerState.provider,
            model: pickerState.model,
          }),
          effectiveReplyToId: threadContext.effectiveReplyToId,
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
