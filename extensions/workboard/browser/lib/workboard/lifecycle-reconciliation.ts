import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatError } from "./normalization-utils.ts";
import {
  currentWorkboardLifecycleReconciliationEpoch,
  getWorkboardRuntime,
  getWorkboardState,
  isCurrentWorkboardLifecycleReconciliationEpoch,
  isCurrentWorkboardLoadGeneration,
  nextWorkboardLoadGeneration,
  resetWorkboardLifecycleTaskConfirmations,
  setWorkboardLifecycleTaskRefreshContinuation,
  setWorkboardLifecycleTaskRefreshFailed,
  setWorkboardLifecycleTasksPrepared,
  shouldRefreshWorkboardTasksForLifecycle,
  workboardLifecycleRequiresTaskRefresh,
  workboardLifecycleSyncBlocked,
  workboardLifecycleTaskRefreshContinuationWaiting,
  workboardLifecycleTaskRefreshRetryPending,
  workboardLifecycleTasksPreparedAt,
  workboardTaskLinksReadyForLifecycle,
  WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_TIMEOUT_ERROR,
  WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_WINDOW_MS,
  type WorkboardHost,
} from "./runtime.ts";
import {
  applyTaskSummariesToState,
  getWorkboardTaskPollBatch,
  listWorkboardTasks,
  selectWorkboardMissingTaskConfirmationIds,
  taskMatchesTrackedCardLink,
} from "./task-links.ts";
import type { WorkboardTaskLinkState, WorkboardUiState } from "./types.ts";

