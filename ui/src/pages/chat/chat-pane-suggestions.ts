import {
  dismissChatPullRequest,
  isGatewayMethodAdvertised,
  listDismissedChatPullRequests,
  parseCatalogSessionKey,
  resolveChatAgentId,
  scopedAgentParamsForSession,
  type ControlUiSessionPullRequest,
  type ControlUiSessionPullRequests,
  type TaskSuggestion,
  type TaskSuggestionEvent,
  type TaskSuggestionsAcceptResult,
  type TaskSuggestionsListResult,
} from "./chat-pane-deps.ts";
import { summarizeSessionPullRequests } from "./chat-pane-shared.ts";
import { ChatPaneSharing } from "./chat-pane-sharing.ts";

export abstract class ChatPaneSuggestions extends ChatPaneSharing {
  protected async refreshTaskSuggestions(): Promise<void> {
    const requestVersion = ++this.taskSuggestionsRequestVersion;
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !isGatewayMethodAdvertised(scope.context.gateway.snapshot, "taskSuggestions.list")
    ) {
      this.taskSuggestions = [];
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (parseCatalogSessionKey(sessionKey)) {
      this.taskSuggestions = [];
      this.requestUpdate();
      return;
    }
    const agentId = resolveChatAgentId(scope.state);
    try {
      const result = await scope.client.request<TaskSuggestionsListResult>("taskSuggestions.list", {
        agentId,
      });
      if (
        requestVersion !== this.taskSuggestionsRequestVersion ||
        !this.isConnectionScopeCurrent(scope) ||
        sessionKey !== scope.state.sessionKey
      ) {
        return;
      }
      this.taskSuggestions = result.suggestions.filter((suggestion) =>
        this.taskSuggestionMatchesCurrentSession(suggestion),
      );
      this.requestUpdate();
    } catch {
      // Suggestions are an optional ephemeral affordance; chat remains usable
      // when an older Gateway or a reconnect loses the process-local registry.
      // Keep event-delivered cards when a background reconciliation fails.
    }
  }

  protected async refreshSessionPullRequests(options: { refresh?: boolean } = {}): Promise<void> {
    const requestVersion = ++this.sessionPullRequestsRequestVersion;
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !isGatewayMethodAdvertised(scope.context.gateway.snapshot, "controlUi.sessionPullRequests")
    ) {
      this.sessionPullRequests = [];
      this.sessionPullRequestsBranch = undefined;
      this.sessionPullRequestsRateLimited = false;
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (!sessionKey.trim() || parseCatalogSessionKey(sessionKey)) {
      this.sessionPullRequests = [];
      this.sessionPullRequestsBranch = undefined;
      this.sessionPullRequestsRateLimited = false;
      this.requestUpdate();
      return;
    }
    const pullRequestEpoch = scope.context.sessions.capturePullRequestEpoch(sessionKey);
    try {
      const result = await scope.client.request<ControlUiSessionPullRequests>(
        "controlUi.sessionPullRequests",
        {
          sessionKey,
          ...scopedAgentParamsForSession(scope.state, sessionKey),
          ...(options.refresh ? { refresh: true } : {}),
        },
      );
      if (
        requestVersion !== this.sessionPullRequestsRequestVersion ||
        !this.isConnectionScopeCurrent(scope) ||
        sessionKey !== scope.state.sessionKey
      ) {
        return;
      }
      this.sessionPullRequests = result.pullRequests;
      if (!result.rateLimited || result.pullRequests.length > 0) {
        scope.context.sessions.setPullRequestSummary(
          sessionKey,
          summarizeSessionPullRequests(result.pullRequests),
          pullRequestEpoch,
        );
      }
      this.sessionPullRequestsBranch = result.branch;
      this.sessionPullRequestsRateLimited = result.rateLimited;
      this.dismissedSessionPullRequestIds = listDismissedChatPullRequests(sessionKey);
      this.requestUpdate();
    } catch {
      // PR chips are an optional affordance; keep the last snapshot so a
      // transient gateway or GitHub failure does not clear the row.
    }
  }

