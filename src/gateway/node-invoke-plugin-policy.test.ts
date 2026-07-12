/**
 * Node invoke plugin-policy regression tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeSession } from "./node-registry.js";
import { listPendingOperatorApprovals } from "./operator-approval-store.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const DEMO_PLUGIN_ID = "demo";
const DEMO_COMMAND = "demo.read";
const DEMO_PARAMS = { path: "/tmp/x" };
const tempDirs: string[] = [];

const hasApprovalTurnSourceRouteMock = vi.hoisted(() =>
  vi.fn(
    (params: { turnSourceChannel?: string | null; approvalKind?: "exec" | "plugin" }) =>
      params.approvalKind === "plugin" && params.turnSourceChannel === "tui",
  ),
);

vi.mock("../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
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
    declaredNodePluginTools: [],
    nodePluginTools: [],
    nodeSkills: [],
    connectedAtMs: 0,
  };
}

function createContext(opts?: {
  pluginApprovalManager?: ExecApprovalManager<PluginApprovalRequestPayload>;
  getApprovalClientConnIds?: GatewayRequestContext["getApprovalClientConnIds"];
  getRuntimeConfig?: GatewayRequestContext["getRuntimeConfig"];
  nodeSession?: NodeSession;
  hasExecApprovalClients?: GatewayRequestContext["hasExecApprovalClients"];
  forwardPluginApprovalRequest?: GatewayRequestContext["forwardPluginApprovalRequest"];
}) {
  const nodeSession = opts?.nodeSession ?? createNodeSession();
  const invoke = vi.fn(async () => ({
    ok: true,
    payload: { ok: true, value: 1 },
    payloadJSON: null,
    error: null,
  }));
  return {
    context: {
      getRuntimeConfig:
        opts?.getRuntimeConfig ??
        (() => ({ gateway: { nodes: { allowCommands: [DEMO_COMMAND] } } })),
      nodeRegistry: { get: () => nodeSession, invoke },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      pluginApprovalManager: opts?.pluginApprovalManager,
      getApprovalClientConnIds: opts?.getApprovalClientConnIds,
      hasExecApprovalClients: opts?.hasExecApprovalClients,
      forwardPluginApprovalRequest: opts?.forwardPluginApprovalRequest,
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

type NodeInvokePolicyRegistration = PluginRegistry["nodeInvokePolicies"][number];
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
  title?: string;
  description?: string;
}): NodeInvokePolicyRegistration {
  return createDemoPolicy(async (ctx: OpenClawPluginNodeInvokePolicyContext) => {
    const approval = await ctx.approvals?.request({
      title: params?.title ?? "Sensitive action",
      description: params?.description ?? "Needs approval",
      ...(params?.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    });
    return { ok: true, payload: approval ?? null };
  });
}

function setDangerousDemoCommandRegistry(policies: NodeInvokePolicyRegistration[] = []) {
  const registry = createEmptyPluginRegistry();
  registry.nodeHostCommands.push({
    pluginId: DEMO_PLUGIN_ID,
    command: {
      command: DEMO_COMMAND,
      dangerous: true,
      handle: async () => "{}",
    },
    source: "test",
  });
  registry.nodeInvokePolicies.push(...policies);
  setActivePluginRegistry(registry);
}

function createPolicyRegistry(handle: NodeInvokePolicyHandler): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.nodeInvokePolicies.push(createDemoPolicy(handle));
  return registry;
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
    resetPluginRuntimeStateForTest();
    hasApprovalTurnSourceRouteMock.mockClear();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
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
    expect(result.details).toStrictEqual({ nodeCommandDispatched: false });
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
      expectedConnId: "conn-1",
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      timeoutMs: undefined,
      idempotencyKey: undefined,
    });
  });

  it("rechecks command authorization immediately before plugin transport dispatch", async () => {
    let allowCommand = true;
    setDangerousDemoCommandRegistry([
      createDemoPolicy(async (ctx) => {
        allowCommand = false;
        return await ctx.invokeNode();
      }),
    ]);
    const { context, invoke } = createContext({
      getRuntimeConfig: () => ({
        gateway: {
          nodes: allowCommand
            ? { allowCommands: [DEMO_COMMAND] }
            : { denyCommands: [DEMO_COMMAND] },
        },
      }),
    });

    const result = await invokeDemoPolicy(context);

    expect(result).toMatchObject({
      ok: false,
      code: "NODE_COMMAND_REVOKED",
      details: {
        command: DEMO_COMMAND,
        reason: "command not allowlisted",
        nodeCommandDispatched: false,
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("overrides plugin dispatch claims with the actual pre-dispatch state", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy(async () => ({
        ok: false,
        code: "POLICY_DENIED",
        message: "policy denied before dispatch",
        details: { nodeCommandDispatched: true, source: "policy" },
      })),
    ]);
    const { context, invoke } = createContext();

    const result = await invokeDemoPolicy(context);

    expect(result).toMatchObject({
      ok: false,
      details: { nodeCommandDispatched: false, source: "policy" },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks a policy failure after node dispatch as ambiguous", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy(async (ctx) => {
        await ctx.invokeNode();
        return {
          ok: false,
          code: "POST_DISPATCH_REJECTION",
          message: "policy rejected after dispatch",
        };
      }),
    ]);
    const { context, invoke } = createContext();

    const result = await invokeDemoPolicy(context);

    expect(result).toMatchObject({
      ok: false,
      details: { nodeCommandDispatched: true },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses a matching policy from the pinned Gateway registry after an active swap", async () => {
    const gatewayRegistry = createPolicyRegistry((ctx) => ctx.invokeNode());
    setActivePluginRegistry(gatewayRegistry);
    pinActivePluginChannelRegistry(gatewayRegistry);
    setActivePluginRegistry(
      createPolicyRegistry(async () => ({
        ok: false,
        code: "TRANSIENT_POLICY",
        message: "agent-scoped policy must not shadow Gateway policy",
      })),
    );
    const { context, invoke } = createContext();

    const result = await invokeDemoPolicy(context);

    expect(result).toStrictEqual({ ok: true, payload: { ok: true, value: 1 }, payloadJSON: null });
    expect(invoke).toHaveBeenCalledOnce();
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

  it("forwards plugin policy approvals to the originating turn source", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    const getApprovalClientConnIds = vi.fn(() => new Set<string>());
    const handlePluginApprovalRequested = vi.fn(async () => true);
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds,
      hasExecApprovalClients: vi.fn(() => false),
      forwardPluginApprovalRequest: handlePluginApprovalRequested,
    });
    const resultPromise = applyPluginNodeInvokePolicy({
      context,
      client: {
        ...createOperatorClient(),
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:alice",
          },
        },
      },
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      turnSource: {
        channel: "tui",
        to: "terminal",
        accountId: "default",
        threadId: 7,
      },
    });

    const record = await expectSinglePendingApproval(manager);
    expect(record.request.turnSourceChannel).toBe("tui");
    expect(record.request.turnSourceTo).toBe("terminal");
    expect(record.request.turnSourceAccountId).toBe("default");
    expect(record.request.turnSourceThreadId).toBe(7);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "plugin.approval.requested",
      expect.objectContaining({ id: record.id }),
      new Set<string>(),
      { dropIfSlow: true },
    );
    expect(handlePluginApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        id: record.id,
        request: expect.objectContaining({
          turnSourceChannel: "tui",
          turnSourceTo: "terminal",
          turnSourceAccountId: "default",
          turnSourceThreadId: 7,
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:alice",
        }),
      }),
    );

    await expectApprovalResolution(resultPromise, manager, record);
  });

  it("ignores approval routes from unsigned node.invoke clients", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    const forwardPluginApprovalRequest = vi.fn(async () => false);
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: vi.fn(() => new Set<string>()),
      hasExecApprovalClients: vi.fn(() => false),
      forwardPluginApprovalRequest,
    });

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: createOperatorClient(),
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      turnSource: {
        channel: "telegram",
        to: "chat:other",
        accountId: "work",
        threadId: 9,
      },
    });

    expect(result).toMatchObject({ ok: true, payload: { decision: null } });
    expect(forwardPluginApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          agentId: null,
          sessionKey: null,
          turnSourceChannel: null,
          turnSourceTo: null,
          turnSourceAccountId: null,
          turnSourceThreadId: null,
        }),
      }),
    );
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

  it("fails closed before routing an unrenderable persistent policy approval", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-policy-approval-"));
    tempDirs.push(stateDir);
    const databaseOptions = { path: path.join(stateDir, "state.sqlite") };
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence: { runtimeEpoch: "node-policy-test", databaseOptions },
      resolveAllowedDecisions: resolvePluginApprovalRequestAllowedDecisions,
    });
    setDangerousDemoCommandRegistry([
      createApprovalRequestPolicy({ title: " \t ", description: "Needs approval" }),
    ]);
    const { context, invoke } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: createApprovalClientLookup([
        createApprovalClient({
          connId: "conn-owner-approval",
          clientId: "client-owner",
          deviceId: "device-owner",
        }),
      ]),
    });

    await expect(invokeDemoPolicy(context, createOperatorClient())).rejects.toThrow(
      "approval cannot be persisted without a valid reviewer presentation",
    );
    expect(manager.listPendingRecords()).toEqual([]);
    expect(listPendingOperatorApprovals({ databaseOptions })).toEqual([]);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves commands without a dangerous plugin registration to normal allowlist handling", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
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

  it("keeps approval payload fields on UTF-16 boundaries", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    setDangerousDemoCommandRegistry([
      createApprovalRequestPolicy({
        title: `${"a".repeat(79)}🚀tail`,
        description: `${"b".repeat(255)}🚀tail`,
      }),
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
    expect(record.request.title).toBe("a".repeat(79));
    expect(record.request.description).toBe("b".repeat(255));

    await expectApprovalResolution(resultPromise, manager, record);
  });
});
