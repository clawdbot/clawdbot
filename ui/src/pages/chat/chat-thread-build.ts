import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatItem, ChatQueueItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import {
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
  clearWorkingProgress,
  resolveWorkingProgress,
  shouldRenderQueuedSendInThread,
} from "./chat-progress.ts";
import {
  annotateToolTurnOutcome,
  coalesceToolActivityMessages,
  groupMessages,
  isKeyedAssistantStreamFallbackMessage,
} from "./chat-thread-grouping.ts";
import {
  appendCanvasBlockToAssistantMessage,
  buildMessageKeys,
  canvasPreviewBaseIdentity,
  chatItemTimestamp,
  collapseSequentialDuplicateMessages,
  createCanvasAssistantMessage,
  extractChatMessagePreview,
  findCanvasInsertionIndex,
  findNearestAssistantMessageIndex,
  hasRenderableNormalizedMessage,
  messageKey,
  messageMatchesSearchQuery,
  queuedSendThreadMessage,
  rawMessageTimestamp,
  safeNormalizeMessage,
  sanitizeStreamText,
  sortChatItemsByVisibleTime,
  timestampAfterVisibleItems,
  transcriptPositionTimestamp,
  turnHasMatchingAssistant,
} from "./chat-thread-items.ts";
import { chatMessagesContainQueuedSend } from "./steer-lifecycle.ts";
import type { PlanStatus } from "./tool-stream.ts";

