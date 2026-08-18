import {
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "@openclaw/gateway-client/browser";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { persistedSteerTargetRunId, rolloverChatStream } from "./stream-causal-boundary.ts";

type SessionMessageApplySource =
  | { kind: "history-delta" }
  | { kind: "live"; activeRunId: string | null };

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
  const isPreviousRunAssistant = Boolean(
    incoming.role === "assistant" &&
    incoming.sequence !== null &&
    incoming.runId &&
    source.kind === "live" &&
    source.activeRunId &&
    incoming.runId !== source.activeRunId,
  );
  if (source.kind === "live" && incoming.role !== "user" && !isPreviousRunAssistant) {
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
  const scope = readChatSessionProjectionScope(state, { agentId: resolveChatAgentId(state) });
  const previousMessageCount = state.chatMessages.length;
  const projection = reduceChatSessionProjection(
    state,
    { type: "messagePersisted", message, envelope: event },
    { scope, runActive },
  );
  if (
    incoming.role === "user" &&
    runActive === true &&
    state.chatRunId &&
    incoming.runId &&
    persistedSteerTargetRunId(message) === state.chatRunId &&
    projection.messages.length > previousMessageCount
  ) {
    rolloverChatStream(state, {
      runId: state.chatRunId,
      boundaryRunId: incoming.runId,
    });
  }
}
