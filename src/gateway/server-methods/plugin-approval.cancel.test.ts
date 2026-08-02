import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createManager() {
  return new ExecApprovalManager<PluginApprovalRequestPayload>({ approvalKind: "plugin" });
}

function createContext(params?: {
  approvalEvents?: GatewayRequestHandlerOptions["context"]["approvalEvents"];
}): GatewayRequestHandlerOptions["context"] {
  return {
    broadcast: vi.fn(),
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    hasExecApprovalClients: () => true,
    approvalEvents: params?.approvalEvents,
  } as unknown as GatewayRequestHandlerOptions["context"];
}

function createClient(params?: {
  connId?: string;
  clientId?: string;
  deviceId?: string;
  instanceId?: string;
  approvalRuntime?: boolean;
}): GatewayRequestHandlerOptions["client"] {
  return {
    connId: params?.connId ?? "conn-test-client",
    connect: {
      client: {
        id: params?.clientId ?? "test-client",
        displayName: "Test Client",
        instanceId: params?.instanceId,
      },
      ...(params?.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params?.approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
  method = "plugin.approval.cancel",
): GatewayRequestHandlerOptions {
  return {
    req: { method, params, id: "req-1" },
    params,
    client: createClient(),
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: createContext(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function responseCall(opts: GatewayRequestHandlerOptions) {
  const call = vi.mocked(opts.respond).mock.calls[0];
  if (!call) {
    throw new Error("expected response");
  }
  return { ok: call[0], result: call[1], error: call[2] };
}

function expectResponseOk(opts: GatewayRequestHandlerOptions) {
  const response = responseCall(opts);
  expect(response.ok).toBe(true);
  expect(response.error).toBeUndefined();
  return response.result;
}

function registerApproval(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  id: string,
  owner = "owner",
  runtimeRequestId = `request-${owner}`,
) {
  const record = manager.create({ title: "T", description: "D" }, 60_000, id);
  record.requestedByDeviceId = `device-${owner}`;
  record.requestedByConnId = `conn-${owner}`;
  record.requestedByClientId = `client-${owner}`;
  record.requestedByInstanceId = `runtime-${owner}`;
  record.requestedByRuntimeRequestId = runtimeRequestId;
  void manager.register(record, 60_000);
  return record;
}

describe("plugin.approval.cancel", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects invalid params", async () => {
    const handler = createPluginApprovalHandlers(manager)["plugin.approval.cancel"];
    const opts = createOptions({ id: "" });

    await expectDefined(handler, "plugin.approval.cancel handler")(opts);

    expect(responseCall(opts).error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("invalid plugin.approval.cancel params"),
    });
  });

  it("fails closed for non-internal clients", async () => {
    const handler = createPluginApprovalHandlers(manager)["plugin.approval.cancel"];
    const record = registerApproval(manager, "plugin:public-cancel");
    const opts = createOptions({ id: record.id });

    await expectDefined(handler, "plugin.approval.cancel handler")(opts);

    expect(responseCall(opts).error).toMatchObject({
      code: "FORBIDDEN",
      message: "plugin approval cancellation is internal-only",
    });
    expect(manager.getSnapshot(record.id)?.resolvedAtMs).toBeUndefined();
  });

  it("cancels one approval and publishes its terminal resolution", async () => {
    const handlePluginApprovalResolved = vi.fn(async () => {});
    const handleResolved = vi.fn(async () => {});
    const publishResolved = vi.fn();
    const handlers = createPluginApprovalHandlers(manager, {
      forwarder: { handlePluginApprovalResolved } as never,
      iosPushDelivery: { handleResolved },
    });
    const handler = handlers["plugin.approval.cancel"];
    const record = registerApproval(manager, "plugin:cancel-one");
    const decisionPromise = manager.awaitDecision(record.id);
    const context = createContext({ approvalEvents: { publishResolved } as never });
    const opts = createOptions(
      { id: record.id },
      {
        client: createClient({
          connId: "conn-runtime",
          clientId: "approval-runtime",
          instanceId: "runtime-owner",
          approvalRuntime: true,
        }),
        context,
      },
    );

    await expectDefined(handler, "plugin.approval.cancel handler")(opts);

    expect(expectResponseOk(opts)).toEqual({ ok: true, cancelled: 1 });
    await expect(decisionPromise).resolves.toBeNull();
    expect(manager.getSnapshot(record.id)).toMatchObject({
      status: "cancelled",
      terminalReason: "run-aborted",
      resolvedBy: "Test Client",
    });
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    expect(context.broadcast).toHaveBeenCalledWith(
      "plugin.approval.resolved",
      expect.objectContaining({
        id: record.id,
        decision: "deny",
        status: "cancelled",
        terminalReason: "run-aborted",
        resolvedBy: "Test Client",
        request: record.request,
      }),
      { dropIfSlow: true },
    );
    expect(publishResolved).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining({
        id: record.id,
        decision: "deny",
        status: "cancelled",
        terminalReason: "run-aborted",
      }),
    );
    expect(handlePluginApprovalResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        id: record.id,
        decision: "deny",
        status: "cancelled",
        terminalReason: "run-aborted",
      }),
    );
    expect(handleResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        id: record.id,
        decision: "deny",
        status: "cancelled",
        terminalReason: "run-aborted",
      }),
    );
    const duplicateRequestOpts = createOptions(
      {
        title: "Duplicate cancelled request",
        description: "Must remain cancelled",
        runtimeRequestId: record.requestedByRuntimeRequestId,
        twoPhase: true,
      },
      { client: opts.client, respond: vi.fn() },
      "plugin.approval.request",
    );
    await expectDefined(
      handlers["plugin.approval.request"],
      "plugin.approval.request handler",
    )(duplicateRequestOpts);
    expect(responseCall(duplicateRequestOpts).error).toMatchObject({
      code: "UNAVAILABLE",
      message: "plugin approval request cancelled",
    });
  });

  it("cancels only the exact runtime request before its approval id is known", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const handler = handlers["plugin.approval.cancel"];
    const owned = registerApproval(manager, "plugin:owned-cancel", "owner", "request-owned");
    const other = registerApproval(manager, "plugin:other-cancel", "owner", "request-other");
    const opts = createOptions(
      { runtimeRequestId: "request-owned" },
      {
        client: createClient({
          connId: "conn-owner",
          clientId: "approval-runtime",
          instanceId: "runtime-owner",
          approvalRuntime: true,
        }),
      },
    );

    await expectDefined(handler, "plugin.approval.cancel handler")(opts);

    expect(expectResponseOk(opts)).toEqual({ ok: true, cancelled: 1 });
    expect(manager.getSnapshot(owned.id)).toMatchObject({
      status: "cancelled",
      terminalReason: "run-aborted",
    });
    expect(manager.getSnapshot(other.id)?.resolvedAtMs).toBeUndefined();
    const duplicateRequestOpts = createOptions(
      {
        title: "Duplicate cancelled request",
        description: "Must remain cancelled",
        runtimeRequestId: "request-owned",
        twoPhase: true,
      },
      { client: opts.client, respond: vi.fn() },
      "plugin.approval.request",
    );
    await expectDefined(
      handlers["plugin.approval.request"],
      "plugin.approval.request handler",
    )(duplicateRequestOpts);
    expect(responseCall(duplicateRequestOpts).error).toMatchObject({
      code: "UNAVAILABLE",
      message: "plugin approval request cancelled",
    });
  });

  it("prevents repeated delivery of a cancelled runtime request from registering later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
    const handlers = createPluginApprovalHandlers(manager);
    const client = createClient({
      clientId: "approval-runtime",
      instanceId: "runtime-owner",
      approvalRuntime: true,
    });
    const cancelOpts = createOptions(
      { runtimeRequestId: "request-before-registration" },
      { client },
    );

    await expectDefined(
      handlers["plugin.approval.cancel"],
      "plugin.approval.cancel handler",
    )(cancelOpts);
    expect(expectResponseOk(cancelOpts)).toEqual({ ok: true, cancelled: 0 });
    await vi.advanceTimersByTimeAsync(610_000);

    const requestParams = {
      title: "Cancelled request",
      description: "Must not become pending",
      runtimeRequestId: "request-before-registration",
      twoPhase: true,
    };
    const requestHandler = expectDefined(
      handlers["plugin.approval.request"],
      "plugin.approval.request handler",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestOpts = createOptions(
        requestParams,
        { client, respond: vi.fn() },
        "plugin.approval.request",
      );
      await requestHandler(requestOpts);
      expect(responseCall(requestOpts).error).toMatchObject({
        code: "UNAVAILABLE",
        message: "plugin approval request cancelled",
      });
    }
    expect(manager.listPendingRecords()).toEqual([]);
  });

  it("fails closed only for the runtime whose cancellation tracking saturates", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const cancelHandler = expectDefined(
      handlers["plugin.approval.cancel"],
      "plugin.approval.cancel handler",
    );
    const ownerClient = createClient({
      clientId: "approval-runtime",
      instanceId: "runtime-owner",
      approvalRuntime: true,
    });

    for (let index = 0; index <= 1_024; index += 1) {
      const cancelOpts = createOptions(
        { runtimeRequestId: `request-${index}` },
        {
          client: ownerClient,
        },
      );
      await cancelHandler(cancelOpts);
      expect(expectResponseOk(cancelOpts)).toEqual({ ok: true, cancelled: 0 });
    }

    const requestHandler = expectDefined(
      handlers["plugin.approval.request"],
      "plugin.approval.request handler",
    );
    const ownerRequestOpts = createOptions(
      {
        title: "Owner request after cancellation saturation",
        description: "Must fail closed",
        runtimeRequestId: "owner-request-after-saturation",
        twoPhase: true,
      },
      { client: ownerClient, respond: vi.fn() },
      "plugin.approval.request",
    );
    await requestHandler(ownerRequestOpts);
    expect(responseCall(ownerRequestOpts).error).toMatchObject({
      code: "UNAVAILABLE",
      message: "plugin approval request cancelled",
    });

    const otherClient = createClient({
      clientId: "approval-runtime",
      instanceId: "runtime-other",
      approvalRuntime: true,
    });
    const otherContext = createContext();
    otherContext.hasExecApprovalClients = () => false;
    const otherRequestOpts = createOptions(
      {
        title: "Request after cancellation saturation",
        description: "Must remain isolated",
        runtimeRequestId: "unrelated-request",
        twoPhase: true,
      },
      { client: otherClient, context: otherContext, respond: vi.fn() },
      "plugin.approval.request",
    );
    await requestHandler(otherRequestOpts);
    expect(expectResponseOk(otherRequestOpts)).toMatchObject({
      decision: null,
    });
    expect(manager.listPendingRecords()).toEqual([]);
  });

  it("bounds cancellation tracking across runtime instance ids", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const cancelHandler = expectDefined(
      handlers["plugin.approval.cancel"],
      "plugin.approval.cancel handler",
    );
    const requestHandler = expectDefined(
      handlers["plugin.approval.request"],
      "plugin.approval.request handler",
    );
    const cancelForRuntime = async (runtimeInstanceId: string) => {
      const opts = createOptions(
        { runtimeRequestId: `cancel-${runtimeInstanceId}` },
        {
          client: createClient({
            clientId: "approval-runtime",
            instanceId: runtimeInstanceId,
            approvalRuntime: true,
          }),
        },
      );
      await cancelHandler(opts);
      expect(expectResponseOk(opts)).toEqual({ ok: true, cancelled: 0 });
    };

    for (let index = 0; index < 1_024; index += 1) {
      await cancelForRuntime(`tracked-${index}`);
    }
    for (let index = 0; index < 1_024; index += 1) {
      await cancelForRuntime(`saturated-${index}`);
    }
    await cancelForRuntime("overflow");

    const requestForRuntime = async (runtimeInstanceId: string, runtimeRequestId: string) => {
      const context = createContext();
      context.hasExecApprovalClients = () => false;
      const opts = createOptions(
        {
          title: "Request after runtime cancellation saturation",
          description: "Must follow the bounded fail-closed state",
          runtimeRequestId,
          twoPhase: true,
        },
        {
          client: createClient({
            clientId: "approval-runtime",
            instanceId: runtimeInstanceId,
            approvalRuntime: true,
          }),
          context,
          respond: vi.fn(),
        },
        "plugin.approval.request",
      );
      await requestHandler(opts);
      return responseCall(opts);
    };

    expect(await requestForRuntime("tracked-0", "unrelated")).toMatchObject({
      result: { decision: null },
    });
    expect(await requestForRuntime("saturated-0", "unrelated")).toMatchObject({
      error: {
        code: "UNAVAILABLE",
        message: "plugin approval request cancelled",
      },
    });
    expect(await requestForRuntime("unknown", "unrelated")).toMatchObject({
      error: {
        code: "UNAVAILABLE",
        message: "plugin approval request cancelled",
      },
    });
  });

  it("does not cancel an approval owned by another runtime instance", async () => {
    const handler = createPluginApprovalHandlers(manager)["plugin.approval.cancel"];
    const record = registerApproval(manager, "plugin:foreign-cancel");
    const opts = createOptions(
      { id: record.id },
      {
        client: createClient({
          clientId: "approval-runtime",
          instanceId: "runtime-other",
          approvalRuntime: true,
        }),
      },
    );

    await expectDefined(handler, "plugin.approval.cancel handler")(opts);

    expect(expectResponseOk(opts)).toEqual({ ok: true, cancelled: 0 });
    expect(manager.getSnapshot(record.id)?.resolvedAtMs).toBeUndefined();
  });

  it("does not grant cancellation ownership without a runtime instance id", async () => {
    const handler = createPluginApprovalHandlers(manager)["plugin.approval.cancel"];
    const record = registerApproval(manager, "plugin:missing-instance-cancel");
    const opts = createOptions(
      { id: record.id },
      {
        client: createClient({
          clientId: "approval-runtime",
          approvalRuntime: true,
        }),
      },
    );

    await expectDefined(handler, "plugin.approval.cancel handler")(opts);

    expect(expectResponseOk(opts)).toEqual({ ok: true, cancelled: 0 });
    expect(manager.getSnapshot(record.id)?.resolvedAtMs).toBeUndefined();
  });

  it("is idempotent after the approval is terminal", async () => {
    const handler = createPluginApprovalHandlers(manager)["plugin.approval.cancel"];
    const record = registerApproval(manager, "plugin:cancel-idempotent");
    const client = createClient({
      instanceId: "runtime-owner",
      approvalRuntime: true,
    });
    const context = createContext();

    for (const expectedCancelled of [1, 0]) {
      const opts = createOptions({ id: record.id }, { client, context });
      await expectDefined(handler, "plugin.approval.cancel handler")(opts);
      expect(expectResponseOk(opts)).toEqual({ ok: true, cancelled: expectedCancelled });
    }

    expect(context.broadcast).toHaveBeenCalledTimes(1);
  });
});
