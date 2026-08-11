// Googlechat plugin module implements actions behavior.
import {
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { resolveGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import { describeGoogleChatMessageTool } from "./message-tool-api.js";
import { formatGoogleChatTextWithMediaLinks } from "./outbound-media-links.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const providerId = "googlechat";

const OUTBOUND_REMOTE_MEDIA_KEYS = ["media", "mediaUrl", "fileUrl", "image"] as const;
const OUTBOUND_LOCAL_MEDIA_KEYS = ["path", "filePath"] as const;
const STRUCTURED_ATTACHMENT_REMOTE_MEDIA_KEYS = [...OUTBOUND_REMOTE_MEDIA_KEYS, "url"] as const;

function resolveGoogleChatActionMedia(params: Record<string, unknown>): {
  mediaUrls: string[];
  hasLocalMedia: boolean;
} {
  const mediaUrls = [
    ...OUTBOUND_REMOTE_MEDIA_KEYS.flatMap((key) => {
      const value = readStringParam(params, key);
      return value === undefined ? [] : [value];
    }),
    ...(readStringArrayParam(params, "mediaUrls") ?? []),
  ];
  let hasLocalMedia = OUTBOUND_LOCAL_MEDIA_KEYS.some(
    (key) => readStringParam(params, key) !== undefined,
  );
  if (!Array.isArray(params.attachments)) {
    return { mediaUrls: [...new Set(mediaUrls)], hasLocalMedia };
  }
  for (const attachment of params.attachments) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    hasLocalMedia ||= OUTBOUND_LOCAL_MEDIA_KEYS.some(
      (key) => readStringParam(record, key) !== undefined,
    );
    for (const key of STRUCTURED_ATTACHMENT_REMOTE_MEDIA_KEYS) {
      const value = readStringParam(record, key);
      if (value !== undefined) {
        mediaUrls.push(value);
      }
    }
  }
  return { mediaUrls: [...new Set(mediaUrls)], hasLocalMedia };
}

export const googlechatMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeGoogleChatMessageTool,
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
    let content: string | undefined;
    if (action === "send") {
      const media = resolveGoogleChatActionMedia(params);
      const hasMediaInput = media.mediaUrls.length > 0 || media.hasLocalMedia;
      content = hasMediaInput
        ? formatGoogleChatTextWithMediaLinks({
            text: readStringParam(params, "message", { allowEmpty: true }),
            mediaUrls: media.mediaUrls,
            hasLocalMedia: media.hasLocalMedia,
          })
        : readStringParam(params, "message", { required: true, allowEmpty: true });
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
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });

      const sent = await sendGoogleChatMessage({
        account,
        space,
        text: content ?? "",
        thread: threadId ?? undefined,
      });
      return jsonResult({ ok: true, to: space, ...sent });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
