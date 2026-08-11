type SkillExperienceReviewCanceller = (sessionKey: string) => boolean;

function createSkillExperienceReviewCancellationState(maxPendingStops = 32) {
  const stoppedSessions = new Set<string>();
  let cancelReview: SkillExperienceReviewCanceller | undefined;

  return {
    register(canceller: SkillExperienceReviewCanceller): void {
      cancelReview = canceller;
    },
    cancel(sessionKey: string, suppressNextTerminal: boolean): boolean {
      const normalizedSessionKey = sessionKey.trim();
      if (!normalizedSessionKey) {
        return false;
      }
      if (suppressNextTerminal) {
        if (!stoppedSessions.has(normalizedSessionKey) && stoppedSessions.size >= maxPendingStops) {
          const oldestSessionKey = stoppedSessions.values().next().value;
          if (oldestSessionKey !== undefined) {
            stoppedSessions.delete(oldestSessionKey);
          }
        }
        stoppedSessions.add(normalizedSessionKey);
      }
      return cancelReview?.(normalizedSessionKey) ?? false;
    },
    consumeStoppedTerminal(sessionKey: string | undefined, success: boolean): boolean {
      const normalizedSessionKey = sessionKey?.trim();
      return Boolean(
        normalizedSessionKey && !success && stoppedSessions.delete(normalizedSessionKey),
      );
    },
  };
}

export const skillExperienceReviewCancellation = createSkillExperienceReviewCancellationState();
