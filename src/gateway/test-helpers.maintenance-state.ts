import type { HealthSummary } from "../commands/health.js";
import { createChatRunState } from "./server-chat-state.js";

// Minimal Gateway maintenance state fixture for tests.

/** Create a Gateway maintenance-state stub with configurable health/presence versions. */
export function createGatewayMaintenanceStateForTest(params?: {
  healthSummary?: HealthSummary;
  healthVersion?: number;
  presenceVersion?: number;
}) {
  const chatRunState = createChatRunState();
  return {
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => params?.presenceVersion ?? 1,
    getHealthVersion: () => params?.healthVersion ?? 1,
    refreshGatewayHealthSnapshot: async () =>
      params?.healthSummary ?? ({ ok: true } as HealthSummary),
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState,
    chatRunBuffers: chatRunState.buffers,
    chatDeltaSentAt: chatRunState.deltaSentAt,
    chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
  };
}
