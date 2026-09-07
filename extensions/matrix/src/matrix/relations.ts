import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { RelationType, type MatrixRelation } from "./send/types.js";

type MatrixRelationContent = { "m.relates_to"?: unknown };

function relatedReplyEventId(relation: Record<string, unknown> | undefined): string | undefined {
  const reply = asOptionalRecord(relation?.["m.in_reply_to"]);
  return typeof reply?.event_id === "string" ? reply.event_id : undefined;
}

export function buildMatrixMessageRelation(params: {
  threadId?: string | null;
  replyToId?: string;
  fallbackReplyToId?: string;
}): MatrixRelation | undefined {
  const threadId = params.threadId?.trim();
  const replyToId = params.replyToId?.trim();
  const relatedId = replyToId || (threadId ? params.fallbackReplyToId?.trim() : undefined);
  const reply = relatedId ? { "m.in_reply_to": { event_id: relatedId } } : undefined;
  if (!threadId) {
    return reply;
  }
  return {
    rel_type: RelationType.Thread,
    event_id: threadId,
    ...reply,
    // Only compatibility fallback is hidden by threaded clients; selected replies remain replies.
    ...(relatedId && !replyToId ? { is_falling_back: true } : {}),
  };
}

export function resolveMatrixReplyToEventId(content: MatrixRelationContent): string | undefined {
  const relation = asOptionalRecord(content["m.relates_to"]);
  return relation?.rel_type === RelationType.Thread && relation.is_falling_back === true
    ? undefined
    : relatedReplyEventId(relation);
}

export function resolveMatrixThreadRootId(content: MatrixRelationContent): string | undefined {
  const relation = asOptionalRecord(content["m.relates_to"]);
  if (relation?.rel_type !== RelationType.Thread) {
    return undefined;
  }
  return typeof relation.event_id === "string" ? relation.event_id : relatedReplyEventId(relation);
}
