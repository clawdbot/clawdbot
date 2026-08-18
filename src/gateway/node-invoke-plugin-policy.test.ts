/**
 * Node invoke plugin-policy regression tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import {
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  type PluginApprovalRequest,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeInvokeResult, NodeSession } from "./node-registry.js";
import { listPendingOperatorApprovals } from "./operator-approval-store.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const DEMO_PLUGIN_ID = "demo";
const DEMO_COMMAND = "demo.read";
const DEMO_PARAMS = { path: "/tmp/x" };
const tempDirs: string[] = [];

const hasApprovalTurnSourceRouteMock = vi.hoisted(() =>
  vi.fn(
    (params: { turnSourceChannel?: string | null; approvalKind?: ChannelApprovalKind }) =>
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
  pluginApprovalIosPushDelivery?: GatewayRequestContext["pluginApprovalIosPushDelivery"];
  validateAgentRuntimeApprovalAuthority?: GatewayRequestContext["validateAgentRuntimeApprovalAuthority"];
}) {
  const nodeSession = opts?.nodeSession ?? createNodeSession();
  const invoke = vi.fn(
    async (params?: {
      onDispatchReady?: (invokeId: string) => void;
    }): Promise<NodeInvokeResult> => {
      params?.onDispatchReady?.("invoke-1");
      return {
        ok: true,
        payload: { ok: true, value: 1 },
        payloadJSON: null,
        error: null,
      };
    },
  );
  return {
    context: {
      getRuntimeConfig:
        opts?.getRuntimeConfig ??
        (() => ({ gateway: { nodes: { commands: { allow: [DEMO_COMMAND] } } } })),
      nodeRegistry: { get: () => nodeSession, invoke },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      pluginApprovalManager: opts?.pluginApprovalManager,
      getApprovalClientConnIds: opts?.getApprovalClientConnIds,
      hasExecApprovalClients: opts?.hasExecApprovalClients,
      forwardPluginApprovalRequest: opts?.forwardPluginApprovalRequest,
      pluginApprovalIosPushDelivery: opts?.pluginApprovalIosPushDelivery,
      validateAgentRuntimeApprovalAuthority: opts?.validateAgentRuntimeApprovalAuthority,
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
  toolName?: string;
  agentId?: string;
}): NodeInvokePolicyRegistration {
  return createDemoPolicy(async (ctx: OpenClawPluginNodeInvokePolicyContext) => {
    const approval = await ctx.approvals?.request({
      title: params?.title ?? "Sensitive action",
      description: params?.description ?? "Needs approval",
      ...(params?.toolName === undefined ? {} : { toolName: params.toolName }),
      ...(params?.agentId === undefined ? {} : { agentId: params.agentId }),
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
  expect(manager.getSnapshot(record.id)?.consumedDecision).toBe("allow-once");
  expect(manager.consumeAllowOnce(record.id)).toBe(false);
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
      isDispatchAuthorized: expect.any(Function),
      onDispatchReady: expect.any(Function),
    });
  });

  it("classifies exact arguments before the policy handler and transport", async () => {
    const policy = createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => {
      expect(ctx.risk).toEqual({ level: "high", family: "fixture_mutation" });
      return ctx.invokeNode();
    });
    policy.policy.classifyRisk = ({ command, params }) => {
      expect({ command, params }).toEqual({ command: DEMO_COMMAND, params: DEMO_PARAMS });
      return { level: "high", family: "fixture_mutation" };
    };
    setDangerousDemoCommandRegistry([policy]);
    const { context, invoke } = createContext();

    await expect(invokeDemoPolicy(context)).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("fails closed when argument risk classification throws or returns invalid metadata", async () => {
    for (const classifyRisk of [
      () => {
        throw new Error("hostile argument text");
      },
      () => ({ level: "high" as const, family: "contains spaces" }),
    ]) {
      const policy = createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) =>
        ctx.invokeNode(),
      );
      policy.policy.classifyRisk = classifyRisk;
      setDangerousDemoCommandRegistry([policy]);
      const { context, invoke } = createContext();

      await expect(invokeDemoPolicy(context)).resolves.toEqual({
        ok: false,
        code: "PLUGIN_POLICY_RISK_CLASSIFICATION_FAILED",
        message: `node.invoke ${DEMO_COMMAND} arguments could not be classified by plugin ${DEMO_PLUGIN_ID}`,
        details: { nodeCommandDispatched: false },
      });
      expect(invoke).not.toHaveBeenCalled();
      resetPluginRuntimeStateForTest();
    }
  });

  it.each([5_000, 0])(
    "bounds plugin timeout override %i by the remaining invocation deadline",
    async (overrideTimeoutMs) => {
      setDangerousDemoCommandRegistry([
        createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) =>
          ctx.invokeNode({ timeoutMs: overrideTimeoutMs }),
        ),
      ]);
      const { context, invoke } = createContext();
      const controller = new AbortController();

      const result = await applyPluginNodeInvokePolicy({
        context,
        client: null,
        nodeSession: createNodeSession(),
        command: DEMO_COMMAND,
        params: DEMO_PARAMS,
        timeoutMs: 1_000,
        signal: controller.signal,
        resolveRemainingTimeoutMs: () => 250,
      });

      expect(result).toMatchObject({ ok: true });
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 250, signal: controller.signal }),
      );
    },
  );

  it("marks plugin-owned work dispatched only after the node transport accepts it", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    const { context, invoke } = createContext();
    const dispatchOrder: string[] = [];
    invoke.mockImplementationOnce(async (params) => {
      dispatchOrder.push("node transport");
      params?.onDispatchReady?.("invoke-1");
      return {
        ok: true,
        payload: { ok: true, value: 1 },
        payloadJSON: null,
        error: null,
      };
    });

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      onNodeCommandDispatched: () => dispatchOrder.push("dispatched"),
    });

    expect(result).toMatchObject({ ok: true });
    expect(dispatchOrder).toStrictEqual(["node transport", "dispatched"]);
  });

  it("keeps plugin-owned work pre-dispatch when the node transport rejects the send", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    const { context, invoke } = createContext();
    const onNodeCommandDispatched = vi.fn();
    invoke.mockResolvedValueOnce({
      ok: false,
      payload: null,
      payloadJSON: null,
      error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
    });

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      onNodeCommandDispatched,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "UNAVAILABLE",
      details: {
        nodeError: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
        nodeCommandDispatched: false,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ onDispatchReady: expect.any(Function) }),
    );
    expect(onNodeCommandDispatched).not.toHaveBeenCalled();
  });

  it("rejects expired plugin-owned work without dispatching it", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    const { context, invoke } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      timeoutMs: 1_000,
      resolveRemainingTimeoutMs: () => 0,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "TIMEOUT",
      details: { nodeCommandDispatched: false },
    });
    expect(invoke).not.toHaveBeenCalled();
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
          nodes: {
            commands: allowCommand ? { allow: [DEMO_COMMAND] } : { deny: [DEMO_COMMAND] },
          },
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

  it("rejects plugin transport dispatch after invocation ownership changes", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    const { context, invoke } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      isInvocationCurrent: async () => false,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "PAIRING_CHANGED",
      details: { nodeCommandDispatched: false },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects plugin transport dispatch when runtime authority closes during pairing recheck", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    let authorityActive = true;
    let releasePairingCheck: (() => void) | undefined;
    const pairingCheck = new Promise<void>((resolve) => {
      releasePairingCheck = resolve;
    });
    const { context, invoke } = createContext({
      validateAgentRuntimeApprovalAuthority: () => authorityActive,
    });
    const operationalRunInstance = createOperationalRunInstanceRef("run-node-policy-race");
    const resultPromise = applyPluginNodeInvokePolicy({
      context,
      client: {
        ...createOperatorClient(),
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:test",
            operationalRunInstance,
            delegatedAuthority: {
              kind: "local",
              operationalRunInstance,
              lifecycleGeneration: "generation",
              claimId: "claim",
            },
          },
        },
      },
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      isInvocationCurrent: async () => {
        await pairingCheck;
        return true;
      },
    });

    await vi.waitFor(() => expect(releasePairingCheck).toBeTypeOf("function"));
    authorityActive = false;
    releasePairingCheck?.();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      code: "APPROVAL_AUTHORITY_CLOSED",
      details: { nodeCommandDispatched: false },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects bridged approval dispatch when its record closes during pairing recheck", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    let approvalActive = true;
    let releasePairingCheck: (() => void) | undefined;
    const pairingCheck = new Promise<void>((resolve) => {
      releasePairingCheck = resolve;
    });
    const { context, invoke } = createContext();
    const resultPromise = applyPluginNodeInvokePolicy({
      context,
      client: createOperatorClient(),
      nodeSession: createNodeSession(),
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      isInvocationCurrent: async () => {
        await pairingCheck;
        return true;
      },
      isApprovalAuthorityActive: () => approvalActive,
    });

    await vi.waitFor(() => expect(releasePairingCheck).toBeTypeOf("function"));
    approvalActive = false;
    releasePairingCheck?.();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      code: "APPROVAL_AUTHORITY_CLOSED",
      details: { nodeCommandDispatched: false },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects plugin transport dispatch through an invalidated node session", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    const nodeSession = createNodeSession();
    nodeSession.client.invalidated = true;
    const { context, invoke } = createContext({ nodeSession });

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession,
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "PAIRING_CHANGED",
      details: { nodeCommandDispatched: false },
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

  it("sanitizes node-policy approval titles at creation like the RPC ingress", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    const getApprovalClientConnIds = createApprovalClientLookup([
      createApprovalClient({
        connId: "conn-owner-approval",
        clientId: "client-owner",
        deviceId: "device-owner",
      }),
    ]);
    setDangerousDemoCommandRegistry([
      // Bidi override + zero-width space: reviewer-spoofing characters.
      createApprovalRequestPolicy({
        title: "Deploy‮yolped",
        description: "safe​text",
        toolName: "tool‮run",
        agentId: "agent​x",
      }),
    ]);
    const { context } = createContext({ pluginApprovalManager: manager, getApprovalClientConnIds });
    const resultPromise = invokeDemoPolicy(context, createOperatorClient());

    const record = await expectSinglePendingApproval(manager);
    expect(record.request.title).toBe("Deploy\\u{202E}yolped");
    expect(record.request.description).toBe("safe\\u{200B}text");
    // Metadata is interpolated into channel approval text lines.
    expect(record.request.toolName).toBe("tool\\u{202E}run");
    expect(record.request.agentId).toBe("agent\\u{200B}x");

    await expectApprovalResolution(resultPromise, manager, record);
  });

  it("forwards plugin policy approvals to the originating turn source", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const getApprovalClientConnIds = vi.fn(() => new Set<string>());
    const handlePluginApprovalRequested = vi.fn(async () => true);
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds,
      hasExecApprovalClients: vi.fn(() => false),
      forwardPluginApprovalRequest: handlePluginApprovalRequested,
      validateAgentRuntimeApprovalAuthority: () => true,
    });
    const operationalRunInstance = createOperationalRunInstanceRef("run-node-policy");
    const resultPromise = applyPluginNodeInvokePolicy({
      context,
      client: {
        ...createOperatorClient(),
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:alice",
            operationalRunInstance,
            delegatedAuthority: {
              kind: "local",
              operationalRunInstance,
              lifecycleGeneration: "test-generation",
              claimId: "test-claim",
            },
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

  it("delivers plugin policy approvals to visible iOS reviewers", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    const handleRequested = vi.fn(
      async (
        _request: PluginApprovalRequest,
        _opts?: {
          isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
        },
      ) => true,
    );
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: vi.fn(() => new Set<string>()),
      hasExecApprovalClients: vi.fn(() => false),
      pluginApprovalIosPushDelivery: { handleRequested },
    });

    const resultPromise = invokeDemoPolicy(context, createOperatorClient());
    const record = await expectSinglePendingApproval(manager);

    expect(handleRequested).toHaveBeenCalledTimes(1);
    const deliveryOptions = handleRequested.mock.calls[0]?.[1];
    expect(
      deliveryOptions?.isTargetVisible?.({
        deviceId: "device-owner",
        scopes: ["operator.approvals", "operator.read"],
      }),
    ).toBe(true);
    expect(
      deliveryOptions?.isTargetVisible?.({
        deviceId: "device-other",
        scopes: ["operator.approvals", "operator.read"],
      }),
    ).toBe(false);

    await expectApprovalResolution(resultPromise, manager, record);
  });

  it("sends an iOS cleanup wake when a plugin policy approval expires", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    const handleExpired = vi.fn(async () => {});
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: vi.fn(() => new Set<string>()),
      hasExecApprovalClients: vi.fn(() => false),
      pluginApprovalIosPushDelivery: {
        handleRequested: vi.fn(async () => true),
        handleExpired,
      },
    });

    const resultPromise = invokeDemoPolicy(context, createOperatorClient());
    const record = await expectSinglePendingApproval(manager);
    manager.expire(record.id, "timeout");

    await expect(resultPromise).resolves.toStrictEqual({
      ok: true,
      payload: { id: record.id, decision: null },
    });
    expect(handleExpired).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
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

  it("fails closed when the allow-once claim cannot be consumed", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>();
    vi.spyOn(manager, "consumeAllowOnce").mockReturnValue(false);
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
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
    expect(manager.resolve(record.id, "allow-once")).toBe(true);

    await expect(resultPromise).resolves.toStrictEqual({
      ok: true,
      payload: { id: record.id, decision: null },
    });
  });

  it("fails closed before routing an unrenderable persistent policy approval", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-policy-approval-"));
    tempDirs.push(stateDir);
    const databaseOptions = { path: path.join(stateDir, "state.sqlite") };
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence: { runtimeEpoch: "node-policy-test", databaseOptions },
      resolveAllowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions,
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
