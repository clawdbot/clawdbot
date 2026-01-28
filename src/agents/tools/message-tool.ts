import { Type } from "@sinclair/typebox";
import {
  listChannelMessageActions,
  supportsChannelMessageButtons,
  supportsChannelMessageCards,
} from "../../channels/plugins/message-actions.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../channels/plugins/types.js";
import { BLUEBUBBLES_GROUP_ACTIONS } from "../../channels/plugins/bluebubbles-actions.js";
import type { MoltbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../gateway/protocol/client-info.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { channelTargetSchema, channelTargetsSchema, stringEnum } from "../schema/typebox.js";
import { listChannelSupportedActions } from "../channel-tools.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;
function buildRoutingSchema() {
  return {
    channel: Type.Optional(Type.String()),
    target: Type.Optional(channelTargetSchema({ description: "Target channel/user id or name." })),
    targets: Type.Optional(channelTargetsSchema()),
    accountId: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean()),
  };
}

function buildSendSchema(options: { includeButtons: boolean; includeCards: boolean }) {
  const props: Record<string, unknown> = {
    message: Type.Optional(Type.String()),
    effectId: Type.Optional(
      Type.String({
        description: "Message effect name/id for sendWithEffect (e.g., invisible ink).",
      }),
    ),
    effect: Type.Optional(
      Type.String({ description: "Alias for effectId (e.g., invisible-ink, balloons)." }),
    ),
    media: Type.Optional(Type.String()),
    filename: Type.Optional(Type.String()),
    buffer: Type.Optional(
      Type.String({
        description: "Base64 payload for attachments (optionally a data: URL).",
      }),
    ),
    contentType: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    asVoice: Type.Optional(Type.Boolean()),
    silent: Type.Optional(Type.Boolean()),
    quoteText: Type.Optional(
      Type.String({ description: "Quote text for Telegram reply_parameters" }),
    ),
    bestEffort: Type.Optional(Type.Boolean()),
    gifPlayback: Type.Optional(Type.Boolean()),
    buttons: Type.Optional(
      Type.Array(
        Type.Array(
          Type.Object({
            text: Type.String(),
            callback_data: Type.String(),
          }),
        ),
        {
          description: "Telegram inline keyboard buttons (array of button rows)",
        },
      ),
    ),
    card: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: "Adaptive Card JSON object (when supported by the channel)",
        },
      ),
    ),
  };
  if (!options.includeButtons) delete props.buttons;
  if (!options.includeCards) delete props.card;
  return props;
}

function buildReactionSchema() {
  return {
    messageId: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
    remove: Type.Optional(Type.Boolean()),
    targetAuthor: Type.Optional(Type.String()),
    targetAuthorUuid: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
  };
}

function buildFetchSchema() {
  return {
    limit: Type.Optional(Type.Number()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
    around: Type.Optional(Type.String()),
    fromMe: Type.Optional(Type.Boolean()),
    includeArchived: Type.Optional(Type.Boolean()),
  };
}

function buildPollSchema() {
  return {
    pollQuestion: Type.Optional(Type.String()),
    pollOption: Type.Optional(Type.Array(Type.String())),
    pollDurationHours: Type.Optional(Type.Number()),
    pollMulti: Type.Optional(Type.Boolean()),
  };
}

function buildChannelTargetSchema() {
  return {
    channelId: Type.Optional(
      Type.String({ description: "Channel id filter (search/thread list/event create)." }),
    ),
    channelIds: Type.Optional(
      Type.Array(Type.String({ description: "Channel id filter (repeatable)." })),
    ),
    guildId: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
    authorId: Type.Optional(Type.String()),
    authorIds: Type.Optional(Type.Array(Type.String())),
    roleId: Type.Optional(Type.String()),
    roleIds: Type.Optional(Type.Array(Type.String())),
    participant: Type.Optional(Type.String()),
  };
}

function buildStickerSchema() {
  return {
    emojiName: Type.Optional(Type.String()),
    stickerId: Type.Optional(Type.Array(Type.String())),
    stickerName: Type.Optional(Type.String()),
    stickerDesc: Type.Optional(Type.String()),
    stickerTags: Type.Optional(Type.String()),
  };
}

function buildThreadSchema() {
  return {
    threadName: Type.Optional(Type.String()),
    autoArchiveMin: Type.Optional(Type.Number()),
  };
}

function buildEventSchema() {
  return {
    query: Type.Optional(Type.String()),
    eventName: Type.Optional(Type.String()),
    eventType: Type.Optional(Type.String()),
    startTime: Type.Optional(Type.String()),
    endTime: Type.Optional(Type.String()),
    desc: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    durationMin: Type.Optional(Type.Number()),
    until: Type.Optional(Type.String()),
  };
}

function buildModerationSchema() {
  return {
    reason: Type.Optional(Type.String()),
    deleteDays: Type.Optional(Type.Number()),
  };
}

function buildGatewaySchema() {
  return {
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  };
}

function buildChannelManagementSchema() {
  return {
    name: Type.Optional(Type.String()),
    type: Type.Optional(Type.Number()),
    parentId: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    position: Type.Optional(Type.Number()),
    nsfw: Type.Optional(Type.Boolean()),
    rateLimitPerUser: Type.Optional(Type.Number()),
    categoryId: Type.Optional(Type.String()),
    clearParent: Type.Optional(
      Type.Boolean({
        description: "Clear the parent/category when supported by the provider.",
      }),
    ),
  };
}

function buildMessageToolSchemaProps(options: { includeButtons: boolean; includeCards: boolean }) {
  return {
    ...buildRoutingSchema(),
    ...buildSendSchema(options),
    ...buildReactionSchema(),
    ...buildFetchSchema(),
    ...buildPollSchema(),
    ...buildChannelTargetSchema(),
    ...buildStickerSchema(),
    ...buildThreadSchema(),
    ...buildEventSchema(),
    ...buildModerationSchema(),
    ...buildGatewaySchema(),
    ...buildChannelManagementSchema(),
  };
}

function buildMessageToolSchemaFromActions(
  actions: readonly string[],
  options: { includeButtons: boolean; includeCards: boolean },
) {
  const props = buildMessageToolSchemaProps(options);
  return Type.Object({
    action: stringEnum(actions),
    ...props,
  });
}

const MessageToolSchema = buildMessageToolSchemaFromActions(AllMessageActions, {
  includeButtons: true,
  includeCards: true,
});

type MessageToolOptions = {
  agentAccountId?: string;
  agentSessionKey?: string;
  config?: MoltbotConfig;
  currentChannelId?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
};

function buildMessageToolSchema(cfg: MoltbotConfig) {
  const actions = listChannelMessageActions(cfg);
  const includeButtons = supportsChannelMessageButtons(cfg);
  const includeCards = supportsChannelMessageCards(cfg);
  return buildMessageToolSchemaFromActions(actions.length > 0 ? actions : ["send"], {
    includeButtons,
    includeCards,
  });
}

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return normalizeAccountId(trimmed);
}

