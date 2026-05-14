import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  deleteGoogleChatMessage,
  sendGoogleChatMessage,
  updateGoogleChatMessage,
  uploadGoogleChatAttachment,
} from "./api.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

export async function deliverGoogleChatReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  typingMessageName?: string;
}): Promise<void> {
  const { payload, account, spaceId, runtime, core, config, statusSink } = params;
  // Clear this whenever the typing message is deleted or unavailable; otherwise
  // text delivery can keep retrying a dead message and drop content.
  let typingMessageName = params.typingMessageName;
  const reply = resolveSendableOutboundReplyParts(payload);
  const mediaCount = reply.mediaCount;
  const hasMedia = reply.hasMedia;
  const text = reply.text;
  let firstTextChunk = true;
  let suppressCaption = false;

  if (hasMedia && typingMessageName) {
    try {
      await deleteGoogleChatMessage({
        account,
        messageName: typingMessageName,
      });
      typingMessageName = undefined;
    } catch (err) {
      runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
      if (typingMessageName) {
        const fallbackText = reply.hasText
          ? text
          : mediaCount > 1
            ? "Sent attachments."
            : "Sent attachment.";
        try {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: fallbackText,
          });
          suppressCaption = Boolean(text.trim());
        } catch (updateErr) {
          runtime.error?.(`Google Chat typing update failed: ${String(updateErr)}`);
          typingMessageName = undefined;
        }
      }
    }
  }

  const chunkLimit = account.config.textChunkLimit ?? 4000;
  const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
  const sendTextMessage = async (chunk: string) => {
    await sendGoogleChatMessage({
      account,
      space: spaceId,
      text: chunk,
      thread: payload.replyToId,
    });
  };
  await deliverTextOrMediaReply({
    payload,
    text: suppressCaption ? "" : reply.text,
    chunkText: (value) => core.channel.text.chunkMarkdownTextWithMode(value, chunkLimit, chunkMode),
    sendText: async (chunk) => {
      try {
        if (firstTextChunk && typingMessageName) {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: chunk,
          });
        } else {
          await sendTextMessage(chunk);
        }
        firstTextChunk = false;
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Google Chat message send failed: ${String(err)}`);
        if (firstTextChunk && typingMessageName) {
          typingMessageName = undefined;
          try {
            await sendTextMessage(chunk);
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (fallbackErr) {
            runtime.error?.(`Google Chat message fallback send failed: ${String(fallbackErr)}`);
          } finally {
            firstTextChunk = false;
          }
        }
      }
    },
    sendMedia: async ({ mediaUrl, caption }) => {
      try {
        const loaded = await core.channel.media.readRemoteMediaBuffer({
          url: mediaUrl,
          maxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
        });
        const upload = await uploadAttachmentForReply({
          account,
          spaceId,
          buffer: loaded.buffer,
          contentType: loaded.contentType,
          filename: loaded.fileName ?? "attachment",
        });
        if (!upload.attachmentUploadToken) {
          throw new Error("missing attachment upload token");
        }
        await sendGoogleChatMessage({
          account,
          space: spaceId,
          text: caption,
          thread: payload.replyToId,
          attachments: [
            { attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.fileName },
          ],
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Google Chat attachment send failed: ${String(err)}`);
      }
    },
  });
}

async function uploadAttachmentForReply(params: {
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  buffer: Buffer;
  contentType?: string;
  filename: string;
}) {
  const { account, spaceId, buffer, contentType, filename } = params;
  return await uploadGoogleChatAttachment({
    account,
    space: spaceId,
    filename,
    buffer,
    contentType,
  });
}
