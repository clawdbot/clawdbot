import type {
  SessionSuggestion,
  SessionSuggestionEvent,
  SessionSuggestionResolution,
  SessionSuggestionsListResult,
  SessionTypingEvent,
  TaskSuggestion,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionMembersListResult,
  SessionVisibility,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { hasMultiplePresenceIdentities } from "../../lib/presence-users.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  type ChatPaneConnectionScope,
} from "./chat-pane-shared.ts";
import { resetSessionCompanion } from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { clearTypingActorForSessionMessage } from "./chat-typing-presence.ts";
import {
  canManageChatSessionSharing,
  type ChatSessionSharingState,
} from "./components/chat-session-sharing.ts";

type HeaderScope = ChatPaneConnectionScope;

export abstract class ChatPaneSharing extends ChatPaneBase {
  protected readonly clearSessionCompanion = async () => {
    const scope = this.captureConnectionScope();
    const key = scope?.state.sessionKey;
    if (!scope || !key) {
      return;
    }
    const agentId = resolveChatAgentId(scope.state);
    await this.sessionCompanionThreads
      .reset(key, (sessionKey) => resetSessionCompanion(scope.client, sessionKey, agentId), agentId)
      .catch((error: unknown) => {
        if (
          this.presented &&
          this.isConnectionScopeCurrent(scope) &&
          scope.state.sessionKey === key
        ) {
          this.publishHeaderError(error);
        }
      });
  };

  protected setSessionSharingState(cacheKey: string, state: ChatSessionSharingState): void {
    this.sessionSharingStates = new Map(this.sessionSharingStates).set(cacheKey, state);
  }

  protected sessionSharingAgentId(sessionKey: string): string | undefined {
    if (sessionKey !== "global") {
      return parseAgentSessionKey(sessionKey)?.agentId;
    }
    return this.state ? resolveChatAgentId(this.state) : undefined;
  }

  protected sessionSharingCacheKey(sessionKey: string): string {
    return `${this.sessionSharingAgentId(sessionKey) ?? ""}\0${sessionKey}`;
  }

