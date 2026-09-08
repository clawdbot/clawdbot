import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.js";
import {
  readTranscriptDisplayDelta,
  type SessionTranscriptDisplayDeltaResult,
} from "../../config/sessions/session-accessor.sqlite-history-events.js";
import { jsonUtf8BytesOrInfinity } from "../../infra/json-utf8-bytes.js";
import {
  createCurrentUserProfileMessageProjector,
  projectChatDisplayMessagesWithState,
} from "../chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
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
  maxBytes?: number;
  scope: SessionTranscriptReadScope;
  sessionKey: string;
  sessionSnapshot: Record<string, unknown>;
}): ChatHistoryDeltaRead {
  const maxBytes = Math.min(params.maxBytes ?? Infinity, CHAT_HISTORY_DELTA_MAX_BYTES);
  const result = readTranscriptDisplayDelta(params.scope, {
    cursor: params.cursor,
    maxBytes,
    maxEvents: CHAT_HISTORY_DELTA_MAX_EVENTS,
  });
  if (result.kind !== "page" || result.hasMore || containsTranscriptDiscontinuity(result)) {
    return { kind: "reset" };
  }

  let projectionState: SessionMessageProjectionState = {
    assistantErrorPending: false,
    turnBoundaryPending: false,
  };
  const projectCurrentUserProfile = createCurrentUserProfileMessageProjector(
    resolveCurrentUserProfileDisplay,
  );
  const messages: Record<string, unknown>[] = [];
  // Include array brackets and separators without serializing the whole page.
  let messagesBytes = 2;
  for (const row of result.events) {
    const event = readMessageEvent(row.event);
    if (!event || row.messageSeq === undefined) {
      continue;
    }
    const historyProjection = projectChatDisplayMessagesWithState([event.message], {
      ...projectionState,
      includeCommentaryFallbacks: true,
    });
    if (
      historyProjection.messages.some(
        (message) => asOptionalRecord(message.openclawStreamFallback)?.source === "segment",
      )
    ) {
      // One transcript entry can own both commentary and a tool call. The single-message
      // envelope cannot carry that split; let the full history owner reconcile both rows.
      return { kind: "reset" };
    }
    const projected = projectSessionMessagePayload({
      agentId: params.agentId,
      message: event.message,
      ...(event.messageId ? { messageId: event.messageId } : {}),
      messageSeq: row.messageSeq,
      transcriptPosition: row.displayPosition,
      projectionState,
      projectCurrentUserProfile,
      sessionKey: params.sessionKey,
      sessionSnapshot: params.sessionSnapshot,
    });
    projectionState = projected.projectionState;
    // Recovery can remove this row from history, which an append-only delta cannot express.
    // Keep the last accepted cursor before the error and let a full tail own reconciliation.
    if (projectionState.assistantErrorPending) {
      return { kind: "reset" };
    }
    if (projected.payload) {
      messagesBytes += jsonUtf8BytesOrInfinity(projected.payload) + (messages.length > 0 ? 1 : 0);
      if (messagesBytes > maxBytes) {
        return { kind: "reset" };
      }
      messages.push(projected.payload);
    }
  }
  return {
    activeLeafEntryId: result.activeLeafEntryId,
    deltaCursor: result.cursor,
    kind: "delta",
    messages: composeTranscriptDisplay(messages, (envelope) => envelope.message),
  };
}
