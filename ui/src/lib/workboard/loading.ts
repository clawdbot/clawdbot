import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardsPayload } from "./normalization.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  isCurrentWorkboardLoadGeneration,
  nextWorkboardLoadGeneration,
  resetWorkboardLifecycleTaskConfirmations,
  setWorkboardLifecycleTaskRefreshFailed,
  setWorkboardLifecycleTasksPrepared,
  shouldRefreshWorkboardTasksForLifecycle,
  workboardHasActiveWrites,
  workboardTaskLinksReadyForLifecycle,
  type WorkboardHost,
  type WorkboardLoadToken,
} from "./runtime.ts";
import {
  applyTaskSummariesToState,
  getWorkboardTaskPollBatch,
  listWorkboardTasks,
  selectWorkboardMissingTaskConfirmationIds,
  selectWorkboardTaskDiscoveryQueries,
  selectWorkboardTaskPollIds,
  taskMatchesTrackedCardLink,
} from "./task-links.ts";
import type {
  WorkboardRefreshSource,
  WorkboardTaskLinkState,
  WorkboardTaskSummary,
  WorkboardUiState,
} from "./types.ts";

type LoadWorkboardParams = {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  force?: boolean;
  refreshDiagnostics?: boolean;
  taskRefresh?: "all" | "linked";
  preserveError?: boolean;
};

export async function loadWorkboard(params: LoadWorkboardParams): Promise<boolean> {
  return await loadWorkboardInternal(params);
}

