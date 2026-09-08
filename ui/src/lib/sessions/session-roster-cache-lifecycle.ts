import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { resolveBootRecordAuth } from "../../app/boot-record.ts";
import type { SessionGateway, SessionListOptions, SessionState } from "./session-capability.ts";
import { sessionRosterCache, type SessionRosterCacheOptions } from "./session-roster-cache.ts";

export function createSessionRosterCacheLifecycle(
  gateway: SessionGateway,
  agentSelection: { readonly state: { readonly selectedId: string | null } },
  options: SessionRosterCacheOptions,
  host: {
    readState: () => SessionState;
    publish: (state: SessionState) => void;
    connected: () => boolean;
    query: () => SessionListOptions;
  },
) {
  const cache = options.rosterCache ?? sessionRosterCache;
  const currentScope = () =>
    gateway.connection
      ? gatewayCredentialScope(gateway.connection.gatewayUrl)
      : options.bootRecord?.scope;
  let cachedScope = currentScope();
  let cachedConnectionRevision = gateway.connectionRevision;
  let cachedProfileId = options.bootRecord?.profileId;
  const retirement = new AbortController();
  const initial = {
    scope: cachedScope,
    connectionRevision: cachedConnectionRevision,
    agentId: agentSelection.state.selectedId,
    profileId: cachedProfileId,
    query: {},
  };
  // Connection readiness releases waiters even if the lazy module or IndexedDB stalls.
  const settled = new Promise<void>((resolve) => {
    if (!options.bootRecord || gateway.snapshot.phase === "connected") {
      resolve();
      return;
    }
    retirement.signal.addEventListener("abort", () => resolve(), { once: true });
    void import("./session-roster-cache.reader.ts")
      .then(({ hydrateSessionRoster }) =>
        hydrateSessionRoster(gateway, agentSelection, cache, host, initial, retirement.signal),
      )
      .then(resolve, resolve);
  });

  return {
    settled,
    synchronize(snapshot: SessionGateway["snapshot"]): void {
      if (snapshot.phase === "connected") {
        retirement.abort();
      }
      if (
        currentScope() !== cachedScope ||
        gateway.connectionRevision !== cachedConnectionRevision ||
        (snapshot.phase === "connected" &&
          cachedProfileId !== undefined &&
          cachedProfileId !== (snapshot.selfUser?.id ?? null))
      ) {
        cachedProfileId = undefined;
        cachedScope = currentScope();
        cachedConnectionRevision = gateway.connectionRevision;
        retirement.abort();
        host.publish({
          ...host.readState(),
          result: null,
          resultCached: false,
          agentId: null,
          groups: [],
          groupSettings: [],
          sectionOrder: [],
        });
      }
    },
    persist(state: SessionState) {
      if (
        !state.result ||
        state.resultCached ||
        !host.connected() ||
        !gateway.connection ||
        !resolveBootRecordAuth(gateway.snapshot.hello?.auth, gateway.connection.token)
      ) {
        return;
      }
      cachedProfileId = undefined;
      cache.write({
        version: 1,
        scope: gatewayCredentialScope(gateway.connection.gatewayUrl),
        savedAt: Date.now(),
        profileId: gateway.snapshot.selfUser?.id ?? null,
        agentId: state.agentId,
        query: host.query(),
        result: state.result,
        groups: state.groups,
        groupSettings: state.groupSettings,
        sectionOrder: state.sectionOrder,
      });
    },
    dispose() {
      retirement.abort();
    },
  };
}