  protected currentSessionSharingRow(
    scope: ChatPaneConnectionScope,
    row: GatewaySessionRow,
  ): GatewaySessionRow | null {
    const current = scope.state.sessionsResult?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, row.key),
    );
    if (!current || !canManageChatSessionSharing(row) || !canManageChatSessionSharing(current)) {
      return null;
    }
    if (current === row) {
      return current;
    }
    const rowSessionId = row.sessionId?.trim();
    const currentSessionId = current.sessionId?.trim();
    return rowSessionId && currentSessionId && rowSessionId === currentSessionId ? current : null;
  }

  protected async loadSessionSharing(row: GatewaySessionRow, force = false): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (
      !scope ||
      !currentRow ||
      !readSessionMethodAccess(scope.context.gateway.snapshot, {
        method: "session.members.list",
        requiredScope: "operator.read",
      }).allowed
    ) {
      return;
    }
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const current = this.sessionSharingStates.get(cacheKey);
    if (current?.loading && !force) {
      return;
    }
    // Sharing data (membership + paired identities) is connection-scoped. A
    // gateway/account change bumps the generation and clears this cache, so a
    // request that resolves after the switch must be dropped rather than
    // overwrite the new connection's menu with the previous account's data.
    // Object identity also owns this key's request slot: same-key session
    // replacement or a forced reload must not let an older request win.
    const loadingState = { ...current, loading: true, error: undefined };
    const ownsLoadingState = () => this.sessionSharingStates.get(cacheKey) === loadingState;
    const clearOwnedLoadingState = () => {
      if (!ownsLoadingState()) {
        return;
      }
      const next = new Map(this.sessionSharingStates);
      next.delete(cacheKey);
      this.sessionSharingStates = next;
    };
    this.setSessionSharingState(cacheKey, loadingState);
    try {
      const result = await scope.client.request<SessionMembersListResult>("session.members.list", {
        sessionKey: currentRow.key,
        ...(this.sessionSharingAgentId(currentRow.key)
          ? { agentId: this.sessionSharingAgentId(currentRow.key) }
          : {}),
      });
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow) ||
        !ownsLoadingState()
      ) {
        if (this.isConnectionScopeCurrent(scope)) {
          clearOwnedLoadingState();
        }
        return;
      }
      this.setSessionSharingState(cacheKey, { loading: false, result });
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow) ||
        !ownsLoadingState()
      ) {
        if (this.isConnectionScopeCurrent(scope)) {
          clearOwnedLoadingState();
        }
        return;
      }
      this.setSessionSharingState(cacheKey, { loading: false, error: formatUiError(error) });
    }
  }

  protected failSharing(scope: HeaderScope, key: string, session: string, error: unknown): void {
    if (!this.ownsHeaderOutcomeScope(scope)) {
      return;
    }
    this.setSessionSharingState(key, {
      ...(this.sessionSharingStates.get(key) ?? { loading: false }),
      loading: false,
      error: formatUiError(error),
    });
    // Sharing errors stay with their session; the visible slot belongs only to the selected session.
    if (areUiSessionKeysEquivalent(this.state?.sessionKey, session)) {
      this.publishHeaderError(error, scope.headerOutcomeOwner);
    }
  }

  protected async setSessionVisibility(
    row: GatewaySessionRow,
    visibility: SessionVisibility,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (!scope || !currentRow || visibility === currentRow.visibility) {
      return;
    }
    const agentId = this.sessionSharingAgentId(currentRow.key);
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const params = {
      sessionKey: currentRow.key,
      visibility,
      ...(agentId ? { agentId } : {}),
    };
    if (
      !readSessionMethodAccess(scope.context.gateway.snapshot, {
        method: "session.visibility.set",
        requiredScope: "operator.write",
      }).allowed
    ) {
      return;
    }
    try {
      await scope.client.request("session.visibility.set", params);
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      await scope.sessions.refreshReplacement(agentId);
      const refreshedRow = this.currentSessionSharingRow(scope, currentRow);
      if (!this.ownsHeaderOutcomeScope(scope) || !refreshedRow) {
        return;
      }
      await this.loadSessionSharing(refreshedRow, true);
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      this.failSharing(scope, cacheKey, currentRow.key, error);
    }
  }

  protected async setSessionMember(
    row: GatewaySessionRow,
    identityId: string,
    member: boolean,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (!scope || !currentRow) {
      return;
    }
    const agentId = this.sessionSharingAgentId(currentRow.key);
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const method = member ? "session.members.add" : "session.members.remove";
    const params = {
      sessionKey: currentRow.key,
      identityId,
      ...(agentId ? { agentId } : {}),
    };
    if (
      !readSessionMethodAccess(scope.context.gateway.snapshot, {
        method,
        requiredScope: "operator.write",
      }).allowed
    ) {
      return;
    }
    try {
      await scope.client.request(method, params);
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      await this.loadSessionSharing(currentRow, true);
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      await scope.sessions.refreshReplacement(agentId);
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      this.failSharing(scope, cacheKey, currentRow.key, error);
    }
  }

  protected captureConnectionScope(): ChatPaneConnectionScope | null {
    const state = this.state;
    if (!state?.client) {
      return null;
    }
    const scope = {
      context: this.context,
      state,
      client: state.client,
      generation: this.connectionGeneration,
      headerOutcomeOwner: this.headerOutcomeOwner,
      sessions: this.context.sessions,
    };
    return this.isConnectionScopeCurrent(scope) ? scope : null;
  }

  protected isConnectionScopeCurrent(scope: ChatPaneConnectionScope): boolean {
    return (
      this.isConnected &&
      this.context === scope.context &&
      this.state === scope.state &&
      scope.state.connected &&
      scope.state.client === scope.client &&
      this.connectedClient === scope.client &&
      scope.context.gateway.snapshot.phase === "connected" &&
      scope.context.gateway.snapshot.client === scope.client &&
      this.connectionGeneration === scope.generation
    );
  }

  protected ownsHeaderOutcomeScope(scope: HeaderScope): boolean {
    return this.isConnectionScopeCurrent(scope) && this.ownsHeaderOutcome(scope.headerOutcomeOwner);
  }

  protected suggestionMatchesCurrentSession(
    suggestion: Pick<TaskSuggestion | SessionSuggestion, "agentId" | "sessionKey">,
  ): boolean {
    const state = this.state;
    return Boolean(
      state?.connected &&
      uiSessionEventMatches(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
          sessionKey: state.sessionKey,
        },
        suggestion.sessionKey,
        suggestion.agentId,
      ),
    );
  }

  protected hasMultipleIdentities(): boolean {
    return hasMultiplePresenceIdentities(this.presencePayload);
  }

  protected isCurrentSessionArchived(state: ChatPageHost): boolean {
    return (
      state.selectedChatSessionArchived ||
      state.sessionsResult?.sessions.some(
        (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, state.sessionKey),
      ) === true
    );
  }

  protected resetSessionSuggestions(): void {
    this.sessionSuggestionsRequestVersion += 1;
    this.sessionSuggestionsRefreshQueued = false;
    this.sessionSuggestions = [];
    this.sessionSuggestionRole = undefined;
    this.sessionSuggestionBusyIds.clear();
    this.sessionSuggestionAddOperation = undefined;
    this.sessionSuggestionEditOperation = undefined;
  }

  protected syncSessionSuggestionTarget(
    agentId: string,
    session: GatewaySessionRow | undefined,
  ): void {
    const signature = session
      ? `${agentId}\0${session.key}\0${session.sessionId ?? ""}\0${session.visibility ?? "shared"}\0${session.sharingRole ?? "owner"}`
      : "";
    if (signature === this.sessionSuggestionTargetSignature) {
      return;
    }
    this.sessionSuggestionTargetSignature = signature;
    this.resetSessionSuggestions();
    this.clearTypingActors();
    void this.refreshSessionSuggestions();
  }

  protected refreshSessionSuggestions(): Promise<void> {
    if (this.sessionSuggestionsRefreshPromise) {
      if (this.sessionSuggestionsRefreshVersion !== this.sessionSuggestionsRequestVersion) {
        this.sessionSuggestionsRefreshQueued = true;
      }
      return this.sessionSuggestionsRefreshPromise;
    }
    const requestVersion = ++this.sessionSuggestionsRequestVersion;
    this.sessionSuggestionsRefreshVersion = requestVersion;
    const refresh = this.loadSessionSuggestions(requestVersion);
    const tracked = refresh.finally(() => {
      if (this.sessionSuggestionsRefreshPromise !== tracked) {
        return;
      }
      this.sessionSuggestionsRefreshPromise = undefined;
      this.sessionSuggestionsRefreshVersion = undefined;
      if (this.sessionSuggestionsRefreshQueued) {
        this.sessionSuggestionsRefreshQueued = false;
        void this.refreshSessionSuggestions();
      }
    });
    this.sessionSuggestionsRefreshPromise = tracked;
    return tracked;
  }

  protected async loadSessionSuggestions(requestVersion: number): Promise<void> {
    const targetSignature = this.sessionSuggestionTargetSignature;
    const scope = this.captureConnectionScope();
    const row = scope?.state.sessionsResult?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, scope.state.sessionKey),
    );
    // Solo dormancy intentionally hides persisted rows too; when a second identity
    // returns, the presence transition below triggers a fresh authoritative list.
    if (
      !scope ||
      !row ||
      !this.hasMultipleIdentities() ||
      !isGatewayMethodAdvertised(scope.context.gateway.snapshot, "session.suggestions.list")
    ) {
      this.sessionSuggestions = [];
      this.sessionSuggestionRole = undefined;
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    try {
      const result = await scope.client.request<SessionSuggestionsListResult>(
        "session.suggestions.list",
        {
          sessionKey,
          ...scopedAgentParamsForSession(scope.state, sessionKey),
        },
      );
      if (!this.isConnectionScopeCurrent(scope) || scope.state.sessionKey !== sessionKey) {
        return;
      }
      if (
        requestVersion !== this.sessionSuggestionsRequestVersion ||
        targetSignature !== this.sessionSuggestionTargetSignature
      ) {
        return;
      }
      this.sessionSuggestions = result.suggestions;
      this.sessionSuggestionRole = result.role;
      this.requestUpdate();
    } catch {
      if (
        requestVersion === this.sessionSuggestionsRequestVersion &&
        targetSignature === this.sessionSuggestionTargetSignature
      ) {
        this.sessionSuggestions = [];
        this.sessionSuggestionRole = undefined;
        this.requestUpdate();
      }
    }
  }

  protected handleSessionSuggestionEvent(event: SessionSuggestionEvent): void {
    if (!this.hasMultipleIdentities() || !this.suggestionMatchesCurrentSession(event.suggestion)) {
      return;
    }
    const shouldRefresh =
      this.sessionSuggestionsRefreshPromise !== undefined ||
      this.sessionSuggestionRole !== undefined;
    this.sessionSuggestionsRequestVersion += 1;
    const selfId = this.context.gateway.snapshot.selfUser?.id;
    if (this.sessionSuggestionRole === "viewer" && event.suggestion.author.id !== selfId) {
      return;
    }
    if (event.action === "added") {
      this.sessionSuggestions = [
        ...this.sessionSuggestions.filter((item) => item.id !== event.suggestion.id),
        event.suggestion,
      ].toSorted(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
    } else if (event.suggestion.author.id === selfId) {
      this.sessionSuggestions = this.sessionSuggestions.map((item) =>
        item.id === event.suggestion.id ? event.suggestion : item,
      );
    } else {
      this.sessionSuggestions = this.sessionSuggestions.filter(
        (item) => item.id !== event.suggestion.id,
      );
    }
    this.sessionSuggestionBusyIds.delete(event.suggestion.id);
    this.requestUpdate();
    if (shouldRefresh) {
      void this.refreshSessionSuggestions();
    }
  }

  protected async addCurrentSessionSuggestion(): Promise<void> {
    const scope = this.captureConnectionScope();
    const text = scope?.state.chatMessage ?? "";
    if (
      !scope ||
      !text.trim() ||
      this.sessionSuggestionAddOperation ||
      !this.hasMultipleIdentities()
    ) {
      return;
    }
    if (scope.state.chatAttachments.length > 0) {
      scope.state.chatError = t("chat.sessionSuggestions.attachmentsUnsupported");
      scope.state.lastError = scope.state.chatError;
      scope.state.requestUpdate?.();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const operation = Symbol("session-suggestion-add");
    this.sessionSuggestionAddOperation = operation;
    this.requestUpdate();
    try {
      const result = await scope.client.request<{ suggestion: SessionSuggestion }>(
        "session.suggestions.add",
        {
          sessionKey,
          text,
          ...scopedAgentParamsForSession(scope.state, sessionKey),
        },
      );
      if (
        this.sessionSuggestionAddOperation !== operation ||
        !this.isConnectionScopeCurrent(scope) ||
        scope.state.sessionKey !== sessionKey
      ) {
        return;
      }
      if (scope.state.chatMessage === text) {
        scope.state.handleChatDraftChange("");
      }
      this.sessionSuggestions = [
        ...this.sessionSuggestions.filter((item) => item.id !== result.suggestion.id),
        result.suggestion,
      ];
    } catch (error) {
      if (
        this.sessionSuggestionAddOperation === operation &&
        this.isConnectionScopeCurrent(scope)
      ) {
        scope.state.chatError = formatUiError(error);
        scope.state.lastError = scope.state.chatError;
      }
    } finally {
      if (this.sessionSuggestionAddOperation === operation) {
        this.sessionSuggestionAddOperation = undefined;
        this.requestUpdate();
      }
    }
  }

  protected async resolveCurrentSessionSuggestion(
    suggestion: SessionSuggestion,
    resolution: SessionSuggestionResolution,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      this.sessionSuggestionBusyIds.has(suggestion.id) ||
      (resolution === "edit" && this.sessionSuggestionEditOperation !== undefined) ||
      !this.suggestionMatchesCurrentSession(suggestion)
    ) {
      return;
    }
    if (this.isCurrentSessionArchived(scope.state) && resolution !== "dismiss") {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const targetSignature = this.sessionSuggestionTargetSignature;
    const isCurrentTarget = () =>
      this.isConnectionScopeCurrent(scope) &&
      scope.state.sessionKey === sessionKey &&
      this.sessionSuggestionTargetSignature === targetSignature;
    const previousEditDraft = resolution === "edit" ? scope.state.chatMessage : undefined;
    const editOperation = resolution === "edit" ? Symbol("session-suggestion-edit") : undefined;
    if (editOperation) {
      this.sessionSuggestionEditOperation = editOperation;
    }
    this.sessionSuggestionBusyIds.add(suggestion.id);
    if (resolution === "edit") {
      scope.state.handleChatDraftChange(suggestion.text);
      queueMicrotask(() =>
        this.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR)?.focus({
          preventScroll: true,
        }),
      );
    }
    this.requestUpdate();
    try {
      const result = await scope.client.request<{ suggestion: SessionSuggestion }>(
        "session.suggestions.resolve",
        {
          sessionKey,
          id: suggestion.id,
          resolution,
          ...scopedAgentParamsForSession(scope.state, sessionKey),
        },
      );
      if (!isCurrentTarget()) {
        return;
      }
      if (result.suggestion.author.id === this.context.gateway.snapshot.selfUser?.id) {
        this.sessionSuggestions = [
          ...this.sessionSuggestions.filter((item) => item.id !== suggestion.id),
          result.suggestion,
        ].toSorted(
          (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
        );
      } else {
        this.sessionSuggestions = this.sessionSuggestions.filter(
          (item) => item.id !== suggestion.id,
        );
      }
    } catch (error) {
      if (isCurrentTarget()) {
        if (
          resolution === "edit" &&
          error instanceof GatewayRequestError &&
          previousEditDraft !== undefined &&
          scope.state.chatMessage === suggestion.text
        ) {
          scope.state.handleChatDraftChange(previousEditDraft);
        }
        scope.state.chatError = formatUiError(error);
        scope.state.lastError = scope.state.chatError;
      }
    } finally {
      if (isCurrentTarget()) {
        if (this.sessionSuggestionEditOperation === editOperation) {
          this.sessionSuggestionEditOperation = undefined;
        }
        this.sessionSuggestionBusyIds.delete(suggestion.id);
        this.requestUpdate();
      }
    }
  }

  protected clearTypingActors(): void {
    for (const timer of this.typingTimers.values()) {
      window.clearTimeout(timer);
    }
    this.typingTimers.clear();
    this.typingActors.clear();
  }

  protected handleSessionTypingEvent(event: SessionTypingEvent): void {
    const selfId = this.context.gateway.snapshot.selfUser?.id;
    const state = this.state;
    const selectedSession = state?.sessionsResult?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
    if (
      !this.hasMultipleIdentities() ||
      event.actor.id === selfId ||
      !state ||
      selectedSession?.sessionId !== event.sessionId ||
      !uiSessionEventMatches(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
          sessionKey: state.sessionKey,
        },
        event.sessionKey,
        event.agentId,
      )
    ) {
      return;
    }
    const priorTimer = this.typingTimers.get(event.actor.id);
    if (priorTimer !== undefined) {
      window.clearTimeout(priorTimer);
      this.typingTimers.delete(event.actor.id);
    }
    if (!event.typing) {
      this.typingActors.delete(event.actor.id);
      this.requestUpdate();
      return;
    }
    const expiresAt = Date.now() + 2_500;
    this.typingActors.set(event.actor.id, {
      label: event.actor.label ?? event.actor.id,
      expiresAt,
      ...(event.preview ? { preview: event.preview } : {}),
    });
    this.typingTimers.set(
      event.actor.id,
      window.setTimeout(() => {
        if (this.typingActors.get(event.actor.id)?.expiresAt === expiresAt) {
          this.typingActors.delete(event.actor.id);
          this.typingTimers.delete(event.actor.id);
          this.requestUpdate();
        }
      }, 2_500),
    );
    this.requestUpdate();
  }

  protected clearTypingActorForSessionMessage(payload: unknown): void {
    const state = this.state;
    if (!state) {
      return;
    }
    if (
      clearTypingActorForSessionMessage(payload, this.typingActors, this.typingTimers, {
        agentsList: this.context.agents.state.agentsList,
        hello: this.context.gateway.snapshot.hello,
        sessionKey: state.sessionKey,
      })
    ) {
      this.requestUpdate();
    }
  }

  protected typingActorViews(): { id: string; label: string; preview?: string }[] {
    return [...this.typingActors]
      .map(([id, { label, preview }]) => (preview ? { id, label, preview } : { id, label }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  }

  protected sendTypingState(typing: boolean, preview?: string): void {
    const scope = this.captureConnectionScope();
    if (!scope || !this.hasMultipleIdentities()) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const sessionId = scope.state.sessionsResult?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, sessionKey),
    )?.sessionId;
    if (!sessionId) {
      return;
    }
    const draft = typing ? preview?.trim() : undefined;
    const draftPreview = draft ? Array.from(draft).slice(-300).join("") : undefined;
    void scope.client
      .request("session.typing", {
        sessionKey,
        sessionId,
        typing,
        ...(draftPreview ? { preview: draftPreview } : {}),
        ...scopedAgentParamsForSession(scope.state, sessionKey),
      })
      .catch(() => undefined);
  }
}
