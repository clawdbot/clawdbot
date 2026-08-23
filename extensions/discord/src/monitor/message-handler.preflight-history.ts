// Discord plugin module implements message handler.preflight history behavior.
import { resolveTimestampMs } from "./format.js";
import {
  createDiscordHistorySenderProvenance,
  type DiscordHistoryEntry,
} from "./message-handler.history.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import { resolveDiscordMessageHistoryText } from "./message-utils.js";
import type { DiscordSenderIdentity } from "./sender-identity.js";

export function buildDiscordPreflightHistoryEntry(params: {
  isGuildMessage: boolean;
  historyLimit: number;
  message: DiscordMessagePreflightContext["message"];
  senderLabel: string;
  sender: Pick<DiscordSenderIdentity, "id" | "name" | "tag">;
  memberRoleIds: readonly string[];
}): DiscordHistoryEntry | undefined {
  const textForHistory = resolveDiscordMessageHistoryText(params.message, {
    includeForwarded: true,
  });
  return params.isGuildMessage && params.historyLimit > 0 && textForHistory
    ? {
        sender: params.senderLabel,
        body: textForHistory,
        timestamp: resolveTimestampMs(params.message.timestamp),
        messageId: params.message.id,
        senderProvenance: createDiscordHistorySenderProvenance({
          sender: params.sender,
          memberRoleIds: params.memberRoleIds,
        }),
      }
    : undefined;
}
