type SkillExperienceReviewCanceller = (sessionKey: string) => boolean;

function createSkillExperienceReviewCancellationState(maxPendingStops = 32) {
  const stoppedRuns = new Set<string>();
  let cancelReview: SkillExperienceReviewCanceller | undefined;

  const stoppedRunKey = (sessionKey: string, runId: string) => JSON.stringify([sessionKey, runId]);

  return {
    register(canceller: SkillExperienceReviewCanceller): void {
      cancelReview = canceller;
    },
    cancel(sessionKey: string, stoppedRunId?: string): boolean {
      const normalizedSessionKey = sessionKey.trim();
      if (!normalizedSessionKey) {
        return false;
      }
      const normalizedRunId = stoppedRunId?.trim();
      if (normalizedRunId) {
        const key = stoppedRunKey(normalizedSessionKey, normalizedRunId);
        if (!stoppedRuns.has(key) && stoppedRuns.size >= maxPendingStops) {
          const oldestRun = stoppedRuns.values().next().value;
          if (oldestRun !== undefined) {
            stoppedRuns.delete(oldestRun);
          }
        }
        stoppedRuns.add(key);
      }
      return cancelReview?.(normalizedSessionKey) ?? false;
    },
    discardStoppedTerminal(sessionKey: string, runId: string): void {
      const normalizedSessionKey = sessionKey.trim();
      const normalizedRunId = runId.trim();
      if (normalizedSessionKey && normalizedRunId) {
        stoppedRuns.delete(stoppedRunKey(normalizedSessionKey, normalizedRunId));
      }
    },
    consumeStoppedTerminal(
      sessionKey: string | undefined,
      runId: string | undefined,
      success: boolean,
    ): boolean {
      const normalizedSessionKey = sessionKey?.trim();
      const normalizedRunId = runId?.trim();
      return Boolean(
        normalizedSessionKey &&
        normalizedRunId &&
        !success &&
        stoppedRuns.delete(stoppedRunKey(normalizedSessionKey, normalizedRunId)),
      );
    },
  };
}

export const skillExperienceReviewCancellation = createSkillExperienceReviewCancellationState();
