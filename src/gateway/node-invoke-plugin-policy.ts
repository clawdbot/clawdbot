import { randomUUID } from "node:crypto";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS } from "../infra/plugin-approvals.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type {
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginNodeInvokeTransportResult,
} from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { NodeSession } from "./node-registry.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

function parseScopes(client: GatewayClient | null): string[] {
  return Array.isArray(client?.connect?.scopes)
    ? client.connect.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
}

function parsePayload(payloadJSON: string | null | undefined, payload: unknown): unknown {
  if (!payloadJSON) {
    return payload;
  }
  try {
    return JSON.parse(payloadJSON) as unknown;
  } catch {
    return payload;
  }
}

function findDangerousPluginNodeCommand(registry: PluginRegistry | null, command: string) {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return null;
  }
  return (
    registry?.nodeHostCommands?.find(
      (entry) =>
        entry.command.dangerous === true && entry.command.command.trim() === normalizedCommand,
    ) ?? null
  );
}

function createApprovalRuntime(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  pluginId: string;
}): OpenClawPluginNodeInvokePolicyContext["approvals"] | undefined {
  const manager = params.context.pluginApprovalManager;
  if (!manager) {
    return undefined;
  }
  return {
    async request(input) {
      const timeoutMs =
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
          ? input.timeoutMs
          : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
      const request: PluginApprovalRequestPayload = {
        pluginId: params.pluginId,
        title: input.title.slice(0, 80),
        description: input.description.slice(0, 256),
        severity: input.severity ?? "warning",
        toolName: normalizeOptionalString(input.toolName) ?? null,
        toolCallId: normalizeOptionalString(input.toolCallId) ?? null,
        agentId: normalizeOptionalString(input.agentId) ?? null,
        sessionKey: normalizeOptionalString(input.sessionKey) ?? null,
      };
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      const decisionPromise = manager.register(record, timeoutMs);
      const requestEvent = {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      };
      params.context.broadcast("plugin.approval.requested", requestEvent, {
        dropIfSlow: true,
      });
      const hasApprovalClients =
        params.context.hasExecApprovalClients?.(params.client?.connId) ?? false;
      if (!hasApprovalClients) {
        manager.expire(record.id, "no-approval-route");
        return { id: record.id, decision: null };
      }
      const decision = await decisionPromise;
      return { id: record.id, decision };
    },
  };
}

export async function applyPluginNodeInvokePolicy(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  nodeSession: NodeSession;
  command: string;
  params: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const registry = getActiveRuntimePluginRegistry();
  const entry = registry?.nodeInvokePolicies?.find((candidate) =>
    candidate.policy.commands.includes(params.command),
  );
  if (!entry) {
    const dangerousCommand = findDangerousPluginNodeCommand(registry, params.command);
    if (dangerousCommand) {
      return {
        ok: false,
        code: "PLUGIN_POLICY_MISSING",
        message: `node.invoke ${params.command} is registered as dangerous by plugin ${dangerousCommand.pluginId} but has no plugin node.invoke policy`,
      };
    }
    return null;
  }

  const invokeNode: OpenClawPluginNodeInvokePolicyContext["invokeNode"] = async (
    override = {},
  ): Promise<OpenClawPluginNodeInvokeTransportResult> => {
    const res = await params.context.nodeRegistry.invoke({
      nodeId: params.nodeSession.nodeId,
      command: params.command,
      params: override.params ?? params.params,
      timeoutMs: override.timeoutMs ?? params.timeoutMs,
      idempotencyKey: override.idempotencyKey ?? params.idempotencyKey,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: res.error?.code,
        message: res.error?.message ?? "node command failed",
        details: { nodeError: res.error ?? null },
      };
    }
    return {
      ok: true,
      payload: parsePayload(res.payloadJSON, res.payload),
      payloadJSON: res.payloadJSON ?? null,
    };
  };

  return await entry.policy.handle({
    nodeId: params.nodeSession.nodeId,
    command: params.command,
    params: params.params,
    timeoutMs: params.timeoutMs,
    idempotencyKey: params.idempotencyKey,
    config: params.context.getRuntimeConfig(),
    pluginConfig: entry.pluginConfig,
    node: {
      nodeId: params.nodeSession.nodeId,
      displayName: params.nodeSession.displayName,
      platform: params.nodeSession.platform,
      deviceFamily: params.nodeSession.deviceFamily,
      commands: params.nodeSession.commands,
    },
    client: params.client
      ? {
          connId: params.client.connId,
          scopes: parseScopes(params.client),
        }
      : null,
    approvals: createApprovalRuntime({
      context: params.context,
      client: params.client,
      pluginId: entry.pluginId,
    }),
    invokeNode,
  });
}
