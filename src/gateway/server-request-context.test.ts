import { describe, expect, it, vi } from "vitest";
import type { GatewayServerLiveState } from "./server-live-state.js";
import { createGatewayRequestContext } from "./server-request-context.js";

describe("createGatewayRequestContext", () => {
  it("reads cron state live from runtime state", () => {
    const cronA = { start: vi.fn(), stop: vi.fn() } as never;
    const cronB = { start: vi.fn(), stop: vi.fn() } as never;
    const runtimeState: Pick<GatewayServerLiveState, "cronState"> = {
      cronState: {
        cron: cronA,
        storePath: "/tmp/cron-a",
        cronEnabled: true,
      },
    };

    const context = createGatewayRequestContext({
      deps: {} as never,
      runtimeState,
      execApprovalManager: undefined,
      pluginApprovalManager: undefined,
      loadGatewayModelCatalog: vi.fn(async () => []),
      getHealthCache: vi.fn(() => null),
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logHealth: { error: vi.fn() },
      logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
      incrementPresenceVersion: vi.fn(() => 1),
      getHealthVersion: vi.fn(() => 1),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      nodeSendToSession: vi.fn(),
      nodeSendToAllSubscribed: vi.fn(),
      nodeSubscribe: vi.fn(),
      nodeUnsubscribe: vi.fn(),
      nodeUnsubscribeAll: vi.fn(),
      hasConnectedTalkNode: vi.fn(() => false),
      clients: new Set(),
      enforceSharedGatewayAuthGenerationForConfigWrite: vi.fn(),
      nodeRegistry: {} as never,
      agentRunSeq: new Map(),
      chatAbortControllers: new Map(),
      chatAbortedRuns: new Map(),
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      addChatRun: vi.fn(),
      removeChatRun: vi.fn(),
      subscribeSessionEvents: vi.fn(),
      unsubscribeSessionEvents: vi.fn(),
      subscribeSessionMessageEvents: vi.fn(),
      unsubscribeSessionMessageEvents: vi.fn(),
      unsubscribeAllSessionEvents: vi.fn(),
      getSessionEventSubscriberConnIds: vi.fn(() => new Set<string>()),
      registerToolEventRecipient: vi.fn(),
      dedupe: new Map(),
      wizardSessions: new Map(),
      findRunningWizard: vi.fn(() => null),
      purgeWizardSession: vi.fn(),
      getRuntimeSnapshot: vi.fn(() => ({}) as never),
      getRuntimeConfig: vi.fn(() => ({}) as never),
      startChannel: vi.fn(async () => undefined),
      stopChannel: vi.fn(async () => undefined),
      markChannelLoggedOut: vi.fn(),
      wizardRunner: vi.fn(async () => undefined),
      broadcastVoiceWakeChanged: vi.fn(),
      broadcastVoiceWakeRoutingChanged: vi.fn(),
      unavailableGatewayMethods: new Set(),
    });

    expect(context.cron).toBe(cronA);
    expect(context.cronStorePath).toBe("/tmp/cron-a");

    runtimeState.cronState = {
      cron: cronB,
      storePath: "/tmp/cron-b",
      cronEnabled: true,
    };

    expect(context.cron).toBe(cronB);
    expect(context.cronStorePath).toBe("/tmp/cron-b");
  });
});
