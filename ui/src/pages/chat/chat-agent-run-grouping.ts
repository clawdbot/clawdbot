import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAssistantMessagePhase } from "../../../../src/shared/chat-message-content.js";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import type {
  ActivityRunRenderItem,
  CompletedTurnRenderItem,
  StreamRunRenderItem,
  WorkGroupRenderItem,
} from "./chat-thread-grouping.ts";
import { isKeyedAssistantStreamFallbackMessage } from "./chat-thread-run-identity.ts";
import { assistantGroupIsForwardedBoundary, chatItemStartsUserTurn } from "./chat-turn-boundary.ts";
import { readLiveTerminalDisposition } from "./terminal-message-identity.ts";

type AgentRunFramePart =
  | MessageGroup
  | WorkGroupRenderItem
  | ActivityRunRenderItem
  | StreamRunRenderItem;

export type AgentRunFrameRenderItem = {
  kind: "agent-run-frame";
  key: string;
  runId: string;
  boundaryId: string;
  outcome:
    | { kind: "active" }
    | { kind: "completed"; actionOwner: MessageGroup["messages"][number] | null }
    | { kind: "failed" };
  parts: AgentRunFramePart[];
};

type AgentRunFrameInput = CompletedTurnRenderItem | ActivityRunRenderItem;

function itemGroups(item: AgentRunFramePart): MessageGroup[] {
  if (item.kind === "group") {
    return [item];
  }
  if (item.kind === "work-group" || item.kind === "activity-run") {
    return item.groups;
  }
  return [];
}

function itemRunId(item: AgentRunFramePart): string | undefined {
  if (item.kind === "stream-run") {
    return item.runId;
  }
  const groups = itemGroups(item);
  const runId = groups[0]?.runId;
  return runId && groups.every((group) => group.runId === runId) ? runId : undefined;
}

function messageIsInterrupted(message: unknown): boolean {
  const record = asRecord(message);
  const stopReason = typeof record?.stopReason === "string" ? record.stopReason.toLowerCase() : "";
  return (
    readLiveTerminalDisposition(message) !== null ||
    asRecord(record?.openclawAbort)?.aborted === true ||
    ["aborted", "cancelled", "canceled", "timeout", "timed_out"].includes(stopReason)
  );
}

function itemFailsFrame(item: AgentRunFramePart): boolean {
  return itemGroups(item).some((group) =>
    group.messages.some(
      ({ message }) => messageIsInterrupted(message) || asRecord(message)?.stopReason === "error",
    ),
  );
}

function itemIsActive(item: AgentRunFramePart): boolean {
  if (item.kind === "stream-run") {
    return item.parts.some(
      (part) => part.kind === "reading-indicator" || (part.kind === "stream" && part.isStreaming),
    );
  }
  return itemGroups(item).some((group) => group.isStreaming);
}

function groupBoundaryId(group: MessageGroup): string | undefined {
  const firstMessage = group.messages[0]?.message;
  const identity = readSessionMessageIdentity(firstMessage);
  const runId = identity?.runId;
  if (runId) {
    return `send:${runId}`;
  }
  return identity?.id ? `entry:${identity.id}` : undefined;
}

function frameKey(runId: string, boundaryId: string, segmentId: string | undefined): string {
  return `agent-run:${JSON.stringify(segmentId ? [runId, boundaryId, segmentId] : [runId, boundaryId])}`;
}

function frameSegmentId(
  parts: AgentRunFramePart[],
  hardBoundaryId: string | undefined,
): string | undefined {
  return (
    hardBoundaryId ??
    parts
      .flatMap((part) => (part.kind === "stream-run" ? part.parts : []))
      .find((part) => part.kind === "stream" && part.key.includes(":after:"))?.key
  );
}

export function agentRunFrameGroups(frame: AgentRunFrameRenderItem): MessageGroup[] {
  return frame.parts.flatMap(itemGroups);
}

function messageCanOwnCompletedFrame(message: unknown, explicitOnly: boolean): boolean {
  const record = asRecord(message);
  const phase = resolveAssistantMessagePhase(message);
  const stopReason = record?.stopReason;
  const metadata = asRecord(record?.["__openclaw"]);
  if (
    !extractTextCached(message)?.trim() ||
    isKeyedAssistantStreamFallbackMessage(message) ||
    messageIsInterrupted(message) ||
    phase === "commentary" ||
    stopReason === "toolUse" ||
    stopReason === "error" ||
    metadata?.runtimeActivityKind === "context_compaction" ||
    (metadata?.mirrorOrigin === "codex-app-server" && metadata.runTerminal !== true)
  ) {
    return false;
  }
  return !explicitOnly || phase === "final_answer" || stopReason === "stop";
}