async function refreshWorkboardLifecycleTasks(
  params: {
    host: WorkboardHost;
    client: GatewayBrowserClient;
    requestUpdate?: () => void;
  },
  state: WorkboardUiState,
): Promise<number | null> {
  const runtime = getWorkboardRuntime(params.host);
  const existingRefresh = runtime.lifecycleTaskRefreshPromise;
  if (existingRefresh) {
    return await existingRefresh;
  }
  const refresh = (async () => {
    const generation = nextWorkboardLoadGeneration(params.host);
    try {
      const previousTasksByCardId = state.tasksByCardId;
      const confirmationNow = Date.now();
      const confirmationExpired =
        state.lifecycleTaskConfirmationStartedAt !== null &&
        confirmationNow - state.lifecycleTaskConfirmationStartedAt >=
          WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_WINDOW_MS;
      if (state.lifecycleTaskRefreshContinueAt !== null && confirmationExpired) {
        resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
        setWorkboardLifecycleTaskRefreshFailed(state, true, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
        state.lifecycleTaskRefreshError = WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_TIMEOUT_ERROR;
        params.requestUpdate?.();
        return null;
      }
      if (state.lifecycleTaskConfirmationStartedAt === null || confirmationExpired) {
        resetWorkboardLifecycleTaskConfirmations(state);
        state.lifecycleTaskConfirmationStartedAt = confirmationNow;
      }
      const previouslyConfirmedTasks = [...previousTasksByCardId.values()].filter((task) =>
        state.lifecycleConfirmedTaskIds.has(task.taskId),
      );
      const taskLinkState: WorkboardTaskLinkState = {
        cards: state.cards,
        tasksByCardId: new Map(),
        missingTaskIds: new Set(state.missingTaskIds),
      };
      const taskSummaries = await listWorkboardTasks(params.client);
      const confirmationResult = await getWorkboardTaskPollBatch(
        params.client,
        selectWorkboardMissingTaskConfirmationIds(
          params.host,
          taskLinkState.cards,
          taskSummaries,
          taskLinkState.missingTaskIds,
          previousTasksByCardId,
          state.lifecycleConfirmedTaskIds,
        ),
        [],
      );
      const previousTasksToPreserve = confirmationResult.error
        ? taskLinkState.cards.flatMap((card) => {
            const task = previousTasksByCardId.get(card.id);
            return task &&
              !confirmationResult.missingTaskIds.has(task.taskId) &&
              taskMatchesTrackedCardLink(task, card, taskLinkState.missingTaskIds)
              ? [task]
              : [];
          })
        : [];
      applyTaskSummariesToState(
        taskLinkState,
        [
          ...taskSummaries,
          ...previouslyConfirmedTasks,
          ...confirmationResult.tasks,
          ...previousTasksToPreserve,
        ],
        { missingTaskIds: confirmationResult.missingTaskIds },
      );
      if (
        !isCurrentWorkboardLoadGeneration(params.host, generation) ||
        workboardLifecycleSyncBlocked(params.host, state)
      ) {
        return null;
      }
      state.cards = taskLinkState.cards;
      state.tasksByCardId = taskLinkState.tasksByCardId;
      state.missingTaskIds = taskLinkState.missingTaskIds;
      for (const task of confirmationResult.tasks) {
        state.lifecycleConfirmedTaskIds.add(task.taskId);
      }
      for (const taskId of confirmationResult.missingTaskIds) {
        state.lifecycleConfirmedTaskIds.add(taskId);
      }
      if (confirmationResult.error) {
        resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
        setWorkboardLifecycleTaskRefreshFailed(state, true, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
        state.lifecycleTaskRefreshError = confirmationResult.error;
        params.requestUpdate?.();
        return null;
      }
      if (!workboardTaskLinksReadyForLifecycle(taskLinkState)) {
        setWorkboardLifecycleTaskRefreshContinuation(state, true, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
        return null;
      }
      resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
      const recoveredTaskRefreshError = state.lifecycleTaskRefreshError;
      setWorkboardLifecycleTaskRefreshFailed(state, false, { host: params.host });
      state.lifecycleTaskRefreshError = null;
      if (
        recoveredTaskRefreshError !== null &&
        state.lastRefreshError === recoveredTaskRefreshError
      ) {
        state.lastRefreshError = null;
      }
      params.requestUpdate?.();
      return Date.now();
    } catch (error) {
      if (
        !isCurrentWorkboardLoadGeneration(params.host, generation) ||
        workboardLifecycleSyncBlocked(params.host, state)
      ) {
        return null;
      }
      resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
      setWorkboardLifecycleTaskRefreshFailed(state, true, {
        host: params.host,
        requestUpdate: params.requestUpdate,
      });
      state.lifecycleTaskRefreshError = formatError(error);
      params.requestUpdate?.();
      return null;
    }
  })();
  runtime.lifecycleTaskRefreshPromise = refresh;
  try {
    return await refresh;
  } finally {
    if (runtime.lifecycleTaskRefreshPromise === refresh) {
      delete runtime.lifecycleTaskRefreshPromise;
    }
  }
}

export async function syncWorkboardLifecycle(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const taskRefreshRetryPending = workboardLifecycleTaskRefreshRetryPending(state);
  const taskRefreshContinuationWaiting = workboardLifecycleTaskRefreshContinuationWaiting(state);
  if (
    !params.client ||
    !state.loaded ||
    ((taskRefreshRetryPending || taskRefreshContinuationWaiting) &&
      workboardLifecycleRequiresTaskRefresh(state)) ||
    workboardLifecycleSyncBlocked(params.host, state)
  ) {
    return;
  }
  const reconciliationEpoch = currentWorkboardLifecycleReconciliationEpoch(params.host);
  let tasksPreparedAt = workboardLifecycleTasksPreparedAt(state);
  const tasksPrepared = tasksPreparedAt !== null;
  setWorkboardLifecycleTasksPrepared(state, false, { host: params.host });
  if (
    !tasksPrepared &&
    !taskRefreshRetryPending &&
    !taskRefreshContinuationWaiting &&
    shouldRefreshWorkboardTasksForLifecycle(state)
  ) {
    tasksPreparedAt = await refreshWorkboardLifecycleTasks(
      {
        host: params.host,
        client: params.client,
        requestUpdate: params.requestUpdate,
      },
      state,
    );
    if (tasksPreparedAt === null && workboardLifecycleRequiresTaskRefresh(state)) {
      // A null result without a recorded failure means the shared refresh was
      // invalidated. Ask only the current, unblocked reconciliation to retry.
      if (
        !state.lifecycleTaskRefreshFailed &&
        isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) &&
        !workboardLifecycleSyncBlocked(params.host, state)
      ) {
        params.requestUpdate?.();
      }
      return;
    }
  }
  if (
    !isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) ||
    workboardLifecycleSyncBlocked(params.host, state)
  ) {
    return;
  }
  setWorkboardLifecycleTasksPrepared(state, true, {
    host: params.host,
    preparedAt: tasksPreparedAt ?? Date.now(),
    requestUpdate: params.requestUpdate,
  });
}
