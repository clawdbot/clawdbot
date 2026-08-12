type FailedLaunchRollback = () => boolean | Promise<boolean>;

const pendingRollbacks = new Map<string, FailedLaunchRollback>();

export function registerFailedLaunchRollback(runId: string, rollback?: FailedLaunchRollback): void {
  if (rollback) {
    pendingRollbacks.set(runId, rollback);
  } else {
    pendingRollbacks.delete(runId);
  }
}

/** Returns undefined after restart, when onSubagentEnded owns recovery instead. */
export async function runFailedLaunchRollback(runId: string): Promise<boolean | undefined> {
  const rollback = pendingRollbacks.get(runId);
  if (!rollback) {
    return undefined;
  }
  const completed = await rollback();
  if (completed && pendingRollbacks.get(runId) === rollback) {
    pendingRollbacks.delete(runId);
  }
  return completed;
}

export function clearFailedLaunchRollbacks(): void {
  pendingRollbacks.clear();
}
