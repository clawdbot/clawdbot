// Plugin approval tests cover requested/resolved plugin approval events,
// requester visibility, broadcast behavior, and approval manager integration.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createManager() {
  return new ExecApprovalManager<PluginApprovalRequestPayload>();
}

function createLogGatewayMock() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

function createApprovalContext(
  params: {
    broadcast?: ReturnType<typeof vi.fn>;
    hasExecApprovalClients?: GatewayRequestHandlerOptions["context"]["hasExecApprovalClients"];
  } = {},
): GatewayRequestHandlerOptions["context"] {
  return {
    broadcast: params.broadcast ?? vi.fn(),
    logGateway: createLogGatewayMock(),
    hasExecApprovalClients: params.hasExecApprovalClients ?? (() => true),
  } as unknown as GatewayRequestHandlerOptions["context"];
}

function createClient(
  params: {
    connId?: string;
    clientId?: string;
    displayName?: string;
    deviceId?: string;
    scopes?: string[];
    approvalRuntime?: boolean;
  } = {},
): GatewayRequestHandlerOptions["client"] {
  const connect: Record<string, unknown> = {
    client: {
      id: params.clientId ?? "test-client",
      displayName: params.displayName ?? "Test Client",
    },
  };
  if (params.deviceId) {
    connect.device = { id: params.deviceId };
  }
  if (params.scopes) {
    connect.scopes = params.scopes;
  }
  return {
    connId: params.connId ?? "conn-test-client",
    connect,
    ...(params.approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

function createMockOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { method, params, id: "req-1" },
    params,
    client: createClient(),
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: createApprovalContext(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function createNoExecApprovalContext(): GatewayRequestHandlerOptions["context"] {
  return createApprovalContext({ hasExecApprovalClients: () => false });
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function mockCall(source: unknown, index: number, label: string) {
  const call = (source as MockCallSource).mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call;
}

function responseCall(source: unknown, index = 0) {
  const call = mockCall(source, index, `response call ${index}`);
  return {
    ok: call[0],
    result: call[1],
    error: call[2],
  };
}

function responseResult(source: unknown, index = 0) {
  return requireRecord(responseCall(source, index).result, `response result ${index}`);
}

function responseError(source: unknown, index = 0) {
  return requireRecord(responseCall(source, index).error, `response error ${index}`);
}

function acceptedResult(source: unknown) {
  const callSource = source as MockCallSource;
  const call = Array.from(callSource.mock.calls).find((candidate) => {
    const result = candidate[1];
    return typeof result === "object" && result !== null && "status" in result
      ? (result as Record<string, unknown>).status === "accepted"
      : false;
  });
  if (!call) {
    throw new Error("Expected accepted response call");
  }
  return requireRecord(call[1], "accepted response result");
}

function acceptedApprovalId(source: unknown) {
  const id = acceptedResult(source).id;
  expect(id, "accepted approval id").toBeTypeOf("string");
  return id as string;
}

function expectResponseOk(source: unknown, index = 0) {
  const call = responseCall(source, index);
  expect(call.ok).toBe(true);
  expect(call.error).toBeUndefined();
  return requireRecord(call.result, `response result ${index}`);
}

function expectResponseRejected(source: unknown, index = 0) {
  expect(responseCall(source, index).ok).toBe(false);
  return responseError(source, index);
}

async function waitForAcceptedApproval(respond: unknown) {
  await vi.waitFor(() => {
    const accepted = acceptedResult(respond);
    expect(accepted.status).toBe("accepted");
    expect(accepted.id).toBeTypeOf("string");
  });
  return acceptedApprovalId(respond);
}

function createOwnedClient(owner: "owner" | "other" = "owner") {
  return createClient({
    connId: `conn-${owner}`,
    clientId: `client-${owner}`,
    deviceId: `device-${owner}`,
  });
}

function registerApproval(
  approvalManager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: {
    title?: string;
    description?: string;
    id?: string;
    allowedDecisions?: PluginApprovalRequestPayload["allowedDecisions"];
  } = {},
) {
  const request = {
    title: params.title ?? "T",
    description: params.description ?? "D",
    ...(params.allowedDecisions ? { allowedDecisions: params.allowedDecisions } : {}),
  };
  const record = params.id
    ? approvalManager.create(request, 60_000, params.id)
    : approvalManager.create(request, 60_000);
  void approvalManager.register(record, 60_000);
  return record;
}

function registerOwnedApproval(
  approvalManager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: { title: string; id?: string; owner?: "owner" | "other" },
) {
  const record = registerApproval(approvalManager, { title: params.title, id: params.id });
  const owner = params.owner ?? "owner";
  record.requestedByDeviceId = `device-${owner}`;
  record.requestedByConnId = `conn-${owner}`;
  record.requestedByClientId = `client-${owner}`;
  return record;
}

function expectPluginApprovalId(value: unknown, label: string): string {
  expect(value, label).toBeTypeOf("string");
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  expect(value.startsWith("plugin:"), label).toBe(true);
  const uuid = value.slice("plugin:".length);
  expect(uuid).toHaveLength(36);
  expect(uuid.split("-").map((part) => part.length)).toEqual([8, 4, 4, 4, 12]);
  expect(
    uuid.split("-").every((part) => /^[0-9a-f]+$/.test(part)),
    label,
  ).toBe(true);
  return value;
}

function broadcastCall(opts: GatewayRequestHandlerOptions, index = 0) {
  const call = mockCall(opts.context.broadcast, index, "broadcast call");
  return {
    event: call?.[0],
    payload: requireRecord(call?.[1], "broadcast payload"),
    options: call?.[2],
  };
}

const invalidParamMethodCases = [
  { method: "plugin.approval.request" },
  { method: "plugin.approval.resolve" },
] as const;

const invalidRequestCases = [
  {
    name: "invalid severity value",
    params: { title: "T", description: "D", severity: "extreme" },
  },
  {
    name: "title exceeding max length",
    params: { title: "x".repeat(81), description: "D" },
  },
  {
    name: "description exceeding max length",
    params: { title: "T", description: "x".repeat(513) },
  },
  {
    name: "timeoutMs exceeding max",
    params: { title: "T", description: "D", timeoutMs: 700_000 },
  },
] as const;

describe("createPluginApprovalHandlers", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns handlers for every plugin approval method", () => {
    const handlers = createPluginApprovalHandlers(manager);
    expect(Object.keys(handlers).toSorted()).toEqual([
      "plugin.approval.list",
      "plugin.approval.request",
      "plugin.approval.resolve",
      "plugin.approval.waitDecision",
    ]);
  });

  describe("invalid params", () => {
    it.each(invalidParamMethodCases)("$method rejects invalid params", async ({ method }) => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions(method, {});
      await expectDefined(handlers[method], "handlers[method] test invariant")(opts);
      expect(responseCall(opts.respond).result).toBeUndefined();
      expect(expectResponseRejected(opts.respond).code).toBeTypeOf("string");
    });
  });

  describe("plugin.approval.request", () => {
    it("creates and registers approval with twoPhase", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          title: "Sensitive action",
          description: "This tool modifies production data",
          severity: "warning",
          twoPhase: true,
        },
        { respond },
      );

      // Don't await — the handler blocks waiting for the decision.
      // Instead, let it run and resolve the approval after the accepted response.
      const handlerPromise = expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);

      const approvalId = await waitForAcceptedApproval(respond);

      const requestedBroadcast = broadcastCall(opts);
      expect(requestedBroadcast.event).toBe("plugin.approval.requested");
      expect(requestedBroadcast.payload.id).toBeTypeOf("string");
      expect(requestedBroadcast.options).toEqual({ dropIfSlow: true });

      // Resolve the approval so the handler can complete
      expect(manager.getSnapshot(approvalId)?.requestedByClientId).toBe("test-client");
      manager.resolve(approvalId, "allow-once");

      await handlerPromise;

      // Final response with decision
      const finalResult = expectResponseOk(respond, 1);
      expect(finalResult.id).toBe(approvalId);
      expect(finalResult.decision).toBe("allow-once");
    });

    it("expires immediately when no approval route", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          title: "Sensitive action",
          description: "Desc",
        },
        {
          context: createNoExecApprovalContext(),
        },
      );
      await expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);
      expect(expectResponseOk(opts.respond).decision).toBeNull();
    });

    it("passes caller connId to hasExecApprovalClients to exclude self", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const hasExecApprovalClients = vi.fn().mockReturnValue(false);
      const opts = createMockOptions(
        "plugin.approval.request",
        { title: "T", description: "D" },
        {
          client: createClient({
            connId: "backend-conn-42",
            clientId: "test",
            displayName: "Test",
          }),
          context: createApprovalContext({ hasExecApprovalClients }),
        },
      );
      await expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);
      expect(hasExecApprovalClients).toHaveBeenCalledWith("backend-conn-42");
    });

    it("keeps plugin approvals pending when the originating chat can handle /approve directly", async () => {
      vi.useFakeTimers();
      try {
        const handlers = createPluginApprovalHandlers(manager);
        const respond = vi.fn();
        const opts = createMockOptions(
          "plugin.approval.request",
          {
            title: "Sensitive action",
            description: "Desc",
            twoPhase: true,
            turnSourceChannel: "slack",
            turnSourceTo: "C123",
          },
          {
            respond,
            context: createApprovalContext({ hasExecApprovalClients: () => false }),
          },
        );

        const requestPromise = expectDefined(
          handlers["plugin.approval.request"],
          'handlers["plugin.approval.request"] test invariant',
        )(opts);
        const approvalId = await waitForAcceptedApproval(respond);
        expect(acceptedResult(respond).deliveryRoute).toBe("turn-source");
        manager.resolve(approvalId, "allow-once");

        await requestPromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(invalidRequestCases)("rejects $name", async ({ params }) => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", params);
      await expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);
      expect(expectResponseRejected(opts.respond).code).toBeTypeOf("string");
    });

    it("generates plugin-prefixed IDs", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        { title: "T", description: "D" },
        {
          respond,
          context: createApprovalContext({ hasExecApprovalClients: () => false }),
        },
      );
      await expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);
      const result = responseResult(respond);
      expectPluginApprovalId(result?.id, "generated plugin approval id");
    });

    it("passes plugin-prefixed IDs directly to manager.create", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const createSpy = vi.spyOn(manager, "create");
      const opts = createMockOptions(
        "plugin.approval.request",
        { title: "T", description: "D" },
        {
          context: createNoExecApprovalContext(),
        },
      );

      await expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expectPluginApprovalId(
        mockCall(createSpy, 0, "manager.create call")[2],
        "manager.create approval id",
      );
    });

    it("rejects plugin-provided id field", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        id: "plugin-provided-id",
        title: "T",
        description: "D",
      });
      await expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);
      expect(responseCall(opts.respond).ok).toBe(false);
      expect(responseError(opts.respond).message).toContain("unexpected property");
    });

    it("stores scoped allowed decisions on plugin approval requests", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          title: "T",
          description: "D",
          allowedDecisions: ["allow-once", "allow-once"],
          twoPhase: true,
        },
        { respond },
      );

      const handlerPromise = expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);
      const approvalId = await waitForAcceptedApproval(respond);
      expect(manager.getSnapshot(approvalId)?.request.allowedDecisions).toEqual([
        "allow-once",
        "deny",
      ]);
      manager.resolve(approvalId, "deny");
      await handlerPromise;
    });

    it("binds an initiating TUI as the least-privilege approval reviewer", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const reviewerClient = createClient({
        connId: "conn-tui-reviewer",
        clientId: "openclaw-tui",
        deviceId: "device-tui-reviewer",
        scopes: ["operator.approvals"],
      });
      const broadcastToConnIds = vi.fn();
      const context = {
        ...createApprovalContext(),
        broadcastToConnIds,
        getApprovalClientConnIds: ({
          filter,
        }: {
          filter: (client: GatewayRequestHandlerOptions["client"]) => boolean;
        }) =>
          filter(reviewerClient)
            ? new Set([reviewerClient?.connId ?? "conn-tui-reviewer"])
            : new Set<string>(),
      } as unknown as GatewayRequestHandlerOptions["context"];
      const respond = vi.fn();
      const requestClient = createClient({
        connId: "conn-approval-runtime",
        clientId: "gateway-client",
        deviceId: "device-approval-runtime",
        scopes: ["operator.approvals"],
        approvalRuntime: true,
      });
      const requestOpts = createMockOptions(
        "plugin.approval.request",
        {
          title: "Apply workspace skill proposal",
          description: "Apply the pending proposal",
          twoPhase: true,
          approvalReviewerDeviceIds: ["device-tui-reviewer"],
        },
        { client: requestClient, context, respond },
      );

      const requestPromise = expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(requestOpts);
      const approvalId = await waitForAcceptedApproval(respond);

      expect(manager.getSnapshot(approvalId)?.approvalReviewerDeviceIds).toEqual([
        "device-tui-reviewer",
      ]);
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id: approvalId }),
        new Set(["conn-tui-reviewer"]),
        { dropIfSlow: true },
      );

      const listRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.list"],
        'handlers["plugin.approval.list"] test invariant',
      )(
        createMockOptions(
          "plugin.approval.list",
          {},
          { client: reviewerClient, respond: listRespond },
        ),
      );
      const approvals = requireArray(responseCall(listRespond).result, "approval list");
      expect(approvals.map((entry) => requireRecord(entry, "approval").id)).toEqual([approvalId]);

      const resolveRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(
        createMockOptions(
          "plugin.approval.resolve",
          { id: approvalId, decision: "allow-once" },
          { client: reviewerClient, context, respond: resolveRespond },
        ),
      );
      expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      await requestPromise;
    });

    it("ignores reviewer devices from non-runtime plugin approval clients", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const requestOpts = createMockOptions(
        "plugin.approval.request",
        {
          title: "Apply workspace skill proposal",
          description: "Apply the pending proposal",
          twoPhase: true,
          approvalReviewerDeviceIds: ["device-tui-reviewer"],
        },
        {
          client: createClient({
            connId: "conn-untrusted",
            clientId: "untrusted-client",
            deviceId: "device-untrusted",
            scopes: ["operator.approvals"],
          }),
          respond,
        },
      );

      const requestPromise = expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(requestOpts);
      const approvalId = await waitForAcceptedApproval(respond);

      expect(manager.getSnapshot(approvalId)?.approvalReviewerDeviceIds).toBeUndefined();
      manager.resolve(approvalId, "deny");
      await requestPromise;
    });
  });

  describe("plugin.approval.list", () => {
    it("lists pending plugin approvals", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const requestOpts = createMockOptions(
        "plugin.approval.request",
        {
          title: "Sensitive action",
          description: "Desc",
          twoPhase: true,
        },
        { respond },
      );

      const handlerPromise = expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(requestOpts);
      const approvalId = await waitForAcceptedApproval(respond);

      const listRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.list"],
        'handlers["plugin.approval.list"] test invariant',
      )(createMockOptions("plugin.approval.list", {}, { respond: listRespond }));
      const listCall = responseCall(listRespond);
      expect(listCall.ok).toBe(true);
      expect(listCall.error).toBeUndefined();
      const approvals = requireArray(listCall.result, "approval list");
      expect(approvals).toHaveLength(1);
      const approval = requireRecord(approvals[0], "approval");
      const listedApprovalId = expectPluginApprovalId(approval.id, "listed approval id");
      const request = requireRecord(approval.request, "approval request");
      expect(request.title).toBe("Sensitive action");
      expect(request.description).toBe("Desc");

      expect(listedApprovalId).toBe(approvalId);
      manager.resolve(approvalId, "allow-once");
      await handlerPromise;
    });

    it("lists only plugin approvals owned by the caller", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      registerOwnedApproval(manager, { title: "Visible", id: "plugin:visible" });
      registerOwnedApproval(manager, {
        title: "Hidden",
        id: "plugin:hidden",
        owner: "other",
      });

      const listRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.list"],
        'handlers["plugin.approval.list"] test invariant',
      )(
        createMockOptions(
          "plugin.approval.list",
          {},
          {
            respond: listRespond,
            client: createOwnedClient(),
          },
        ),
      );

      const listCall = responseCall(listRespond);
      expect(listCall.ok).toBe(true);
      const approvals = requireArray(listCall.result, "approval list");
      expect(approvals.map((entry) => requireRecord(entry, "approval").id)).toEqual([
        "plugin:visible",
      ]);
    });
  });

  describe("plugin.approval.waitDecision", () => {
    it("rejects missing id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", {});
      await expectDefined(
        handlers["plugin.approval.waitDecision"],
        'handlers["plugin.approval.waitDecision"] test invariant',
      )(opts);
      expect(expectResponseRejected(opts.respond).message).toContain("id is required");
    });

    it("returns not found for unknown id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", { id: "unknown" });
      await expectDefined(
        handlers["plugin.approval.waitDecision"],
        'handlers["plugin.approval.waitDecision"] test invariant',
      )(opts);
      expect(expectResponseRejected(opts.respond).message).toContain("expired or not found");
    });

    it("returns not found for approvals hidden from the caller", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = registerOwnedApproval(manager, { title: "T" });
      manager.resolve(record.id, "allow-once");

      const opts = createMockOptions(
        "plugin.approval.waitDecision",
        { id: record.id },
        {
          client: createClient({
            connId: "conn-other",
            clientId: "client-other",
            deviceId: "device-other",
            scopes: ["operator.approvals"],
          }),
        },
      );
      await expectDefined(
        handlers["plugin.approval.waitDecision"],
        'handlers["plugin.approval.waitDecision"] test invariant',
      )(opts);
      expect(expectResponseRejected(opts.respond).message).toContain("expired or not found");
    });

    it("returns decision when resolved", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = registerApproval(manager);

      // Resolve before waiting
      manager.resolve(record.id, "allow-once");

      const opts = createMockOptions("plugin.approval.waitDecision", { id: record.id });
      await expectDefined(
        handlers["plugin.approval.waitDecision"],
        'handlers["plugin.approval.waitDecision"] test invariant',
      )(opts);
      const result = expectResponseOk(opts.respond);
      expect(result.id).toBe(record.id);
      expect(result.decision).toBe("allow-once");
    });
  });

  describe("plugin.approval.resolve", () => {
    it("rejects invalid decision", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = registerApproval(manager);
      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "invalid",
      });
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(opts);
      expect(expectResponseRejected(opts.respond).message).toBe("invalid decision");
    });

    it("resolves a pending approval", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = registerApproval(manager);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "deny",
      });
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      const resolvedBroadcast = broadcastCall(opts);
      expect(resolvedBroadcast.event).toBe("plugin.approval.resolved");
      expect(resolvedBroadcast.payload.id).toBe(record.id);
      expect(resolvedBroadcast.payload.decision).toBe("deny");
      expect(resolvedBroadcast.options).toEqual({ dropIfSlow: true });
    });

    it("resolves only plugin approvals owned by the caller", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const visible = registerOwnedApproval(manager, {
        title: "Visible",
        id: "plugin:abcd-visible",
      });
      const hidden = registerOwnedApproval(manager, {
        title: "Hidden",
        id: "plugin:abcd-hidden",
        owner: "other",
      });

      const ownerClient = createOwnedClient();
      const resolveRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(
        createMockOptions(
          "plugin.approval.resolve",
          {
            id: "plugin:abcd",
            decision: "allow-once",
          },
          {
            respond: resolveRespond,
            client: ownerClient,
          },
        ),
      );
      expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(manager.getSnapshot(visible.id)?.decision).toBe("allow-once");
      expect(manager.getSnapshot(hidden.id)?.decision).toBeUndefined();

      const hiddenRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(
        createMockOptions(
          "plugin.approval.resolve",
          {
            id: hidden.id,
            decision: "deny",
          },
          {
            respond: hiddenRespond,
            client: ownerClient,
          },
        ),
      );
      const error = expectResponseRejected(hiddenRespond);
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toBe("unknown or expired approval id");
      expect(manager.getSnapshot(hidden.id)?.decision).toBeUndefined();
    });

    it("rejects decisions outside plugin approval allowed decisions", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = registerApproval(manager, {
        allowedDecisions: ["allow-once", "deny"],
      });

      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "allow-always",
      });
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(opts);
      const error = expectResponseRejected(opts.respond);
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toBe("allow-always is unavailable for this plugin approval");
      expect(error.details).toEqual({ allowedDecisions: ["allow-once", "deny"] });
      expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    });

    it("rejects unknown approval id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.resolve", {
        id: "nonexistent",
        decision: "allow-once",
      });
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(opts);
      const error = expectResponseRejected(opts.respond);
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toContain("unknown or expired");
      expect(requireRecord(error.details, "error details").reason).toBe("APPROVAL_NOT_FOUND");
    });

    it("accepts unique short id prefixes", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = registerApproval(manager, { id: "abcdef-1234" });

      const opts = createMockOptions("plugin.approval.resolve", {
        id: "abcdef",
        decision: "allow-always",
      });
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(manager.getSnapshot(record.id)?.decision).toBe("allow-always");
    });

    it("does not leak candidate ids when prefixes are ambiguous", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      registerApproval(manager, { title: "A", id: "plugin:abc-1111" });
      registerApproval(manager, { title: "B", id: "plugin:abc-2222" });

      const opts = createMockOptions("plugin.approval.resolve", {
        id: "plugin:abc",
        decision: "deny",
      });
      await expectDefined(
        handlers["plugin.approval.resolve"],
        'handlers["plugin.approval.resolve"] test invariant',
      )(opts);
      const error = expectResponseRejected(opts.respond);
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toBe("unknown or expired approval id");
    });
  });
});
