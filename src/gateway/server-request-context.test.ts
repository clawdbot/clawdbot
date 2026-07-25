/**
 * Gateway request context construction tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import { createGatewayRequestContext } from "./server-request-context.js";

type GatewayRequestContextParams = Parameters<typeof createGatewayRequestContext>[0];

function makeContextParams(
  overrides: Partial<GatewayRequestContextParams> = {},
): GatewayRequestContextParams {
  const config = {} as never;
  const runtimeState: Pick<GatewayServerLiveState, "cronState" | "configReloader"> = {
    cronState: {
      cron: { start: vi.fn(), stop: vi.fn() } as never,
      storePath: "/tmp/cron",
      cronEnabled: true,
    },
    configReloader: {
      stop: vi.fn(async () => {}),
      notifyPluginMetadataChanged: vi.fn(),
    },
  };
  return {
    deps: {} as never,
    runtimeState,
    getRuntimeConfig: vi.fn(() => config),
    sessionObserver: {} as never,
    resolveTerminalLaunchPolicy: vi.fn(() => ({
      ok: false as const,
      block: { kind: "disabled" as const },
    })),
    isTerminalEnabled: vi.fn(() => false),
    execApprovalManager: undefined,
    pluginApprovalManager: undefined,
    listSessionPendingApprovals: undefined,
    loadGatewayModelCatalog: vi.fn(async () => []),
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
      agentDir: "/tmp/model-catalog-agent",
      config,
      entries: [],
      routeVariants: [],
    })),
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
    hasConnectedTalkNode: vi.fn(async () => false),
    clients: new Set(),
    enforceSharedGatewayAuthGenerationForConfigWrite: vi.fn(),
    nodeRegistry: { invalidateConnectionForPairingChange: vi.fn() } as never,
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
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
    systemAgentSessions: new Map(),
    findRunningWizard: vi.fn(() => null),
    purgeWizardSession: vi.fn(),
    getRuntimeSnapshot: vi.fn(() => ({}) as never),
    startChannel: vi.fn(async () => undefined),
    stopChannel: vi.fn(async () => undefined),
    markChannelLoggedOut: vi.fn(),
    wizardRunner: vi.fn(async () => undefined),
    channelWizardRunner: vi.fn(async () => undefined),
    broadcastVoiceWakeChanged: vi.fn(),
    broadcastVoiceWakeRoutingChanged: vi.fn(),
    unavailableGatewayMethods: new Set(),
    ...overrides,
  };
}

function makeGatewayClient(params: {
  connId: string;
  clientId: (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];
  mode?: (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];
  scopes?: string[];
  caps?: string[];
  approvalRuntime?: boolean;
  invalidated?: boolean;
}) {
  return {
    connId: params.connId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: params.clientId,
        version: "test",
        platform: "test",
        mode: params.mode ?? GATEWAY_CLIENT_MODES.CLI,
      },
      scopes: params.scopes ?? [],
      caps: params.caps ?? [],
    },
    socket: { close: vi.fn() },
    ...(params.approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
    ...(params.invalidated ? { invalidated: true } : {}),
  };
}

describe("createGatewayRequestContext", () => {
  it("reads cron state live from runtime state", () => {
    const cronA = { start: vi.fn(), stop: vi.fn() } as never;
    const cronB = { start: vi.fn(), stop: vi.fn() } as never;
    const runtimeState: Pick<GatewayServerLiveState, "cronState" | "configReloader"> = {
      cronState: {
        cron: cronA,
        storePath: "/tmp/cron-a",
        cronEnabled: true,
      },
      configReloader: {
        stop: vi.fn(async () => {}),
        notifyPluginMetadataChanged: vi.fn(),
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

  it("reads config hot-reload status live from runtime state", () => {
    const runtimeState: Pick<GatewayServerLiveState, "cronState" | "configReloader"> = {
      cronState: {
        cron: { start: vi.fn(), stop: vi.fn() } as never,
        storePath: "/tmp/cron",
        cronEnabled: true,
      },
      configReloader: {
        stop: vi.fn(async () => {}),
        notifyPluginMetadataChanged: vi.fn(),
      },
    };

    const context = createGatewayRequestContext(makeContextParams({ runtimeState }));

    expect(context.getConfigReloaderHotReloadStatus?.()).toBeUndefined();

    runtimeState.configReloader = {
      stop: vi.fn(async () => {}),
      hotReloadStatus: () => "active",
      notifyPluginMetadataChanged: vi.fn(),
    };
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("active");

    runtimeState.configReloader = {
      stop: vi.fn(async () => {}),
      hotReloadStatus: () => "disabled",
      notifyPluginMetadataChanged: vi.fn(),
    };
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("disabled");
  });

  it("does not treat scoped CLI or backend callers as approval delivery routes", () => {
    const clients = new Set([
      makeGatewayClient({
        connId: "cli",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.admin"],
      }),
      makeGatewayClient({
        connId: "backend",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: ["operator.approvals"],
      }),
    ]) as never;
    const context = createGatewayRequestContext(makeContextParams({ clients }));

    expect(context.hasExecApprovalClients?.()).toBe(false);
    expect(context.getApprovalClientConnIds?.()).toEqual(new Set());
    expect(context.getApprovalClientConnIds?.({ approvalKind: "plugin" })).toEqual(new Set());
  });

  it("preserves only clients that handle each approval kind", () => {
    const clients = new Set([
      makeGatewayClient({
        connId: "control-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        scopes: ["operator.approvals"],
      }),
      makeGatewayClient({
        connId: "ios",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        mode: GATEWAY_CLIENT_MODES.UI,
        scopes: ["operator.admin"],
      }),
      makeGatewayClient({
        connId: "bridge",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      }),
      makeGatewayClient({
        connId: "acp",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
      }),
      makeGatewayClient({
        connId: "tui",
        clientId: GATEWAY_CLIENT_IDS.TUI,
        scopes: ["operator.approvals"],
      }),
      makeGatewayClient({
        connId: "plugin-bridge",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS],
      }),
      makeGatewayClient({
        connId: "runtime",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: ["operator.approvals"],
        approvalRuntime: true,
      }),
      makeGatewayClient({
        connId: "invalidated-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        scopes: ["operator.approvals"],
        invalidated: true,
      }),
      makeGatewayClient({
        connId: "unscoped-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
    ]) as never;
    const context = createGatewayRequestContext(makeContextParams({ clients }));

    expect(context.hasExecApprovalClients?.()).toBe(true);
    expect(context.getApprovalClientConnIds?.()).toEqual(
      new Set(["control-ui", "ios", "bridge", "acp", "runtime"]),
    );
    expect(context.getApprovalClientConnIds?.({ approvalKind: "plugin" })).toEqual(
      new Set(["control-ui", "bridge", "tui", "plugin-bridge", "runtime"]),
    );
    expect(context.getApprovalClientConnIds?.({ approvalKind: "system-agent" })).toEqual(
      new Set(["control-ui", "bridge", "runtime"]),
    );
    expect(context.hasExecApprovalClients?.("control-ui")).toBe(true);
    expect(
      context.getApprovalClientConnIds?.({
        excludeConnId: "control-ui",
        filter: (client) => client.connect.client.id === GATEWAY_CLIENT_IDS.IOS_APP,
      }),
    ).toEqual(new Set(["ios"]));
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
    const invalidateDeviceTransports = vi.fn();
    const invalidateConnectionForPairingChange = vi.fn();

    const context = createGatewayRequestContext(
      makeContextParams({
        clients,
        invalidateDeviceTransports,
        nodeRegistry: { invalidateConnectionForPairingChange } as never,
      }),
    );
    context.invalidateClientsForDevice?.("device-1", { reason: "device-token-rotated" });

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe(
      "device-token-rotated",
    );
    expect(target.socket.close).not.toHaveBeenCalled();
    expect(invalidateConnectionForPairingChange).toHaveBeenCalledWith(
      "conn-target",
      "device-token-rotated",
    );

    expect((unrelated as { invalidated?: boolean }).invalidated).toBeUndefined();
    expect(unrelated.socket.close).not.toHaveBeenCalled();
    expect(invalidateDeviceTransports).toHaveBeenCalledWith("device-1", {
      reason: "device-token-rotated",
    });
  });

  it("disconnectClientsForDevice also marks the invalidated flag before closing", () => {
    const target = {
      connId: "conn-target",
      connect: { device: { id: "device-1" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const clients = new Set([target]) as never;
    const disconnectDeviceTransports = vi.fn();

    const context = createGatewayRequestContext(
      makeContextParams({ clients, disconnectDeviceTransports }),
    );
    context.disconnectClientsForDevice?.("device-1");

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe("device-removed");
    expect(target.socket.close).toHaveBeenCalledWith(4001, "device removed");
    expect(disconnectDeviceTransports).toHaveBeenCalledWith("device-1", undefined);
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
