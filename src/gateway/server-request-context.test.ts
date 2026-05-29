import { describe, expect, it, vi } from "vitest";
import type { GatewayServerLiveState } from "./server-live-state.js";
import {
  createGatewayRequestContext,
  type GatewayRequestContextParams,
} from "./server-request-context.js";

function makeContextParams(
  overrides: Partial<GatewayRequestContextParams> = {},
): GatewayRequestContextParams {
  const runtimeState: Pick<GatewayServerLiveState, "cronState"> = {
    cronState: {
      cron: { start: vi.fn(), stop: vi.fn() } as never,
      storePath: "/tmp/cron",
      cronEnabled: true,
    },
  };
  return {
    deps: {} as never,
    runtimeState,
    getRuntimeConfig: vi.fn(() => ({}) as never),
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
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    clearChatRunState: vi.fn(),
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
    startChannel: vi.fn(async () => undefined),
    stopChannel: vi.fn(async () => undefined),
    markChannelLoggedOut: vi.fn(),
    wizardRunner: vi.fn(async () => undefined),
    broadcastVoiceWakeChanged: vi.fn(),
    broadcastVoiceWakeRoutingChanged: vi.fn(),
    unavailableGatewayMethods: new Set(),
    ...overrides,
  };
}

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

    const context = createGatewayRequestContext(makeContextParams({ runtimeState }));

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

  it("invalidateClientsForDevice sets the flag on matching clients without closing the socket", () => {
    const target = {
      connId: "conn-target",
      connect: { device: { id: "device-1" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const unrelated = {
      connId: "conn-unrelated",
      connect: { device: { id: "device-2" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const clients = new Set([target, unrelated]) as never;

    const context = createGatewayRequestContext(makeContextParams({ clients }));
    context.invalidateClientsForDevice?.("device-1", { reason: "device-token-rotated" });

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe(
      "device-token-rotated",
    );
    expect(target.socket.close).not.toHaveBeenCalled();

    expect((unrelated as { invalidated?: boolean }).invalidated).toBeUndefined();
    expect(unrelated.socket.close).not.toHaveBeenCalled();
  });

  it("disconnectClientsForDevice also marks the invalidated flag before closing", () => {
    const target = {
      connId: "conn-target",
      connect: { device: { id: "device-1" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const clients = new Set([target]) as never;

    const context = createGatewayRequestContext(makeContextParams({ clients }));
    context.disconnectClientsForDevice?.("device-1");

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe("device-removed");
    expect(target.socket.close).toHaveBeenCalledWith(4001, "device removed");
  });

  it("invalidateClientsForDevice filters by role when provided", () => {
    const primary = {
      connId: "conn-primary",
      connect: { device: { id: "device-1" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const secondary = {
      connId: "conn-secondary",
      connect: { device: { id: "device-1" }, role: "secondary" },
      socket: { close: vi.fn() },
    };
    const clients = new Set([primary, secondary]) as never;

    const context = createGatewayRequestContext(makeContextParams({ clients }));
    context.invalidateClientsForDevice?.("device-1", { role: "primary" });

    expect((primary as { invalidated?: boolean }).invalidated).toBe(true);
    expect((secondary as { invalidated?: boolean }).invalidated).toBeUndefined();
  });
});
