import { asOptionalRecord, asSafeIntegerInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixRawEvent } from "./sdk.js";

export const MATRIX_PREVIEW_PROTOCOL_KEY = "com.openclaw.preview";

export type MatrixOpenClawPreviewState = "in-progress" | "final" | "abandoned" | "ancillary";
export type MatrixOpenClawPreviewKind = "answer" | "progress";

export type MatrixOpenClawPreviewMarker = {
  v: 1;
  responseId: string;
  triggerEventId: string;
  state: MatrixOpenClawPreviewState;
  revision: number;
  kind: MatrixOpenClawPreviewKind;
  threadId?: string;
  replyToId?: string;
  /** Present only on standalone final events that jointly form one logical answer. */
  partIndex?: number;
  partCount?: number;
};

export type MatrixOpenClawPreviewEnvelope = {
  marker: MatrixOpenClawPreviewMarker;
  sourceEvent: MatrixRawEvent;
  content: Record<string, unknown>;
  originalEventId?: string;
  bundled: boolean;
};

export type MatrixOpenClawPreviewParseResult =
  | { kind: "none" }
  | { kind: "malformed"; reason: string }
  | { kind: "preview"; envelope: MatrixOpenClawPreviewEnvelope };

const MARKER_KEYS = new Set([
  "v",
  "responseId",
  "triggerEventId",
  "state",
  "revision",
  "kind",
  "threadId",
  "replyToId",
  "partIndex",
  "partCount",
]);
const MAX_PROTOCOL_ID_CHARS = 256;
export const MAX_MATRIX_STANDALONE_FINAL_PARTS = 64;

function protocolId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_PROTOCOL_ID_CHARS ? normalized : undefined;
}

