import {
  createActionGate,
  readStringParam,
} from "../../../agents/tools/common.js";
import { handleTelegramAction } from "../../../agents/tools/telegram-actions.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import { listEnabledTelegramAccounts } from "../../../telegram/accounts.js";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../types.js";

const providerId = "telegram";

function hasTelegramInlineButtons(cfg: ClawdbotConfig): boolean {
  const caps = new Set<string>();
  for (const entry of cfg.channels?.telegram?.capabilities ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed) caps.add(trimmed.toLowerCase());
  }
  const accounts = cfg.channels?.telegram?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const account of Object.values(accounts)) {
      const accountCaps = (account as { capabilities?: unknown })?.capabilities;
      if (!Array.isArray(accountCaps)) continue;
      for (const entry of accountCaps) {
        const trimmed = String(entry).trim();
        if (trimmed) caps.add(trimmed.toLowerCase());
      }
    }
  }
  return caps.has("inlinebuttons");
}

export const telegramMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledTelegramAccounts(cfg).filter(
      (account) => account.tokenSource !== "none",
    );
    if (accounts.length === 0) return [];
    const gate = createActionGate(cfg.channels?.telegram?.actions);
    const actions = new Set<ChannelMessageActionName>(["send"]);
    if (gate("reactions")) actions.add("react");
    return Array.from(actions);
  },
  supportsButtons: ({ cfg }) => hasTelegramInlineButtons(cfg),
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    const accountId =
      typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const replyTo = readStringParam(params, "replyTo");
      const threadId = readStringParam(params, "threadId");
      const buttons = params.buttons;
      return await handleTelegramAction(
        {
          action: "sendMessage",
          to,
          content,
          mediaUrl: mediaUrl ?? undefined,
          replyToMessageId: replyTo ?? undefined,
          messageThreadId: threadId ?? undefined,
          accountId: accountId ?? undefined,
          buttons,
        },
        cfg,
      );
    }

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove =
        typeof params.remove === "boolean" ? params.remove : undefined;
      return await handleTelegramAction(
        {
          action: "react",
          chatId:
            readStringParam(params, "chatId") ??
            readStringParam(params, "to", { required: true }),
          messageId,
          emoji,
          remove,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    throw new Error(
      `Action ${action} is not supported for provider ${providerId}.`,
    );
  },
};
