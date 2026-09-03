import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { t } from "../../i18n/index.ts";
import {
  type ChatGuardianNotice,
  type ChatItem,
  type ChatQueueItem,
  type MessageGroup,
  accumulatedStreamText,
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
import { buildPendingInputItems } from "./chat-pending-inputs.ts";
import {
  buildCompactionDividerItem,
  buildGuardianNoticeItem,
  buildResetDividerItem,
  clearWorkingProgress,
  isContextCompactionMessage,
  matchesCompactionOperation,
  resolveWorkingProgress,
  shouldRenderQueuedSendInThread,
} from "./chat-progress.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import {
  appendCanvasBlockToAssistantMessage,
  buildMessageItems,
  canvasPreviewBaseIdentity,
  createCanvasAssistantMessage,
  extractChatMessagePreview,
  findCanvasInsertionIndex,
  findNearestAssistantMessage,
  hasRenderableNormalizedMessage,
  insertionIndexesForBounds,
  type ChatProjection,
  messageMatchesSearchQuery,
  queuedSendThreadMessage,
  rawMessageTimestamp,
  insertChatItemsByTimestamp,
  sanitizeStreamText,
  timestampAfterVisibleItems,
  transcriptPositionTimestamp,
  turnHasMatchingAssistant,
  type TurnInsertionBounds,
  userTurnRunId,
} from "./chat-thread-items.ts";
import {
  applyPersistedToolInvocationBounds,
  findCurrentTurnBounds,
  createRunTurnLookup,
  createToolCallLookup,
  isKeyedAssistantStreamFallbackMessage,
  optionalBoundaryIdentity,
  optionalRunIdentity,
  resolveRunInsertionBounds,
} from "./chat-thread-run-identity.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { selectChatInputDisplay } from "./history-merge.ts";
import { resolveSystemNoticeKind } from "./system-notice-kinds.ts";
import { isLiveTerminalForRun } from "./terminal-message-identity.ts";
import type { CompactionStatus } from "./tool-stream-contract.ts";