async function loadWorkboardInternal(
  params: LoadWorkboardParams,
  queuedAfterGeneration?: number,
): Promise<boolean> {
  const runtime = getWorkboardRuntime(params.host);
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    state.dispatching ||
    workboardHasActiveWrites(state) ||
    (!params.force && (state.loaded || state.loadAttempted))
  ) {
    return false;
  }
  const client = params.client;
  const existingLoad = runtime.loadPromise;
  if (existingLoad) {
    const existingGeneration = runtime.loadGeneration;
    const result = await existingLoad;
    const existingLoadIsCurrent =
      existingGeneration !== undefined &&
      isCurrentWorkboardLoadGeneration(params.host, existingGeneration);
    const currentLoadMarker = runtime.loadToken;
    // Only follow a replacement created by this load's forced-waiter queue.
    // Fresh loads after teardown or writes must not revive stale callers.
    const queuedLoadReplacedExisting =
      existingGeneration !== undefined &&
      currentLoadMarker?.queuedAfterGeneration === existingGeneration &&
      Boolean(runtime.loadPromise);
    // Forced callers carry their own diagnostics/task-refresh contract, so a
    // weaker in-flight load cannot satisfy them.
    return params.force &&
      (existingLoadIsCurrent || queuedLoadReplacedExisting) &&
      !state.dispatching &&
      !workboardHasActiveWrites(state)
      ? await loadWorkboardInternal(params, existingGeneration)
      : result;
  }
  const generation = nextWorkboardLoadGeneration(params.host);
  const loadToken: WorkboardLoadToken = { queuedAfterGeneration };
  runtime.loadToken = loadToken;
  const lastRefreshErrorBeforeLoad = state.lastRefreshError;
  state.loadAttempted = true;
  state.loading = true;
  if (!params.preserveError) {
    delete runtime.loadError;
    state.error = null;
  }
  if (params.taskRefresh !== "linked" || !state.lifecycleTaskRefreshFailed) {
    state.lastRefreshError = null;
  }
  params.requestUpdate?.();
  const loadPromise = (async () => {
    try {
      if (params.refreshDiagnostics) {
        try {
          await client.request("workboard.cards.diagnostics.refresh", {});
        } catch (error) {
          if (isCurrentWorkboardLoadGeneration(params.host, generation)) {
            state.lastRefreshError = formatError(error);
          }
        }
      }
      const payload = await client.request("workboard.cards.list", {});
      const normalized = normalizeCardsPayload(payload);
      if (!isCurrentWorkboardLoadGeneration(params.host, generation)) {
        return false;
      }
      const previousTasksByCardId = state.tasksByCardId;
      const taskLinkState: WorkboardTaskLinkState = {
        cards: normalized.cards,
        tasksByCardId: new Map(),
        missingTaskIds: new Set(state.missingTaskIds),
      };
      let lifecycleTaskRefreshFailed = state.lifecycleTaskRefreshFailed;
      let preserveLifecycleTaskRefreshFailure = false;
      let nextTaskRefreshError: string | null = null;
      let nextUnfilteredCursor: string | null | undefined;
      if (taskLinkState.cards.length > 0) {
        const preparedTaskSummaries = taskLinkState.cards.flatMap((card) => {
          const task = previousTasksByCardId.get(card.id);
          return task && taskMatchesTrackedCardLink(task, card, taskLinkState.missingTaskIds)
            ? [task]
            : [];
        });
        try {
          const pollResult =
            params.taskRefresh === "linked"
              ? await getWorkboardTaskPollBatch(
                  client,
                  selectWorkboardTaskPollIds(
                    params.host,
                    taskLinkState.cards,
                    previousTasksByCardId,
                    taskLinkState.missingTaskIds,
                  ),
                  selectWorkboardTaskDiscoveryQueries(
                    params.host,
                    taskLinkState.cards,
                    previousTasksByCardId,
                    taskLinkState.missingTaskIds,
                  ),
                )
              : null;
          let taskSummaries: WorkboardTaskSummary[];
          let missingTaskIds: ReadonlySet<string>;
          let taskRefreshError: string | null;
          if (pollResult) {
            taskSummaries = [
              ...pollResult.tasks,
              ...preparedTaskSummaries.filter(
                (task) => !pollResult.missingTaskIds.has(task.taskId),
              ),
            ];
            missingTaskIds = pollResult.missingTaskIds;
            taskRefreshError = pollResult.error;
          } else {
            const listedTaskSummaries = await listWorkboardTasks(client);
            const confirmationResult = await getWorkboardTaskPollBatch(
              client,
              selectWorkboardMissingTaskConfirmationIds(
                params.host,
                taskLinkState.cards,
                listedTaskSummaries,
                taskLinkState.missingTaskIds,
                previousTasksByCardId,
              ),
              [],
            );
            const previousTasksToPreserve = confirmationResult.error
              ? preparedTaskSummaries.filter(
                  (task) => !confirmationResult.missingTaskIds.has(task.taskId),
                )
              : [];
            taskSummaries = [
              ...listedTaskSummaries,
              ...confirmationResult.tasks,
              ...previousTasksToPreserve,
            ];
            missingTaskIds = confirmationResult.missingTaskIds;
            taskRefreshError = confirmationResult.error;
          }
          nextUnfilteredCursor = pollResult?.nextUnfilteredCursor;
          applyTaskSummariesToState(taskLinkState, taskSummaries, { missingTaskIds });
          preserveLifecycleTaskRefreshFailure =
            params.taskRefresh === "linked" &&
            state.lifecycleTaskRefreshFailed &&
            !taskRefreshError &&
            shouldRefreshWorkboardTasksForLifecycle(taskLinkState);
          lifecycleTaskRefreshFailed =
            Boolean(taskRefreshError) || preserveLifecycleTaskRefreshFailure;
          if (taskRefreshError) {
            nextTaskRefreshError = taskRefreshError;
          }
        } catch (error) {
          applyTaskSummariesToState(taskLinkState, preparedTaskSummaries);
          // Render-driven lifecycle sync runs after every update. Defer a
          // failed task refresh until a later authoritative refresh.
          lifecycleTaskRefreshFailed = true;
          nextTaskRefreshError = formatError(error);
        }
      } else {
        lifecycleTaskRefreshFailed = false;
      }
      if (!isCurrentWorkboardLoadGeneration(params.host, generation)) {
        return false;
      }
      if (params.taskRefresh === "linked" && shouldDeferWorkboardLiveRefresh(state)) {
        return false;
      }
      if (nextUnfilteredCursor !== undefined) {
        if (nextUnfilteredCursor) {
          runtime.defaultTaskDiscoveryCursor = nextUnfilteredCursor;
        } else {
          delete runtime.defaultTaskDiscoveryCursor;
        }
      }
      state.cards = taskLinkState.cards;
      state.boards = normalized.boards;
      state.statuses = normalized.statuses;
      state.tasksByCardId = taskLinkState.tasksByCardId;
      state.missingTaskIds = taskLinkState.missingTaskIds;
      resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
      const recoveredFromLifecycleTaskRefresh =
        state.lifecycleTaskRefreshFailed && !lifecycleTaskRefreshFailed;
      if (!preserveLifecycleTaskRefreshFailure) {
        setWorkboardLifecycleTaskRefreshFailed(state, lifecycleTaskRefreshFailed, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
      }
      if (!lifecycleTaskRefreshFailed) {
        state.lifecycleTaskRefreshError = null;
        if (
          recoveredFromLifecycleTaskRefresh &&
          state.lastRefreshError === lastRefreshErrorBeforeLoad
        ) {
          state.lastRefreshError = null;
        }
      }
      if (nextTaskRefreshError) {
        state.lifecycleTaskRefreshError = nextTaskRefreshError;
        state.lastRefreshError = nextTaskRefreshError;
      }
      setWorkboardLifecycleTasksPrepared(
        state,
        !lifecycleTaskRefreshFailed &&
          workboardTaskLinksReadyForLifecycle(taskLinkState, {
            requireRunningTaskDiscovery: params.taskRefresh === "linked",
          }),
        { host: params.host, requestUpdate: params.requestUpdate },
      );
      const recoveredLoadError = runtime.loadError;
      if (recoveredLoadError !== undefined && state.error === recoveredLoadError) {
        state.error = null;
      }
      delete runtime.loadError;
      // Preserve stale edit text for recovery, but never re-enable its full-card
      // save payload after canonical state may have changed.
      state.mutationReadiness = state.editingCardId ? "stale_edit_draft" : "ready";
      state.loaded = true;
      return true;
    } catch (error) {
      if (isCurrentWorkboardLoadGeneration(params.host, generation)) {
        const formattedError = formatError(error);
        if (params.preserveError) {
          state.lastRefreshError = formattedError;
        } else {
          runtime.loadError = formattedError;
          state.error = formattedError;
        }
      }
      return false;
    } finally {
      const isCurrentGeneration = isCurrentWorkboardLoadGeneration(params.host, generation);
      const ownsLoad = runtime.loadToken === loadToken;
      if (!isCurrentGeneration && !state.loaded) {
        state.loadAttempted = false;
      }
      if (isCurrentGeneration || (ownsLoad && !state.draftSaving)) {
        state.loading = false;
      }
      if (ownsLoad) {
        delete runtime.loadPromise;
        delete runtime.loadToken;
      }
      params.requestUpdate?.();
    }
  })();
  runtime.loadPromise = loadPromise;
  return await loadPromise;
}