export type BuildChatItemsProps = {
  paneId: string;
  sessionKey: string;
  runId?: string | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** Keeps the status row visible while a running tool is parked for approval. */
  waitingApproval?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  planStatus?: PlanStatus | null;
  questionPrompts?: readonly QuestionPrompt[];
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
};

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const history = props.messages.filter(
    (message) =>
      !isAssistantHeartbeatAckForDisplay(message) &&
      (props.persistCommentary !== false || !isKeyedAssistantStreamFallbackMessage(message)),
  );
  const tools = props.toolMessages.filter((message) => asRecord(message) !== null);
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
    const msg = history[i];
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
  const activeRunQueuedSends = threadQueuedSends.filter(
    (queued) => queued.sendState === "waiting-model",
  );
  const futureQueuedSends = threadQueuedSends.filter(
    (queued) => queued.sendState !== "waiting-model",
  );
  const futureQueuedTimestamp = futureQueuedSends.reduce<number | null>(
    (earliest, queued) =>
      earliest == null ? queued.createdAt : Math.min(earliest, queued.createdAt),
    null,
  );
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
    items.push({
      kind: "message",
      // Mirror buildMessageKeys for a send-identity source key so the pending
      // row and its history successor resolve to the same Lit key.
      key: queued.sendRunId ? `msg:send:${queued.sendRunId}:0` : `pending-send:${queued.id}`,
      message,
    });
  };
  for (const queued of activeRunQueuedSends) {
    appendQueuedSend(queued);
  }
  for (const liftedCanvasSource of liftedCanvasSources) {
    const baseIdentity = canvasPreviewBaseIdentity(liftedCanvasSource.message, liftedCanvasSource);
    if (baseIdentity && persistedCanvasIdentities.has(baseIdentity)) {
      continue;
    }
    const assistantIndex = findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
    if (assistantIndex == null) {
      if (searchFiltering) {
        continue;
      }
      const insertionIndex = findCanvasInsertionIndex(items, liftedCanvasSource.timestamp);
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
  for (const queued of futureQueuedSends) {
    appendQueuedSend(queued);
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const segments = props.streamSegments;
  const keyedSegments = segments.filter(streamSegmentHasItemId);
  const indexedSegments = segments.filter((segment) => !streamSegmentHasItemId(segment));
  const toolItems = tools.map((message, index) => ({
    key: toolKeys[index] ?? messageKey(message, index + history.length),
    message,
  }));
  const toolKeysByCallId = new Map<string, string>();
  for (const tool of toolItems) {
    const toolCallId = asRecord(tool.message)?.toolCallId;
    if (typeof toolCallId === "string" && toolCallId.trim()) {
      toolKeysByCallId.set(toolCallId.trim(), tool.key);
    }
  }
  const maxLen = Math.max(indexedSegments.length, tools.length);
  let previousAccumulatedStreamText: string | null = null;
  const toolStreamPredecessors = new Map<string, string>();
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
      if (usesAccumulatedText && text.length > 0) {
        previousAccumulatedStreamText = text;
      }
      if (visibleText.length > 0) {
        const streamKey = `stream-seg:${props.sessionKey}:${i}`;
        items.push({
          kind: "stream",
          key: streamKey,
          text: visibleText,
          startedAt: segment.ts,
          isStreaming: false,
        });
        const toolCallId = segment.toolCallId?.trim();
        const toolKey = toolCallId ? toolKeysByCallId.get(toolCallId) : undefined;
        if (toolKey) {
          // Gateway and browser clocks can disagree. Keep the assistant text that
          // introduced a tool causally before its card even when timestamps do not.
          toolStreamPredecessors.set(toolKey, streamKey);
        }
      }
    }
    const tool = toolItems[i];
    if (tool && props.showToolCalls) {
      items.push({
        kind: "message",
        key: tool.key,
        message: tool.message,
      });
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
    // Merge keyed commentary into the timestamp ordering path instead of
    // appending it after every tool card. Insert before the first already-built
    // item whose visible timestamp is strictly later, so a preamble that
    // arrived before a later tool renders above that tool while the run is live
    // (not only after final materialization). Tools that share the commentary's
    // timestamp and are already visible stay above it.
    const insertionIndex = items.findIndex((existing) => {
      const existingTimestamp = chatItemTimestamp(existing);
      return existingTimestamp != null && existingTimestamp > segment.ts;
    });
    if (insertionIndex === -1) {
      items.push(commentaryItem);
    } else {
      items.splice(insertionIndex, 0, commentaryItem);
    }
  }

  // Working spark contract: whenever the agent works with nothing visibly
  // streaming (pre-first-token, or a queued send in flight), the thread shows
  // the reading indicator where the reply will materialize. Streaming text
  // and running tool rows take over as the signal once content flows.
  // A visible running tool row already signals active work, so the spark is
  // suppressed rather than stacked under it; hidden tool calls keep the spark.
  const hasVisibleRunningTool =
    props.showToolCalls &&
    tools.some((message) => {
      const record = asRecord(message);
      return (
        record?.["__openclawToolStreamLive"] === true &&
        record["__openclawToolStreamResultReceived"] !== true
      );
    });
  // The initial-load skeleton owns the empty thread; a background reload with
  // content still visible keeps the spark (it is the only working signal).
  const initialHistoryLoad = props.loading === true && items.length === 0;
  const hasPendingResponse =
    props.stream === null &&
    ((props.runWorking === true &&
      (props.waitingApproval === true || !hasVisibleRunningTool) &&
      !initialHistoryLoad) ||
      queuedSends.some(
        (item) => item.sendState === "sending" && shouldRenderQueuedSendInThread(item),
      ));
  if (props.runWorking !== true && props.stream === null && !hasPendingResponse) {
    clearWorkingProgress(props.sessionKey);
  }
  const resolveProgress = () =>
    resolveWorkingProgress(
      props.sessionKey,
      props.runId ?? null,
      props.streamStartedAt,
      queuedSends,
      segments,
      tools,
    );
  if (hasPendingResponse) {
    const progress = resolveProgress();
    items.push({ kind: "reading-indicator", ...progress });
  } else if (props.stream !== null) {
    const text = sanitizeStreamText(props.stream);
    const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
    if (visibleText.length > 0) {
      if (!stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
        const progress = resolveProgress();
        items.push({
          kind: "stream",
          key: progress.key,
          text: visibleText,
          startedAt: timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now()),
          isStreaming: true,
        });
      }
    } else if (props.stream.trim().length === 0) {
      const progress = resolveProgress();
      items.push({ kind: "reading-indicator", ...progress });
    }
  }
  if (props.runActive === true && props.planStatus && props.planStatus.steps.length > 0) {
    items.push({ kind: "plan", key: `plan:${props.sessionKey}:active` });
  }
  for (const prompt of props.questionPrompts ?? []) {
    // Pending questions live in the composer dock. Only their terminal summary becomes transcript.
    if (
      prompt.status === "pending" ||
      !prompt.sessionKey ||
      !areUiSessionKeysEquivalent(prompt.sessionKey, props.sessionKey)
    ) {
      continue;
    }
    items.push({
      kind: "question",
      key: `question:${prompt.id}`,
      questionId: prompt.id,
      startedAt: prompt.createdAtMs,
    });
  }

  return annotateToolTurnOutcome(
    groupMessages(
      collapseSequentialDuplicateMessages(
        coalesceToolActivityMessages(sortChatItemsByVisibleTime(items, toolStreamPredecessors)),
      ),
    ),
  );
}
