/**
 * Waits for completion-required async tasks before finalizing an attempt.
 */
import { createAbortError as createNamedAbortError } from "../../../infra/abort-signal.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { toErrorObject } from "../../../infra/errors.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { isTerminalTaskStatus } from "../../../tasks/task-executor-policy.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  findTaskByRunIdForStatus,
  listTasksForOwnerOrRequesterSessionKeyForStatus,
} from "../../../tasks/task-status-access.js";

export type AsyncStartedToolMeta = {
  toolName?: string;
  asyncStarted?: boolean;
  asyncTaskRunId?: string;
  asyncTaskId?: string;
};

/** Summary of completion-required async task waits performed before a cron run can finish. */
export type CompletionRequiredAsyncTaskWaitResult = {
  waitedRunIds: string[];
  timedOutRunIds: string[];
  terminalTasks: TaskRecord[];
};

const DEFAULT_ASYNC_TASK_POLL_INTERVAL_MS = 500;
const COMPLETION_REQUIRED_TASK_KINDS = new Set([
  "image_generation",
  "music_generation",
  "video_generation",
]);

function resolveAsyncTaskPollIntervalMs(): number {
  return isFastTestRuntimeEnv() ? 10 : DEFAULT_ASYNC_TASK_POLL_INTERVAL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, ms));
  });
}

function createAbortError(signal: AbortSignal): Error {
  return createNamedAbortError("aborted", {
    cause: "reason" in signal ? (signal as { reason?: unknown }).reason : undefined,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

async function sleepWithAbort(
  ms: number,
  signal: AbortSignal | undefined,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  if (!signal) {
    await sleepFn(ms);
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleepFn(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(toErrorObject(err, "Non-Error rejection"));
      },
    );
  });
}

function collectAsyncTaskRunIds(
  toolMetas: readonly AsyncStartedToolMeta[],
  sessionKey: string | undefined,
  alreadyWaited: ReadonlySet<string>,
): string[] {
  const runIds: string[] = [];
  const seen = new Set<string>();
  const addRunId = (runIdRaw: string | undefined) => {
    const runId = runIdRaw?.trim();
    if (!runId || alreadyWaited.has(runId) || seen.has(runId)) {
      return;
    }
    seen.add(runId);
    runIds.push(runId);
  };
  for (const meta of toolMetas) {
    addRunId(meta.asyncStarted === true ? meta.asyncTaskRunId : undefined);
  }
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return runIds;
  }
  // Registry lookup catches completion-required tasks started before their
  // tool metadata reached the current attempt result.
  for (const task of listTasksForOwnerOrRequesterSessionKeyForStatus(normalizedSessionKey)) {
    if (!COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind ?? "")) {
      continue;
    }
    if (isTerminalTaskStatus(task.status)) {
      continue;
    }
    addRunId(task.runId);
  }
  return runIds;
}

function findTerminalTasks(runIds: readonly string[]): {
  pendingRunIds: string[];
  terminalTasks: TaskRecord[];
} {
  const pendingRunIds: string[] = [];
  const terminalTasks: TaskRecord[] = [];
  for (const runId of runIds) {
    const task = findTaskByRunIdForStatus(runId);
    if (task && isTerminalTaskStatus(task.status)) {
      terminalTasks.push(task);
      continue;
    }
    pendingRunIds.push(runId);
  }
  return { pendingRunIds, terminalTasks };
}

/** Returns whether a cron run has non-terminal generated-media tasks that must settle first. */
export function requiresCompletionRequiredAsyncTaskWait(params: {
  sessionKey: string | undefined;
  toolMetas: readonly AsyncStartedToolMeta[];
}): boolean {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !isCronRunSessionKey(sessionKey)) {
    return false;
  }
  if (
    params.toolMetas.some(
      (meta) => meta.asyncStarted === true && Boolean(meta.asyncTaskRunId?.trim()),
    )
  ) {
    return true;
  }
  return listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey).some(
    (task) =>
      COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind ?? "") &&
      !isTerminalTaskStatus(task.status) &&
      Boolean(task.runId?.trim()),
  );
}

/** Returns whether the current attempt should synchronously wait for media tasks. */
export function shouldWaitForCompletionRequiredAsyncTasks(params: {
  sessionKey: string | undefined;
  toolMetas: readonly AsyncStartedToolMeta[];
  yieldDetected?: boolean;
}): boolean {
  if (params.yieldDetected === true) {
    // sessions_yield pauses the turn so the completion event can wake it later;
    // waiting here would reuse the internal abort signal and turn the pause into AbortError.
    return false;
  }
  return requiresCompletionRequiredAsyncTaskWait({
    sessionKey: params.sessionKey,
    toolMetas: params.toolMetas,
  });
}

/**
 * Polls completion-required async tasks until they reach terminal state, time
 * out at the run deadline, or abort. Newly discovered task run ids are folded
 * into later poll rounds so task metadata and registry state can arrive in any
 * order.
 */
export async function waitForCompletionRequiredAsyncTasks(params: {
  getToolMetas: () => readonly AsyncStartedToolMeta[];
  sessionKey?: string;
  deadlineAtMs: number;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<CompletionRequiredAsyncTaskWaitResult> {
  const now = params.now ?? Date.now;
  const sleepFn = params.sleep ?? sleep;
  const pollIntervalMs = params.pollIntervalMs ?? resolveAsyncTaskPollIntervalMs();
  const waitedRunIds = new Set<string>();
  const timedOutRunIds = new Set<string>();
  const terminalTasksByRunId = new Map<string, TaskRecord>();

  while (true) {
    throwIfAborted(params.abortSignal);
    // Re-read metadata every outer loop; tool calls may record async run ids
    // after an earlier task wait finished.
    const runIds = collectAsyncTaskRunIds(params.getToolMetas(), params.sessionKey, waitedRunIds);
    if (runIds.length === 0) {
      return {
        waitedRunIds: [...waitedRunIds],
        timedOutRunIds: [...timedOutRunIds],
        terminalTasks: [...terminalTasksByRunId.values()],
      };
    }

    for (const runId of runIds) {
      waitedRunIds.add(runId);
    }

    let pendingRunIds = runIds;
    while (pendingRunIds.length > 0) {
      throwIfAborted(params.abortSignal);
      const terminalState = findTerminalTasks(pendingRunIds);
      for (const task of terminalState.terminalTasks) {
        const runId = task.runId?.trim();
        if (runId) {
          terminalTasksByRunId.set(runId, task);
        }
      }
      pendingRunIds = terminalState.pendingRunIds;
      if (pendingRunIds.length === 0) {
        break;
      }
      const remainingMs = params.deadlineAtMs - now();
      if (remainingMs <= 0) {
        for (const runId of pendingRunIds) {
          timedOutRunIds.add(runId);
        }
        return {
          waitedRunIds: [...waitedRunIds],
          timedOutRunIds: [...timedOutRunIds],
          terminalTasks: [...terminalTasksByRunId.values()],
        };
      }
      await sleepWithAbort(Math.min(pollIntervalMs, remainingMs), params.abortSignal, sleepFn);
    }
  }
}
