import type {
  TaskSuggestion,
  TaskSuggestionEvent,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import {
  taskSuggestionAcceptParams,
  type TaskSuggestionAcceptMode,
} from "../../lib/task-suggestion-acceptance.ts";
import { discoverPlaceCatalog } from "../new-session/cloud-profile-discovery.ts";
import { ChatPaneSharing } from "./chat-pane-sharing.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";

export abstract class ChatPaneTaskSuggestions extends ChatPaneSharing {
  protected taskSuggestions: TaskSuggestion[] = [];
  protected readonly taskSuggestionBusyIds = new Set<string>();
  protected readonly taskSuggestionCopiedIds = new Set<string>();
  protected readonly taskSuggestionOperations = new Map<string, symbol>();
  protected taskSuggestionsRequestVersion = 0;
  protected taskSuggestionCloudProfiles: Array<{ id: string }> = [];
  protected taskSuggestionCloudProfileGeneration = -1;
  protected activeTaskSuggestionId: string | undefined;
  protected taskSuggestionSwapDirection: "next" | "previous" | undefined;
  protected taskSuggestionSwapGeneration = 0;

  protected setTaskSuggestions(suggestions: TaskSuggestion[]): void {
    this.taskSuggestions = suggestions;
    if (!suggestions.some((suggestion) => suggestion.id === this.activeTaskSuggestionId)) {
      this.activeTaskSuggestionId = suggestions[0]?.id;
      this.taskSuggestionSwapDirection = undefined;
    }
  }

  protected readonly navigateTaskSuggestion = (
    taskId: string,
    direction: "next" | "previous",
  ): void => {
    const current = this.taskSuggestions.findIndex((suggestion) => suggestion.id === taskId);
    if (current < 0 || this.taskSuggestions.length < 2) {
      return;
    }
    const offset = direction === "next" ? 1 : -1;
    const next =
      this.taskSuggestions[
        (current + offset + this.taskSuggestions.length) % this.taskSuggestions.length
      ];
    if (!next) {
      return;
    }
    this.activeTaskSuggestionId = next.id;
    this.taskSuggestionSwapDirection = direction;
    this.taskSuggestionSwapGeneration += 1;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const activeCard = [...this.querySelectorAll<HTMLElement>(".task-suggestion")].find(
        (card) => card.dataset.taskId === next.id,
      );
      activeCard
        ?.querySelector<HTMLElement>(`[data-task-${direction === "next" ? "next" : "prev"}]`)
        ?.focus();
    });
  };

  protected resetTaskSuggestionCloudProfiles(): void {
    this.taskSuggestionCloudProfiles = [];
    this.taskSuggestionCloudProfileGeneration = -1;
  }

  protected async ensureTaskSuggestionCloudProfiles(): Promise<void> {
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      this.taskSuggestions.length === 0 ||
      this.taskSuggestionCloudProfileGeneration === scope.generation ||
      !hasOperatorAdminAccess(scope.context.gateway.snapshot.hello?.auth ?? null) ||
      isGatewayMethodAdvertised(scope.context.gateway.snapshot, "taskSuggestions.accept") !== true
    ) {
      return;
    }
    // Profile metadata is connection-stable. Mark the generation before the
    // request so repeated renders cannot turn this optional affordance into polling.
    this.taskSuggestionCloudProfileGeneration = scope.generation;
    if (isGatewayMethodAdvertised(scope.context.gateway.snapshot, "environments.list") !== true) {
      return;
    }
    try {
      const { profiles } = await discoverPlaceCatalog(scope.client, true);
      if (!this.isConnectionScopeCurrent(scope)) {
        return;
      }
      this.taskSuggestionCloudProfiles = profiles.map((profile) => ({ id: profile.id }));
      this.requestUpdate();
    } catch {
      // Cloud is optional; a failed one-shot discovery leaves the disabled hint.
    }
  }

  protected async refreshTaskSuggestions(): Promise<void> {
    const requestVersion = ++this.taskSuggestionsRequestVersion;
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !isGatewayMethodAdvertised(scope.context.gateway.snapshot, "taskSuggestions.list")
    ) {
      this.setTaskSuggestions([]);
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (parseCatalogSessionKey(sessionKey)) {
      this.setTaskSuggestions([]);
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
      this.setTaskSuggestions(
        result.suggestions.filter((suggestion) => this.suggestionMatchesCurrentSession(suggestion)),
      );
      this.requestUpdate();
    } catch {
      // Suggestions are an optional ephemeral affordance; chat remains usable
      // when an older Gateway or a reconnect loses the process-local registry.
      // Keep event-delivered cards when a background reconciliation fails.
    }
  }

  protected handleTaskSuggestionEvent(event: TaskSuggestionEvent): void {
    if (event.action === "created") {
      if (!this.suggestionMatchesCurrentSession(event.suggestion)) {
        return;
      }
      this.setTaskSuggestions([
        event.suggestion,
        ...this.taskSuggestions.filter((item) => item.id !== event.suggestion.id),
      ]);
    } else {
      this.setTaskSuggestions(this.taskSuggestions.filter((item) => item.id !== event.taskId));
      this.taskSuggestionBusyIds.delete(event.taskId);
    }
    this.requestUpdate();
    // The replacement snapshot includes the event plus unrelated suggestions;
    // its request version prevents any older snapshot from overwriting either.
    void this.refreshTaskSuggestions();
  }

  protected readonly acceptTaskSuggestion = (
    suggestion: TaskSuggestion,
    mode: TaskSuggestionAcceptMode,
    cloudProfileId?: string,
  ): Promise<void> => this.resolveTaskSuggestion(suggestion, "accept", mode, cloudProfileId);

  protected readonly dismissTaskSuggestion = (suggestion: TaskSuggestion): Promise<void> =>
    this.resolveTaskSuggestion(suggestion, "dismiss");

  // Copy is client-local and never gated on acceptance capability; a failed
  // copy must surface visibly instead of dissolving into silence.
  protected readonly copyTaskSuggestionPrompt = async (
    suggestion: TaskSuggestion,
  ): Promise<void> => {
    const copied = await copyToClipboard(suggestion.prompt);
    if (!this.isConnected) {
      return;
    }
    if (!copied) {
      const failure = t("chat.taskSuggestions.copyPromptFailed");
      if (this.state) {
        this.state.lastError = failure;
        this.state.chatError = failure;
      }
      this.requestUpdate();
      return;
    }
    this.taskSuggestionCopiedIds.add(suggestion.id);
    this.requestUpdate();
    setTimeout(() => {
      this.taskSuggestionCopiedIds.delete(suggestion.id);
      if (this.isConnected) {
        this.requestUpdate();
      }
    }, 2000);
  };

  protected async resolveTaskSuggestion(
    suggestion: TaskSuggestion,
    action: "accept" | "dismiss",
    mode: TaskSuggestionAcceptMode = "worktree",
    cloudProfileId?: string,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !this.suggestionMatchesCurrentSession(suggestion) ||
      this.taskSuggestionOperations.has(suggestion.id)
    ) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const operation = Symbol("task-suggestion-operation");
    const isCurrent = () =>
      this.isConnectionScopeCurrent(scope) &&
      scope.state.sessionKey === sessionKey &&
      this.taskSuggestionOperations.get(suggestion.id) === operation;
    this.taskSuggestionOperations.set(suggestion.id, operation);
    this.taskSuggestionBusyIds.add(suggestion.id);
    this.requestUpdate();
    try {
      let acceptedKey: string | undefined;
      if (action === "accept") {
        const result = await scope.client.request<TaskSuggestionsAcceptResult>(
          "taskSuggestions.accept",
          taskSuggestionAcceptParams(suggestion.id, mode, cloudProfileId),
        );
        acceptedKey = result.key;
      } else {
        await scope.client.request("taskSuggestions.dismiss", { taskId: suggestion.id });
      }
      if (!isCurrent()) {
        return;
      }
      this.setTaskSuggestions(this.taskSuggestions.filter((item) => item.id !== suggestion.id));
      if (acceptedKey && mode !== "session") {
        this.onPaneSessionChange?.(this.paneId, acceptedKey);
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      scope.state.lastError = formatUiError(error);
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
  }
}
