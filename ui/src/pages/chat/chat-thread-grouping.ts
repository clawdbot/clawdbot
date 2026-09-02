import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { prepareMessagesForGrouping } from "./chat-thread-duplicates.ts";
import { userTurnRunId } from "./chat-thread-items.ts";
import {
  isKeyedAssistantStreamFallbackMessage,
  transcriptRunId,
} from "./chat-thread-run-identity.ts";
import {
  assistantGroupIsForwardedBoundary,
  chatItemStartsUserTurn,
  hasForwardedSource,
} from "./chat-turn-boundary.ts";
import { indexTurnContinuations, persistedSteerTargetRunId } from "./stream-causal-boundary.ts";

function assistantMessageKind(message: unknown, visibleContent: MessageGroup["visibleContent"]) {
  if (isKeyedAssistantStreamFallbackMessage(message)) {
    return "commentary";
  }
  return visibleContent === "none" ? "activity" : "reply";
}

function stampReplyAttribution(
  items: Array<ChatItem | MessageGroup>,
): Array<ChatItem | MessageGroup> {
  const userSenderKeys = new Set<string>();
  for (const item of items) {
    if (item.kind !== "group" || item.role !== "user" || !item.sender) {
      continue;
    }
    const senderKey = senderIdentityKey(item.sender);
    if (senderKey) {
      userSenderKeys.add(senderKey);
    }
  }
  if (userSenderKeys.size < 2) {
    return items;
  }

  let latestUserSender: MessageGroup["sender"];
  for (const item of items) {
    if (item.kind !== "group") {
      continue;
    }
    if (item.role === "user") {
      // A sender-less user group clears attribution: no chip is safer than
      // mislabeling the reply as addressed to the previous participant.
      latestUserSender = item.sender;
    } else if (item.role === "assistant" && hasForwardedSource(item)) {
      // Forwarded input starts a turn without a local human reply recipient.
      latestUserSender = undefined;
    } else if (item.role === "assistant" && latestUserSender) {
      item.replyToSender = latestUserSender;
    }
  }
  return items;
}
export function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;
  let currentUserTurnIdentity: string | null = null;

  for (const prepared of prepareMessagesForGrouping(items)) {
    if (prepared.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(prepared);
      continue;
    }

    const { item, normalized } = prepared;
    const role = normalizeRoleForGrouping(normalized.role);
    // Classify after content projection and keep the fact with its group; later
    // presentation passes reuse it, while a rebuild sees in-place message changes.
    const visibleContent = resolveMessageVisibleContent(item.message, normalized);
    const senderLabel =
      role === "user" || role === "assistant" ? (normalized.senderLabel ?? null) : null;
    const sender = role === "user" ? normalized.sender : undefined;
    const timestamp = normalized.timestamp || Date.now();
    const runId =
      role === "assistant" || role === "tool" ? transcriptRunId(item.message) : undefined;
    // Independent sends own separate elapsed boundaries; consecutive steers
    // before any output keep their target run's original start. Do not stamp
    // user runIds onto groups: reply-less activity pooling uses that field.
    const steerTarget = role === "user" ? persistedSteerTargetRunId(item.message) : null;
    const userTurnIdentity = role === "user" ? (steerTarget ?? userTurnRunId(item.message)) : null;
    const shouldSplitBySender = role === "user" || role === "assistant";
    const startsProjectedTurn =
      asRecord(asRecord(item.message)?.["__openclaw"])?.turnBoundary === true;
    const splitsAssistantKind =
      role === "assistant" &&
      currentGroup?.role === "assistant" &&
      assistantMessageKind(currentGroup.messages[0]?.message, currentGroup.visibleContent) !==
        assistantMessageKind(item.message, visibleContent);

    if (
      !currentGroup ||
      startsProjectedTurn ||
      currentGroup.role !== role ||
      currentGroup.runId !== runId ||
      currentUserTurnIdentity !== userTurnIdentity ||
      splitsAssistantKind ||
      (shouldSplitBySender &&
        ((!sender?.identity && currentGroup.senderLabel !== senderLabel) ||
          currentGroup.senderSession?.sessionKey !== normalized.senderSession?.sessionKey ||
          senderIdentityKey(currentGroup.sender) !== senderIdentityKey(sender)))
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentUserTurnIdentity = userTurnIdentity;
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        ...(normalized.senderSession ? { senderSession: normalized.senderSession } : {}),
        ...(sender ? { sender } : {}),
        messages: [{ message: item.message, key: item.key, duplicateCount: item.duplicateCount }],
        visibleContent,
        timestamp,
        isStreaming: false,
        ...(runId ? { runId } : {}),
      };
    } else {
      if (visibleContent === "non-text" || currentGroup.visibleContent === "none") {
        currentGroup.visibleContent = visibleContent;
      }
      currentGroup.messages.push({
        message: item.message,
        key: item.key,
        duplicateCount: item.duplicateCount,
      });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return stampReplyAttribution(result);
}

