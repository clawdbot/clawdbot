import {
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "@openclaw/gateway-client/browser";
import type { SessionProjectionScope } from "@openclaw/gateway-client/browser";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { extractText } from "../../lib/chat/message-extract.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import {
  latestPersistedSteerBoundary,
  latestStreamBoundaryRunId,
  persistedSteerTargetRunId,
  rolloverChatStream,
} from "./stream-causal-boundary.ts";
import { maybeResetToolStreamRun } from "./stream-reconciliation.ts";
import {
  prunePersistedAssistantStreamSegments,
  reconcilePersistedAssistantStream,
} from "./stream-segment-pruning.ts";

type SessionMessageApplySource =
  | { kind: "history-delta" }
  | { kind: "live"; activeRunId: string | null };

/**
 * The run this pane is finishing. A terminal chat event clears the local run
 * before its persisted reply row arrives, so match producer-owned rows to the
 * active run or its exact terminal tombstone. Legacy rows without producer
 * ownership may use that tombstone only when their projected reply matches.
 */
function finishingChatRunId(
  state: ChatState,
  source: SessionMessageApplySource,
  message: unknown,
  scope: SessionProjectionScope,
  producerRunId: string | null,
): string | null {
  if (source.kind !== "live") {
    return null;
  }
  if (source.activeRunId) {
    return producerRunId && producerRunId !== source.activeRunId ? null : source.activeRunId;
  }
  const recent = state.lastLocalTerminalReconcile;
  const runId = recent?.sessionKey === state.sessionKey ? recent.runId : null;
  if (!runId) {
    return null;
  }
  if (producerRunId) {
    return producerRunId === runId ? runId : null;
  }
  const projected = getChatSessionProjection(state, scope).runs[runId]?.message;
  const projectedText = extractText(projected)?.trim();
  return projectedText && projectedText === extractText(message)?.trim() ? runId : null;
}

/** Apply one durable session.message payload through the pane-owned transcript reducer. */
export function applySessionMessagePayload(
  state: ChatState,
  payload: unknown,
  runActive: boolean | undefined,
  source: SessionMessageApplySource,
): void {
  const event = asNonArrayRecord(payload);
  if (!event) {
    return;
  }
  const sourceMessage = event.message;
  const incoming = readSessionMessageIdentity(sourceMessage, event);
  if (!incoming) {
    return;
  }
  const scope = readChatSessionProjectionScope(state, { agentId: resolveChatAgentId(state) });
  const isPreviousRunAssistant = Boolean(
    incoming.role === "assistant" &&
    incoming.sequence !== null &&
    incoming.runId &&
    source.kind === "live" &&
    source.activeRunId &&
    incoming.runId !== source.activeRunId,
  );
  // Only the producer's explicit run ID admits an assistant before its run
  // ends; clientRunId describes the session event, not transcript ownership.
  const producerRunId = incoming.runId === event.runId ? incoming.runId : null;
  const assistantOwnerRunId =
    incoming.role === "assistant" &&
    incoming.id &&
    !incoming.isImported &&
    (producerRunId || (!incoming.runId && runActive !== true))
      ? finishingChatRunId(state, source, sourceMessage, scope, producerRunId)
      : null;
  if (
    source.kind === "live" &&
    incoming.role !== "user" &&
    !isPreviousRunAssistant &&
    !assistantOwnerRunId
  ) {
    return;
  }
  // Partial import provenance cannot turn an envelope position into durable
  // transcript identity; only the persisted row can prove its source order.
  if (
    incoming.isImported &&
    !incoming.externalSource &&
    readSessionMessageSequence(sourceMessage) === null
  ) {
    return;
  }
  if (!incoming.id && !incoming.idempotencyKey && incoming.sequence === null) {
    return;
  }
  const sourceRecord = asNonArrayRecord(sourceMessage);
  if (!sourceRecord) {
    return;
  }
  const sourceMetadata = asNonArrayRecord(sourceRecord["__openclaw"]);
  const message = {
    ...sourceRecord,
    __openclaw: {
      ...sourceMetadata,
      ...(incoming.id ? { id: incoming.id } : {}),
      ...(incoming.idempotencyKey ? { idempotencyKey: incoming.idempotencyKey } : {}),
      ...(incoming.sequence !== null ? { seq: incoming.sequence } : {}),
      ...(producerRunId ? { runId: producerRunId } : {}),
    },
  };
  const projection = reduceChatSessionProjection(
    state,
    {
      type: "messagePersisted",
      message,
      envelope: assistantOwnerRunId ? { ...event, runId: assistantOwnerRunId } : event,
    },
    { scope, runActive },
  );
  if (incoming.role === "assistant" && projection.messages.includes(message)) {
    prunePersistedAssistantStreamSegments(state, message);
    if (assistantOwnerRunId && runActive === false) {
      state.chatStream = null;
      state.chatStreamStartedAt = null;
      maybeResetToolStreamRun(state, assistantOwnerRunId);
    }
    reconcilePersistedAssistantStream(state);
  }
  const steerTargetRunId = persistedSteerTargetRunId(message);
  const currentRunId = state.chatRunId;
  const persistedSteerBoundary = steerTargetRunId
    ? latestPersistedSteerBoundary(projection.messages, steerTargetRunId)
    : null;
  if (
    incoming.role === "user" &&
    (runActive === true || (runActive === undefined && currentRunId === steerTargetRunId)) &&
    incoming.runId &&
    steerTargetRunId &&
    (!currentRunId || currentRunId === steerTargetRunId || currentRunId === incoming.runId) &&
    persistedSteerBoundary?.runId === incoming.runId &&
    latestStreamBoundaryRunId(state) !== incoming.runId
  ) {
    state.chatRunId = steerTargetRunId;
    rolloverChatStream(state, {
      runId: steerTargetRunId,
      boundaryRunId: incoming.runId,
    });
  }
}
