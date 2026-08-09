import type { SessionsCatalogContinueResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette-contract.ts";
import {
  announceCatalogSessionContinued,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  loadChatHistory,
  loadOlderChatHistoryPage,
  resolveChatHistoryPagination,
  rewindChatHistory,
  switchChatHistoryBranch,
} from "./chat-history.ts";
import { ChatPaneSession } from "./chat-pane-session.ts";
import {
  CHAT_HISTORY_BOOTSTRAP_PAGE_LIMIT,
  CHAT_HISTORY_INTENT_EDGE_PX,
  CHAT_HISTORY_INTENT_IDLE_MS,
  CHAT_HISTORY_TOUCH_INTENT_PX,
  CHAT_HISTORY_UPWARD_KEYS,
} from "./chat-pane-shared.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import {
  captureChatSessionScrollPosition,
  getChatSessionScrollPosition,
  restoreChatScroll,
  saveChatSessionScrollPosition,
  scheduleChatScroll,
  type ChatSessionScrollPosition,
} from "./scroll.ts";

export abstract class ChatPaneHistory extends ChatPaneSession {
  private activeCatalogContinuation: symbol | null = null;

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

  protected resetOlderMessagesViewport(nextSessionKey?: string): ChatSessionScrollPosition | null {
    let restoredPosition: ChatSessionScrollPosition | null = null;
    const state = this.state;
    if (nextSessionKey && state) {
      const root = this.querySelector<HTMLElement>(".chat-thread");
      const outgoingSessionKey = root ? this.transcript.renderedSessionKey : state.sessionKey;
      const pendingScrollTop = outgoingSessionKey
        ? this.transcript.pendingScrollOffsetFor(outgoingSessionKey)
        : null;
      const outgoingPosition =
        pendingScrollTop !== null
          ? { scrollTop: pendingScrollTop, anchorToEnd: false }
          : root
            ? captureChatSessionScrollPosition(root)
            : this.transcriptScrollTop !== null
              ? { scrollTop: this.transcriptScrollTop, anchorToEnd: false }
              : null;
      if (outgoingSessionKey && outgoingPosition) {
        saveChatSessionScrollPosition(this.paneId, outgoingSessionKey, outgoingPosition);
      }
    }
    if (nextSessionKey) {
      restoredPosition = getChatSessionScrollPosition(this.paneId, nextSessionKey) ?? null;
    }
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
    this.transcriptScrollTop = restoredPosition?.scrollTop ?? null;
    this.olderCursorsSeen.clear();
    this.olderOffsetsSeen.clear();
    this.nativePaginationSnapshot = null;
    this.clearHistoryObserver();
    return restoredPosition;
  }

