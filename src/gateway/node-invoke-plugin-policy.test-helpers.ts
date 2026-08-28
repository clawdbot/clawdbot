/** Shared harness for node invoke plugin-policy tests. */
import { expect, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeInvokeResult, NodeSession } from "./node-registry.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

export const DEMO_PLUGIN_ID = "demo";
export const DEMO_COMMAND = "demo.read";
export const DEMO_PARAMS = { path: "/tmp/x" };

export function createNodeSession(): NodeSession {
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

export function nodeCommandsConfig(commands: { allow?: string[]; deny?: string[] }) {
  return { gateway: { nodes: { commands } } };
}

export function createContext(opts?: {
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
      onProgress?: (chunk: string) => void;
      isDispatchAuthorized?: () => boolean;
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
        opts?.getRuntimeConfig ?? (() => nodeCommandsConfig({ allow: [DEMO_COMMAND] })),
      nodeRegistry: {
        get: () => nodeSession,
        getForPairingGeneration: () => nodeSession,
        invoke,
      },
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

export function createApprovalClient(params: {
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

export function createApprovalClientLookup(clients: GatewayClient[]): ApprovalClientLookup {
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

export function createOperatorClient(connId = "conn-requester"): GatewayClient {
  return createApprovalClient({
    connId,
    clientId: "client-owner",
    deviceId: "device-owner",
  });
}

export type NodeInvokePolicyRegistration = PluginRegistry["nodeInvokePolicies"][number];
type NodeInvokePolicyHandler = NodeInvokePolicyRegistration["policy"]["handle"];
export type PluginApprovalRecord = ReturnType<
  ExecApprovalManager<PluginApprovalRequestPayload>["listPendingRecords"]
>[number];

export function createDemoPolicy(handle: NodeInvokePolicyHandler): NodeInvokePolicyRegistration {
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

export function createApprovalRequestPolicy(params?: {
  timeoutMs?: number;
  title?: string;
  description?: string;
  toolName?: string;
  agentId?: string;
  allowedDecisions?: readonly ("allow-once" | "allow-always" | "deny")[];
}): NodeInvokePolicyRegistration {
  return createDemoPolicy(async (ctx: OpenClawPluginNodeInvokePolicyContext) => {
    const approval = await ctx.approvals?.request({
      title: params?.title ?? "Sensitive action",
      description: params?.description ?? "Needs approval",
      ...(params?.toolName === undefined ? {} : { toolName: params.toolName }),
      ...(params?.agentId === undefined ? {} : { agentId: params.agentId }),
      ...(params?.allowedDecisions === undefined
        ? {}
        : { allowedDecisions: params.allowedDecisions }),
      ...(params?.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    });
    return { ok: true, payload: approval ?? null };
  });
}

export function setDangerousDemoCommandRegistry(policies: NodeInvokePolicyRegistration[] = []) {
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

export async function invokeDemoPolicy(
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

export async function expectSinglePendingApproval(
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

export async function expectApprovalResolution(
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
