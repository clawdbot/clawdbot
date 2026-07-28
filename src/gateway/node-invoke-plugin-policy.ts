// Plugin-provided node.invoke policy adapter.
// Lets plugin policies gate dangerous node commands before transport dispatch.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resolvePluginApprovalTimeoutMs } from "../infra/plugin-approvals.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime.js";
import type {
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginNodeInvokeTransportResult,
} from "../plugins/types.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import type { NodeSession } from "./node-registry.js";
import { runApprovalRequestDeliveries } from "./server-methods/approval-request-delivery.js";
import {
  bindApprovalRequesterMetadata,
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
} from "./server-methods/approval-shared.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";

// Plugin node.invoke policies are the last gateway-side guard before a
// plugin-declared dangerous node command reaches the node transport.
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

function normalizeRouteThreadId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return normalizeOptionalString(value) ?? null;
}

function resolveNodeInvokeTurnSourceFields(
  turnSource:
    | {
        channel?: unknown;
        to?: unknown;
        accountId?: unknown;
        threadId?: unknown;
      }
    | undefined,
): Pick<
  PluginApprovalRequestPayload,
  "turnSourceChannel" | "turnSourceTo" | "turnSourceAccountId" | "turnSourceThreadId"
> {
  return {
    turnSourceChannel: normalizeOptionalString(turnSource?.channel) ?? null,
    turnSourceTo: normalizeOptionalString(turnSource?.to) ?? null,
    turnSourceAccountId: normalizeOptionalString(turnSource?.accountId) ?? null,
    turnSourceThreadId: normalizeRouteThreadId(turnSource?.threadId),
  };
}

// Dangerous commands must have an explicit policy. Without this check, a plugin
// could mark a command dangerous but rely on the gateway default allow path.
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
  turnSource: Parameters<typeof resolveNodeInvokeTurnSourceFields>[0];
}): OpenClawPluginNodeInvokePolicyContext["approvals"] | undefined {
  const manager = params.context.pluginApprovalManager;
  if (!manager) {
    return undefined;
  }
  return {
    async request(input) {
      const timeoutMs = resolvePluginApprovalTimeoutMs(input.timeoutMs);
      const turnSource = resolveNodeInvokeTurnSourceFields(params.turnSource);
      const callerIdentity = params.client?.internal?.agentRuntimeIdentity;
      const request: PluginApprovalRequestPayload = {
        pluginId: params.pluginId,
        title: truncateUtf16Safe(input.title, 80),
        description: truncateUtf16Safe(input.description, 256),
        severity: input.severity ?? "warning",
        toolName: normalizeOptionalString(input.toolName) ?? null,
        toolCallId: normalizeOptionalString(input.toolCallId) ?? null,
        agentId: callerIdentity?.agentId ?? normalizeOptionalString(input.agentId) ?? null,
        sessionKey: callerIdentity?.sessionKey ?? normalizeOptionalString(input.sessionKey) ?? null,
        turnSourceChannel: turnSource.turnSourceChannel,
        turnSourceTo: turnSource.turnSourceTo,
        turnSourceAccountId: turnSource.turnSourceAccountId,
        turnSourceThreadId: turnSource.turnSourceThreadId,
      };
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      bindApprovalRequesterMetadata({ record, client: params.client });
      const respond: RespondFn = () => {};
      // Register directly: persistence and presentation-validation failures
      // must throw so the plugin policy fails closed before any request
      // routing. The RPC storage-unavailable respond path does not apply to
      // this runtime-internal caller.
      const decisionPromise = manager.register(record, timeoutMs);
      const requestEvent = buildRequestedApprovalEvent(record);
      const forwardRequest = params.context.forwardPluginApprovalRequest;
      const iosPushRequest = params.context.pluginApprovalIosPushDelivery?.handleRequested?.bind(
        params.context.pluginApprovalIosPushDelivery,
      );
      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context: params.context,
        clientConnId: params.client?.connId,
        requestEventName: "plugin.approval.requested",
        requestEvent,
        twoPhase: false,
        approvalKind: "plugin",
        deliverRequest: () =>
          runApprovalRequestDeliveries({
            context: params.context,
            record,
            forward: forwardRequest
              ? [
                  () => forwardRequest(requestEvent),
                  "plugin approvals: forward node policy request failed",
                ]
              : undefined,
            iosPush: iosPushRequest
              ? [
                  (isTargetVisible) => iosPushRequest(requestEvent, { isTargetVisible }),
                  "plugin approvals: iOS push node policy request failed",
                ]
              : undefined,
          }),
        afterDecision: async (decision) => {
          if (decision === null) {
            await params.context.pluginApprovalIosPushDelivery?.handleExpired?.(requestEvent);
          }
        },
        afterDecisionErrorLabel: "plugin approvals: iOS push node policy expire failed",
      });
      const decision = await decisionPromise;
      // This return hands execution authority to the plugin policy. Claim a
      // one-shot decision here so observation or retry cannot replay it.
      if (
        decision === "allow-once" &&
        !manager.consumeAllowOnce(record.id, `plugin.node.invoke:${record.id}`)
      ) {
        return { id: record.id, decision: null };
      }
      return { id: record.id, decision };
    },
  };
}

