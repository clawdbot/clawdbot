/** Waits for asynchronous tool tasks before final reply delivery. */
const DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS = 30_000;

/** Result from waiting for pending tool tasks before final delivery. */
type PendingToolTaskDrainResult = { kind: "settled" } | { kind: "timeout"; remaining: number };

type DrainOptions = {
  tasks: Set<Promise<void>>;
  idleTimeoutMs?: number;
  onTimeout?: (message: string) => void;
};

type PendingTaskObserver = { settled?: (task: Promise<void>) => void };

function observePendingTask(task: Promise<void>, observer: PendingTaskObserver): void {
  // Stuck tasks retain only this detachable observer, never the active drain's
  // task set and callbacks after its idle deadline has ended the wait.
  const settled = () => observer.settled?.(task);
  void task.then(settled, settled);
}

/** Waits for pending tool tasks to settle or times out to avoid session deadlock. */
export async function drainPendingToolTasks({
  tasks,
  idleTimeoutMs = DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS,
  onTimeout,
}: DrainOptions): Promise<PendingToolTaskDrainResult> {
  if (tasks.size === 0) {
    return { kind: "settled" };
  }
  if (idleTimeoutMs <= 0) {
    return { kind: "timeout", remaining: tasks.size };
  }

  const observed = new WeakSet<Promise<void>>();
  const observer: PendingTaskObserver = {};
  const outcome = await new Promise<"settled" | "timeout">((resolve) => {
    const finish = (result: "settled" | "timeout") => {
      observer.settled = undefined;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish("timeout"), idleTimeoutMs);
    timeout.unref?.();
    const observeNewTasks = () => {
      for (const task of tasks) {
        if (!observed.has(task)) {
          observed.add(task);
          observePendingTask(task, observer);
        }
      }
    };
    observer.settled = (task) => {
      observed.delete(task);
      tasks.delete(task);
      if (tasks.size === 0) {
        finish("settled");
      } else {
        timeout.refresh();
        observeNewTasks();
      }
    };
    observeNewTasks();
  });
  if (outcome === "timeout") {
    const remaining = tasks.size;
    onTimeout?.(
      `pending tool tasks made no progress within ${idleTimeoutMs}ms; proceeding with ${remaining} task(s) still pending to avoid session deadlock`,
    );
    return { kind: "timeout", remaining };
  }

  return { kind: "settled" };
}