type RenderChatItem = ChatItem | MessageGroup;
export type StreamRunRenderItem = {
  kind: "stream-run";
  key: string;
  runId?: string;
  boundaryId?: string;
  parts: Array<Extract<ChatItem, { kind: "stream" | "reading-indicator" }>>;
};
export function coalesceStreamRuns(
  items: RenderChatItem[],
): Array<RenderChatItem | StreamRunRenderItem> {
  const result: Array<RenderChatItem | StreamRunRenderItem> = [];
  let run: StreamRunRenderItem["parts"] = [];
  const flush = () => {
    const [first] = run;
    if (first) {
      const { runId, boundaryId } = first;
      result.push({
        kind: "stream-run",
        key: `stream-run:${first.key}`,
        parts: run,
        ...(runId ? { runId } : {}),
        ...(boundaryId ? { boundaryId } : {}),
      });
      run = [];
    }
  };
  for (const item of items) {
    if (item.kind === "stream" || item.kind === "reading-indicator") {
      const first = run[0];
      if (first && (first.runId !== item.runId || first.boundaryId !== item.boundaryId)) {
        flush();
      }
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

/** Collapsed rollup of a completed turn's activity (tools, commentary, reasoning). */
export type WorkGroupRenderItem = {
  kind: "work-group";
  key: string;
  groups: MessageGroup[];
  durationMs: number | null;
};

export type ActivityRunRenderItem = {
  kind: "activity-run";
  key: string;
  groups: MessageGroup[];
};

type TurnRenderItem = RenderChatItem | StreamRunRenderItem;

function isCollapsibleWorkGroup(item: TurnRenderItem): item is MessageGroup {
  if (item.kind !== "group" || item.isStreaming || groupHasVisibleReplyContent(item, false)) {
    return false;
  }
  const role = item.role.toLowerCase();
  return role === "tool" || (role === "assistant" && !assistantGroupIsForwardedBoundary(item));
}

function groupHasVisibleReplyContent(group: MessageGroup, includeText = true): boolean {
  return group.visibleContent === "non-text" || (includeText && group.visibleContent === "text");
}

export function assistantGroupCanOwnActiveRunStatus(group: MessageGroup): boolean {
  return (
    group.role.toLowerCase() === "assistant" &&
    !assistantGroupIsForwardedBoundary(group) &&
    groupHasVisibleReplyContent(group)
  );
}

// History carries no final-vs-commentary marker (commentary exists only as
// live stream segments), so the last assistant group with visible content
// stands in for the final reply. Turns whose last content is commentary
// merely collapse less; the visible reply is never folded away.
function isFinalReplyGroup(item: TurnRenderItem): boolean {
  return item.kind === "group" && !item.isStreaming && assistantGroupCanOwnActiveRunStatus(item);
}

function turnUserMessages(turn: TurnRenderItem[]): unknown[] {
  const boundary = turn[0];
  if (!boundary || boundary.kind === "stream-run") {
    return [];
  }
  if (boundary.kind === "group") {
    return boundary.role.toLowerCase() === "user"
      ? boundary.messages.map(({ message }) => message)
      : [];
  }
  return boundary.kind === "message" && chatItemStartsUserTurn(boundary) ? [boundary.message] : [];
}

/**
 * Once a turn is done, its intermediate work (tool groups and assistant
 * commentary before the final reply) collapses behind one "Worked for X"
 * disclosure so the thread reads final-output-first. Live turns stay fully
 * expanded; the collapse itself is the done signal.
 */
export function collapseCompletedTurnWork(
  items: TurnRenderItem[],
  opts: { sessionKey: string; runWorking: boolean; searchActive?: boolean },
): Array<TurnRenderItem | WorkGroupRenderItem> {
  const [scope, agentId, kind, sessionId, ...extraParts] = normalizeLowercaseStringOrEmpty(
    opts.sessionKey,
  ).split(":");
  const isDashboardSession =
    scope === "agent" &&
    Boolean(agentId) &&
    kind === "dashboard" &&
    Boolean(sessionId) &&
    extraParts.length === 0;
  // Channel sessions can also be opened in the Control UI, but their full
  // transcript remains the canonical presentation on message surfaces.
  if (!isDashboardSession || opts.searchActive) {
    return items;
  }
  const turns: TurnRenderItem[][] = [];
  let currentTurn: TurnRenderItem[] = [];
  for (const item of items) {
    if (item.kind !== "stream-run" && chatItemStartsUserTurn(item) && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(item);
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  const { continuationTurnIndexes, precedingContinuationTurnIndexes } = indexTurnContinuations(
    turns,
    turnUserMessages,
  );
  const finalReplyIndexes = turns.map((turn, turnIndex) => {
    if (continuationTurnIndexes.has(turnIndex)) {
      return -1;
    }
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      const candidate = turn[index];
      if (candidate && isFinalReplyGroup(candidate)) {
        return index;
      }
    }
    return -1;
  });
  const terminalReplies = finalReplyIndexes.map((index, turnIndex) =>
    index >= 0 ? (turns[turnIndex]?.[index] as MessageGroup) : undefined,
  );
  for (let turnIndex = turns.length - 2; turnIndex >= 0; turnIndex -= 1) {
    const continuationTurnIndex = continuationTurnIndexes.get(turnIndex);
    if (!terminalReplies[turnIndex] && continuationTurnIndex !== undefined) {
      terminalReplies[turnIndex] = terminalReplies[continuationTurnIndex];
    }
  }
  const liveTurnIndexes = new Set<number>();
  if (opts.runWorking) {
    let liveTurnIndex = turns.length - 1;
    liveTurnIndexes.add(liveTurnIndex);
    for (;;) {
      const precedingTurnIndex = precedingContinuationTurnIndexes.get(liveTurnIndex);
      if (precedingTurnIndex === undefined) {
        break;
      }
      liveTurnIndex = precedingTurnIndex;
      liveTurnIndexes.add(liveTurnIndex);
    }
  }

  const result: Array<TurnRenderItem | WorkGroupRenderItem> = [];
  for (const [turnIndex, turn] of turns.entries()) {
    // In-flight content (stream runs, streaming groups) marks the turn live.
    // While the run works, the trailing turn also stays expanded so activity
    // is watchable until the terminal rebuild collapses it.
    const isLive =
      liveTurnIndexes.has(turnIndex) ||
      turn.some(
        (item) => item.kind === "stream-run" || (item.kind === "group" && item.isStreaming),
      );
    if (isLive) {
      result.push(...turn);
      continue;
    }
    const finalReplyIndex = finalReplyIndexes[turnIndex] ?? -1;
    const terminalReply = terminalReplies[turnIndex];
    // Without a final reply, the tool rows are the turn's only visible result.
    // Keep them exposed instead of replacing the result with an opaque rollup.
    if (!terminalReply) {
      result.push(...turn);
      continue;
    }
    const segmentEnd = finalReplyIndex >= 0 ? finalReplyIndex - 1 : turn.length - 1;
    let segmentStart = segmentEnd + 1;
    for (let index = segmentEnd; index >= 0; index -= 1) {
      const candidate = turn[index];
      if (!candidate || !isCollapsibleWorkGroup(candidate)) {
        break;
      }
      segmentStart = index;
    }
    const groups = turn.slice(segmentStart, segmentEnd + 1) as MessageGroup[];
    const firstGroup = groups[0];
    if (!firstGroup) {
      result.push(...turn);
      continue;
    }
    const boundary = turn[0];
    const boundaryTimestamp =
      boundary &&
      boundary.kind !== "stream-run" &&
      chatItemStartsUserTurn(boundary) &&
      "timestamp" in boundary
        ? boundary.timestamp
        : null;
    const startTimestamp = boundaryTimestamp == null ? firstGroup.timestamp : boundaryTimestamp;
    const endTimestamp = terminalReply.timestamp;
    const durationMs = endTimestamp > startTimestamp ? endTimestamp - startTimestamp : null;
    const continuationBoundary = turns[continuationTurnIndexes.get(turnIndex) ?? -1]?.[0];
    result.push(...turn.slice(0, segmentStart));
    result.push({
      kind: "work-group",
      // The final reply survives older-history prepends; the first work row does not.
      key: `work:${
        finalReplyIndex >= 0 || !continuationBoundary ? terminalReply.key : continuationBoundary.key
      }`,
      groups,
      durationMs,
    });
    result.push(...turn.slice(segmentEnd + 1));
  }
  return result;
}

export type CompletedTurnRenderItem = TurnRenderItem | WorkGroupRenderItem;

// Runs whose transcript shows any reply/stream content keep their activity
// separate per run (one run, one response); only fully reply-less runs — e.g.
// heartbeat wakes that just call their response tool — may pool across runs.
function runIdsWithVisibleReplies(items: CompletedTurnRenderItem[]): Set<string> {
  const replyRunIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "stream-run") {
      if (item.runId) {
        replyRunIds.add(item.runId);
      }
      continue;
    }
    if (item.kind !== "group" || item.runId === undefined) {
      continue;
    }
    // Tool-group text is the tool's own output shown inside the card, never a
    // reply; assistant/user text is the run's visible response.
    const includeText = item.role.toLowerCase() !== "tool";
    if (item.isStreaming || groupHasVisibleReplyContent(item, includeText)) {
      replyRunIds.add(item.runId);
    }
  }
  return replyRunIds;
}

/** Presentation-only rollup for tool groups separated by projected turn boundaries. */
export function coalesceActivityRuns(
  items: CompletedTurnRenderItem[],
  opts: { searchActive?: boolean } = {},
): Array<CompletedTurnRenderItem | ActivityRunRenderItem> {
  if (opts.searchActive) {
    return items;
  }
  const replyRunIds = runIdsWithVisibleReplies(items);
  // A group is its run's entire visible outcome when the run never produced a
  // reply. Consecutive such runs (heartbeats, cron wakes) collapse into one
  // activity rollup instead of stacking identical rows down the transcript.
  const isReplyLessRunActivity = (group: MessageGroup): boolean => {
    const role = group.role.toLowerCase();
    return (
      !group.isStreaming &&
      group.runId !== undefined &&
      !replyRunIds.has(group.runId) &&
      (role === "tool" || (role === "assistant" && !assistantGroupIsForwardedBoundary(group))) &&
      // includeText=false: any assistant text already marked the run as replied
      // above; here only non-tool blocks (media/attachments) block pooling.
      !groupHasVisibleReplyContent(group, false)
    );
  };
  const result: Array<CompletedTurnRenderItem | ActivityRunRenderItem> = [];
  let groups: MessageGroup[] = [];
  const flush = () => {
    const [first] = groups;
    if (!first) {
      return;
    }
    result.push(
      groups.length === 1 ? first : { kind: "activity-run", key: `activity:${first.key}`, groups },
    );
    groups = [];
  };
  for (const item of items) {
    const replyLessRunActivity = item.kind === "group" && isReplyLessRunActivity(item);
    if (item.kind === "group" && (item.role.toLowerCase() === "tool" || replyLessRunActivity)) {
      const tail = groups[groups.length - 1];
      if (
        tail &&
        tail.runId !== item.runId &&
        !(replyLessRunActivity && isReplyLessRunActivity(tail))
      ) {
        flush();
      }
      groups.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}
