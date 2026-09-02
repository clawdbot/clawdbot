// Plugin-provided node.invoke policy adapter.
// Lets plugin policies gate dangerous node commands before transport dispatch.
import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { recordRuntimeActionDecision } from "../audit/runtime-action-decision.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginNodeInvokeTransportResult,
} from "../plugins/types.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import {
  consumeNodeInvokePlacementGrant,
  type NodeInvokePlacementGrantAuthorization,
} from "./node-invoke-placement-grant.js";
import { createPluginNodeInvokeApprovalRuntime } from "./node-invoke-plugin-approval.js";
import { invokeNodeWithReadinessRetry } from "./node-invoke-readiness.js";
import type { NodeInvokeResult, NodeSession } from "./node-registry.js";
import type { GatewayNodeInvokeStream } from "./server-methods/shared-types.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

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

function validateRiskClassification(
  value: NonNullable<OpenClawPluginNodeInvokePolicyContext["risk"]>,
): NonNullable<OpenClawPluginNodeInvokePolicyContext["risk"]> | null {
  const family = normalizeOptionalString(value?.family);
  if (
    (value?.level !== "ordinary" && value?.level !== "high") ||
    !family ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(family)
  ) {
    return null;
  }
  return { level: value.level, family };
}

function resolveStandingApprovalScope(value: unknown): string | undefined {
  const approval = asOptionalRecord(value);
  const scope = normalizeOptionalString(approval?.scope);
  return approval?.kind === "placement" && scope && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(scope)
    ? scope
    : undefined;
}

/** Host-owned dispatch binding; private endpoints supply a separately probed capability declaration. */
export type PluginNodeInvokePrivateTransport = {
  commands?: readonly string[];
  isCurrent: () => boolean;
  invoke: (params: {
    params: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    idempotencyKey?: string;
    isDispatchAuthorized: () => boolean;
    onDispatchReady: (invokeId: string) => void;
  }) => Promise<NodeInvokeResult>;
};

