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
    for (const candidate of activity.activeEmbeddedRuns.values()) {
      if (candidate.runId === embeddedRun.runId) {
        return embeddedRun;
      }
    }
    if (runIdIndex.get(embeddedRun.runId) === activity) {
      runIdIndex.delete(embeddedRun.runId);
    }
    return embeddedRun;
  };
  const clear = (activity: TActivity): void => {
    // Every local owner is leaving; only retain indexes now owned by another activity.
    for (const { runId } of activity.activeEmbeddedRuns.values()) {
      if (runIdIndex.get(runId) === activity) {
        runIdIndex.delete(runId);
      }
    }
    activity.activeEmbeddedRuns.clear();
  };
  return { clear, remove };
}
