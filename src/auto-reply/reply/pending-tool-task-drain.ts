/** Waits for asynchronous tool tasks before final reply delivery. */
const DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS = 30_000;

/** Result from waiting for pending tool tasks before final delivery. */
type PendingToolTaskDrainResult = { kind: "settled" } | { kind: "timeout"; remaining: number };

type DrainOptions = {
  tasks: Set<Promise<void>>;
  idleTimeoutMs?: number;
  onTimeout?: (message: string) => void;
};

function createIdleTimeoutPromise(timeoutMs: number): {
  promise: Promise<"timeout">;
  clear: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    timeoutId.unref?.();
  });
  return {
    promise,
    clear: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
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

  while (tasks.size > 0) {
    // Snapshot current tasks; newly added tasks are handled in later loop passes.
    const snapshot = [...tasks];
    const timeout = createIdleTimeoutPromise(idleTimeoutMs);
    const outcome = await Promise.race<{ kind: "settled"; task: Promise<void> } | "timeout">([
      timeout.promise,
      ...snapshot.map((task) =>
        task.then(
          () => ({ kind: "settled" as const, task }),
          () => ({ kind: "settled" as const, task }),
        ),
      ),
    ]);
    timeout.clear();

    if (outcome === "timeout") {
      const remaining = tasks.size;
      onTimeout?.(
        `pending tool tasks made no progress within ${idleTimeoutMs}ms; proceeding with ${remaining} task(s) still pending to avoid session deadlock`,
      );
      return { kind: "timeout", remaining };
    }

    tasks.delete(outcome.task);
  }

  return { kind: "settled" };
}