/** Applies the registered plugin policy for a node.invoke command, if one exists. */
export async function applyPluginNodeInvokePolicy(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  nodeSession: NodeSession;
  command: string;
  params: unknown;
  turnSource?: {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
    threadId?: unknown;
  };
  timeoutMs?: number;
  idempotencyKey?: string;
  isInvocationCurrent?: () => boolean | Promise<boolean>;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const registry = getActivePluginGatewayNodePolicyRegistry();
  // Route metadata is authority-bearing: only a signed agent-runtime caller may nominate it.
  const trustedTurnSource = params.client?.internal?.agentRuntimeIdentity
    ? params.turnSource
    : undefined;
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
        details: { nodeCommandDispatched: false },
      };
    }
    return null;
  }

  let nodeCommandDispatched = false;
  const invokeNode: OpenClawPluginNodeInvokePolicyContext["invokeNode"] = async (
    override = {},
  ): Promise<OpenClawPluginNodeInvokeTransportResult> => {
    // Policies invoke the real node through this narrowed transport wrapper so
    // they can retry/override params without getting direct registry access.
    if (params.isInvocationCurrent && !(await params.isInvocationCurrent())) {
      return {
        ok: false,
        code: "PAIRING_CHANGED",
        message: "node pairing changed before dispatch",
      };
    }
    const currentNode = params.nodeSession.pairingGeneration
      ? params.context.nodeRegistry.getForPairingGeneration(
          params.nodeSession.nodeId,
          params.nodeSession.pairingGeneration,
        )
      : params.context.nodeRegistry.get(params.nodeSession.nodeId);
    if (!currentNode || currentNode.connId !== params.nodeSession.connId) {
      return {
        ok: false,
        code: "ROUTE_CHANGED",
        message: "node connection changed before dispatch",
      };
    }
    if (currentNode.client.invalidated === true) {
      return {
        ok: false,
        code: "PAIRING_CHANGED",
        message: "node pairing changed before dispatch",
      };
    }
    const currentConfig = params.context.getRuntimeConfig();
    const allowlist = resolveNodeCommandAllowlist(currentConfig, {
      ...currentNode,
      approvedCommands: currentNode.commands,
    });
    const allowed = isNodeCommandAllowed({
      command: params.command,
      declaredCommands: currentNode.commands,
      allowlist,
    });
    if (!allowed.ok) {
      return {
        ok: false,
        code: "NODE_COMMAND_REVOKED",
        message: `node command not allowed at dispatch: ${allowed.reason}`,
        details: { command: params.command, reason: allowed.reason },
      };
    }
    // Once the registry owns the request, any failure is ambiguous to callers:
    // the node may have acted before the response was lost or rejected.
    nodeCommandDispatched = true;
    const res = await params.context.nodeRegistry.invoke({
      nodeId: params.nodeSession.nodeId,
      expectedConnId: params.nodeSession.connId,
      ...(params.nodeSession.pairingGeneration
        ? { expectedPairingGeneration: params.nodeSession.pairingGeneration }
        : {}),
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

  const result = await entry.policy.handle({
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
      turnSource: trustedTurnSource,
    }),
    invokeNode,
  });
  if (result.ok) {
    return result;
  }
  return {
    ...result,
    // Core owns dispatch and must override a plugin-supplied claim. Callers may
    // clear speculative state only when this value is definitively false.
    details: { ...result.details, nodeCommandDispatched },
  };
}
