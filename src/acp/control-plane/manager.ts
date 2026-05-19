import { AcpSessionManager } from "./manager.core.js";

export { AcpSessionManager } from "./manager.core.js";
export type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpInitializeSessionInput,
  AcpManagerObservabilitySnapshot,
  AcpRunTurnInput,
  AcpSessionResolution,
  AcpSessionRuntimeOptions,
  AcpSessionStatus,
  AcpStartupIdentityReconcileResult,
} from "./manager.types.js";

let ACP_SESSION_MANAGER_SINGLETON: AcpSessionManager | null = null;

export function getAcpSessionManager(): AcpSessionManager {
  if (!ACP_SESSION_MANAGER_SINGLETON) {
    ACP_SESSION_MANAGER_SINGLETON = new AcpSessionManager();
  }
  return ACP_SESSION_MANAGER_SINGLETON;
}

export const testing = {
  resetAcpSessionManagerForTests() {
    ACP_SESSION_MANAGER_SINGLETON = null;
  },
  setAcpSessionManagerForTests(manager: unknown) {
    ACP_SESSION_MANAGER_SINGLETON = manager as AcpSessionManager | null;
  },
};
export { testing as __testing };
