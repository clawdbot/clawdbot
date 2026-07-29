import type { CopilotGatewayClient } from "./copilot-gateway.js";
import type { CopilotSessionEntry, CopilotSessionRegistry } from "./copilot-session-registry.js";

export function createCopilotRecoveryController(
  options: Record<string, unknown> & {
    gateway: CopilotGatewayClient;
    registry: CopilotSessionRegistry;
  },
): {
  abortEntry: (entry: CopilotSessionEntry) => Promise<boolean>;
  clearAbortRetry: () => void;
  drainAborts: (gatewayScope?: string | null) => Promise<void>;
  drainArchives: (gatewayScope?: string | null) => Promise<void>;
  drainStaleScopes: () => Promise<void>;
  reconcileGatewayReady: (
    status: Record<string, unknown>,
    statusRevision: number,
    gatewayScope: string | null,
    revocation: Promise<unknown>,
  ) => Promise<void>;
  scheduleAbortRetry: (gatewayScope?: string | null) => void;
  scheduleStaleRecovery: () => void;
};
