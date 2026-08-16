// Chat-item projection, expansion, reply hydration, and guarded row rendering.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { classifySessionKind } from "../../../../../src/sessions/classify-session-kind.js";
import { i18n } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../../lib/sessions/session-key.ts";
import { resolveTurnRecap, type TurnRecap } from "../chat-progress.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  assistantMessageExpansionSignature,
  buildCachedChatItems,
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpansionStateVersion,
  getExpandedAssistantMessages,
  getExpandedToolCards,
  getExpandedUserMessages,
  persistedMessageEntryId,
  setExpansionState,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { getToolTitlesVersion } from "../tool-titles.ts";
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import { renderChatDivider, renderChatNotice } from "./chat-divider.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-group.ts";
import { resolveMessageReplyText } from "./chat-message-markdown.ts";
import {
  getChatMediaRenderVersion,
  renderActivityGroup,
  renderMessageGroup,
  renderStreamGroup,
  renderWorkGroupSummary,
  type MessageReplyTarget,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import {
  closeTranscriptSearch,
  getTranscriptState,
  type ChatThreadProps,
  type ChatThreadState,
} from "./chat-thread-interactions.ts";
import type {
  ChatTranscriptSession,
  TranscriptAnnouncement,
  TranscriptRow,
} from "./chat-transcript-controller.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

type ChatTranscriptProjection = {
  isDirectThread: boolean;
  isEmpty: boolean;
  showLoadingSkeleton: boolean;
  searchOpen: boolean;
  renderRows: (overlay?: unknown) => TemplateResult;
};

type ChatRenderItem = ReturnType<typeof coalesceActivityRuns>[number];
const CHAT_TRANSCRIPT_ANNOUNCEMENT_MAX_CHARS = 500;

type LoadedReplySource = {
  rowKey: string;
  preview: MessageReplyTarget & { sourceMessageId: string };
};

function projectResolvedReplyPreview(
  message: unknown,
  replyToId: string,
  props: Pick<ChatThreadProps, "assistantName" | "userAvatar" | "userId" | "userName">,
): LoadedReplySource["preview"] | undefined {
  const normalized = normalizeMessage(message);
  const text = resolveMessageReplyText(message);
  if (!text) {
    return undefined;
  }
  const group: MessageGroup = {
    kind: "group",
    key: replyToId,
    role: normalized.role,
    senderLabel: normalized.senderLabel,
    ...(normalized.sender ? { sender: normalized.sender } : {}),
    messages: [{ key: replyToId, message }],
    timestamp: normalized.timestamp,
    isStreaming: false,
  };
  const sourceMessageId = persistedMessageEntryId(message) ?? replyToId;
  return {
    messageId: sourceMessageId,
    sourceMessageId,
    senderLabel: resolveMessageGroupSenderLabel(group, props),
    text,
  };
}

function latestTranscriptAnnouncement(
  items: readonly ChatRenderItem[],
): TranscriptAnnouncement | null {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (!item || item.kind !== "group" || item.role.toLowerCase() !== "assistant") {
      continue;
    }
    for (let messageIndex = item.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = item.messages[messageIndex]?.message;
      const text = extractTextCached(message)?.trim();
      if (text) {
        return {
          key: item.key,
          text: truncateUtf16Safe(text, CHAT_TRANSCRIPT_ANNOUNCEMENT_MAX_CHARS),
        };
      }
    }
  }
  return null;
}

function chatRenderItemGuardDependencies(item: ChatRenderItem): readonly unknown[] {
  if (item.kind === "stream-run") {
    return [item.key, ...item.parts];
  }
  if (item.kind === "work-group") {
    return [item.key, item.durationMs, ...item.groups];
  }
  if (item.kind === "activity-run") {
    return [item.key, ...item.groups];
  }
  return [item];
}

