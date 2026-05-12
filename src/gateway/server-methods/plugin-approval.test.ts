import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createManager() {
  return new ExecApprovalManager<PluginApprovalRequestPayload>();
}

function createMockOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { method, params, id: "req-1" },
    params,
    client: {
      connect: {
        client: { id: "test-client", displayName: "Test Client" },
      },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function createNoExecApprovalContext(): GatewayRequestHandlerOptions["context"] {
  return {
    broadcast: vi.fn(),
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    hasExecApprovalClients: () => false,
  } as unknown as GatewayRequestHandlerOptions["context"];
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

function mockCall(source: MockCallSource, index: number, label: string) {
  const call = source.mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call;
}

function responseCall(source: MockCallSource, index = 0) {
  const call = mockCall(source, index, `response call ${index}`);
  return {
    ok: call[0],
    result: call[1],
    error: call[2],
  };
}

function responseResult(source: MockCallSource, index = 0) {
  return requireRecord(responseCall(source, index).result, `response result ${index}`);
}

function responseError(source: MockCallSource, index = 0) {
  return requireRecord(responseCall(source, index).error, `response error ${index}`);
}

function acceptedResult(source: MockCallSource) {
  const call = Array.from(source.mock.calls).find((candidate) => {
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

function acceptedApprovalId(source: MockCallSource) {
  const id = acceptedResult(source).id;
  expect(id, "accepted approval id").toBeTypeOf("string");
  return id as string;
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
  const call = mockCall(
    opts.context.broadcast as unknown as MockCallSource,
    index,
    "broadcast call",
  );
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
      await handlers[method](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseCall(opts.respond as unknown as MockCallSource).result).toBeUndefined();
      expect(responseError(opts.respond as unknown as MockCallSource).code).toBeTypeOf("string");
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
      const handlerPromise = handlers["plugin.approval.request"](opts);

      // Wait for the twoPhase "accepted" response
      await vi.waitFor(() => {
        const accepted = acceptedResult(respond as unknown as MockCallSource);
        expect(accepted.status).toBe("accepted");
        expect(accepted.id).toBeTypeOf("string");
      });

      const requestedBroadcast = broadcastCall(opts);
      expect(requestedBroadcast.event).toBe("plugin.approval.requested");
      expect(requestedBroadcast.payload.id).toBeTypeOf("string");
      expect(requestedBroadcast.options).toEqual({ dropIfSlow: true });

      // Resolve the approval so the handler can complete
      const approvalId = acceptedApprovalId(respond as unknown as MockCallSource);
      manager.resolve(approvalId, "allow-once");

      await handlerPromise;

      // Final response with decision
      const finalResult = responseResult(respond as unknown as MockCallSource, 1);
      expect(responseCall(respond as unknown as MockCallSource, 1).ok).toBe(true);
      expect(finalResult.id).toBe(approvalId);
      expect(finalResult.decision).toBe("allow-once");
      expect(responseCall(respond as unknown as MockCallSource, 1).error).toBeUndefined();
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
      await handlers["plugin.approval.request"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(true);
      expect(responseResult(opts.respond as unknown as MockCallSource).decision).toBeNull();
      expect(responseCall(opts.respond as unknown as MockCallSource).error).toBeUndefined();
    });

    it("passes caller connId to hasExecApprovalClients to exclude self", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const hasExecApprovalClients = vi.fn().mockReturnValue(false);
      const opts = createMockOptions(
        "plugin.approval.request",
        { title: "T", description: "D" },
        {
          client: {
            connId: "backend-conn-42",
            connect: { client: { id: "test", displayName: "Test" } },
          } as unknown as GatewayRequestHandlerOptions["client"],
          context: {
            broadcast: vi.fn(),
            logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
            hasExecApprovalClients,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      );
      await handlers["plugin.approval.request"](opts);
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
            context: {
              broadcast: vi.fn(),
              logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
              hasExecApprovalClients: () => false,
            } as unknown as GatewayRequestHandlerOptions["context"],
          },
        );

        const requestPromise = handlers["plugin.approval.request"](opts);

        await vi.waitFor(() => {
          const accepted = acceptedResult(respond as unknown as MockCallSource);
          expect(accepted.status).toBe("accepted");
          expect(accepted.id).toBeTypeOf("string");
        });

        const approvalId = acceptedApprovalId(respond as unknown as MockCallSource);
        manager.resolve(approvalId, "allow-once");

        await requestPromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects invalid severity value", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        title: "T",
        description: "D",
        severity: "extreme",
      });
      await handlers["plugin.approval.request"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).code).toBeTypeOf("string");
    });

    it("rejects title exceeding max length", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        title: "x".repeat(81),
        description: "D",
      });
      await handlers["plugin.approval.request"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).code).toBeTypeOf("string");
    });

    it("rejects description exceeding max length", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        title: "T",
        description: "x".repeat(257),
      });
      await handlers["plugin.approval.request"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).code).toBeTypeOf("string");
    });

    it("rejects timeoutMs exceeding max", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        title: "T",
        description: "D",
        timeoutMs: 700_000,
      });
      await handlers["plugin.approval.request"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).code).toBeTypeOf("string");
    });

    it("generates plugin-prefixed IDs", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        { title: "T", description: "D" },
        {
          respond,
          context: {
            broadcast: vi.fn(),
            logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
            hasExecApprovalClients: () => false,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      );
      await handlers["plugin.approval.request"](opts);
      const result = respond.mock.calls.at(0)?.[1] as Record<string, unknown> | undefined;
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

      await handlers["plugin.approval.request"](opts);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expectPluginApprovalId(createSpy.mock.calls.at(0)?.[2], "manager.create approval id");
    });

    it("rejects plugin-provided id field", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        id: "plugin-provided-id",
        title: "T",
        description: "D",
      });
      await handlers["plugin.approval.request"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).message).toContain(
        "unexpected property",
      );
    });

    it("stores scoped allowed decisions on plugin approval requests", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          title: "T",
          description: "D",
          allowedDecisions: ["allow-once", "deny", "allow-once"],
          twoPhase: true,
        },
        { respond },
      );

      const handlerPromise = handlers["plugin.approval.request"](opts);
      await vi.waitFor(() => {
        const accepted = acceptedResult(respond as unknown as MockCallSource);
        expect(accepted.status).toBe("accepted");
        expect(accepted.id).toBeTypeOf("string");
      });

      const approvalId = acceptedApprovalId(respond as unknown as MockCallSource);
      expect(manager.getSnapshot(approvalId)?.request.allowedDecisions).toEqual([
        "allow-once",
        "deny",
      ]);
      manager.resolve(approvalId, "deny");
      await handlerPromise;
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

      const handlerPromise = handlers["plugin.approval.request"](requestOpts);
      await vi.waitFor(() => {
        const accepted = acceptedResult(respond as unknown as MockCallSource);
        expect(accepted.status).toBe("accepted");
        expect(accepted.id).toBeTypeOf("string");
      });

      const listRespond = vi.fn();
      await handlers["plugin.approval.list"](
        createMockOptions("plugin.approval.list", {}, { respond: listRespond }),
      );
      expect(responseCall(listRespond as unknown as MockCallSource).ok).toBe(true);
      const approvals = requireArray(
        responseCall(listRespond as unknown as MockCallSource).result,
        "approval list",
      );
      expect(approvals).toHaveLength(1);
      const approval = requireRecord(approvals[0], "approval");
      const listedApprovalId = expectPluginApprovalId(approval.id, "listed approval id");
      const request = requireRecord(approval.request, "approval request");
      expect(request.title).toBe("Sensitive action");
      expect(request.description).toBe("Desc");
      expect(responseCall(listRespond as unknown as MockCallSource).error).toBeUndefined();

      const approvalId = acceptedApprovalId(respond as unknown as MockCallSource);
      expect(listedApprovalId).toBe(approvalId);
      manager.resolve(approvalId, "allow-once");
      await handlerPromise;
    });
  });

  describe("plugin.approval.waitDecision", () => {
    it("rejects missing id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", {});
      await handlers["plugin.approval.waitDecision"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).message).toContain(
        "id is required",
      );
    });

    it("returns not found for unknown id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", { id: "unknown" });
      await handlers["plugin.approval.waitDecision"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).message).toContain(
        "expired or not found",
      );
    });

    it("returns decision when resolved", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000);
      void manager.register(record, 60_000);

      // Resolve before waiting
      manager.resolve(record.id, "allow-once");

      const opts = createMockOptions("plugin.approval.waitDecision", { id: record.id });
      await handlers["plugin.approval.waitDecision"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(true);
      expect(responseResult(opts.respond as unknown as MockCallSource).id).toBe(record.id);
      expect(responseResult(opts.respond as unknown as MockCallSource).decision).toBe("allow-once");
      expect(responseCall(opts.respond as unknown as MockCallSource).error).toBeUndefined();
    });
  });

  describe("plugin.approval.resolve", () => {
    it("rejects invalid decision", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000);
      void manager.register(record, 60_000);
      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "invalid",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      expect(responseError(opts.respond as unknown as MockCallSource).message).toBe(
        "invalid decision",
      );
    });

    it("resolves a pending approval", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000);
      void manager.register(record, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "deny",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      const resolvedBroadcast = broadcastCall(opts);
      expect(resolvedBroadcast.event).toBe("plugin.approval.resolved");
      expect(resolvedBroadcast.payload.id).toBe(record.id);
      expect(resolvedBroadcast.payload.decision).toBe("deny");
      expect(resolvedBroadcast.options).toEqual({ dropIfSlow: true });
    });

    it("rejects decisions outside plugin approval allowed decisions", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create(
        {
          title: "T",
          description: "D",
          allowedDecisions: ["allow-once", "deny"],
        },
        60_000,
      );
      void manager.register(record, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: record.id,
        decision: "allow-always",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      const error = responseError(opts.respond as unknown as MockCallSource);
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
      await handlers["plugin.approval.resolve"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      const error = responseError(opts.respond as unknown as MockCallSource);
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toContain("unknown or expired");
      expect(requireRecord(error.details, "error details").reason).toBe("APPROVAL_NOT_FOUND");
    });

    it("accepts unique short id prefixes", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ title: "T", description: "D" }, 60_000, "abcdef-1234");
      void manager.register(record, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: "abcdef",
        decision: "allow-always",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(manager.getSnapshot(record.id)?.decision).toBe("allow-always");
    });

    it("does not leak candidate ids when prefixes are ambiguous", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const recordA = manager.create({ title: "A", description: "D" }, 60_000, "plugin:abc-1111");
      const recordB = manager.create({ title: "B", description: "D" }, 60_000, "plugin:abc-2222");
      void manager.register(recordA, 60_000);
      void manager.register(recordB, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        id: "plugin:abc",
        decision: "deny",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(responseCall(opts.respond as unknown as MockCallSource).ok).toBe(false);
      const error = responseError(opts.respond as unknown as MockCallSource);
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toBe("unknown or expired approval id");
    });
  });
});
