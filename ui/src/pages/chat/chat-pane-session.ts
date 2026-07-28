import { selectApplicationSession } from "../../app/agent-selection.ts";
import {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  applySelectedSessionProjection,
  buildCatalogSessionKey,
  catalogMessageId,
  clampText,
  dismissConfirmedActionPopovers,
  flushChatQueueAfterIdleSessionReconciliation,
  flushChatQueueForEvent,
  loadChatComposerSnapshot,
  loadChatBranches,
  loadChatHistory,
  lookupCatalogSession,
  parseAgentSessionKey,
  parseCatalogSessionKey,
  refreshChatAvatar,
  refreshChatMetadata,
  refreshRouteSessionOptions,
  resetChatStateForRouteSession,
  resetChatThreadSessionPresentationState,
  retryChatComposerMemoryFallback,
  resolveChatAgentId,
  resolveSessionDisplayName,
  resolveSessionKey,
  resolveStoredChatOutboxScope,
  saveRouteSessionSettings,
  scheduleChatScroll,
  storedChatOutboxScopeKey,
  syncSelectedSessionMessageSubscription,
  type CatalogSessionKey,
  type ChatPageHost,
  type GatewaySessionRow,
  type SessionCatalogTranscriptItem,
  type SessionsCatalogReadResult,
} from "./chat-pane-deps.ts";
import {
  CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS,
  catalogRawResult,
  catalogRawString,
  nativeHistoryMessageIdentity,
} from "./chat-pane-shared.ts";
import { ChatPaneSuggestions } from "./chat-pane-suggestions.ts";

export abstract class ChatPaneSession extends ChatPaneSuggestions {
  protected deferSessionHydrationUntilTranscript(
    sessionKey: string,
    transcriptLoad: Promise<unknown>,
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const requestVersion = ++this.deferredSessionHydrationRequestVersion;
    const connectionGeneration = this.connectionGeneration;
    const client = state.client;
    const isCurrent = () =>
      this.deferredSessionHydrationRequestVersion === requestVersion &&
      this.connectionGeneration === connectionGeneration &&
      this.state === state &&
      state.connected &&
      state.client === client &&
      state.sessionKey === sessionKey;
    const scheduleAfterTranscript = () => {
      if (!isCurrent()) {
        return;
      }
      // These affordances do not shape the transcript. Start them together only
      // after the authoritative history has committed so they cannot delay chat paint.
      state.renderLifecycle.afterCommit((complete) => {
        if (isCurrent()) {
          void loadChatBranches(state);
          void this.probeSessionDiscussion(sessionKey);
          this.hydrateSessionCompanion(sessionKey);
          void this.refreshSessionPullRequests();
        }
        complete();
      });
    };
    void transcriptLoad.then(scheduleAfterTranscript, scheduleAfterTranscript);
  }

  protected markSessionRead(row: GatewaySessionRow | undefined) {
    const state = this.state;
    if (!state?.connected || !row) {
      return;
    }
    const failureAt = row.endedAt ?? row.updatedAt ?? 0;
    const unreadFailure =
      (row.status === "failed" || row.status === "timeout") &&
      (row.lastReadAt == null || failureAt > row.lastReadAt);
    const agentStatusActive = Boolean(row.agentStatus && row.agentStatus.expiresAt > Date.now());
    if (
      !this.unreadPatchGuard.shouldPatch(
        state.sessionKey,
        row.unread === true || unreadFailure || agentStatusActive,
      )
    ) {
      return;
    }
    const agentId = parseAgentSessionKey(row.key)?.agentId ?? resolveChatAgentId(state);
    const guardKey = state.sessionKey;
    void this.context.sessions.patch(row.key, { unread: false }, { agentId }).catch(() => {
      // Unlatch so later unread snapshots retry; the session capability
      // publishes the actionable error for the owning page.
      this.unreadPatchGuard.patchFailed(guardKey);
    });
  }