export type BuildChatItemsProps = {
  paneId: string;
  sessionKey: string;
  archiveNotice?: Extract<ChatItem, { kind: "notice" }>;
  runId?: string | null;
  compactionStatus?: CompactionStatus | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  guardianNotices?: ChatGuardianNotice[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  pendingInputs?: ChatPendingInputsPage["items"];
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

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const tools = props.toolMessages.filter(
    (message): message is Record<string, unknown> => asRecord(message) !== null,
  );
  const toolItems = buildMessageItems(tools).map((item) => {
    const projection: ChatProjection<typeof item> = { item };
    return {
      projection,
      runId: normalizeOptionalString(item.message.runId),
      callId: normalizeOptionalString(item.message.toolCallId),
      preview: extractChatMessagePreview(item.message),
    };
  });
  const history = composeTranscriptDisplay(
    props.messages.filter(
      (message) =>
        !isAssistantHeartbeatAckForDisplay(message) &&
        (props.persistCommentary !== false || !isKeyedAssistantStreamFallbackMessage(message)),
    ),
  );
  const searchFiltering = props.searchOpen === true && Boolean(props.searchQuery?.trim());
  const persistedCanvasIdentities = new Set<string>();
  const compaction = props.compactionStatus;
  const compactionKey = compaction
    ? `divider:compaction:live:${compaction.runId}:${compaction.itemId ?? "manual"}`
    : undefined;
  let hasPersistedCompaction = false;
  for (const [i, item] of buildMessageItems(history).entries()) {
    const msg = item.message;
    const itemKey = item.key;
    const raw = asRecord(msg) ?? {};
    const marker = asRecord(raw["__openclaw"]);
    if (marker?.kind === "compaction" || isContextCompactionMessage(msg)) {
      const matchesLive = compaction != null && matchesCompactionOperation(msg, compaction);
      const divider = buildCompactionDividerItem(
        marker ?? {},
        rawMessageTimestamp(msg) ?? Date.now(),
        i,
      );
      items.push({
        ...divider,
        compactionId: divider.key,
        ...(matchesLive && compactionKey ? { key: compactionKey } : {}),
      });
      hasPersistedCompaction ||= matchesLive;
      continue;
    }
    const normalized = safeNormalizeMessage(msg);
    if (!normalized) {
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
    if (persistedCanvasSource) {
      const identity = canvasPreviewBaseIdentity(msg, persistedCanvasSource);
      if (identity) {
        persistedCanvasIdentities.add(identity);
      }
    }
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
    if (
      !hasRenderableNormalizedMessage(msg, normalized) &&
      normalized.role.toLowerCase() !== "assistant"
    ) {
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
          ...(noticeKind?.startsTurn === false ? {} : { startsTurn: true }),
          ...(noticeKind?.collapsedBody ? { collapsedBody: true } : {}),
          text,
          timestamp: normalized.timestamp,
          ...optionalBoundaryIdentity(userTurnRunId(msg)),
        });
      }
      continue;
    }

    items.push(item);
  }
  const queuedSends = props.queue ?? [];
  const { queue: threadQueuedSends, pendingInputs } = selectChatInputDisplay(
    history,
    queuedSends,
    props.pendingInputs ?? [],
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
  // Transient projections merge into stable history + queued-send rows by timestamp.
  // Stable rows keep their relative order despite client and Gateway clock skew.
  const projections: ChatProjection[] = buildPendingInputItems(
    pendingInputs,
    props.searchOpen ? props.searchQuery : undefined,
  ).map((item) => ({ item }));
  if (compaction && compactionKey && !hasPersistedCompaction) {
    const timestamp = compaction.startedAt ?? compaction.completedAt ?? Date.now();
    projections.push({
      item: {
        ...buildCompactionDividerItem(
          {},
          timestamp,
          0,
          compaction.phase === "complete" ? "complete" : "active",
        ),
        key: compactionKey,
      },
    });
  }
  const appendQueuedSend = (queued: ChatQueueItem) => {
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
    const runId = queued.sendRunId;
    // Reconnect can deliver a saved reply before history recovers its user row.
    // Anchor to the first rendered owned output even after the local run clears;
    // hidden/imported rows cannot anchor, and unmatched future sends stay last.
    const insertionIndex = items.findIndex((item) => {
      if (!runId || item.kind !== "message") {
        return false;
      }
      const identity = readSessionMessageIdentity(item.message);
      return (
        isLiveTerminalForRun(item.message, runId) ||
        (identity?.role === "assistant" && !identity.isImported && identity.runId === runId)
      );
    });
    items.splice(insertionIndex < 0 ? items.length : insertionIndex, 0, {
      kind: "message",
      key: queued.sendRunId ? buildMessageItems([message])[0]!.key : `pending-send:${queued.id}`,
      message,
    });
  };
  for (const queued of currentRunQueuedSends) {
    appendQueuedSend(queued);
  }
  const currentTurnBounds = findCurrentTurnBounds(items);
  const canvasRunBounds = createRunTurnLookup(items);
  for (const { projection, preview } of toolItems) {
    if (!preview) {
      continue;
    }
    const baseIdentity = canvasPreviewBaseIdentity(projection.item.message, preview);
    if (baseIdentity && persistedCanvasIdentities.has(baseIdentity)) {
      continue;
    }
    const canvasBounds = resolveRunInsertionBounds(
      canvasRunBounds,
      projection.item.message.runId,
      props.runId,
      currentTurnBounds,
    );
    const { minimum: canvasMinimumIndex, maximum: canvasMaximumIndex } = insertionIndexesForBounds(
      items,
      canvasBounds ?? undefined,
    );
    const assistant = findNearestAssistantMessage(
      items,
      preview.timestamp,
      canvasMinimumIndex,
      canvasMaximumIndex,
    );
    if (assistant) {
      items[assistant.index] = {
        ...assistant.item,
        message: appendCanvasBlockToAssistantMessage(
          assistant.item.message,
          preview.preview,
          preview.text,
        ),
      };
      continue;
    }
    if (searchFiltering) {
      continue;
    }
    const insertionIndex = findCanvasInsertionIndex(
      items,
      preview.timestamp,
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
      preview.timestamp != null && boundaryTimestamp != null
        ? Math.min(preview.timestamp, boundaryTimestamp)
        : preview.timestamp;
    // Canvas previews are positioned relative to the queued-send tail that
    // existed when they were lifted, so they stay in the stable row order
    // rather than being re-sorted with live stream/tool cards.
    items.splice(insertionIndex, 0, {
      kind: "message",
      key: `${projection.item.key}:canvas`,
      message: createCanvasAssistantMessage(preview, timestamp),
    });
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
  const toolLookup = createToolCallLookup<ChatProjection>();
  for (const tool of toolItems) {
    toolLookup.add(tool.runId, tool.callId, tool.projection);
  }
  // Empty user rows may have disappeared since canvas placement. Preserve the
  // earlier current-turn fallback, but resolve exact bounds over rendered rows.
  const projectionRunBounds = createRunTurnLookup(items);
  const resolveProjectionBounds = (
    runId: unknown,
    boundaryRunId?: string,
    afterBoundaryRunId?: string,
  ): TurnInsertionBounds | undefined => {
    const bounds = resolveRunInsertionBounds(
      projectionRunBounds,
      runId,
      props.runId,
      currentTurnBounds,
    );
    const boundaryKey = boundaryRunId ? projectionRunBounds(boundaryRunId)?.afterKey : undefined;
    const afterBounds = afterBoundaryRunId ? projectionRunBounds(afterBoundaryRunId) : undefined;
    return bounds || boundaryKey || afterBounds
      ? {
          ...bounds,
          ...(afterBounds?.afterKey ? { afterKey: afterBounds.afterKey } : {}),
          ...(afterBounds?.beforeKey ? { beforeKey: afterBounds.beforeKey } : {}),
          ...(boundaryKey ? { beforeKey: boundaryKey } : {}),
        }
      : undefined;
  };
  if (!searchFiltering) {
    if (props.archiveNotice) {
      projections.push({ item: props.archiveNotice });
    }
    for (const notice of props.guardianNotices ?? []) {
      projections.push({
        item: buildGuardianNoticeItem(notice),
        bounds: resolveProjectionBounds(notice.runId),
      });
    }
  }
  const toolBeforeBoundaries = createToolCallLookup<string>();
  const toolAfterBoundaries = createToolCallLookup<string>();
  for (const segment of indexedSegments) {
    const callId = normalizeOptionalString(segment.toolCallId);
    const runId = normalizeOptionalString(segment.runId);
    const boundaryRunId = normalizeOptionalString(segment.boundaryRunId);
    const afterBoundaryRunId = afterBoundaryBySegment.get(segment);
    if (boundaryRunId) {
      toolBeforeBoundaries.add(runId, callId, boundaryRunId);
    }
    if (afterBoundaryRunId) {
      toolAfterBoundaries.add(runId, callId, afterBoundaryRunId);
    }
  }
  const appendStreamSegment = (segment: ChatStreamSegment, key: string, text: string) => {
    const afterBoundaryRunId = afterBoundaryBySegment.get(segment);
    projections.push({
      item: {
        kind: "stream",
        key,
        text,
        startedAt: segment.ts,
        isStreaming: false,
        ...optionalRunIdentity(segment.runId),
        ...optionalBoundaryIdentity(afterBoundaryRunId ?? segment.runId),
      },
      bounds: resolveProjectionBounds(segment.runId, segment.boundaryRunId, afterBoundaryRunId),
    });
  };
  let previousAccumulatedStreamText: string | null = null;
  const maxLen = Math.max(indexedSegments.length, toolItems.length);
  for (let i = 0; i < maxLen; i++) {
    const segment = indexedSegments[i];
    if (segment) {
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
      if (visibleText.length > 0 && segment.persisted !== true) {
        const streamKey = `stream-seg:${props.sessionKey}:${i}`;
        appendStreamSegment(segment, streamKey, visibleText);
        const tool = toolLookup.get(
          normalizeOptionalString(segment.runId),
          segment.toolCallId?.trim(),
        );
        if (tool) {
          // Gateway and browser clocks can disagree. Keep the assistant text that
          // introduced a tool causally before its card even when timestamps do not.
          tool.predecessorKey = streamKey;
        }
      }
    }
    const tool = toolItems[i];
    if (tool && props.showToolCalls) {
      const before = toolBeforeBoundaries.get(tool.runId, tool.callId);
      const after = toolAfterBoundaries.get(tool.runId, tool.callId);
      tool.projection.bounds = resolveProjectionBounds(tool.runId, before, after);
      projections.push(tool.projection);
    }
  }
  // Keyed commentary does not advance cumulative text and follows the indexed
  // stream/tool pairs on timestamp ties.
  for (const segment of keyedSegments) {
    const text = sanitizeStreamText(segment.text);
    if (text.length > 0) {
      appendStreamSegment(segment, `stream-seg:${props.sessionKey}:${segment.itemId}`, text);
    }
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
    projections.push({
      item: questionItem,
      bounds: prompt.runId ? resolveProjectionBounds(prompt.runId) : undefined,
    });
  }

  // Unowned projections keep their user-turn floor despite clock skew;
  // identified live tools stay in the canonical invocation's interval.
  applyPersistedToolInvocationBounds(
    items,
    toolItems.map((tool) => tool.projection),
  );
  insertChatItemsByTimestamp(items, projections);

  // The active claw is telemetry, not a placeholder: it stays through visible
  // assistant text and tool cards until the run settles. The initial-load
  // skeleton still owns an otherwise empty thread, but not an active stream.
  const initialHistoryLoad = props.stream === null && props.loading === true && items.length === 0;
  // A non-null empty stream is the acknowledgement bridge before runWorking
  // catches up.
  const hasEmptyLiveStream = props.stream !== null && props.stream.trim().length === 0;
  const showWorkingIndicator =
    (!compaction || compaction.phase === "complete") &&
    ((props.runWorking === true && !initialHistoryLoad) ||
      hasEmptyLiveStream ||
      queuedSends.some(
        (item) => item.sendState === "sending" && shouldRenderQueuedSendInThread(item),
      ));
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
    const prefix = accumulatedStreamText(segments, sanitizeStreamText);
    const visibleText = trimAccumulatedStreamPrefix(text, prefix);
    if (visibleText.length > 0 && !stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
      const liveProgress = resolveProgress();
      const liveRunId = props.runId ?? liveProgress.runId;
      const liveStreamItem: ChatItem = {
        kind: "stream",
        key: latestBoundaryRunId
          ? `${liveProgress.key}:after:${latestBoundaryRunId}`
          : liveProgress.key,
        text: visibleText,
        startedAt: timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now()),
        isStreaming: true,
        ...optionalRunIdentity(liveRunId),
        ...optionalBoundaryIdentity(latestBoundaryRunId ?? liveRunId),
      };
      const liveTurnRunId = latestBoundaryRunId ?? normalizeOptionalString(props.runId);
      // Pending-custody user rows now participate in the live tail's ceiling.
      const liveTurnBounds = liveTurnRunId ? createRunTurnLookup(items)(liveTurnRunId) : null;
      if (liveTurnBounds) {
        const { maximum } = insertionIndexesForBounds(items, liveTurnBounds);
        items.splice(maximum, 0, liveStreamItem);
      } else {
        items.push(liveStreamItem);
      }
    }
  }
  if (showWorkingIndicator) {
    const workingProgress = resolveProgress();
    const workingRunId = props.runId ?? workingProgress.runId;
    items.push({
      kind: "reading-indicator",
      key: workingProgress.key,
      startedAt: workingProgress.startedAt,
      ...optionalRunIdentity(workingRunId),
      ...optionalBoundaryIdentity(latestBoundaryRunId ?? workingRunId),
    });
  }
  // Unmatched future turns stay after all current-run projections as a causal
  // ceiling. A known same-run reply instead anchors its already-attempted prompt.
  for (const queued of futureQueuedSends) {
    appendQueuedSend(queued);
  }

  return groupMessages(coalesceToolActivityMessages(items));
}
