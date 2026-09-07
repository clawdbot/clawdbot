import type { MeetingSessionCleanupOwner } from "./session-runtime-types.js";

type MeetingSessionCleanupState = {
  browserLeft?: boolean;
  browserSettled: boolean;
  stopSettled: boolean;
  hasPendingSetup?: () => boolean;
};

/** A rejected replacement can leave both the old engine and its candidate transport open. */
function combineMeetingSessionStops(
  previous: () => Promise<void>,
  candidate: () => Promise<void>,
): () => Promise<void> {
  const remaining = new Set([previous, candidate]);
  let inFlight: Promise<void> | undefined;
  return async () => {
    if (inFlight) {
      return await inFlight;
    }
    const cleanup = Promise.allSettled(
      Array.from(remaining, async (stop) => {
        await stop();
        remaining.delete(stop);
      }),
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Meeting engine cleanup failed");
      }
    });
    inFlight = cleanup;
    try {
      await cleanup;
    } finally {
      if (inFlight === cleanup) {
        inFlight = undefined;
      }
    }
  };
}

export class MeetingSessionCleanupTracker {
  readonly #states = new Map<string, MeetingSessionCleanupState>();

  begin(sessionId: string, browserLeft?: boolean): boolean {
    if (this.#states.has(sessionId)) {
      return false;
    }
    this.#states.set(sessionId, { browserLeft, browserSettled: false, stopSettled: false });
    return true;
  }

  isPending(sessionId: string): boolean {
    return this.#states.has(sessionId);
  }

  resetStop(sessionId: string): void {
    const state = this.#states.get(sessionId);
    if (state) {
      state.stopSettled = false;
    }
  }

  finishSetup(sessionId: string, stopSettled: boolean): boolean {
    const state = this.#states.get(sessionId);
    if (!state) {
      return false;
    }
    state.stopSettled = stopSettled;
    return this.#completeIfSettled(sessionId, state);
  }

