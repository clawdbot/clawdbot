import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureNodeWakeLifecycle } from "../node-wake-state.js";
import {
  approveDevicePairingMock,
  getPendingDevicePairingMock,
  listDevicePairingMock,
  rejectDevicePairingMock,
  updatePairedDeviceMetadataMock,
  createClient,
  createOptions,
  expectRespondedErrorMessage,
  captureSecurityEvents,
  resetDeviceHandlerTestState,
} from "./devices.test-support.js";

const { deviceHandlers } = await import("./devices.js");

describe("device management", () => {
  beforeEach(resetDeviceHandlerTestState);

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

    await expectDefined(
      deviceHandlers["device.pair.list"],
      'deviceHandlers["device.pair.list"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.list"],
      'deviceHandlers["device.pair.list"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.list"],
      'deviceHandlers["device.pair.list"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.list"],
      'deviceHandlers["device.pair.list"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.list"],
      'deviceHandlers["device.pair.list"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.approve"],
      'deviceHandlers["device.pair.approve"] test invariant',
    )(opts);

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
      await expectDefined(
        deviceHandlers["device.pair.approve"],
        'deviceHandlers["device.pair.approve"] test invariant',
      )(opts);
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

  it("retires the previous node generation before returning reapproval success", async () => {
    approveDevicePairingMock.mockResolvedValue({
      status: "approved",
      requestId: "req-node-repair",
      nodePairingGenerationChanged: true,
      device: {
        deviceId: "node-repaired",
        publicKey: "replacement-key",
        role: "node",
        roles: ["node"],
        approvedAtMs: 200,
        createdAtMs: 100,
      },
    });
    const lifecycle = captureNodeWakeLifecycle("node-repaired");
    const opts = createOptions("device.pair.approve", { requestId: "req-node-repair" });
    const respond = vi.mocked(opts.respond);
    const invalidate = vi.mocked(opts.context.invalidateClientsForDevice!);
    const disconnect = vi.mocked(opts.context.disconnectClientsForDevice!);
    respond.mockImplementation(() => {
      expect(lifecycle.aborted).toBe(true);
      expect(invalidate).toHaveBeenCalledWith("node-repaired", {
        role: "node",
        reason: "device-pairing-reapproved",
      });
      expect(disconnect).not.toHaveBeenCalled();
    });

    await expectDefined(
      deviceHandlers["device.pair.approve"],
      'deviceHandlers["device.pair.approve"] test invariant',
    )(opts);
    await Promise.resolve();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith("node-repaired", { role: "node" });
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

    await expectDefined(
      deviceHandlers["device.pair.approve"],
      'deviceHandlers["device.pair.approve"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.approve"],
      'deviceHandlers["device.pair.approve"] test invariant',
    )(opts);

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
      await expectDefined(
        deviceHandlers["device.pair.approve"],
        'deviceHandlers["device.pair.approve"] test invariant',
      )(opts);
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

    await expectDefined(
      deviceHandlers["device.pair.approve"],
      'deviceHandlers["device.pair.approve"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.approve"],
      'deviceHandlers["device.pair.approve"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.approve"],
      'deviceHandlers["device.pair.approve"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.reject"],
      'deviceHandlers["device.pair.reject"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.reject"],
      'deviceHandlers["device.pair.reject"] test invariant',
    )(opts);

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
      await expectDefined(
        deviceHandlers["device.pair.reject"],
        'deviceHandlers["device.pair.reject"] test invariant',
      )(opts);
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

    await expectDefined(
      deviceHandlers["device.pair.rename"],
      'deviceHandlers["device.pair.rename"] test invariant',
    )(opts);

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
    expect(opts.context.broadcast).toHaveBeenCalledWith(
      "device.pair.changed",
      {},
      { dropIfSlow: true },
    );
  });

  it("rejects renaming another device from a non-admin device session", async () => {
    const opts = createOptions(
      "device.pair.rename",
      { deviceId: "device-2", label: "Not yours" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await expectDefined(
      deviceHandlers["device.pair.rename"],
      'deviceHandlers["device.pair.rename"] test invariant',
    )(opts);

    expect(updatePairedDeviceMetadataMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device pairing rename denied");
  });

  it("rejects rename for unknown device ids", async () => {
    updatePairedDeviceMetadataMock.mockResolvedValue(false);
    const opts = createOptions("device.pair.rename", {
      deviceId: "missing-device",
      label: "Ghost",
    });

    await expectDefined(
      deviceHandlers["device.pair.rename"],
      'deviceHandlers["device.pair.rename"] test invariant',
    )(opts);

    expect(updatePairedDeviceMetadataMock).toHaveBeenCalledWith("missing-device", {
      operatorLabel: "Ghost",
    });
    expect(opts.context.broadcast).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "unknown deviceId");
  });

  it("rejects empty labels after trim", async () => {
    const opts = createOptions("device.pair.rename", {
      deviceId: "device-1",
      label: "   ",
    });

    await expectDefined(
      deviceHandlers["device.pair.rename"],
      'deviceHandlers["device.pair.rename"] test invariant',
    )(opts);

    expect(updatePairedDeviceMetadataMock).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "label required");
  });

  it("rejects overlong rename labels at the schema boundary", async () => {
    const opts = createOptions("device.pair.rename", {
      deviceId: "device-1",
      label: "x".repeat(65),
    });

    await expectDefined(
      deviceHandlers["device.pair.rename"],
      'deviceHandlers["device.pair.rename"] test invariant',
    )(opts);

    expect(updatePairedDeviceMetadataMock).not.toHaveBeenCalled();
    const respond = opts.respond as ReturnType<typeof vi.fn>;
    const call = respond.mock.calls[0] as unknown as [boolean, unknown, { message?: string }];
    expect(call[0]).toBe(false);
    expect(call[2]?.message).toContain("invalid device.pair.rename params");
  });
});
