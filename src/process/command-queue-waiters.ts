import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ActiveTaskWaiter = {
  activeTaskIds: Set<number>;
  resolve: (value: { drained: boolean }) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type CommandLaneIdleWaiter = {
  lane: string;
  resolve: (value: { idle: boolean }) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

const COMMAND_QUEUE_WAITERS_KEY = Symbol.for("openclaw.commandQueueWaiters");

function getWaiterState() {
  return resolveGlobalSingleton(COMMAND_QUEUE_WAITERS_KEY, () => ({
    activeTaskWaiters: new Set<ActiveTaskWaiter>(),
    laneIdleWaiters: new Map<string, Set<CommandLaneIdleWaiter>>(),
  }));
}

function resolveActiveTaskWaiter(waiter: ActiveTaskWaiter, result: { drained: boolean }): void {
  const state = getWaiterState();
  if (!state.activeTaskWaiters.delete(waiter)) {
    return;
  }
  if (waiter.timeout) {
    clearTimeout(waiter.timeout);
  }
  waiter.resolve(result);
}

export function notifyActiveCommandTaskWaiters(
  hasPendingActiveTasks: (taskIds: Set<number>) => boolean,
): void {
  for (const waiter of Array.from(getWaiterState().activeTaskWaiters)) {
    if (waiter.activeTaskIds.size === 0 || !hasPendingActiveTasks(waiter.activeTaskIds)) {
      resolveActiveTaskWaiter(waiter, { drained: true });
    }
  }
}

export function waitForActiveCommandTasks(params: {
  activeTaskIds: Set<number>;
  hasPendingActiveTasks: (taskIds: Set<number>) => boolean;
  timeoutMs?: number;
}): Promise<{ drained: boolean }> {
  if (params.activeTaskIds.size === 0) {
    return Promise.resolve({ drained: true });
  }
  if (params.timeoutMs !== undefined && params.timeoutMs <= 0) {
    return Promise.resolve({ drained: false });
  }
  return new Promise((resolve) => {
    const waiter: ActiveTaskWaiter = {
      activeTaskIds: params.activeTaskIds,
      resolve,
    };
    if (params.timeoutMs !== undefined) {
      waiter.timeout = setTimeout(
        () => resolveActiveTaskWaiter(waiter, { drained: false }),
        params.timeoutMs,
      );
    }
    getWaiterState().activeTaskWaiters.add(waiter);
    notifyActiveCommandTaskWaiters(params.hasPendingActiveTasks);
  });
}

function resolveCommandLaneIdleWaiter(
  waiter: CommandLaneIdleWaiter,
  result: { idle: boolean },
): void {
  const state = getWaiterState();
  const laneWaiters = state.laneIdleWaiters.get(waiter.lane);
  if (!laneWaiters?.delete(waiter)) {
    return;
  }
  if (laneWaiters.size === 0) {
    state.laneIdleWaiters.delete(waiter.lane);
  }
  if (waiter.timeout) {
    clearTimeout(waiter.timeout);
  }
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener("abort", waiter.abortHandler);
  }
  waiter.resolve(result);
}

export function notifyCommandLaneIdleWaitersForState(
  lane: string,
  isLaneIdle: (lane: string) => boolean,
): void {
  const laneWaiters = getWaiterState().laneIdleWaiters.get(lane);
  if (!laneWaiters || laneWaiters.size === 0 || !isLaneIdle(lane)) {
    return;
  }
  for (const waiter of Array.from(laneWaiters)) {
    resolveCommandLaneIdleWaiter(waiter, { idle: true });
  }
}

export function notifyAllCommandLaneIdleWaitersForState(
  isLaneIdle: (lane: string) => boolean,
): void {
  for (const lane of Array.from(getWaiterState().laneIdleWaiters.keys())) {
    notifyCommandLaneIdleWaitersForState(lane, isLaneIdle);
  }
}

export function waitForCommandLaneIdleState(params: {
  lane: string;
  isLaneIdle: (lane: string) => boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ idle: boolean }> {
  if (params.isLaneIdle(params.lane)) {
    return Promise.resolve({ idle: true });
  }
  if (params.signal?.aborted || (params.timeoutMs !== undefined && params.timeoutMs <= 0)) {
    return Promise.resolve({ idle: false });
  }
  return new Promise((resolve) => {
    const waiter: CommandLaneIdleWaiter = {
      lane: params.lane,
      resolve,
      signal: params.signal,
    };
    if (params.timeoutMs !== undefined) {
      waiter.timeout = setTimeout(
        () => resolveCommandLaneIdleWaiter(waiter, { idle: false }),
        clampPositiveTimerTimeoutMs(params.timeoutMs),
      );
      waiter.timeout.unref?.();
    }
    if (params.signal) {
      waiter.abortHandler = () => resolveCommandLaneIdleWaiter(waiter, { idle: false });
      params.signal.addEventListener("abort", waiter.abortHandler, { once: true });
    }
    const state = getWaiterState();
    const laneWaiters = state.laneIdleWaiters.get(params.lane) ?? new Set();
    laneWaiters.add(waiter);
    state.laneIdleWaiters.set(params.lane, laneWaiters);
    notifyCommandLaneIdleWaitersForState(params.lane, params.isLaneIdle);
  });
}

export function resetCommandQueueWaiters(): void {
  const state = getWaiterState();
  for (const waiter of Array.from(state.activeTaskWaiters)) {
    resolveActiveTaskWaiter(waiter, { drained: true });
  }
  for (const laneWaiters of Array.from(state.laneIdleWaiters.values())) {
    for (const waiter of Array.from(laneWaiters)) {
      resolveCommandLaneIdleWaiter(waiter, { idle: true });
    }
  }
}
