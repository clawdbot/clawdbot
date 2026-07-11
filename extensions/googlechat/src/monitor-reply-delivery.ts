// Googlechat plugin module implements monitor reply delivery behavior.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { deleteGoogleChatMessage, sendGoogleChatMessage, updateGoogleChatMessage } from "./api.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

export async function deliverGoogleChatReply(params: {
  payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
  };
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
  const text = reply.text;
  let firstTextChunk = true;

  if (reply.hasMedia) {
    runtime.error?.(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel; sending text fallback only.",
    );
  }

  if (reply.hasMedia && !reply.hasText) {
    try {
      if (typingMessageName) {
        await deleteGoogleChatMessage({ account, messageName: typingMessageName });
      }
    } catch (err) {
      runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
    }
    throw new Error(
      "Google Chat outbound attachments require user OAuth and no text fallback is available.",
    );
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
  const chunks = core.channel.text.chunkMarkdownTextWithMode(text, chunkLimit, chunkMode);
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
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
  }
}
