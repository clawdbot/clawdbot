import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createClient(approvalRuntime = false): GatewayRequestHandlerOptions["client"] {
  return {
    connId: "conn-test-client",
    connect: {
      client: {
        id: "test-client",
        displayName: "Test Client",
      },
    },
    ...(approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

function createApprovalContext(
  hasAbortMarker: (runId: string) => boolean = () => false,
): GatewayRequestHandlerOptions["context"] {
  return {
    broadcast: vi.fn(),
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    hasExecApprovalClients: () => true,
    chatRunState: { hasAbortMarker },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

function createOptions(
  method: string,
  params: Record<string, unknown>,
  overrides: Partial<GatewayRequestHandlerOptions> = {},
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

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function responseCall(source: unknown, index = 0) {
  const call = (source as MockCallSource).mock.calls[index];
  if (!call) {
    throw new Error(`Expected response call ${index}`);
  }
  return {
    ok: call[0],
    result: call[1],
    error: call[2] as Record<string, unknown> | undefined,
  };
}

async function waitForAcceptedApproval(respond: unknown): Promise<string> {
  let approvalId: string | undefined;
  await vi.waitFor(() => {
    const calls = Array.from((respond as MockCallSource).mock.calls);
    const accepted = calls.find((call) => {
      const result = call[1];
      return (
        typeof result === "object" &&
        result !== null &&
        "status" in result &&
        (result as { status?: unknown }).status === "accepted"
      );
    });
    const result = accepted?.[1] as { id?: unknown } | undefined;
    expect(result?.id).toBeTypeOf("string");
    approvalId = result?.id as string;
  });
  return expectDefined(approvalId, "accepted approval id");
}

describe("plugin external approval resolution", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;

  beforeEach(() => {
    manager = new ExecApprovalManager<PluginApprovalRequestPayload>({ approvalKind: "plugin" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects externalResolution from ordinary Gateway callers", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const opts = createOptions("plugin.approval.request", {
      title: "T",
      description: "D",
      externalResolution: { label: "Verify with World" },
    });

    await expectDefined(
      handlers["plugin.approval.request"],
      'handlers["plugin.approval.request"] test invariant',
    )(opts);

    expect(responseCall(opts.respond).ok).toBe(false);
    expect(responseCall(opts.respond).error?.message).toContain("unexpected property");
  });

  it("accepts host-bound verification only for the internal approval runtime", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const respond = vi.fn();
    const opts = createOptions(
      "plugin.approval.request",
      {
        pluginId: "agentkit",
        title: "T",
        description: "D",
        toolName: "dangerous-tool",
        allowedDecisions: ["deny"],
        externalResolution: {
          label: "Verify with World",
          decisions: ["allow-once", "allow-always"],
        },
        runId: "run-1",
        sessionId: "session-1",
        twoPhase: true,
      },
      { client: createClient(true), respond },
    );
    const handlerPromise = expectDefined(
      handlers["plugin.approval.request"],
      'handlers["plugin.approval.request"] test invariant',
    )(opts);
    const approvalId = await waitForAcceptedApproval(respond);

    expect(manager.getSnapshot(approvalId)?.request).toMatchObject({
      pluginId: "agentkit",
      toolName: "dangerous-tool",
      runId: "run-1",
      sessionId: "session-1",
      allowedDecisions: ["deny"],
      externalResolution: {
        label: "Verify with World",
        decisions: ["allow-once", "allow-always"],
      },
    });

    const genericAllow = createOptions("plugin.approval.resolve", {
      id: approvalId,
      decision: "allow-once",
    });
    await expectDefined(
      handlers["plugin.approval.resolve"],
      'handlers["plugin.approval.resolve"] test invariant',
    )(genericAllow);

    expect(responseCall(genericAllow.respond).ok).toBe(false);
    expect(responseCall(genericAllow.respond).error).toMatchObject({
      details: { allowedDecisions: ["deny"] },
    });
    expect(manager.getSnapshot(approvalId)?.resolvedAtMs).toBeUndefined();
    manager.resolve(approvalId, "deny");
    await handlerPromise;
  });

  it("rejects missing host bindings and overlapping generic allow decisions", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const invalidRequests = [
      {
        pluginId: "agentkit",
        title: "T",
        description: "D",
        toolName: "dangerous-tool",
        allowedDecisions: ["deny"],
        externalResolution: { label: "Verify with World" },
      },
      {
        title: "T",
        description: "D",
        toolName: "dangerous-tool",
        runId: "run-1",
        externalResolution: { label: "Verify with World" },
      },
      {
        pluginId: "agentkit",
        title: "T",
        description: "D",
        runId: "run-1",
        externalResolution: { label: "Verify with World" },
      },
      {
        pluginId: "agentkit",
        title: "T",
        description: "D",
        toolName: "dangerous-tool",
        allowedDecisions: ["allow-once", "deny"],
        externalResolution: { label: "Verify with World" },
        runId: "run-1",
      },
    ];

    for (const request of invalidRequests) {
      const opts = createOptions("plugin.approval.request", request, {
        client: createClient(true),
      });
      await expectDefined(
        handlers["plugin.approval.request"],
        'handlers["plugin.approval.request"] test invariant',
      )(opts);
      expect(responseCall(opts.respond).ok).toBe(false);
    }
  });

  it("rejects verification after the owning run was aborted", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const context = createApprovalContext((runId) => runId === "run-aborted");
    const opts = createOptions(
      "plugin.approval.request",
      {
        pluginId: "agentkit",
        title: "T",
        description: "D",
        toolName: "dangerous-tool",
        allowedDecisions: ["deny"],
        externalResolution: { label: "Verify with World" },
        runId: "run-aborted",
        twoPhase: true,
      },
      {
        client: createClient(true),
        context,
      },
    );

    await expectDefined(
      handlers["plugin.approval.request"],
      'handlers["plugin.approval.request"] test invariant',
    )(opts);

    expect(responseCall(opts.respond).ok).toBe(false);
    expect(responseCall(opts.respond).error).toMatchObject({
      message: "approval run already aborted",
      details: { reason: "PLUGIN_APPROVAL_RUN_ABORTED" },
    });
    expect(manager.listPendingRecords()).toEqual([]);
    expect(context.broadcast).not.toHaveBeenCalled();
  });
});
