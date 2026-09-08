import { AsyncLocalStorage } from "node:async_hooks";
import { createAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type MaintenanceOwner = {
  sequence: number;
  lifecycleGeneration: string;
  controller: AbortController;
  done: Promise<void>;
  writesDone: Promise<void>;
  writesReleased: boolean;
  predecessors: readonly MaintenanceOwner[];
  preemptible: boolean;
  running: boolean;
};
type SessionMaintenance = {
  owners: Set<MaintenanceOwner>;
  foreground: number;
  wake: Set<() => void>;
};
const log = createSubsystemLogger("agents/session-maintenance");
function recordPhase(sessionKey: string, owner: MaintenanceOwner, phase: string): void {
  if (owner.preemptible) {
    log.debug("session maintenance lifecycle", {
      event: "session_maintenance",
      phase,
      sessionKey,
      maintenanceId: owner.sequence,
      lifecycleGeneration: owner.lifecycleGeneration,
    });
  }
}
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionMaintenance"),
  () => ({
    sequence: 0,
    sessions: new Map<string, SessionMaintenance>(),
    current: new AsyncLocalStorage<ReadonlySet<MaintenanceOwner>>(),
  }),
  (current) => {
    for (const session of current.sessions.values()) {
      for (const owner of session.owners) {
        owner.controller.abort(createAbortError("Session maintenance stopped with its host"));
      }
    }
  },
);

function sessionState(key: string): SessionMaintenance {
  let session = state.sessions.get(key);
  if (!session) {
    session = { owners: new Set(), foreground: 0, wake: new Set() };
    state.sessions.set(key, session);
  }
  return session;
}

function releaseSessionState(key: string, session: SessionMaintenance): void {
  if (!session.foreground && !session.owners.size && state.sessions.get(key) === session) {
    state.sessions.delete(key);
  }
}

function independentOwners(
  session: SessionMaintenance | undefined,
  current: ReadonlySet<MaintenanceOwner> | undefined,
): MaintenanceOwner[] {
  const blocked = new Set(current);
  // Owners are registered in dependency order. Work waiting on an active ancestor
  // cannot precede its child; released writes no longer propagate that dependency.
  return [...(session?.owners ?? [])].filter((owner) => {
    if (
      blocked.has(owner) ||
      owner.predecessors.some(
        (predecessor) => !predecessor.writesReleased && blocked.has(predecessor),
      )
    ) {
      blocked.add(owner);
      return false;
    }
    return true;
  });
}

registerAgentEventLifecycleRotationHandler("session-maintenance", () => {
  for (const session of state.sessions.values()) {
    for (const owner of session.owners) {
      owner.controller.abort(createAbortError("Session maintenance retired with its lifecycle"));
    }
  }
});

/** Tracks a producer's real completion; cancellation never releases a writer early. */
export function createSessionMaintenanceOwner(params: {
  sessionKey: string;
  preemptible?: boolean;
  abortSignal?: AbortSignal;
}) {
  const key = params.sessionKey.trim();
  const session = sessionState(key);
  const generation = getAgentEventLifecycleGeneration();
  const ancestors = state.current.getStore() ?? new Set<MaintenanceOwner>();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    getGatewayRestartDrainSignal(),
    ...(params.abortSignal ? [params.abortSignal] : []),
  ]);
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let finishWrites = () => {};
  const writesDone = new Promise<void>((resolve) => {
    finishWrites = resolve;
  });
  const releaseWrites = () => {
    owner.writesReleased = true;
    owner.predecessors = [];
    finishWrites();
  };
  const owner: MaintenanceOwner = {
    sequence: state.sequence++,
    lifecycleGeneration: generation,
    controller,
    done,
    writesDone,
    writesReleased: false,
    predecessors: independentOwners(session, ancestors),
    preemptible: params.preemptible === true,
    running: params.preemptible !== true,
  };
  session.owners.add(owner);
  recordPhase(key, owner, "pending");
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertAgentRunLifecycleGenerationCurrent(generation);
    if (owner.writesReleased || !session.owners.has(owner)) {
      throw createAbortError("Session maintenance owner is closed");
    }
  };
  return {
    signal,
    done,
    assertCurrent,
    releaseWrites,
    run: async <T>(run: () => Promise<T>): Promise<T> => {
      // Waiting on successors would make nested model reads mutually await sibling work.
      await Promise.all(owner.predecessors.map((predecessor) => predecessor.writesDone));
      if (owner.preemptible) {
        while (session.foreground > 0) {
          let wake = () => {};
          const available = new Promise<void>((resolve) => {
            wake = resolve;
          });
          session.wake.add(wake);
          try {
            await racePromiseWithAbortSignal(available, signal);
          } finally {
            session.wake.delete(wake);
          }
        }
        assertCurrent();
        owner.running = true;
        recordPhase(key, owner, "started");
      }
      // A maintenance model call and a coalesced child must not wait on their own parent.
      return state.current.run(new Set([...ancestors, owner]), run);
    },
    track: <T>(work: Promise<T>): Promise<T> =>
      work.finally(() => {
        releaseWrites();
        session.owners.delete(owner);
        recordPhase(key, owner, "settled");
        finish();
        releaseSessionState(key, session);
      }),
  };
}

/** Reserve foreground priority before queueing so optional work cannot seize its lane. */
export async function beginForegroundSessionMaintenance(sessionKey?: string): Promise<() => void> {
  const key = sessionKey?.trim();
  if (!key) {
    return () => {};
  }
  const session = sessionState(key);
  session.foreground += 1;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    session.foreground -= 1;
    if (!session.foreground) {
      for (const wake of session.wake) {
        wake();
      }
    }
    releaseSessionState(key, session);
  };
  const current = state.current.getStore();
  const existing = independentOwners(session, current);
  const optional = existing.filter((owner) => owner.preemptible);
  for (const owner of optional) {
    recordPhase(key, owner, "foreground_preemption_requested");
    owner.controller.abort(createAbortError("Session maintenance yielded to a foreground turn"));
  }
  await Promise.all(
    existing.filter((owner) => owner.running || owner.preemptible).map((owner) => owner.done),
  );
  return release;
}

/** Read checkpoint shared by foreground and nested maintenance inference. */
export async function waitForSessionMaintenance(sessionKey?: string): Promise<void> {
  const session = sessionKey ? state.sessions.get(sessionKey.trim()) : undefined;
  const current = state.current.getStore();
  await Promise.all(
    independentOwners(session, current)
      .filter((owner) => owner.running || session?.foreground === 0)
      .map((owner) => (current?.size ? owner.writesDone : owner.done)),
  );
}
