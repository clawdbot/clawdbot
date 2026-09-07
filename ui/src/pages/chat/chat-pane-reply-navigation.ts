import type { ChatMessageGetResult } from "../../../../packages/gateway-protocol/src/index.js";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  canonicalUiSessionKeyForPersistence,
  areUiSessionKeysEquivalent,
} from "../../lib/sessions/session-key.ts";
import { ChatBookmarks, type ChatBookmark, type ChatBookmarkAccess } from "./chat-bookmarks.ts";
import { ChatPaneSession } from "./chat-pane-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { persistedMessageEntryId } from "./chat-thread.ts";
import { renderChatBookmarksDialog } from "./components/chat-bookmarks-dialog.ts";
import {
  closeTranscriptSearch,
  getTranscriptState,
} from "./components/chat-thread-interactions.ts";

export abstract class ChatPaneReplyNavigation extends ChatPaneSession {
  protected readonly bookmarks = new ChatBookmarks(() => this.requestUpdate());

  protected syncBookmarks(): ChatBookmarkAccess | undefined {
    const connection = this.captureConnectionScope();
    const snapshot = this.context.gateway.snapshot;
    const identity = snapshot.selfUser?.identity;
    const state = this.state;
    const selectedKey = state?.sessionKey ?? "";
    const key = state ? canonicalUiSessionKeyForPersistence(state, selectedKey) : "";
    const sessionId = state?.currentSessionId ?? "";
    const agentId = state ? resolveChatAgentId(state) : "";
    const profileId = identity?.type === "profile" ? identity.id : null;
    const canWrite = hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    const previousScope = this.bookmarks.scope;
    this.bookmarks.bind(
      connection &&
        profileId &&
        sessionId &&
        !selectedChatSessionRow(connection.state)?.incognito &&
        !state?.selectedChatSessionIncognito &&
        !isIncognitoSessionKey(key) &&
        !parseCatalogSessionKey(key) &&
        hasOperatorReadAccess(snapshot.hello?.auth ?? null)
        ? {
            client: connection.client,
            generation: connection.generation,
            profileId,
            agentId,
            key,
            sessionId,
            canWrite,
            isCurrent: () =>
              this.isConnectionScopeCurrent(connection) &&
              connection.state.sessionKey === selectedKey &&
              connection.state.currentSessionId === sessionId &&
              resolveChatAgentId(connection.state) === agentId &&
              this.context.gateway.snapshot.selfUser?.identity?.type === "profile" &&
              this.context.gateway.snapshot.selfUser.identity.id === profileId &&
              !selectedChatSessionRow(connection.state)?.incognito &&
              !connection.state.selectedChatSessionIncognito &&
              hasOperatorReadAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
              hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) ===
                canWrite,
          }
        : null,
    );
    const scope = this.bookmarks.scope;
    const transcriptState = getTranscriptState(this.presentationId);
    const reveal = transcriptState.bookmarkReveal;
    if (
      scope !== previousScope ||
      (reveal &&
        (reveal.showToolCalls !== state?.settings.chatShowToolCalls ||
          reveal.persistCommentary !== (state?.settings.chatPersistCommentary !== false)))
    ) {
      transcriptState.bookmarkReveal = undefined;
    }
    if (!scope) {
      return undefined;
    }
    const current = () => this.bookmarks.scope === scope && scope.isCurrent();
    return {
      revision: this.bookmarks.revision,
      bookmarks: this.bookmarks.conversationBookmarks.filter(
        (item) => item.sessionId === sessionId,
      ),
      selectedId: this.bookmarks.selectedId,
      toggle:
        scope.canWrite && this.bookmarks.indexReady
          ? (id) => {
              if (current()) {
                this.bookmarks.toggle(id);
              }
            }
          : undefined,
      edit:
        scope.canWrite && this.bookmarks.indexReady
          ? (id) => {
              if (current()) {
                this.bookmarks.edit(id);
              }
            }
          : undefined,
      open: (bookmark) => {
        if (current()) {
          this.openBookmark(bookmark);
        }
      },
    };
  }

  private openBookmark(bookmark: ChatBookmark): void {
    const scope = this.bookmarks.scope;
    const state = this.state;
    if (!state || !scope?.isCurrent() || !this.bookmarks.canOpen(bookmark)) {
      return;
    }
    this.bookmarks.selectedId = bookmark.id;
    this.bookmarks.open = false;
    const transcriptState = getTranscriptState(this.presentationId);
    transcriptState.bookmarkReveal = {
      messageId: bookmark.messageId,
      showToolCalls: state.settings.chatShowToolCalls,
      persistCommentary: state.settings.chatPersistCommentary !== false,
    };
    closeTranscriptSearch(transcriptState, () => this.requestUpdate());
    this.openReplyMessage(bookmark.messageId);
  }

  protected renderBookmarksDialog() {
    return renderChatBookmarksDialog(this.bookmarks, {
      update: () => this.requestUpdate(),
      open: (bookmark) => this.openBookmark(bookmark),
    });
  }

  override disconnectedCallback() {
    this.bookmarks.bind(null);
    super.disconnectedCallback();
  }

  private activeReplyNavigation: symbol | null = null;
  private replyNavigationSessionKey: string | null = null;
  protected replyNavigationId: string | null = null;
  protected replyMessageRevision = 0;
  private readonly replyMessages = new Map<
    string,
    { client: object; generation: number; message?: unknown }
  >();

  protected abstract loadOlderMessages(): Promise<boolean>;

  protected readonly readReplyMessage = (messageId: string): unknown => {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    const cached = this.replyMessages.get(this.replyMessageCacheKey(state.sessionKey, messageId));
    return cached?.client === state.client && cached.generation === this.connectionGeneration
      ? cached.message
      : undefined;
  };

  protected readonly requestReplyMessage = (messageId: string): void => {
    void this.loadReplyMessage(messageId);
  };

  protected readonly openReplyMessage = (messageId: string): void => {
    void this.navigateToReplyMessage(messageId);
  };

  private replyMessageCacheKey(sessionKey: string, messageId: string): string {
    const state = this.state;
    const agentId = state ? scopedAgentParamsForSession(state, sessionKey).agentId : undefined;
    return `${sessionKey}\u0000${agentId ?? ""}\u0000${messageId}`;
  }

  private async loadReplyMessage(messageId: string): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope || parseCatalogSessionKey(scope.state.sessionKey)) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const agentId = scopedAgentParamsForSession(scope.state, sessionKey).agentId;
    const cacheKey = this.replyMessageCacheKey(sessionKey, messageId);
    const cached = this.replyMessages.get(cacheKey);
    if (cached?.client === scope.client && cached.generation === scope.generation) {
      return;
    }
    while (this.replyMessages.size >= 256) {
      this.replyMessages.delete(this.replyMessages.keys().next().value!);
    }
    const attempt = { client: scope.client, generation: scope.generation };
    this.replyMessages.set(cacheKey, attempt);
    let result: ChatMessageGetResult;
    try {
      result = await scope.client.request<ChatMessageGetResult>("chat.message.get", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        messageId,
        maxChars: 500,
      });
    } catch {
      // Retain the failed attempt so rendering cannot retry it in a loop.
      // A new logical connection owns a fresh attempt, even with the same client.
      return;
    }
    if (!this.isConnectionScopeCurrent(scope) || this.replyMessages.get(cacheKey) !== attempt) {
      return;
    }
    if (!result.ok || !result.message) {
      return;
    }
    this.replyMessages.set(cacheKey, { ...attempt, message: result.message });
    this.replyMessageRevision += 1;
    if (areUiSessionKeysEquivalent(scope.state.sessionKey, sessionKey)) {
      this.requestUpdate();
    }
  }

  private replyNavigationIsCurrent(
    navigation: symbol,
    state: ChatPageHost,
    sessionKey: string,
    sessionId: string,
  ): boolean {
    return (
      this.activeReplyNavigation === navigation &&
      this.state === state &&
      areUiSessionKeysEquivalent(state.sessionKey, sessionKey) &&
      (!sessionId || state.currentSessionId === sessionId)
    );
  }

  protected currentReplyNavigationId(sessionKey: string): string | null {
    return this.replyNavigationSessionKey &&
      areUiSessionKeysEquivalent(this.replyNavigationSessionKey, sessionKey)
      ? this.replyNavigationId
      : null;
  }

  protected currentReplyMessageAccess(sessionKey: string) {
    return {
      revision: this.replyMessageRevision,
      navigationId: this.currentReplyNavigationId(sessionKey),
      read: this.readReplyMessage,
      request: this.requestReplyMessage,
      open: this.openReplyMessage,
    };
  }

  protected resetReplyNavigation(): void {
    this.activeReplyNavigation = null;
    this.replyNavigationSessionKey = null;
    this.replyNavigationId = null;
  }

  private async navigateToReplyMessage(messageId: string): Promise<void> {
    const state = this.state;
    if (!state || parseCatalogSessionKey(state.sessionKey)) {
      return;
    }
    const sessionKey = state.sessionKey;
    const sessionId = state.currentSessionId?.trim() ?? "";
    const navigation = Symbol("reply-navigation");
    this.activeReplyNavigation = navigation;
    this.replyNavigationSessionKey = sessionKey;
    this.replyNavigationId = messageId;
    this.requestUpdate();
    try {
      while (
        !state.chatMessages.some((message) => persistedMessageEntryId(message) === messageId)
      ) {
        if (!this.replyNavigationIsCurrent(navigation, state, sessionKey, sessionId)) {
          return;
        }
        if (!state.chatHistoryPagination.hasMore) {
          if (this.replyNavigationIsCurrent(navigation, state, sessionKey, sessionId)) {
            state.lastError = t("chat.messages.originalUnavailable");
            state.requestUpdate?.();
          }
          return;
        }
        const loaded = await this.loadOlderMessages();
        if (!this.replyNavigationIsCurrent(navigation, state, sessionKey, sessionId)) {
          return;
        }
        if (!loaded) {
          if (!state.chatHistoryPagination.hasMore && !state.lastError) {
            state.lastError = t("chat.messages.originalUnavailable");
            state.requestUpdate?.();
          }
          return;
        }
      }
      if (!this.replyNavigationIsCurrent(navigation, state, sessionKey, sessionId)) {
        return;
      }
      this.requestUpdate();
      await this.updateComplete;
      if (this.replyNavigationIsCurrent(navigation, state, sessionKey, sessionId)) {
        if (!this.transcript.revealMessage(messageId)) {
          state.lastError = t("chat.messages.originalUnavailable");
          state.requestUpdate?.();
        }
      }
    } finally {
      if (this.activeReplyNavigation === navigation) {
        this.resetReplyNavigation();
        this.requestUpdate();
      }
    }
  }
}
