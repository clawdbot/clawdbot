import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { BeamStoredSession } from "./types.js";
import { BEAM_MAX_SESSIONS, BEAM_RETENTION_MS } from "./types.js";

export type BeamStore = {
  put: (session: BeamStoredSession) => Promise<void>;
  get: (beamId: string) => Promise<BeamStoredSession | undefined>;
  list: () => Promise<BeamStoredSession[]>;
};

export function createBeamStore(runtime: PluginRuntime): BeamStore {
  const store = runtime.state.openKeyedStore<BeamStoredSession>({
    namespace: "sessions",
    maxEntries: BEAM_MAX_SESSIONS,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: BEAM_RETENTION_MS,
  });
  return {
    put: async (session) => {
      await store.register(session.beamId, session);
    },
    get: (beamId) => store.lookup(beamId),
    list: async () => (await store.entries()).map((entry) => entry.value),
  };
}
