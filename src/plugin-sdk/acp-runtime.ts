// Public ACP runtime helpers for plugins that integrate with ACP control/session state.

import { testing as managerTesting, getAcpSessionManager } from "../acp/control-plane/manager.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../acp/policy.js";
import { testing as registryTesting, requireAcpRuntimeBackend } from "../acp/runtime/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export { getAcpSessionManager };
export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../acp/runtime/registry.js";
export { requireAcpRuntimeBackend };
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpSessionUpdateTag,
} from "@openclaw/acp-core/runtime/types";
export { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
export type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
export { tryDispatchAcpReplyHook } from "./acp-runtime-backend.js";

export function resolveAcpSessionAvailability(params: {
  config: OpenClawConfig;
  backendId: string;
  agentId: string;
}): { available: true } | { available: false; message: string } {
  const policyError =
    resolveAcpDispatchPolicyError(params.config) ??
    resolveAcpAgentPolicyError(params.config, params.agentId);
  if (policyError) {
    return { available: false, message: policyError.message };
  }
  try {
    requireAcpRuntimeBackend(params.backendId);
    return { available: true };
  } catch (error) {
    return {
      available: false,
      message: error instanceof Error ? error.message : "ACP runtime backend is unavailable.",
    };
  }
}

// Keep test helpers off the hot init path. Eagerly merging them here can
// create a back-edge through the bundled ACP runtime chunk before the imported
// testing bindings finish initialization.
/** Lazy ACP test helper facade combining control-plane and runtime registry helpers. */
export const testing = new Proxy({} as typeof managerTesting & typeof registryTesting, {
  get(_target, prop, receiver) {
    if (Reflect.has(managerTesting, prop)) {
      return Reflect.get(managerTesting, prop, receiver);
    }
    return Reflect.get(registryTesting, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop);
  },
  ownKeys() {
    return Array.from(
      new Set([...Reflect.ownKeys(managerTesting), ...Reflect.ownKeys(registryTesting)]),
    );
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop)) {
      return {
        configurable: true,
        enumerable: true,
      };
    }
    return undefined;
  },
});

/** @deprecated Use `testing`. */
export { testing as __testing };
