// Plugin-provided node.invoke policy adapter.
// Lets plugin policies gate dangerous node commands before transport dispatch.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { recordRuntimeActionDecision } from "../audit/runtime-action-decision.js";
import { sanitizeApprovalScope } from "../infra/approval-scope.js";
import {
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "../infra/exec-approval-text-sanitize.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resolvePluginApprovalTimeoutMs } from "../infra/plugin-approvals.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginNodeInvokeTransportResult,
} from "../plugins/types.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import { invokeNodeWithReadinessRetry } from "./node-invoke-readiness.js";
import type { NodeSession } from "./node-registry.js";
import { runApprovalRequestDeliveries } from "./server-methods/approval-request-delivery.js";
import {
  bindApprovalRequesterMetadata,
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
} from "./server-methods/approval-shared.js";
import type { GatewayNodeInvokeStream } from "./server-methods/shared-types.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";

// Plugin node.invoke policies are the last gateway-side guard before a
// plugin-declared dangerous node command reaches the node transport.
function sanitizeOptionalMeta(value?: string | null): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? sanitizeExecApprovalDisplayText(normalized) : null;
}

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
      if (
        callerIdentity &&
        params.context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) !== true
      ) {
        throw new Error("agent runtime approval authority is no longer active");
      }
      const request: PluginApprovalRequestPayload = {
        pluginId: params.pluginId,
        // Same creation-boundary sanitize as the RPC ingress: this record
        // feeds the identical broadcast/forwarder/push paths. Normalize first
        // so a whitespace-only title still fails closed at register (escaping
        // the whitespace would make an unrenderable prompt look renderable).
        title: truncateUtf16Safe(
          sanitizeExecApprovalDisplayText(normalizeOptionalString(input.title) ?? ""),
          80,
        ),
        description: truncateUtf16Safe(
          sanitizeExecApprovalWarningText(normalizeOptionalString(input.description) ?? ""),
          256,
        ),
        scope: input.scope ? sanitizeApprovalScope(input.scope) : null,
        severity: input.severity ?? "warning",
        ...(input.allowedDecisions === undefined
          ? {}
          : {
              allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions({
                allowedDecisions: input.allowedDecisions,
              }),
            }),
        // toolName/agentId are interpolated into channel approval text; only
        // host-minted runtime identity values skip the display escape.
        toolName: sanitizeOptionalMeta(input.toolName),
        toolCallId: normalizeOptionalString(input.toolCallId) ?? null,
        agentId: callerIdentity?.agentId ?? sanitizeOptionalMeta(input.agentId),
        sessionKey: callerIdentity?.sessionKey ?? normalizeOptionalString(input.sessionKey) ?? null,
        runId: callerIdentity?.operationalRunInstance.runId ?? null,
        turnSourceChannel: turnSource.turnSourceChannel,
        turnSourceTo: turnSource.turnSourceTo,
        turnSourceAccountId: turnSource.turnSourceAccountId,
        turnSourceThreadId: turnSource.turnSourceThreadId,
      };
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      if (callerIdentity) {
        record.agentRuntimeDelegatedAuthority = callerIdentity.delegatedAuthority;
        if (callerIdentity.executionIdentity) {
          record.executionIdentityToken = callerIdentity.executionIdentity;
        }
      }
      bindApprovalRequesterMetadata({ record, client: params.client });
      const respond: RespondFn = () => {};
      // Register directly: persistence and presentation-validation failures
      // must throw so the plugin policy fails closed before any request
      // routing. The RPC storage-unavailable respond path does not apply to
      // this runtime-internal caller.
      const decisionPromise = manager.register(record, timeoutMs);
      const requestEvent = buildRequestedApprovalEvent(record, "plugin");
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
        // The carried connection is turn/invoke provenance, never this
        // approval's presenter: policy approvals are minted here, not requested
        // by the client, so the connection stays eligible as a reviewer. A
        // sole-reviewer operator would otherwise be excluded from delivery and
        // the request auto-denied as no-route.
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
      let decision = manager.projectDecisionIfActive(record.id, await decisionPromise);
      // This return hands execution authority to the plugin policy. Claim a
      // one-shot decision here so observation or retry cannot replay it.
      if (
        decision === "allow-once" &&
        !manager.consumeAllowOnce(record.id, `plugin.node.invoke:${record.id}`)
      ) {
        return { id: record.id, decision: null };
      }
      decision = manager.projectDecisionIfActive(record.id, decision);
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
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const registry = getActivePluginGatewayNodePolicyRegistry();
  const callerIdentity = params.client?.internal?.agentRuntimeIdentity;
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

  let nodeCommandDispatched = false;
  let nodeGateDecisionRecorded = false;
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
    if (
      callerIdentity &&
      params.context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) !== true
    ) {
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
    const resolveCommandAuthorization = () =>
      isNodeCommandAllowed({
        command: params.command,
        declaredCommands: currentNode.commands,
        allowlist: resolveNodeCommandAllowlist(params.context.getRuntimeConfig(), {
          ...currentNode,
          approvedCommands: currentNode.commands,
        }),
      });
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
    if (!isPluginCurrent()) {
      return deny("node_plugin_replaced", {
        ok: false,
        code: "PLUGIN_POLICY_CHANGED",
        message: "node plugin policy changed before dispatch",
      });
    }
    if (
      callerIdentity &&
      params.context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) !== true
    ) {
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
    const res = await invokeNodeWithReadinessRetry(params.context.nodeRegistry, {
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
        return (
          isPluginCurrent() &&
          (params.nodeInvokeStream?.isRuntimeCurrent() ?? true) &&
          (!callerIdentity ||
            params.context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) === true) &&
          params.isApprovalAuthorityActive?.() !== false &&
          resolveCommandAuthorization().ok
        );
      },
      onDispatchReady: (invokeId) => {
        // Only the registry knows that the transport send succeeded. Preserve
        // pre-send failures as retry-safe while making later failures ambiguous.
        nodeCommandDispatched = true;
        params.onNodeCommandDispatched?.();
        params.nodeInvokeStream?.onDispatchReady(invokeId);
      },
    });
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
      approvals: createApprovalRuntime({
        context: params.context,
        client: params.client,
        pluginId: entry.pluginId,
        turnSource: trustedTurnSource,
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
