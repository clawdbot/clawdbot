import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMonitorContext } from "../context.js";

type SlackDmHistoryMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  ts?: string;
};

type SlackDmHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
};

export function resolveSlackDmHistoryLimit(params: {
  account: ResolvedSlackAccount;
  userId?: string;
  defaultLimit: number;
}): number {
  const override =
    params.userId && params.account.config.dms?.[params.userId]?.historyLimit !== undefined
      ? params.account.config.dms[params.userId]?.historyLimit
      : undefined;
  return Math.max(0, override ?? params.defaultLimit);
}

export async function resolveSlackDmHistoryContext(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  currentMessageTs?: string;
  limit: number;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
}): Promise<{ body: string | undefined; inboundHistory: SlackDmHistoryEntry[] | undefined }> {
  const maxMessages = Math.max(0, Math.floor(params.limit));
  if (maxMessages <= 0) {
    return { body: undefined, inboundHistory: undefined };
  }

  try {
    const response = (await params.ctx.app.client.conversations.history({
      token: params.ctx.botToken,
      channel: params.channelId,
      ...(params.currentMessageTs ? { latest: params.currentMessageTs, inclusive: true } : {}),
      limit: maxMessages + 1,
    })) as { messages?: SlackDmHistoryMessage[] };

    const messages = (response.messages ?? [])
      .filter((message) => {
        if (params.currentMessageTs && message.ts === params.currentMessageTs) {
          return false;
        }
        return Boolean(normalizeOptionalString(message.text));
      })
      .slice(0, maxMessages)
      .toReversed();

    if (messages.length === 0) {
      return { body: undefined, inboundHistory: undefined };
    }

    const userNames = new Map<string, string>();
    const resolveUserLabel = async (userId: string): Promise<string> => {
      const cached = userNames.get(userId);
      if (cached) {
        return cached;
      }
      const resolved = normalizeOptionalString((await params.ctx.resolveUserName(userId)).name);
      const label = resolved ?? userId;
      userNames.set(userId, label);
      return label;
    };

    const entries: SlackDmHistoryEntry[] = [];
    const formatted: string[] = [];
    for (const message of messages) {
      const body = normalizeOptionalString(message.text);
      if (!body) {
        continue;
      }
      const isCurrentBot =
        (params.ctx.botUserId && message.user === params.ctx.botUserId) ||
        (params.ctx.botId && message.bot_id === params.ctx.botId);
      const role = isCurrentBot || message.bot_id ? "assistant" : "user";
      const senderBase = isCurrentBot
        ? "Assistant"
        : message.user
          ? await resolveUserLabel(message.user)
          : (normalizeOptionalString(message.username) ?? (message.bot_id ? "Bot" : "Unknown"));
      const sender = `${senderBase} (${role})`;
      const timestamp = message.ts ? Math.round(Number(message.ts) * 1000) : undefined;
      entries.push({ sender, body, timestamp });
      formatted.push(
        formatInboundEnvelope({
          channel: "Slack",
          from: sender,
          timestamp,
          body: `${body}\n[slack message id: ${message.ts ?? "unknown"} channel: ${params.channelId}]`,
          chatType: "direct",
          envelope: params.envelopeOptions,
        }),
      );
    }

    return {
      body: formatted.length > 0 ? formatted.join("\n\n") : undefined,
      inboundHistory: entries.length > 0 ? entries : undefined,
    };
  } catch (err) {
    logVerbose(
      `slack: failed to fetch DM history for channel ${params.channelId}: ${formatErrorMessage(err)}`,
    );
    return { body: undefined, inboundHistory: undefined };
  }
}
