import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listDevicePairingMock = vi.fn();
const loadApnsRegistrationMock = vi.fn();
const resolveApnsAuthConfigFromEnvMock = vi.fn();
const resolveApnsRelayConfigFromEnvMock = vi.fn();
const sendApnsExecApprovalAlertMock = vi.fn();
const sendApnsExecApprovalResolvedWakeMock = vi.fn();
let createExecApprovalIosPushDelivery: typeof import("./exec-approval-ios-push.js").createExecApprovalIosPushDelivery;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

function mockPairedIosOperator(scopes: string[]) {
  listDevicePairingMock.mockResolvedValue({
    pending: [],
    paired: [
      {
        deviceId: "ios-device-1",
        publicKey: "pub",
        platform: "iOS 18",
        role: "operator",
        roles: ["operator"],
        createdAtMs: 1,
        approvedAtMs: 1,
        tokens: {
          operator: {
            token: "operator-token",
            role: "operator",
            scopes,
            createdAtMs: 1,
          },
        },
      },
    ],
  });
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

vi.mock("../infra/push-apns.js", () => ({
  loadApnsRegistration: loadApnsRegistrationMock,
  resolveApnsAuthConfigFromEnv: resolveApnsAuthConfigFromEnvMock,
  resolveApnsRelayConfigFromEnv: resolveApnsRelayConfigFromEnvMock,
  sendApnsExecApprovalAlert: sendApnsExecApprovalAlertMock,
  sendApnsExecApprovalResolvedWake: sendApnsExecApprovalResolvedWakeMock,
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

describe("createExecApprovalIosPushDelivery", () => {
  beforeAll(async () => {
    ({ createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [], paired: [] });
    loadApnsRegistrationMock.mockResolvedValue({
      nodeId: "ios-device-1",
      transport: "direct",
      token: "apns-token",
      topic: "ai.openclaw.ios.test",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue({
      ok: true,
      value: { teamId: "team", keyId: "key", privateKey: "private-key" },
    });
    resolveApnsRelayConfigFromEnvMock.mockReturnValue({ ok: false, error: "unused" });
    sendApnsExecApprovalAlertMock.mockResolvedValue({
      ok: true,
      status: 200,
      environment: "sandbox",
      topic: "ai.openclaw.ios.test",
      tokenSuffix: "token",
      transport: "direct",
    });
    sendApnsExecApprovalResolvedWakeMock.mockResolvedValue({
      ok: true,
      status: 200,
      environment: "sandbox",
      topic: "ai.openclaw.ios.test",
      tokenSuffix: "token",
      transport: "direct",
    });
  });

  it("does not target iOS devices whose active operator token lacks operator.approvals", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [],
      paired: [
        {
          deviceId: "ios-device-1",
          publicKey: "pub",
          platform: "iOS 18",
          role: "operator",
          roles: ["operator"],
          approvedScopes: ["operator.approvals"],
          createdAtMs: 1,
          approvedAtMs: 1,
          tokens: {
            operator: {
              token: "operator-token",
              role: "operator",
              scopes: ["operator.read"],
              createdAtMs: 1,
            },
          },
        },
      ],
    });

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested({
      id: "approval-1",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(accepted).toBe(false);
    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalAlertMock).not.toHaveBeenCalled();
  });

  it("targets iOS devices when the active operator token includes operator.approvals", async () => {
    mockPairedIosOperator(["operator.approvals", "operator.read"]);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested({
      id: "approval-2",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(accepted).toBe(true);
    expect(loadApnsRegistrationMock).toHaveBeenCalledWith("ios-device-1");
    expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledTimes(1);
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

    const accepted = await delivery.handleRequested({
      id: "approval-dead-route",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

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

    const requested = delivery.handleRequested({
      id: "approval-ordered-cleanup",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });
    const resolved = delivery.handleResolved({
      id: "approval-ordered-cleanup",
      decision: "allow-once",
      ts: 1,
    });

    await Promise.resolve();
    expect(sendApnsExecApprovalResolvedWakeMock).not.toHaveBeenCalled();

    requestedPush.resolve({
      ok: true,
      status: 200,
      environment: "sandbox",
      topic: "ai.openclaw.ios.test",
      tokenSuffix: "token",
      transport: "direct",
    });
    await requested;
    await resolved;

    expect(sendApnsExecApprovalResolvedWakeMock).toHaveBeenCalledTimes(1);
  });

  it("skips cleanup pushes when the original request target set is unknown", async () => {
    const debug = vi.fn();
    const delivery = createExecApprovalIosPushDelivery({ log: { debug } });

    await delivery.handleResolved({
      id: "approval-missing-targets",
      decision: "allow-once",
      ts: 1,
    });

    expect(debug).toHaveBeenCalledWith(
      "exec approvals: iOS cleanup push skipped approvalId=approval-missing-targets reason=missing-targets",
    );
    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalResolvedWakeMock).not.toHaveBeenCalled();
  });

  it("sends cleanup pushes only to the original request targets", async () => {
    mockPairedIosOperator(["operator.approvals", "operator.read"]);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    await delivery.handleRequested({
      id: "approval-cleanup",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });
    vi.clearAllMocks();
    loadApnsRegistrationMock.mockResolvedValue({
      nodeId: "ios-device-1",
      transport: "direct",
      token: "apns-token",
      topic: "ai.openclaw.ios.test",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue({
      ok: true,
      value: { teamId: "team", keyId: "key", privateKey: "private-key" },
    });

    await delivery.handleResolved({
      id: "approval-cleanup",
      decision: "allow-once",
      ts: 1,
    });

    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationMock).toHaveBeenCalledWith("ios-device-1");
    expect(sendApnsExecApprovalResolvedWakeMock).toHaveBeenCalledTimes(1);
  });
});
