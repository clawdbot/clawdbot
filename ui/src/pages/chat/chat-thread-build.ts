import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { t } from "../../i18n/index.ts";
import {
  type ChatGuardianNotice,
  type ChatItem,
  type ChatQueueItem,
  type MessageGroup,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  buildCompactionDividerItem,
  buildResetDividerItem,
  clearWorkingProgress,
  projectContextCompactionActivity,
  resolveWorkingProgress,
  shouldRenderQueuedSendInThread,
} from "./chat-progress.ts";
import { chatMessagesContainQueuedSend } from "./chat-send-support.ts";
import {
  coalesceToolActivityMessages,
  groupMessages,
  isKeyedAssistantStreamFallbackMessage,
} from "./chat-thread-grouping.ts";
import {
  appendCanvasBlockToAssistantMessage,
  buildMessageKeys,
  canvasPreviewBaseIdentity,
  collapseSequentialDuplicateMessages,
  createCanvasAssistantMessage,
  extractChatMessagePreview,
  findCanvasInsertionIndex,
  findNearestAssistantMessageIndex,
  hasRenderableNormalizedMessage,
  insertionIndexesForBounds,
  messageKey,
  messageMatchesSearchQuery,
  queuedSendThreadMessage,
  rawMessageTimestamp,
  insertChatItemsByTimestamp,
  sanitizeStreamText,
  timestampAfterVisibleItems,
  transcriptPositionTimestamp,
  turnHasMatchingAssistant,
  userTurnSendIdentity,
  type TurnInsertionBounds,
} from "./chat-thread-items.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { resolveSystemNoticeKind } from "./system-notice-kinds.ts";
import { isLiveTerminalForRun } from "./terminal-message-identity.ts";
import {
  buildLiveRenderedToolRefs,
  buildToolStreamIdentity,
  removeLiveToolBlocksFromHistory,
} from "./tool-stream-identity.ts";

