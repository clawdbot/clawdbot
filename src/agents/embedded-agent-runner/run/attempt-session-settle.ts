/** Tracks native prompt and abort settlement through attempt cleanup. */
import type { AgentSession } from "../../sessions/index.js";

export function createEmbeddedAttemptSessionSettleTracker(
  activeSession: Pick<AgentSession, "abort">,
): {
  abortActiveSession: (reason?: unknown) => Promise<void>;
  buildAbortSettlePromise: () => Promise<void> | null;
  trackPromptSettlePromise: (promise: Promise<void>) => Promise<void>;
} {
  const inFlightPromptSettlePromises = new Set<Promise<void>>();
  const inFlightAbortSettlePromises = new Set<Promise<void>>();
  const trackSettlePromise = (
    promises: Set<Promise<void>>,
    promise: Promise<void>,
  ): Promise<void> => {
    promises.add(promise);
    void promise.then(
      () => {
        promises.delete(promise);
      },
      () => {
        promises.delete(promise);
      },
    );
    return promise;
  };

  const trackPromptSettlePromise = (promise: Promise<void>): Promise<void> =>
    trackSettlePromise(inFlightPromptSettlePromises, promise);
  const abortActiveSession = (reason?: unknown): Promise<void> =>
    trackSettlePromise(inFlightAbortSettlePromises, Promise.resolve(activeSession.abort(reason)));
  const buildAbortSettlePromise = (): Promise<void> | null => {
    const promises = [...inFlightPromptSettlePromises, ...inFlightAbortSettlePromises];
    return promises.length === 0 ? null : Promise.allSettled(promises).then(() => undefined);
  };

  return {
    abortActiveSession,
    buildAbortSettlePromise,
    trackPromptSettlePromise,
  };
}
