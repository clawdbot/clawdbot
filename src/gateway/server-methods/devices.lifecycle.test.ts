import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainNodePendingWork, enqueueNodePendingWork } from "../node-pending-work.js";
import { captureNodeWakeLifecycle, releaseNodeWakeLifecycle } from "../node-wake-state.js";
import { getNodeWakeStateSnapshot } from "../node-wake-state.test-support.js";
import { registerGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { bindDeviceWorkerReconciliation } from "../worker-environments/device-provider.js";
import {
  getPairedDeviceMock,
  removePairedDeviceMock,
  revokeDeviceTokenMock,
  rotateDeviceTokenMock,
  createClient,
  createOptions,
  mockPairedOperatorDevice,
  mockRotateOperatorTokenSuccess,
  expectRespondedErrorMessage,
  captureSecurityEvents,
  seedNodeWakeState,
  resetDeviceHandlerTestState,
} from "./devices.test-support.js";

const { deviceHandlers } = await import("./devices.js");

describe("device lifecycle", () => {
  beforeEach(resetDeviceHandlerTestState);

  it("clears and invalidates node runtime state after removing a full device pairing", async () => {
    const nodeId = "disconnected-node-device";
    removePairedDeviceMock.mockResolvedValue({ deviceId: nodeId });
    await seedNodeWakeState(nodeId);
    enqueueNodePendingWork({ nodeId, type: "location.request" });
    const wakeLifecycle = captureNodeWakeLifecycle(nodeId);
    const opts = createOptions("device.pair.remove", { deviceId: nodeId });

    await expectDefined(
      deviceHandlers["device.pair.remove"],
      'deviceHandlers["device.pair.remove"] test invariant',
    )(opts);

    expect(getNodeWakeStateSnapshot(nodeId)).toBeUndefined();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(drainNodePendingWork(nodeId).items.map((item) => item.id)).toEqual(["baseline-status"]);
    const nodeRegistry = opts.context.nodeRegistry as unknown as {
      updateSurface: ReturnType<typeof vi.fn>;
    };
    expect(nodeRegistry.updateSurface).toHaveBeenCalledWith(nodeId, {
      caps: [],
      commands: [],
      permissions: undefined,
    });
    expect(opts.context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      reason: "device-pair-removed",
    });
  });

  it("clears node runtime state and reconciles workers after revoking a node token", async () => {
    const nodeId = "revoked-node-device";
    revokeDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: { token: "raw-node-token", role: "node", scopes: [], revokedAtMs: 456 },
    });
    await seedNodeWakeState(nodeId);
    enqueueNodePendingWork({ nodeId, type: "location.request" });
    const wakeLifecycle = captureNodeWakeLifecycle(nodeId);
    const workerEnvironmentService = {};
    const reconciledDevices: string[] = [];
    bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
      reconciledDevices.push(deviceId);
      return [];
    });
    const opts = createOptions(
      "device.token.revoke",
      { deviceId: nodeId, role: "node" },
      // Non-operator role management requires an admin-scoped caller.
      { client: createClient(["operator.admin"], "admin-device", { isDeviceTokenAuth: true }) },
    );
    Object.assign(opts.context, { workerEnvironmentService });

    await expectDefined(
      deviceHandlers["device.token.revoke"],
      'deviceHandlers["device.token.revoke"] test invariant',
    )(opts);

    // Revocation ends node authority like pairing removal: the same teardown
    // owner must run so pending work, wake state, surface caps, and worker
    // placements are not stranded on a dead node.
    expect(getNodeWakeStateSnapshot(nodeId)).toBeUndefined();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(drainNodePendingWork(nodeId).items.map((item) => item.id)).toEqual(["baseline-status"]);
    const nodeRegistry = opts.context.nodeRegistry as unknown as {
      updateSurface: ReturnType<typeof vi.fn>;
    };
    expect(nodeRegistry.updateSurface).toHaveBeenCalledWith(nodeId, {
      caps: [],
      commands: [],
      permissions: undefined,
    });
    expect(reconciledDevices).toEqual([nodeId]);
    expect(opts.context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-token-revoked",
    });
  });

  it.each(
    ["device.pair.remove", "device.token.revoke"].flatMap((method) =>
      [false, true].map((callerRetired) => ({ method, callerRetired })),
    ),
  )(
    "finishes $method teardown when callerRetired=$callerRetired",
    async ({ method, callerRetired }) => {
      const revoking = method === "device.token.revoke";
      const opts = createOptions(
        method,
        { deviceId: " device-1 ", ...(revoking ? { role: "node" } : {}) },
        { client: createClient(["operator.admin"], "admin-device", { isDeviceTokenAuth: true }) },
      );
      const client = Object.assign(expectDefined(opts.client, "removal caller"), {
        invalidated: false,
        socket: { close: vi.fn() },
      });
      const removed = { deviceId: "device-1", removedAtMs: 123 };
      const mutation = revoking ? revokeDeviceTokenMock : removePairedDeviceMock;
      mutation.mockImplementationOnce(async () => {
        client.invalidated = callerRetired;
        return revoking ? { ok: true, entry: { role: "node", revokedAtMs: 456 } } : removed;
      });
      const policyResponse = registerGatewayPolicyResponse(method, client, opts.respond);
      const order: string[] = [];
      const workerEnvironmentService = {};
      bindDeviceWorkerReconciliation(workerEnvironmentService, async () => {
        order.push("environment");
        return ["environment-1"];
      });
      const reconcileActive = vi.fn(async () => {
        order.push("placement");
      });
      Object.assign(opts.context, {
        workerEnvironmentService,
        workerPlacementDispatchService: { reconcileActive },
        invalidateClientsForDevice: vi.fn(() => order.push("invalidate")),
        disconnectClientsForDevice: vi.fn(() => order.push("disconnect")),
      });
      vi.mocked(opts.respond).mockImplementation(() => {
        order.push("respond");
      });
      try {
        const removal = expectDefined(deviceHandlers[method], method)(opts);
        if (callerRetired) {
          await expect(removal).rejects.toThrow("client authorization is no longer active");
          expect(opts.respond).not.toHaveBeenCalled();
        } else {
          await removal;
          expect(opts.respond).toHaveBeenCalledWith(
            true,
            revoking ? { deviceId: "device-1", role: "node", revokedAtMs: 456 } : removed,
            undefined,
          );
        }
        expect(reconcileActive).toHaveBeenCalledWith("environment-1");
        expect(order).toEqual([
          "invalidate",
          "environment",
          "placement",
          ...(callerRetired ? [] : ["respond"]),
          "disconnect",
        ]);
      } finally {
        policyResponse?.finish();
      }
    },
  );

  it.each(["device.pair.remove", "device.token.revoke"])(
    "tears down revoked clients when worker cleanup fails in %s",
    async (method) => {
      removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1" });
      revokeDeviceTokenMock.mockResolvedValue({
        ok: true,
        entry: { role: "node", revokedAtMs: 456 },
      });
      const opts = createOptions(
        method,
        { deviceId: "device-1", ...(method === "device.token.revoke" ? { role: "node" } : {}) },
        { client: createClient(["operator.admin"], "admin-device") },
      );
      const updateSurface = vi.spyOn(opts.context.nodeRegistry, "updateSurface");
      const workerEnvironmentService = {};
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("worker credential write failed");
      bindDeviceWorkerReconciliation(workerEnvironmentService, async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      });
      Object.assign(opts.context, { workerEnvironmentService });
      const mutation = expectDefined(deviceHandlers[method], method)(opts);
      try {
        await entered.promise;
        // Authority must end while cleanup is still pending on another owner.
        expect(opts.context.invalidateClientsForDevice).toHaveBeenCalledWith("device-1", {
          reason: method === "device.pair.remove" ? "device-pair-removed" : "device-token-revoked",
          ...(method === "device.token.revoke" ? { role: "node" } : {}),
        });
        expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
        release.resolve();
        await expect(mutation).rejects.toThrow(failure);
        expect(opts.context.disconnectClientsForDevice).toHaveBeenCalled();
        expect(updateSurface).toHaveBeenCalledWith("device-1", {
          caps: [],
          commands: [],
          permissions: undefined,
        });
        expect(opts.respond).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.resolve(mutation).catch(() => {});
      }
    },
  );

  it("does not disconnect clients when device removal fails", async () => {
    removePairedDeviceMock.mockResolvedValue(null);
    const opts = createOptions("device.pair.remove", { deviceId: "device-1" });

    await expectDefined(
      deviceHandlers["device.pair.remove"],
      'deviceHandlers["device.pair.remove"] test invariant',
    )(opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "unknown deviceId");
  });

  it("rejects removing another device from a non-admin device session", async () => {
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: "device-2" },
      { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
    );

    await expectDefined(
      deviceHandlers["device.pair.remove"],
      'deviceHandlers["device.pair.remove"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.remove"],
      'deviceHandlers["device.pair.remove"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.pair.remove"],
      'deviceHandlers["device.pair.remove"] test invariant',
    )(opts);

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
      await expectDefined(
        deviceHandlers["device.token.revoke"],
        'deviceHandlers["device.token.revoke"] test invariant',
      )(opts);
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

    await expectDefined(
      deviceHandlers["device.token.revoke"],
      'deviceHandlers["device.token.revoke"] test invariant',
    )(opts);

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
      await expectDefined(
        deviceHandlers["device.token.revoke"],
        'deviceHandlers["device.token.revoke"] test invariant',
      )(opts);
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

    await expectDefined(
      deviceHandlers["device.token.revoke"],
      'deviceHandlers["device.token.revoke"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.token.rotate"],
      'deviceHandlers["device.token.rotate"] test invariant',
    )(opts);
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
        tokenDelivery: "withheld-cross-device",
      },
      undefined,
    );
  });

  it.each(["device.token.rotate", "device.token.revoke"] as const)(
    "invalidates an in-flight node wake after %s",
    async (method) => {
      const mutation =
        method === "device.token.rotate" ? rotateDeviceTokenMock : revokeDeviceTokenMock;
      mutation.mockResolvedValue({
        ok: true,
        entry:
          method === "device.token.rotate"
            ? {
                token: "new-node-token",
                role: "node",
                scopes: [],
                createdAtMs: 456,
                rotatedAtMs: 789,
              }
            : { role: "node", revokedAtMs: 789 },
      });
      const lifecycle = captureNodeWakeLifecycle("device-1");
      const opts = createOptions(
        method,
        { deviceId: "device-1", role: "node" },
        { client: createClient(["operator.admin"], "admin-device", { isDeviceTokenAuth: true }) },
      );

      await expectDefined(deviceHandlers[method], method)(opts);

      expect(lifecycle.aborted).toBe(true);
    },
  );

  it("keeps node wake ownership across unrelated operator token rotation", async () => {
    mockRotateOperatorTokenSuccess();
    const lifecycle = captureNodeWakeLifecycle("device-1");
    const opts = createOptions("device.token.rotate", {
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.pairing"],
    });

    await expectDefined(
      deviceHandlers["device.token.rotate"],
      'deviceHandlers["device.token.rotate"] test invariant',
    )(opts);

    expect(lifecycle.aborted).toBe(false);
    releaseNodeWakeLifecycle("device-1", lifecycle);
  });

  it.each(["device.token.rotate", "device.token.revoke"] as const)(
    "invalidates affected clients synchronously before responding to %s",
    async (method) => {
      const rotating = method === "device.token.rotate";
      if (rotating) {
        mockPairedOperatorDevice();
        mockRotateOperatorTokenSuccess();
      } else {
        revokeDeviceTokenMock.mockResolvedValue({
          ok: true,
          entry: { role: "operator", revokedAtMs: 456 },
        });
      }
      const opts = createOptions(
        method,
        {
          deviceId: "device-1",
          role: "operator",
          ...(rotating ? { scopes: ["operator.pairing"] } : {}),
        },
        { client: createClient(["operator.pairing"], "device-1", { isDeviceTokenAuth: true }) },
      );
      const respond = vi.mocked(opts.respond);
      const invalidate = vi.mocked(opts.context.invalidateClientsForDevice!);
      const disconnect = vi.mocked(opts.context.disconnectClientsForDevice!);

      respond.mockImplementation(() => {
        expect(invalidate).toHaveBeenCalledWith("device-1", {
          role: "operator",
          reason: rotating ? "device-token-rotated" : "device-token-revoked",
        });
        expect(disconnect).not.toHaveBeenCalled();
      });

      await expectDefined(deviceHandlers[method], method)(opts);
      await Promise.resolve();

      expect(respond).toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledWith("device-1", { role: "operator" });
    },
  );

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

    await expectDefined(
      deviceHandlers["device.token.rotate"],
      'deviceHandlers["device.token.rotate"] test invariant',
    )(opts);

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
        tokenDelivery: "in-band",
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

    await expectDefined(
      deviceHandlers["device.token.rotate"],
      'deviceHandlers["device.token.rotate"] test invariant',
    )(rotateOpts);
    await expectDefined(
      deviceHandlers["device.token.revoke"],
      'deviceHandlers["device.token.revoke"] test invariant',
    )(revokeOpts);

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
        tokenDelivery: "in-band",
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

    await expectDefined(
      deviceHandlers["device.token.rotate"],
      'deviceHandlers["device.token.rotate"] test invariant',
    )(opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.pairing"],
        rotatedAtMs: 789,
        tokenDelivery: "withheld-cross-device",
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

    await expectDefined(
      deviceHandlers["device.token.rotate"],
      'deviceHandlers["device.token.rotate"] test invariant',
    )(opts);

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "node",
      scopes: undefined,
      callerScopes: undefined,
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

    await expectDefined(
      deviceHandlers["device.token.rotate"],
      'deviceHandlers["device.token.rotate"] test invariant',
    )(opts);

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

    await expectDefined(
      deviceHandlers["device.token.revoke"],
      'deviceHandlers["device.token.revoke"] test invariant',
    )(opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectRespondedErrorMessage(opts, "device token revocation denied");
  });
});
