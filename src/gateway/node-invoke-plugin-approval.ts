import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeApprovalScope } from "../infra/approval-scope.js";
import {
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "../infra/exec-approval-text-sanitize.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resolvePluginApprovalTimeoutMs } from "../infra/plugin-approvals.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import {
  resolveNodeInvokePlacementGrant,
  retainResolvedNodeInvokePlacementGrant,
  type NodeInvokePlacementGrantOwner,
  type NodeInvokePlacementGrantAuthorization,
} from "./node-invoke-placement-grant.js";
import type { NodeSession } from "./node-registry.js";
import { bindApprovalRequesterMetadata } from "./server-methods/approval-shared.js";
import { handlePendingPluginApprovalRequest } from "./server-methods/plugin-approval-request-delivery.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";

function sanitizeOptionalMeta(value?: string | null): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? sanitizeExecApprovalDisplayText(normalized) : null;
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

export function createPluginNodeInvokeApprovalRuntime(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  callerIdentity?: AgentRuntimeIdentity;
  pluginId: string;
  command: string;
  approvalScope?: string;
  nodeSession: NodeSession;
  risk: OpenClawPluginNodeInvokePolicyContext["risk"];
  standingGrantAuthorization: NodeInvokePlacementGrantAuthorization;
  placementGrantAuthority?: {
    agentId: string;
    sessionKey: string;
    runId: string;
    assertCurrent: (request: {
      pluginId: string;
      command: string;
      nodeId: string;
      workspace: {
        workspaceDir: string;
        environmentId: string;
        sessionId: string;
        ownerEpoch: number;
        sessionKey: string;
      };
    }) => void;
  };
  turnSource?: {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
    threadId?: unknown;
  };
  isCurrent: () => boolean;
}): OpenClawPluginNodeInvokePolicyContext["approvals"] | undefined {
  const manager = params.context.pluginApprovalManager;
  if (!manager) {
    return undefined;
  }
  return {
    async request(input) {
      const timeoutMs = resolvePluginApprovalTimeoutMs(input.timeoutMs);
      const turnSource = resolveNodeInvokeTurnSourceFields(params.turnSource);
      const callerIdentity = params.callerIdentity;
      const invocationSessionKey =
        params.client?.internal?.pluginRuntimeOwnerId === params.pluginId
          ? params.client.internal.nodeInvokeApprovalSessionKey
          : undefined;
      if (!params.isCurrent()) {
        throw new Error("agent runtime approval authority is no longer active");
      }
      const requestedDecisions =
        input.allowedDecisions === undefined
          ? undefined
          : resolveCanonicalPluginApprovalRequestAllowedDecisions({
              allowedDecisions: input.allowedDecisions,
            });
      const scopedAuthority = params.placementGrantAuthority;
      const placementGrantOwner: NodeInvokePlacementGrantOwner | undefined = scopedAuthority
        ? {
            agentId: scopedAuthority.agentId,
            sessionKey: scopedAuthority.sessionKey,
            assertCurrent: (binding) =>
              scopedAuthority.assertCurrent({
                pluginId: binding.pluginId,
                command: binding.command,
                nodeId: binding.nodeId,
                workspace: {
                  workspaceDir: binding.cwd,
                  environmentId: binding.environmentId,
                  sessionId: binding.sessionId,
                  ownerEpoch: binding.ownerEpoch,
                  sessionKey: binding.sessionKey,
                },
              }),
          }
        : undefined;
      const placementGrantResolution = resolveNodeInvokePlacementGrant({
        runtime: params.context.placementStandingGrants,
        requestedDecisions,
        owner: placementGrantOwner,
        pluginId: params.pluginId,
        command: params.command,
        ...(params.approvalScope ? { approvalScope: params.approvalScope } : {}),
        risk: params.risk,
        nodeSession: params.nodeSession,
      });
      if (placementGrantResolution.kind === "granted") {
        params.standingGrantAuthorization.binding = placementGrantResolution.binding;
        return { id: placementGrantResolution.approvalId, decision: "allow-always" };
      }
      const { allowedDecisions, binding: placementGrant } = placementGrantResolution;
      const request: PluginApprovalRequestPayload = {
        pluginId: params.pluginId,
        // Internal node prompts truncate; RPC ingress rejects oversized prompts.
        // Normalize before escaping so empty prompts still fail closed.
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
        ...(allowedDecisions === undefined ? {} : { allowedDecisions }),
        toolName: sanitizeOptionalMeta(input.toolName),
        toolCallId: normalizeOptionalString(input.toolCallId) ?? null,
        agentId:
          callerIdentity?.agentId ??
          scopedAuthority?.agentId ??
          sanitizeOptionalMeta(input.agentId),
        sessionKey:
          callerIdentity?.sessionKey ??
          scopedAuthority?.sessionKey ??
          invocationSessionKey ??
          normalizeOptionalString(input.sessionKey) ??
          null,
        runId: callerIdentity?.operationalRunInstance.runId ?? scopedAuthority?.runId ?? null,
        placementGrant,
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
      if (placementGrant && placementGrantOwner) {
        record.approvalAuthority = () => {
          placementGrantOwner.assertCurrent(placementGrant);
          return true;
        };
      }
      bindApprovalRequesterMetadata({ record, client: params.client });
      const respond: RespondFn = () => {};
      const decisionPromise = manager.register(record, timeoutMs);
      await handlePendingPluginApprovalRequest({
        manager,
        record,
        respond,
        context: params.context,
        // The carried connection is turn provenance, not the presenter. Keep
        // a sole-reviewer operator eligible for this internally minted prompt.
        twoPhase: false,
        forwardRequest: params.context.forwardPluginApprovalRequest,
        getIosPushDelivery: () => params.context.pluginApprovalIosPushDelivery,
        source: "node-policy",
      });
      let decision = manager.projectDecisionIfActive(record.id, await decisionPromise);
      if (!params.isCurrent()) {
        return { id: record.id, decision: null };
      }
      if (
        decision === "allow-once" &&
        !manager.consumeAllowOnce(record.id, `plugin.node.invoke:${record.id}`)
      ) {
        return { id: record.id, decision: null };
      }
      decision = manager.projectDecisionIfActive(record.id, decision);
      if (
        !retainResolvedNodeInvokePlacementGrant({
          runtime: params.context.placementStandingGrants,
          decision,
          binding: placementGrant,
          owner: placementGrantOwner,
          authorization: params.standingGrantAuthorization,
        })
      ) {
        return { id: record.id, decision: null };
      }
      return { id: record.id, decision };
    },
  };
}
