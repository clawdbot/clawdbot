// Device method tests cover pairing approval/rejection, paired-device lookup,
// token rotation/revocation, and operator scope enforcement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../../infra/diagnostic-events.js";
import { deviceHandlers } from "./devices.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const {
  approveDevicePairingMock,
  getPairedDeviceMock,
  getPendingDevicePairingMock,
  listDevicePairingMock,
  removePairedDeviceMock,
  rejectDevicePairingMock,
  revokeDeviceTokenMock,
  rotateDeviceTokenMock,
  updatePairedDeviceMetadataMock,
} = vi.hoisted(() => ({
  approveDevicePairingMock: vi.fn(),
  getPairedDeviceMock: vi.fn(),
  getPendingDevicePairingMock: vi.fn(),
  listDevicePairingMock: vi.fn(),
  removePairedDeviceMock: vi.fn(),
  rejectDevicePairingMock: vi.fn(),
  revokeDeviceTokenMock: vi.fn(),
  rotateDeviceTokenMock: vi.fn(),
  updatePairedDeviceMetadataMock: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return {
    ...actual,
    approveDevicePairing: approveDevicePairingMock,
    getPairedDevice: getPairedDeviceMock,
    getPendingDevicePairing: getPendingDevicePairingMock,
    listDevicePairing: listDevicePairingMock,
    removePairedDevice: removePairedDeviceMock,
    rejectDevicePairing: rejectDevicePairingMock,
    revokeDeviceToken: revokeDeviceTokenMock,
    rotateDeviceToken: rotateDeviceTokenMock,
    updatePairedDeviceMetadata: updatePairedDeviceMetadataMock,
  };
});

function createClient(
  scopes: string[],
  deviceId?: string,
  opts?: {
    isDeviceTokenAuth?: boolean;
  },
) {
  return {
    ...(opts?.isDeviceTokenAuth !== undefined ? { isDeviceTokenAuth: opts.isDeviceTokenAuth } : {}),
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

function createOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      disconnectClientsForDevice: vi.fn(),
      invalidateClientsForDevice: vi.fn(),
      logGateway: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function mockPairedOperatorDevice(): void {
  getPairedDeviceMock.mockResolvedValue({
    deviceId: "device-1",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing"],
    tokens: {
      operator: {
        token: "old-token",
        role: "operator",
        scopes: ["operator.pairing"],
        createdAtMs: 123,
      },
    },
  });
}

function mockRotateOperatorTokenSuccess(): void {
  rotateDeviceTokenMock.mockResolvedValue({
    ok: true,
    entry: {
      token: "new-token",
      role: "operator",
      scopes: ["operator.pairing"],
      createdAtMs: 456,
      rotatedAtMs: 789,
    },
  });
}

function expectRespondedErrorMessage(opts: GatewayRequestHandlerOptions, message: string): void {
  const respond = opts.respond as ReturnType<typeof vi.fn>;
  expect(respond).toHaveBeenCalledTimes(1);
  const call = respond.mock.calls[0] as unknown as [boolean, unknown, { message?: string }];
  expect(call[0]).toBe(false);
  expect(call[1]).toBeUndefined();
  expect(call[2]?.message).toBe(message);
}

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

describe("deviceHandlers", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    vi.clearAllMocks();
  });

  it("disconnects active clients after removing a paired device", async () => {
    removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1", removedAtMs: 123 });
    const opts = createOptions("device.pair.remove", { deviceId: " device-1 " });

    await deviceHandlers["device.pair.remove"](opts);
    await Promise.resolve();

    expect(removePairedDeviceMock).toHaveBeenCalledWith(" device-1 ");
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", removedAtMs: 123 },
      undefined,
    );
  });

  it("invalidates affected clients synchronously before responding to device.pair.remove", async () => {
    removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1", removedAtMs: 123 });
    const opts = createOptions("device.pair.remove", { deviceId: "device-1" });
    const respond = vi.mocked(opts.respond);
    const invalidate = vi.mocked(opts.context.invalidateClientsForDevice!);
    const disconnect = vi.mocked(opts.context.disconnectClientsForDevice!);

    respond.mockImplementation(() => {
      // At the moment the response is emitted, the client flag must already
      // be set so any RPCs pipelined in the WS buffer are rejected.
      expect(invalidate).toHaveBeenCalledWith("device-1", { reason: "device-pair-removed" });
      // The hard close is deferred to the microtask to let the response flush.
      expect(disconnect).not.toHaveBeenCalled();
    });

    await deviceHandlers["device.pair.remove"](opts);
    await Promise.resolve();

    expect(respond).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith("device-1");
  });

  it("does not disconnect clients when device removal fails", async () => {
    removePairedDeviceMock.mockResolvedValue(null);
    const opts = createOptions("device.pair.remove", { deviceId: "device-1" });

    await deviceHandlers["device.pair.remove"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "unknown deviceId");
  });

  it("rejects removing another device from a non-admin device session", async () => {
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: "device-2" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.pair.remove"](opts);

    expect(removePairedDeviceMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing removal denied");
  });

  it("treats normalized device ids as self-owned for paired device removal", async () => {
    removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1", removedAtMs: 123 });
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: " device-1 " },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.pair.remove"](opts);

    expect(removePairedDeviceMock).toHaveBeenCalledWith(" device-1 ");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", removedAtMs: 123 },
      undefined,
    );
  });

  it("rejects removing mixed-role devices without admin scope", async () => {
    getPairedDeviceMock.mockResolvedValue({
      deviceId: "device-1",
      role: "operator",
      roles: ["operator", "node"],
      tokens: {
        operator: {
          token: "operator-token",
          role: "operator",
          scopes: ["operator.pairing"],
          createdAtMs: 100,
        },
        node: {
          token: "node-token",
          role: "node",
          scopes: [],
          createdAtMs: 100,
          revokedAtMs: 200,
        },
      },
    });
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: "device-1" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.pair.remove"](opts);

    expect(removePairedDeviceMock).not.toHaveBeenCalled();
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing removal denied");
  });

  it("disconnects active clients after revoking a device token", async () => {
    revokeDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: { token: "raw-revoked-token", role: "operator", scopes: [], revokedAtMs: 456 },
    });
    const opts = createOptions("device.token.revoke", {
      deviceId: " device-1 ",
      role: " operator ",
    });
    const captured = captureSecurityEvents();

    try {
      await deviceHandlers["device.token.revoke"](opts);
      await Promise.resolve();
    } finally {
      captured.stop();
    }

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
      callerScopes: [],
    });
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", role: "operator", revokedAtMs: 456 },
      undefined,
    );
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      type: "security.event",
      category: "auth",
      action: "device.token.revoked",
      outcome: "success",
      severity: "high",
      target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
      policy: { id: "gateway.device-token", decision: "allow" },
      control: { id: "device.token.revoke", family: "auth" },
      attributes: { role: "operator" },
    });
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("device-1");
    expect(serialized).not.toContain("raw-revoked-token");
  });

  it("allows admin-scoped callers to revoke another device's token", async () => {
    revokeDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: { role: "operator", revokedAtMs: 456 },
    });
    const opts = createOptions(
      "device.token.revoke",
      { deviceId: "device-2", role: "operator" },
      { client: createClient(["operator.admin"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.token.revoke"](opts);

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: "device-2",
      role: "operator",
      callerScopes: ["operator.admin"],
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-2", role: "operator", revokedAtMs: 456 },
      undefined,
    );
  });

  it("rejects revoking node tokens without admin scope", async () => {
    const opts = createOptions(
      "device.token.revoke",
      { deviceId: "device-1", role: "node" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );
    const captured = captureSecurityEvents();

    try {
      await deviceHandlers["device.token.revoke"](opts);
    } finally {
      captured.stop();
    }

    expect(revokeDeviceTokenMock).not.toHaveBeenCalled();
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device token revocation denied");
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "device.token.revocation_denied",
      outcome: "denied",
      reason: "role-management-requires-admin",
      actor: {
        kind: "operator",
        deviceIdHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u),
        role: "operator",
      },
      target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
      policy: {
        id: "gateway.device-token",
        decision: "deny",
        reason: "role-management-requires-admin",
      },
      control: { id: "device.token.revoke", family: "auth" },
      attributes: { role: "node" },
    });
    expect(JSON.stringify(captured.events)).not.toContain("device-1");
  });

  it("treats normalized device ids as self-owned for token revocation", async () => {
    revokeDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: { role: "operator", revokedAtMs: 456 },
    });
    const opts = createOptions(
      "device.token.revoke",
      { deviceId: " device-1 ", role: "operator" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.token.revoke"](opts);

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: "operator",
      callerScopes: ["operator.pairing"],
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", role: "operator", revokedAtMs: 456 },
      undefined,
    );
  });

  it("disconnects active clients after rotating a device token", async () => {
    mockPairedOperatorDevice();
    mockRotateOperatorTokenSuccess();
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: " device-1 ",
        role: " operator ",
        scopes: ["operator.pairing"],
      },
      {
        client: {
          connect: {
            scopes: ["operator.pairing"],
          },
        } as never,
      },
    );

    await deviceHandlers["device.token.rotate"](opts);
    await Promise.resolve();

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
      scopes: ["operator.pairing"],
      callerScopes: ["operator.pairing"],
    });
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: " device-1 ",
        role: "operator",
        scopes: ["operator.pairing"],
        rotatedAtMs: 789,
      },
      undefined,
    );
  });

  it("invalidates affected clients synchronously before responding to device.token.rotate", async () => {
    mockPairedOperatorDevice();
    mockRotateOperatorTokenSuccess();
    const opts = createOptions(
      "device.token.rotate",
      { deviceId: "device-1", role: "operator", scopes: ["operator.pairing"] },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );
    const respond = vi.mocked(opts.respond);
    const invalidate = vi.mocked(opts.context.invalidateClientsForDevice!);
    const disconnect = vi.mocked(opts.context.disconnectClientsForDevice!);

    respond.mockImplementation(() => {
      expect(invalidate).toHaveBeenCalledWith("device-1", {
        role: "operator",
        reason: "device-token-rotated",
      });
      expect(disconnect).not.toHaveBeenCalled();
    });

    await deviceHandlers["device.token.rotate"](opts);
    await Promise.resolve();

    expect(respond).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith("device-1", { role: "operator" });
  });

  it("invalidates affected clients synchronously before responding to device.token.revoke", async () => {
    revokeDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: { role: "operator", revokedAtMs: 456 },
    });
    const opts = createOptions(
      "device.token.revoke",
      { deviceId: "device-1", role: "operator" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );
    const respond = vi.mocked(opts.respond);
    const invalidate = vi.mocked(opts.context.invalidateClientsForDevice!);
    const disconnect = vi.mocked(opts.context.disconnectClientsForDevice!);

    respond.mockImplementation(() => {
      expect(invalidate).toHaveBeenCalledWith("device-1", {
        role: "operator",
        reason: "device-token-revoked",
      });
      expect(disconnect).not.toHaveBeenCalled();
    });

    await deviceHandlers["device.token.revoke"](opts);
    await Promise.resolve();

    expect(respond).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith("device-1", { role: "operator" });
  });

  it("treats normalized device ids as self-owned for token rotation", async () => {
    mockPairedOperatorDevice();
    mockRotateOperatorTokenSuccess();
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: " device-1 ",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.token.rotate"](opts);

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: "operator",
      scopes: ["operator.pairing"],
      callerScopes: ["operator.pairing"],
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: " device-1 ",
        role: "operator",
        token: "new-token",
        scopes: ["operator.pairing"],
        rotatedAtMs: 789,
      },
      undefined,
    );
  });

  it("allows pairing-scoped device sessions to manage their own operator token", async () => {
    rotateDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: {
        token: "rotated-token",
        role: "operator",
        scopes: ["operator.pairing"],
        createdAtMs: 456,
        rotatedAtMs: 789,
      },
    });
    revokeDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: { role: "operator", revokedAtMs: 987 },
    });

    const rotateOpts = createOptions(
      "device.token.rotate",
      { deviceId: "device-1", role: "operator", scopes: ["operator.pairing"] },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );
    const revokeOpts = createOptions(
      "device.token.revoke",
      { deviceId: "device-1", role: "operator" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.token.rotate"](rotateOpts);
    await deviceHandlers["device.token.revoke"](revokeOpts);

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.pairing"],
      callerScopes: ["operator.pairing"],
    });
    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "operator",
      callerScopes: ["operator.pairing"],
    });
    expect(rotateOpts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: "device-1",
        role: "operator",
        token: "rotated-token",
        scopes: ["operator.pairing"],
        rotatedAtMs: 789,
      },
      undefined,
    );
    expect(revokeOpts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", role: "operator", revokedAtMs: 987 },
      undefined,
    );
  });

  it("omits rotated tokens when an admin rotates another device token", async () => {
    mockPairedOperatorDevice();
    mockRotateOperatorTokenSuccess();
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      {
        client: createClient(["operator.admin", "operator.pairing"], "admin-device", {
          isDeviceTokenAuth: true,
        }),
      },
    );

    await deviceHandlers["device.token.rotate"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.pairing"],
        rotatedAtMs: 789,
      },
      undefined,
    );
  });

  it("rejects rotating a token for a role that was never approved", async () => {
    rotateDeviceTokenMock.mockResolvedValue({ ok: false, reason: "unknown-device-or-role" });
    const opts = createOptions(
      "device.token.rotate",
      { deviceId: "device-1", role: "node" },
      { client: createClient(["operator.admin"], "admin-device", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.token.rotate"](opts);

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "node",
      scopes: undefined,
      callerScopes: ["operator.admin"],
    });
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device token rotation denied");
  });

  it("rejects rotating node tokens without admin scope", async () => {
    mockPairedOperatorDevice();
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: "device-1",
        role: "node",
      },
      {
        client: {
          connect: {
            scopes: ["operator.pairing"],
          },
        } as never,
      },
    );

    await deviceHandlers["device.token.rotate"](opts);

    expect(rotateDeviceTokenMock).not.toHaveBeenCalled();
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device token rotation denied");
  });

  it("does not disconnect clients when token revocation fails", async () => {
    revokeDeviceTokenMock.mockResolvedValue({ ok: false, reason: "unknown-device-or-role" });
    const opts = createOptions("device.token.revoke", {
      deviceId: "device-1",
      role: "operator",
    });

    await deviceHandlers["device.token.revoke"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device token revocation denied");
  });

  it("filters pairing list to the caller device for non-admin device sessions", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [
        { requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 },
        { requestId: "req-2", deviceId: "device-2", publicKey: "pk-2", ts: 200 },
      ],
      paired: [
        {
          deviceId: "device-1",
          publicKey: "pk-1",
          approvedAtMs: 100,
          createdAtMs: 50,
        },
        {
          deviceId: "device-2",
          publicKey: "pk-2",
          approvedAtMs: 200,
          createdAtMs: 60,
        },
      ],
    });
    const opts = createOptions(
      "device.pair.list",
      {},
      {
        client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }),
      },
    );

    await deviceHandlers["device.pair.list"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        pending: [{ requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 }],
        paired: [
          {
            deviceId: "device-1",
            publicKey: "pk-1",
            approvedAtMs: 100,
            createdAtMs: 50,
            tokens: undefined,
            connected: false,
          },
        ],
      },
      undefined,
    );
  });

  it("preserves the full pairing list for admin device sessions", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [
        { requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 },
        { requestId: "req-2", deviceId: "device-2", publicKey: "pk-2", ts: 200 },
      ],
      paired: [
        { deviceId: "device-1", publicKey: "pk-1", approvedAtMs: 100, createdAtMs: 50 },
        { deviceId: "device-2", publicKey: "pk-2", approvedAtMs: 200, createdAtMs: 60 },
      ],
    });
    const opts = createOptions(
      "device.pair.list",
      {},
      {
        client: createClient(["operator.pairing", "operator.admin"], "device-1", {
          isDeviceTokenAuth: true,
        }),
      },
    );

    await deviceHandlers["device.pair.list"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        pending: [
          { requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 },
          { requestId: "req-2", deviceId: "device-2", publicKey: "pk-2", ts: 200 },
        ],
        paired: [
          {
            deviceId: "device-1",
            publicKey: "pk-1",
            approvedAtMs: 100,
            createdAtMs: 50,
            tokens: undefined,
            connected: false,
          },
          {
            deviceId: "device-2",
            publicKey: "pk-2",
            approvedAtMs: 200,
            createdAtMs: 60,
            tokens: undefined,
            connected: false,
          },
        ],
      },
      undefined,
    );
  });

  it("preserves the full pairing list for non-device operator sessions", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [{ requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 }],
      paired: [{ deviceId: "device-2", publicKey: "pk-2", approvedAtMs: 200, createdAtMs: 60 }],
    });
    const opts = createOptions(
      "device.pair.list",
      {},
      {
        client: createClient(["operator.pairing"]),
      },
    );

    await deviceHandlers["device.pair.list"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        pending: [{ requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 }],
        paired: [
          {
            deviceId: "device-2",
            publicKey: "pk-2",
            approvedAtMs: 200,
            createdAtMs: 60,
            tokens: undefined,
            connected: false,
          },
        ],
      },
      undefined,
    );
  });

  it("preserves the full pairing list for shared-auth sessions carrying a device identity", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [
        { requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 },
        { requestId: "req-2", deviceId: "device-2", publicKey: "pk-2", ts: 200 },
      ],
      paired: [{ deviceId: "device-2", publicKey: "pk-2", approvedAtMs: 200, createdAtMs: 60 }],
    });
    const opts = createOptions(
      "device.pair.list",
      {},
      {
        client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: false }),
      },
    );

    await deviceHandlers["device.pair.list"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        pending: [
          { requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 },
          { requestId: "req-2", deviceId: "device-2", publicKey: "pk-2", ts: 200 },
        ],
        paired: [
          {
            deviceId: "device-2",
            publicKey: "pk-2",
            approvedAtMs: 200,
            createdAtMs: 60,
            tokens: undefined,
            connected: false,
          },
        ],
      },
      undefined,
    );
  });

  it("marks live device connections in the pairing list", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [],
      paired: [
        { deviceId: "device-1", publicKey: "pk-1", approvedAtMs: 100, createdAtMs: 50 },
        { deviceId: "device-2", publicKey: "pk-2", approvedAtMs: 200, createdAtMs: 60 },
      ],
    });
    const opts = createOptions(
      "device.pair.list",
      {},
      { client: createClient(["operator.pairing"]) },
    );
    (
      opts.context as { hasConnectedClientsForDevice?: (deviceId: string) => boolean }
    ).hasConnectedClientsForDevice = (deviceId) => deviceId === "device-2";

    await deviceHandlers["device.pair.list"](opts);

    const respond = opts.respond as ReturnType<typeof vi.fn>;
    const payload = respond.mock.calls[0]?.[1] as {
      paired: Array<{ deviceId: string; connected: boolean }>;
    };
    expect(payload.paired.map((device) => [device.deviceId, device.connected])).toEqual([
      ["device-1", false],
      ["device-2", true],
    ]);
  });

  it("rejects approving another device from a non-admin device session", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-2",
      deviceId: "device-2",
      publicKey: "pk-2",
      ts: 100,
    });
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "req-2" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.pair.approve"](opts);

    expect(approveDevicePairingMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing approval denied");
  });

  it("allows admins to approve another device", async () => {
    approveDevicePairingMock.mockResolvedValue({
      status: "approved",
      requestId: "req-2",
      device: {
        deviceId: "device-2",
        publicKey: "pk-2",
        approvedAtMs: 200,
        createdAtMs: 150,
      },
    });
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "req-2" },
      {
        client: createClient(["operator.admin"], "device-1", {
          isDeviceTokenAuth: true,
        }),
      },
    );
    const captured = captureSecurityEvents();

    try {
      await deviceHandlers["device.pair.approve"](opts);
    } finally {
      captured.stop();
    }

    expect(getPendingDevicePairingMock).not.toHaveBeenCalled();
    expect(approveDevicePairingMock).toHaveBeenCalledWith("req-2", {
      callerScopes: ["operator.admin"],
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "req-2",
        device: {
          deviceId: "device-2",
          publicKey: "pk-2",
          approvedAtMs: 200,
          createdAtMs: 150,
          tokens: undefined,
        },
      },
      undefined,
    );
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "device.pairing.approved",
      outcome: "success",
      severity: "low",
      actor: {
        kind: "operator",
        deviceIdHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u),
        role: "admin",
      },
      target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
      policy: { id: "gateway.device-pairing", decision: "allow" },
      control: { id: "device.pair.approve", family: "auth" },
      attributes: { role_count: 0, scope_count: 0 },
    });
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("device-1");
    expect(serialized).not.toContain("device-2");
    expect(serialized).not.toContain("pk-2");
  });

  it("allows approving the caller device from a non-admin device session", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-1",
      deviceId: " device-1 ",
      publicKey: "pk-1",
      ts: 100,
    });
    approveDevicePairingMock.mockResolvedValue({
      status: "approved",
      requestId: "req-1",
      device: {
        deviceId: "device-1",
        publicKey: "pk-1",
        approvedAtMs: 100,
        createdAtMs: 50,
      },
    });
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "req-1" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.pair.approve"](opts);

    expect(approveDevicePairingMock).toHaveBeenCalledWith("req-1", {
      callerScopes: ["operator.pairing"],
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "req-1",
        device: {
          deviceId: "device-1",
          publicKey: "pk-1",
          approvedAtMs: 100,
          createdAtMs: 50,
          tokens: undefined,
        },
      },
      undefined,
    );
  });

  it("allows shared-auth operator sessions to approve operator roles within caller scopes", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-1",
      deviceId: "device-2",
      publicKey: "pk-2",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.pairing"],
      ts: 100,
    });
    approveDevicePairingMock.mockResolvedValue({
      status: "approved",
      requestId: "req-1",
      device: {
        deviceId: "device-2",
        publicKey: "pk-2",
        role: "operator",
        roles: ["operator"],
        approvedScopes: ["operator.pairing"],
        approvedAtMs: 100,
        createdAtMs: 50,
      },
    });
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "req-1" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: false }) },
    );

    await deviceHandlers["device.pair.approve"](opts);

    expect(getPendingDevicePairingMock).toHaveBeenCalledWith("req-1");
    expect(approveDevicePairingMock).toHaveBeenCalledWith("req-1", {
      callerScopes: ["operator.pairing"],
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "req-1",
        device: {
          deviceId: "device-2",
          publicKey: "pk-2",
          role: "operator",
          roles: ["operator"],
          approvedAtMs: 100,
          createdAtMs: 50,
          tokens: undefined,
        },
      },
      undefined,
    );
  });

  it("rejects approving node roles for the caller device without admin scope", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-1",
      deviceId: " device-1 ",
      publicKey: "pk-1",
      role: "node",
      roles: ["node"],
      ts: 100,
    });
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "req-1" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );
    const captured = captureSecurityEvents();

    try {
      await deviceHandlers["device.pair.approve"](opts);
    } finally {
      captured.stop();
    }

    expect(approveDevicePairingMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing approval denied");
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "device.pairing.denied",
      outcome: "denied",
      reason: "role-management-requires-admin",
      policy: {
        id: "gateway.device-pairing",
        decision: "deny",
        reason: "role-management-requires-admin",
      },
      control: { id: "device.pair.approve", family: "auth" },
    });
    expect(JSON.stringify(captured.events)).not.toContain("device-1");
  });

  it("rejects approving node roles from non-admin shared-auth sessions", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-1",
      deviceId: "device-1",
      publicKey: "pk-1",
      role: "node",
      roles: ["node"],
      ts: 100,
    });
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "req-1" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: false }) },
    );

    await deviceHandlers["device.pair.approve"](opts);

    expect(approveDevicePairingMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing approval denied");
  });

  it("rejects approving mixed operator and node roles from non-admin sessions", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-1",
      deviceId: "device-2",
      publicKey: "pk-2",
      role: "operator",
      roles: [" operator ", " node "],
      scopes: ["operator.pairing"],
      ts: 100,
    });
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "req-1" },
      { client: createClient(["operator.pairing"]) },
    );

    await deviceHandlers["device.pair.approve"](opts);

    expect(approveDevicePairingMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing approval denied");
  });

  it("denies unknown approvals from non-admin non-device sessions", async () => {
    getPendingDevicePairingMock.mockResolvedValue(null);
    const opts = createOptions(
      "device.pair.approve",
      { requestId: "missing" },
      { client: createClient(["operator.pairing"]) },
    );

    await deviceHandlers["device.pair.approve"](opts);

    expect(approveDevicePairingMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing approval denied");
  });

  it("rejects rejecting another device from a non-admin device session", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-2",
      deviceId: "device-2",
      publicKey: "pk-2",
      ts: 100,
    });
    const opts = createOptions(
      "device.pair.reject",
      { requestId: "req-2" },
      {
        client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }),
      },
    );

    await deviceHandlers["device.pair.reject"](opts);

    expect(rejectDevicePairingMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing rejection denied");
  });

  it("allows rejecting the caller device from a non-admin device session", async () => {
    getPendingDevicePairingMock.mockResolvedValue({
      requestId: "req-1",
      deviceId: " device-1 ",
      publicKey: "pk-1",
      ts: 100,
    });
    rejectDevicePairingMock.mockResolvedValue({
      requestId: "req-1",
      deviceId: "device-1",
      rejectedAtMs: 123,
    });
    const opts = createOptions(
      "device.pair.reject",
      { requestId: "req-1" },
      {
        client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }),
      },
    );

    await deviceHandlers["device.pair.reject"](opts);

    expect(rejectDevicePairingMock).toHaveBeenCalledWith("req-1");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { requestId: "req-1", deviceId: "device-1", rejectedAtMs: 123 },
      undefined,
    );
  });

  it("allows admins to reject another device", async () => {
    rejectDevicePairingMock.mockResolvedValue({
      requestId: "req-2",
      deviceId: "device-2",
      rejectedAtMs: 456,
    });
    const opts = createOptions(
      "device.pair.reject",
      { requestId: "req-2" },
      {
        client: createClient(["operator.pairing", "operator.admin"], "device-1", {
          isDeviceTokenAuth: true,
        }),
      },
    );
    const captured = captureSecurityEvents();

    try {
      await deviceHandlers["device.pair.reject"](opts);
    } finally {
      captured.stop();
    }

    expect(rejectDevicePairingMock).toHaveBeenCalledWith("req-2");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { requestId: "req-2", deviceId: "device-2", rejectedAtMs: 456 },
      undefined,
    );
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "device.pairing.rejected",
      outcome: "success",
      severity: "low",
      actor: {
        kind: "operator",
        role: "admin",
      },
      target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
      policy: { id: "gateway.device-pairing", decision: "allow" },
      control: { id: "device.pair.reject", family: "auth" },
    });
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("device-1");
    expect(serialized).not.toContain("device-2");
  });

  it("renames a paired device with an operator label", async () => {
    updatePairedDeviceMetadataMock.mockResolvedValue(true);
    const opts = createOptions("device.pair.rename", {
      deviceId: "device-1",
      label: "  Kitchen Mac  ",
    });

    await deviceHandlers["device.pair.rename"](opts);

    expect(updatePairedDeviceMetadataMock).toHaveBeenCalledWith("device-1", {
      operatorLabel: "Kitchen Mac",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", label: "Kitchen Mac" },
      undefined,
    );
    expect(opts.context.logGateway.info).toHaveBeenCalledWith(
      "device pairing renamed device=device-1 label=Kitchen Mac",
    );
  });

  it("rejects renaming another device from a non-admin device session", async () => {
    const opts = createOptions(
      "device.pair.rename",
      { deviceId: "device-2", label: "Not yours" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.pair.rename"](opts);

    expect(updatePairedDeviceMetadataMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing rename denied");
  });

  it("rejects rename for unknown device ids", async () => {
    updatePairedDeviceMetadataMock.mockResolvedValue(false);
    const opts = createOptions("device.pair.rename", {
      deviceId: "missing-device",
      label: "Ghost",
    });

    await deviceHandlers["device.pair.rename"](opts);

    expect(updatePairedDeviceMetadataMock).toHaveBeenCalledWith("missing-device", {
      operatorLabel: "Ghost",
    });
    expectRespondedErrorMessage(opts, "unknown deviceId");
  });

  it("rejects empty labels after trim", async () => {
    const opts = createOptions("device.pair.rename", {
      deviceId: "device-1",
      label: "   ",
    });

    await deviceHandlers["device.pair.rename"](opts);

    expect(updatePairedDeviceMetadataMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "label required");
  });

  it("rejects overlong rename labels at the schema boundary", async () => {
    const opts = createOptions("device.pair.rename", {
      deviceId: "device-1",
      label: "x".repeat(65),
    });

    await deviceHandlers["device.pair.rename"](opts);

    expect(updatePairedDeviceMetadataMock).not.toHaveBeenCalled();
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    const call = respond.mock.calls[0] as unknown as [boolean, unknown, { message?: string }];
    expect(call[0]).toBe(false);
    expect(call[2]?.message).toContain("invalid device.pair.rename params");
  });
});
