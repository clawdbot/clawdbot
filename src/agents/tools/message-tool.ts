import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  type MessagePollResult,
  type MessageSendResult,
  sendMessage,
  sendPoll,
} from "../../infra/outbound/message.js";
import { resolveMessageProviderSelection } from "../../infra/outbound/provider-selection.js";
import {
  dispatchProviderMessageAction,
  listProviderMessageActions,
  supportsProviderMessageButtons,
} from "../../providers/plugins/message-actions.js";
import type { ProviderMessageActionName } from "../../providers/plugins/types.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const MessageActionSchema = Type.Union([
  Type.Literal("send"),
  Type.Literal("poll"),
  Type.Literal("react"),
  Type.Literal("reactions"),
  Type.Literal("read"),
  Type.Literal("edit"),
  Type.Literal("delete"),
  Type.Literal("pin"),
  Type.Literal("unpin"),
  Type.Literal("list-pins"),
  Type.Literal("permissions"),
  Type.Literal("thread-create"),
  Type.Literal("thread-list"),
  Type.Literal("thread-reply"),
  Type.Literal("search"),
  Type.Literal("sticker"),
  Type.Literal("member-info"),
  Type.Literal("role-info"),
  Type.Literal("emoji-list"),
  Type.Literal("emoji-upload"),
  Type.Literal("sticker-upload"),
  Type.Literal("role-add"),
  Type.Literal("role-remove"),
  Type.Literal("channel-info"),
  Type.Literal("channel-list"),
  Type.Literal("voice-status"),
  Type.Literal("event-list"),
  Type.Literal("event-create"),
  Type.Literal("timeout"),
  Type.Literal("kick"),
  Type.Literal("ban"),
]);

const MessageToolSchema = Type.Object({
  action: MessageActionSchema,
  provider: Type.Optional(Type.String()),
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
});

type MessageToolOptions = {
  agentAccountId?: string;
  config?: ClawdbotConfig;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
};

function buildMessageActionSchema(cfg: ClawdbotConfig) {
  const actions = listProviderMessageActions(cfg);
  if (actions.length === 0) return MessageActionSchema;
  return Type.Union(actions.map((action) => Type.Literal(action)));
}

function buildMessageToolSchema(cfg: ClawdbotConfig) {
  const base = MessageToolSchema as unknown as Record<string, unknown>;
  const baseProps = (base.properties ?? {}) as Record<string, unknown>;
  const props: Record<string, unknown> = {
    ...baseProps,
    action: buildMessageActionSchema(cfg),
  };

  if (!supportsProviderMessageButtons(cfg)) {
    delete props.buttons;
  }

  return { ...base, properties: props };
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
      "Send messages and provider-specific actions (Discord/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams).",
    parameters: schema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();
      const action = readStringParam(params, "action", {
        required: true,
      }) as ProviderMessageActionName;
      const providerSelection = await resolveMessageProviderSelection({
        cfg,
        provider: readStringParam(params, "provider"),
      });
      const provider = providerSelection.provider;
      const accountId = readStringParam(params, "accountId") ?? agentAccountId;
      const gateway = {
        url: readStringParam(params, "gatewayUrl", { trim: false }),
        token: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: readNumberParam(params, "timeoutMs"),
        clientName: "agent" as const,
        mode: "agent" as const,
      };
      const dryRun = Boolean(params.dryRun);
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

      if (action === "send") {
        const to = readStringParam(params, "to", { required: true });
        const message = readStringParam(params, "message", {
          required: true,
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "media", { trim: false });
        const gifPlayback =
          typeof params.gifPlayback === "boolean" ? params.gifPlayback : false;
        const bestEffort =
          typeof params.bestEffort === "boolean"
            ? params.bestEffort
            : undefined;

        if (dryRun) {
          const result: MessageSendResult = await sendMessage({
            to,
            content: message,
            mediaUrl: mediaUrl || undefined,
            provider: provider || undefined,
            accountId: accountId ?? undefined,
            gifPlayback,
            dryRun,
            bestEffort,
            gateway,
          });
          return jsonResult(result);
        }

        const handled = await dispatchProviderMessageAction({
          provider,
          action,
          cfg,
          params,
          accountId,
          gateway,
          toolContext,
          dryRun,
        });
        if (handled) return handled;

        const result: MessageSendResult = await sendMessage({
          to,
          content: message,
          mediaUrl: mediaUrl || undefined,
          provider: provider || undefined,
          accountId: accountId ?? undefined,
          gifPlayback,
          dryRun,
          bestEffort,
          gateway,
        });
        return jsonResult(result);
      }

      if (action === "poll") {
        const to = readStringParam(params, "to", { required: true });
        const question = readStringParam(params, "pollQuestion", {
          required: true,
        });
        const options =
          readStringArrayParam(params, "pollOption", { required: true }) ?? [];
        const allowMultiselect =
          typeof params.pollMulti === "boolean" ? params.pollMulti : undefined;
        const durationHours = readNumberParam(params, "pollDurationHours", {
          integer: true,
        });

        if (dryRun) {
          const maxSelections = allowMultiselect
            ? Math.max(2, options.length)
            : 1;
          const result: MessagePollResult = await sendPoll({
            to,
            question,
            options,
            maxSelections,
            durationHours: durationHours ?? undefined,
            provider,
            dryRun,
            gateway,
          });
          return jsonResult(result);
        }

        const handled = await dispatchProviderMessageAction({
          provider,
          action,
          cfg,
          params,
          accountId,
          gateway,
          toolContext,
          dryRun,
        });
        if (handled) return handled;

        const maxSelections = allowMultiselect
          ? Math.max(2, options.length)
          : 1;
        const result: MessagePollResult = await sendPoll({
          to,
          question,
          options,
          maxSelections,
          durationHours: durationHours ?? undefined,
          provider,
          dryRun,
          gateway,
        });
        return jsonResult(result);
      }

      const handled = await dispatchProviderMessageAction({
        provider,
        action,
        cfg,
        params,
        accountId,
        gateway,
        toolContext,
        dryRun,
      });
      if (handled) return handled;
      throw new Error(
        `Action ${action} is not supported for provider ${provider}.`,
      );
    },
  };
}
