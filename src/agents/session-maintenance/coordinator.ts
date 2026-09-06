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
  const predecessors = [...session.owners].filter((owner) => !ancestors.has(owner));
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
  let writesReleased = false;
  const writesDone = new Promise<void>((resolve) => {
    finishWrites = resolve;
  });
  const releaseWrites = () => {
    writesReleased = true;
    finishWrites();
  };
  const owner: MaintenanceOwner = {
    sequence: state.sequence++,
    lifecycleGeneration: generation,
    controller,
    done,
    writesDone,
    preemptible: params.preemptible === true,
    running: params.preemptible !== true,
  };
  session.owners.add(owner);
  recordPhase(key, owner, "pending");
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertAgentRunLifecycleGenerationCurrent(generation);
    if (writesReleased || !session.owners.has(owner)) {
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
      await Promise.all(predecessors.map((predecessor) => predecessor.writesDone));
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
  const existing = [...session.owners].filter((owner) => !current?.has(owner));
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
  const sequence = current?.size
    ? Math.max(...[...current].map((owner) => owner.sequence))
    : undefined;
  await Promise.all(
    [...(session?.owners ?? [])]
      .filter(
        (owner) =>
          (owner.running || session?.foreground === 0) &&
          !current?.has(owner) &&
          (sequence === undefined || owner.sequence < sequence),
      )
      .map((owner) => (sequence === undefined ? owner.done : owner.writesDone)),
  );
}
