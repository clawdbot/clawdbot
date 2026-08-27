import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { authorizeOperatorScopesForRequiredScope, READ_SCOPE } from "./method-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionListEntryFilter, isGatewayAdmin } from "./session-sharing.js";
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
    const canRead =
      client?.connect != null &&
      (client.connect.role ?? "operator") === "operator" &&
      authorizeOperatorScopesForRequiredScope(READ_SCOPE, client.connect.scopes ?? []).allowed &&
      // Match session reads: an established admin grant does not depend on profile verification.
      (isGatewayAdmin(client) || !isGatewayClientProfilePending(client));
    const entryFilter = canRead
      ? createSessionListEntryFilter({ cfg: params.cfg, client })
      : undefined;
    return params.presence.map((row) => {
      if (!row.watchedSessions) {
        return row;
      }
      const watchedSessions = canRead
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
