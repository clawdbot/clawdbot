import { AsyncLocalStorage } from "node:async_hooks";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { ToolInputError } from "./tool-input-error.js";
import type {
  ToolSearchCatalogEntry,
  ToolSearchCatalogRef,
  ToolSearchToolContext,
} from "./tool-search-types.js";

type Admission = { ready: Deferred; exclusive: boolean; started: boolean };
type CatalogSchedule = {
  queue: Admission[];
  active: number;
  exclusive: boolean;
  closed: AbortController;
};
type ExecutionScope = {
  schedule: CatalogSchedule;
  exclusive: boolean;
  active: boolean;
  parent?: ExecutionScope;
};

// Refs survive client-tool append and are shared by every cell in an admitted run.
const schedules = new WeakMap<ToolSearchCatalogRef, CatalogSchedule>();
const executionScope = new AsyncLocalStorage<ExecutionScope>();

function createSchedule(owner: ToolSearchCatalogRef): CatalogSchedule {
  const closed = new AbortController();
  const schedule: CatalogSchedule = {
    queue: [],
    active: 0,
    exclusive: false,
    closed,
  };
  schedules.set(owner, schedule);
  return schedule;
}

/** Catalog teardown owns cancellation without retaining another run listener. */
export function disposeToolSearchSchedule(owner: ToolSearchCatalogRef): void {
  const schedule = schedules.get(owner);
  if (!schedule) {
    return;
  }
  schedules.delete(owner);
  schedule.closed.abort(createAbortError("Tool Search catalog was closed."));
}

function drainSchedule(schedule: CatalogSchedule): void {
  while (!schedule.closed.signal.aborted && !schedule.exclusive) {
    const next = schedule.queue[0];
    if (!next || (next.exclusive && schedule.active > 0)) {
      return;
    }
    schedule.queue.shift();
    next.started = true;
    schedule.active += 1;
    schedule.exclusive = next.exclusive;
    next.ready.resolve();
  }
}

export async function runScheduledToolSearchCall<T>(params: {
  ctx: ToolSearchToolContext;
  entry: ToolSearchCatalogEntry;
  signal?: AbortSignal;
  execute: (entry: ToolSearchCatalogEntry, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const owner = params.ctx.catalogRef;
  if (!owner?.current) {
    throw new ToolInputError("Tool Search catalog is unavailable for this run.");
  }
  const schedule = schedules.get(owner) ?? createSchedule(owner);
  const mode = params.entry.tool.executionMode;
  const exclusive = mode === "sequential";
  const parent = executionScope.getStore();
  let ancestor = parent;
  while (ancestor && (!ancestor.active || ancestor.schedule !== schedule)) {
    ancestor = ancestor.parent;
  }
  if (
    ancestor &&
    (ancestor.exclusive || exclusive || schedule.queue.some((entry) => entry.exclusive))
  ) {
    throw new ToolInputError("Reentrant tool call would wait on its own catalog execution.");
  }
  const admission: Admission = { ready: createDeferredCore(), exclusive, started: false };
  // Admit before schema compilation or hooks can reorder callers. Only the
  // contiguous parallel prefix may pass a queued exclusive invocation.
  schedule.queue.push(admission);
  drainSchedule(schedule);
  const signals = [schedule.closed.signal];
  if (params.ctx.abortSignal) {
    signals.push(params.ctx.abortSignal);
  }
  if (params.signal) {
    signals.push(params.signal);
  }
  const signal = AbortSignal.any(signals);
  const scope: ExecutionScope = { schedule, exclusive, active: false, parent };
  try {
    // Queued cancellation must settle even if a predecessor ignores abort.
    await racePromiseWithAbortSignal(admission.ready.promise, signal);
    signal.throwIfAborted();
    const current = owner.current?.entries.find((entry) => entry.id === params.entry.id);
    if (!current || current.tool !== params.entry.tool || current.tool.executionMode !== mode) {
      throw new ToolInputError("Queued tool changed or is no longer available in this run.");
    }
    scope.active = true;
    // Do not race active execution against abort again: accepted results and
    // finalization own release, not an observer that stops waiting early.
    return await executionScope.run(scope, () => params.execute(current, signal));
  } finally {
    scope.active = false;
    if (admission.started) {
      schedule.active -= 1;
      if (exclusive) {
        schedule.exclusive = false;
      }
    } else {
      schedule.queue.splice(schedule.queue.indexOf(admission), 1);
    }
    drainSchedule(schedule);
    if (schedule.active === 0 && schedule.queue.length === 0) {
      if (schedules.get(owner) === schedule) {
        schedules.delete(owner);
      }
    }
  }
}