function trackTranscriptRenderDependencies(
  state: ChatThreadState,
  dependencies: unknown[],
): unknown[] {
  const previous = state.transcriptRenderDependencies;
  const nextLength = dependencies.length - 1;
  let changed = previous.length !== nextLength;
  for (let index = 0; !changed && index < nextLength; index += 1) {
    changed = !Object.is(previous[index], dependencies[index + 1]);
  }
  if (changed) {
    // The first dependency is chatItems. Keep the shared context stable when
    // only the live row changes, but invalidate every row for presentation changes.
    state.transcriptRenderDependencies = dependencies.slice(1);
    state.transcriptRenderContext = {};
  }
  return dependencies;
}

function guardChatRenderItems(
  state: ChatThreadState,
  // Live run status is not derivable from a row's own item identity: ownership
  // is decided by sibling rows, and the usage counter ticks on run patches that
  // touch nothing else. Rows showing status must re-render on both, or the
  // memoized copy stacks a second claw row or freezes the token count.
  liveStatus: (item: ChatRenderItem) => string,
  render: (item: ChatRenderItem) => unknown,
) {
  return (item: ChatRenderItem) =>
    guard(
      [...chatRenderItemGuardDependencies(item), state.transcriptRenderContext, liveStatus(item)],
      () => render(item),
    );
}

