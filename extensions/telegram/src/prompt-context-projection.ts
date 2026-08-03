import type { Message } from "grammy/types";
import {
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TelegramPromptContextSource = { transcriptMessageId: string };
export type TelegramPromptContextProjection = TelegramPromptContextSource & {
  partIndex: number;
  finalPart: boolean;
};
export type TelegramPromptContextProjectionMarker =
  | { kind: "valid"; projection: TelegramPromptContextProjection }
  | { kind: "invalid"; transcriptMessageId: string };
type TelegramPromptContextRecord = { messageId: number; message?: Message; text?: string };

function parseTranscriptMessageId(value: unknown): string | undefined {
  const id = isRecord(value) ? value.transcriptMessageId : undefined;
  return typeof id === "string" && id.trim() ? id : undefined;
}

export function resolveTelegramPromptContextDeliverySignature(payload: ReplyPayload): string {
  const parts = resolveSendableOutboundReplyParts(payload);
  const spokenText = payload.spokenText ?? "";
  return JSON.stringify([parts.text, parts.mediaUrls, payload.audioAsVoice === true, spokenText]);
}

export function parseTelegramPromptContextProjection(
  value: unknown,
): TelegramPromptContextProjectionMarker | undefined {
  const transcriptMessageId = parseTranscriptMessageId(value);
  if (!transcriptMessageId || !isRecord(value)) {
    return undefined;
  }
  const { partIndex, finalPart } = value;
  return typeof partIndex === "number" &&
    Number.isSafeInteger(partIndex) &&
    partIndex >= 0 &&
    typeof finalPart === "boolean"
    ? { kind: "valid", projection: { transcriptMessageId, partIndex, finalPart } }
    : { kind: "invalid", transcriptMessageId };
}

export function resolveTelegramPromptContextSource(
  payload: ReplyPayload,
): TelegramPromptContextSource | undefined {
  const telegram = payload.channelData?.telegram;
  const taggedSource = isRecord(telegram) ? telegram.promptContextSource : undefined;
  const transcriptMessageId = parseTranscriptMessageId(taggedSource);
  const deliverySignature = isRecord(taggedSource) ? taggedSource.deliverySignature : undefined;
  return transcriptMessageId &&
    deliverySignature === resolveTelegramPromptContextDeliverySignature(payload)
    ? { transcriptMessageId }
    : undefined;
}

export function withTelegramPromptContextSource(
  payload: ReplyPayload,
  source: TelegramPromptContextSource | undefined,
): ReplyPayload {
  if (!source) {
    return payload;
  }
  const telegram = payload.channelData?.telegram;
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      telegram: {
        ...(isRecord(telegram) ? telegram : {}),
        promptContextSource: {
          ...source,
          deliverySignature: resolveTelegramPromptContextDeliverySignature(payload),
        },
      },
    },
  };
}

export function createTelegramPromptContextProjectionCursor(source: TelegramPromptContextSource) {
  return {
    source,
    nextPartIndex: 0,
    complete: true,
    invalidate() {
      this.complete = false;
    },
    take(finalPart: boolean): TelegramPromptContextProjection {
      return {
        ...this.source,
        partIndex: this.nextPartIndex++,
        finalPart: this.complete && finalPart,
      };
    },
  };
}

export function createTelegramPromptContextProjectionSequence(params: {
  source?: TelegramPromptContextSource;
  record: (
    record: TelegramPromptContextRecord & {
      projection?: TelegramPromptContextProjection;
    },
  ) => Promise<boolean>;
}) {
  let cursor = params.source
    ? createTelegramPromptContextProjectionCursor(params.source)
    : undefined;
  let pending: TelegramPromptContextRecord | undefined;
  let started = false;
  const invalidate = () => cursor?.invalidate();
  const flush = async (finalPart: boolean) => {
    if (!pending) {
      return;
    }
    const record = pending;
    pending = undefined;
    const projection = cursor?.take(finalPart);
    const recorded = await params
      .record({ ...record, ...(projection ? { projection } : {}) })
      .catch(() => false);
    if (!recorded) {
      invalidate();
    }
  };
  return {
    get source() {
      return cursor?.source;
    },
    isFresh: () => !started && (cursor?.complete ?? true),
    async accept(record: TelegramPromptContextRecord) {
      started = true;
      await flush(false);
      pending = record;
    },
    finish: () => flush(true),
    invalidate,
    detach() {
      invalidate();
      cursor = undefined;
    },
    async fail() {
      invalidate();
      await flush(false);
    },
  };
}

export type TelegramPromptContextProjectionSequence = ReturnType<
  typeof createTelegramPromptContextProjectionSequence
>;

export function resolveCompleteTelegramPromptContextProjectionIds(
  markers: readonly (TelegramPromptContextProjectionMarker | undefined)[],
): ReadonlySet<string> {
  const grouped = new Map<string, TelegramPromptContextProjection[] | undefined>();
  for (const marker of markers) {
    if (!marker) {
      continue;
    }
    const id =
      marker.kind === "valid" ? marker.projection.transcriptMessageId : marker.transcriptMessageId;
    if (marker.kind === "invalid") {
      grouped.set(id, undefined);
    } else if (grouped.get(id) !== undefined || !grouped.has(id)) {
      grouped.set(id, [...(grouped.get(id) ?? []), marker.projection]);
    }
  }
  const complete = new Set<string>();
  for (const [id, parts] of grouped) {
    const ordered = parts?.toSorted((left, right) => left.partIndex - right.partIndex);
    if (
      ordered?.every(
        (part, index) =>
          part.partIndex === index && part.finalPart === (index === ordered.length - 1),
      )
    ) {
      complete.add(id);
    }
  }
  return complete;
}
