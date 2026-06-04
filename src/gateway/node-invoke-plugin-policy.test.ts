/**
 * Node invoke plugin-policy regression tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeSession } from "./node-registry.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const DEMO_PLUGIN_ID = "demo";
const DEMO_COMMAND = "demo.read";
const DEMO_PARAMS = { path: "/tmp/x" };

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

type NodeInvokePolicyRegistration = NonNullable<PluginRegistry["nodeInvokePolicies"]>[number];
type NodeInvokePolicyHandler = NodeInvokePolicyRegistration["policy"]["handle"];
type PluginApprovalRecord = ReturnType<
  ExecApprovalManager<PluginApprovalRequestPayload>["listPendingRecords"]
>[number];

function createDemoPolicy(handle: NodeInvokePolicyHandler): NodeInvokePolicyRegistration {
  return {
    pluginId: DEMO_PLUGIN_ID,
    policy: {
      commands: [DEMO_COMMAND],
      handle,
    },
    pluginConfig: { enabled: true },
    source: "test",
  };
}

function createApprovalRequestPolicy(params?: {
  timeoutMs?: number;
}): NodeInvokePolicyRegistration {
  return createDemoPolicy(async (ctx: OpenClawPluginNodeInvokePolicyContext) => {
    const approval = await ctx.approvals?.request({
      title: "Sensitive action",
      description: "Needs approval",
      ...(params?.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    });
    return { ok: true, payload: approval ?? null };
  });
}

function setDangerousDemoCommandRegistry(policies: NodeInvokePolicyRegistration[] = []) {
  registryState.current = {
    nodeHostCommands: [
      {
        pluginId: DEMO_PLUGIN_ID,
        command: {
          command: DEMO_COMMAND,
          dangerous: true,
          handle: async () => "{}",
        },
        source: "test",
      },
    ],
    nodeInvokePolicies: policies,
  } as unknown as PluginRegistry;
}

async function invokeDemoPolicy(
  context: GatewayRequestContext,
  client: GatewayClient | null = null,
) {
  return await applyPluginNodeInvokePolicy({
    context,
    client,
    nodeSession: createNodeSession(),
    command: DEMO_COMMAND,
    params: DEMO_PARAMS,
  });
}

async function expectSinglePendingApproval(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
): Promise<PluginApprovalRecord> {
  await vi.waitFor(() => {
    expect(manager.listPendingRecords()).toHaveLength(1);
  });
  const [record] = manager.listPendingRecords();
  if (!record) {
    throw new Error("expected pending approval");
  }
  return record;
}

async function expectApprovalResolution(
  resultPromise: ReturnType<typeof applyPluginNodeInvokePolicy>,
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  record: PluginApprovalRecord,
) {
  expect(manager.resolve(record.id, "allow-once")).toBe(true);
  await expect(resultPromise).resolves.toStrictEqual({
    ok: true,
    payload: { id: record.id, decision: "allow-once" },
  });
}

describe("applyPluginNodeInvokePolicy", () => {
  beforeEach(() => {
    registryState.current = null;
  });

  it("fails closed for dangerous plugin node commands without a policy", async () => {
    setDangerousDemoCommandRegistry();
    const { context, invoke } = createContext();

    const result = await invokeDemoPolicy(context);

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
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    const { context, invoke } = createContext();

    const result = await invokeDemoPolicy(context);

    expect(result).toStrictEqual({ ok: true, payload: { ok: true, value: 1 }, payloadJSON: null });
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
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
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds,
    });
    const resultPromise = invokeDemoPolicy(context, createOperatorClient());

    const record = await expectSinglePendingApproval(manager);
    expect(record.requestedByConnId).toBe("conn-requester");
    expect(record.requestedByDeviceId).toBe("device-owner");
    expect(record.requestedByClientId).toBe("client-owner");
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "plugin.approval.requested",
      expect.objectContaining({ id: record.id }),
      visibleConnIds,
      { dropIfSlow: true },
    );

    await expectApprovalResolution(resultPromise, manager, record);
  });

  it("caps plugin policy approval timeouts through the shared approval policy", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    setDangerousDemoCommandRegistry([
      createApprovalRequestPolicy({ timeoutMs: Number.MAX_SAFE_INTEGER }),
    ]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: createApprovalClientLookup([
        createApprovalClient({
          connId: "conn-owner-approval",
          clientId: "client-owner",
          deviceId: "device-owner",
        }),
      ]),
    });
    const resultPromise = invokeDemoPolicy(context, createOperatorClient());

    const record = await expectSinglePendingApproval(manager);
    expect(record.expiresAtMs - record.createdAtMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS);

    await expectApprovalResolution(resultPromise, manager, record);
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
