import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { authorizeOperatorScopesForRequiredScope, READ_SCOPE } from "./method-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isGatewayAdmin, prepareSessionSharing } from "./session-sharing.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import { resolveCanonicalSessionStoreMatchFromStoreKeys } from "./session-utils-store.js";

/** One synchronous snapshot/fanout owns these reads; never reuse them across broadcasts. */
export function createPresenceRecipientProjection(params: {
  cfg: OpenClawConfig;
  presence: SystemPresence[];
}): (client: GatewayClient | null) => SystemPresence[] {
  const targets = new Map<string, { canonicalKey: string; entry: SessionEntry } | undefined>();
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const resolveTarget = (sessionKey: string) => {
    if (!targets.has(sessionKey)) {
      const parsed = parseAgentSessionKey(sessionKey);
      // Viewer declarations wrap sentinel keys with their agent. The stored key
      // remains global/unknown in that agent's store, not a literal prefixed row.
      const key =
        parsed?.rest === "global" || parsed?.rest === "unknown" ? parsed.rest : sessionKey;
      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg: params.cfg,
        key,
        agentId: parsed?.agentId,
        readOnly: true,
        exactRead: true,
        clone: false,
        targetDiscoveryCache,
      });
      const match = resolveCanonicalSessionStoreMatchFromStoreKeys(target.store, target.storeKeys);
      targets.set(
        sessionKey,
        match ? { canonicalKey: target.canonicalKey, entry: match.entry } : undefined,
      );
    }
    return targets.get(sessionKey);
  };
  return (client) => {
    // Match system-presence RPC access before projecting any rows: even idle
    // people expose timing through ts and roster ordering, not just named fields.
    if (
      !client?.connect ||
      (client.connect.role ?? "operator") !== "operator" ||
      !authorizeOperatorScopesForRequiredScope(READ_SCOPE, client.connect.scopes ?? []).allowed
    ) {
      return [];
    }
    const canReadSessions =
      // Match session reads: an established admin grant does not depend on profile verification.
      isGatewayAdmin(client) || !isGatewayClientProfilePending(client);
    const entryFilter = canReadSessions
      ? prepareSessionSharing({ cfg: params.cfg, client }).entryFilter
      : undefined;
    return params.presence.map((row) => {
      if (!row.watchedSessions) {
        return row;
      }
      const watchedSessions = canReadSessions
        ? row.watchedSessions.filter((key) => {
            const target = resolveTarget(key);
            return target && (entryFilter?.(target.canonicalKey, target.entry) ?? true);
          })
        : [];
      const { watchedSessions: _watchedSessions, ...person } = row;
      return watchedSessions.length ? { ...person, watchedSessions } : person;
    });
  };
}
