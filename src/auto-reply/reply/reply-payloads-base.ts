// Defines base reply payload helpers shared by delivery and dedupe logic.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyToMode } from "../../config/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { copyReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import { extractReplyToTag } from "./reply-tags.js";
import {
  createReplyToModeFilterForChannel,
  resolveImplicitCurrentMessageReplyAllowance,
} from "./reply-threading.js";

/** Adds the BTW question banner for channels that only accept plain text bodies. */
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
  const payload = normalizeOptionalString(params.payload.replyToId)
    ? setReplyPayloadMetadata(copyReplyPayloadMetadata(params.payload, { ...params.payload }), {
        replyToIdExplicit: true,
      })
    : params.payload;
  const implicitReplyToId = normalizeOptionalString(params.implicitReplyToId);
  const currentMessageId = normalizeOptionalString(params.currentMessageId);
  const allowImplicitReplyToCurrentMessage = resolveImplicitCurrentMessageReplyAllowance(
    params.replyToMode,
    params.replyThreading,
  );

  let resolved: ReplyPayload =
    payload.replyToId ||
    payload.replyToCurrent === false ||
    !implicitReplyToId ||
    !allowImplicitReplyToCurrentMessage
      ? payload
      : copyReplyPayloadMetadata(payload, {
          ...payload,
          replyToId: implicitReplyToId,
        });

  // Inline reply tags override implicit threading without losing payload metadata.
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

/** Applies inline reply tags to a single payload. */
export function applyReplyTagsToPayload(
  payload: ReplyPayload,
  currentMessageId?: string,
): ReplyPayload {
  return resolveReplyThreadingForPayload({ payload, currentMessageId });
}

/** True when a payload has visible or playable content for delivery. */
export function isRenderablePayload(payload: ReplyPayload): boolean {
  return hasReplyPayloadContent(payload, {
    extraContent: payload.audioAsVoice || payload.location != null,
  });
}

/** True when a payload should stay internal as reasoning-only output. */
export function shouldSuppressReasoningPayload(payload: ReplyPayload): boolean {
  return payload.isReasoning === true;
}

type ReplyThreadingParams = {
  payloads: ReplyPayload[];
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
};

/** Resolves reply targets and filters empty payloads before channel delivery. */
export function resolveReplyThreadingPayloads(params: ReplyThreadingParams): ReplyPayload[] {
  const { payloads, replyToMode, currentMessageId, replyThreading } = params;
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
    .filter(isRenderablePayload);
}

/** Applies threading policy and filters empty payloads before channel delivery. */
export function applyReplyThreading(params: ReplyThreadingParams): ReplyPayload[] {
  const applyReplyToMode = createReplyToModeFilterForChannel(
    params.replyToMode,
    params.replyToChannel,
  );
  return resolveReplyThreadingPayloads(params).map(applyReplyToMode);
}
