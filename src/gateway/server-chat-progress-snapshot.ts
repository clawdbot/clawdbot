import type { AgentEventPayload } from "../infra/agent-events.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

const CHAT_RUN_PROGRESS_MAX_EVENTS = 50;
const CHAT_RUN_PROGRESS_MAX_BYTES = 128 * 1024;
const CHAT_RUN_PROGRESS_MAX_EVENT_BYTES = 64 * 1024;

export type ChatRunProgressSnapshot = {
  events: AgentEventPayload[];
  byteLength: number;
  lastSeq: number;
};

export function updateChatRunProgressSnapshot(
  snapshot: ChatRunProgressSnapshot | undefined,
  event: AgentEventPayload,
): ChatRunProgressSnapshot | undefined {
  const data = event.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId.trim() : "";
  const preambleItemId =
    typeof data.itemId === "string" && data.itemId.trim()
      ? data.itemId.trim()
      : typeof data.id === "string" && data.id.trim()
        ? data.id.trim()
        : "";
  const isTool =
    event.stream === "tool" &&
    Boolean(toolCallId) &&
    ["start", "input_delta", "update", "result"].includes(phase);
  const isPreamble = event.stream === "item" && data.kind === "preamble";
  if (!isTool && !isPreamble) {
    return snapshot;
  }

  const next = snapshot ?? { events: [], byteLength: 0, lastSeq: 0 };
  // Agent events are run-sequenced. Reject delayed duplicates so reconnect
  // state cannot resurrect a tool that a newer result already completed.
  if (event.seq <= next.lastSeq) {
    return next;
  }
  next.lastSeq = event.seq;
  const matchesPreamble = (candidate: AgentEventPayload) =>
    candidate.stream === "item" &&
    candidate.data?.kind === "preamble" &&
    (candidate.data.itemId ?? "") === preambleItemId;
  const previousPreamble = preambleItemId ? next.events.find(matchesPreamble) : undefined;

  const removeWhere = (predicate: (candidate: AgentEventPayload) => boolean) => {
    next.events = next.events.filter((candidate) => {
      if (!predicate(candidate)) {
        return true;
      }
      next.byteLength -= jsonUtf8Bytes(candidate);
      return false;
    });
  };

  if (isTool) {
    removeWhere((candidate) => {
      if (candidate.stream !== "tool" || candidate.data?.toolCallId !== toolCallId) {
        return false;
      }
      return phase === "start" || phase === "result" || candidate.data?.phase === phase;
    });
    if (phase === "result") {
      return next;
    }
  } else {
    const progressText = typeof data.progressText === "string" ? data.progressText.trim() : "";
    removeWhere(matchesPreamble);
    if (!progressText) {
      return next;
    }
  }

  const storedData: Record<string, unknown> = isTool
    ? {
        phase,
        ...(typeof data.name === "string" ? { name: data.name } : {}),
        toolCallId,
        ...(phase === "start" && Object.hasOwn(data, "args") ? { args: data.args } : {}),
        ...(phase === "update" && Object.hasOwn(data, "partialResult")
          ? { partialResult: data.partialResult }
          : {}),
        ...(phase === "input_delta" && Object.hasOwn(data, "diff") ? { diff: data.diff } : {}),
      }
    : {
        kind: "preamble",
        ...(preambleItemId ? { itemId: preambleItemId } : {}),
        progressText: data.progressText,
      };
  let storedEvent: AgentEventPayload = {
    runId: event.runId,
    seq: event.seq,
    stream: event.stream,
    // Keep first-seen time so reload cannot move updated commentary across a later steer.
    ts: previousPreamble?.ts ?? event.ts,
    data: storedData,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
  };
  let eventBytes = jsonUtf8Bytes(storedEvent);
  if (eventBytes > CHAT_RUN_PROGRESS_MAX_EVENT_BYTES && isTool) {
    delete storedData.args;
    delete storedData.partialResult;
    storedEvent = { ...storedEvent, data: storedData };
    eventBytes = jsonUtf8Bytes(storedEvent);
  }
  if (eventBytes > CHAT_RUN_PROGRESS_MAX_EVENT_BYTES) {
    return next;
  }
  next.events.push(storedEvent);
  next.byteLength += eventBytes;
  while (
    next.events.length > CHAT_RUN_PROGRESS_MAX_EVENTS ||
    next.byteLength > CHAT_RUN_PROGRESS_MAX_BYTES
  ) {
    const removed = next.events.shift();
    if (!removed) {
      break;
    }
    next.byteLength -= jsonUtf8Bytes(removed);
  }
  return next;
}
