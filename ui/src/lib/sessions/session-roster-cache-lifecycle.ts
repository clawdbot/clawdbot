import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { BootRecord } from "../../app/boot-record.ts";
import type { SessionGateway, SessionListOptions, SessionState } from "./session-capability.ts";
import {
  rosterRecordMatches,
  sessionRosterCache,
  type SessionRosterCache,
} from "./session-roster-cache.ts";

export type SessionRosterCacheOptions = {
  rosterCache?: SessionRosterCache;
  bootRecord?: BootRecord | null;
};

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
  const startupAgentId = agentSelection.state.selectedId ?? null;
  const currentScope = () =>
    gateway.connection
      ? gatewayCredentialScope(gateway.connection.gatewayUrl)
      : options.bootRecord?.scope;
  const startupScope = currentScope();
  const startupConnectionRevision = gateway.connectionRevision;
  let cachedScope = startupScope;
  let cachedConnectionRevision = startupConnectionRevision;
  const expected = { agentId: startupAgentId, profileId: options.bootRecord?.profileId, query: {} };
  let retired = gateway.snapshot.phase === "connected";
  let cachedProfileId = options.bootRecord?.profileId;
  let disposed = false;
  const settled =
    options.bootRecord && startupScope && !retired && host.readState().result === null
      ? cache
          .read(startupScope, expected)
          .then((record) => {
            if (
              !record ||
              disposed ||
              retired ||
              host.readState().result !== null ||
              gateway.snapshot.phase === "connected" ||
              agentSelection.state.selectedId !== startupAgentId ||
              currentScope() !== startupScope ||
              gateway.connectionRevision !== startupConnectionRevision ||
              !rosterRecordMatches(record, expected)
            ) {
              return;
            }
            cachedProfileId = record.profileId;
            host.publish({
              ...host.readState(),
              result: record.result,
              agentId: record.agentId,
              groups: record.groups,
              groupSettings: record.groupSettings,
              sectionOrder: record.sectionOrder,
              resultCached: true,
            });
          })
          .catch(() => undefined)
      : Promise.resolve();

  return {
    settled,
    synchronize(snapshot: SessionGateway["snapshot"]): void {
      if (snapshot.phase === "connected") {
        retired = true;
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
        retired = true;
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
      if (!state.result || state.resultCached || !host.connected() || !gateway.connection) {
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
      disposed = true;
    },
  };
}
