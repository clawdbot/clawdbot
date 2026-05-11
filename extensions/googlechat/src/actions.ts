import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
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

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listEnabledGoogleChatAccounts(cfg).filter(
    (account) => account.enabled && account.credentialSource !== "none",
  );
}

function isReactionsEnabled(accounts: Array<{ config: { actions?: unknown } }>) {
  for (const account of accounts) {
    const gate = createActionGate(account.config.actions as Record<string, boolean | undefined>);
    if (gate("reactions")) {
      return true;
    }
  }
  return false;
}

function resolveAppUserNames(account: { config: { botUser?: string | null } }) {
  return new Set(["users/app", account.config.botUser?.trim()].filter(Boolean) as string[]);
}

async function loadGoogleChatActionMedia(params: {
  mediaUrl: string;
  maxBytes: number;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}) {
  const runtime = getGoogleChatRuntime();
  return /^https?:\/\//i.test(params.mediaUrl)
    ? await runtime.channel.media.fetchRemoteMedia({
        url: params.mediaUrl,
        maxBytes: params.maxBytes,
      })
    : await loadOutboundMediaFromUrl(params.mediaUrl, {
        maxBytes: params.maxBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      });
}

export const googlechatMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = accountId
      ? [resolveGoogleChatAccount({ cfg, accountId })].filter(
          (account) => account.enabled && account.credentialSource !== "none",
        )
      : listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return null;
    }
    const actions = new Set<ChannelMessageActionName>([]);
    actions.add("send");
    actions.add("upload-file");
    if (isReactionsEnabled(accounts)) {
      actions.add("react");
      actions.add("reactions");
    }
    return { actions: Array.from(actions) };
  },
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
  }) => {
    const account = resolveGoogleChatAccount({
      cfg: cfg,
      accountId,
    });
    if (account.credentialSource === "none") {
      throw new Error("Google Chat credentials are missing.");
    }

    if (action === "send" || action === "upload-file") {
      const to = readStringParam(params, "to", { required: true });
      const content =
        readStringParam(params, "message", {
          required: action === "send",
          allowEmpty: true,
        }) ??
        readStringParam(params, "initialComment", {
          allowEmpty: true,
        }) ??
        "";
      const mediaUrl =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "path", { trim: false });
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });

      if (mediaUrl) {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await loadGoogleChatActionMedia({
          mediaUrl,
          maxBytes,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
        });
        const uploadFileName =
          readStringParam(params, "filename") ??
          readStringParam(params, "title") ??
          loaded.fileName ??
          "attachment";
        const upload = await uploadGoogleChatAttachment({
          account,
          space,
          filename: uploadFileName,
          buffer: loaded.buffer,
          contentType: loaded.contentType,
        });
        await sendGoogleChatMessage({
          account,
          space,
          text: content,
          thread: threadId ?? undefined,
          attachments: upload.attachmentUploadToken
            ? [
                {
                  attachmentUploadToken: upload.attachmentUploadToken,
                  contentName: uploadFileName,
                },
              ]
            : undefined,
        });
        return jsonResult({ ok: true, to: space });
      }

      if (action === "upload-file") {
        throw new Error("upload-file requires media, filePath, or path");
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
          if (appUsers.size > 0 && !appUsers.has(userName ?? "")) {
            return false;
          }
          if (emoji) {
            return reaction.emoji?.unicode === emoji;
          }
          return true;
        });
        for (const reaction of toRemove) {
          if (!reaction.name) {
            continue;
          }
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
