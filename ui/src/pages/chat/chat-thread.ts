import {
  accumulatedStreamText,
  trimAccumulatedStreamPrefix,
  type ChatItem,
  type MessageGroup,
} from "../../lib/chat/chat-types.ts";
import { stripHeartbeatTokenForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { isStandaloneToolMessageForDisplay } from "../../lib/chat/message-normalizer.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { resetWorkingProgress } from "./chat-progress.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { sanitizeStreamText } from "./chat-thread-items.ts";
import { getOrCreateSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";

export {
  isPendingSendMessage,
  persistedMessageEntryId,
  readPendingSendFailure,
} from "./chat-thread-items.ts";
export {
  assistantGroupCanOwnActiveRunStatus,
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
} from "./chat-thread-grouping.ts";
export { agentRunFrameGroups, coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";

type CachedChatItems = {
  input: BuildChatItemsProps | null;
  items: ReturnType<typeof buildChatItems>;
  liveStream: {
    index: number;
    identity: string;
    prefix: string | null;
  } | null;
};

type RenderChatItem = ReturnType<typeof buildChatItems>[number];

type ToolCardExpansionState = {
  expanded: Map<string, boolean>;
  // Group disclosures share the map but must stay outside tool-only auto-expand and pruning.
  initialized: Set<string>;
  lastSync?: {
    // The scan memo must not retain messages after their owning pane releases them.
    items: WeakRef<readonly RenderChatItem[]>;
    isFilteredProjection: boolean;
    autoExpandToolCalls: boolean;
  };
};

const chatItemsByPane = new Map<string, Map<string, CachedChatItems>>();
const toolCardStateBySession = new Map<string, ToolCardExpansionState>();
const expandedUserMessagesBySession = new Map<string, Map<string, boolean>>();
const expansionMapVersions = new WeakMap<ReadonlyMap<string, unknown>, number>();

export function resetChatThreadState(paneId?: string): void {
  if (paneId) {
    chatItemsByPane.delete(paneId);
    return;
  }
  chatItemsByPane.clear();
  resetWorkingProgress();
  toolCardStateBySession.clear();
  expandedUserMessagesBySession.clear();
}

function sameMessageGroup(previous: MessageGroup, next: MessageGroup): boolean {
  // Source message identity owns the row timestamp too: normalization supplies
  // Date.now() for missing timestamps, which must not churn stable rows.
  return (
    previous.role === next.role &&
    previous.senderLabel === next.senderLabel &&
    previous.senderSession?.sessionKey === next.senderSession?.sessionKey &&
    previous.senderSession?.agentId === next.senderSession?.agentId &&
    JSON.stringify(previous.sender) === JSON.stringify(next.sender) &&
    JSON.stringify(previous.replyToSender) === JSON.stringify(next.replyToSender) &&
    previous.isStreaming === next.isStreaming &&
    previous.visibleContent === next.visibleContent &&
    previous.runId === next.runId &&
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
        previous.label === next.label &&
        previous.startsTurn === next.startsTurn &&
        previous.timestamp === next.timestamp
      );
    case "divider":
      return (
        previous.kind === "divider" &&
        previous.compaction === next.compaction &&
        previous.compactionId === next.compactionId &&
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
        previous.isStreaming === next.isStreaming &&
        previous.runId === next.runId &&
        previous.boundaryId === next.boundaryId
      );
    case "reading-indicator":
      return (
        previous.kind === "reading-indicator" &&
        previous.startedAt === next.startedAt &&
        previous.runId === next.runId &&
        previous.boundaryId === next.boundaryId
      );
    case "question":
      return (
        previous.kind === "question" &&
        previous.questionId === next.questionId &&
        previous.startedAt === next.startedAt
      );
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
  const previousCompactions = new Map(
    previous.flatMap((item) =>
      item.kind === "divider" && item.compactionId ? [[item.compactionId, item.key] as const] : [],
    ),
  );
  const reconciled = next.map((item) => {
    if (item.kind === "divider" && item.compactionId) {
      const key = previousCompactions.get(item.compactionId);
      return key ? { ...item, key } : item;
    }
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
        prior.runId !== item.runId ||
        prior.senderLabel !== item.senderLabel ||
        prior.senderSession?.sessionKey !== item.senderSession?.sessionKey ||
        prior.senderSession?.agentId !== item.senderSession?.agentId ||
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
    previous.archiveNotice?.key === next.archiveNotice?.key &&
    previous.archiveNotice?.label === next.archiveNotice?.label &&
    previous.runId === next.runId &&
    previous.compactionStatus === next.compactionStatus &&
    previous.locale === next.locale &&
    previous.messages === next.messages &&
    previous.toolMessages === next.toolMessages &&
    previous.guardianNotices === next.guardianNotices &&
    previous.streamSegments === next.streamSegments &&
    previous.streamStartedAt === next.streamStartedAt &&
    previous.queue === next.queue &&
    previous.pendingInputs === next.pendingInputs &&
    previous.showToolCalls === next.showToolCalls &&
    previous.persistCommentary === next.persistCommentary &&
    previous.runWorking === next.runWorking &&
    previous.runActive === next.runActive &&
    previous.questionPrompts === next.questionPrompts &&
    previous.loading === next.loading &&
    previous.searchOpen === next.searchOpen &&
    previous.searchQuery === next.searchQuery
  );
}

function liveStreamIdentity(input: BuildChatItemsProps): string {
  return JSON.stringify([input.sessionKey, input.runId ?? null, input.streamStartedAt]);
}

function updateCachedLiveStream(cached: CachedChatItems, input: BuildChatItemsProps): boolean {
  const live = cached.liveStream;
  const item = live ? cached.items[live.index] : undefined;
  if (
    input.stream === null ||
    !live ||
    item?.kind !== "stream" ||
    !item.isStreaming ||
    live.identity !== liveStreamIdentity(input)
  ) {
    return false;
  }
  const text = trimAccumulatedStreamPrefix(sanitizeStreamText(input.stream), live.prefix);
  if (text.length === 0 || stripHeartbeatTokenForDisplay(text).shouldSkip) {
    return false;
  }
  cached.items[live.index] = { ...item, text };
  return true;
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
    liveStream: null,
  }));
  // Keep stream-only updates off the loaded-history path; structural changes
  // still use the full builder.
  if (cached.input && sameChatItemsStructuralInput(cached.input, input)) {
    if (cached.input.stream === input.stream) {
      return cached.items;
    }
    if (cached.input.stream !== null && updateCachedLiveStream(cached, input)) {
      cached.input = input;
      return cached.items;
    }
  }
  const items = stabilizeChatItems(cached.items, buildChatItems(input));
  cached.input = input;
  cached.items = items;
  const liveStreamIndex = items.findIndex((item) => item.kind === "stream" && item.isStreaming);
  cached.liveStream =
    liveStreamIndex < 0
      ? null
      : {
          index: liveStreamIndex,
          identity: liveStreamIdentity(input),
          prefix: accumulatedStreamText(input.streamSegments, sanitizeStreamText),
        };
  return items;
}

export function getExpansionStateVersion(values: ReadonlyMap<string, unknown>): number {
  return expansionMapVersions.get(values) ?? 0;
}

export function setExpansionState<T>(values: Map<string, T>, key: string, value: T): void {
  if (values.has(key) && values.get(key) === value) {
    return;
  }
  values.set(key, value);
  expansionMapVersions.set(values, getExpansionStateVersion(values) + 1);
}

export function deleteExpansionState<T>(values: Map<string, T>, key: string): void {
  if (values.delete(key)) {
    expansionMapVersions.set(values, getExpansionStateVersion(values) + 1);
  }
}

function getToolCardExpansionState(sessionKey: string): ToolCardExpansionState {
  // Expansion choices, initialization, and memoization share one eviction boundary.
  return getOrCreateSessionCacheValue(toolCardStateBySession, sessionKey, () => ({
    expanded: new Map(),
    initialized: new Set(),
  }));
}

export function getExpandedToolCards(sessionKey: string): Map<string, boolean> {
  return getToolCardExpansionState(sessionKey).expanded;
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

export function* collectToolTitleCandidates(items: readonly (ChatItem | MessageGroup)[]) {
  for (const item of items) {
    if (item.kind === "group") {
      for (const entry of item.messages) {
        yield* extractToolCardsCached(entry.message);
      }
    }
  }
}

export type AssistantMessageExpansionState =
  | { status: "loading"; revision: number }
  | { status: "error"; revision: number }
  | { status: "loaded"; markdown: string; revision: number };

export function syncToolCardExpansionState(
  sessionKey: string,
  items: readonly (ChatItem | MessageGroup)[],
  autoExpandToolCalls: boolean,
  isFilteredProjection = false,
): void {
  const state = getToolCardExpansionState(sessionKey);
  const { expanded, initialized, lastSync } = state;
  if (
    lastSync?.items.deref() === items &&
    lastSync.isFilteredProjection === isFilteredProjection &&
    lastSync.autoExpandToolCalls === autoExpandToolCalls
  ) {
    return;
  }
  const currentToolCardIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "group") {
      continue;
    }
    for (const entry of item.messages) {
      const cards = extractToolCardsCached(entry.message);
      for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
        const disclosureId = `${entry.key}:toolcard:${cardIndex}`;
        currentToolCardIds.add(disclosureId);
        if (initialized.has(disclosureId)) {
          continue;
        }
        setExpansionState(expanded, disclosureId, autoExpandToolCalls);
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
      setExpansionState(expanded, disclosureId, autoExpandToolCalls);
      initialized.add(disclosureId);
    }
  }
  if (autoExpandToolCalls && !lastSync?.autoExpandToolCalls) {
    for (const toolCardId of initialized) {
      setExpansionState(expanded, toolCardId, true);
    }
  }
  // Search hides existing cards temporarily; pruning that projection would
  // discard the user's disclosure choice before the full transcript returns.
  if (!isFilteredProjection) {
    for (const disclosureId of initialized) {
      if (!currentToolCardIds.has(disclosureId)) {
        initialized.delete(disclosureId);
        deleteExpansionState(expanded, disclosureId);
      }
    }
  }
  state.lastSync = {
    items: new WeakRef(items),
    isFilteredProjection,
    autoExpandToolCalls,
  };
}
