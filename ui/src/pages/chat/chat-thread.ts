// Control UI chat module owns Chat thread item derivation and thread-local caches.
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import {
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import { stripHeartbeatTokenForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { isStandaloneToolMessageForDisplay } from "../../lib/chat/message-normalizer.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { resetWorkingProgress } from "./chat-progress.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { sanitizeStreamText } from "./chat-thread-items.ts";
import {
  getOrCreateSessionCacheValue,
  getSessionCacheValue,
  setSessionCacheValue,
} from "./session-cache.ts";

export { isPendingSendMessage, persistedMessageEntryId } from "./chat-thread-items.ts";
export {
  assistantGroupCanOwnActiveRunStatus,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
} from "./chat-thread-grouping.ts";

type CachedChatItems = {
  input: BuildChatItemsProps | null;
  items: ReturnType<typeof buildChatItems>;
  liveStreamIdentity: string | null;
  liveStreamIndex: number;
  liveStreamPrefix: string | null;
};

type RenderChatItem = ReturnType<typeof buildChatItems>[number];

const chatItemsByPane = new Map<string, Map<string, CachedChatItems>>();
const expandedToolCardsBySession = new Map<string, Map<string, boolean>>();
const expandedUserMessagesBySession = new Map<string, Map<string, boolean>>();
const initializedToolCardsBySession = new Map<string, Set<string>>();
const lastAutoExpandPrefBySession = new Map<string, boolean>();
const lastToolCardItemsBySession = new Map<string, readonly (ChatItem | MessageGroup)[]>();

export function resetChatThreadState(paneId?: string): void {
  if (paneId) {
    chatItemsByPane.delete(paneId);
    return;
  }
  chatItemsByPane.clear();
  resetWorkingProgress();
  expandedToolCardsBySession.clear();
  expandedUserMessagesBySession.clear();
  initializedToolCardsBySession.clear();
  lastAutoExpandPrefBySession.clear();
  lastToolCardItemsBySession.clear();
}

function sameMessageGroup(previous: MessageGroup, next: MessageGroup): boolean {
  // Source message identity owns the row timestamp too: normalization supplies
  // Date.now() for missing timestamps, which must not churn stable rows.
  return (
    previous.role === next.role &&
    previous.senderLabel === next.senderLabel &&
    senderIdentityKey(previous.sender) === senderIdentityKey(next.sender) &&
    senderIdentityKey(previous.replyToSender) === senderIdentityKey(next.replyToSender) &&
    previous.isStreaming === next.isStreaming &&
    previous.turnSucceeded === next.turnSucceeded &&
    previous.messages.length === next.messages.length &&
    previous.messages.every((entry, index) => {
      const candidate = next.messages[index];
      return (
        candidate !== undefined &&
        entry.key === candidate.key &&
        entry.message === candidate.message &&
        entry.duplicateCount === candidate.duplicateCount
      );
    })
  );
}

function sameChatItem(previous: RenderChatItem, next: RenderChatItem): boolean {
  if (previous.kind !== next.kind || previous.key !== next.key) {
    return false;
  }
  switch (next.kind) {
    case "group":
      return previous.kind === "group" && sameMessageGroup(previous, next);
    case "message":
      return (
        previous.kind === "message" &&
        previous.message === next.message &&
        previous.duplicateCount === next.duplicateCount
      );
    case "notice":
      return (
        previous.kind === "notice" &&
        previous.text === next.text &&
        previous.timestamp === next.timestamp
      );
    case "divider":
      return (
        previous.kind === "divider" &&
        previous.label === next.label &&
        previous.metric === next.metric &&
        previous.description === next.description &&
        previous.timestamp === next.timestamp &&
        previous.action?.kind === next.action?.kind &&
        previous.action?.label === next.action?.label
      );
    case "stream":
      return (
        previous.kind === "stream" &&
        previous.text === next.text &&
        previous.startedAt === next.startedAt &&
        previous.isStreaming === next.isStreaming
      );
    case "reading-indicator":
      return previous.kind === "reading-indicator" && previous.startedAt === next.startedAt;
    case "question":
      return (
        previous.kind === "question" &&
        previous.questionId === next.questionId &&
        previous.startedAt === next.startedAt
      );
    case "plan":
      return previous.kind === "plan";
  }
  return false;
}

function stabilizeChatItems(
  previous: ReturnType<typeof buildChatItems>,
  next: ReturnType<typeof buildChatItems>,
): ReturnType<typeof buildChatItems> {
  if (previous.length === 0 || next.length === 0) {
    return next;
  }
  // Same-role groups can grow at either edge. Preserve the existing row key
  // when loaded-history arrays retain message objects across prepend or append.
  const previousGroupByMessage = new WeakMap<object, MessageGroup>();
  const previousGroupByMessageKey = new Map<string, MessageGroup>();
  for (const item of previous) {
    if (item.kind !== "group") {
      continue;
    }
    for (const message of item.messages) {
      if (message.message && typeof message.message === "object") {
        previousGroupByMessage.set(message.message, item);
      }
      previousGroupByMessageKey.set(message.key, item);
    }
  }
  const nextNaturalGroupKeys = new Set(
    next.filter((item) => item.kind === "group").map((item) => item.key),
  );
  const claimedGroupKeys = new Set<string>();
  const reconciled = next.map((item) => {
    if (item.kind !== "group") {
      return item;
    }
    const candidates = new Map<MessageGroup, { overlap: number; lastMatchIndex: number }>();
    for (const [index, message] of item.messages.entries()) {
      const prior =
        message.message && typeof message.message === "object"
          ? (previousGroupByMessage.get(message.message) ??
            previousGroupByMessageKey.get(message.key))
          : previousGroupByMessageKey.get(message.key);
      if (
        !prior ||
        claimedGroupKeys.has(prior.key) ||
        prior.role !== item.role ||
        prior.senderLabel !== item.senderLabel ||
        senderIdentityKey(prior.sender) !== senderIdentityKey(item.sender)
      ) {
        continue;
      }
      const candidate = candidates.get(prior);
      candidates.set(prior, {
        overlap: (candidate?.overlap ?? 0) + 1,
        lastMatchIndex: index,
      });
    }
    let best: { group: MessageGroup; overlap: number; lastMatchIndex: number } | null = null;
    for (const [group, candidate] of candidates) {
      if (
        !best ||
        candidate.overlap > best.overlap ||
        (candidate.overlap === best.overlap && candidate.lastMatchIndex > best.lastMatchIndex)
      ) {
        best = { group, ...candidate };
      }
    }
    if (!best) {
      return item;
    }
    if (best.group.key !== item.key && nextNaturalGroupKeys.has(best.group.key)) {
      return item;
    }
    claimedGroupKeys.add(best.group.key);
    return item.key === best.group.key ? item : { ...item, key: best.group.key };
  });
  const previousByKey = new Map(previous.map((item) => [`${item.kind}\u0000${item.key}`, item]));
  const stabilized = reconciled.map((item) => {
    const prior = previousByKey.get(`${item.kind}\u0000${item.key}`);
    return prior && sameChatItem(prior, item) ? prior : item;
  });
  return stabilized.length === previous.length &&
    stabilized.every((item, index) => item === previous[index])
    ? previous
    : stabilized;
}

function sameChatItemsStructuralInput(
  previous: BuildChatItemsProps,
  next: BuildChatItemsProps,
): boolean {
  return (
    previous.sessionKey === next.sessionKey &&
    previous.runId === next.runId &&
    previous.locale === next.locale &&
    previous.messages === next.messages &&
    previous.toolMessages === next.toolMessages &&
    previous.streamSegments === next.streamSegments &&
    previous.streamStartedAt === next.streamStartedAt &&
    previous.queue === next.queue &&
    previous.showToolCalls === next.showToolCalls &&
    previous.persistCommentary === next.persistCommentary &&
    previous.runWorking === next.runWorking &&
    previous.runActive === next.runActive &&
    previous.questionPrompts === next.questionPrompts &&
    Boolean(previous.planStatus?.steps.length) === Boolean(next.planStatus?.steps.length) &&
    previous.loading === next.loading &&
    previous.searchOpen === next.searchOpen &&
    previous.searchQuery === next.searchQuery
  );
}

function sameChatItemsInput(previous: BuildChatItemsProps, next: BuildChatItemsProps): boolean {
  return previous.stream === next.stream && sameChatItemsStructuralInput(previous, next);
}

function sameChatItemsInputExceptStream(
  previous: BuildChatItemsProps,
  next: BuildChatItemsProps,
): boolean {
  return (
    previous.stream !== null && next.stream !== null && sameChatItemsStructuralInput(previous, next)
  );
}

function accumulatedIndexedStreamText(segments: readonly ChatStreamSegment[]): string | null {
  let accumulated: string | null = null;
  for (const segment of segments) {
    if (streamSegmentHasItemId(segment) || !streamSegmentUsesAccumulatedText(segment)) {
      continue;
    }
    const text = sanitizeStreamText(segment.text);
    if (text.length > 0) {
      accumulated = text;
    }
  }
  return accumulated;
}

function liveStreamIdentity(input: BuildChatItemsProps): string {
  return JSON.stringify([input.sessionKey, input.runId ?? null, input.streamStartedAt]);
}

function updateCachedLiveStream(
  items: ReturnType<typeof buildChatItems>,
  index: number,
  identity: string | null,
  accumulatedPrefix: string | null,
  input: BuildChatItemsProps,
): boolean {
  const item = items[index];
  if (
    item?.kind !== "stream" ||
    !item.isStreaming ||
    identity !== liveStreamIdentity(input) ||
    input.stream === null
  ) {
    return false;
  }
  const text = trimAccumulatedStreamPrefix(sanitizeStreamText(input.stream), accumulatedPrefix);
  if (text.length === 0 || stripHeartbeatTokenForDisplay(text).shouldSkip) {
    return false;
  }
  items[index] = { ...item, text };
  return true;
}

function findLiveStreamIndex(items: ReturnType<typeof buildChatItems>): number {
  return items.findIndex((item) => item.kind === "stream" && item.isStreaming);
}

export function buildCachedChatItems(
  input: BuildChatItemsProps,
): ReturnType<typeof buildChatItems> {
  let paneCache = chatItemsByPane.get(input.paneId);
  if (!paneCache) {
    paneCache = new Map();
    chatItemsByPane.set(input.paneId, paneCache);
  }
  const cached = getOrCreateSessionCacheValue(paneCache, input.sessionKey, () => ({
    input: null,
    items: [],
    liveStreamIdentity: null,
    liveStreamIndex: -1,
    liveStreamPrefix: null,
  }));
  if (cached.input && sameChatItemsInput(cached.input, input)) {
    return cached.items;
  }
  // Streaming updates are the hottest transcript path. When every structural
  // input is unchanged, update the owned live row without rescanning
  // loaded history; shape changes still use the canonical full builder.
  if (
    cached.input &&
    sameChatItemsInputExceptStream(cached.input, input) &&
    updateCachedLiveStream(
      cached.items,
      cached.liveStreamIndex,
      cached.liveStreamIdentity,
      cached.liveStreamPrefix,
      input,
    )
  ) {
    cached.input = input;
    return cached.items;
  }
  const items = stabilizeChatItems(cached.items, buildChatItems(input));
  cached.input = input;
  cached.items = items;
  cached.liveStreamIndex = findLiveStreamIndex(items);
  cached.liveStreamIdentity = cached.liveStreamIndex === -1 ? null : liveStreamIdentity(input);
  cached.liveStreamPrefix = accumulatedIndexedStreamText(input.streamSegments);
  return items;
}

export function deletedChatItemsSignature(
  deleted: { has: (key: string) => boolean },
  chatItems: ReturnType<typeof buildChatItems>,
): string {
  const deletedKeys = chatItems
    .map((item) => item.key)
    .filter((key) => deleted.has(key))
    .toSorted();
  return deletedKeys.length === 0 ? "" : deletedKeys.join("\u0000");
}

export function stableBooleanMapSignature(values: ReadonlyMap<string, boolean>): string {
  if (values.size === 0) {
    return "";
  }
  return Array.from(values)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value ? "1" : "0"}`)
    .join("\u0000");
}

export function getExpandedToolCards(sessionKey: string): Map<string, boolean> {
  return getOrCreateSessionCacheValue(expandedToolCardsBySession, sessionKey, () => new Map());
}

export function getExpandedUserMessages(sessionKey: string): Map<string, boolean> {
  for (const [cachedKey, state] of expandedUserMessagesBySession) {
    if (areUiSessionKeysEquivalent(cachedKey, sessionKey)) {
      if (cachedKey !== sessionKey) {
        expandedUserMessagesBySession.delete(cachedKey);
        setSessionCacheValue(expandedUserMessagesBySession, sessionKey, state);
      }
      return state;
    }
  }
  return getOrCreateSessionCacheValue(expandedUserMessagesBySession, sessionKey, () => new Map());
}

function getInitializedToolCards(sessionKey: string): Set<string> {
  return getOrCreateSessionCacheValue(initializedToolCardsBySession, sessionKey, () => new Set());
}

export function syncToolCardExpansionState(
  sessionKey: string,
  items: readonly (ChatItem | MessageGroup)[],
  autoExpandToolCalls: boolean,
): void {
  const expanded = getExpandedToolCards(sessionKey);
  const initialized = getInitializedToolCards(sessionKey);
  const previousItems = getSessionCacheValue(lastToolCardItemsBySession, sessionKey);
  const previousAutoExpand = getSessionCacheValue(lastAutoExpandPrefBySession, sessionKey) ?? false;
  if (previousItems === items && previousAutoExpand === autoExpandToolCalls) {
    return;
  }
  const currentToolCardIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "group") {
      continue;
    }
    for (const entry of item.messages) {
      const cards = extractToolCardsCached(entry.message, entry.key);
      for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
        const disclosureId = `${entry.key}:toolcard:${cardIndex}`;
        currentToolCardIds.add(disclosureId);
        if (initialized.has(disclosureId)) {
          continue;
        }
        expanded.set(disclosureId, autoExpandToolCalls);
        initialized.add(disclosureId);
      }
      if (!isStandaloneToolMessageForDisplay(entry.message)) {
        continue;
      }
      const disclosureId = `toolmsg:${entry.key}`;
      currentToolCardIds.add(disclosureId);
      if (initialized.has(disclosureId)) {
        continue;
      }
      expanded.set(disclosureId, autoExpandToolCalls);
      initialized.add(disclosureId);
    }
  }
  if (autoExpandToolCalls && !previousAutoExpand) {
    for (const toolCardId of currentToolCardIds) {
      expanded.set(toolCardId, true);
    }
  }
  setSessionCacheValue(lastToolCardItemsBySession, sessionKey, items);
  setSessionCacheValue(lastAutoExpandPrefBySession, sessionKey, autoExpandToolCalls);
}
