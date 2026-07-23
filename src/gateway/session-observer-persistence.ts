import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";

const PERSIST_INTERVAL_MS = 60_000;

type PersistDigest = NonNullable<SessionObserverDeps["persistDigest"]>;

export function createSessionObserverDigestPersister(params: {
  now: () => number;
  persistDigest: PersistDigest;
  stillCurrent: (runId: string, sessionKey: string) => () => boolean;
  onError: (state: SessionObserverState, error: unknown) => void;
}) {
  const preamblePersistedAt = new WeakMap<SessionObserverState, number>();
  return async (
    state: SessionObserverState,
    digest: SessionObserverDigest,
    final: boolean,
    kind: "model" | "preamble" = "model",
  ) => {
    const lastPersistedAt =
      kind === "preamble" ? preamblePersistedAt.get(state) : state.lastPersistedAt;
    const due =
      lastPersistedAt === undefined || params.now() - lastPersistedAt >= PERSIST_INTERVAL_MS;
    if (!final && !due) {
      return;
    }
    // Live broadcasts are immediate; terminal persistence gets one bounded retry.
    const attempts = final ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const accepted = await params.persistDigest({
          sessionKey: state.sessionKey,
          sessionId: state.sessionId,
          agentId: state.agentId,
          digest,
          stillCurrent: params.stillCurrent(state.runId, state.sessionKey),
        });
        if (accepted) {
          if (kind === "preamble") {
            preamblePersistedAt.set(state, params.now());
          } else {
            state.lastPersistedAt = params.now();
          }
        }
        return;
      } catch (error) {
        if (attempt + 1 === attempts) {
          params.onError(state, error);
        }
      }
    }
  };
}