  async recover<THandles extends { stop?: () => Promise<void> }>(params: {
    sessionId: string;
    owner: MeetingSessionCleanupOwner;
    browserLeft?: boolean;
    isCurrent: () => boolean;
    isActive: () => boolean;
    setup: (
      onCleanupReady: (stop: () => Promise<void>) => Promise<void>,
    ) => Promise<THandles | undefined>;
    clearAdmission: () => void;
    attach: (handles: THandles) => void;
    retainPending: () => void;
  }): Promise<void> {
    const { owner, sessionId, isCurrent, isActive } = params;
    if (owner.recovery) {
      return await owner.recovery;
    }
    let candidateStop: (() => Promise<void>) | undefined;
    const recovery = Promise.resolve().then(async () => {
      try {
        if (!isCurrent() || !isActive()) {
          return;
        }
        const handles = await params.setup(async (stop) => {
          candidateStop = stop;
          const previous = owner.stop;
          const handoff =
            previous && previous !== stop ? combineMeetingSessionStops(previous, stop) : stop;
          owner.stop = handoff;
          if (!isCurrent()) {
            throw new Error("Meeting cleanup owner changed during provider setup");
          }
          this.resetStop(sessionId);
          if (!isActive()) {
            throw new Error("Meeting session ended before provider setup");
          }
          params.clearAdmission();
          if (previous && previous !== stop) {
            try {
              await previous();
            } catch (error) {
              if (isCurrent()) {
                this.begin(sessionId, params.browserLeft);
                params.retainPending();
              }
              throw error;
            }
          }
          if (!isCurrent() || !isActive() || owner.stop !== handoff) {
            throw new Error("Meeting cleanup owner changed during provider setup");
          }
          owner.stop = stop;
        });
        candidateStop ??= handles?.stop;
        if (!isCurrent() || !isActive()) {
          await candidateStop?.();
          if (owner.stop === candidateStop) {
            owner.stop = undefined;
          }
          return;
        }
        if (handles) {
          params.attach(handles);
        }
      } catch (error) {
        if (candidateStop) {
          try {
            await candidateStop();
            if (owner.stop === candidateStop) {
              owner.stop = undefined;
            }
          } catch {
            if (isCurrent()) {
              this.begin(sessionId, params.browserLeft);
              params.retainPending();
            }
          }
        }
        throw error;
      }
    });
    owner.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (owner.recovery === recovery) {
        owner.recovery = undefined;
      }
    }
  }

  async cleanup(params: {
    sessionId: string;
    stop?: () => Promise<void>;
    keepBrowserTab: boolean;
    releaseBrowser: () => Promise<boolean | undefined>;
    hasPendingSetup?: () => boolean;
    isStopSettled?: () => boolean;
  }): Promise<{ browserLeft?: boolean; complete: boolean; stopSettled: boolean }> {
    const state = this.#states.get(params.sessionId);
    if (!state) {
      throw new Error("Missing cleanup state for meeting session " + params.sessionId);
    }
    state.hasPendingSetup = params.hasPendingSetup;
    let cleanupError: unknown;
    if (!state.stopSettled) {
      try {
        await params.stop?.();
        state.stopSettled = params.isStopSettled?.() ?? true;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (!state.browserSettled) {
      try {
        if (params.keepBrowserTab) {
          state.browserSettled = true;
        } else {
          state.browserLeft = await params.releaseBrowser();
          state.browserSettled = state.browserLeft !== false;
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    const complete = this.#completeIfSettled(params.sessionId, state);
    if (cleanupError) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Meeting session cleanup failed", { cause: cleanupError });
    }
    return { browserLeft: state.browserLeft, complete, stopSettled: state.stopSettled };
  }

  async retryBrowserAfterFailedJoin(params: {
    sessionId: string;
    browserLeft?: boolean;
    hasBrowserTab: () => boolean;
    releaseBrowser: () => Promise<boolean | undefined>;
  }): Promise<{ browserLeft?: boolean; complete: boolean; error?: unknown; incomplete: boolean }> {
    const state = this.#states.get(params.sessionId);
    if (!state) {
      return { browserLeft: params.browserLeft, complete: true, incomplete: false };
    }
    if (!params.hasBrowserTab()) {
      state.browserSettled ||= state.browserLeft !== false;
    } else if (!state.browserSettled) {
      try {
        state.browserLeft = await params.releaseBrowser();
        state.browserSettled = state.browserLeft !== false;
      } catch (error) {
        return {
          browserLeft: state.browserLeft,
          complete: false,
          error,
          incomplete: params.hasBrowserTab(),
        };
      }
    }
    return {
      browserLeft: state.browserLeft,
      complete: this.#completeIfSettled(params.sessionId, state),
      incomplete: params.hasBrowserTab(),
    };
  }

  async rollbackFailedJoin(params: {
    sessionId: string;
    browserLeft?: boolean;
    leave: () => Promise<unknown>;
    hasBrowserTab: () => boolean;
    releaseBrowser: () => Promise<boolean | undefined>;
    formatError: (error: unknown) => string;
    warn: (message: string) => void;
    onBrowserResult: (left: boolean | undefined) => void;
    onComplete: () => void;
  }): Promise<void> {
    // Retry failed-start cleanup once, then make one final browser settlement attempt.
    // The caller retains an ended session when cleanup still needs an owner.
    let retryFullCleanup = false;
    try {
      await params.leave();
    } catch (error) {
      params.warn(`replacement cleanup failed: ${params.formatError(error)}`);
      retryFullCleanup = true;
    }
    if (retryFullCleanup) {
      try {
        await params.leave();
      } catch (error) {
        params.warn(`replacement cleanup retry failed: ${params.formatError(error)}`);
      }
    }
    const retry = await this.retryBrowserAfterFailedJoin(params);
    params.onBrowserResult(retry.browserLeft);
    if (retry.error) {
      params.warn(`replacement browser cleanup retry failed: ${params.formatError(retry.error)}`);
    }
    if (retry.complete) {
      params.onComplete();
    }
    if (retry.incomplete) {
      params.warn("replacement browser cleanup incomplete after failed join");
    }
  }

  #completeIfSettled(sessionId: string, state: MeetingSessionCleanupState): boolean {
    if (!state.stopSettled || !state.browserSettled || state.hasPendingSetup?.()) {
      return false;
    }
    this.#states.delete(sessionId);
    return true;
  }
}
