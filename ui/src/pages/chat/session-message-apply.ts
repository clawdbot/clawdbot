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
import { persistedSteerTargetRunId, rolloverChatStream } from "./stream-causal-boundary.ts";

type SessionMessageApplySource =
  | { kind: "history-delta" }
  | { kind: "live"; activeRunId: string | null };

/**
 * The run this pane is finishing. A terminal chat event clears the local run
 * before its persisted reply row arrives, so the armed terminal tombstone is
 * the same pane's proof of ownership for that trailing row. The tombstone
 * outlives its run by design, so it may only claim the row that carries the
 * reply already projected for that run; a delayed older row keeps its own
 * missing ownership instead of displacing a newer run's answer.
 */
function finishingChatRunId(
  state: ChatState,
  source: SessionMessageApplySource,
  message: unknown,
  scope: SessionProjectionScope,
): string | null {
  if (source.kind !== "live") {
    return null;
  }
  if (source.activeRunId) {
    return source.activeRunId;
  }
  const recent = state.lastLocalTerminalReconcile;
  const runId = recent?.sessionKey === state.sessionKey ? recent.runId : null;
  if (!runId) {
    return null;
  }
  const projected = getChatSessionProjection(state, state.chatMessages, scope).runs[runId]?.message;
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
  // The transcript never records which run wrote an assistant row, so the run
  // this pane is finishing is the only proof of ownership for the reply that
  // ends it. Admitting it here lets the reducer recognize the same run's
  // terminal projection instead of rendering the reply twice.
  const assistantOwnerRunId =
    incoming.role === "assistant" &&
    incoming.id &&
    !incoming.isImported &&
    !incoming.runId &&
    runActive !== true
      ? finishingChatRunId(state, source, sourceMessage, scope)
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
    },
  };
  const previousMessageCount = state.chatMessages.length;
  const projection = reduceChatSessionProjection(
    state,
    {
      type: "messagePersisted",
      message,
      envelope: assistantOwnerRunId ? { ...event, runId: assistantOwnerRunId } : event,
    },
    { scope, runActive },
  );
  const steerTargetRunId = persistedSteerTargetRunId(message);
  const currentRunId = state.chatRunId;
  if (
    incoming.role === "user" &&
    runActive === true &&
    incoming.runId &&
    steerTargetRunId &&
    (!currentRunId || currentRunId === steerTargetRunId || currentRunId === incoming.runId) &&
    projection.messages.length > previousMessageCount
  ) {
    state.chatRunId = steerTargetRunId;
    rolloverChatStream(state, {
      runId: steerTargetRunId,
      boundaryRunId: incoming.runId,
    });
  }
}
