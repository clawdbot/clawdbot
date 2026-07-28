// Gateway maintenance-state test helper.
// Builds minimal timer/health/chat state for maintenance tests.
import type { HealthSummary } from "../commands/health.js";
import { createChatRunState } from "./server-chat-state.js";

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
    chatQueuedTurns: new Map(),
    restartRecoveryCandidates: new Map(),
    chatRunState,
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
    getRuntimeConfig: () => ({}),
    runDeliveryQueueMediaGc: async () => undefined,
  };
}
