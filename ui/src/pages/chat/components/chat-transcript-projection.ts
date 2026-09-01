// Chat-item projection, expansion, reply hydration, and guarded row rendering.
import { nothing, type TemplateResult } from "lit";
import { classifySessionKind } from "../../../../../src/sessions/classify-session-kind.js";
import { i18n, t } from "../../../i18n/index.ts";
import { latestBrowserTabCards } from "../../../lib/chat/browser-tab-preview.ts";
import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import {
  isUiGlobalScopeConfigured,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../../lib/sessions/session-key.ts";
import { agentRunFrameActiveStatusParts } from "../chat-agent-run-grouping.ts";
import { resolveTurnRecap, type TurnRecap } from "../chat-progress.ts";
import { readChatThreadMessageIdentity } from "../chat-thread-items.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  agentRunFrameGroups,
  assistantMessageExpansionSignature,
  buildCachedChatItems,
  collectToolTitleCandidates,
  coalesceAgentRunFrames,
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  persistedMessageEntryId,
  setExpansionState,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import { getToolTitlesVersion, scheduleToolTitlesForTranscript } from "../tool-titles.ts";
import { renderAgentRunFrame } from "./chat-agent-run-frame.ts";
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
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";
import {
  closeTranscriptSearch,
  getTranscriptState,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import { renderBrowserTabPreviews } from "./chat-tool-cards.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import {
  guardChatRenderItems,
  trackTranscriptRenderDependencies,
} from "./chat-transcript-render-guard.ts";
import type { ChatTranscriptSession, TranscriptHeader } from "./chat-transcript-session.ts";
import { renderChatTypingIndicator } from "./chat-typing-indicator.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

type ChatTranscriptProjection = {
  isDirectThread: boolean;
  isEmpty: boolean;
  showLoadingSkeleton: boolean;
  searchOpen: boolean;
  renderRows: (overlay?: unknown, header?: TranscriptHeader | null) => TemplateResult;
};

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

export function projectChatTranscript(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
): ChatTranscriptProjection {
  const state = getTranscriptState(props.paneId);
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const displayStream = props.stream ?? null;
  const sessionHost = props.sessionHost ?? null;
  const activeSession = props.selectedSession;
  // Global-alias routing ignores the capped session list, which may omit the
  // canonical row. The scope gate keeps per-sender main threads direct.
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
  const archiveActor = activeSession?.archivedBy;
  const archiveNotice =
    activeSession?.archived && activeSession.archivedAt !== undefined && archiveActor?.id
      ? ({
          kind: "notice",
          key: `archive:${activeSession.sessionId ?? activeSession.key}:${activeSession.archivedAt}`,
          label: t("sessionsView.archivedBy", {
            name: archiveActor.label ?? archiveActor.id,
          }),
          text: "",
          timestamp: activeSession.archivedAt,
        } satisfies Extract<ChatItem, { kind: "notice" }>)
      : undefined;
  const chatItems = buildCachedChatItems({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    archiveNotice,
    runId: props.runId ?? null,
    locale,
    messages: props.messages,
    toolMessages: props.toolMessages,
    guardianNotices: props.guardianNotices,
    streamSegments: props.streamSegments,
    stream: displayStream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    pendingInputs: props.pendingInputs,
    showToolCalls: props.showToolCalls,
    persistCommentary: props.persistCommentary,
    runWorking: Boolean(props.runWorking),
    runActive: Boolean(props.runActive),
    questionPrompts: props.questionPrompts,
    loading: props.loading,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
  });
  const workingIndicator = chatItems.find((item) => item.kind === "reading-indicator");
  const runOutputTokens = workingIndicator?.runId
    ? (props.runUsageById?.get(workingIndicator.runId)?.outputTokens ?? null)
    : null;
  if (props.showToolCalls && !searchFiltering) {
    scheduleToolTitlesForTranscript(collectToolTitleCandidates(chatItems));
  }
  const latestBrowserTabs =
    props.browserTabPreviewsActive === false
      ? latestBrowserTabCards([], [])
      : latestBrowserTabCards(props.messages, props.toolMessages);
  syncToolCardExpansionState(
    props.sessionKey,
    chatItems,
    Boolean(props.autoExpandToolCalls),
    searchFiltering || !props.showToolCalls,
  );
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const expandedUserMessages = getExpandedUserMessages(props.sessionKey);
  const expandedAssistantMessages = transcript.expandedAssistantMessages;
  const recoveryKey = (messageId: string) => JSON.stringify([props.fullMessageAgentId, messageId]);
  if (expandedAssistantMessages.size > 0) {
    // Search and virtualization only hide rows. Prune against source history so
    // a removed message retires its body/load without refetching hidden rows.
    const retainedKeys = new Set(
      [
        ...props.messages,
        ...props.toolMessages,
        ...(props.pendingInputs ?? []).map((input) => input.message),
      ]
        .map((message) => readChatThreadMessageIdentity(message)?.id)
        .filter((id): id is string => typeof id === "string")
        .map(recoveryKey),
    );
    for (const key of expandedAssistantMessages.keys()) {
      if (!retainedKeys.has(key)) {
        expandedAssistantMessages.delete(key);
      }
    }
  }
  const questionPrompts = new Map(
    (props.questionPrompts ?? []).map((prompt) => [prompt.id, prompt]),
  );
  const toggleToolCardExpanded = (toolCardId: string, expanded?: boolean) => {
    setExpansionState(
      expandedToolCards,
      toolCardId,
      !(expanded ?? expandedToolCards.get(toolCardId) ?? false),
    );
    requestUpdate();
  };
  const toggleAssistantMessageExpanded = (messageId: string) => {
    const key = recoveryKey(messageId);
    const current = expandedAssistantMessages.get(key);
    const loader = props.loadFullAssistantMessage;
    if (!loader || current?.status === "loading") {
      return;
    }
    const revision = (current?.revision ?? 0) + 1;
    const pending = { status: "loading", revision } as const;
    expandedAssistantMessages.set(key, pending);
    requestUpdate();
    const completeLoad = (result: Awaited<ReturnType<typeof loader>>) => {
      // A reset or source replacement can reuse both message id and revision.
      // Only the exact pending entry may publish into this presentation.
      if (expandedAssistantMessages.get(key) !== pending) {
        return;
      }
      const markdown =
        result?.ok && result.message && typeof result.message === "object"
          ? extractTextCached(result.message)
          : null;
      expandedAssistantMessages.set(
        key,
        markdown === null
          ? { status: "error", revision: revision + 1 }
          : { status: "loaded", markdown, revision: revision + 1 },
      );
      requestUpdate();
    };
    void loader({
      sessionKey: props.sessionKey,
      ...(props.fullMessageAgentId ? { agentId: props.fullMessageAgentId } : {}),
      messageId,
    }).then(completeLoad, () => completeLoad(null));
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const hasTypingActors = (props.typingActors?.length ?? 0) > 0;
  const isEmpty =
    chatItems.length === 0 && !props.loading && !hasRealtimeTalkConversation && !hasTypingActors;
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
  // A forwarded cross-session message is another voice in the room: the thread
  // stops rendering as a compact direct exchange and identity chrome returns.
  const hasForwardedGroups = chatItems.some(
    (item) => item.kind === "group" && hasForwardedSource(item),
  );
  const isDirectThread =
    (sessionKind === "direct" || sessionKind === "cron" || sessionKind === "spawn-child") &&
    !props.userId &&
    !hasForwardedGroups;
  const showLoadingSkeleton = props.loading && chatItems.length === 0 && !hasTypingActors;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const activeContinuationByGroupKey = new Map<
    string,
    { parts: StreamGroupPart[]; options: StreamGroupOptions }
  >();
  const turnRecapByGroupKey = new Map<string, TurnRecap>();
  const loadedReplySources = new Map<string, LoadedReplySource>();
  const messageRowKeysById = new Map<string, string>();
  const resolveReplyPreview = createReplyPreviewResolver(loadedReplySources, props);
  const sharedMessageRenderOptions = {
    onReply: props.onSetReply
      ? (target) => state.transcriptRenderContext.onSetReply?.(target)
      : undefined,
    onOpenSidebar: props.onOpenSidebar,
    sessionKey: props.sessionKey,
    boardProvider: props.boardProvider,
    agentId: props.fullMessageAgentId,
    runActive: props.runActive,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    onRequestUpdate: requestUpdate,
    resourceBasePath: props.resourceBasePath,
    localMediaPreviewRoots: props.localMediaPreviewRoots ?? [],
    connectionEpoch: props.connectionEpoch,
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
    resolveArtifactDownload: props.resolveArtifactDownload,
    onRequestOpenImage: props.onRequestOpenImage,
    onOpenImage: props.onOpenImage,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
    embedSandboxMode: props.embedSandboxMode ?? "scripts",
    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
    fetchLinkFavicon: props.fetchLinkFavicon,
    showAssistantAvatar: false,
  } satisfies StreamGroupOptions;
  const streamGroupOptions = {
    ...sharedMessageRenderOptions,
    assistant: assistantIdentity,
    startupLabel: props.startupLabel,
    waitingApproval: props.waitingApproval,
    runOutputTokens,
    questionPrompts,
  } satisfies StreamGroupOptions;
  // Latest ownership crosses rows: the former owner must rerender when a
  // newer answer arrives even if its own message object stays stable.
  let latestAssistantItemKey: string | null = null;
  const renderGroupOptions = (item: MessageGroup) => {
    const lastMessage = item.messages.at(-1)?.message;
    const rewindEntryId =
      item.role.toLowerCase() === "user" && lastMessage
        ? persistedMessageEntryId(lastMessage)
        : null;
    return {
      ...sharedMessageRenderOptions,
      latestBrowserTabs,
      showReasoning,
      showToolCalls: props.showToolCalls,
      autoExpandToolCalls: Boolean(props.autoExpandToolCalls),
      isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
      onToggleToolMessageExpanded: toggleToolCardExpanded,
      isUserMessageExpanded: (messageId: string) => expandedUserMessages.get(messageId) ?? false,
      onToggleUserMessageExpanded: (messageId: string) => {
        setExpansionState(expandedUserMessages, messageId, !expandedUserMessages.get(messageId));
        requestUpdate();
      },
      loadFullAssistantMessage: props.loadFullAssistantMessage ?? undefined,
      getAssistantMessageExpansion: (messageId: string) =>
        expandedAssistantMessages.get(recoveryKey(messageId)),
      onToggleAssistantMessageExpanded: toggleAssistantMessageExpanded,
      isToolExpanded: (toolCardId: string) => expandedToolCards.get(toolCardId) ?? false,
      onToggleToolExpanded: toggleToolCardExpanded,
      assistantName: props.assistantName,
      assistantAvatar: assistantIdentity.avatar,
      agentId: props.currentAgentId ?? props.fullMessageAgentId,
      agents: props.agents,
      senderAgentAvatars: props.senderAgentAvatars,
      mainKey: props.mainKey,
      userId: props.userId ?? null,
      userName: props.userName ?? null,
      userAvatar: props.userAvatar ?? null,
      onRetryQueuedMessage: props.onRetryQueuedMessage,
      onDiscardQueuedMessage: props.onDiscardQueuedMessage,
      queuedMessageAction: props.queuedMessageAction,
      personActivity: props.personActivity,
      showAvatarGutter: !isDirectThread,
      contextWindow: threadContextWindow,
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
      latestAssistant: item.key === latestAssistantItemKey,
    } satisfies Parameters<typeof renderMessageGroup>[1];
  };
  const renderGroupItem = (item: MessageGroup) => {
    return renderMessageGroup(item, renderGroupOptions(item));
  };
  // Only the working indicator shows live usage, so rows without one keep
  // memoizing across usage patches.
  const workingUsageKey = `usage:${runOutputTokens ?? ""}`;
  const liveStatusSignature = (item: ChatRenderItem): string => {
    if (item.kind === "agent-run-frame") {
      const hasWorkingIndicator = item.parts.some(
        (part) =>
          part.kind === "stream-run" &&
          part.parts.some((streamPart) => streamPart.kind === "reading-indicator"),
      );
      const recap = turnRecapByGroupKey.get(item.key);
      return `${hasWorkingIndicator ? workingUsageKey : ""}|${
        recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : ""
      }|${item.key === latestAssistantItemKey ? "latest-assistant" : ""}`;
    }
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
    return `${continuationKey}|${recapKey}|${
      item.key === latestAssistantItemKey ? "latest-assistant" : ""
    }`;
  };
  const renderItem = guardChatRenderItems(state, liveStatusSignature, (item) => {
    if (item.kind === "divider") {
      return renderChatDivider(item, props.onOpenSessionCheckpoints);
    }
    if (item.kind === "notice") {
      return renderChatNotice(item);
    }
    if (item.kind === "stream-run") {
      return renderStreamGroup(item.parts, streamGroupOptions);
    }
    if (item.kind === "work-group") {
      const workExpanded = expandedToolCards.get(item.key) ?? false;
      return renderWorkGroupSummary(item, {
        expanded: workExpanded,
        browserTabPreviews: renderBrowserTabPreviews(item.groups, {
          sessionKey: props.sessionKey,
          latestBrowserTabs,
        }),
        onToggle: () => toggleToolCardExpanded(item.key, workExpanded),
      });
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
    if (item.kind === "agent-run-frame") {
      return renderAgentRunFrame(item, {
        streamOptions: streamGroupOptions,
        renderGroupOptions,
        isWorkExpanded: (key) => expandedToolCards.get(key) ?? false,
        onToggleWork: toggleToolCardExpanded,
        turnRecap: turnRecapByGroupKey.get(item.key),
      });
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
  const semanticItems = coalesceActivityRuns(
    collapseCompletedTurnWork(coalesceStreamRuns(chatItems), {
      sessionKey: props.sessionKey,
      runWorking: Boolean(props.runWorking),
      searchActive: searchFiltering,
    }),
    { searchActive: searchFiltering },
  );
  const collapsedItems = coalesceAgentRunFrames(semanticItems, { searchActive: searchFiltering });
  const resolvedRecap = resolveTurnRecap(state, {
    sessionKey: props.sessionKey,
    agentId: props.currentAgentId,
    gatewayClient: props.gatewayClient,
    indicator: workingIndicator,
    row: activeSession,
    usageByRun: props.runUsageById,
  });
  const transcriptItems = collapsedItems.filter((item, index) => {
    const previous = collapsedItems[index - 1];
    const activeStatusParts =
      item.kind === "stream-run" && item.parts.every((part) => part.kind === "reading-indicator")
        ? item.parts
        : item.kind === "agent-run-frame"
          ? agentRunFrameActiveStatusParts(item)
          : undefined;
    const activeStatusRunId =
      item.kind === "stream-run" || item.kind === "agent-run-frame" ? item.runId : undefined;
    if (
      previous?.kind !== "group" ||
      !activeStatusParts ||
      !assistantGroupCanOwnActiveRunStatus(previous) ||
      (previous.runId !== undefined &&
        activeStatusRunId !== undefined &&
        previous.runId !== activeStatusRunId)
    ) {
      return true;
    }
    // A reply and its still-running state are one turn-level presentation.
    // Keeping the status in the reply avoids a second claw/assistant row.
    activeContinuationByGroupKey.set(previous.key, {
      parts: activeStatusParts,
      options: streamGroupOptions,
    });
    return false;
  });
  // Default disclosure belongs only to a settled assistant at the transcript
  // tail; any newer visible row returns the prior answer to hover/tap behavior.
  const lastTranscriptItem = transcriptItems.at(-1);
  const tailStatusOwner =
    lastTranscriptItem?.kind === "agent-run-frame" &&
    lastTranscriptItem.outcome.kind === "completed" &&
    lastTranscriptItem.outcome.actionOwner !== null
      ? lastTranscriptItem
      : lastTranscriptItem?.kind === "group" &&
          assistantGroupCanOwnActiveRunStatus(lastTranscriptItem)
        ? lastTranscriptItem
        : null;
  // An unwatched background run must not inherit the visible turn's recap.
  const turnRecap =
    resolvedRecap && (!tailStatusOwner?.runId || tailStatusOwner.runId === resolvedRecap.runId)
      ? resolvedRecap
      : null;
  latestAssistantItemKey =
    !props.runActive &&
    !props.runWorking &&
    !searchFiltering &&
    tailStatusOwner &&
    (tailStatusOwner.kind !== "group" || !tailStatusOwner.isStreaming)
      ? tailStatusOwner.key
      : null;
  for (const item of transcriptItems) {
    const groups =
      item.kind === "agent-run-frame"
        ? agentRunFrameGroups(item)
        : item.kind === "group"
          ? [item]
          : [];
    const firstGroup = groups.find((group) => group.role === "assistant") ?? groups[0];
    if (!firstGroup) {
      continue;
    }
    const senderLabel = resolveMessageGroupSenderLabel(firstGroup, {
      assistantName: props.assistantName,
      userId: props.userId,
      userName: props.userName,
      userAvatar: props.userAvatar,
    });
    for (const group of groups) {
      for (const source of group.messages) {
        const sourceMessageId = persistedMessageEntryId(source.message);
        // The preview resolves content lazily; indexing only needs persisted identities.
        if (sourceMessageId) {
          messageRowKeysById.set(sourceMessageId, item.key);
          loadedReplySources.set(sourceMessageId, {
            message: source.message,
            messageId: source.key,
            senderLabel,
          });
        }
      }
    }
  }
  transcript.syncMessageRows(messageRowKeysById);
  let turnRecapOwnerKey: string | null = null;
  if (turnRecap !== null && tailStatusOwner?.runId === turnRecap.runId) {
    turnRecapByGroupKey.set(tailStatusOwner.key, turnRecap);
    turnRecapOwnerKey = tailStatusOwner.key;
  }
  // New row keys measure expanded work immediately; existing keys keep their
  // cached height until ResizeObserver reports the changed layout.
  const transcriptRows: TranscriptRow<ChatRenderItem>[] = [];
  for (const item of transcriptItems) {
    transcriptRows.push({ kind: "item", key: item.key, item });
    if (item.kind === "work-group" && expandedToolCards.get(item.key)) {
      for (const group of item.groups) {
        transcriptRows.push({ kind: "item", key: `${item.key}:${group.key}`, item: group });
      }
    }
  }
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
  const typingIndicator = renderChatTypingIndicator(props.typingActors);
  if (typingIndicator) {
    transcriptRows.push({ kind: "content", key: "presence:typing", content: typingIndicator });
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
    JSON.stringify([...latestBrowserTabs]),
    props.sessionKey,
    props.selectedSession,
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
    props.startupLabel,
    Boolean(props.waitingApproval),
    props.questionPrompts,
    Boolean(props.autoExpandToolCalls),
    props.assistantName,
    assistantIdentity.avatar,
    props.currentAgentId,
    props.agents,
    props.senderAgentAvatars,
    props.mainKey,
    props.userId,
    props.userName,
    props.userAvatar,
    props.resourceBasePath,
    (props.localMediaPreviewRoots ?? []).join("\u0000"),
    props.assistantAttachmentAuthToken,
    props.connectionEpoch,
    props.canvasPluginSurfaceUrl,
    props.embedSandboxMode ?? "scripts",
    props.allowExternalEmbedUrls ?? false,
    Boolean(props.fetchLinkFavicon),
    threadContextWindow,
    Boolean(props.onSetReply),
    Boolean(props.onRetryQueuedMessage),
    Boolean(props.onDiscardQueuedMessage),
    props.queuedMessageAction?.id,
    props.queuedMessageAction?.label,
    props.queuedMessageAction?.onAction,
    props.replyMessageAccess?.revision ?? 0,
    props.replyMessageAccess?.navigationId ?? "",
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
    props.runStatus?.phase ?? "",
    props.runStatus?.occurredAt ?? 0,
  ]);
  state.transcriptRenderContext.onSetReply = props.onSetReply;
  state.transcriptRenderContext.onOpenReply = (replyToId) => {
    const loaded = loadedReplySources.get(replyToId);
    if (loaded && resolveMessageReplyText(loaded.message)) {
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
    renderRows: (overlay: unknown = nothing, header: TranscriptHeader | null = null) =>
      transcript.render(
        transcriptRows,
        (row) => (row.kind === "item" ? renderItem(row.item) : row.content),
        latestTranscriptAnnouncement(collapsedItems),
        props.announceTranscript !== false && !state.searchOpen && !props.loading,
        overlay,
        header,
      ),
  };
}
