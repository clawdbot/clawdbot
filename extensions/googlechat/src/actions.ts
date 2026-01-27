import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  MoltbotConfig,
} from "clawdbot/plugin-sdk";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "clawdbot/plugin-sdk";

import { listEnabledGoogleChatAccounts, resolveGoogleChatAccount } from "./accounts.js";
import {
  createGoogleChatReaction,
  deleteGoogleChatReaction,
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment,
} from "./api.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const providerId = "googlechat";

function listEnabledAccounts(cfg: MoltbotConfig) {
  return listEnabledGoogleChatAccounts(cfg).filter(
    (account) => account.enabled && account.credentialSource !== "none",
  );
}

function isReactionsEnabled(accounts: ReturnType<typeof listEnabledAccounts>, cfg: MoltbotConfig) {
  for (const account of accounts) {
    const gate = createActionGate(
      (account.config.actions ?? (cfg.channels?.["googlechat"] as { actions?: unknown })?.actions) as Record<
        string,
        boolean | undefined
      >,
    );
    if (gate("reactions")) return true;
  }
  return false;
}

function resolveAppUserNames(account: { config: { botUser?: string | null } }) {
  return new Set(["users/app", account.config.botUser?.trim()].filter(Boolean) as string[]);
}

export const googlechatMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg as MoltbotConfig);
    if (accounts.length === 0) return [];
    const actions = new Set<ChannelMessageActionName>([]);
    actions.add("send");
    if (isReactionsEnabled(accounts, cfg as MoltbotConfig)) {
      actions.add("react");
      actions.add("reactions");
    }
    return Array.from(actions);
  },
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    const account = resolveGoogleChatAccount({
      cfg: cfg as MoltbotConfig,
      accountId,
    });
    if (account.credentialSource === "none") {
      throw new Error("Google Chat credentials are missing.");
    }

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });

      if (mediaUrl) {
        const core = getGoogleChatRuntime();
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await core.channel.media.fetchRemoteMedia(mediaUrl, { maxBytes });
        const upload = await uploadGoogleChatAttachment({
          account,
          space,
          filename: loaded.filename ?? "attachment",
          buffer: loaded.buffer,
          contentType: loaded.contentType,
        });
        await sendGoogleChatMessage({
          account,
          space,
          text: content,
          thread: threadId ?? undefined,
          attachments: upload.attachmentUploadToken
            ? [{ attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.filename }]
            : undefined,
        });
        return jsonResult({ ok: true, to: space });
      }

      await sendGoogleChatMessage({
        account,
        space,
        text: content,
        thread: threadId ?? undefined,
      });
      return jsonResult({ ok: true, to: space });
    }

    if (action === "react") {
      const messageName = readStringParam(params, "messageId", { required: true });
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Google Chat reaction.",
      });
      if (remove || isEmpty) {
        const reactions = await listGoogleChatReactions({ account, messageName });
        const appUsers = resolveAppUserNames(account);
        const toRemove = reactions.filter((reaction) => {
          const userName = reaction.user?.name?.trim();
          if (appUsers.size > 0 && !appUsers.has(userName ?? "")) return false;
          if (emoji) return reaction.emoji?.unicode === emoji;
          return true;
        });
        for (const reaction of toRemove) {
          if (!reaction.name) continue;
          await deleteGoogleChatReaction({ account, reactionName: reaction.name });
        }
        return jsonResult({ ok: true, removed: toRemove.length });
      }
      const reaction = await createGoogleChatReaction({
        account,
        messageName,
        emoji,
      });
      return jsonResult({ ok: true, reaction });
    }

    if (action === "reactions") {
      const messageName = readStringParam(params, "messageId", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const reactions = await listGoogleChatReactions({
        account,
        messageName,
        limit: limit ?? undefined,
      });
      return jsonResult({ ok: true, reactions });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
