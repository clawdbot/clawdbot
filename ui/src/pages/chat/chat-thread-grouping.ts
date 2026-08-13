import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import type { ChatItem, MessageGroup, ToolCard } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { resolveMessageToolUseId, resolveToolBlockId } from "./chat-thread-items.ts";
import {
  assistantGroupIsForwardedBoundary,
  chatItemStartsUserTurn,
  safeNormalizeMessage,
} from "./chat-turn-boundary.ts";

export function isKeyedAssistantStreamFallbackMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (normalizeLowercaseStringOrEmpty(record?.role) !== "assistant") {
    return false;
  }
  const fallback = asRecord(record?.openclawStreamFallback);
  return typeof fallback?.itemId === "string" && fallback.itemId.trim().length > 0;
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
    } else if (item.role === "assistant" && latestUserSender) {
      item.replyToSender = latestUserSender;
    }
  }
  return items;
}
export function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel =
      role === "user" || role === "assistant" ? (normalized.senderLabel ?? null) : null;
    const sender = role === "user" ? normalized.sender : undefined;
    const timestamp = normalized.timestamp || Date.now();
    const shouldSplitBySender = role === "user" || role === "assistant";
    const startsProjectedTurn =
      asRecord(asRecord(item.message)?.["__openclaw"])?.turnBoundary === true;
    const splitsAssistantCommentary =
      role === "assistant" &&
      currentGroup?.role === "assistant" &&
      isKeyedAssistantStreamFallbackMessage(currentGroup.messages[0]?.message) !==
        isKeyedAssistantStreamFallbackMessage(item.message);

    if (
      !currentGroup ||
      startsProjectedTurn ||
      currentGroup.role !== role ||
      splitsAssistantCommentary ||
      (shouldSplitBySender &&
        (currentGroup.senderLabel !== senderLabel ||
          senderIdentityKey(currentGroup.sender) !== senderIdentityKey(sender)))
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        ...(sender ? { sender } : {}),
        messages: [{ message: item.message, key: item.key, duplicateCount: item.duplicateCount }],
        timestamp,
        isStreaming: false,
      };
    } else {
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

function mergeToolCallResultPair(callItem: ChatItem, resultItem: ChatItem): ChatItem | null {
  if (callItem.kind !== "message" || resultItem.kind !== "message") {
    return null;
  }
  const callMessage = asRecord(callItem.message);
  const resultMessage = asRecord(resultItem.message);
  if (!callMessage || !resultMessage) {
    return null;
  }
  const callRole = typeof callMessage.role === "string" ? callMessage.role.toLowerCase() : "";
  const normalizedResult = safeNormalizeMessage(resultItem.message);
  const resultRole = normalizedResult ? normalizeRoleForGrouping(normalizedResult.role) : "unknown";
  if (callRole !== "assistant" || resultRole !== "tool" || !Array.isArray(callMessage.content)) {
    return null;
  }
  const hasToolCallBlock = callMessage.content.some((block) =>
    isToolCallContentType(asRecord(block)?.type),
  );
  if (!hasToolCallBlock) {
    return null;
  }

  const callCards = extractToolCardsCached(callItem.message, `${callItem.key}:activity-call`);
  const resultCards = extractToolCardsCached(
    resultItem.message,
    `${resultItem.key}:activity-result`,
  );
  if (callCards.length === 0 || resultCards.length === 0) {
    return null;
  }
  const rawResultContent = Array.isArray(resultMessage.content) ? resultMessage.content : [];
  if (rawResultContent.some((block) => isToolCallContentType(asRecord(block)?.type))) {
    return null;
  }
  const resultOnlyContent = rawResultContent.filter(
    (block) => !isToolCallContentType(asRecord(block)?.type),
  );
  const hasToolResultBlock = resultOnlyContent.some((block) =>
    isToolResultContentType(asRecord(block)?.type),
  );
  const hasToolResult =
    hasToolResultBlock ||
    resultCards.some((card) => card.outputText !== undefined || card.isError !== undefined);
  if (!hasToolResult) {
    return null;
  }

  const unresolvedCallIds = unresolvedToolCallIds(callItem);
  const matchedResults = new Map<string, { resultCard: ToolCard; resultName: string }>();
  for (const resultCard of resultCards) {
    const callId = resultCard.callId;
    if (!callId || !unresolvedCallIds.has(callId) || matchedResults.has(callId)) {
      return null;
    }
    const callCard = callCards.find((card) => card.callId === callId);
    if (!callCard) {
      return null;
    }
    const resultName = resultCard.name === "tool" ? callCard.name : resultCard.name;
    if (
      normalizeLowercaseStringOrEmpty(callCard.name) !== normalizeLowercaseStringOrEmpty(resultName)
    ) {
      return null;
    }
    matchedResults.set(callId, { resultCard, resultName });
  }

  const preservedResultContent = resultOnlyContent.filter(
    (block) => asRecord(block)?.type !== "text",
  );
  // Raw transcript result blocks usually carry the call id and tool name on the
  // message, not the block. Stamp both onto the merged blocks (plus message-level
  // details) so card extraction pairs them with the call instead of rendering a
  // second bare "Tool" card.
  const resultContent = hasToolResultBlock
    ? resultOnlyContent.map((block) => {
        const record = asRecord(block);
        if (!record || !isToolResultContentType(record.type)) {
          return block;
        }
        const callId = resolveToolBlockId(record, resultMessage);
        const matched = callId ? matchedResults.get(callId) : undefined;
        if (!matched) {
          return block;
        }
        const stamped: Record<string, unknown> = Object.assign({}, record);
        stamped.id = callId;
        stamped.name =
          typeof record.name === "string" && record.name.trim() ? record.name : matched.resultName;
        if (record.details === undefined && resultMessage.details !== undefined) {
          stamped.details = resultMessage.details;
        }
        if (
          record.isError === undefined &&
          record.is_error === undefined &&
          matched.resultCard.isError !== undefined
        ) {
          stamped.isError = matched.resultCard.isError;
        }
        return stamped;
      })
    : (() => {
        const [matched] = matchedResults.values();
        if (!matched) {
          return preservedResultContent;
        }
        return [
          {
            type: "tool_result",
            id: matched.resultCard.callId,
            name: matched.resultName,
            text: matched.resultCard.outputText ?? "",
            ...(matched.resultCard.details !== undefined
              ? { details: matched.resultCard.details }
              : {}),
            ...(matched.resultCard.isError !== undefined
              ? { isError: matched.resultCard.isError }
              : {}),
          },
          ...preservedResultContent,
        ];
      })();
  return {
    ...callItem,
    message: {
      ...callMessage,
      content: [...callMessage.content, ...resultContent],
    },
  };
}

function unresolvedToolCallIds(item: ChatItem): Set<string> {
  const unresolved = new Set<string>();
  if (item.kind !== "message") {
    return unresolved;
  }
  const message = asRecord(item.message);
  if (
    !message ||
    typeof message.role !== "string" ||
    message.role.toLowerCase() !== "assistant" ||
    !Array.isArray(message.content)
  ) {
    return unresolved;
  }
  for (const block of message.content) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    const callId = resolveToolBlockId(record, message);
    if (!callId) {
      continue;
    }
    if (isToolCallContentType(record.type)) {
      unresolved.add(callId);
    } else if (isToolResultContentType(record.type)) {
      unresolved.delete(callId);
    }
  }
  return unresolved;
}

