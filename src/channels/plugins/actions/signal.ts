import { createActionGate, jsonResult, readStringParam } from "../../../agents/tools/common.js";
import { listEnabledSignalAccounts, resolveSignalAccount } from "../../../signal/accounts.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { sendReactionSignal, removeReactionSignal } from "../../../signal/send-reactions.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";

const providerId = "signal";
const GROUP_PREFIX = "group:";

function normalizeSignalReactionRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) return withoutSignal;
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    return withoutSignal.slice("uuid:".length).trim();
  }
  return withoutSignal;
}

function resolveSignalReactionTarget(raw: string): { recipient?: string; groupId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) return {};
  if (withoutSignal.toLowerCase().startsWith(GROUP_PREFIX)) {
    const groupId = withoutSignal.slice(GROUP_PREFIX.length).trim();
    return groupId ? { groupId } : {};
  }
  return { recipient: normalizeSignalReactionRecipient(withoutSignal) };
}

export const signalMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledSignalAccounts(cfg);
    if (accounts.length === 0) return [];
    const configuredAccounts = accounts.filter((account) => account.configured);
    if (configuredAccounts.length === 0) return [];

    const actions = new Set<ChannelMessageActionName>(["send"]);

    const reactionsEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("reactions"),
    );
    if (reactionsEnabled) {
      actions.add("react");
    }

    return Array.from(actions);
  },
  supportsAction: ({ action }) => action !== "send",

  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
      // Check reaction level first
      const reactionLevelInfo = resolveSignalReactionLevel({
        cfg,
        accountId: accountId ?? undefined,
      });
      if (!reactionLevelInfo.agentReactionsEnabled) {
        throw new Error(
          `Signal agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
            `Set channels.signal.reactionLevel to "minimal" or "extensive" to enable.`,
        );
      }

      // Also check the action gate for backward compatibility
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      const isActionEnabled = createActionGate(actionConfig);
      if (!isActionEnabled("reactions")) {
        throw new Error("Signal reactions are disabled via actions.reactions.");
      }

      const recipientRaw =
        readStringParam(params, "recipient") ??
        readStringParam(params, "to", {
          required: true,
          label: "recipient (UUID, phone number, or group)",
        });
      const target = resolveSignalReactionTarget(recipientRaw);
      if (!target.recipient && !target.groupId) {
        throw new Error("recipient or group required");
      }

      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });
      const targetAuthor = readStringParam(params, "targetAuthor");
      const targetAuthorUuid = readStringParam(params, "targetAuthorUuid");
      if (target.groupId && !targetAuthor && !targetAuthorUuid) {
        throw new Error("targetAuthor or targetAuthorUuid required for group reactions.");
      }

      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;

      const timestamp = parseInt(messageId, 10);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid messageId: ${messageId}. Expected numeric timestamp.`);
      }

      if (remove) {
        if (!emoji) throw new Error("Emoji required to remove reaction.");
        await removeReactionSignal(target.recipient ?? "", timestamp, emoji, {
          accountId: accountId ?? undefined,
          groupId: target.groupId,
          targetAuthor,
          targetAuthorUuid,
        });
        return jsonResult({ ok: true, removed: emoji });
      }

      if (!emoji) throw new Error("Emoji required to add reaction.");
      await sendReactionSignal(target.recipient ?? "", timestamp, emoji, {
        accountId: accountId ?? undefined,
        groupId: target.groupId,
        targetAuthor,
        targetAuthorUuid,
      });
      return jsonResult({ ok: true, added: emoji });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
