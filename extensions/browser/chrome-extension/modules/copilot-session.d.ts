import type { CopilotSessionEntry, CopilotSessionRegistry } from "./copilot-session-registry.js";

export function createCopilotSessionController(
  options: Record<string, unknown> & {
    registry: CopilotSessionRegistry;
  },
): {
  ensureSession: (
    tabId: number,
    options?: { hydrateHistory?: boolean },
  ) => Promise<CopilotSessionEntry | null>;
  sendMessage: (
    tabId: number,
    port: unknown,
    portRevision: number,
    text: string,
  ) => Promise<unknown>;
};