export async function refreshWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  source: WorkboardRefreshSource;
  refreshDiagnostics?: boolean;
}): Promise<boolean> {
  const state = getWorkboardState(params.host);
  const passive = params.source === "live";
  if (state.dispatching || workboardHasActiveWrites(state)) {
    return false;
  }
  const startedAt = Date.now();
  state.lastRefreshStartedAt = startedAt;
  state.lastRefreshSource = params.source;
  if (!passive || !state.lifecycleTaskRefreshFailed) {
    state.lastRefreshError = null;
  }
  params.requestUpdate?.();
  if (!params.client) {
    state.lastRefreshError = "Gateway client unavailable";
    params.requestUpdate?.();
    return false;
  }
  const refreshed = await loadWorkboard({
    host: params.host,
    client: params.client,
    requestUpdate: params.requestUpdate,
    force: true,
    refreshDiagnostics: params.refreshDiagnostics,
    taskRefresh: passive ? "linked" : "all",
    preserveError: passive,
  });
  state.lastRefreshSource = params.source;
  if (!passive && state.error) {
    state.lastRefreshError = state.error;
  } else if (refreshed) {
    state.lastRefreshAt = Date.now();
  }
  params.requestUpdate?.();
  return refreshed;
}

export function shouldDeferWorkboardLiveRefresh(state: WorkboardUiState): boolean {
  return Boolean(
    state.draftOpen ||
    state.editingCardId ||
    workboardHasActiveWrites(state) ||
    state.draggedCardId ||
    state.dispatching ||
    state.detailCommentBody.trim() ||
    state.draftCommentBody.trim(),
  );
}
