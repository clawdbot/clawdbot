type MeetingSessionCleanupState = {
  browserLeft?: boolean;
  browserSettled: boolean;
  stopSettled: boolean;
};

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

  async cleanup(params: {
    sessionId: string;
    stop?: () => Promise<void>;
    keepBrowserTab: boolean;
    releaseBrowser: () => Promise<boolean | undefined>;
  }): Promise<{ browserLeft?: boolean; complete: boolean; stopSettled: boolean }> {
    const state = this.#states.get(params.sessionId);
    if (!state) {
      throw new Error("Missing cleanup state for meeting session " + params.sessionId);
    }
    let cleanupError: unknown;
    if (!state.stopSettled) {
      try {
        await params.stop?.();
        state.stopSettled = true;
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
    // Unpublished replacements have no later leave caller. Retry full cleanup once,
    // then make one final browser settlement attempt before releasing ownership.
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
    if (!state.stopSettled || !state.browserSettled) {
      return false;
    }
    this.#states.delete(sessionId);
    return true;
  }
}