  protected async restoreArchivedSession(sessionKey: string) {
    const scope = this.captureConnectionScope();
    if (!scope || scope.state.sessionKey !== sessionKey) {
      return;
    }
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? resolveChatAgentId(scope.state);
    let failure: string | null = null;
    try {
      // The patch can resolve falsy on failure; the capability error explains it.
      const patched = await scope.sessions.patch(sessionKey, { archived: false }, { agentId });
      if (!patched) {
        failure = scope.sessions.state.error;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure && this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
      scope.state.lastError = failure;
      scope.state.chatError = failure;
      scope.state.requestUpdate?.();
    }
  }

  protected setPaneSessionKey(sessionKey: string): string | null {
    const state = this.state;
    if (!state) {
      return null;
    }
    const nextSessionKey = parseCatalogSessionKey(sessionKey)
      ? sessionKey
      : resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
    if (!nextSessionKey) {
      return null;
    }
    state.sessionKey = nextSessionKey;
    return nextSessionKey;
  }

  // Global chrome (persisted session settings, gateway session, agent
  // selection) is owned by exactly one pane; the container guarantees a single
  // active pane, so inactive split panes must never run these bindings.
  protected applyActiveSessionBindings() {
    const state = this.state;
    if (
      !state ||
      !this.active ||
      !this.sessionKey.trim() ||
      parseCatalogSessionKey(state.sessionKey)
    ) {
      return;
    }
    const nextSessionKey = state.sessionKey;
    saveRouteSessionSettings(state, nextSessionKey);
    selectApplicationSession({
      selection: this.context.agentSelection,
      gateway: this.context.gateway,
      sessionKey: nextSessionKey,
    });
  }

  protected switchPaneSession(nextSessionKey: string) {
    const state = this.state;
    if (!state) {
      return;
    }
    // Close old-session listener owners before the next render detaches their
    // DOM; thread-global portals and caches are reset separately.
    dismissConfirmedActionPopovers(this);
    resetChatThreadSessionPresentationState(this.paneId);
    this.sessionDiscussionOpenUrls.clear();
    const previousSessionKey = state.sessionKey;
    // An in-progress title edit belongs to the previous session; committing
    // it against the newly routed row would rename the wrong session.
    this.cancelHeaderRename();
    const restoredPosition = this.resetOlderMessagesViewport(nextSessionKey);
    const catalogKey = parseCatalogSessionKey(nextSessionKey);
    const previousAgentId = resolveChatAgentId(state);
    const previousSessionsResult = state.sessionsResult;
    const nextSessionRow = state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey);
    const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
    const previousComposerScope =
      this.chatState.composerScopeForRouteSwitch() ??
      resolveStoredChatOutboxScope(state, previousSessionKey);
    const previousComposerScopeKey = storedChatOutboxScopeKey(previousComposerScope);
    const existingFallback = state.chatComposerFallbackByScope[previousComposerScopeKey];
    const draftPersistResult = this.chatState.persistComposerForRouteSwitch();
    const draftPersisted = draftPersistResult.status === "persisted";
    const previousStoredSnapshot = loadChatComposerSnapshot(
      state,
      previousSessionKey,
      previousComposerScope.agentId,
    );
    const previousStoredDraft = previousStoredSnapshot ? previousStoredSnapshot.draft : null;
    const storedDraftMatches = previousStoredDraft === state.chatMessage;
    const hasStagedAttachments = state.chatAttachments.length > 0;
    const retainExistingFallback = existingFallback !== undefined && !storedDraftMatches;
    const previousDraftRetry =
      draftPersistResult.status === "storage-failed"
        ? {
            expectedDraftRevision: draftPersistResult.expectedDraftRevision,
            draftRevision: draftPersistResult.draftRevision,
          }
        : existingFallback?.storageFailed && !storedDraftMatches
          ? existingFallback.draftRetry
          : undefined;
    resetChatStateForRouteSession(state, nextSessionKey, {
      retainPreviousComposerInMemory:
        !draftPersisted || hasStagedAttachments || retainExistingFallback,
      previousDraftRetry,
      previousComposerScope,
    });
    // The sidebar row is already authoritative enough for first paint: it supplies
    // the header and run controls while the reset restores any cached transcript.
    applySelectedSessionProjection(state, nextSessionRow);
    this.reconcileWaitingApprovalSnapshot();
    retryChatComposerMemoryFallback(state, nextSessionKey);
    // Route restoration is the new persistence baseline. An untouched pane
    // must not later erase a draft written by another split pane. Memory-only
    // fallbacks stay pane-local until a later edit persists successfully.
    this.chatState.adoptComposerRoute();
    this.taskSuggestionsRequestVersion += 1;
    this.catalogLoadGeneration += 1;
    this.taskSuggestions = [];
    this.taskSuggestionBusyIds.clear();
    this.taskSuggestionOperations.clear();
    this.resetSessionSuggestions();
    this.clearTypingActors();
    this.resetSessionPullRequests();
    if (catalogKey) {
      this.openCatalogSession(catalogKey, state);
      return;
    }
    this.catalogRequestedSessionKey = null;
    this.markSessionRead(nextSessionRow);
    if (previousSessionKey !== nextSessionKey) {
      state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
    }
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state).finally(() => this.requestUpdate());
    const nextAgentId = resolveChatAgentId(state);
    // Agent-scoped catalogs remain valid across same-agent sessions. Cross-agent
    // failures must clear instead of retaining models owned by the previous agent.
    void refreshChatMetadata(state, {
      preserveModelCatalogOnFallback: Boolean(previousAgentId && previousAgentId === nextAgentId),
    }).finally(() => state.requestUpdate?.());
    const subscriptionSync = syncSelectedSessionMessageSubscription(state);
    const composerStorageError = state.chatError === CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    const historyLoad = loadChatHistory(state, { deferBranches: true });
    if (composerStorageError) {
      // History loading clears the shared error slot synchronously. Restore the
      // pane-local storage warning unless the retry above made the draft durable.
      state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    }
    state.requestUpdate();
    void this.refreshTaskSuggestions();
    void this.refreshSessionSuggestions();
    this.deferSessionHydrationUntilTranscript(nextSessionKey, historyLoad);
    const scheduleHistoryScroll = () => {
      if (state.sessionKey !== nextSessionKey) {
        return;
      }
      state.requestUpdate();
      if (restoredPosition === null || restoredPosition.anchorToEnd) {
        scheduleChatScroll(state, true);
      } else {
        this.restoreOlderMessagesViewport(nextSessionKey, restoredPosition.scrollTop);
      }
    };
    void historyLoad.then(scheduleHistoryScroll, scheduleHistoryScroll);
    void historyLoad.then(
      () => this.sendPendingSkillWorkshopRevision(nextSessionKey),
      () => this.sendPendingSkillWorkshopRevision(nextSessionKey),
    );
    if (state.chatQueue.length > 0) {
      const sessionsRefresh = refreshRouteSessionOptions(state);
      flushChatQueueAfterIdleSessionReconciliation(
        state,
        nextSessionKey,
        historyLoad,
        sessionsRefresh,
        previousSessionsResult,
        () => void flushChatQueueForEvent(state),
      );
      void sessionsRefresh;
    }
    void subscriptionSync;
    void historyLoad;
  }

  protected openCatalogSession(key: CatalogSessionKey, state: ChatPageHost) {
    this.catalogRequestedSessionKey = buildCatalogSessionKey(key);
    this.catalogMessages = [];
    this.catalogCursor = undefined;
    this.catalogSession = null;
    this.catalogHost = null;
    state.chatAttachments = [];
    state.chatLoading = true;
    state.requestUpdate();
    void this.loadCatalogSession(key, false);
  }

  protected catalogItemMessage(item: SessionCatalogTranscriptItem): Record<string, unknown> | null {
    const parsedTimestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
    const text = item.text?.trim() ? item.text : null;
    if (item.type === "userMessage") {
      return text
        ? {
            role: "user",
            content: text,
            ...(timestamp == null ? {} : { timestamp }),
            messageId: item.id,
          }
        : null;
    }
    let content = text;
    if (item.type === "reasoning") {
      content = text ? `Thinking\n\n${text}` : "Thinking";
    } else if (item.type === "toolCall") {
      const label =
        text ?? catalogRawString(item.raw, ["command", "name", "tool", "title", "query"]);
      content = label ? `Tool call\n\n${label}` : "Tool call";
    } else if (item.type === "toolResult") {
      // Raw aggregated output is only bounded by the transcript read's per-item
      // byte cap (megabytes), so clamp it to the preview size before rendering.
      const aggregated = catalogRawString(item.raw, ["aggregatedOutput"]);
      const output =
        text ??
        (aggregated ? clampText(aggregated, CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS) : null) ??
        catalogRawResult(item.raw);
      content = output ? `Tool result\n\n${output}` : "Tool result";
    }
    if (!content) {
      return null;
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: content }],
      ...(timestamp == null ? {} : { timestamp }),
      messageId: item.id,
    };
  }

  protected prependUniqueCatalogMessages(messages: unknown[]): unknown[] {
    const seenIds = new Set(this.catalogMessages.map(catalogMessageId).filter(Boolean));
    const uniqueMessages = messages.filter((message) => {
      const messageId = catalogMessageId(message);
      if (!messageId || !seenIds.has(messageId)) {
        if (messageId) {
          seenIds.add(messageId);
        }
        return true;
      }
      return false;
    });
    return [...uniqueMessages, ...this.catalogMessages];
  }

  protected prependUniqueNativeMessages(messages: unknown[], current: unknown[]): unknown[] {
    const duplicateCounts = new Map<string, number>();
    for (const message of current) {
      const identity = nativeHistoryMessageIdentity(message);
      if (identity) {
        duplicateCounts.set(identity, (duplicateCounts.get(identity) ?? 0) + 1);
      }
    }
    const uniqueMessages = messages.filter((message) => {
      const identity = nativeHistoryMessageIdentity(message);
      if (!identity) {
        return true;
      }
      const duplicatesRemaining = duplicateCounts.get(identity) ?? 0;
      if (duplicatesRemaining === 0) {
        return true;
      }
      duplicateCounts.set(identity, duplicatesRemaining - 1);
      return false;
    });
    return [...uniqueMessages, ...current];
  }

  protected async loadCatalogSession(key: CatalogSessionKey, older: boolean): Promise<boolean> {
    const state = this.state;
    const client = state?.client;
    if (!state || !client || !state.connected) {
      return false;
    }
    if (older && !this.catalogCursor) {
      return false;
    }
    const generation = older ? this.catalogLoadGeneration : ++this.catalogLoadGeneration;
    const requestedSessionKey = buildCatalogSessionKey(key);
    const isCurrent = () =>
      generation === this.catalogLoadGeneration && this.sessionKey === requestedSessionKey;
    if (!older) {
      this.catalogLoading = true;
      this.catalogCursor = undefined;
      this.olderCursorsSeen.clear();
      this.historyObserverArmed = false;
      this.historyBootstrapPagesLoaded = 0;
      this.transcriptScrollTop = null;
      this.historyObserver?.disconnect();
      this.historyObserver = null;
    }
    try {
      if (!older) {
        const lookup = await lookupCatalogSession({ client, key, isCurrent });
        if (!lookup) {
          return false;
        }
        this.catalogHost = lookup.host;
        this.catalogSession = lookup.session;
      }
      const requestedOlderCursor = older ? this.catalogCursor : undefined;
      if (requestedOlderCursor) {
        this.olderCursorsSeen.add(requestedOlderCursor);
      }
      const page = await client.request<SessionsCatalogReadResult>("sessions.catalog.read", {
        catalogId: key.catalogId,
        hostId: key.hostId,
        threadId: key.threadId,
        limit: 50,
        ...(older && this.catalogCursor ? { cursor: this.catalogCursor } : {}),
      });
      if (!isCurrent()) {
        return false;
      }
      const messages = page.items
        .toReversed()
        .map((item) => this.catalogItemMessage(item))
        .filter((message) => message !== null);
      const nextMessages = older ? this.prependUniqueCatalogMessages(messages) : messages;
      // Exhaust when the cursor cannot make new forward progress: absent, unchanged,
      // or already visited this session (a provider cycling c1 -> c2 -> c1). Any of
      // these stops the re-armed observer from looping. An advancing, never-seen
      // cursor with no newly rendered messages (an entirely filtered/duplicate page)
      // must keep paging — real older history may sit behind it.
      const olderExhausted =
        older &&
        (!page.nextCursor ||
          page.nextCursor === requestedOlderCursor ||
          this.olderCursorsSeen.has(page.nextCursor));
      this.catalogMessages = nextMessages;
      this.catalogCursor = olderExhausted ? undefined : page.nextCursor;
      const currentState = this.state ?? state;
      currentState.lastError = null;
      scheduleChatScroll(currentState, !older);
      return older ? !olderExhausted : true;
    } catch (error) {
      if (isCurrent()) {
        (this.state ?? state).lastError = error instanceof Error ? error.message : String(error);
      }
      return false;
    } finally {
      if (isCurrent()) {
        const currentState = this.state ?? state;
        if (!older) {
          this.catalogLoading = false;
          currentState.chatLoading = false;
        }
        currentState.requestUpdate();
      }
    }
  }
}
