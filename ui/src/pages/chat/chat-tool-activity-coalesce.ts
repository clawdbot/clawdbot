// Pairs assistant tool-call transcript items with their tool-result siblings so
// each call renders as one complete card instead of a call row plus a bare
// result row. Split from chat-thread-grouping.ts, which owns row grouping.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import type { ChatItem, ToolCard } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { resolveMessageToolUseId, resolveToolBlockId } from "./chat-thread-items.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";

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
