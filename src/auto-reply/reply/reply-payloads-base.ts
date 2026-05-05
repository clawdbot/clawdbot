import type { ReplyToMode } from "../../config/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import { extractReplyToTag } from "./reply-tags.js";
import {
  createReplyToModeFilterForChannel,
  resolveImplicitCurrentMessageReplyAllowance,
} from "./reply-threading.js";

export function formatBtwTextForExternalDelivery(payload: ReplyPayload): string | undefined {
  const text = normalizeOptionalString(payload.text);
  if (!text) {
    return payload.text;
  }
  const question = normalizeOptionalString(payload.btw?.question);
  if (!question) {
    return payload.text;
  }
  const formatted = `BTW\nQuestion: ${question}\n\n${text}`;
  return text === formatted || text.startsWith("BTW\nQuestion:") ? text : formatted;
}

function resolveReplyThreadingForPayload(params: {
  payload: ReplyPayload;
  replyToMode?: ReplyToMode;
  implicitReplyToId?: string;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
}): ReplyPayload {
  const implicitReplyToId = normalizeOptionalString(params.implicitReplyToId);
  const currentMessageId = normalizeOptionalString(params.currentMessageId);
  const allowImplicitReplyToCurrentMessage = resolveImplicitCurrentMessageReplyAllowance(
    params.replyToMode,
    params.replyThreading,
  );

  let resolved: ReplyPayload =
    params.payload.replyToId ||
    params.payload.replyToCurrent === false ||
    !implicitReplyToId ||
    !allowImplicitReplyToCurrentMessage
      ? params.payload
      : copyReplyPayloadMetadata(params.payload, {
          ...params.payload,
          replyToId: implicitReplyToId,
        });

  if (typeof resolved.text === "string" && resolved.text.includes("[[")) {
    const { cleaned, replyToId, replyToCurrent, hasTag } = extractReplyToTag(
      resolved.text,
      currentMessageId,
    );
    resolved = copyReplyPayloadMetadata(resolved, {
      ...resolved,
      text: cleaned ? cleaned : undefined,
      replyToId: replyToId ?? resolved.replyToId,
      replyToTag: hasTag || resolved.replyToTag,
      replyToCurrent: replyToCurrent || resolved.replyToCurrent,
    });
  }

  if (resolved.replyToCurrent && !resolved.replyToId && currentMessageId) {
    resolved = copyReplyPayloadMetadata(resolved, {
      ...resolved,
      replyToId: currentMessageId,
    });
  }

  return resolved;
}

export function applyReplyTagsToPayload(
  payload: ReplyPayload,
  currentMessageId?: string,
): ReplyPayload {
  return resolveReplyThreadingForPayload({ payload, currentMessageId });
}

export function isRenderablePayload(payload: ReplyPayload): boolean {
  return hasReplyPayloadContent(payload, { extraContent: payload.audioAsVoice });
}

export function shouldSuppressReasoningPayload(payload: ReplyPayload): boolean {
  return payload.isReasoning === true;
}

export function applyReplyThreading(params: {
  payloads: ReplyPayload[];
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
}): ReplyPayload[] {
  const { payloads, replyToMode, replyToChannel, currentMessageId, replyThreading } = params;
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const implicitReplyToId = normalizeOptionalString(currentMessageId);
  return payloads
    .map((payload) =>
      resolveReplyThreadingForPayload({
        payload,
        replyToMode,
        implicitReplyToId,
        currentMessageId,
        replyThreading,
      }),
    )
    .filter(isRenderablePayload)
    .map(applyReplyToMode);
}
