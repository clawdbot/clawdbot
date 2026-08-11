import type { SessionEntry } from "../config/sessions.js";

/**
 * Leaf store-target contract for gateway session path resolution.
 *
 * Kept free of subagent-registry types so spawn/runtime barrels can import
 * `resolveGatewaySessionStoreTarget` without routing through the session-utils
 * barrel and closing a madge cycle via registry ↔ gateway.
 */
export type GatewaySessionStoreTarget = {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
};

export type GatewaySessionStoreTargetWithStore = GatewaySessionStoreTarget & {
  canonicalValidationError?: Error;
  store: Record<string, SessionEntry>;
};
