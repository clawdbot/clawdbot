import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeSession } from "./node-registry.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const registryState = vi.hoisted(() => ({
  current: null as PluginRegistry | null,
}));

vi.mock("../plugins/active-runtime-registry.js", () => ({
  getActiveRuntimePluginRegistry: () => registryState.current,
}));

function createNodeSession(): NodeSession {
  return {
    nodeId: "node-1",
    connId: "conn-1",
    client: {} as NodeSession["client"],
    declaredCaps: [],
    caps: [],
    declaredCommands: ["demo.read"],
    commands: ["demo.read"],
    connectedAtMs: 0,
  };
}

function createContext(opts?: {
  pluginApprovalManager?: ExecApprovalManager<PluginApprovalRequestPayload>;
  getApprovalClientConnIds?: GatewayRequestContext["getApprovalClientConnIds"];
}) {
  const invoke = vi.fn(async () => ({
    ok: true,
    payload: { ok: true, value: 1 },
    payloadJSON: null,
    error: null,
  }));
  return {
    context: {
      getRuntimeConfig: () => ({}),
      nodeRegistry: { invoke },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      pluginApprovalManager: opts?.pluginApprovalManager,
      getApprovalClientConnIds: opts?.getApprovalClientConnIds,
    } as unknown as GatewayRequestContext,
    invoke,
  };
}

type ApprovalClientLookup = NonNullable<GatewayRequestContext["getApprovalClientConnIds"]>;

function createApprovalClient(params: {
  connId: string;
  clientId: string;
  deviceId?: string;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: params.clientId },
      device: params.deviceId ? { id: params.deviceId } : undefined,
      scopes: ["operator.approvals"],
    },
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

function createOperatorClient(): GatewayClient {
  return createApprovalClient({
    connId: "conn-requester",
    clientId: "client-owner",
    deviceId: "device-owner",
  });
}

describe("applyPluginNodeInvokePolicy", () => {
  beforeEach(() => {
    registryState.current = null;
  });

  it("fails closed for dangerous plugin node commands without a policy", async () => {
    registryState.current = {
      nodeHostCommands: [
        {
          pluginId: "demo",
          command: {
            command: "demo.read",
            dangerous: true,
            handle: async () => "{}",
          },
          source: "test",
        },
      ],
      nodeInvokePolicies: [],
    } as unknown as PluginRegistry;
    const { context, invoke } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: "demo.read",
      params: { path: "/tmp/x" },
    });

    if (result === null) {
      throw new Error("expected plugin policy failure");
    }
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected plugin policy failure");
    }
    expect(result.code).toBe("PLUGIN_POLICY_MISSING");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses a matching plugin policy when one is registered", async () => {
    registryState.current = {
      nodeHostCommands: [
        {
          pluginId: "demo",
          command: {
            command: "demo.read",
            dangerous: true,
            handle: async () => "{}",
          },
          source: "test",
        },
      ],
      nodeInvokePolicies: [
        {
          pluginId: "demo",
          policy: {
            commands: ["demo.read"],
            handle: (ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode(),
          },
          pluginConfig: { enabled: true },
          source: "test",
        },
      ],
    } as unknown as PluginRegistry;
    const { context, invoke } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: "demo.read",
      params: { path: "/tmp/x" },
    });

    expect(result).toStrictEqual({ ok: true, payload: { ok: true, value: 1 }, payloadJSON: null });
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "demo.read",
      params: { path: "/tmp/x" },
      timeoutMs: undefined,
      idempotencyKey: undefined,
    });
  });

  it("binds plugin policy approval requests to the invoking client", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    const visibleConnIds = new Set(["conn-owner-approval"]);
    const getApprovalClientConnIds = createApprovalClientLookup([
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
    ]);
    registryState.current = {
      nodeHostCommands: [
        {
          pluginId: "demo",
          command: {
            command: "demo.read",
            dangerous: true,
            handle: async () => "{}",
          },
          source: "test",
        },
      ],
      nodeInvokePolicies: [
        {
          pluginId: "demo",
          policy: {
            commands: ["demo.read"],
            handle: async (ctx: OpenClawPluginNodeInvokePolicyContext) => {
              const approval = await ctx.approvals?.request({
                title: "Sensitive action",
                description: "Needs approval",
              });
              return { ok: true, payload: approval ?? null };
            },
          },
          pluginConfig: { enabled: true },
          source: "test",
        },
      ],
    } as unknown as PluginRegistry;
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds,
    });
    const resultPromise = applyPluginNodeInvokePolicy({
      context,
      client: createOperatorClient(),
      nodeSession: createNodeSession(),
      command: "demo.read",
      params: { path: "/tmp/x" },
    });

    await vi.waitFor(() => {
      expect(manager.listPendingRecords()).toHaveLength(1);
    });
    const [record] = manager.listPendingRecords();
    expect(record?.requestedByConnId).toBe("conn-requester");
    expect(record?.requestedByDeviceId).toBe("device-owner");
    expect(record?.requestedByClientId).toBe("client-owner");
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "plugin.approval.requested",
      expect.objectContaining({ id: record?.id }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await expect(resultPromise).resolves.toStrictEqual({
      ok: true,
      payload: { id: record?.id, decision: "allow-once" },
    });
  });

  it("leaves commands without a dangerous plugin registration to normal allowlist handling", async () => {
    registryState.current = {
      nodeHostCommands: [],
      nodeInvokePolicies: [],
    } as unknown as PluginRegistry;
    const { context } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: "safe.echo",
      params: { value: "hello" },
    });

    expect(result).toBeNull();
  });
});
