import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { replaceCard, staleSessionState } from "./card-state.ts";
import {
  executionStatusForLifecycle,
  getLifecycleSyncKeys,
  getWorkboardLifecycle,
  hasPendingStatusTransition,
  lifecycleSyncKey,
  mergePatchMetadata,
  shouldSkipLifecycleStatusWrite,
  shouldSkipStaleLifecycleStatus,
  shouldSyncCardStatus,
  shouldSyncExecutionStatus,
} from "./lifecycle.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardPayload } from "./normalization.ts";
import {
  currentWorkboardLifecycleReconciliationEpoch,
  getWorkboardRuntime,
  getWorkboardState,
  isCurrentWorkboardLifecycleReconciliationEpoch,
  isCurrentWorkboardLoadGeneration,
  nextWorkboardLoadGeneration,
  releaseWorkboardLifecycleWrite,
  resetWorkboardLifecycleTaskConfirmations,
  setWorkboardLifecycleTaskRefreshContinuation,
  setWorkboardLifecycleTaskRefreshFailed,
  setWorkboardLifecycleTasksPrepared,
  shouldRefreshWorkboardTasksForLifecycle,
  trackWorkboardLifecycleWrite,
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
  sessions: readonly GatewaySessionRow[];
  canWrite?: boolean;
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
  // Read-only operators still need task-refresh recovery. Gate only the
  // lifecycle card writeback after the shared task snapshot is current.
  if (params.canWrite === false) {
    setWorkboardLifecycleTasksPrepared(state, true, {
      host: params.host,
      preparedAt: tasksPreparedAt ?? Date.now(),
      requestUpdate: params.requestUpdate,
    });
    return;
  }
  const syncKeys = getLifecycleSyncKeys(params.host);
  let lifecycleWriteStarted = false;
  for (const card of state.cards) {
    if (
      !isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) ||
      workboardLifecycleSyncBlocked(params.host, state)
    ) {
      return;
    }
    const lifecycle = getWorkboardLifecycle(
      card,
      params.sessions,
      state.tasksByCardId.get(card.id),
    );
    const executionStatus = executionStatusForLifecycle(lifecycle);
    const patch: Record<string, unknown> = {};
    if (
      lifecycle.sourceUpdatedAt !== undefined &&
      !shouldSkipLifecycleStatusWrite(params.host, card, lifecycle) &&
      shouldSyncCardStatus(card, lifecycle.targetStatus)
    ) {
      patch.status = lifecycle.targetStatus;
      mergePatchMetadata(patch, {
        lifecycleStatusSourceUpdatedAt: lifecycle.sourceUpdatedAt,
      });
    }
    if (shouldSyncExecutionStatus(card, executionStatus)) {
      patch.execution = {
        ...card.execution,
        status: executionStatus,
        updatedAt: Date.now(),
      };
    }
    const stale = lifecycle.session ? staleSessionState(lifecycle.session) : undefined;
    const existingStale = card.metadata?.stale;
    if (stale) {
      const staleChanged =
        !existingStale ||
        existingStale.lastSessionUpdatedAt !== stale.lastSessionUpdatedAt ||
        existingStale.reason !== stale.reason;
      if (staleChanged) {
        mergePatchMetadata(patch, {
          stale: {
            ...stale,
            detectedAt: existingStale?.detectedAt ?? stale.detectedAt,
          },
        });
      }
    } else if (existingStale) {
      mergePatchMetadata(patch, {
        stale: null,
      });
    }
    if (Object.keys(patch).length === 0) {
      continue;
    }
    const key = lifecycleSyncKey(card, lifecycle);
    if (syncKeys.get(card.id) === key || state.syncingCardIds.has(card.id)) {
      continue;
    }
    const generation = nextWorkboardLoadGeneration(params.host);
    lifecycleWriteStarted = true;
    state.syncingCardIds.add(card.id);
    params.requestUpdate?.();
    let write: Promise<unknown> | null = null;
    try {
      write = params.client.request("workboard.cards.update", {
        id: card.id,
        patch,
      });
      trackWorkboardLifecycleWrite(params.host, write);
      const payload = await write;
      const currentCard = state.cards.find((candidate) => candidate.id === card.id);
      const responseCard = normalizeCardPayload(payload);
      // Lifecycle responses are full-card replacements. Any newer load or write
      // invalidates this generation so its response cannot replace fresher state.
      if (
        !currentCard ||
        !isCurrentWorkboardLoadGeneration(params.host, generation) ||
        !isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) ||
        hasPendingStatusTransition(params.host, currentCard.id) ||
        (currentCard.status !== card.status && responseCard.status !== currentCard.status) ||
        (shouldSkipStaleLifecycleStatus(currentCard, lifecycle) &&
          responseCard.status !== currentCard.status)
      ) {
        continue;
      }
      replaceCard(state, responseCard);
      syncKeys.set(card.id, key);
    } catch (error) {
      if (isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch)) {
        state.error = formatError(error);
        syncKeys.set(card.id, key);
      }
    } finally {
      if (write) {
        releaseWorkboardLifecycleWrite(params.host, write);
      }
      state.syncingCardIds.delete(card.id);
      if (
        isCurrentWorkboardLoadGeneration(params.host, generation) &&
        isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch)
      ) {
        setWorkboardLifecycleTasksPrepared(state, true, {
          host: params.host,
          preparedAt: tasksPreparedAt ?? Date.now(),
          requestUpdate: params.requestUpdate,
        });
      }
      params.requestUpdate?.();
    }
  }
  if (
    !lifecycleWriteStarted &&
    isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch)
  ) {
    setWorkboardLifecycleTasksPrepared(state, true, {
      host: params.host,
      preparedAt: tasksPreparedAt ?? Date.now(),
      requestUpdate: params.requestUpdate,
    });
  }
}