function filterActionsForContext(params: {
  actions: ChannelMessageActionName[];
  channel?: string;
  currentChannelId?: string;
}): ChannelMessageActionName[] {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel !== "bluebubbles") return params.actions;
  const currentChannelId = params.currentChannelId?.trim();
  if (!currentChannelId) return params.actions;
  const normalizedTarget =
    normalizeTargetForProvider(channel, currentChannelId) ?? currentChannelId;
  const lowered = normalizedTarget.trim().toLowerCase();
  const isGroupTarget =
    lowered.startsWith("chat_guid:") ||
    lowered.startsWith("chat_id:") ||
    lowered.startsWith("chat_identifier:") ||
    lowered.startsWith("group:");
  if (isGroupTarget) return params.actions;
  return params.actions.filter((action) => !BLUEBUBBLES_GROUP_ACTIONS.has(action));
}

function buildMessageToolDescription(options?: {
  config?: MoltbotConfig;
  currentChannel?: string;
  currentChannelId?: string;
}): string {
  const baseDescription = "Send, delete, and manage messages via channel plugins.";

  // If we have a current channel, show only its supported actions
  if (options?.currentChannel) {
    const channelActions = filterActionsForContext({
      actions: listChannelSupportedActions({
        cfg: options.config,
        channel: options.currentChannel,
      }),
      channel: options.currentChannel,
      currentChannelId: options.currentChannelId,
    });
    if (channelActions.length > 0) {
      // Always include "send" as a base action
      const allActions = new Set(["send", ...channelActions]);
      const actionList = Array.from(allActions).sort().join(", ");
      return `${baseDescription} Current channel (${options.currentChannel}) supports: ${actionList}.`;
    }
  }

  // Fallback to generic description with all configured actions
  if (options?.config) {
    const actions = listChannelMessageActions(options.config);
    if (actions.length > 0) {
      return `${baseDescription} Supports actions: ${actions.join(", ")}.`;
    }
  }

  return `${baseDescription} Supports actions: send, delete, react, poll, pin, threads, and more.`;
}

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  const schema = options?.config ? buildMessageToolSchema(options.config) : MessageToolSchema;
  const description = buildMessageToolDescription({
    config: options?.config,
    currentChannel: options?.currentChannelProvider,
    currentChannelId: options?.currentChannelId,
  });

  return {
    label: "Message",
    name: "message",
    description,
    parameters: schema,
    execute: async (_toolCallId, args, signal) => {
      // Check if already aborted before doing any work
      if (signal?.aborted) {
        const err = new Error("Message send aborted");
        err.name = "AbortError";
        throw err;
      }
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();
      const action = readStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;

      const accountId = readStringParam(params, "accountId") ?? agentAccountId;
      if (accountId) {
        params.accountId = accountId;
      }

      const gateway = {
        url: readStringParam(params, "gatewayUrl", { trim: false }),
        token: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: readNumberParam(params, "timeoutMs"),
        clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        clientDisplayName: "agent",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      };

      const toolContext =
        options?.currentChannelId ||
        options?.currentChannelProvider ||
        options?.currentThreadTs ||
        options?.replyToMode ||
        options?.hasRepliedRef
          ? {
              currentChannelId: options?.currentChannelId,
              currentChannelProvider: options?.currentChannelProvider,
              currentThreadTs: options?.currentThreadTs,
              replyToMode: options?.replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
              // Direct tool invocations should not add cross-context decoration.
              // The agent is composing a message, not forwarding from another chat.
              skipCrossContextDecoration: true,
            }
          : undefined;

      const result = await runMessageAction({
        cfg,
        action,
        params,
        defaultAccountId: accountId ?? undefined,
        gateway,
        toolContext,
        agentId: options?.agentSessionKey
          ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg })
          : undefined,
        abortSignal: signal,
      });

      const toolResult = getToolResult(result);
      if (toolResult) return toolResult;
      return jsonResult(result.payload);
    },
  };
}
