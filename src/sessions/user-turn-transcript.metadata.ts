import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { UserTurnInput } from "./user-turn-transcript.types.js";

const REPLY_PREVIEW_TEXT_MAX_CHARS = 2000;
const REPLY_PREVIEW_SENDER_MAX_CHARS = 200;

function buildUserTurnSenderMeta(
  sender: UserTurnInput["sender"],
): Record<string, string> | undefined {
  const senderId = normalizeOptionalString(sender?.id);
  const senderName = normalizeOptionalString(sender?.name);
  const senderUsername = normalizeOptionalString(sender?.username);
  if (!senderId && !senderName && !senderUsername) {
    return undefined;
  }
  return {
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
  };
}

export function buildPersistedUserTurnMetadata(
  input: UserTurnInput,
  normalizedMedia: readonly unknown[],
): Record<string, unknown> {
  const replyToId = normalizeOptionalString(input.replyToId);
  const replyPreviewText = normalizeOptionalString(input.replyToPreview?.text);
  const replyPreviewSender = normalizeOptionalString(input.replyToPreview?.senderLabel);
  return {
    // Privileged synthetic handoffs may execute owner tools but never author trusted memory.
    ...(input.senderIsOwner === undefined
      ? {}
      : {
          senderIsOwner:
            input.senderIsOwner && (!input.provenance || input.provenance.kind === "external_user"),
        }),
    ...buildUserTurnSenderMeta(input.sender),
    ...(replyToId ? { replyToId } : {}),
    ...(replyPreviewText
      ? {
          replyToPreview: {
            text: truncateUtf16Safe(replyPreviewText, REPLY_PREVIEW_TEXT_MAX_CHARS),
            ...(replyPreviewSender
              ? {
                  senderLabel: truncateUtf16Safe(
                    replyPreviewSender,
                    REPLY_PREVIEW_SENDER_MAX_CHARS,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(normalizedMedia.length > 0 ? { media: normalizedMedia } : {}),
    ...(input.mediaImageLayout
      ? {
          mediaImageLayout: {
            slots: input.mediaImageLayout.slots.map((slot) => ({ ...slot })),
            ...(input.mediaImageLayout.suppressedFactIndexes?.length
              ? {
                  suppressedFactIndexes: [...input.mediaImageLayout.suppressedFactIndexes],
                }
              : {}),
          },
        }
      : {}),
  };
}
