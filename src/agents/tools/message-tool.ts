import { Type } from "@sinclair/typebox";
import {
  listChannelMessageActions,
  supportsChannelMessageButtons,
} from "../../channels/plugins/message-actions.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../gateway/protocol/client-info.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;

const MessageToolCommonSchema = {
  channel: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  media: Type.Optional(Type.String()),
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
  messageId: Type.Optional(Type.String()),
  replyTo: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  dryRun: Type.Optional(Type.Boolean()),
  bestEffort: Type.Optional(Type.Boolean()),
  gifPlayback: Type.Optional(Type.Boolean()),
  emoji: Type.Optional(Type.String()),
  remove: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number()),
  before: Type.Optional(Type.String()),
  after: Type.Optional(Type.String()),
  around: Type.Optional(Type.String()),
  pollQuestion: Type.Optional(Type.String()),
  pollOption: Type.Optional(Type.Array(Type.String())),
  pollDurationHours: Type.Optional(Type.Number()),
  pollMulti: Type.Optional(Type.Boolean()),
  channelId: Type.Optional(Type.String()),
  channelIds: Type.Optional(Type.Array(Type.String())),
  guildId: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
  authorId: Type.Optional(Type.String()),
  authorIds: Type.Optional(Type.Array(Type.String())),
  roleId: Type.Optional(Type.String()),
  roleIds: Type.Optional(Type.Array(Type.String())),
  emojiName: Type.Optional(Type.String()),
  stickerId: Type.Optional(Type.Array(Type.String())),
  stickerName: Type.Optional(Type.String()),
  stickerDesc: Type.Optional(Type.String()),
  stickerTags: Type.Optional(Type.String()),
  threadName: Type.Optional(Type.String()),
  autoArchiveMin: Type.Optional(Type.Number()),
  query: Type.Optional(Type.String()),
  eventName: Type.Optional(Type.String()),
  eventType: Type.Optional(Type.String()),
  startTime: Type.Optional(Type.String()),
  endTime: Type.Optional(Type.String()),
  desc: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  durationMin: Type.Optional(Type.Number()),
  until: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  deleteDays: Type.Optional(Type.Number()),
  includeArchived: Type.Optional(Type.Boolean()),
  participant: Type.Optional(Type.String()),
  fromMe: Type.Optional(Type.Boolean()),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
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

function buildMessageToolSchemaFromActions(
  actions: readonly string[],
  options: { includeButtons: boolean },
) {
  const props: Record<string, unknown> = { ...MessageToolCommonSchema };
  if (!options.includeButtons) delete props.buttons;

  return Type.Object({
    action: stringEnum(actions),
    ...props,
  });
}

const MessageToolSchema = buildMessageToolSchemaFromActions(AllMessageActions, {
  includeButtons: true,
});

type MessageToolOptions = {
  agentAccountId?: string;
  config?: ClawdbotConfig;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
};

function buildMessageToolSchema(cfg: ClawdbotConfig) {
  const actions = listChannelMessageActions(cfg);
  const includeButtons = supportsChannelMessageButtons(cfg);
  return buildMessageToolSchemaFromActions(
    actions.length > 0 ? actions : ["send"],
    { includeButtons },
  );
}

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return normalizeAccountId(trimmed);
}

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  const schema = options?.config
    ? buildMessageToolSchema(options.config)
    : MessageToolSchema;

  return {
    label: "Message",
    name: "message",
    description:
      "Send messages and channel actions (polls, reactions, pins, threads, etc.) via configured channel plugins.",
    parameters: schema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();
      const action = readStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      const accountId = readStringParam(params, "accountId") ?? agentAccountId;

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
        options?.currentThreadTs ||
        options?.replyToMode ||
        options?.hasRepliedRef
          ? {
              currentChannelId: options?.currentChannelId,
              currentThreadTs: options?.currentThreadTs,
              replyToMode: options?.replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
            }
          : undefined;

      const result = await runMessageAction({
        cfg,
        action,
        params,
        defaultAccountId: accountId ?? undefined,
        gateway,
        toolContext,
      });

      if (result.toolResult) return result.toolResult;
      return jsonResult(result.payload);
    },
  };
}
