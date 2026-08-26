import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { applyInputProvenanceToUserMessage, normalizeInputProvenance } from "./input-provenance.js";
import type {
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnMessagePersistenceParams,
} from "./user-turn-transcript.types.js";

const REPLY_PREVIEW_TEXT_MAX_CHARS = 2000;
const REPLY_PREVIEW_SENDER_MAX_CHARS = 200;
const STEER_TARGET_RUN_ID_MAX_CHARS = 512;

export function normalizePersistedSteerTargetRunId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length <= STEER_TARGET_RUN_ID_MAX_CHARS ? normalized : undefined;
}

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

type AgentMessageWithOpenClawMetadata = AgentMessage & {
  __openclaw?: Record<string, unknown>;
};

export function rewritePersistedSteerTargetRunId(
  message: PersistedUserTurnMessage | undefined,
  targetRunId: string | null | undefined,
): PersistedUserTurnMessage | undefined {
  if (!message || targetRunId === undefined) {
    return message;
  }
  const metadata = { ...message["__openclaw"] };
  delete metadata.steerTargetRunId;
  if (targetRunId) {
    metadata.steerTargetRunId = targetRunId;
  }
  const nextMessage = { ...message };
  delete nextMessage["__openclaw"];
  if (Object.keys(metadata).length > 0) {
    nextMessage["__openclaw"] = metadata;
  }
  return nextMessage;
}

/** Restores producer metadata that write hooks must not be able to forge or erase. */
export function restorePreparedUserTurnOperationalMetaForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (!params.preparedMessage || params.runtimeMessage.role !== "user") {
    return params.runtimeMessage;
  }
  const preparedMeta = params.preparedMessage["__openclaw"];
  const senderIsOwner = preparedMeta?.senderIsOwner;
  const steerTargetRunId = normalizePersistedSteerTargetRunId(preparedMeta?.steerTargetRunId);
  const nextMessage: AgentMessageWithOpenClawMetadata = { ...params.runtimeMessage };
  const runtimeMeta = { ...nextMessage["__openclaw"] };
  delete runtimeMeta.steerTargetRunId;
  if (steerTargetRunId) {
    runtimeMeta.steerTargetRunId = steerTargetRunId;
  }
  if (typeof senderIsOwner === "boolean") {
    runtimeMeta.senderIsOwner = senderIsOwner;
  }
  delete nextMessage["__openclaw"];
  if (Object.keys(runtimeMeta).length > 0) {
    nextMessage["__openclaw"] = runtimeMeta;
  }
  return nextMessage;
}

/** Applies before-message hooks while preserving user-turn transcript metadata. */
export function preparePersistedUserTurnMessageForTranscriptWrite(
  message: PersistedUserTurnMessage,
  params: Pick<UserTurnMessagePersistenceParams, "agentId" | "sessionKey" | "beforeMessageWrite">,
): PersistedUserTurnMessage | undefined {
  if (!params.beforeMessageWrite) {
    return message;
  }
  const originalIdempotencyKey = Reflect.get(message, "idempotencyKey");
  const idempotencyKey =
    typeof originalIdempotencyKey === "string" ? originalIdempotencyKey : undefined;
  const provenance = normalizeInputProvenance(Reflect.get(message, "provenance"));
  const originalMeta = message["__openclaw"];
  const senderIsOwner = originalMeta?.senderIsOwner;
  const replyToId = normalizeOptionalString(originalMeta?.replyToId);
  const originalReplyPreview = asOptionalRecord(originalMeta?.replyToPreview);
  const replyPreviewText = normalizeOptionalString(originalReplyPreview?.text);
  const replyPreviewSender = normalizeOptionalString(originalReplyPreview?.senderLabel);
  const replyToPreview = replyPreviewText
    ? {
        text: replyPreviewText,
        ...(replyPreviewSender ? { senderLabel: replyPreviewSender } : {}),
      }
    : undefined;
  const originalTransport = originalMeta?.transport;
  const steerTargetRunId = normalizePersistedSteerTargetRunId(originalMeta?.steerTargetRunId);
  const lateMedia = originalMeta?.lateMedia === true;
  const originalMedia = originalMeta?.media;
  const media = Array.isArray(originalMedia) ? structuredClone(originalMedia) : undefined;
  const originalMediaImageLayout = originalMeta?.mediaImageLayout;
  const mediaImageLayout =
    originalMediaImageLayout === undefined ? undefined : structuredClone(originalMediaImageLayout);
  // Hooks receive the original message object and may mutate nested metadata in
  // place. Snapshot transport correlation before handing them that reference.
  const originalTransportRecord = asOptionalRecord(originalTransport);
  const transport = originalTransportRecord ? { ...originalTransportRecord } : undefined;
  const nextMessage = params.beforeMessageWrite({
    message,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
  if (nextMessage?.role !== "user") {
    return undefined;
  }
  const preparedUserMessage = provenance
    ? applyInputProvenanceToUserMessage(nextMessage, provenance)
    : nextMessage;
  if (preparedUserMessage.role !== "user") {
    return undefined;
  }
  const nextUserMessage: PersistedUserTurnMessage = { ...preparedUserMessage };
  const protectedMeta: Record<string, unknown> = {
    ...nextUserMessage["__openclaw"],
    ...(typeof senderIsOwner === "boolean" ? { senderIsOwner } : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(replyToPreview ? { replyToPreview } : {}),
    ...(transport ? { transport } : {}),
    ...(lateMedia ? { lateMedia: true } : {}),
    ...(media === undefined ? {} : { media }),
    ...(mediaImageLayout === undefined ? {} : { mediaImageLayout }),
  };
  delete protectedMeta.steerTargetRunId;
  if (steerTargetRunId) {
    protectedMeta.steerTargetRunId = steerTargetRunId;
  }
  const protectedMessage: PersistedUserTurnMessage = {
    ...nextUserMessage,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  delete protectedMessage["__openclaw"];
  if (Object.keys(protectedMeta).length > 0) {
    protectedMessage["__openclaw"] = protectedMeta;
  }
  return protectedMessage;
}
