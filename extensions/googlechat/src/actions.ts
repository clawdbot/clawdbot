// Googlechat plugin module implements actions behavior.
import {
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { listEnabledGoogleChatAccounts, resolveGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const providerId = "googlechat";

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listEnabledGoogleChatAccounts(cfg).filter(
    (account) =>
      account.enabled &&
      account.credentialSource !== "none" &&
      account.tokenStatus !== "configured_unavailable",
  );
}

const OUTBOUND_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl"] as const;
const STRUCTURED_ATTACHMENT_MEDIA_KEYS = [...OUTBOUND_MEDIA_KEYS, "url"] as const;

function hasGoogleChatOutboundAttachment(params: Record<string, unknown>): boolean {
  if (OUTBOUND_MEDIA_KEYS.some((key) => readStringParam(params, key) !== undefined)) {
    return true;
  }
  if (readStringArrayParam(params, "mediaUrls") !== undefined) {
    return true;
  }
  if (!Array.isArray(params.attachments)) {
    return false;
  }
  return params.attachments.some((attachment) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      return false;
    }
    const record = attachment as Record<string, unknown>;
    return STRUCTURED_ATTACHMENT_MEDIA_KEYS.some(
      (key) => readStringParam(record, key) !== undefined,
    );
  });
}

export const googlechatMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = accountId
      ? [resolveGoogleChatAccount({ cfg, accountId })].filter(
          (account) =>
            account.enabled &&
            account.credentialSource !== "none" &&
            account.tokenStatus !== "configured_unavailable",
        )
      : listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return null;
    }
    return { actions: ["send"] };
  },
  supportsAction: ({ action }) => action === "send",
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "upload-file") {
      throw new Error(
        "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
      );
    }
    if (action === "send") {
      if (hasGoogleChatOutboundAttachment(params)) {
        throw new Error(
          "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
        );
      }
    }

    const account = resolveGoogleChatAccount({
      cfg,
      accountId,
    });
    if (account.credentialSource === "none" || account.tokenStatus === "configured_unavailable") {
      throw new Error("Google Chat credentials are missing.");
    }

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });

      const sent = await sendGoogleChatMessage({
        account,
        space,
        text: content,
        thread: threadId ?? undefined,
      });
      return jsonResult({ ok: true, to: space, ...sent });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
