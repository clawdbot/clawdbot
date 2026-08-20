import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import type {
  ActivityRunRenderItem,
  CompletedTurnRenderItem,
  StreamRunRenderItem,
  WorkGroupRenderItem,
} from "./chat-thread-grouping.ts";
import { assistantGroupIsForwardedBoundary, chatItemStartsUserTurn } from "./chat-turn-boundary.ts";

type AgentRunFramePart =
  | MessageGroup
  | WorkGroupRenderItem
  | ActivityRunRenderItem
  | StreamRunRenderItem;

type AgentRunFrameRenderItem = {
  kind: "agent-run-frame";
  key: string;
  runId: string;
  boundaryId: string;
  state: "active" | "terminal";
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
  const runIds = new Set(groups.map((group) => group.runId).filter((value) => value !== undefined));
  return groups.length > 0 && runIds.size === 1 && groups.every((group) => group.runId)
    ? runIds.values().next().value
    : undefined;
}

function itemHasError(item: AgentRunFramePart): boolean {
  return itemGroups(item).some((group) =>
    group.messages.some(({ message }) => asRecord(message)?.stopReason === "error"),
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

function itemBoundaryId(item: AgentRunFramePart): string | undefined {
  return item.kind === "stream-run" ? item.boundaryId : undefined;
}

function groupBoundaryId(group: MessageGroup): string | undefined {
  const firstMessage = group.messages[0]?.message;
  const identity = readSessionMessageIdentity(firstMessage);
  if (group.role === "user" && identity?.runId) {
    return `send:${identity.runId}`;
  }
  if (!chatItemStartsUserTurn(group)) {
    return undefined;
  }
  return identity?.id ? `entry:${identity.id}` : undefined;
}

function isExternalBoundary(group: MessageGroup): boolean {
  return group.role === "user" || assistantGroupIsForwardedBoundary(group);
}

function itemBoundaryGroup(item: AgentRunFramePart): MessageGroup | undefined {
  const first = itemGroups(item)[0];
  return first && chatItemStartsUserTurn(first) ? first : undefined;
}

function frameKey(runId: string, boundaryId: string): string {
  return `agent-run:${JSON.stringify([runId, boundaryId])}`;
}

export function agentRunFrameGroups(frame: AgentRunFrameRenderItem): MessageGroup[] {
  return frame.parts.flatMap(itemGroups);
}

export function agentRunFrameTerminalAssistant(
  frame: AgentRunFrameRenderItem,
): MessageGroup | undefined {
  const last = frame.parts.at(-1);
  return last?.kind === "group" && last.role === "assistant" ? last : undefined;
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
  let runId: string | undefined;
  let parts: AgentRunFramePart[] = [];
  const flush = () => {
    if (!runId || !boundaryId || parts.length === 0) {
      return;
    }
    result.push({
      kind: "agent-run-frame",
      key: frameKey(runId, boundaryId),
      runId,
      boundaryId,
      state: parts.some(itemIsActive) ? "active" : "terminal",
      parts,
    });
    parts = [];
    runId = undefined;
  };
  for (const item of items) {
    const candidate = item as AgentRunFramePart;
    const boundaryGroup = itemBoundaryGroup(candidate);
    if (boundaryGroup) {
      flush();
      const nextBoundaryId = groupBoundaryId(boundaryGroup);
      if (isExternalBoundary(boundaryGroup) || !nextBoundaryId) {
        result.push(item);
        boundaryId = nextBoundaryId;
        continue;
      }
      boundaryId = nextBoundaryId;
    }
    const candidateBoundaryId = itemBoundaryId(candidate);
    if (candidateBoundaryId && candidateBoundaryId !== boundaryId) {
      flush();
      boundaryId = candidateBoundaryId;
    }
    const candidateRunId = itemRunId(candidate);
    if (!boundaryId || !candidateRunId || itemHasError(candidate)) {
      flush();
      result.push(item);
      boundaryId = undefined;
      continue;
    }
    if (runId && runId !== candidateRunId) {
      flush();
    }
    runId = candidateRunId;
    parts.push(candidate);
  }
  flush();
  return result;
}
