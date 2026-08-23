import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.js";
import {
  readTranscriptDisplayDelta,
  type SessionTranscriptDisplayDeltaResult,
} from "../../config/sessions/session-accessor.sqlite-delta.js";
import {
  projectSessionMessagePayload,
  type SessionMessageProjectionState,
} from "../session-transcript-message.js";

const CHAT_HISTORY_DELTA_MAX_EVENTS = 200;
const CHAT_HISTORY_DELTA_MAX_BYTES = 1_000_000;

type ChatHistoryDeltaRead =
  | { kind: "reset" }
  | {
      activeLeafEntryId: string | null;
      deltaCursor: string;
      kind: "delta";
      messages: Record<string, unknown>[];
    };

function readMessageEvent(event: unknown): { message: unknown; messageId?: string } | undefined {
  const record = asOptionalRecord(event);
  if (!record) {
    return undefined;
  }
  if (record.message === undefined) {
    return undefined;
  }
  return {
    message: record.message,
    ...(typeof record.id === "string" && record.id ? { messageId: record.id } : {}),
  };
}

function containsTranscriptDiscontinuity(
  result: Extract<SessionTranscriptDisplayDeltaResult, { kind: "page" }>,
): boolean {
  return result.events.some((row) => {
    const event = asOptionalRecord(row.event);
    if (!event) {
      return false;
    }
    const type = event.type;
    return type === "reset" || type === "compaction";
  });
}

export function readChatHistoryDelta(params: {
  agentId: string;
  cursor: string;
  scope: SessionTranscriptReadScope;
  sessionKey: string;
  sessionSnapshot: Record<string, unknown>;
}): ChatHistoryDeltaRead {
  const result = readTranscriptDisplayDelta(params.scope, {
    cursor: params.cursor,
    maxBytes: CHAT_HISTORY_DELTA_MAX_BYTES,
    maxEvents: CHAT_HISTORY_DELTA_MAX_EVENTS,
  });
  if (result.kind !== "page" || result.hasMore || containsTranscriptDiscontinuity(result)) {
    return { kind: "reset" };
  }

  let projectionState: SessionMessageProjectionState = {
    streamErrorFallbackPending: false,
    turnBoundaryPending: false,
  };
  const messages: Record<string, unknown>[] = [];
  for (const row of result.events) {
    const event = readMessageEvent(row.event);
    if (!event || row.messageSeq === undefined) {
      continue;
    }
    const projected = projectSessionMessagePayload({
      agentId: params.agentId,
      message: event.message,
      ...(event.messageId ? { messageId: event.messageId } : {}),
      messageSeq: row.messageSeq,
      projectionState,
      sessionKey: params.sessionKey,
      sessionSnapshot: params.sessionSnapshot,
    });
    projectionState = projected.projectionState;
    if (projected.payload) {
      messages.push(projected.payload);
    }
  }
  if (Buffer.byteLength(JSON.stringify(messages), "utf8") > CHAT_HISTORY_DELTA_MAX_BYTES) {
    return { kind: "reset" };
  }
  return {
    activeLeafEntryId: result.activeLeafEntryId,
    deltaCursor: result.cursor,
    kind: "delta",
    messages,
  };
}
