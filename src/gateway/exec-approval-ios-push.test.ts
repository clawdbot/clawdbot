/**
 * Tests iOS push notification dispatch for exec approval requests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequest, ExecApprovalResolved } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "../infra/plugin-approvals.js";
import { createDeferred } from "../test-utils/deferred.js";

const listDevicePairingMock = vi.fn();
const loadApnsRegistrationMock = vi.fn();
const loadApnsRegistrationsMock = vi.fn();
const resolveApnsAuthConfigFromEnvMock = vi.fn();
const resolveApnsRelayConfigFromEnvMock = vi.fn();
const sendApnsExecApprovalAlertMock = vi.fn();
const sendApnsExecApprovalResolvedWakeMock = vi.fn();
const sendApnsPluginApprovalAlertMock = vi.fn();
const sendApnsPluginApprovalResolvedWakeMock = vi.fn();
let createExecApprovalIosPushDelivery: typeof import("./exec-approval-ios-push.js").createExecApprovalIosPushDelivery;
let createPluginApprovalIosPushDelivery: typeof import("./exec-approval-ios-push.js").createPluginApprovalIosPushDelivery;

function apnsRegistration(nodeId = "ios-device-1") {
  return {
    nodeId,
    transport: "direct",
    token: "apns-token",
    topic: "ai.openclaw.ios.test",
    environment: "sandbox",
    updatedAtMs: 1,
  };
}

function relayApnsRegistration(nodeId = "ios-device-1") {
  return {
    nodeId,
    transport: "relay",
    relayHandle: `relay-${nodeId}`,
    sendGrant: `grant-${nodeId}`,
    installationId: `installation-${nodeId}`,
    topic: "ai.openclaw.ios.test",
    environment: "sandbox",
    distribution: "official",
    relayOrigin: "https://relay.example.test",
    updatedAtMs: 1,
  };
}

function successfulApnsPushResult() {
  return {
    ok: true,
    status: 200,
    environment: "sandbox",
    topic: "ai.openclaw.ios.test",
    tokenSuffix: "token",
    transport: "direct",
  };
}

function resolvedApnsAuthConfig() {
  return {
    ok: true,
    value: { teamId: "team", keyId: "key", privateKey: "private-key" },
  };
}

function approvalRequest(id: string): ExecApprovalRequest {
  return {
    id,
    request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function approvalResolved(id: string): ExecApprovalResolved {
  return {
    id,
    decision: "allow-once",
    ts: 1,
  };
}

function pluginApprovalRequest(id: string): PluginApprovalRequest {
  return {
    id,
    request: {
      title: "Install plugin update",
      description: "Allow the plugin to update its managed package.",
      severity: "warning",
      toolName: "plugins.update",
    },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function pluginApprovalResolved(id: string): PluginApprovalResolved {
  return {
    id,
    decision: "allow-once",
    ts: 1,
  };
}

function pairedIosOperator(options: {
  deviceId?: string;
  publicKey?: string;
  platform?: string;
  approvedAtMs?: number;
  scopes: string[];
  approvedScopes?: string[];
  token?: string;
}) {
  const deviceId = options.deviceId ?? "ios-device-1";
  return {
    deviceId,
    publicKey: options.publicKey ?? "pub",
    platform: options.platform ?? "iOS 18",
    role: "operator",
    roles: ["operator"],
    approvedScopes: options.approvedScopes,
    createdAtMs: 1,
    approvedAtMs: options.approvedAtMs ?? 1,
    tokens: {
      operator: {
        token: options.token ?? "operator-token",
        role: "operator",
        scopes: options.scopes,
        createdAtMs: 1,
      },
    },
  };
}

function mockPairedIosOperators(...paired: ReturnType<typeof pairedIosOperator>[]) {
  listDevicePairingMock.mockResolvedValue({
    pending: [],
    paired,
  });
}

function mockPairedIosOperator(scopes: string[]) {
  mockPairedIosOperators(pairedIosOperator({ scopes }));
}

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({ gateway: {} }),
}));

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return {
    ...actual,
    listDevicePairing: listDevicePairingMock,
  };
});

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateProcessDeviceIdentity: () => ({ deviceId: "gateway-device-1" }),
}));

vi.mock("../infra/push-apns.js", () => ({
  loadApnsRegistration: loadApnsRegistrationMock,
  loadApnsRegistrations: loadApnsRegistrationsMock,
  resolveApnsAuthConfigFromEnv: resolveApnsAuthConfigFromEnvMock,
  resolveApnsRelayConfigFromEnv: resolveApnsRelayConfigFromEnvMock,
  sendApnsExecApprovalAlert: sendApnsExecApprovalAlertMock,
  sendApnsExecApprovalResolvedWake: sendApnsExecApprovalResolvedWakeMock,
  sendApnsPluginApprovalAlert: sendApnsPluginApprovalAlertMock,
  sendApnsPluginApprovalResolvedWake: sendApnsPluginApprovalResolvedWakeMock,
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

describe("createExecApprovalIosPushDelivery", () => {
  beforeAll(async () => {
    ({ createExecApprovalIosPushDelivery, createPluginApprovalIosPushDelivery } =
      await import("./exec-approval-ios-push.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [], paired: [] });
    loadApnsRegistrationMock.mockResolvedValue(apnsRegistration());
    loadApnsRegistrationsMock.mockImplementation(async (nodeIds: readonly string[]) => {
      const registrations = [];
      for (const nodeId of nodeIds) {
        const registration = await loadApnsRegistrationMock(nodeId);
        if (registration) {
          registrations.push({ nodeId, registration });
        }
      }
      return registrations;
    });
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue(resolvedApnsAuthConfig());
    resolveApnsRelayConfigFromEnvMock.mockReturnValue({ ok: false, error: "unused" });
    sendApnsExecApprovalAlertMock.mockResolvedValue(successfulApnsPushResult());
    sendApnsExecApprovalResolvedWakeMock.mockResolvedValue(successfulApnsPushResult());
    sendApnsPluginApprovalAlertMock.mockResolvedValue(successfulApnsPushResult());
    sendApnsPluginApprovalResolvedWakeMock.mockResolvedValue(successfulApnsPushResult());
  });

  it("does not target iOS devices whose active operator token lacks operator.approvals", async () => {
    mockPairedIosOperators(
      pairedIosOperator({
        scopes: ["operator.read"],
        approvedScopes: ["operator.approvals"],
      }),
    );

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested(approvalRequest("approval-1"));

    expect(accepted).toBe(false);
    expect(loadApnsRegistrationsMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalAlertMock).not.toHaveBeenCalled();
  });

  it("does not target approval-only iOS devices that cannot validate gateway ownership", async () => {
    mockPairedIosOperator(["operator.approvals"]);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested(approvalRequest("approval-no-read"));

    expect(accepted).toBe(false);
    expect(loadApnsRegistrationsMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalAlertMock).not.toHaveBeenCalled();
  });

  it("targets iOS devices when the active operator token can approve and validate ownership", async () => {
    mockPairedIosOperator(["operator.approvals", "operator.read"]);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested(approvalRequest("approval-2"));

    expect(accepted).toBe(true);
    expect(loadApnsRegistrationsMock).toHaveBeenCalledWith(["ios-device-1"]);
    expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledTimes(1);
    expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayDeviceId: "gateway-device-1" }),
    );
  });

  it("loads APNs registrations in one bulk read for all visible iOS operators", async () => {
    mockPairedIosOperators(
      pairedIosOperator({
        deviceId: "ios-device-1",
        publicKey: "pub-1",
        scopes: ["operator.approvals", "operator.read"],
        token: "operator-token-1",
      }),
      pairedIosOperator({
        deviceId: "ios-device-2",
        publicKey: "pub-2",
        platform: "iPadOS 18",
        approvedAtMs: 2,
        scopes: ["operator.approvals", "operator.write"],
        token: "operator-token-2",
      }),
    );

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    await delivery.handleRequested(approvalRequest("approval-bulk-load"));

    expect(loadApnsRegistrationsMock).toHaveBeenCalledTimes(1);
    expect(loadApnsRegistrationsMock).toHaveBeenCalledWith(["ios-device-1", "ios-device-2"]);
  });

  it("does not target iOS devices rejected by the approval visibility filter", async () => {
    mockPairedIosOperator(["operator.approvals", "operator.read"]);
    const isTargetVisible = vi.fn(() => false);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested(approvalRequest("approval-filtered"), {
      isTargetVisible,
    });

    expect(accepted).toBe(false);
    expect(isTargetVisible).toHaveBeenCalledWith({
      deviceId: "ios-device-1",
      scopes: ["operator.approvals", "operator.read"],
    });
    expect(loadApnsRegistrationsMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalAlertMock).not.toHaveBeenCalled();
  });

  it("does not treat iOS as a live approval route when every push fails", async () => {
    const warn = vi.fn();
    mockPairedIosOperator(["operator.approvals", "operator.read"]);
    sendApnsExecApprovalAlertMock.mockResolvedValue({
      ok: false,
      status: 410,
      reason: "Unregistered",
      environment: "sandbox",
      topic: "ai.openclaw.ios.test",
      tokenSuffix: "token",
      transport: "direct",
    });

    const delivery = createExecApprovalIosPushDelivery({ log: { warn } });

    const accepted = await delivery.handleRequested(approvalRequest("approval-dead-route"));

    expect(accepted).toBe(false);
    expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push failed node=ios-device-1 status=410 reason=Unregistered",
    );
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push reached no devices approvalId=approval-dead-route attempted=1",
    );
  });

  it("waits for request delivery to finish before sending cleanup pushes", async () => {
    mockPairedIosOperator(["operator.approvals", "operator.read"]);
    const requestedPush = createDeferred<{
      ok: boolean;
      status: number;
      environment: string;
      topic: string;
      tokenSuffix: string;
      transport: string;
    }>();
    sendApnsExecApprovalAlertMock.mockReturnValue(requestedPush.promise);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const requested = delivery.handleRequested(approvalRequest("approval-ordered-cleanup"));
    const resolved = delivery.handleResolved(approvalResolved("approval-ordered-cleanup"));

    await Promise.resolve();
    expect(sendApnsExecApprovalResolvedWakeMock).not.toHaveBeenCalled();

    requestedPush.resolve(successfulApnsPushResult());
    await requested;
    await resolved;

    expect(sendApnsExecApprovalResolvedWakeMock).toHaveBeenCalledTimes(1);
  });

  it("skips cleanup pushes when the original request target set is unknown", async () => {
    const debug = vi.fn();
    const delivery = createExecApprovalIosPushDelivery({ log: { debug } });

    await delivery.handleResolved(approvalResolved("approval-missing-targets"));

    expect(debug).toHaveBeenCalledWith(
      "exec approvals: iOS cleanup push skipped approvalId=approval-missing-targets reason=missing-targets",
    );
    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationsMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalResolvedWakeMock).not.toHaveBeenCalled();
  });

  it("sends cleanup pushes only to the original request targets", async () => {
    mockPairedIosOperator(["operator.approvals", "operator.read"]);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    await delivery.handleRequested(approvalRequest("approval-cleanup"));
    vi.clearAllMocks();
    loadApnsRegistrationMock.mockResolvedValue(apnsRegistration());
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue(resolvedApnsAuthConfig());

    await delivery.handleResolved(approvalResolved("approval-cleanup"));

    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationsMock).toHaveBeenCalledWith(["ios-device-1"]);
    expect(sendApnsExecApprovalResolvedWakeMock).toHaveBeenCalledTimes(1);
  });

  describe("createPluginApprovalIosPushDelivery", () => {
    it("targets only paired iOS operators with approval and read scopes", async () => {
      mockPairedIosOperators(
        pairedIosOperator({
          deviceId: "ios-approved",
          scopes: ["operator.approvals", "operator.read"],
        }),
        pairedIosOperator({
          deviceId: "ios-read-only",
          scopes: ["operator.read"],
        }),
      );

      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const accepted = await delivery.handleRequested(pluginApprovalRequest("plugin:direct"));

      expect(accepted).toBe(true);
      expect(loadApnsRegistrationsMock).toHaveBeenCalledWith(["ios-approved"]);
      expect(sendApnsPluginApprovalAlertMock).toHaveBeenCalledTimes(1);
      expect(sendApnsPluginApprovalAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "ios-approved",
          approvalId: "plugin:direct",
          gatewayDeviceId: "gateway-device-1",
          title: "Install plugin update",
          description: "Allow the plugin to update its managed package.",
        }),
      );
    });

    it("uses the shared relay delivery plan for plugin alerts", async () => {
      const relayConfig = { baseUrl: "https://relay.example.test", timeoutMs: 10_000 };
      mockPairedIosOperator(["operator.approvals", "operator.read"]);
      loadApnsRegistrationMock.mockResolvedValue(relayApnsRegistration());
      resolveApnsRelayConfigFromEnvMock.mockReturnValue({ ok: true, value: relayConfig });

      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const accepted = await delivery.handleRequested(pluginApprovalRequest("plugin:relay"));

      expect(accepted).toBe(true);
      expect(sendApnsPluginApprovalAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          registration: expect.objectContaining({ transport: "relay" }),
          relayConfig,
          approvalId: "plugin:relay",
        }),
      );
      expect(resolveApnsAuthConfigFromEnvMock).not.toHaveBeenCalled();
    });

    it("sends plugin cleanup wakes for resolved and expired requests", async () => {
      mockPairedIosOperator(["operator.approvals", "operator.read"]);
      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const resolvedRequest = pluginApprovalRequest("plugin:resolved");
      const expiredRequest = pluginApprovalRequest("plugin:expired");

      await delivery.handleRequested(resolvedRequest);
      await delivery.handleRequested(expiredRequest);
      await delivery.handleResolved(pluginApprovalResolved(resolvedRequest.id));
      await delivery.handleExpired(expiredRequest);

      expect(sendApnsPluginApprovalResolvedWakeMock).toHaveBeenCalledTimes(2);
      expect(sendApnsPluginApprovalResolvedWakeMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "plugin:resolved" }),
      );
      expect(sendApnsPluginApprovalResolvedWakeMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "plugin:expired" }),
      );
    });

    it("routes exec and plugin factories through the same paired-target resolver", async () => {
      mockPairedIosOperator(["operator.approvals", "operator.read"]);

      await createExecApprovalIosPushDelivery({ log: {} }).handleRequested(
        approvalRequest("exec-shared-target"),
      );
      await createPluginApprovalIosPushDelivery({ log: {} }).handleRequested(
        pluginApprovalRequest("plugin:shared-target"),
      );

      expect(listDevicePairingMock).toHaveBeenCalledTimes(2);
      expect(loadApnsRegistrationsMock).toHaveBeenNthCalledWith(1, ["ios-device-1"]);
      expect(loadApnsRegistrationsMock).toHaveBeenNthCalledWith(2, ["ios-device-1"]);
      expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledTimes(1);
      expect(sendApnsPluginApprovalAlertMock).toHaveBeenCalledTimes(1);
    });
  });
});