  protected restoreOlderMessagesViewport(sessionKey: string, scrollTop: number): void {
    const state = this.state;
    if (!state || !areUiSessionKeysEquivalent(state.sessionKey, sessionKey)) {
      return;
    }
    const generation = this.olderLoadGeneration;
    state.renderLifecycle.afterCommit((complete) => {
      try {
        if (
          this.state !== state ||
          !areUiSessionKeysEquivalent(state.sessionKey, sessionKey) ||
          this.olderLoadGeneration !== generation
        ) {
          return;
        }
        const root = this.querySelector<HTMLElement>(".chat-thread");
        if (root) {
          restoreChatScroll(state, root, scrollTop);
          // The outer scroller can still be zero-height on this commit. Let
          // the virtualizer reconcile the logical target as rows are measured.
          this.transcript.scrollToOffset(scrollTop, (settledPosition) => {
            if (
              this.state !== state ||
              !areUiSessionKeysEquivalent(state.sessionKey, sessionKey) ||
              this.olderLoadGeneration !== generation
            ) {
              return;
            }
            const settledRoot = this.querySelector<HTMLElement>(".chat-thread");
            if (!settledRoot) {
              return;
            }
            this.transcriptScrollTop = restoreChatScroll(
              state,
              settledRoot,
              settledPosition.scrollTop,
            );
            saveChatSessionScrollPosition(this.paneId, sessionKey, {
              ...settledPosition,
              scrollTop: this.transcriptScrollTop,
            });
          });
          this.transcriptScrollTop = scrollTop;
        }
      } finally {
        complete();
      }
    });
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
      const renderedSessionKey = this.transcript.renderedSessionKey;
      const stateSessionKey = this.state?.sessionKey;
      if (
        renderedSessionKey &&
        stateSessionKey &&
        areUiSessionKeysEquivalent(renderedSessionKey, stateSessionKey)
      ) {
        saveChatSessionScrollPosition(
          this.paneId,
          renderedSessionKey,
          captureChatSessionScrollPosition(root),
        );
      }
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
    const scope = this.captureConnectionScope();
    const state = scope?.state;
    const client = scope?.client;
    const draft = state?.chatMessage.trim();
    if (!scope || !state || !client || !draft || !this.catalogSession?.canContinue) {
      return;
    }
    const sourceSessionKey = state.sessionKey;
    const sourceCatalogGeneration = this.catalogLoadGeneration;
    const continuation = Symbol("catalog-continuation");
    let adoptedSessionKey: string | null = null;
    let adoptedCatalogGeneration: number | null = null;
    this.activeCatalogContinuation = continuation;
    state.chatSending = true;
    state.requestUpdate();
    const releaseStaleContinuation = () => {
      if (this.activeCatalogContinuation !== continuation) {
        return;
      }
      this.activeCatalogContinuation = null;
      if (state.chatSendingScopeKey != null || !state.chatSending) {
        return;
      }
      state.chatSending = false;
      state.requestUpdate();
    };
    try {
      const result = await client.request<SessionsCatalogContinueResult>(
        "sessions.catalog.continue",
        key,
      );
      // A catalog adoption must not navigate or send into a pane that switched
      // sessions or reconnected while its original continuation was in flight.
      if (
        this.activeCatalogContinuation !== continuation ||
        !this.isConnectionScopeCurrent(scope) ||
        this.catalogLoadGeneration !== sourceCatalogGeneration ||
        state.sessionKey !== sourceSessionKey
      ) {
        releaseStaleContinuation();
        return;
      }
      adoptedSessionKey = result.sessionKey;
      announceCatalogSessionContinued({ ...key, sessionKey: result.sessionKey });
      // Make the adopted session authoritative before routing; otherwise the
      // outgoing catalog pane can immediately restore the previous chat URL.
      this.switchPaneSession(result.sessionKey);
      adoptedCatalogGeneration = this.catalogLoadGeneration;
      this.onPaneSessionChange?.(this.paneId, result.sessionKey);
      state.handleChatDraftChange(draft);
      await state.handleSendChat();
      if (this.activeCatalogContinuation === continuation) {
        this.activeCatalogContinuation = null;
      }
    } catch (error) {
      if (
        this.activeCatalogContinuation !== continuation ||
        !this.isConnectionScopeCurrent(scope) ||
        (adoptedSessionKey === null
          ? this.catalogLoadGeneration !== sourceCatalogGeneration ||
            state.sessionKey !== sourceSessionKey
          : adoptedCatalogGeneration === null
            ? state.sessionKey !== sourceSessionKey && state.sessionKey !== adoptedSessionKey
            : this.catalogLoadGeneration !== adoptedCatalogGeneration ||
              state.sessionKey !== adoptedSessionKey)
      ) {
        releaseStaleContinuation();
        return;
      }
      this.activeCatalogContinuation = null;
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
      // Restored images intentionally stay in this tab's memory; persisted composer drafts remain
      // text-only so large payloads do not enter local storage.
      state.chatAttachments = replaceChatAttachmentsFromEditor(
        state.chatAttachments,
        result.editorAttachments,
      );
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