export function projectChatTranscript(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
): ChatTranscriptProjection {
  const state = getTranscriptState(props.paneId);
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const displayStream = props.stream ?? null;
  const sessionHost = props.sessionHost ?? null;
  // Equivalence, not exact match: the default session travels under alias
  // keys ("main" vs "agent:main:main") depending on the caller.
  const activeSession = props.sessions?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, props.sessionKey),
  );
  // Global-alias detection needs no session row: under configured global
  // scope, agent:<id>:global and configured-main aliases route to the global
  // stream even when the capped sessions list omits the canonical row (or it
  // does not exist yet). The scope gate keeps per-sender main threads direct.
  const isGlobalAliasKey =
    parseAgentSessionKey(props.sessionKey)?.rest === "global" ||
    (sessionHost !== null &&
      isUiGlobalScopeConfigured(sessionHost) &&
      resolveUiGlobalAliasAgentId(sessionHost, props.sessionKey) !== null);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: resolveAssistantDisplayAvatar(props),
  };
  const locale = i18n.getLocale();
  const searchFiltering = state.searchOpen && Boolean(state.searchQuery.trim());
  const chatItems = buildCachedChatItems({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    runId: props.runId === undefined ? (activeSession?.activeRunIds?.[0] ?? null) : props.runId,
    locale,
    messages: props.messages,
    toolMessages: props.toolMessages,
    streamSegments: props.streamSegments,
    stream: displayStream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    showToolCalls: props.showToolCalls,
    persistCommentary: props.persistCommentary,
    runWorking: Boolean(props.runWorking),
    runActive: Boolean(props.runActive),
    planStatus: props.planStatus,
    questionPrompts: props.questionPrompts,
    loading: props.loading,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
  });
  syncToolCardExpansionState(
    props.sessionKey,
    chatItems,
    Boolean(props.autoExpandToolCalls),
    searchFiltering || !props.showToolCalls,
  );
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const expandedUserMessages = getExpandedUserMessages(props.sessionKey);
  const expandedAssistantMessages = getExpandedAssistantMessages(props.sessionKey);
  const questionPrompts = new Map(
    (props.questionPrompts ?? []).map((prompt) => [prompt.id, prompt]),
  );
  const toggleToolCardExpanded = (toolCardId: string) => {
    setExpansionState(expandedToolCards, toolCardId, !expandedToolCards.get(toolCardId));
    requestUpdate();
  };
  const toggleAssistantMessageExpanded = (messageId: string) => {
    const current = expandedAssistantMessages.get(messageId);
    const loader = props.loadFullAssistantMessage;
    if (!loader || current?.status === "loading") {
      return;
    }
    const revision = (current?.revision ?? 0) + 1;
    expandedAssistantMessages.set(messageId, { status: "loading", revision });
    requestUpdate();
    void loader({
      sessionKey: props.sessionKey,
      ...(props.fullMessageAgentId ? { agentId: props.fullMessageAgentId } : {}),
      messageId,
      kind: "assistant_message",
    }).then(
      (result) => {
        const pending = expandedAssistantMessages.get(messageId);
        if (pending?.status !== "loading" || pending.revision !== revision) {
          return;
        }
        const markdown =
          result?.ok && result.message && typeof result.message === "object"
            ? extractTextCached(result.message)
            : null;
        expandedAssistantMessages.set(
          messageId,
          markdown === null
            ? { status: "error", revision: revision + 1 }
            : { status: "loaded", markdown, revision: revision + 1 },
        );
        requestUpdate();
      },
      () => {
        const pending = expandedAssistantMessages.get(messageId);
        if (pending?.status !== "loading" || pending.revision !== revision) {
          return;
        }
        expandedAssistantMessages.set(messageId, { status: "error", revision: revision + 1 });
        requestUpdate();
      },
    );
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const isEmpty = chatItems.length === 0 && !props.loading && !hasRealtimeTalkConversation;
  transcript.setContentReady(!props.loading);
  // 1:1 sessions drop the avatar gutter entirely; group threads keep avatars
  // as the always-visible identity marker. The canonical session kind decides;
  // the sessions list is capped, so absent/unknown rows classify by key:
  // global aliases first, then the same core key-shape helper the gateway
  // uses. Message senderLabels are not a signal here: gateway sanitization
  // labels 1:1 channel DM rows too.
  const rowKind = activeSession?.kind;
  const sessionKind =
    rowKind && rowKind !== "unknown"
      ? rowKind
      : isGlobalAliasKey
        ? "global"
        : classifySessionKind(props.sessionKey);
  // Only agent-solo kinds qualify: "global" aggregates every inbound context
  // under session.scope="global" (including group/channel senders), so it
  // keeps avatars like "group" and "unknown" do. An identity-resolving gateway
  // (multi-user trusted proxy) also keeps them: several people share these
  // sessions, so the author marker is signal, not decoration.
  const isDirectThread =
    (sessionKind === "direct" || sessionKind === "cron" || sessionKind === "spawn-child") &&
    !props.userId;
  const showLoadingSkeleton = props.loading && chatItems.length === 0;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const activeContinuationByGroupKey = new Map<
    string,
    { parts: StreamGroupPart[]; options: StreamGroupOptions }
  >();
  const turnRecapByGroupKey = new Map<string, TurnRecap>();
  const loadedReplySources = new Map<string, LoadedReplySource>();
  const resolvedReplyPreviews = new Map<string, LoadedReplySource["preview"] | undefined>();
  const resolveReplyPreview = (replyToId: string) => {
    const loaded = loadedReplySources.get(replyToId)?.preview;
    if (loaded) {
      return loaded;
    }
    if (resolvedReplyPreviews.has(replyToId)) {
      return resolvedReplyPreviews.get(replyToId);
    }
    const message = props.replyMessageAccess?.read(replyToId);
    const preview = message ? projectResolvedReplyPreview(message, replyToId, props) : undefined;
    resolvedReplyPreviews.set(replyToId, preview);
    return preview;
  };
  const sharedMessageRenderOptions = {
    onOpenSidebar: props.onOpenSidebar,
    sessionKey: props.sessionKey,
    boardProvider: props.boardProvider,
    agentId: props.fullMessageAgentId,
    runActive: props.runActive,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    onRequestUpdate: requestUpdate,
    basePath: props.basePath,
    localMediaPreviewRoots: props.localMediaPreviewRoots ?? [],
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
    resolveArtifactDownload: props.resolveArtifactDownload,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
    onRequestOpenImage: props.onRequestOpenImage,
    onOpenImage: props.onOpenImage,
    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
    embedSandboxMode: props.embedSandboxMode ?? "scripts",
    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
    showAssistantAvatar: false,
  } satisfies StreamGroupOptions;
  const streamGroupOptions = {
    ...sharedMessageRenderOptions,
    assistant: assistantIdentity,
  } satisfies StreamGroupOptions;
  const renderGroupOptions = (item: MessageGroup) => {
    const lastMessage = item.messages.at(-1)?.message;
    const rewindEntryId =
      item.role.toLowerCase() === "user" && lastMessage
        ? persistedMessageEntryId(lastMessage)
        : null;
    return {
      ...sharedMessageRenderOptions,
      showReasoning,
      showToolCalls: props.showToolCalls,
      autoExpandToolCalls: Boolean(props.autoExpandToolCalls),
      isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
      onToggleToolMessageExpanded: (messageId: string, expanded?: boolean) => {
        setExpansionState(
          expandedToolCards,
          messageId,
          !(expanded ?? expandedToolCards.get(messageId) ?? false),
        );
        requestUpdate();
      },
      isUserMessageExpanded: (messageId: string) => expandedUserMessages.get(messageId) ?? false,
      onToggleUserMessageExpanded: (messageId: string) => {
        setExpansionState(expandedUserMessages, messageId, !expandedUserMessages.get(messageId));
        requestUpdate();
      },
      loadFullAssistantMessage: props.loadFullAssistantMessage ?? undefined,
      getAssistantMessageExpansion: (messageId: string) => expandedAssistantMessages.get(messageId),
      onToggleAssistantMessageExpanded: toggleAssistantMessageExpanded,
      isToolExpanded: (toolCardId: string) => expandedToolCards.get(toolCardId) ?? false,
      onToggleToolExpanded: toggleToolCardExpanded,
      assistantName: props.assistantName,
      assistantAvatar: assistantIdentity.avatar,
      userId: props.userId ?? null,
      userName: props.userName ?? null,
      userAvatar: props.userAvatar ?? null,
      showAvatarGutter: !isDirectThread,
      contextWindow: threadContextWindow,
      onReply: props.onSetReply
        ? (target) => state.transcriptRenderContext.onSetReply?.(target)
        : undefined,
      resolveReplyPreview,
      onResolveReply: props.replyMessageAccess?.request,
      onOpenReply: (replyToId: string) => state.transcriptRenderContext.onOpenReply?.(replyToId),
      replyNavigationId: props.replyMessageAccess?.navigationId,
      onRewind:
        rewindEntryId && props.onRewindMessage
          ? () => {
              void Promise.resolve(props.onRewindMessage?.(rewindEntryId)).then((rewound) => {
                if (rewound) {
                  props.onFocusComposer?.();
                }
              });
            }
          : undefined,
      rewindDisabled: Boolean(props.runActive || props.runWorking),
      activeContinuation: activeContinuationByGroupKey.get(item.key),
      turnRecap: turnRecapByGroupKey.get(item.key),
    } satisfies Parameters<typeof renderMessageGroup>[1];
  };
  const renderGroupItem = (item: MessageGroup) => {
    return renderMessageGroup(item, renderGroupOptions(item));
  };
  // Only the working indicator shows live usage, so rows without one keep
  // memoizing across usage patches.
  const workingUsageKey = `usage:${props.runOutputTokens ?? ""}`;
  const liveStatusSignature = (item: ChatRenderItem): string => {
    if (item.kind === "stream-run") {
      return item.parts.some((part) => part.kind === "reading-indicator") ? workingUsageKey : "";
    }
    if (item.kind !== "group") {
      return "";
    }
    const continuation = activeContinuationByGroupKey.get(item.key);
    const recap = turnRecapByGroupKey.get(item.key);
    // Part keys stand in for the rest of the continuation: its remaining
    // options mirror props that already invalidate every row through the
    // shared render context.
    const continuationKey = continuation
      ? `${continuation.parts.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    const recapKey = recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : "";
    return `${continuationKey}|${recapKey}`;
  };
  const renderItem = guardChatRenderItems(state, liveStatusSignature, (item) => {
    if (item.kind === "divider") {
      return renderChatDivider(item, props.onOpenSessionCheckpoints);
    }
    if (item.kind === "notice") {
      return renderChatNotice(item);
    }
    if (item.kind === "stream-run") {
      return renderStreamGroup(item.parts, {
        ...streamGroupOptions,
        questionPrompts,
        planStatus: props.planStatus,
        planActive: Boolean(props.runActive),
        startupPhase: props.startupStatus?.phase,
        waitingApproval: props.waitingApproval,
        runOutputTokens: props.runOutputTokens,
      });
    }
    if (item.kind === "work-group") {
      const workExpanded = expandedToolCards.get(item.key) ?? false;
      return html`
        ${renderWorkGroupSummary(item, {
          expanded: workExpanded,
          onToggle: () => {
            setExpansionState(expandedToolCards, item.key, !workExpanded);
            requestUpdate();
          },
        })}
        ${workExpanded ? item.groups.map((group) => renderGroupItem(group)) : nothing}
      `;
    }
    if (item.kind === "activity-run") {
      const firstGroup = item.groups[0];
      if (!firstGroup) {
        return nothing;
      }
      if (item.groups.length === 1) {
        return renderGroupItem(firstGroup);
      }
      return renderActivityGroup(item.groups, renderGroupOptions(firstGroup));
    }
    if (item.kind === "group") {
      return renderGroupItem(item);
    }
    if (item.kind === "question") {
      return renderStreamGroup([item], {
        questionPrompts,
      });
    }
    return nothing;
  });
  const collapsedItems = coalesceActivityRuns(
    collapseCompletedTurnWork(coalesceStreamRuns(chatItems), {
      sessionKey: props.sessionKey,
      runWorking: Boolean(props.runWorking),
      searchActive: searchFiltering,
    }),
    { searchActive: searchFiltering },
  );
  // Watch/settle on actual indicator visibility (not runWorking): queued
  // sends show the claw before the run starts, and the recap must never
  // stack under a visible working row.
  const workingIndicatorVisible = chatItems.some((item) => item.kind === "reading-indicator");
  // runOutputTokens is the live usage-stream counter for the pane's own run;
  // its map entry dies at lifecycle end, so the watch captures the max seen.
  const turnRecap = resolveTurnRecap(
    props.sessionKey,
    workingIndicatorVisible,
    activeSession,
    props.runOutputTokens ?? null,
  );
  const transcriptItems = collapsedItems.filter((item, index) => {
    if (item.kind !== "stream-run") {
      return true;
    }
    const previous = collapsedItems[index - 1];
    const isActiveStatusRun =
      item.parts.some((part) => part.kind === "reading-indicator") &&
      item.parts.every((part) => part.kind === "reading-indicator" || part.kind === "plan");
    if (
      previous?.kind !== "group" ||
      !isActiveStatusRun ||
      !assistantGroupCanOwnActiveRunStatus(previous)
    ) {
      return true;
    }
    // A reply and its still-running state are one turn-level presentation.
    // Keeping the status in the reply avoids a second claw/assistant row.
    activeContinuationByGroupKey.set(previous.key, {
      parts: item.parts,
      options: {
        ...streamGroupOptions,
        planStatus: props.planStatus,
        planActive: Boolean(props.runActive),
        startupPhase: props.startupStatus?.phase,
        waitingApproval: props.waitingApproval,
        runOutputTokens: props.runOutputTokens,
      },
    });
    return false;
  });
  for (const item of transcriptItems) {
    if (item.kind !== "group") {
      continue;
    }
    const senderLabel = resolveMessageGroupSenderLabel(item, {
      assistantName: props.assistantName,
      userId: props.userId,
      userName: props.userName,
      userAvatar: props.userAvatar,
    });
    for (const source of item.messages) {
      const sourceMessageId = persistedMessageEntryId(source.message);
      const text = resolveMessageReplyText(source.message);
      if (sourceMessageId && text) {
        loadedReplySources.set(sourceMessageId, {
          rowKey: item.key,
          preview: {
            messageId: source.key,
            sourceMessageId,
            senderLabel,
            text,
          },
        });
      }
    }
  }
  transcript.syncMessageRows(
    new Map([...loadedReplySources].map(([messageId, source]) => [messageId, source.rowKey])),
  );
  let turnRecapOwnerKey: string | null = null;
  if (turnRecap !== null) {
    const lastItem = transcriptItems.at(-1);
    if (lastItem?.kind === "group" && assistantGroupCanOwnActiveRunStatus(lastItem)) {
      turnRecapByGroupKey.set(lastItem.key, turnRecap);
      turnRecapOwnerKey = lastItem.key;
    }
  }
  const transcriptRows: TranscriptRow<ChatRenderItem>[] = transcriptItems.map((item) => ({
    kind: "item",
    key: item.key,
    item,
  }));
  const realtimeConversation = renderRealtimeTalkConversation(props);
  if (realtimeConversation !== nothing) {
    transcriptRows.push({
      kind: "content",
      key: "realtime-talk",
      content: realtimeConversation,
    });
  }
  if (turnRecap !== null && turnRecapOwnerKey === null && !isEmpty && !showLoadingSkeleton) {
    transcriptRows.push({
      kind: "content",
      key: "turn-recap",
      content: renderTurnRecapRow(turnRecap),
    });
  }
  const backgroundTasks =
    !props.runWorking && !isEmpty && !showLoadingSkeleton
      ? renderBackgroundTasksStatusRow(props.backgroundTasks)
      : nothing;
  if (backgroundTasks !== nothing) {
    transcriptRows.push({
      kind: "content",
      key: "background-tasks",
      content: backgroundTasks,
    });
  }
  trackTranscriptRenderDependencies(state, [
    chatItems,
    locale,
    expandedToolCards,
    getExpansionStateVersion(expandedToolCards),
    expandedUserMessages,
    getExpansionStateVersion(expandedUserMessages),
    assistantMessageExpansionSignature(expandedAssistantMessages),
    getChatMediaRenderVersion(),
    // The host minute poll requests an update; this key crosses row guard() memoization.
    Math.floor(Date.now() / 60_000),
    getToolTitlesVersion(),
    props.sessionKey,
    props.boardProvider,
    props.boardProvider?.canPinWidgets,
    props.boardProvider?.canPinMcpApps,
    props.boardProvider?.snapshot$.value.revision,
    props.fullMessageAgentId,
    Boolean(props.loadFullAssistantMessage),
    showReasoning,
    props.showToolCalls,
    Boolean(props.runActive),
    Boolean(props.runWorking),
    props.startupStatus?.phase,
    Boolean(props.waitingApproval),
    props.planStatus,
    props.questionPrompts,
    Boolean(props.autoExpandToolCalls),
    props.assistantName,
    assistantIdentity.avatar,
    props.userId,
    props.userName,
    props.userAvatar,
    props.basePath,
    (props.localMediaPreviewRoots ?? []).join("\u0000"),
    props.assistantAttachmentAuthToken,
    props.canvasPluginSurfaceUrl,
    props.embedSandboxMode ?? "scripts",
    props.allowExternalEmbedUrls ?? false,
    threadContextWindow,
    Boolean(props.onSetReply),
    props.replyMessageAccess?.revision ?? 0,
    props.replyMessageAccess?.navigationId ?? "",
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
  ]);
  state.transcriptRenderContext.onSetReply = props.onSetReply;
  state.transcriptRenderContext.onOpenReply = (replyToId) => {
    if (loadedReplySources.has(replyToId)) {
      transcript.revealMessage(replyToId);
      return;
    }
    if (searchFiltering) {
      closeTranscriptSearch(state, requestUpdate);
    }
    props.replyMessageAccess?.open(replyToId);
  };
  return {
    isDirectThread,
    isEmpty,
    showLoadingSkeleton,
    searchOpen: state.searchOpen,
    renderRows: (overlay: unknown = nothing) =>
      transcript.render(
        transcriptRows,
        (row) => (row.kind === "item" ? renderItem(row.item) : row.content),
        latestTranscriptAnnouncement(collapsedItems),
        props.announceTranscript !== false && !state.searchOpen && !props.loading,
        overlay,
      ),
  };
}