function isToolTimelineItem(item: ChatItem): boolean {
  if (item.kind !== "message") {
    return false;
  }
  const normalized = safeNormalizeMessage(item.message);
  return normalized ? normalizeRoleForGrouping(normalized.role) === "tool" : false;
}

function splitBundledToolResultItems(item: ChatItem): ChatItem[] {
  if (item.kind !== "message") {
    return [item];
  }
  const message = asRecord(item.message);
  if (!message || !Array.isArray(message.content) || message.content.length < 2) {
    return [item];
  }
  const blocksByCallId = new Map<string, unknown[]>();
  for (const block of message.content) {
    const record = asRecord(block);
    if (!record || !isToolResultContentType(record.type)) {
      return [item];
    }
    const callId = resolveToolBlockId(record, message);
    if (!callId) {
      return [item];
    }
    const blocks = blocksByCallId.get(callId) ?? [];
    blocks.push(block);
    blocksByCallId.set(callId, blocks);
  }
  if (blocksByCallId.size < 2) {
    return [item];
  }
  return Array.from(blocksByCallId.values(), (content, index) => ({
    ...item,
    key: `${item.key}:result:${index}`,
    message: { ...message, content },
  }));
}

function resolveToolResultCallId(item: ChatItem): string | undefined {
  if (item.kind !== "message") {
    return undefined;
  }
  const message = asRecord(item.message);
  if (!message) {
    return undefined;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  if (content.some((block) => isToolCallContentType(asRecord(block)?.type))) {
    return undefined;
  }
  const resultIds = new Set<string>();
  for (const block of content) {
    const record = asRecord(block);
    if (record && isToolResultContentType(record.type)) {
      const callId = resolveToolBlockId(record, message);
      if (callId) {
        resultIds.add(callId);
      }
    }
  }
  const resultId = resultIds.values().next().value;
  return resultIds.size > 1 ? undefined : (resultId ?? resolveMessageToolUseId(message));
}

function refreshOpenCallIds(
  openCallIndexes: Map<string, number>,
  coalesced: ChatItem[],
  callIndex: number,
) {
  for (const [callId, index] of openCallIndexes) {
    if (index === callIndex) {
      openCallIndexes.delete(callId);
    }
  }
  for (const callId of unresolvedToolCallIds(coalesced[callIndex]!)) {
    openCallIndexes.set(callId, callIndex);
  }
}

export function coalesceToolActivityMessages(items: ChatItem[]): ChatItem[] {
  const coalesced: ChatItem[] = [];
  // Defer backward-pair removal so all call-id indexes stay stable.
  const suppressedIndexes = new Set<number>();
  // Parallel calls can outnumber any fixed lookback window, so each unresolved
  // call id owns its current transcript item until a non-tool boundary.
  const openCallIndexes = new Map<string, number>();
  // Keep earlier result slots by call id so later calls can restore complete cards.
  const openResultIndexes = new Map<string, number>();
  for (const item of items) {
    const resultItems = splitBundledToolResultItems(item);
    const unmatchedResultItems: ChatItem[] = [];
    for (const resultItem of resultItems) {
      const callId = resolveToolResultCallId(resultItem);
      const callIndex = callId ? openCallIndexes.get(callId) : undefined;
      const callItem = callIndex === undefined ? undefined : coalesced[callIndex];
      const merged =
        callIndex === undefined || !callItem ? null : mergeToolCallResultPair(callItem, resultItem);
      if (!merged || callIndex === undefined) {
        unmatchedResultItems.push(resultItem);
        continue;
      }
      coalesced[callIndex] = merged;
      refreshOpenCallIds(openCallIndexes, coalesced, callIndex);
    }
    const hasMergedResult = unmatchedResultItems.length < resultItems.length;
    if (hasMergedResult || resultItems.length > 1) {
      const orphanResults = hasMergedResult ? unmatchedResultItems : resultItems;
      for (const orphanResult of orphanResults) {
        const callId = resolveToolResultCallId(orphanResult);
        if (callId) {
          openResultIndexes.set(callId, openResultIndexes.get(callId) ?? coalesced.length);
        }
        coalesced.push(orphanResult);
      }
      continue;
    }

    const unresolvedCallIds = unresolvedToolCallIds(item);
    let backwardMerged = item;
    const matchedResultIndexes: number[] = [];
    for (const callId of unresolvedCallIds) {
      const resultIndex = openResultIndexes.get(callId);
      const orphanResult = resultIndex === undefined ? undefined : coalesced[resultIndex];
      const merged = orphanResult ? mergeToolCallResultPair(backwardMerged, orphanResult) : null;
      if (merged && resultIndex !== undefined) {
        backwardMerged = merged;
        matchedResultIndexes.push(resultIndex);
        openResultIndexes.delete(callId);
      }
    }
    if (matchedResultIndexes.length > 0) {
      const resultIndex = Math.min(...matchedResultIndexes);
      coalesced[resultIndex] = backwardMerged;
      matchedResultIndexes.forEach((index) => suppressedIndexes.add(index));
      suppressedIndexes.delete(resultIndex);
      refreshOpenCallIds(openCallIndexes, coalesced, resultIndex);
      continue;
    }
    if (unresolvedCallIds.size === 1) {
      const callId = unresolvedCallIds.values().next().value;
      const previousIndex = callId ? openCallIndexes.get(callId) : undefined;
      const previous = previousIndex === undefined ? undefined : coalesced[previousIndex];
      if (previousIndex !== undefined && previous && unresolvedToolCallIds(previous).size === 1) {
        coalesced[previousIndex] = item;
        refreshOpenCallIds(openCallIndexes, coalesced, previousIndex);
        continue;
      }
    }

    coalesced.push(item);
    if (unresolvedCallIds.size > 0) {
      const callIndex = coalesced.length - 1;
      for (const callId of unresolvedCallIds) {
        openCallIndexes.set(callId, callIndex);
      }
      continue;
    }
    if (isToolTimelineItem(item)) {
      // Orphan results keep the window open for later siblings.
      const callId = resolveToolResultCallId(item);
      if (callId) {
        openResultIndexes.set(callId, openResultIndexes.get(callId) ?? coalesced.length - 1);
      }
      continue;
    }
    // Any other content (user text, assistant reply, dividers) closes the run.
    openCallIndexes.clear();
    openResultIndexes.clear();
  }
  return coalesced.filter((_, index) => !suppressedIndexes.has(index));
}

type RenderChatItem = ChatItem | MessageGroup;
type StreamRunRenderItem = {
  kind: "stream-run";
  key: string;
  parts: Array<
    Extract<
      ChatItem,
      { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" } | { kind: "plan" }
    >
  >;
};

export function coalesceStreamRuns(
  items: RenderChatItem[],
): Array<RenderChatItem | StreamRunRenderItem> {
  const result: Array<RenderChatItem | StreamRunRenderItem> = [];
  let run: StreamRunRenderItem["parts"] = [];
  // Contiguous in-flight stream, plan, and reading-indicator items render under one
  // assistant avatar; messages, groups, and dividers intentionally break the run.
  const flush = () => {
    const [first] = run;
    if (first) {
      result.push({ kind: "stream-run", key: `stream-run:${first.key}`, parts: run });
      run = [];
    }
  };
  for (const item of items) {
    if (item.kind === "stream" || item.kind === "reading-indicator" || item.kind === "plan") {
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}
/** Collapsed rollup of a completed turn's intermediate work (tools, commentary). */
type WorkGroupRenderItem = {
  kind: "work-group";
  key: string;
  groups: MessageGroup[];
  durationMs: number | null;
};

type ActivityRunRenderItem = {
  kind: "activity-run";
  key: string;
  groups: MessageGroup[];
};

type TurnRenderItem = RenderChatItem | StreamRunRenderItem;

function isCollapsibleWorkGroup(item: TurnRenderItem): item is MessageGroup {
  if (item.kind !== "group" || item.isStreaming) {
    return false;
  }
  const role = item.role.toLowerCase();
  return role === "tool" || (role === "assistant" && !assistantGroupIsForwardedBoundary(item));
}

// Attachment/canvas/media-only replies carry no text but are still the turn's
// visible outcome; they must never fold into the work rollup. Normalized
// content passes unknown block types through (e.g. raw image blocks), so
// anything that is not a tool block counts as visible reply content.
function assistantGroupHasVisibleReplyContent(group: MessageGroup): boolean {
  return group.messages.some(({ message }) => {
    if (extractTextCached(message)?.trim()) {
      return true;
    }
    const content = safeNormalizeMessage(message)?.content ?? [];
    return content.some((block) => {
      if (block.type === "text") {
        return Boolean(block.text?.trim());
      }
      return !isToolCallContentType(block.type) && !isToolResultContentType(block.type);
    });
  });
}

export function assistantGroupCanOwnActiveRunStatus(group: MessageGroup): boolean {
  return (
    group.role.toLowerCase() === "assistant" &&
    !assistantGroupIsForwardedBoundary(group) &&
    assistantGroupHasVisibleReplyContent(group)
  );
}

// History carries no final-vs-commentary marker (commentary exists only as
// live stream segments), so the last assistant group with visible content
// stands in for the final reply. Turns whose last content is commentary
// merely collapse less; the visible reply is never folded away.
function isFinalReplyGroup(item: TurnRenderItem): boolean {
  return (
    isCollapsibleWorkGroup(item) &&
    item.role.toLowerCase() === "assistant" &&
    assistantGroupHasVisibleReplyContent(item)
  );
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

  const result: Array<TurnRenderItem | WorkGroupRenderItem> = [];
  for (const [turnIndex, turn] of turns.entries()) {
    // In-flight content (stream runs, streaming groups) marks the turn live.
    // While the run works, the trailing turn also stays expanded so activity
    // is watchable until the terminal rebuild collapses it.
    const isLive =
      (opts.runWorking && turnIndex === turns.length - 1) ||
      turn.some(
        (item) => item.kind === "stream-run" || (item.kind === "group" && item.isStreaming),
      );
    if (isLive) {
      result.push(...turn);
      continue;
    }
    let finalReplyIndex = -1;
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      const candidate = turn[index];
      if (candidate && isFinalReplyGroup(candidate)) {
        finalReplyIndex = index;
        break;
      }
    }
    // Without a final reply, the tool rows are the turn's only visible result.
    // Keep them exposed instead of replacing the result with an opaque rollup.
    if (finalReplyIndex === -1) {
      result.push(...turn);
      continue;
    }
    const segmentEnd = finalReplyIndex - 1;
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
    const finalReply = turn[finalReplyIndex] as MessageGroup;
    const endTimestamp = finalReply.timestamp;
    const durationMs = endTimestamp > startTimestamp ? endTimestamp - startTimestamp : null;
    result.push(...turn.slice(0, segmentStart));
    result.push({
      kind: "work-group",
      // The final reply survives older-history prepends; the first work row does not.
      key: `work:${finalReply.key}`,
      groups,
      durationMs,
    });
    result.push(...turn.slice(segmentEnd + 1));
  }
  return result;
}

type CompletedTurnRenderItem = TurnRenderItem | WorkGroupRenderItem;

/** Presentation-only rollup for tool groups separated by projected turn boundaries. */
export function coalesceActivityRuns(
  items: CompletedTurnRenderItem[],
  opts: { searchActive?: boolean } = {},
): Array<CompletedTurnRenderItem | ActivityRunRenderItem> {
  if (opts.searchActive) {
    return items;
  }
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
    if (item.kind === "group" && item.role.toLowerCase() === "tool") {
      groups.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}