function completedFrameActionOwner(
  parts: AgentRunFramePart[],
): MessageGroup["messages"][number] | null {
  const messages = parts
    .flatMap(itemGroups)
    .flatMap((group) => (group.role === "assistant" ? group.messages : []));
  const explicit = messages.findLast(({ message }) => messageCanOwnCompletedFrame(message, true));
  if (explicit) {
    return explicit;
  }
  const lastPart = parts.at(-1);
  if (lastPart?.kind !== "group" || lastPart.role !== "assistant") {
    return null;
  }
  const lastMessage = lastPart.messages.at(-1);
  return lastMessage
    ? messageCanOwnCompletedFrame(lastMessage.message, false)
      ? lastMessage
      : null
    : null;
}

export function agentRunFrameActiveStatusParts(
  frame: AgentRunFrameRenderItem,
): StreamRunRenderItem["parts"] | undefined {
  if (frame.outcome.kind !== "active") {
    return undefined;
  }
  const parts = frame.parts.flatMap((part) => (part.kind === "stream-run" ? part.parts : []));
  return parts.length > 0 &&
    frame.parts.every(
      (part) =>
        part.kind === "stream-run" &&
        part.parts.every((streamPart) => streamPart.kind === "reading-indicator"),
    )
    ? parts
    : undefined;
}

function isAgentRunFramePart(item: AgentRunFrameInput): item is AgentRunFramePart {
  return (
    item.kind === "group" ||
    item.kind === "work-group" ||
    item.kind === "activity-run" ||
    item.kind === "stream-run"
  );
}

/** Wrap semantic work/activity rows in one run-owned presentation frame. */
export function coalesceAgentRunFrames(
  items: AgentRunFrameInput[],
  opts: { searchActive?: boolean } = {},
): Array<AgentRunFrameInput | AgentRunFrameRenderItem> {
  if (opts.searchActive) {
    return items;
  }
  const result: Array<AgentRunFrameInput | AgentRunFrameRenderItem> = [];
  let boundaryId: string | undefined;
  let segmentId: string | undefined;
  let runId: string | undefined;
  let parts: AgentRunFramePart[] = [];
  const flush = (failed = false) => {
    if (!runId || !boundaryId || parts.length === 0) {
      return;
    }
    result.push({
      kind: "agent-run-frame",
      key: frameKey(runId, boundaryId, frameSegmentId(parts, segmentId)),
      runId,
      boundaryId,
      outcome: failed
        ? { kind: "failed" }
        : parts.some(itemIsActive)
          ? { kind: "active" }
          : { kind: "completed", actionOwner: completedFrameActionOwner(parts) },
      parts,
    });
    parts = [];
    runId = undefined;
  };
  for (const item of items) {
    if (!isAgentRunFramePart(item)) {
      flush();
      result.push(item);
      boundaryId = item.kind === "notice" && item.startsTurn ? item.boundaryId : undefined;
      segmentId = boundaryId ? undefined : item.key;
      continue;
    }
    const boundaryGroup = itemGroups(item)[0];
    if (boundaryGroup && chatItemStartsUserTurn(boundaryGroup)) {
      flush();
      segmentId = undefined;
      const nextBoundaryId = groupBoundaryId(boundaryGroup);
      if (
        boundaryGroup.role === "user" ||
        assistantGroupIsForwardedBoundary(boundaryGroup) ||
        !nextBoundaryId
      ) {
        result.push(item);
        boundaryId = nextBoundaryId;
        continue;
      }
      boundaryId = nextBoundaryId;
    }
    const candidateBoundaryId = item.kind === "stream-run" ? item.boundaryId : undefined;
    if (candidateBoundaryId && candidateBoundaryId !== boundaryId) {
      flush();
      boundaryId = candidateBoundaryId;
    }
    const candidateRunId = itemRunId(item);
    if (!boundaryId || !candidateRunId) {
      flush();
      result.push(item);
      boundaryId = undefined;
      segmentId = item.key;
      continue;
    }
    const failed = itemFailsFrame(item);
    if (runId && runId !== candidateRunId) {
      flush();
    }
    runId = candidateRunId;
    parts.push(item);
    if (failed) {
      flush(true);
      boundaryId = undefined;
      segmentId = item.key;
    }
  }
  flush();
  return result;
}
