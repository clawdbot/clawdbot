type AgentEndCancellationReservation = { readonly id: number };

type ReservationState = AgentEndCancellationReservation & {
  sessionKey: string;
  memberships: Set<string>;
  reconciled: boolean;
};
type RunState = {
  attempts: Map<number, ReservationState>;
  confirmed: boolean;
  promise: Promise<boolean>;
  resolve: (aborted: boolean) => void;
};

function createAgentEndCancellationState(limit = 32) {
  const sessions = new Map<string, Map<string, RunState>>();
  let nextReservationId = 1;
  let cancelPending: ((sessionKey: string) => boolean) | undefined;

  function releaseRun(runId: string, run: RunState): void {
    for (const attempt of run.attempts.values()) {
      attempt.memberships.delete(runId);
    }
    run.attempts.clear();
    if (!run.confirmed) {
      run.resolve(false);
    }
  }

  function runsFor(sessionKey: string): Map<string, RunState> {
    const existing = sessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    if (sessions.size >= limit) {
      const oldestKey = sessions.keys().next().value;
      const oldest = oldestKey ? sessions.get(oldestKey) : undefined;
      for (const [runId, run] of oldest ?? []) {
        releaseRun(runId, run);
      }
      if (oldestKey) {
        sessions.delete(oldestKey);
      }
    }
    const runs = new Map<string, RunState>();
    sessions.set(sessionKey, runs);
    return runs;
  }

  function makeRoom(runs: Map<string, RunState>, runId: string): void {
    if (runs.has(runId) || runs.size < limit) {
      return;
    }
    const oldestId = runs.keys().next().value;
    const oldest = oldestId ? runs.get(oldestId) : undefined;
    if (oldest && oldestId) {
      releaseRun(oldestId, oldest);
    }
    if (oldestId) {
      runs.delete(oldestId);
    }
  }

  function createRunState(): RunState {
    let resolve!: (aborted: boolean) => void;
    const promise = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    return { attempts: new Map(), confirmed: false, promise, resolve };
  }

  return {
    register(canceller: (sessionKey: string) => boolean): void {
      cancelPending = canceller;
    },
    reserve(sessionKey: string, runIds: readonly string[]): AgentEndCancellationReservation {
      const key = sessionKey.trim();
      const attempt: ReservationState = {
        id: nextReservationId++,
        sessionKey: key,
        memberships: new Set(runIds.filter(Boolean)),
        reconciled: false,
      };
      if (!key) {
        attempt.memberships.clear();
        return attempt;
      }
      if (attempt.memberships.size === 0) {
        return attempt;
      }
      const runs = runsFor(key);
      for (const runId of attempt.memberships) {
        makeRoom(runs, runId);
        const run = runs.get(runId) ?? createRunState();
        run.attempts.set(attempt.id, attempt);
        runs.set(runId, run);
      }
      return attempt;
    },
    reconcile(
      reservation: AgentEndCancellationReservation,
      abortedRunIds: readonly string[],
      didAbort: boolean,
    ): boolean {
      const attempt = reservation as ReservationState;
      if (attempt.reconciled) {
        return false;
      }
      attempt.reconciled = true;
      const aborted = new Set(didAbort ? abortedRunIds : []);
      const runs = sessions.get(attempt.sessionKey);
      for (const runId of attempt.memberships) {
        const run = runs?.get(runId);
        attempt.memberships.delete(runId);
        if (!run?.attempts.delete(attempt.id)) {
          continue;
        }
        if (aborted.has(runId) && !run.confirmed) {
          run.confirmed = true;
          run.resolve(true);
        }
        if (!run.confirmed && run.attempts.size === 0) {
          run.resolve(false);
          runs?.delete(runId);
        }
      }
      for (const runId of aborted) {
        if (!runId || runs?.get(runId)?.confirmed) {
          continue;
        }
        const confirmedRuns = runs ?? runsFor(attempt.sessionKey);
        makeRoom(confirmedRuns, runId);
        const run = confirmedRuns.get(runId) ?? createRunState();
        run.confirmed = true;
        run.resolve(true);
        confirmedRuns.set(runId, run);
      }
      if (runs?.size === 0) {
        sessions.delete(attempt.sessionKey);
      }
      return didAbort ? (cancelPending?.(attempt.sessionKey) ?? false) : false;
    },
    async consumeStoppedTerminal(
      sessionKey: string | undefined,
      runId: string | undefined,
      success: boolean,
    ): Promise<boolean> {
      const key = sessionKey?.trim();
      if (!key || !runId || success) {
        return false;
      }
      const run = sessions.get(key)?.get(runId);
      if (!run || (!run.confirmed && !(await run.promise))) {
        return false;
      }
      const runs = sessions.get(key);
      if (!runs?.get(runId)?.confirmed) {
        return false;
      }
      runs.delete(runId);
      if (runs.size === 0) {
        sessions.delete(key);
      }
      return true;
    },
  };
}

export const agentEndCancellation = createAgentEndCancellationState();
