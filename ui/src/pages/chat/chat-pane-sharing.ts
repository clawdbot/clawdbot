import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  GatewayRequestError,
  areUiSessionKeysEquivalent,
  hasMultiplePresenceIdentities,
  isGatewayMethodAdvertised,
  parseAgentSessionKey,
  resolveChatAgentId,
  scopedAgentParamsForSession,
  t,
  uiSessionEventMatches,
  type ChatPageHost,
  type ChatSessionSharingState,
  type GatewaySessionRow,
  type SessionMembersListResult,
  type SessionSuggestion,
  type SessionSuggestionEvent,
  type SessionSuggestionResolution,
  type SessionSuggestionsListResult,
  type SessionTypingEvent,
  type SessionVisibility,
  type TaskSuggestion,
} from "./chat-pane-deps.ts";
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  type ChatPaneConnectionScope,
} from "./chat-pane-shared.ts";

export abstract class ChatPaneSharing extends ChatPaneBase {
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

  protected async loadSessionSharing(row: GatewaySessionRow, force = false): Promise<void> {
    const state = this.state;
    if (!state?.connected || !state.client) {
      return;
    }
    const cacheKey = this.sessionSharingCacheKey(row.key);
    const current = this.sessionSharingStates.get(cacheKey);
    if (current?.loading && !force) {
      return;
    }
    // Sharing data (membership + paired identities) is connection-scoped. A
    // gateway/account change bumps the generation and clears this cache, so a
    // request that resolves after the switch must be dropped rather than
    // overwrite the new connection's menu with the previous account's data.
    const generation = this.connectionGeneration;
    this.setSessionSharingState(cacheKey, { ...current, loading: true, error: undefined });
    try {
      const result = await state.client.request<SessionMembersListResult>("session.members.list", {
        sessionKey: row.key,
        ...(this.sessionSharingAgentId(row.key)
          ? { agentId: this.sessionSharingAgentId(row.key) }
          : {}),
      });
      if (this.connectionGeneration !== generation) {
        return;
      }
      this.setSessionSharingState(cacheKey, { loading: false, result });
    } catch (error) {
      if (this.connectionGeneration !== generation) {
        return;
      }
      this.setSessionSharingState(cacheKey, { loading: false, error: String(error) });
    }
  }

  protected async setSessionVisibility(
    row: GatewaySessionRow,
    visibility: SessionVisibility,
  ): Promise<void> {
    const state = this.state;
    if (!state?.connected || !state.client || visibility === row.visibility) {
      return;
    }
    try {
      await state.client.request("session.visibility.set", {
        sessionKey: row.key,
        visibility,
        ...(this.sessionSharingAgentId(row.key)
          ? { agentId: this.sessionSharingAgentId(row.key) }
          : {}),
      });
      await this.context.sessions.refreshReplacement(this.sessionSharingAgentId(row.key));
      await this.loadSessionSharing(row, true);
    } catch (error) {
      const cacheKey = this.sessionSharingCacheKey(row.key);
      this.setSessionSharingState(cacheKey, {
        ...(this.sessionSharingStates.get(cacheKey) ?? { loading: false }),
        loading: false,
        error: String(error),
      });
    }
  }

  protected async setSessionMember(
    row: GatewaySessionRow,
    identityId: string,
    member: boolean,
  ): Promise<void> {
    const state = this.state;
    if (!state?.connected || !state.client) {
      return;
    }
    try {
      await state.client.request(member ? "session.members.add" : "session.members.remove", {
        sessionKey: row.key,
        identityId,
        ...(this.sessionSharingAgentId(row.key)
          ? { agentId: this.sessionSharingAgentId(row.key) }
          : {}),
      });
      await this.loadSessionSharing(row, true);
      await this.context.sessions.refreshReplacement(this.sessionSharingAgentId(row.key));
    } catch (error) {
      const cacheKey = this.sessionSharingCacheKey(row.key);
      this.setSessionSharingState(cacheKey, {
        ...(this.sessionSharingStates.get(cacheKey) ?? { loading: false }),
        loading: false,
        error: String(error),
      });
    }
  }

  protected captureConnectionScope(): ChatPaneConnectionScope | null {
    const context = this.context;
    const state = this.state;
    const client = state?.client;
    if (
      !this.isConnected ||
      !state?.connected ||
      !client ||
      this.connectedClient !== client ||
      context.gateway.snapshot.phase !== "connected" ||
      context.gateway.snapshot.client !== client
    ) {
      return null;
    }
    return {
      context,
      state,
      client,
      generation: this.connectionGeneration,
      sessions: context.sessions,
    };
  }

  protected isConnectionScopeCurrent(scope: ChatPaneConnectionScope): boolean {
    return (
      this.isConnected &&
      this.context === scope.context &&
      this.context.sessions === scope.sessions &&
      this.state === scope.state &&
      scope.state.connected &&
      scope.state.client === scope.client &&
      this.connectedClient === scope.client &&
      scope.context.gateway.snapshot.phase === "connected" &&
      scope.context.gateway.snapshot.client === scope.client &&
      this.connectionGeneration === scope.generation
    );
  }

  protected taskSuggestionMatchesCurrentSession(suggestion: TaskSuggestion): boolean {
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

  protected sessionSuggestionMatchesCurrentSession(suggestion: SessionSuggestion): boolean {
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
    if (
      !this.hasMultipleIdentities() ||
      !this.sessionSuggestionMatchesCurrentSession(event.suggestion)
    ) {
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
    const operation = Symbol();
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
        scope.state.chatError = error instanceof Error ? error.message : String(error);
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
      !this.sessionSuggestionMatchesCurrentSession(suggestion)
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
    const editOperation = resolution === "edit" ? Symbol() : undefined;
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
        scope.state.chatError = error instanceof Error ? error.message : String(error);
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

  protected typingLabel(): string | null {
    const names = [...this.typingActors.values()].map((actor) => actor.label).toSorted();
    if (names.length === 0) {
      return null;
    }
    return names.length === 1
      ? t("chat.sessionSuggestions.typing", { name: names[0] ?? "" })
      : t("chat.sessionSuggestions.typingMany", { names: names.join(", ") });
  }

  protected sendTypingState(typing: boolean): void {
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
    void scope.client
      .request("session.typing", {
        sessionKey,
        sessionId,
        typing,
        ...scopedAgentParamsForSession(scope.state, sessionKey),
      })
      .catch(() => undefined);
  }
}
