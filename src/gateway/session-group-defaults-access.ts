import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionGroupMutationTargetsByName } from "./session-group-mutation-targets.js";
import {
  authorizeSessionSharingTarget,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";

/** Keep shared group settings visible only where every member session is mutable. */
export function filterMutableSessionGroupRecords<T extends { name: string }>(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  records: readonly T[];
}): T[] {
  const allowed = new Set(params.records.map((record) => record.name));
  if (isGatewayAdmin(params.client)) {
    return [...params.records];
  }
  const storeCache: GatewaySessionStoreCache = new Map();
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  for (const [name, targetRefs] of resolveSessionGroupMutationTargetsByName(params.cfg)) {
    if (!allowed.has(name)) {
      continue;
    }
    for (const targetRef of targetRefs) {
      const target = resolveSessionSharingTarget({
        cfg: params.cfg,
        sessionKey: targetRef.sessionKey,
        agentId: targetRef.agentId,
        storeCache,
        targetDiscoveryCache,
      });
      if (target && authorizeSessionSharingTarget({ client: params.client, target })) {
        allowed.delete(name);
        break;
      }
    }
  }
  return params.records.filter((record) => allowed.has(record.name));
}