export type BuildChatItemsProps = {
  paneId: string;
  sessionKey: string;
  runId?: string | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  guardianNotices?: ChatGuardianNotice[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  questionPrompts?: readonly QuestionPrompt[];
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
};

function guardianNoticeItem(notice: ChatGuardianNotice): Extract<ChatItem, { kind: "notice" }> {
  const action = notice.command ?? t("chat.systemNotice.guardian.requestedAction");
  if (notice.kind === "approved") {
    return {
      kind: "notice",
      key: notice.key,
      icon: "shieldCheck",
      label: t("chat.systemNotice.guardian.approvedSummary", { action }),
      text: "",
      timestamp: notice.timestamp,
    };
  }
  if (notice.kind === "warning") {
    return {
      kind: "notice",
      key: notice.key,
      icon: "shieldCheck",
      label: t("chat.systemNotice.guardian.warningLabel"),
      text: notice.message ?? t("chat.systemNotice.guardian.warningFallback"),
      timestamp: notice.timestamp,
      tone: "danger",
    };
  }
  return {
    kind: "notice",
    key: notice.key,
    icon: "shieldCheck",
    label: t("chat.systemNotice.guardian.deniedLabel"),
    text: t("chat.systemNotice.guardian.deniedSummary", {
      action,
      risk: notice.riskLevel ?? t("chat.systemNotice.guardian.unknownRisk"),
      rationale: notice.rationale ?? t("chat.systemNotice.guardian.noRationale"),
    }),
    timestamp: notice.timestamp,
    tone: "danger",
  };
}

function isUserChatItem(item: ChatItem): boolean {
  if (item.kind !== "message") {
    return false;
  }
  const normalized = safeNormalizeMessage(item.message);
  return normalized ? normalizeRoleForGrouping(normalized.role).toLowerCase() === "user" : false;
}

function findCurrentTurnBounds(items: ChatItem[]): TurnInsertionBounds | null {
  const index = items.findLastIndex(isUserChatItem);
  const item = items[index];
  return index >= 0 && item ? { afterKey: item.key } : null;
}

function findRunTurnBounds(items: ChatItem[], runId: string): TurnInsertionBounds | null {
  const sendIdentity = `send:${runId}`;
  const index = items.findIndex(
    (item) =>
      item.kind === "message" &&
      isUserChatItem(item) &&
      userTurnSendIdentity(item.message) === sendIdentity,
  );
  const item = items[index];
  if (index < 0 || !item) {
    return null;
  }
  const nextUser = items.slice(index + 1).find(isUserChatItem);
  return { afterKey: item.key, ...(nextUser ? { beforeKey: nextUser.key } : {}) };
}

function resolveRunInsertionBounds(
  items: ChatItem[],
  runId: unknown,
  currentRunId: string | null | undefined,
  currentTurnBounds: TurnInsertionBounds | null,
): TurnInsertionBounds | null {
  if (typeof runId !== "string" || !runId.trim()) {
    return currentRunId != null ? currentTurnBounds : null;
  }
  const runBounds = findRunTurnBounds(items, runId);
  if (runId === currentRunId) {
    // Active runs can span steers: the original prompt is a floor, not a ceiling.
    return runBounds ? { afterKey: runBounds.afterKey } : currentTurnBounds;
  }
  if (runBounds || currentRunId == null) {
    return runBounds;
  }
  // Legacy rows may lack the user-run identity needed for exact bounds. Keep
  // their timestamp ordering across historical turns, but never cross the
  // current prompt and become current-run output.
  return currentTurnBounds?.afterKey ? { beforeKey: currentTurnBounds.afterKey } : null;
}

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const tools = props.toolMessages.filter((message) => asRecord(message) !== null);
  const liveToolRefs = buildLiveRenderedToolRefs(tools);
  const history = props.messages
    .filter(
      (message) =>
        !isAssistantHeartbeatAckForDisplay(message) &&
        (props.persistCommentary !== false || !isKeyedAssistantStreamFallbackMessage(message)),
    )
    .map((message) => removeLiveToolBlocksFromHistory(message, liveToolRefs));
  const historyKeys = buildMessageKeys(history);
  const toolKeys = buildMessageKeys(tools, history.length);
  const liftedCanvasSources = tools.flatMap((message, index) => {
    const source = extractChatMessagePreview(message);
    return source ? [{ ...source, message, index }] : [];
  });
  const searchFiltering = props.searchOpen === true && Boolean(props.searchQuery?.trim());
  const persistedCanvasIdentities = new Set<string>();
  for (const message of history) {
    const source = extractChatMessagePreview(message);
    if (!source) {
      continue;
    }
    const baseIdentity = canvasPreviewBaseIdentity(message, source);
    if (baseIdentity) {
      // fetchMcpAppView assigns a fresh viewId to every invocation. Matching the call and
      // view therefore identifies the same preview while still tolerating a reused call ID.
      persistedCanvasIdentities.add(baseIdentity);
    }
  }
  for (let i = 0; i < history.length; i++) {
    const msg = projectContextCompactionActivity(history[i]);
    const itemKey = historyKeys[i] ?? messageKey(msg, i);
    const normalized = safeNormalizeMessage(msg);
    if (!normalized) {
      continue;
    }
    const raw = asRecord(msg) ?? {};
    const marker = raw["__openclaw"] as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push(buildCompactionDividerItem(marker, normalized.timestamp ?? Date.now(), i));
      continue;
    }
    if (marker && marker.kind === "reset") {
      items.push(buildResetDividerItem(marker, normalized.timestamp ?? Date.now(), i));
      continue;
    }

    const role = normalizeRoleForGrouping(normalized.role);
    if (role === "system") {
      const text = extractTextCached(msg);
      if (text?.trim()) {
        items.push({ kind: "notice", key: itemKey, text, timestamp: normalized.timestamp });
      }
      continue;
    }

    const isToolResult = normalized.role.toLowerCase() === "toolresult";
    const persistedCanvasSource = isToolResult ? extractChatMessagePreview(msg) : null;
    const renderPersistedPreview =
      persistedCanvasSource != null &&
      (!searchFiltering || turnHasMatchingAssistant(history, i, props.searchQuery ?? ""));
    if (persistedCanvasSource && renderPersistedPreview) {
      items.push({
        kind: "message",
        key: `${itemKey}:canvas`,
        message: createCanvasAssistantMessage(
          persistedCanvasSource,
          persistedCanvasSource.timestamp ?? transcriptPositionTimestamp(history, i),
        ),
      });
    }

    if (!props.showToolCalls && isToolResult) {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (props.searchOpen && searchQuery.trim() && !messageMatchesSearchQuery(msg, searchQuery)) {
      continue;
    }
    if (!hasRenderableNormalizedMessage(msg) && normalized.role.toLowerCase() !== "assistant") {
      continue;
    }

    const provenance = asRecord(raw.provenance);
    if (role === "user" && provenance?.kind === "internal_system") {
      const noticeKind = resolveSystemNoticeKind(
        typeof provenance.sourceTool === "string" ? provenance.sourceTool : undefined,
      );
      const text = noticeKind?.summaryKey
        ? t(noticeKind.summaryKey)
        : extractTextCached(msg)?.replace(/^\[System\] /u, "");
      if (text?.trim()) {
        items.push({
          kind: "notice",
          key: itemKey,
          icon: noticeKind?.icon ?? "cpu",
          label: noticeKind ? t(noticeKind.labelKey) : t("common.system"),
          startsTurn: true,
          text,
          timestamp: normalized.timestamp,
        });
      }
      continue;
    }

    items.push({
      kind: "message",
      key: itemKey,
      message: msg,
    });
  }
  const queuedSends = props.queue ?? [];
  // Once authoritative history carries the send id, that message owns the bubble.
  // Keep the queue row for run progress and delivery retirement, but do not render both copies.
  const threadQueuedSends = queuedSends.filter(
    (queued) => !chatMessagesContainQueuedSend(history, queued, true),
  );
  const currentRunQueuedSends = threadQueuedSends.filter(
    (queued) =>
      queued.sendState === "sending" ||
      queued.sendState === "waiting-model" ||
      (queued.sendState === "waiting-reconnect" &&
        props.runId != null &&
        queued.sendRunId === props.runId),
  );
  const futureQueuedSends = threadQueuedSends.filter(
    (queued) => !currentRunQueuedSends.includes(queued),
  );
  const futureQueuedTimestamp = futureQueuedSends.reduce<number | null>(
    (earliest, queued) =>
      earliest == null ? queued.createdAt : Math.min(earliest, queued.createdAt),
    null,
  );
  // Live tool cards and stream segments are collected separately and merged into
  // the stable history + queued-send rows by timestamp below. We never reorder
  // the stable rows themselves, so optimistic user bubbles stay after the
  // preceding assistant reply even when client and Gateway clocks disagree.
  const timestampedProjectionItems: ChatItem[] = [];
  const appendQueuedSend = (queued: ChatQueueItem, beforeMessage?: unknown) => {
    if (!shouldRenderQueuedSendInThread(queued)) {
      return;
    }
    const message = queuedSendThreadMessage(queued);
    if (!message) {
      return;
    }
    const searchQuery = props.searchQuery ?? "";
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(message, searchQuery)
    ) {
      return;
    }
    const queuedItem: ChatItem = {
      kind: "message",
      // Mirror buildMessageKeys for a send-identity source key so the pending
      // row and its history successor resolve to the same Lit key.
      key: queued.sendRunId ? `msg:send:${queued.sendRunId}:0` : `pending-send:${queued.id}`,
      message,
    };
    const insertionIndex =
      beforeMessage === undefined
        ? -1
        : items.findIndex((item) => item.kind === "message" && item.message === beforeMessage);
    if (insertionIndex === -1) {
      items.push(queuedItem);
    } else {
      items.splice(insertionIndex, 0, queuedItem);
    }
  };
  for (const queued of currentRunQueuedSends) {
    const runId = queued.sendRunId;
    const liveTerminal = runId
      ? history.find((message) => isLiveTerminalForRun(message, runId))
      : undefined;
    appendQueuedSend(queued, liveTerminal);
  }
  const currentTurnBounds = findCurrentTurnBounds(items);
  for (const liftedCanvasSource of liftedCanvasSources) {
    const baseIdentity = canvasPreviewBaseIdentity(liftedCanvasSource.message, liftedCanvasSource);
    if (baseIdentity && persistedCanvasIdentities.has(baseIdentity)) {
      continue;
    }
    const sourceRunId = asRecord(liftedCanvasSource.message)?.runId;
    const canvasBounds = resolveRunInsertionBounds(
      items,
      sourceRunId,
      props.runId,
      currentTurnBounds,
    );
    const { minimum: canvasMinimumIndex, maximum: canvasMaximumIndex } = insertionIndexesForBounds(
      items,
      canvasBounds ?? undefined,
    );
    const assistantIndex = findNearestAssistantMessageIndex(
      items,
      liftedCanvasSource.timestamp,
      canvasMinimumIndex,
      canvasMaximumIndex,
    );
    if (assistantIndex == null) {
      if (searchFiltering) {
        continue;
      }
      const insertionIndex = findCanvasInsertionIndex(
        items,
        liftedCanvasSource.timestamp,
        canvasMinimumIndex,
        canvasMaximumIndex,
      );
      const nextItem = items[insertionIndex];
      const nextTimestamp =
        nextItem?.kind === "message" ? rawMessageTimestamp(nextItem.message) : null;
      const boundaryTimestamp =
        nextTimestamp == null
          ? futureQueuedTimestamp
          : futureQueuedTimestamp == null
            ? nextTimestamp
            : Math.min(nextTimestamp, futureQueuedTimestamp);
      const timestamp =
        liftedCanvasSource.timestamp != null && boundaryTimestamp != null
          ? Math.min(liftedCanvasSource.timestamp, boundaryTimestamp)
          : liftedCanvasSource.timestamp;
      // Canvas previews are positioned relative to the queued-send tail that
      // existed when they were lifted, so they stay in the stable row order
      // rather than being re-sorted with live stream/tool cards.
      items.splice(insertionIndex, 0, {
        kind: "message",
        key: `${
          toolKeys[liftedCanvasSource.index] ??
          messageKey(liftedCanvasSource.message, liftedCanvasSource.index + history.length)
        }:canvas`,
        message: createCanvasAssistantMessage(liftedCanvasSource, timestamp),
      });
      continue;
    }
    const item = items[assistantIndex];
    if (!item || item.kind !== "message") {
      continue;
    }
    items[assistantIndex] = {
      ...item,
      message: appendCanvasBlockToAssistantMessage(
        item.message as Record<string, unknown>,
        liftedCanvasSource.preview,
        liftedCanvasSource.text,
      ),
    };
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const segments = props.streamSegments;
  const afterBoundaryBySegment = new Map<ChatStreamSegment, string>();
  let latestBoundaryRunId: string | undefined;
  for (const segment of segments) {
    const afterBoundaryRunId =
      normalizeOptionalString(segment.afterBoundaryRunId) ?? latestBoundaryRunId;
    if (afterBoundaryRunId) {
      afterBoundaryBySegment.set(segment, afterBoundaryRunId);
    }
    latestBoundaryRunId = normalizeOptionalString(segment.boundaryRunId) ?? latestBoundaryRunId;
  }
  const keyedSegments = segments.filter(streamSegmentHasItemId);
  const indexedSegments = segments.filter(
    (segment) => !streamSegmentHasItemId(segment) && segment.boundaryMarker !== true,
  );
  const toolItems = tools.map((message, index) => ({
    key: toolKeys[index] ?? messageKey(message, index + history.length),
    message,
  }));
  const toolKeysByIdentity = new Map<string, string>();
  const uniqueToolKeysByCallId = new Map<string, string | null>();
  const addUniqueBareValue = (
    values: Map<string, string | null>,
    toolCallId: string,
    value: string,
  ) => values.set(toolCallId, values.has(toolCallId) ? null : value);
  for (const tool of toolItems) {
    const toolRecord = asRecord(tool.message);
    const toolCallId = normalizeOptionalString(toolRecord?.toolCallId);
    if (typeof toolCallId === "string" && toolCallId.trim()) {
      const runId = normalizeOptionalString(toolRecord?.runId);
      if (runId) {
        toolKeysByIdentity.set(buildToolStreamIdentity(runId, toolCallId), tool.key);
      }
      addUniqueBareValue(uniqueToolKeysByCallId, toolCallId, tool.key);
    }
  }
  const maxLen = Math.max(indexedSegments.length, tools.length);
  let previousAccumulatedStreamText: string | null = null;
  const toolStreamPredecessors = new Map<string, string>();
  const projectionInsertionBounds = new Map<string, TurnInsertionBounds>();
  const applyRunBounds = (
    key: string,
    runId: unknown,
    boundaryRunId?: string,
    afterBoundaryRunId?: string,
  ) => {
    const bounds = resolveRunInsertionBounds(items, runId, props.runId, currentTurnBounds);
    const boundaryKey = boundaryRunId
      ? findRunTurnBounds(items, boundaryRunId)?.afterKey
      : undefined;
    const afterBounds = afterBoundaryRunId
      ? findRunTurnBounds(items, afterBoundaryRunId)
      : undefined;
    if (bounds || boundaryKey || afterBounds) {
      projectionInsertionBounds.set(key, {
        ...bounds,
        ...(afterBounds?.afterKey ? { afterKey: afterBounds.afterKey } : {}),
        ...(afterBounds?.beforeKey ? { beforeKey: afterBounds.beforeKey } : {}),
        ...(boundaryKey ? { beforeKey: boundaryKey } : {}),
      });
    }
  };
  if (!searchFiltering) {
    for (const notice of props.guardianNotices ?? []) {
      const item = guardianNoticeItem(notice);
      timestampedProjectionItems.push(item);
      applyRunBounds(item.key, notice.runId);
    }
  }
  const toolBoundariesByIdentity = new Map<string, string>();
  const uniqueToolBoundariesByCallId = new Map<string, string | null>();
  const toolAfterBoundariesByIdentity = new Map<string, string>();
  const uniqueToolAfterBoundariesByCallId = new Map<string, string | null>();
  for (const segment of indexedSegments) {
    const toolCallId = normalizeOptionalString(segment.toolCallId);
    const boundaryRunId = normalizeOptionalString(segment.boundaryRunId);
    const afterBoundaryRunId = afterBoundaryBySegment.get(segment);
    if (!toolCallId) {
      continue;
    }
    const runId = normalizeOptionalString(segment.runId);
    if (runId && boundaryRunId) {
      toolBoundariesByIdentity.set(buildToolStreamIdentity(runId, toolCallId), boundaryRunId);
    }
    if (boundaryRunId) {
      addUniqueBareValue(uniqueToolBoundariesByCallId, toolCallId, boundaryRunId);
    }
    if (runId && afterBoundaryRunId) {
      toolAfterBoundariesByIdentity.set(
        buildToolStreamIdentity(runId, toolCallId),
        afterBoundaryRunId,
      );
    }
    if (afterBoundaryRunId) {
      addUniqueBareValue(uniqueToolAfterBoundariesByCallId, toolCallId, afterBoundaryRunId);
    }
  }
  const resolveScopedValue = (
    exact: ReadonlyMap<string, string>,
    bare: ReadonlyMap<string, string | null>,
    runId: string | undefined,
    toolCallId: string,
  ) =>
    (runId ? exact.get(buildToolStreamIdentity(runId, toolCallId)) : undefined) ??
    bare.get(toolCallId) ??
    undefined;
  for (let i = 0; i < maxLen; i++) {
    if (i < indexedSegments.length) {
      const segment = indexedSegments[i];
      if (!segment) {
        continue;
      }
      const text = sanitizeStreamText(segment.text);
      const usesAccumulatedText = streamSegmentUsesAccumulatedText(segment);
      const visibleText = usesAccumulatedText
        ? trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText)
        : text;
      if (usesAccumulatedText) {
        previousAccumulatedStreamText = advanceAccumulatedStreamText(
          previousAccumulatedStreamText,
          text,
        );
      }
      if (visibleText.length > 0) {
        const streamKey = `stream-seg:${props.sessionKey}:${i}`;
        const streamItem: ChatItem = {
          kind: "stream",
          key: streamKey,
          text: visibleText,
          startedAt: segment.ts,
          isStreaming: false,
        };
        timestampedProjectionItems.push(streamItem);
        applyRunBounds(
          streamItem.key,
          segment.runId,
          segment.boundaryRunId,
          afterBoundaryBySegment.get(segment),
        );
        const toolCallId = segment.toolCallId?.trim();
        const toolKey = toolCallId
          ? resolveScopedValue(
              toolKeysByIdentity,
              uniqueToolKeysByCallId,
              normalizeOptionalString(segment.runId),
              toolCallId,
            )
          : undefined;
        if (toolKey) {
          // Gateway and browser clocks can disagree. Keep the assistant text that
          // introduced a tool causally before its card even when timestamps do not.
          toolStreamPredecessors.set(toolKey, streamKey);
        }
      }
    }
    const tool = toolItems[i];
    if (tool && props.showToolCalls) {
      const toolItem: ChatItem = {
        kind: "message",
        key: tool.key,
        message: tool.message,
      };
      timestampedProjectionItems.push(toolItem);
      const toolRecord = asRecord(tool.message);
      const toolCallId = normalizeOptionalString(toolRecord?.toolCallId);
      const toolRunId = normalizeOptionalString(toolRecord?.runId);
      applyRunBounds(
        toolItem.key,
        toolRunId,
        toolCallId
          ? resolveScopedValue(
              toolBoundariesByIdentity,
              uniqueToolBoundariesByCallId,
              toolRunId,
              toolCallId,
            )
          : undefined,
        toolCallId
          ? resolveScopedValue(
              toolAfterBoundariesByIdentity,
              uniqueToolAfterBoundariesByCallId,
              toolRunId,
              toolCallId,
            )
          : undefined,
      );
    }
  }
  for (const segment of keyedSegments) {
    const text = sanitizeStreamText(segment.text);
    if (text.length === 0) {
      continue;
    }
    const commentaryItem: ChatItem = {
      kind: "stream",
      key: `stream-seg:${props.sessionKey}:${segment.itemId}`,
      text,
      startedAt: segment.ts,
      isStreaming: false,
    };
    timestampedProjectionItems.push(commentaryItem);
    applyRunBounds(
      commentaryItem.key,
      segment.runId,
      segment.boundaryRunId,
      afterBoundaryBySegment.get(segment),
    );
  }

  for (const prompt of props.questionPrompts ?? []) {
    // Pending questions live in the composer dock. Their terminal summaries are
    // timestamped transient projections, so keep their historical placement.
    if (
      prompt.status === "pending" ||
      !prompt.sessionKey ||
      !areUiSessionKeysEquivalent(prompt.sessionKey, props.sessionKey)
    ) {
      continue;
    }
    const questionItem: ChatItem = {
      kind: "question",
      key: `question:${prompt.id}`,
      questionId: prompt.id,
      startedAt: prompt.createdAtMs,
    };
    timestampedProjectionItems.push(questionItem);
    if (prompt.runId) {
      applyRunBounds(questionItem.key, prompt.runId);
    }
  }

  // Merge timestamped transient projections into the stable transcript order.
  // The latest user row is a causal floor: current-run items must not jump
  // above it under clock skew, then jump back when history materializes them.
  insertChatItemsByTimestamp(
    items,
    timestampedProjectionItems,
    projectionInsertionBounds,
    toolStreamPredecessors,
  );

  // The active claw is telemetry, not a placeholder: it stays through visible
  // assistant text and tool cards until the run settles. The initial-load
  // skeleton still owns an otherwise empty thread, but not an active stream.
  const initialHistoryLoad = props.stream === null && props.loading === true && items.length === 0;
  // A non-null empty stream is the acknowledgement bridge before runWorking
  // catches up.
  const hasEmptyLiveStream = props.stream !== null && props.stream.trim().length === 0;
  const showWorkingIndicator =
    (props.runWorking === true && !initialHistoryLoad) ||
    hasEmptyLiveStream ||
    queuedSends.some(
      (item) => item.sendState === "sending" && shouldRenderQueuedSendInThread(item),
    );
  if (props.runWorking !== true && props.stream === null && !showWorkingIndicator) {
    clearWorkingProgress(props.sessionKey);
  }
  let progress: ReturnType<typeof resolveWorkingProgress> | null = null;
  const resolveProgress = () =>
    (progress ??= resolveWorkingProgress(
      props.sessionKey,
      props.runId ?? null,
      props.streamStartedAt,
      queuedSends,
      segments,
      tools,
    ));
  if (props.stream !== null) {
    const text = sanitizeStreamText(props.stream);
    const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
    if (visibleText.length > 0 && !stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
      const liveProgress = resolveProgress();
      const liveStreamItem: ChatItem = {
        kind: "stream",
        key: latestBoundaryRunId
          ? `${liveProgress.key}:after:${latestBoundaryRunId}`
          : liveProgress.key,
        text: visibleText,
        startedAt: timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now()),
        isStreaming: true,
      };
      const liveTurnRunId = latestBoundaryRunId ?? normalizeOptionalString(props.runId);
      const liveTurnBounds = liveTurnRunId ? findRunTurnBounds(items, liveTurnRunId) : null;
      if (liveTurnBounds) {
        const { maximum } = insertionIndexesForBounds(items, liveTurnBounds);
        items.splice(maximum, 0, liveStreamItem);
      } else {
        items.push(liveStreamItem);
      }
    }
  }
  if (showWorkingIndicator) {
    items.push({ kind: "reading-indicator", ...resolveProgress() });
  }
  // Future queued turns are a causal ceiling for every current-run projection.
  // Append them after tools, streams, progress, and prompts so none can cross the
  // next user turn when a live item becomes stable transcript history.
  for (const queued of futureQueuedSends) {
    appendQueuedSend(queued);
  }

  return groupMessages(collapseSequentialDuplicateMessages(coalesceToolActivityMessages(items)));
}
