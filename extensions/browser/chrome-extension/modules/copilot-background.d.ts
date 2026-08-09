import type { CopilotSessionRegistry } from "./copilot-session-registry.js";

export function createCopilotController(options: Record<string, unknown>): {
  initializeCustody(): Promise<void>;
  initialize(): Promise<void>;
  preparePanel(tabId: number): Promise<{ path: string }>;
  onConsentChanged(changedTabId?: number, options?: { revoked?: boolean }): Promise<void>;
  onRelayStatus(status: { ready: boolean; label?: string }): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  refreshConfig(): Promise<void>;
  drainAborts(gatewayScope?: string | null): Promise<void>;
  drainArchives(gatewayScope?: string | null): Promise<void>;
  drainStaleScopes(): Promise<void>;
  registry: CopilotSessionRegistry;
};
