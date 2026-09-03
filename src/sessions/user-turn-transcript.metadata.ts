import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { normalizeInputProvenance } from "./input-provenance.js";
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

/** Channel source facts qualify an observation, never an authenticated Gateway profile. */
export function buildChannelUserTurnSender(ctx: MsgContext): UserTurnInput["sender"] {
  const id = normalizeOptionalString(ctx.SenderId);
  return {
    id,
    name: normalizeOptionalString(ctx.SenderName),
    username: normalizeOptionalString(ctx.SenderUsername),
    ...(id
      ? {
          identity: {
            type: "observation",
            id,
            pluginId: normalizeOptionalString(ctx.Provider ?? ctx.Surface) ?? null,
            accountId: normalizeOptionalString(ctx.AccountId) ?? null,
            senderKind:
              ctx.SenderIsBot === true ? "bot" : ctx.SenderIsBot === false ? "human" : "unknown",
          },
        }
      : {}),
  };
}

export function buildPersistedUserTurnMetadata(
  input: UserTurnInput,
  normalizedMedia: readonly unknown[],
): Record<string, unknown> {
  const senderId = normalizeOptionalString(input.sender?.id);
  const senderName = normalizeOptionalString(input.sender?.name);
  const senderUsername = normalizeOptionalString(input.sender?.username);
  const senderIdentity =
    input.display !== false && (!input.provenance || input.provenance.kind === "external_user")
      ? readTranscriptSenderIdentity(input.sender?.identity)
      : undefined;
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
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
    ...(senderIdentity && senderIdentity.id === senderId ? { senderIdentity } : {}),
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

/**
 * Runtime hooks may rewrite roles and redact display/transport fields. Restore only
 * operational facts here; canonical admission preparation deliberately protects more.
 */
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
  const nextMessage: AgentMessage & { display?: false; __openclaw?: Record<string, unknown> } = {
    ...params.runtimeMessage,
  };
  const provenance = normalizeInputProvenance(Reflect.get(params.preparedMessage, "provenance"));
  if (provenance) {
    Object.assign(nextMessage, { provenance });
  }
  if (params.preparedMessage.display === false) {
    nextMessage.display = false;
  }
  const runtimeMeta = { ...nextMessage["__openclaw"] };
  delete runtimeMeta.intent;
  if (preparedMeta?.intent) {
    runtimeMeta.intent = preparedMeta.intent;
  }
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

/** Snapshots producer evidence before hooks can replace or mutate the message. */
export function applyTranscriptSenderIdentityToWrite(
  message: AgentMessage,
  write: () => AgentMessage | null | undefined,
): AgentMessage | null | undefined {
  const original = asOptionalRecord(Reflect.get(message, "__openclaw"));
  const identity =
    message.role === "user" ? readTranscriptSenderIdentity(original?.senderIdentity) : undefined;
  const senderId = original?.senderId;
  const next = write();
  const metadata = next && asOptionalRecord(Reflect.get(next, "__openclaw"));
  if (!metadata || !Object.hasOwn(metadata, "senderIdentity")) {
    return next;
  }
  if (
    next.role === "user" &&
    identity &&
    metadata.senderId === senderId &&
    isDeepStrictEqual(readTranscriptSenderIdentity(metadata.senderIdentity), identity)
  ) {
    return next;
  }
  const redacted = { ...metadata };
  delete redacted.senderIdentity;
  return Object.assign({ ...next }, { __openclaw: redacted });
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
  const display = message.display;
  const intent =
    originalMeta?.intent === undefined ? undefined : structuredClone(originalMeta.intent);
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
  const nextMessage = applyTranscriptSenderIdentityToWrite(message, () =>
    params.beforeMessageWrite!({
      message,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    }),
  );
  if (nextMessage?.role !== "user") {
    return undefined;
  }
  const nextUserMessage: PersistedUserTurnMessage = {
    ...nextMessage,
    ...(provenance ? { provenance } : {}),
  };
  const protectedMeta: Record<string, unknown> = {
    ...nextUserMessage["__openclaw"],
    ...(typeof senderIsOwner === "boolean" ? { senderIsOwner } : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(replyToPreview ? { replyToPreview } : {}),
    ...(transport ? { transport } : {}),
    ...(lateMedia ? { lateMedia: true } : {}),
    ...(media === undefined ? {} : { media }),
    ...(mediaImageLayout === undefined ? {} : { mediaImageLayout }),
    ...(intent === undefined ? {} : { intent }),
  };
  if (intent === undefined) {
    delete protectedMeta.intent;
  }
  delete protectedMeta.steerTargetRunId;
  if (steerTargetRunId) {
    protectedMeta.steerTargetRunId = steerTargetRunId;
  }
  const protectedMessage: PersistedUserTurnMessage = {
    ...nextUserMessage,
    ...(display === false ? { display: false } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  delete protectedMessage["__openclaw"];
  if (Object.keys(protectedMeta).length > 0) {
    protectedMessage["__openclaw"] = protectedMeta;
  }
  return protectedMessage;
}
