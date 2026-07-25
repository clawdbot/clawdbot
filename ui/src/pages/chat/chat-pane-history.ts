import {
  COMMAND_PALETTE_TARGET_EVENT,
  announceCatalogSessionContinued,
  loadChatHistory,
  loadOlderChatHistoryPage,
  parseAgentSessionKey,
  parseCatalogSessionKey,
  persistChatComposerState,
  resolveChatHistoryPagination,
  rewindChatHistory,
  scheduleChatScroll,
  scopedAgentParamsForSession,
  switchChatHistoryBranch,
  visibleSessionMatches,
  type CatalogSessionKey,
  type ChatHistoryPagination,
  type CommandPaletteTargetDetail,
  type SessionsCatalogContinueResult,
} from "./chat-pane-deps.ts";
import { ChatPaneSession } from "./chat-pane-session.ts";
import {
  CHAT_HISTORY_BOOTSTRAP_PAGE_LIMIT,
  CHAT_HISTORY_INTENT_EDGE_PX,
  CHAT_HISTORY_INTENT_IDLE_MS,
  CHAT_HISTORY_TOUCH_INTENT_PX,
  CHAT_HISTORY_UPWARD_KEYS,
} from "./chat-pane-shared.ts";

export abstract class ChatPaneHistory extends ChatPaneSession {
  protected hasOlderMessages(): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    if (parseCatalogSessionKey(state.sessionKey)) {
      return Boolean(this.catalogCursor && !this.catalogLoading);
    }
    const pagination = state.chatHistoryPagination ?? { hasMore: false };
    if (pagination !== this.nativePaginationSnapshot) {
      this.nativePaginationSnapshot = pagination;
      this.olderOffsetsSeen.clear();
    }
    return pagination.hasMore && !state.chatLoading;
  }

  protected resetOlderMessagesViewport(): void {
    this.olderLoadGeneration += 1;
    this.loadingOlder = false;
    this.historyObserverArmed = false;
    this.historyAutoLoadBlocked = false;
    this.historyBootstrapPagesLoaded = 0;
    this.historyIntentConsumed = false;
    this.historyTouchY = null;
    if (this.historyIntentTimer !== null) {
      window.clearTimeout(this.historyIntentTimer);
      this.historyIntentTimer = null;
    }
    this.transcriptScrollTop = null;
    this.olderCursorsSeen.clear();
    this.olderOffsetsSeen.clear();
    this.nativePaginationSnapshot = null;
    this.clearHistoryObserver();
  }

  protected clearHistoryObserver(): void {
    this.historyObserver?.disconnect();
    this.historyObserver = null;
    this.historyObserverRoot = null;
    this.historyObserverSentinel = null;
    this.historyObserverBootstrap = false;
  }

  protected syncHistoryObserver(): void {
    const catalogSession = Boolean(this.state && parseCatalogSessionKey(this.state.sessionKey));
    const historyLoading = catalogSession ? this.catalogLoading : this.state?.chatLoading;
    if (historyLoading) {
      this.historyObserverArmed = false;
      if (this.loadingOlder) {
        this.olderLoadGeneration += 1;
        this.loadingOlder = false;
      }
    }
    if (
      typeof IntersectionObserver !== "function" ||
      !this.state?.connected ||
      this.loadingOlder ||
      !this.hasOlderMessages()
    ) {
      this.clearHistoryObserver();
      return;
    }
    const root = this.querySelector<HTMLElement>(".chat-thread");
    const sentinel = root?.querySelector<HTMLElement>(".chat-history-sentinel") ?? null;
    if (!root || !sentinel) {
      this.clearHistoryObserver();
      return;
    }
    this.transcriptScrollTop ??= root.scrollTop;
    const threadIsScrollable = root.scrollHeight > root.clientHeight;
    const bootstrap =
      !this.historyObserverArmed &&
      !threadIsScrollable &&
      this.historyBootstrapPagesLoaded < CHAT_HISTORY_BOOTSTRAP_PAGE_LIMIT;
    if (this.historyAutoLoadBlocked) {
      this.clearHistoryObserver();
      return;
    }
    if (!this.historyObserverArmed && !bootstrap) {
      this.clearHistoryObserver();
      if (!threadIsScrollable) {
        this.historyAutoLoadBlocked = true;
        this.requestUpdate();
      }
      return;
    }
    if (
      this.historyObserver &&
      this.historyObserverRoot === root &&
      this.historyObserverSentinel === sentinel &&
      this.historyObserverBootstrap === bootstrap
    ) {
      return;
    }
    this.clearHistoryObserver();
    this.historyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.historyObserverArmed = false;
          if (bootstrap) {
            this.historyBootstrapPagesLoaded += 1;
          }
          void this.loadOlderMessages();
        }
      },
      { root, rootMargin: "300px 0px 0px", threshold: 0 },
    );
    this.historyObserverRoot = root;
    this.historyObserverSentinel = sentinel;
    this.historyObserverBootstrap = bootstrap;
    this.historyObserver.observe(sentinel);
  }

  protected handleTranscriptScroll(event: Event): void {
    const root =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : event.target instanceof HTMLElement
          ? event.target
          : null;
    const previousScrollTop = this.transcriptScrollTop;
    if (root) {
      this.transcriptScrollTop = root.scrollTop;
    }
    const hasUpwardIntent =
      !this.loadingOlder &&
      root !== null &&
      previousScrollTop !== null &&
      root.scrollTop < previousScrollTop &&
      root.scrollTop <= CHAT_HISTORY_INTENT_EDGE_PX;
    const newHistoryIntent = hasUpwardIntent && this.consumeHistoryIntent();
    // A failed request or exhausted bootstrap stays disarmed until renewed
    // upward intent, preventing request loops without stranding older history.
    if (newHistoryIntent && this.historyAutoLoadBlocked) {
      this.historyAutoLoadBlocked = false;
      this.historyObserverArmed = true;
      this.syncHistoryObserver();
    } else if (newHistoryIntent && !this.historyObserverArmed) {
      this.historyObserverArmed = true;
      this.syncHistoryObserver();
    }
    // Preserve the normal at-bottom/new-message bookkeeping while layering
    // history-sentinel arming onto the same scroll event.
    this.state?.handleChatScroll(event);
  }

  protected consumeHistoryIntent(): boolean {
    if (this.historyIntentTimer !== null) {
      window.clearTimeout(this.historyIntentTimer);
    }
    this.historyIntentTimer = window.setTimeout(() => {
      this.historyIntentTimer = null;
      this.historyIntentConsumed = false;
    }, CHAT_HISTORY_INTENT_IDLE_MS);
    if (this.historyIntentConsumed) {
      return false;
    }
    this.historyIntentConsumed = true;
    return true;
  }

  protected handleTranscriptHistoryIntent(event: Event): void {
    const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    let upward =
      (event instanceof WheelEvent && event.deltaY < 0) ||
      (event instanceof KeyboardEvent && CHAT_HISTORY_UPWARD_KEYS.has(event.key));
    if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
      const touchY = event.touches[0]?.clientY ?? null;
      if (event.type === "touchstart") {
        this.historyTouchY = touchY;
        return;
      }
      if (event.type === "touchend" || event.type === "touchcancel") {
        this.historyTouchY = null;
        return;
      }
      const previousTouchY = this.historyTouchY;
      if (touchY !== null && previousTouchY !== null) {
        upward = touchY - previousTouchY >= CHAT_HISTORY_TOUCH_INTENT_PX;
        if (upward || touchY < previousTouchY) {
          this.historyTouchY = touchY;
        }
      }
    }
    if (
      !root ||
      !upward ||
      root.scrollTop > CHAT_HISTORY_INTENT_EDGE_PX ||
      this.loadingOlder ||
      !this.hasOlderMessages() ||
      !this.consumeHistoryIntent()
    ) {
      return;
    }
    this.historyAutoLoadBlocked = false;
    if (typeof IntersectionObserver !== "function") {
      void this.loadOlderMessages();
      return;
    }
    this.historyObserverArmed = true;
    this.syncHistoryObserver();
  }

  protected async loadOlderMessages(): Promise<void> {
    const state = this.state;
    const catalogKey = state ? parseCatalogSessionKey(state.sessionKey) : null;
    if (!state || this.loadingOlder || !this.hasOlderMessages()) {
      return;
    }
    const generation = ++this.olderLoadGeneration;
    this.loadingOlder = true;
    state.requestUpdate();
    let prepended = false;
    try {
      if (catalogKey) {
        prepended = await this.loadCatalogSession(catalogKey, true);
      } else {
        const pagination = state.chatHistoryPagination;
        if (!pagination?.hasMore) {
          return;
        }
        const requestedOffset = pagination.nextOffset;
        const expectedSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        this.olderOffsetsSeen.add(requestedOffset);
        const result = await loadOlderChatHistoryPage(state, requestedOffset);
        if (!result || generation !== this.olderLoadGeneration) {
          return;
        }
        const resultSessionId =
          typeof result.sessionInfo?.sessionId === "string" && result.sessionInfo.sessionId.trim()
            ? result.sessionInfo.sessionId.trim()
            : typeof result.sessionId === "string"
              ? result.sessionId.trim()
              : "";
        if (expectedSessionId && resultSessionId !== expectedSessionId) {
          // Offset cursors belong to one transcript. A reset can reuse the session
          // key, so replace the tail instead of mixing two session IDs.
          await loadChatHistory(state);
          prepended = true;
          return;
        }
        const nextPagination = resolveChatHistoryPagination(result);
        const exhausted =
          !nextPagination.hasMore ||
          nextPagination.nextOffset <= requestedOffset ||
          this.olderOffsetsSeen.has(nextPagination.nextOffset);
        const messages = Array.isArray(result.messages) ? result.messages : [];
        const nextMessages = this.prependUniqueNativeMessages(messages, state.chatMessages);
        const grew = nextMessages.length > state.chatMessages.length;
        state.chatMessages = nextMessages;
        const appliedPagination: ChatHistoryPagination = exhausted
          ? {
              hasMore: false,
              ...(nextPagination.totalMessages !== undefined
                ? { totalMessages: nextPagination.totalMessages }
                : {}),
            }
          : nextPagination;
        state.chatHistoryPagination = appliedPagination;
        this.nativePaginationSnapshot = appliedPagination;
        state.lastError = null;
        scheduleChatScroll(state, false);
        prepended = grew || !exhausted;
      }
    } catch (error) {
      if (generation === this.olderLoadGeneration) {
        state.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.olderLoadGeneration) {
        if (!prepended) {
          this.historyAutoLoadBlocked = this.hasOlderMessages();
        } else if (!this.hasOlderMessages()) {
          this.historyAutoLoadBlocked = false;
        }
        this.loadingOlder = false;
        state.requestUpdate();
      }
    }
  }

  protected async continueCatalogSession(key: CatalogSessionKey) {
    const state = this.state;
    const client = state?.client;
    const draft = state?.chatMessage.trim();
    if (!state || !client || !draft || !this.catalogSession?.canContinue) {
      return;
    }
    state.chatSending = true;
    state.requestUpdate();
    try {
      const result = await client.request<SessionsCatalogContinueResult>(
        "sessions.catalog.continue",
        key,
      );
      announceCatalogSessionContinued({ ...key, sessionKey: result.sessionKey });
      this.onPaneSessionChange?.(this.paneId, result.sessionKey);
      this.switchPaneSession(result.sessionKey);
      state.handleChatDraftChange(draft);
      await state.handleSendChat();
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.chatSending = false;
      state.requestUpdate();
    }
  }

  protected async rewindToMessage(entryId: string): Promise<boolean> {
    const state = this.state;
    if (!state) {
      return false;
    }
    const result = await rewindChatHistory(state, entryId);
    if (!result) {
      state.requestUpdate?.();
      return false;
    }
    state.requestUpdate?.();
    return true;
  }

  protected async forkFromMessage(entryId: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const sourceKey = state.sessionKey;
    const agentParams = scopedAgentParamsForSession(state, sourceKey);
    try {
      const result = await state.sessions.forkAtMessage(sourceKey, entryId, agentParams);
      const editorText = result.editorText ?? "";
      const draftPersisted = persistChatComposerState(state, result.sessionKey, {
        agentId: parseAgentSessionKey(result.sessionKey)?.agentId,
        draft: editorText,
      });
      if (this.state !== state || !visibleSessionMatches(state, sourceKey, agentParams.agentId)) {
        return;
      }
      this.onPaneSessionChange?.(this.paneId, result.sessionKey);
      this.switchPaneSession(result.sessionKey);
      if (!draftPersisted) {
        state.handleChatDraftChange(editorText);
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.chatError = state.lastError;
      state.requestUpdate?.();
    }
  }

  protected async switchToBranch(leafEntryId: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    await switchChatHistoryBranch(state, leafEntryId);
    state.requestUpdate?.();
  }

  protected readonly handleCommandPaletteSlashCommand = (command: string) => {
    const state = this.state;
    if (!state) {
      return;
    }
    state.handleChatDraftChange(command.endsWith(" ") ? command : `${command} `);
    state.requestUpdate?.();
  };

  protected announceCommandPaletteTarget(
    onSlashCommand: CommandPaletteTargetDetail["onSlashCommand"],
  ) {
    this.dispatchEvent(
      new CustomEvent<CommandPaletteTargetDetail>(COMMAND_PALETTE_TARGET_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          owner: this,
          onSlashCommand,
        },
      }),
    );
  }
}
