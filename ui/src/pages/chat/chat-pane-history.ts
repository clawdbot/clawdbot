import type { SessionsCatalogContinueResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette-contract.ts";
import { formatUiError } from "../../lib/format-error.ts";
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
import {
  cloneChatAttachmentsForIndependentOwner,
  replaceChatAttachmentsFromEditor,
} from "./attachment-payload-store.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  commitCurrentChatHistorySnapshot,
  loadChatHistory,
  loadOlderChatHistoryPage,
  resolveChatHistoryPagination,
  rewindChatHistory,
  switchChatHistoryBranch,
} from "./chat-history.ts";
import { ChatPaneReplyNavigation } from "./chat-pane-reply-navigation.ts";
import {
  CHAT_HISTORY_INTENT_EDGE_PX,
  CHAT_HISTORY_INTENT_IDLE_MS,
  CHAT_HISTORY_TOUCH_INTENT_PX,
  CHAT_HISTORY_UPWARD_KEYS,
  clearPaneSessionHandoff,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import {
  captureChatSessionScrollPosition,
  saveChatSessionScrollPosition,
  scheduleChatScroll,
} from "./scroll.ts";

export abstract class ChatPaneHistory extends ChatPaneReplyNavigation {
  private activeCatalogContinuation: symbol | null = null;
  private activeOlderLoad: Promise<boolean> | null = null;

  protected hasOlderMessages(): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    if (parseCatalogSessionKey(state.sessionKey)) {
      return Boolean(this.catalogCursor && !this.catalogLoading);
    }
    return state.chatHistoryPagination.hasMore && !state.chatLoading;
  }

  protected resetOlderMessagesViewport(): void {
    this.olderLoadGeneration += 1;
    this.activeOlderLoad = null;
    this.resetReplyNavigation();
    this.loadingOlder = false;
    this.historyObserverArmed = false;
    this.historyAutoLoadBlocked = false;
    this.historyIntentConsumed = false;
    this.historyTouchY = null;
    if (this.historyIntentTimer !== null) {
      window.clearTimeout(this.historyIntentTimer);
      this.historyIntentTimer = null;
    }
    this.transcriptScrollTop = null;
    this.olderCursorsSeen.clear();
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
      !this.presented ||
      !this.state?.connected ||
      this.loadingOlder ||
      !this.hasOlderMessages()
    ) {
      this.clearHistoryObserver();
      return;
    }
    const root = this.transcript.scrollElement;
    const sentinel = root?.querySelector<HTMLElement>(".chat-history-sentinel") ?? null;
    if (!root || !sentinel) {
      this.clearHistoryObserver();
      return;
    }
    this.transcriptScrollTop ??= root.scrollTop;
    const threadIsScrollable = root.scrollHeight > root.clientHeight;
    const bootstrap = !this.historyObserverArmed && !threadIsScrollable;
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
          this.presentationId,
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

  protected async showEarlierMessages(): Promise<void> {
    const state = this.state;
    const root = this.transcript.scrollElement;
    if (!state || !root) {
      return;
    }
    if (root.scrollTop > CHAT_HISTORY_INTENT_EDGE_PX) {
      const nextScrollTop = Math.max(0, root.scrollTop - root.clientHeight);
      // Keep the observer's intent tracker aligned so this explicit page-up
      // cannot masquerade as a user scroll and trigger an older-page load.
      this.transcriptScrollTop = nextScrollTop;
      root.scrollTop = nextScrollTop;
      return;
    }
    const sessionKey = state.sessionKey;
    const sessionStillCurrent = () =>
      this.state === state && areUiSessionKeysEquivalent(state.sessionKey, sessionKey);
    const loaded = await this.loadOlderMessages();
    if (!loaded || !sessionStillCurrent()) {
      return;
    }
    await this.updateComplete;
    if (!sessionStillCurrent()) {
      return;
    }
    // The explicit reveal can leave the sentinel visible. Disarm it before the
    // programmatic jump so one click cannot chain another automatic page load.
    this.transcriptScrollTop = 0;
    this.historyObserverArmed = false;
    this.historyAutoLoadBlocked = this.hasOlderMessages();
    this.clearHistoryObserver();
    this.transcript.scrollToOffset(0);
  }

  protected async loadOlderMessages(): Promise<boolean> {
    if (this.activeOlderLoad) {
      return this.activeOlderLoad;
    }
    const load = this.performOlderMessagesLoad();
    this.activeOlderLoad = load;
    try {
      return await load;
    } finally {
      if (this.activeOlderLoad === load) {
        this.activeOlderLoad = null;
      }
    }
  }

  private async performOlderMessagesLoad(): Promise<boolean> {
    const state = this.state;
    const catalogKey = state ? parseCatalogSessionKey(state.sessionKey) : null;
    if (!state || this.loadingOlder || !this.hasOlderMessages()) {
      return false;
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
        if (!pagination.hasMore) {
          return false;
        }
        const requestedOffset = pagination.nextOffset;
        const expectedSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        const result = await loadOlderChatHistoryPage(state, requestedOffset);
        if (!result || generation !== this.olderLoadGeneration) {
          return false;
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
          return true;
        }
        const nextPagination = resolveChatHistoryPagination(result);
        const exhausted = !nextPagination.hasMore || nextPagination.nextOffset <= requestedOffset;
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
        state.lastError = null;
        commitCurrentChatHistorySnapshot(state);
        scheduleChatScroll(state, false);
        prepended = grew || !exhausted;
      }
    } catch (error) {
      if (generation === this.olderLoadGeneration) {
        state.lastError = formatUiError(error);
        // Loading-row removal can emit a layout scroll. Align the tracker so it
        // cannot masquerade as renewed user intent and consume the manual retry.
        this.transcriptScrollTop = this.transcript.scrollElement?.scrollTop ?? null;
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
    return prepended;
  }

  protected async continueCatalogSession(key: CatalogSessionKey) {
    const scope = this.captureConnectionScope();
    const state = scope?.state;
    const client = scope?.client;
    const draft = state?.chatMessage.trim() ?? "";
    // Attachments count as composed content: an image-only continuation must
    // send, not silently no-op while the send button looks live.
    if (!scope || !state || !client || !this.catalogSession?.canContinue) {
      return;
    }
    const attachments = cloneChatAttachmentsForIndependentOwner(state.chatAttachments);
    if (!draft && attachments.length === 0) {
      return;
    }
    const sourceSessionKey = state.sessionKey;
    const sourceAgentId = resolveChatAgentId(state);
    const sourceCatalogGeneration = this.catalogLoadGeneration;
    const continuation = Symbol("catalog-continuation");
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
        {
          ...key,
          agentId: sourceAgentId,
          ...(this.catalogSession.sourceHomeId
            ? { sourceHomeId: this.catalogSession.sourceHomeId }
            : {}),
        },
      );
      // A catalog adoption must not navigate or send into a pane that switched
      // sessions or reconnected while its original continuation was in flight.
      if (
        this.activeCatalogContinuation !== continuation ||
        !this.isConnectionScopeCurrent(scope) ||
        this.catalogLoadGeneration !== sourceCatalogGeneration ||
        state.sessionKey !== sourceSessionKey ||
        resolveChatAgentId(state) !== sourceAgentId
      ) {
        releaseStaleContinuation();
        return;
      }
      preparePaneSessionHandoff(this.context, this.paneId, result.sessionKey, {
        attachments,
        draft,
        send: true,
      });
      if (this.onPaneSessionChange?.(this.paneId, result.sessionKey) === false) {
        clearPaneSessionHandoff(this.context, this.paneId, result.sessionKey);
        releaseStaleContinuation();
        return;
      }
      announceCatalogSessionContinued({
        ...key,
        agentId: sourceAgentId,
        sessionKey: result.sessionKey,
      });
      this.activeCatalogContinuation = null;
      state.chatSending = false;
      state.requestUpdate();
    } catch (error) {
      if (
        this.activeCatalogContinuation !== continuation ||
        !this.isConnectionScopeCurrent(scope) ||
        this.catalogLoadGeneration !== sourceCatalogGeneration ||
        state.sessionKey !== sourceSessionKey ||
        resolveChatAgentId(state) !== sourceAgentId
      ) {
        releaseStaleContinuation();
        return;
      }
      this.activeCatalogContinuation = null;
      state.lastError = formatUiError(error);
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
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const state = scope.state;
    const sourceKey = state.sessionKey;
    const agentParams = scopedAgentParamsForSession(state, sourceKey);
    try {
      const result = await state.sessions.forkAtMessage(sourceKey, entryId, agentParams);
      const editorText = result.editorText ?? "";
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !visibleSessionMatches(state, sourceKey, agentParams.agentId)
      ) {
        return;
      }
      if (this.onPaneSessionChange?.(this.paneId, result.sessionKey) === false) {
        return;
      }
      persistChatComposerState(state, result.sessionKey, {
        agentId: parseAgentSessionKey(result.sessionKey)?.agentId,
        draft: editorText,
      });
      preparePaneSessionHandoff(this.context, this.paneId, result.sessionKey, {
        attachments: replaceChatAttachmentsFromEditor([], result.editorAttachments),
        draft: editorText,
      });
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !visibleSessionMatches(state, sourceKey, agentParams.agentId)
      ) {
        return;
      }
      state.lastError = formatUiError(error);
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