  protected resetSessionPullRequests(): void {
    this.sessionPullRequestsRequestVersion += 1;
    this.sessionPullRequests = [];
    this.sessionPullRequestsBranch = undefined;
    this.sessionPullRequestsRateLimited = false;
    this.sessionPullRequestsExpanded = false;
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

  protected handleTaskSuggestionEvent(event: TaskSuggestionEvent): void {
    if (event.action === "created") {
      if (!this.taskSuggestionMatchesCurrentSession(event.suggestion)) {
        return;
      }
      this.taskSuggestions = [
        event.suggestion,
        ...this.taskSuggestions.filter((item) => item.id !== event.suggestion.id),
      ];
    } else {
      this.taskSuggestions = this.taskSuggestions.filter((item) => item.id !== event.taskId);
      this.taskSuggestionBusyIds.delete(event.taskId);
    }
    this.requestUpdate();
    // The replacement snapshot includes the event plus unrelated suggestions;
    // its request version prevents any older snapshot from overwriting either.
    void this.refreshTaskSuggestions();
  }

  protected readonly acceptTaskSuggestion = async (suggestion: TaskSuggestion): Promise<void> => {
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !this.taskSuggestionMatchesCurrentSession(suggestion) ||
      this.taskSuggestionOperations.has(suggestion.id)
    ) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const operation = Symbol();
    const isCurrent = () =>
      this.isConnectionScopeCurrent(scope) &&
      scope.state.sessionKey === sessionKey &&
      this.taskSuggestionOperations.get(suggestion.id) === operation;
    this.taskSuggestionOperations.set(suggestion.id, operation);
    this.taskSuggestionBusyIds.add(suggestion.id);
    this.requestUpdate();
    try {
      const result = await scope.client.request<TaskSuggestionsAcceptResult>(
        "taskSuggestions.accept",
        { taskId: suggestion.id },
      );
      if (!isCurrent()) {
        return;
      }
      this.taskSuggestions = this.taskSuggestions.filter((item) => item.id !== suggestion.id);
      this.onPaneSessionChange?.(this.paneId, result.key);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      scope.state.lastError = error instanceof Error ? error.message : String(error);
      scope.state.chatError = scope.state.lastError;
    } finally {
      if (this.taskSuggestionOperations.get(suggestion.id) === operation) {
        this.taskSuggestionOperations.delete(suggestion.id);
        this.taskSuggestionBusyIds.delete(suggestion.id);
        if (this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
          this.requestUpdate();
        }
      }
    }
  };

  protected readonly dismissTaskSuggestion = async (suggestion: TaskSuggestion): Promise<void> => {
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !this.taskSuggestionMatchesCurrentSession(suggestion) ||
      this.taskSuggestionOperations.has(suggestion.id)
    ) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const operation = Symbol();
    const isCurrent = () =>
      this.isConnectionScopeCurrent(scope) &&
      scope.state.sessionKey === sessionKey &&
      this.taskSuggestionOperations.get(suggestion.id) === operation;
    this.taskSuggestionOperations.set(suggestion.id, operation);
    this.taskSuggestionBusyIds.add(suggestion.id);
    this.requestUpdate();
    try {
      await scope.client.request("taskSuggestions.dismiss", { taskId: suggestion.id });
      if (!isCurrent()) {
        return;
      }
      this.taskSuggestions = this.taskSuggestions.filter((item) => item.id !== suggestion.id);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      scope.state.lastError = error instanceof Error ? error.message : String(error);
      scope.state.chatError = scope.state.lastError;
    } finally {
      if (this.taskSuggestionOperations.get(suggestion.id) === operation) {
        this.taskSuggestionOperations.delete(suggestion.id);
        this.taskSuggestionBusyIds.delete(suggestion.id);
        if (this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
          this.requestUpdate();
        }
      }
    }
  };
}