function parseMatrixOpenClawPreviewMarker(value: unknown): MatrixOpenClawPreviewMarker | undefined {
  const marker = asOptionalRecord(value);
  if (!marker || Object.keys(marker).some((key) => !MARKER_KEYS.has(key))) {
    return undefined;
  }
  const responseId = protocolId(marker.responseId);
  const triggerEventId = protocolId(marker.triggerEventId);
  const threadId = marker.threadId === undefined ? undefined : protocolId(marker.threadId);
  const replyToId = marker.replyToId === undefined ? undefined : protocolId(marker.replyToId);
  const revision = asSafeIntegerInRange(marker.revision, { min: 0 });
  const partIndex =
    marker.partIndex === undefined ? undefined : asSafeIntegerInRange(marker.partIndex, { min: 0 });
  const partCount =
    marker.partCount === undefined
      ? undefined
      : asSafeIntegerInRange(marker.partCount, {
          min: 1,
          max: MAX_MATRIX_STANDALONE_FINAL_PARTS,
        });
  if (
    marker.v !== 1 ||
    !responseId ||
    !triggerEventId ||
    (marker.state !== "in-progress" &&
      marker.state !== "final" &&
      marker.state !== "abandoned" &&
      marker.state !== "ancillary") ||
    revision === undefined ||
    (marker.kind !== "answer" && marker.kind !== "progress") ||
    (marker.state === "final" && marker.kind !== "answer") ||
    (marker.state === "ancillary" && marker.kind !== "progress") ||
    (marker.threadId !== undefined && !threadId) ||
    (marker.replyToId !== undefined && !replyToId) ||
    (marker.partIndex !== undefined && partIndex === undefined) ||
    (marker.partCount !== undefined && partCount === undefined)
  ) {
    return undefined;
  }
  return {
    v: 1,
    responseId,
    triggerEventId,
    state: marker.state,
    revision,
    kind: marker.kind,
    ...(threadId ? { threadId } : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(partIndex !== undefined ? { partIndex } : {}),
    ...(partCount !== undefined ? { partCount } : {}),
  };
}

export function buildMatrixOpenClawPreviewContent(
  marker: MatrixOpenClawPreviewMarker,
): Record<string, unknown> {
  return { [MATRIX_PREVIEW_PROTOCOL_KEY]: marker };
}

function sameMarker(
  left: MatrixOpenClawPreviewMarker,
  right: MatrixOpenClawPreviewMarker,
): boolean {
  return (
    left.v === right.v &&
    left.responseId === right.responseId &&
    left.triggerEventId === right.triggerEventId &&
    left.state === right.state &&
    left.revision === right.revision &&
    left.kind === right.kind &&
    left.threadId === right.threadId &&
    left.replyToId === right.replyToId &&
    left.partIndex === right.partIndex &&
    left.partCount === right.partCount
  );
}

function parsePreviewContent(params: {
  event: MatrixRawEvent;
  content: Record<string, unknown>;
  bundled: boolean;
}): MatrixOpenClawPreviewParseResult {
  const { content } = params;
  if (params.event.type !== "m.room.message" || params.event.state_key !== undefined) {
    return { kind: "malformed", reason: "preview must be a non-state room message" };
  }
  if (!protocolId(params.event.event_id)) {
    return { kind: "malformed", reason: "missing event id" };
  }
  const relation = asOptionalRecord(content["m.relates_to"]);
  const isEdit = relation?.rel_type === "m.replace";
  const newContent = asOptionalRecord(content["m.new_content"]);
  const hasOuterMarker = Object.hasOwn(content, MATRIX_PREVIEW_PROTOCOL_KEY);
  const hasInnerMarker = Boolean(
    newContent && Object.hasOwn(newContent, MATRIX_PREVIEW_PROTOCOL_KEY),
  );
  if (!hasOuterMarker && !hasInnerMarker) {
    return { kind: "none" };
  }
  const outer = parseMatrixOpenClawPreviewMarker(content[MATRIX_PREVIEW_PROTOCOL_KEY]);
  if (!outer) {
    return { kind: "malformed", reason: "invalid outer marker" };
  }
  if (isEdit) {
    const originalEventId = protocolId(relation.event_id);
    const inner = parseMatrixOpenClawPreviewMarker(newContent?.[MATRIX_PREVIEW_PROTOCOL_KEY]);
    if (!originalEventId || !newContent || !inner || !sameMarker(outer, inner)) {
      return { kind: "malformed", reason: "edit marker copies or target do not agree" };
    }
    if (
      outer.revision < 1 ||
      outer.state === "ancillary" ||
      outer.partIndex !== undefined ||
      outer.partCount !== undefined
    ) {
      return { kind: "malformed", reason: "edit revision must be positive" };
    }
    return {
      kind: "preview",
      envelope: {
        marker: outer,
        sourceEvent: params.event,
        content: newContent,
        originalEventId,
        bundled: params.bundled,
      },
    };
  }
  if (hasInnerMarker) {
    return { kind: "malformed", reason: "non-edit event contains m.new_content marker" };
  }
  const isStandaloneFinal =
    outer.state === "final" &&
    outer.revision === 0 &&
    outer.kind === "answer" &&
    outer.partIndex !== undefined &&
    outer.partCount !== undefined &&
    outer.partIndex < outer.partCount;
  const isInitialPreview =
    outer.state === "in-progress" &&
    outer.revision === 0 &&
    outer.partIndex === undefined &&
    outer.partCount === undefined;
  const isAncillary =
    outer.state === "ancillary" &&
    outer.revision === 0 &&
    outer.kind === "progress" &&
    outer.partIndex === undefined &&
    outer.partCount === undefined;
  if (!isInitialPreview && !isStandaloneFinal && !isAncillary) {
    return {
      kind: "malformed",
      reason: "root must be an initial preview or a bounded standalone final part",
    };
  }
  return {
    kind: "preview",
    envelope: {
      marker: outer,
      sourceEvent: params.event,
      content,
      bundled: params.bundled,
    },
  };
}

function bundledReplacement(event: MatrixRawEvent): MatrixRawEvent | undefined {
  const relations = asOptionalRecord(event.unsigned?.["m.relations"]);
  const replacement = asOptionalRecord(relations?.["m.replace"]);
  const content = asOptionalRecord(replacement?.content);
  const relation = asOptionalRecord(content?.["m.relates_to"]);
  const replacementUnsigned = asOptionalRecord(replacement?.unsigned);
  const replacementRelations = asOptionalRecord(replacementUnsigned?.["m.relations"]);
  if (
    !replacement ||
    !content ||
    event.state_key !== undefined ||
    replacement.sender !== event.sender ||
    replacement.type !== event.type ||
    replacement.state_key !== undefined ||
    replacementUnsigned?.redacted_because ||
    relation?.rel_type !== "m.replace" ||
    relation.event_id !== event.event_id
  ) {
    return undefined;
  }
  return {
    event_id: protocolId(replacement.event_id) ?? "",
    sender: event.sender,
    type: event.type,
    origin_server_ts:
      typeof replacement.origin_server_ts === "number"
        ? replacement.origin_server_ts
        : event.origin_server_ts,
    content,
    ...(replacementUnsigned
      ? {
          unsigned: {
            ...(typeof replacementUnsigned.age === "number"
              ? { age: replacementUnsigned.age }
              : {}),
            ...(replacementRelations ? { "m.relations": replacementRelations } : {}),
            ...(replacementUnsigned.redacted_because !== undefined
              ? { redacted_because: replacementUnsigned.redacted_because }
              : {}),
          },
        }
      : {}),
  };
}

export function parseMatrixOpenClawPreviewEvent(
  event: MatrixRawEvent,
): MatrixOpenClawPreviewParseResult {
  const replacement = bundledReplacement(event);
  if (replacement) {
    const parsed = parsePreviewContent({
      event: replacement,
      content: replacement.content,
      bundled: true,
    });
    if (parsed.kind !== "none") {
      return parsed;
    }
  }
  return parsePreviewContent({ event, content: event.content, bundled: false });
}

export function hasMatrixOpenClawPreviewMarker(event: MatrixRawEvent): boolean {
  if (Object.hasOwn(event.content, MATRIX_PREVIEW_PROTOCOL_KEY)) {
    return true;
  }
  const newContent = asOptionalRecord(event.content["m.new_content"]);
  if (newContent && Object.hasOwn(newContent, MATRIX_PREVIEW_PROTOCOL_KEY)) {
    return true;
  }
  const replacement = bundledReplacement(event);
  return Boolean(
    replacement &&
    (Object.hasOwn(replacement.content, MATRIX_PREVIEW_PROTOCOL_KEY) ||
      Object.hasOwn(
        asOptionalRecord(replacement.content["m.new_content"]) ?? {},
        MATRIX_PREVIEW_PROTOCOL_KEY,
      )),
  );
}

function relationFromMarker(
  marker: MatrixOpenClawPreviewMarker,
): Record<string, unknown> | undefined {
  if (marker.threadId) {
    return {
      rel_type: "m.thread",
      event_id: marker.threadId,
      ...(marker.replyToId ? { "m.in_reply_to": { event_id: marker.replyToId } } : {}),
    };
  }
  return marker.replyToId ? { "m.in_reply_to": { event_id: marker.replyToId } } : undefined;
}

export function buildPromotedMatrixPreviewEvent(params: {
  envelope: MatrixOpenClawPreviewEnvelope;
  originalEventId: string;
  senderId: string;
}): MatrixRawEvent | undefined {
  const { envelope } = params;
  if (envelope.marker.state !== "final") {
    return undefined;
  }
  const body = typeof envelope.content.body === "string" ? envelope.content.body : "";
  if (!body.trim()) {
    return undefined;
  }
  const content: Record<string, unknown> = {
    msgtype:
      envelope.content.msgtype === "m.notice" || envelope.content.msgtype === "m.text"
        ? envelope.content.msgtype
        : "m.text",
    body,
  };
  if (envelope.content.format === "org.matrix.custom.html") {
    content.format = envelope.content.format;
    if (typeof envelope.content.formatted_body === "string") {
      content.formatted_body = envelope.content.formatted_body;
    }
  }
  const mentions = asOptionalRecord(envelope.content["m.mentions"]);
  if (mentions) {
    const userIds = Array.isArray(mentions.user_ids)
      ? mentions.user_ids.filter((value): value is string => typeof value === "string")
      : undefined;
    content["m.mentions"] = {
      ...(userIds ? { user_ids: userIds } : {}),
      ...(mentions.room === true ? { room: true } : {}),
    };
  }
  const relation = relationFromMarker(envelope.marker);
  if (relation) {
    content["m.relates_to"] = relation;
  }
  return {
    event_id: params.originalEventId,
    sender: params.senderId,
    type: "m.room.message",
    origin_server_ts: envelope.sourceEvent.origin_server_ts,
    content,
    __openclawTrustedEnhancedFinal: true,
  };
}
