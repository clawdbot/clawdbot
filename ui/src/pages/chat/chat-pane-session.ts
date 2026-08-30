import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type {
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { clampText } from "../../lib/format.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  summarizeSessionPullRequests,
  scopedSessionPullRequestKey,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../../lib/session-pull-requests.ts";
import {
  lookupCatalogSession,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey, scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { catalogMessageId } from "./catalog-message-id.ts";
import { loadChatBranches } from "./chat-history.ts";
import {
  CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS,
  catalogRawResult,
  catalogRawString,
  nativeHistoryMessageIdentity,
} from "./chat-pane-shared.ts";
import { ChatPaneTaskSuggestions } from "./chat-pane-task-suggestions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  resolveChatAgentId,
  saveRouteSessionSettings,
  selectedChatSessionRow,
} from "./chat-state-route.ts";
import {
  dismissChatPullRequest,
  listDismissedChatPullRequests,
} from "./components/chat-pull-requests.ts";
import { scheduleChatScroll } from "./scroll.ts";

export abstract class ChatPaneSession extends ChatPaneTaskSuggestions {
  private deferredSessionHydrationActive = false;
  private pendingDeferredSessionHydration: (() => void) | null = null;

  protected async refreshSessionPullRequests(options: { refresh?: boolean } = {}): Promise<void> {
    if (!this.presented) {
      sessionPullRequestsForGateway(this.context.gateway).unwatch(this);
      return;
    }
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !isGatewayMethodAdvertised(
        scope.context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      )
    ) {
      if (scope) {
        sessionPullRequestsForGateway(scope.context.gateway).unwatch(this);
      }
      this.sessionPullRequests = [];
      this.sessionPullRequestsBranch = undefined;
      this.githubPublicationResult = null;
      this.githubPublicationError = null;
      this.githubPublicationIdempotencyKey = null;
      this.githubPublicationBusy = false;
      this.sessionPullRequestsRateLimited = false;
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (!sessionKey.trim() || parseCatalogSessionKey(sessionKey)) {
      sessionPullRequestsForGateway(scope.context.gateway).unwatch(this);
      this.sessionPullRequests = [];
      this.sessionPullRequestsBranch = undefined;
      this.sessionPullRequestsRateLimited = false;
      this.requestUpdate();
      return;
    }
    const pullRequestEpoch = scope.context.sessions.capturePullRequestEpoch(sessionKey);
    const store = sessionPullRequestsForGateway(scope.context.gateway);
    const pullRequestKey = scopedSessionPullRequestKey(
      sessionKey,
      scopedAgentParamsForSession(scope.state, sessionKey).agentId ??
        resolveChatAgentId(scope.state),
    );
    store.watch(this, [pullRequestKey], { foreground: true });
    if (options.refresh) {
      store.refresh(pullRequestKey);
    }
    const result = store.get(pullRequestKey);
    if (!this.isConnectionScopeCurrent(scope) || sessionKey !== scope.state.sessionKey) {
      return;
    }
    if (!result) {
      if (this.sessionPullRequests.length > 0 || this.sessionPullRequestsBranch !== undefined) {
        scope.context.sessions.setPullRequestSummary(sessionKey, undefined, pullRequestEpoch);
      }
      this.sessionPullRequests = [];
      this.sessionPullRequestsBranch = undefined;
      this.sessionPullRequestsRateLimited = false;
      this.dismissedSessionPullRequestIds = new Set();
      this.requestUpdate();
      return;
    }
    if (result.status === "unavailable") {
      return;
    }
    this.sessionPullRequests = result.pullRequests;
    if (!result.rateLimited || result.pullRequests.length > 0) {
      const previousSummary = scope.context.sessions.pullRequestSummary(sessionKey);
      scope.context.sessions.setPullRequestSummary(
        sessionKey,
        summarizeSessionPullRequests(result.pullRequests, previousSummary),
        pullRequestEpoch,
      );
    }
    const published =
      this.githubPublicationResult?.status === "published"
        ? this.githubPublicationResult
        : undefined;
    const publishedPullRequest = published
      ? result.pullRequests.find((pullRequest) => pullRequest.url === published.url)
      : undefined;
    if (
      result.branch &&
      published &&
      (result.branch.branch !== published.branch ||
        (publishedPullRequest &&
          publishedPullRequest.state !== "open" &&
          publishedPullRequest.state !== "draft"))
    ) {
      this.githubPublicationResult = null;
      this.githubPublicationError = null;
      this.githubPublicationIdempotencyKey = null;
    }
    this.sessionPullRequestsBranch = result.branch;
    this.sessionPullRequestsRateLimited = result.rateLimited;
    this.dismissedSessionPullRequestIds = listDismissedChatPullRequests(sessionKey);
    this.requestUpdate();
  }

  protected resetSessionPullRequests(): void {
    this.githubPublicationRequestVersion += 1;
    sessionPullRequestsForGateway(this.context.gateway).unwatch(this);
    this.sessionPullRequests = [];
    this.sessionPullRequestsBranch = undefined;
    this.sessionPullRequestsRateLimited = false;
    this.sessionPullRequestsExpanded = false;
    this.githubPublicationResult = null;
    this.githubPublicationError = null;
    this.githubPublicationIdempotencyKey = null;
    this.githubPublicationBusy = false;
    this.dismissedSessionPullRequestIds = new Set();
  }

  protected readonly dismissSessionPullRequest = (
    pullRequest: ControlUiSessionPullRequest,
  ): void => {
    const sessionKey = this.state?.sessionKey;
    if (!sessionKey) {
      return;
    }
    this.dismissedSessionPullRequestIds = dismissChatPullRequest(sessionKey, pullRequest);
    this.requestUpdate();
  };

  protected deferSessionHydrationUntilTranscript(
    sessionKey: string,
    transcriptLoad: Promise<boolean>,
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    this.deferredSessionHydrationActive = true;
    this.pendingDeferredSessionHydration = null;
    const requestVersion = ++this.deferredSessionHydrationRequestVersion;
    const connectionGeneration = this.connectionGeneration;
    const client = state.client;
    const retireIfCurrent = () => {
      if (this.deferredSessionHydrationRequestVersion === requestVersion) {
        this.deferredSessionHydrationActive = false;
        this.pendingDeferredSessionHydration = null;
      }
    };
    const isCurrent = () =>
      this.deferredSessionHydrationRequestVersion === requestVersion &&
      this.connectionGeneration === connectionGeneration &&
      this.state === state &&
      state.connected &&
      state.client === client &&
      state.sessionKey === sessionKey;
    const scheduleHydration = (historyCommitted: boolean) => {
      if (!isCurrent()) {
        retireIfCurrent();
        return;
      }
      if (!this.presented) {
        this.pendingDeferredSessionHydration = () => scheduleHydration(historyCommitted);
        return;
      }
      this.pendingDeferredSessionHydration = null;
      // These affordances do not shape the transcript. Start them together only
      // after the authoritative history has committed so they cannot delay chat paint.
      state.renderLifecycle.afterCommit((complete) => {
        if (isCurrent() && this.presented) {
          this.deferredSessionHydrationActive = false;
          if (historyCommitted) {
            this.markSessionRead(selectedChatSessionRow(state));
          }
          void loadChatBranches(state);
          void this.probeSessionDiscussion(sessionKey);
          this.hydrateSessionCompanion(sessionKey);
          void this.refreshSessionPullRequests();
        } else if (isCurrent()) {
          this.pendingDeferredSessionHydration = () => scheduleHydration(historyCommitted);
        } else {
          retireIfCurrent();
        }
        complete();
      });
    };
    void transcriptLoad.then(scheduleHydration, () => scheduleHydration(false));
  }

  protected resumeDeferredSessionHydration(): boolean {
    const resume = this.pendingDeferredSessionHydration;
    this.pendingDeferredSessionHydration = null;
    resume?.();
    return this.deferredSessionHydrationActive;
  }

  protected retireDeferredSessionHydration(): void {
    this.deferredSessionHydrationRequestVersion += 1;
    this.deferredSessionHydrationActive = false;
    this.pendingDeferredSessionHydration = null;
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
    const unread = row.unread === true || unreadFailure || agentStatusActive;
    if (!unread) {
      this.unreadPatchGuard.shouldPatch(state.sessionKey, false, row.markedUnreadAt);
      return;
    }
    const agentId = parseAgentSessionKey(row.key)?.agentId ?? resolveChatAgentId(state);
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: row.key, unread: false, agentId },
    });
    // Read-only navigation must remain silent: absence of mutation access is
    // not an operation failure and should not latch the unread retry guard.
    if (
      !access.allowed ||
      !this.unreadPatchGuard.shouldPatch(state.sessionKey, true, row.markedUnreadAt)
    ) {
      return;
    }
    const guardKey = state.sessionKey;
    void this.context.sessions
      .patch(
        row.key,
        { unread: false },
        { agentId, expectedMarkedUnreadAt: row.markedUnreadAt ?? null },
      )
      .then(
        (result) => {
          // A null result means no request was sent (connection scope lost);
          // unlatch like a failure or the badge stays lit until navigation.
          if (result === null) {
            this.unreadPatchGuard.patchFailed(guardKey);
          }
        },
        () => {
          // Unlatch so later unread snapshots retry; the session capability
          // publishes the actionable error for the owning page.
          this.unreadPatchGuard.patchFailed(guardKey);
        },
      );
  }

  protected async restoreArchivedSession(sessionKey: string, expectedSessionId: string) {
    const scope = this.captureConnectionScope();
    if (!scope || scope.state.sessionKey !== sessionKey) {
      return;
    }
    const access = readSessionMethodAccess(scope.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, archived: false },
    });
    if (!access.allowed) {
      scope.state.lastError = access.reason;
      scope.state.chatError = access.reason;
      scope.state.requestUpdate?.();
      return;
    }
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? resolveChatAgentId(scope.state);
    let failure: string | null = null;
    try {
      // The patch can resolve falsy on failure; the capability error explains it.
      const patched = await scope.sessions.patch(
        sessionKey,
        { archived: false },
        { agentId, expectedSessionId },
      );
      if (!patched) {
        failure = scope.sessions.state.error;
      }
    } catch (error) {
      failure = formatUiError(error);
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
      !this.presented ||
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

  protected openCatalogSession(key: CatalogSessionKey, state: ChatPageHost) {
    this.catalogRequestedSessionKey = this.sessionKey;
    this.catalogMessages = [];
    this.catalogCursor = undefined;
    this.catalogSession = null;
    this.catalogHost = null;
    // Payload-store entries and their object URLs are reclaimed only by
    // explicit release; clearing the array alone strands them for the tab.
    releaseChatAttachmentPayloads(state.chatAttachments);
    state.chatAttachments = [];
    state.chatLoading = true;
    state.requestUpdate();
    void this.loadCatalogSession(key, false);
  }

  protected catalogItemMessage(item: SessionCatalogTranscriptItem): Record<string, unknown> | null {
    const timestamp = parseDateStringTimestampMs(item.timestamp) ?? null;
    const text = item.text?.trim() ? item.text : null;
    if (item.type === "userMessage") {
      return text
        ? {
            role: "user",
            // Missing source attribution must never fall back to the current viewer.
            senderLabel: item.sender?.label ?? t("sessionsView.user"),
            ...(item.sender
              ? {
                  __openclaw: {
                    senderIdentity: item.sender.identity,
                    senderId: item.sender.identity.id,
                    senderName: item.sender.label,
                    senderProfileAvatarUrl: item.sender.avatarUrl,
                  },
                }
              : {}),
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
    const agentId = resolveChatAgentId(state);
    const generation = older ? this.catalogLoadGeneration : ++this.catalogLoadGeneration;
    const requestedSessionKey = this.sessionKey;
    const isCurrent = () =>
      generation === this.catalogLoadGeneration &&
      this.sessionKey === requestedSessionKey &&
      resolveChatAgentId(state) === agentId;
    if (!older) {
      this.catalogLoading = true;
      this.catalogCursor = undefined;
      this.olderCursorsSeen.clear();
      this.historyObserverArmed = false;
      this.transcriptScrollTop = null;
      this.historyObserver?.disconnect();
      this.historyObserver = null;
    }
    try {
      if (!older) {
        const lookup = await lookupCatalogSession({ agentId, client, key, isCurrent });
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
        agentId,
        catalogId: key.catalogId,
        hostId: key.hostId,
        threadId: key.threadId,
        ...(this.catalogSession?.sourceHomeId
          ? { sourceHomeId: this.catalogSession.sourceHomeId }
          : {}),
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
      const addedMessages = nextMessages.length > this.catalogMessages.length;
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
      return !older || addedMessages || !olderExhausted;
    } catch (error) {
      if (isCurrent()) {
        (this.state ?? state).lastError = formatUiError(error);
      }
      return false;
    } finally {
      if (isCurrent()) {
        const currentState = this.state ?? state;
        if (!older) {
          this.catalogLoading = false;
          currentState.chatLoading = false;
        }
        if (!older) {
          currentState.requestUpdate();
        }
      }
    }
  }
}