/** Applies the registered plugin policy for a node.invoke command, if one exists. */
export async function applyPluginNodeInvokePolicy(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  nodeSession: NodeSession;
  command: string;
  params: unknown;
  sessionKey?: string;
  turnSource?: {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
    threadId?: unknown;
  };
  timeoutMs?: number;
  signal?: AbortSignal;
  resolveRemainingTimeoutMs?: () => number | undefined;
  onNodeCommandDispatched?: () => void;
  nodeInvokeStream?: GatewayNodeInvokeStream;
  idempotencyKey?: string;
  isInvocationCurrent?: () => boolean | Promise<boolean>;
  isApprovalAuthorityActive?: () => boolean;
  privateTransport?: PluginNodeInvokePrivateTransport;
  /** Internal callers carry an admitted run without inventing a client connection. */
  agentRuntimeIdentity?: AgentRuntimeIdentity;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const registry = getActivePluginGatewayNodePolicyRegistry();
  const callerIdentity =
    params.agentRuntimeIdentity ?? params.client?.internal?.agentRuntimeIdentity;
  const token = callerIdentity?.executionIdentity;
  const isCallerRuntimeAuthorityActive = () =>
    !callerIdentity ||
    params.context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) === true;
  const decisionOccurrenceId = randomUUID();
  let receiptOrdinal = 0;
  const recordNodeDecision = (input: {
    pluginId: string;
    outcome: "allowed" | "denied" | "unknown";
    coverageState: "enforced" | "attribution-only" | "unknown";
    reasonCode: string;
    summary: string;
    missingEvidence?: string[];
    remediation?: Array<{ code: string; text: string }>;
  }) => {
    receiptOrdinal += 1;
    recordRuntimeActionDecision({
      token,
      family: "node",
      operation: "invoke",
      outcome: input.outcome,
      coverageState: input.coverageState,
      reasonCode: input.reasonCode,
      owner: "node-runtime",
      decisionBoundary: "gateway.node-invoke-plugin-policy",
      policyRefs: ["node:pairing", "node:command-capability", "plugin:node-invoke-policy"],
      summary: input.summary,
      missingEvidence: input.missingEvidence,
      remediation: input.remediation ?? [],
      discriminator: JSON.stringify([
        input.pluginId,
        params.nodeSession.nodeId,
        params.command,
        decisionOccurrenceId,
        receiptOrdinal,
      ]),
    });
  };
  // Route metadata comes only from an authenticated or host-bound agent runtime.
  const trustedTurnSource = callerIdentity ? params.turnSource : undefined;
  const entry = registry?.nodeInvokePolicies?.find((candidate) =>
    candidate.policy.commands.includes(params.command),
  );
  if (!entry) {
    const dangerousCommand = findDangerousPluginNodeCommand(registry, params.command);
    if (dangerousCommand) {
      recordNodeDecision({
        pluginId: dangerousCommand.pluginId,
        outcome: "denied",
        coverageState: "enforced",
        reasonCode: "node_plugin_policy_missing",
        summary: "A dangerous plugin-owned node command was denied because its policy was missing.",
      });
      return {
        ok: false,
        code: "PLUGIN_POLICY_MISSING",
        message: `node.invoke ${params.command} is registered as dangerous by plugin ${dangerousCommand.pluginId} but has no plugin node.invoke policy`,
        details: { nodeCommandDispatched: false },
      };
    }
    return null;
  }

  let risk: OpenClawPluginNodeInvokePolicyContext["risk"];
  if (entry.policy.classifyRisk) {
    try {
      risk =
        validateRiskClassification(
          entry.policy.classifyRisk({ command: params.command, params: params.params }),
        ) ?? undefined;
    } catch {
      // Argument classifiers run before the policy handler and transport. Do
      // not expose rejected arguments or plugin exception text to the caller.
    }
    if (!risk) {
      recordNodeDecision({
        pluginId: entry.pluginId,
        outcome: "denied",
        coverageState: "enforced",
        reasonCode: "node_risk_classification_failed",
        summary:
          "A plugin-owned node command was denied before transport after risk classification failed.",
      });
      return {
        ok: false,
        code: "PLUGIN_POLICY_RISK_CLASSIFICATION_FAILED",
        message: `node.invoke ${params.command} arguments could not be classified by plugin ${entry.pluginId}`,
        details: { nodeCommandDispatched: false },
      };
    }
  }
  const approvalScope = resolveStandingApprovalScope(entry.policy.standingApproval);

  let nodeCommandDispatched = false;
  let nodeGateDecisionRecorded = false;
  const standingGrantAuthorization: NodeInvokePlacementGrantAuthorization = {};
  const pluginRecord = registry?.plugins.find((record) => record.id === entry.pluginId);
  const policy = entry.policy;
  const isPluginCurrent = () =>
    getActivePluginGatewayNodePolicyRegistry() === registry &&
    entry.policy === policy &&
    registry?.nodeInvokePolicies.includes(entry) === true &&
    (!pluginRecord ||
      (registry.plugins.includes(pluginRecord) &&
        pluginRecord.enabled &&
        pluginRecord.status === "loaded"));
  const dispatchNode = async (
    override: Parameters<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>[0] = {},
    sessionAuthority?: { assertCurrent: () => void; signal: AbortSignal },
  ): Promise<OpenClawPluginNodeInvokeTransportResult> => {
    const deny = (
      reasonCode: string,
      result: OpenClawPluginNodeInvokeTransportResult,
    ): OpenClawPluginNodeInvokeTransportResult => {
      nodeGateDecisionRecorded = true;
      recordNodeDecision({
        pluginId: entry.pluginId,
        outcome: "denied",
        coverageState: "enforced",
        reasonCode,
        summary: "A plugin-owned node command was denied at the Gateway dispatch gate.",
      });
      return result;
    };
    sessionAuthority?.assertCurrent();
    if (!isCallerRuntimeAuthorityActive()) {
      return deny("node_runtime_authority_closed", {
        ok: false,
        code: "APPROVAL_AUTHORITY_CLOSED",
        message: "agent runtime approval authority closed before node dispatch",
      });
    }
    // Policies invoke the real node through this narrowed transport wrapper so
    // they can retry/override params without getting direct registry access.
    if (params.isInvocationCurrent && !(await params.isInvocationCurrent())) {
      return deny("node_pairing_changed", {
        ok: false,
        code: "PAIRING_CHANGED",
        message: "node pairing changed before dispatch",
      });
    }
    const currentNode = params.nodeSession.pairingGeneration
      ? params.context.nodeRegistry.getForPairingGeneration(
          params.nodeSession.nodeId,
          params.nodeSession.pairingGeneration,
        )
      : params.context.nodeRegistry.get(params.nodeSession.nodeId);
    if (!currentNode || currentNode.connId !== params.nodeSession.connId) {
      return deny("node_route_changed", {
        ok: false,
        code: "ROUTE_CHANGED",
        message: "node connection changed before dispatch",
      });
    }
    if (currentNode.client.invalidated === true) {
      return deny("node_pairing_changed", {
        ok: false,
        code: "PAIRING_CHANGED",
        message: "node pairing changed before dispatch",
      });
    }
    // A private owner supplies only its probed capability declaration. The
    // public node advertisement remains untouched, and config denies still win.
    const resolveCommandAuthorization = () => {
      const declaredCommands = params.privateTransport?.commands
        ? [...params.privateTransport.commands]
        : currentNode.commands;
      return isNodeCommandAllowed({
        command: params.command,
        declaredCommands,
        allowlist: resolveNodeCommandAllowlist(params.context.getRuntimeConfig(), {
          ...currentNode,
          approvedCommands: declaredCommands,
        }),
      });
    };
    const allowed = resolveCommandAuthorization();
    if (!allowed.ok) {
      return deny("node_command_revoked", {
        ok: false,
        code: "NODE_COMMAND_REVOKED",
        message: `node command not allowed at dispatch: ${allowed.reason}`,
        details: { command: params.command, reason: allowed.reason },
      });
    }
    const remainingTimeoutMs = params.resolveRemainingTimeoutMs?.();
    if (remainingTimeoutMs === 0 && params.timeoutMs !== 0) {
      return deny("node_dispatch_timeout", {
        ok: false,
        code: "TIMEOUT",
        message: "node invoke timed out",
      });
    }
    const requestedTimeoutMs = override.timeoutMs ?? params.timeoutMs;
    const timeoutMs =
      typeof remainingTimeoutMs === "number" && remainingTimeoutMs > 0
        ? typeof requestedTimeoutMs === "number" && requestedTimeoutMs > 0
          ? Math.min(requestedTimeoutMs, remainingTimeoutMs)
          : remainingTimeoutMs
        : requestedTimeoutMs;
    // Pairing and policy checks above may await. Revalidate the exact runtime
    // capability at the final transport handoff so closure wins that race.
    sessionAuthority?.assertCurrent();
    if (params.privateTransport?.isCurrent() === false) {
      return deny("node_private_owner_closed", {
        ok: false,
        code: "PRIVATE_OWNER_CLOSED",
        message: "private node invocation owner closed before dispatch",
      });
    }
    if (!isPluginCurrent()) {
      return deny("node_plugin_replaced", {
        ok: false,
        code: "PLUGIN_POLICY_CHANGED",
        message: "node plugin policy changed before dispatch",
      });
    }
    if (!isCallerRuntimeAuthorityActive()) {
      return deny("node_runtime_authority_closed", {
        ok: false,
        code: "APPROVAL_AUTHORITY_CLOSED",
        message: "agent runtime approval authority closed before node dispatch",
      });
    }
    if (params.isApprovalAuthorityActive?.() === false) {
      return deny("node_approval_authority_closed", {
        ok: false,
        code: "APPROVAL_AUTHORITY_CLOSED",
        message: "approved runtime authority closed before node dispatch",
      });
    }
    recordNodeDecision({
      pluginId: entry.pluginId,
      outcome: "allowed",
      coverageState: "enforced",
      reasonCode: "node_dispatch_gate_allowed",
      summary:
        "Gateway node pairing, capability, and plugin policy gates allowed transport dispatch.",
    });
    nodeGateDecisionRecorded = true;
    const request = {
      nodeId: params.nodeSession.nodeId,
      expectedConnId: params.nodeSession.connId,
      ...(params.nodeSession.pairingGeneration
        ? { expectedPairingGeneration: params.nodeSession.pairingGeneration }
        : {}),
      command: params.command,
      params: override.params ?? params.params,
      timeoutMs,
      ...(sessionAuthority
        ? {
            signal: params.signal
              ? AbortSignal.any([params.signal, sessionAuthority.signal])
              : sessionAuthority.signal,
          }
        : params.signal
          ? { signal: params.signal }
          : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      idempotencyKey: override.idempotencyKey ?? params.idempotencyKey,
      ...(params.nodeInvokeStream && {
        onProgress: params.nodeInvokeStream.onProgress,
        idleTimeoutMs: params.nodeInvokeStream.idleTimeoutMs,
      }),
      isDispatchAuthorized: () => {
        try {
          sessionAuthority?.assertCurrent();
        } catch {
          return false;
        }
        const current =
          isPluginCurrent() &&
          params.privateTransport?.isCurrent() !== false &&
          (params.nodeInvokeStream?.isRuntimeCurrent() ?? true) &&
          isCallerRuntimeAuthorityActive() &&
          params.isApprovalAuthorityActive?.() !== false &&
          resolveCommandAuthorization().ok;
        if (!current) {
          return false;
        }
        const grantOutcome = consumeNodeInvokePlacementGrant({
          runtime: params.context.placementStandingGrants,
          authorization: standingGrantAuthorization,
        });
        if (grantOutcome === "rejected") {
          return false;
        }
        if (grantOutcome === "consumed") {
          recordNodeDecision({
            pluginId: entry.pluginId,
            outcome: "allowed",
            coverageState: "enforced",
            reasonCode: "node_placement_standing_grant_consumed",
            summary: "A placement-scoped standing grant authorized the node transport dispatch.",
          });
        }
        return true;
      },
      onDispatchReady: (invokeId: string) => {
        // Only the registry knows that the transport send succeeded. Preserve
        // pre-send failures as retry-safe while making later failures ambiguous.
        nodeCommandDispatched = true;
        params.onNodeCommandDispatched?.();
        params.nodeInvokeStream?.onDispatchReady(invokeId);
      },
    };
    const res = params.privateTransport
      ? await params.privateTransport.invoke(request)
      : await invokeNodeWithReadinessRetry(params.context.nodeRegistry, request);
    if (!res.ok) {
      if (nodeCommandDispatched) {
        recordNodeDecision({
          pluginId: entry.pluginId,
          outcome: "unknown",
          coverageState: "unknown",
          reasonCode: "node_action_completion_unknown",
          summary:
            "The node transport accepted the action but did not report a successful outcome.",
          missingEvidence: ["node.action_completion"],
          remediation: [
            {
              code: "inspect_node_action",
              text: "Inspect the paired node before retrying an action whose completion is unknown.",
            },
          ],
        });
      }
      return {
        ok: false,
        code: res.error?.code,
        message: res.error?.message ?? "node command failed",
        details: { nodeError: res.error ?? null },
      };
    }
    recordNodeDecision({
      pluginId: entry.pluginId,
      outcome: "allowed",
      coverageState: "attribution-only",
      reasonCode: "node_action_completed",
      summary:
        "The paired node reported successful completion; this is attribution, not authorization.",
    });
    return {
      ok: true,
      payload: parsePayload(res.payloadJSON, res.payload),
      payloadJSON: res.payloadJSON ?? null,
    };
  };
  const scope = getPluginRuntimeGatewayRequestScope();
  const ownedInvocation =
    params.nodeInvokeStream && params.client?.internal?.pluginRuntimeOwnerId === entry.pluginId
      ? scope?.invokeWithSessionNodeAuthority
      : undefined;
  const invokeOwned = (
    source: "human-approved" | "session-full",
    override: NonNullable<Parameters<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>[0]>,
    createParams?: () => unknown,
  ) =>
    ownedInvocation && override.workspace
      ? ownedInvocation(
          {
            pluginId: entry.pluginId,
            command: params.command,
            nodeId: params.nodeSession.nodeId,
            workspace: override.workspace,
            source,
          },
          async (assertCurrent, signal) => {
            if (params.sessionKey !== override.workspace?.sessionKey) {
              throw new Error("Node launch requires its authenticated outer session");
            }
            return await dispatchNode(
              createParams ? { ...override, params: createParams() } : override,
              { assertCurrent, signal },
            );
          },
        )
      : undefined;
  const invokeNode: OpenClawPluginNodeInvokePolicyContext["invokeNode"] = async (override = {}) => {
    if (!ownedInvocation || !override.workspace) {
      return await dispatchNode(override);
    }
    const result = await invokeOwned("human-approved", override);
    if (!result) {
      throw new Error("Node launch lost its admitted owner");
    }
    return result;
  };

  let result: OpenClawPluginNodeInvokePolicyResult;
  try {
    result = await entry.policy.handle({
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
      ...(risk ? { risk } : {}),
      approvals: createPluginNodeInvokeApprovalRuntime({
        context: params.context,
        client: params.client,
        callerIdentity,
        pluginId: entry.pluginId,
        command: params.command,
        ...(approvalScope ? { approvalScope } : {}),
        nodeSession: params.nodeSession,
        risk,
        standingGrantAuthorization,
        ...(scope?.nodePlacementGrantAuthority
          ? { placementGrantAuthority: scope.nodePlacementGrantAuthority }
          : {}),
        turnSource: trustedTurnSource,
        isCurrent: () =>
          isPluginCurrent() &&
          isCallerRuntimeAuthorityActive() &&
          params.privateTransport?.isCurrent() !== false &&
          params.isApprovalAuthorityActive?.() !== false,
      }),
      invokeNode,
      ...(ownedInvocation
        ? {
            invokeNodeWithSessionFull: async ({ workspace, createParams }) =>
              await invokeOwned("session-full", { workspace }, createParams),
          }
        : {}),
    });
  } catch (error) {
    // Plugin policy handlers may settle after their exact caller authority
    // closes. Never attribute that late result to the retired run.
    if (!nodeCommandDispatched && isCallerRuntimeAuthorityActive()) {
      recordNodeDecision({
        pluginId: entry.pluginId,
        outcome: "denied",
        coverageState: "enforced",
        reasonCode: "node_plugin_policy_failed",
        summary: "The registered plugin policy failed closed before node transport dispatch.",
      });
    }
    throw error;
  }
  if (!nodeCommandDispatched && !nodeGateDecisionRecorded && isCallerRuntimeAuthorityActive()) {
    recordNodeDecision({
      pluginId: entry.pluginId,
      outcome: result.ok ? "unknown" : "denied",
      coverageState: result.ok ? "unknown" : "enforced",
      reasonCode: result.ok ? "node_action_callback_missing" : "node_plugin_policy_denied",
      summary: result.ok
        ? "The plugin policy returned without invoking the expected OpenClaw node callback."
        : "The registered plugin policy denied node transport dispatch.",
      missingEvidence: result.ok ? ["node.action_callback"] : [],
      remediation: result.ok
        ? [
            {
              code: "add_node_action_callback",
              text: "Route the native action through the provided OpenClaw node callback.",
            },
          ]
        : [],
    });
  }
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
