/**
 * Tests shared approval helpers used by gateway method handlers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  bindApprovalReviewerDeviceIds,
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  isApprovalRecordVisibleToClient,
  registerPendingApprovalRecord,
} from "./approval-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

type ApprovalClientLookup = NonNullable<GatewayRequestContext["getApprovalClientConnIds"]>;

function createApprovalClient(params: {
  connId: string;
  clientId: string;
  deviceId?: string;
  scopes?: string[];
  approvalRuntime?: boolean;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: params.clientId },
      device: params.deviceId ? { id: params.deviceId } : undefined,
      scopes: params.scopes ?? ["operator.approvals"],
    },
    ...(params.approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
  } as GatewayClient;
}

function createApprovalClientLookup(clients: GatewayClient[]): ApprovalClientLookup {
  return (opts = {}) =>
    new Set(
      clients
        .filter((client) => {
          if (opts.excludeConnId && client.connId === opts.excludeConnId) {
            return false;
          }
          return opts.filter?.(client, opts.record) ?? true;
        })
        .map((client) => client.connId)
        .filter((connId): connId is string => typeof connId === "string" && connId.length > 0),
    );
}

describe("handlePendingApprovalRequest", () => {
  afterEach(() => {
    hasApprovalTurnSourceRouteMock.mockClear();
  });

  it("allows operator.admin clients to see requester-bound approvals", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-admin-visible",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-admin",
          clientId: "client-admin",
          deviceId: "device-admin",
          scopes: ["operator.admin"],
        }),
      }),
    ).toBe(true);
  });

  it("does not allow approval-scoped clients to see no-device gateway-client approvals from another connection", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-client-visible",
    );
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(false);
  });

  it.each([
    ["Control UI", GATEWAY_CLIENT_IDS.CONTROL_UI],
    ["WebChat UI", GATEWAY_CLIENT_IDS.WEBCHAT_UI],
    ["WebChat", GATEWAY_CLIENT_IDS.WEBCHAT],
  ])(
    "does not allow approval-scoped clients to see no-device %s approvals from another connection",
    (_label, clientId) => {
      const manager = new ExecApprovalManager();
      const record = manager.create(
        {
          command: "echo ok",
        },
        60_000,
        `approval-${clientId}-visible`,
      );
      record.requestedByConnId = "conn-browser-ui";
      record.requestedByClientId = clientId;

      expect(
        isApprovalRecordVisibleToClient({
          record,
          client: createApprovalClient({
            connId: "conn-mobile",
            clientId: GATEWAY_CLIENT_IDS.IOS_APP,
            scopes: ["operator.approvals"],
          }),
        }),
      ).toBe(false);
    },
  );

  it("does not allow approval-scoped clients to see device-bound gateway-client approvals from another device", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-device-visible",
    );
    record.requestedByDeviceId = "device-gateway";
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          deviceId: "device-mobile",
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(false);
  });

  it("allows approval-scoped reviewer devices to see approvals requested by the backend runtime", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-reviewer-device-visible",
    );
    record.requestedByDeviceId = "device-gateway-runtime";
    record.requestedByConnId = "conn-gateway-runtime";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    bindApprovalReviewerDeviceIds({
      record,
      deviceIds: [" device-mobile ", "device-mobile"],
    });

    expect(record.approvalReviewerDeviceIds).toEqual(["device-mobile"]);
    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          deviceId: "device-mobile",
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(true);
  });

  it("does not allow reviewer devices without approval scope to see approvals", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-reviewer-device-scope-hidden",
    );
    record.requestedByDeviceId = "device-gateway-runtime";
    record.requestedByConnId = "conn-gateway-runtime";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    bindApprovalReviewerDeviceIds({ record, deviceIds: ["device-mobile"] });

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          deviceId: "device-mobile",
          scopes: ["operator.read"],
        }),
      }),
    ).toBe(false);
  });

  it("does not widen explicitly reviewer-bound approvals to another device", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-reviewer-device-isolated",
    );
    bindApprovalReviewerDeviceIds({ record, deviceIds: ["device-mobile"] });

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-other",
          clientId: GATEWAY_CLIENT_IDS.IOS_APP,
          deviceId: "device-other",
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(false);
  });

  it("allows gateway-client approval runtimes to see requester-bound approvals", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-delivery-runtime-visible",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-delivery-runtime",
          clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          scopes: ["operator.approvals"],
          approvalRuntime: true,
        }),
      }),
    ).toBe(true);
  });

  it("does not trust gateway-client ids without the approval runtime marker", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-delivery-runtime-spoof-hidden",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-spoofed-runtime",
          clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(false);
  });

  it("does not widen non-gateway no-device approvals to matching client ids", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-other-client-hidden",
    );
    record.requestedByConnId = "conn-requester";
    record.requestedByClientId = "client-owner";

    expect(
      isApprovalRecordVisibleToClient({
        record,
        client: createApprovalClient({
          connId: "conn-mobile",
          clientId: "client-owner",
          scopes: ["operator.approvals"],
        }),
      }),
    ).toBe(false);
  });

  it("reports an active approval client instead of the manual turn-source route", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
        turnSourceChannel: "feishu",
        turnSourceAccountId: "work",
      },
      60_000,
      "approval-with-client",
    );
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => true,
      } as unknown as GatewayRequestContext,
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(hasApprovalTurnSourceRouteMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        id: "approval-with-client",
        status: "accepted",
        deliveryRoute: "approval-client",
      }),
      undefined,
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("checks plugin turn-source routes with plugin approval kind", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "plugin approval",
        turnSourceChannel: "whatsapp",
        turnSourceAccountId: "default",
      },
      60_000,
      "plugin-turn-source-kind",
    );
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => false,
      } as unknown as GatewayRequestContext,
      requestEventName: "plugin.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      approvalKind: "plugin",
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(hasApprovalTurnSourceRouteMock).toHaveBeenCalledWith({
      turnSourceChannel: "whatsapp",
      turnSourceAccountId: "default",
      approvalKind: "plugin",
    });

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("targets requested approval events to visible approval clients when available", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-visible",
    );
    record.requestedByDeviceId = "device-owner";
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-owner-approval"]);
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-owner-approval",
              clientId: "client-owner",
              deviceId: "device-owner",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: "client-other",
              deviceId: "device-other",
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-requester",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-visible" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("routes backend-runtime approval events to the authorized approval reviewer device", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-reviewer-device-event",
    );
    record.requestedByDeviceId = "device-gateway-runtime";
    record.requestedByConnId = "conn-gateway-runtime";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    bindApprovalReviewerDeviceIds({ record, deviceIds: ["device-mobile"] });
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-mobile-approval"]);
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-mobile",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-other",
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-gateway-runtime",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-reviewer-device-event" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("targets requester-bound approval events to gateway-client approval runtimes", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-delivery-runtime",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-delivery-runtime"]);
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-delivery-runtime",
              clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
              approvalRuntime: true,
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-other",
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-owner",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-delivery-runtime" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });

  it("does not target no-device gateway-client approvals to unrelated approval-scoped clients", async () => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-mobile",
    );
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set<string>();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-gateway",
              clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
            }),
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-gateway",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-gateway-mobile" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    await requestPromise;
    expect(manager.getSnapshot(record.id)?.resolvedBy).toBe("no-approval-route");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-gateway-mobile", decision: null }),
      undefined,
    );
  });

  it("returns a concurrent first answer when no-route denial loses after delivery", async () => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-no-route-race",
    );
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    let finishDelivery!: (delivered: boolean) => void;
    const delivery = new Promise<boolean>((resolve) => {
      finishDelivery = resolve;
    });
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => false,
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-requester",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => delivery,
    });

    await Promise.resolve();
    expect(manager.resolve(record.id, "allow-once", "control-ui")).toBe(true);
    finishDelivery(false);
    await requestPromise;

    expect(manager.getSnapshot(record.id)).toMatchObject({
      decision: "allow-once",
      resolvedBy: "control-ui",
    });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: record.id, decision: "allow-once" }),
      undefined,
    );
  });

  it("retains a concurrent approval binding through a delayed requester handoff", async () => {
    vi.useFakeTimers();
    try {
      const manager = new ExecApprovalManager();
      const record = manager.create(
        {
          command: "echo ok",
        },
        60_000,
        "approval-delayed-handoff",
      );
      const decisionPromise = manager.register(record, 60_000);
      const respond = vi.fn();
      let finishDelivery!: (delivered: boolean) => void;
      const delivery = new Promise<boolean>((resolve) => {
        finishDelivery = resolve;
      });
      const requestPromise = handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context: {
          broadcast: vi.fn(),
          hasExecApprovalClients: () => false,
        } as unknown as GatewayRequestContext,
        requestEventName: "exec.approval.requested",
        requestEvent: {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        twoPhase: true,
        deliverRequest: () => delivery,
      });

      await Promise.resolve();
      expect(manager.resolve(record.id, "allow-once", "control-ui")).toBe(true);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(manager.getLiveSnapshot(record.id)).toMatchObject({
        decision: "allow-once",
        resolvedBy: "control-ui",
      });

      finishDelivery(true);
      await requestPromise;
      expect(respond).toHaveBeenLastCalledWith(
        true,
        expect.objectContaining({ id: record.id, decision: "allow-once" }),
        undefined,
      );
      expect(manager.getLiveSnapshot(record.id)).not.toBeNull();

      await vi.advanceTimersByTimeAsync(14_999);
      expect(manager.getLiveSnapshot(record.id)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getLiveSnapshot(record.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps register-only approval requests pending without a delivery route", async () => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-register-only",
    );
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => false,
      } as unknown as GatewayRequestContext,
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      requireDeliveryRoute: false,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(manager.getSnapshot(record.id)?.resolvedAtMs).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-register-only", status: "accepted" }),
      undefined,
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
    expect(manager.getSnapshot(record.id)?.resolvedBy).not.toBe("no-approval-route");
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ id: "approval-register-only", decision: "allow-once" }),
      undefined,
    );
  });

  it("does not target no-device browser UI approvals to unrelated approval-scoped clients", async () => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-control-ui-mobile",
    );
    record.requestedByConnId = "conn-control-ui";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.CONTROL_UI;
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set<string>();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-control-ui",
              clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
            }),
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-control-ui",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-control-ui-mobile" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    await requestPromise;
    expect(manager.getSnapshot(record.id)?.resolvedBy).toBe("no-approval-route");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-control-ui-mobile", decision: null }),
      undefined,
    );
  });

  it("does not target device-bound gateway-client approvals to unrelated approval-scoped clients", async () => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-device-mobile",
    );
    record.requestedByDeviceId = "device-gateway";
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set<string>();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-gateway",
              clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
              deviceId: "device-gateway",
            }),
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-mobile",
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-gateway",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-gateway-device-mobile" }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    await requestPromise;
    expect(manager.getSnapshot(record.id)?.resolvedBy).toBe("no-approval-route");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-gateway-device-mobile", decision: null }),
      undefined,
    );
  });

  it("does not target no-device approvals by self-declared client id", async () => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-no-device",
    );
    record.requestedByConnId = "conn-requester";
    record.requestedByClientId = "client-owner";
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set<string>();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-requester",
              clientId: "client-owner",
            }),
            createApprovalClient({
              connId: "conn-owner-approval",
              clientId: "client-owner",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: "client-other",
            }),
          ]),
        ),
        hasExecApprovalClients: vi.fn(() => {
          throw new Error("expected visibility-filtered approval client lookup");
        }),
      } as unknown as GatewayRequestContext,
      clientConnId: "conn-requester",
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.requested",
      expect.objectContaining({ id: "approval-no-device" }),
      visibleConnIds,
      { dropIfSlow: true },
    );
    await requestPromise;
    expect(manager.getSnapshot(record.id)?.resolvedBy).toBe("no-approval-route");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-no-device", decision: null }),
      undefined,
    );
  });

  it("does not resolve no-device approvals by self-declared client id", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-no-device-resolve",
    );
    record.requestedByConnId = "conn-requester";
    record.requestedByClientId = "client-owner";
    void manager.register(record, 60_000);
    const respond = vi.fn();

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-other",
        clientId: "client-owner",
        scopes: ["operator.approvals"],
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
  });

  it("does not wait on decisions for approvals hidden from the caller", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-wait-hidden",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    void manager.register(record, 60_000);
    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    const respond = vi.fn();

    await handleApprovalWaitDecision({
      manager,
      inputId: record.id,
      respond,
      client: createApprovalClient({
        connId: "conn-other",
        clientId: "client-other",
        deviceId: "device-other",
        scopes: ["operator.approvals"],
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "approval expired or not found",
      }),
    );
  });

  it("allows visible callers to wait for approval decisions", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-wait-visible",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    void manager.register(record, 60_000);
    expect(manager.resolve(record.id, "deny")).toBe(true);
    const respond = vi.fn();

    await handleApprovalWaitDecision({
      manager,
      inputId: record.id,
      respond,
      client: createApprovalClient({
        connId: "conn-owner-approval",
        clientId: "client-owner",
        deviceId: "device-owner",
        scopes: ["operator.approvals"],
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        id: "approval-wait-visible",
        decision: "deny",
      }),
      undefined,
    );
  });

  it("does not allow approval-scoped clients to resolve no-device gateway-client approvals from another connection", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-resolve",
    );
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    void manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-mobile-approval",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        scopes: ["operator.approvals"],
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
  });

  it("does not allow approval-scoped clients to resolve no-device browser UI approvals from another connection", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-control-ui-resolve",
    );
    record.requestedByConnId = "conn-control-ui";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.CONTROL_UI;
    void manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-mobile-approval",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        scopes: ["operator.approvals"],
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
  });

  it("does not allow approval-scoped clients to resolve device-bound gateway-client approvals from another device", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-gateway-device-resolve",
    );
    record.requestedByDeviceId = "device-gateway";
    record.requestedByConnId = "conn-gateway";
    record.requestedByClientId = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    void manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-mobile-approval",
              clientId: GATEWAY_CLIENT_IDS.IOS_APP,
              deviceId: "device-mobile",
              scopes: ["operator.approvals"],
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-mobile-approval",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        deviceId: "device-mobile",
        scopes: ["operator.approvals"],
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
  });

  it("allows gateway-client approval runtimes to resolve requester-bound approvals", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-delivery-runtime-resolve",
    );
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    void manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-delivery-runtime",
              clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
              scopes: ["operator.approvals"],
              approvalRuntime: true,
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-delivery-runtime",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        scopes: ["operator.approvals"],
        approvalRuntime: true,
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(manager.getSnapshot(record.id)?.decision).toBe("allow-once");
  });

  it("targets resolved approval events to visible approval clients when available", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
      },
      60_000,
      "approval-resolved-visible",
    );
    record.requestedByDeviceId = "device-owner";
    void manager.register(record, 60_000);
    const respond = vi.fn();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const visibleConnIds = new Set(["conn-owner-approval"]);

    await handleApprovalResolve({
      manager,
      inputId: record.id,
      decision: "allow-once",
      respond,
      context: {
        broadcast,
        broadcastToConnIds,
        getApprovalClientConnIds: vi.fn(
          createApprovalClientLookup([
            createApprovalClient({
              connId: "conn-owner-approval",
              clientId: "client-owner",
              deviceId: "device-owner",
            }),
            createApprovalClient({
              connId: "conn-other-approval",
              clientId: "client-other",
              deviceId: "device-other",
            }),
          ]),
        ),
      } as unknown as GatewayRequestContext,
      client: createApprovalClient({
        connId: "conn-owner-approval",
        clientId: "client-owner",
        deviceId: "device-owner",
      }),
      resolvedEventName: "exec.approval.resolved",
      buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
        id: approvalId,
        decision,
        request: snapshot.request,
      }),
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.resolved",
      expect.objectContaining({ id: "approval-resolved-visible" }),
      visibleConnIds,
      { dropIfSlow: true },
    );
  });

  it("sanitizes durable registration failures while retaining server diagnostics", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-register-failure-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    fs.mkdirSync(databasePath);
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-register-failure",
        databaseOptions: { path: databasePath },
      },
    });
    const record = manager.create({ command: "echo safe" }, 60_000, "registration-failure");
    const respond = vi.fn();
    const logError = vi.fn();

    try {
      expect(
        registerPendingApprovalRecord({
          manager,
          record,
          timeoutMs: 60_000,
          respond,
          context: { logGateway: { error: logError } } as unknown as GatewayRequestContext,
        }),
      ).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "approval request unavailable" }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
      expect(logError).toHaveBeenCalledTimes(1);
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("sanitizes a no-route storage failure while failing the waiter closed", async () => {
    hasApprovalTurnSourceRouteMock.mockReturnValueOnce(false);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-route-failure-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-route-failure",
        databaseOptions: { path: databasePath },
      },
    });
    const record = manager.create({ command: "echo safe" }, 60_000, "route-failure");
    const decisionPromise = manager.register(record, 60_000);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(databasePath, { force: true });
    fs.mkdirSync(databasePath);
    const respond = vi.fn();
    const logError = vi.fn();

    try {
      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context: {
          broadcast: vi.fn(),
          hasExecApprovalClients: () => false,
          logGateway: { error: logError },
        } as unknown as GatewayRequestContext,
        requestEventName: "exec.approval.requested",
        requestEvent: {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        twoPhase: true,
        deliverRequest: () => false,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "approval request unavailable" }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
      expect(logError).toHaveBeenCalledTimes(1);
      await expect(decisionPromise).resolves.toBe("deny");
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("sanitizes durable resolve failures while failing the waiter closed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-resolve-failure-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "approval-shared-resolve-failure",
        databaseOptions: { path: databasePath },
      },
    });
    const record = manager.create({ command: "echo safe" }, 60_000, "resolve-failure");
    const decisionPromise = manager.register(record, 60_000);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(databasePath, { force: true });
    fs.mkdirSync(databasePath);
    const respond = vi.fn();
    const logError = vi.fn();

    try {
      await handleApprovalResolve({
        manager,
        inputId: record.id,
        decision: "deny",
        respond,
        context: {
          broadcast: vi.fn(),
          broadcastToConnIds: vi.fn(),
          logGateway: { error: logError },
        } as unknown as GatewayRequestContext,
        client: null,
        resolvedEventName: "exec.approval.resolved",
        buildResolvedEvent: ({ approvalId, decision, snapshot }) => ({
          id: approvalId,
          decision,
          request: snapshot.request,
        }),
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "approval resolve unavailable" }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain(databasePath);
      expect(logError).toHaveBeenCalledTimes(1);
      await expect(decisionPromise).resolves.toBe("deny");
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
