import { beforeEach, describe, expect, it, vi } from "vitest";
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
} = vi.hoisted(() => ({
  approveDevicePairingMock: vi.fn(),
  getPairedDeviceMock: vi.fn(),
  getPendingDevicePairingMock: vi.fn(),
  listDevicePairingMock: vi.fn(),
  removePairedDeviceMock: vi.fn(),
  rejectDevicePairingMock: vi.fn(),
  revokeDeviceTokenMock: vi.fn(),
  rotateDeviceTokenMock: vi.fn(),
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

describe("deviceHandlers", () => {
  beforeEach(() => {
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

  it("does not disconnect clients when device removal fails", async () => {
    removePairedDeviceMock.mockResolvedValue(null);
    const opts = createOptions("device.pair.remove", { deviceId: "device-1" });

    await deviceHandlers["device.pair.remove"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown deviceId" }),
    );
  });

  it("rejects removing another device from a non-admin device session", async () => {
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: "device-2" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await deviceHandlers["device.pair.remove"](opts);

    expect(removePairedDeviceMock).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device pairing removal denied" }),
    );
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

  it("disconnects active clients after revoking a device token", async () => {
    revokeDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: { role: "operator", revokedAtMs: 456 },
    });
    const opts = createOptions("device.token.revoke", {
      deviceId: " device-1 ",
      role: " operator ",
    });

    await deviceHandlers["device.token.revoke"](opts);
    await Promise.resolve();

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
    mockPairedOperatorDevice();
    rotateDeviceTokenMock.mockResolvedValue({ ok: false, reason: "unknown-device-or-role" });
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

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "node",
      scopes: undefined,
      callerScopes: ["operator.pairing"],
    });
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device token rotation denied" }),
    );
  });

  it("does not disconnect clients when token revocation fails", async () => {
    revokeDeviceTokenMock.mockResolvedValue({ ok: false, reason: "unknown-device-or-role" });
    const opts = createOptions("device.token.revoke", {
      deviceId: "device-1",
      role: "operator",
    });

    await deviceHandlers["device.token.revoke"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device token revocation denied" }),
    );
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
          },
          {
            deviceId: "device-2",
            publicKey: "pk-2",
            approvedAtMs: 200,
            createdAtMs: 60,
            tokens: undefined,
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
          },
        ],
      },
      undefined,
    );
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
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device pairing approval denied" }),
    );
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

    await deviceHandlers["device.pair.approve"](opts);

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
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device pairing rejection denied" }),
    );
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

    await deviceHandlers["device.pair.reject"](opts);

    expect(rejectDevicePairingMock).toHaveBeenCalledWith("req-2");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { requestId: "req-2", deviceId: "device-2", rejectedAtMs: 456 },
      undefined,
    );
  });
});
