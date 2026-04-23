import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import { createActionGate, jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { removeReactionSignal, sendReactionSignal } from "../reaction-runtime-api.js";
import { listEnabledSignalAccounts, resolveSignalAccount } from "./accounts.js";
import { resolveSignalReactionLevel } from "./reaction-level.js";

const providerId = "signal";
const GROUP_PREFIX = "group:";

function normalizeSignalReactionRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return withoutSignal;
  }
  if (normalizeLowercaseStringOrEmpty(withoutSignal).startsWith("uuid:")) {
    return withoutSignal.slice("uuid:".length).trim();
  }
  return withoutSignal;
}

function resolveSignalReactionTarget(raw: string): { recipient?: string; groupId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return {};
  }
  if (normalizeLowercaseStringOrEmpty(withoutSignal).startsWith(GROUP_PREFIX)) {
    const groupId = withoutSignal.slice(GROUP_PREFIX.length).trim();
    return groupId ? { groupId } : {};
  }
  return { recipient: normalizeSignalReactionRecipient(withoutSignal) };
}

async function mutateSignalReaction(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  target: { recipient?: string; groupId?: string };
  timestamp: number;
  emoji: string;
  remove?: boolean;
  targetAuthor?: string;
  targetAuthorUuid?: string;
}) {
  const options = {
    cfg: params.cfg,
    accountId: params.accountId,
    groupId: params.target.groupId,
    targetAuthor: params.targetAuthor,
    targetAuthorUuid: params.targetAuthorUuid,
  };
  if (params.remove) {
    await removeReactionSignal(
      params.target.recipient ?? "",
      params.timestamp,
      params.emoji,
      options,
    );
    return jsonResult({ ok: true, removed: params.emoji });
  }
  await sendReactionSignal(params.target.recipient ?? "", params.timestamp, params.emoji, options);
  return jsonResult({ ok: true, added: params.emoji });
}

export const signalMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const configuredAccounts = accountId
      ? [resolveSignalAccount({ cfg, accountId })].filter(
          (account) => account.enabled && account.configured,
        )
      : listEnabledSignalAccounts(cfg).filter((account) => account.configured);
    if (configuredAccounts.length === 0) {
      return null;
    }

    const actions = new Set<ChannelMessageActionName>(["send"]);
    const reactionsEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("reactions"),
    );
    if (reactionsEnabled) {
      actions.add("react");
    }

    return { actions: Array.from(actions) };
  },
  supportsAction: ({ action }) => action !== "send",

  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
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

      const messageIdRaw = resolveReactionMessageId({ args: params, toolContext });
      const messageId = messageIdRaw != null ? String(messageIdRaw) : undefined;
      if (!messageId) {
        throw new Error(
          "messageId (timestamp) required. Provide messageId explicitly or react to the current inbound message.",
        );
      }
      const targetAuthor = readStringParam(params, "targetAuthor");
      const targetAuthorUuid = readStringParam(params, "targetAuthorUuid");
      if (target.groupId && !targetAuthor && !targetAuthorUuid) {
        throw new Error("targetAuthor or targetAuthorUuid required for group reactions.");
      }

      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;

      const timestamp = Number.parseInt(messageId, 10);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid messageId: ${messageId}. Expected numeric timestamp.`);
      }

      if (remove) {
        if (!emoji) {
          throw new Error("Emoji required to remove reaction.");
        }
        return await mutateSignalReaction({
          cfg,
          accountId: accountId ?? undefined,
          target,
          timestamp,
          emoji,
          remove: true,
          targetAuthor,
          targetAuthorUuid,
        });
      }

      if (!emoji) {
        throw new Error("Emoji required to add reaction.");
      }
      return await mutateSignalReaction({
        cfg,
        accountId: accountId ?? undefined,
        target,
        timestamp,
        emoji,
        remove: false,
        targetAuthor,
        targetAuthorUuid,
      });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
