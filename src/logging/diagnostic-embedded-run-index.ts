type EmbeddedRunActivity<TRun extends { runId: string }> = {
  activeEmbeddedRuns: Map<string, TRun>;
};

export function createDiagnosticEmbeddedRunIndex<
  TRun extends { runId: string },
  TActivity extends EmbeddedRunActivity<TRun>,
>(runIdIndex: Map<string, TActivity>) {
  const remove = (activity: TActivity, workKey: string): TRun | undefined => {
    const embeddedRun = activity.activeEmbeddedRuns.get(workKey);
    if (!embeddedRun) {
      return undefined;
    }
    activity.activeEmbeddedRuns.delete(workKey);
    const runIdStillActive = Array.from(activity.activeEmbeddedRuns.values()).some(
      (candidate) => candidate.runId === embeddedRun.runId,
    );
    if (!runIdStillActive && runIdIndex.get(embeddedRun.runId) === activity) {
      runIdIndex.delete(embeddedRun.runId);
    }
    return embeddedRun;
  };
  const clear = (activity: TActivity): void => {
    for (const workKey of Array.from(activity.activeEmbeddedRuns.keys())) {
      remove(activity, workKey);
    }
  };
  return { clear, remove };
}
