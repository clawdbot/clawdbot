// Owns delegated system-agent approval registration and detached completion.
import { randomUUID } from "node:crypto";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalApplicationStatus,
  type SystemAgentApprovalResolved,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { describeSystemAgentPersistentOperation } from "../../system-agent/operations.js";
import type { AgentRuntimeDelegatedAuthority } from "../agent-runtime-identity-token.js";
import { sameWorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import {
  broadcastApprovalResolvedEvent,
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
} from "./approval-shared.js";
import type { GatewaySystemAgentSession } from "./shared-types.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import type { GatewayRequestContext } from "./types.js";

function sameApprovalAuthority(
  left: AgentRuntimeDelegatedAuthority,
  right: AgentRuntimeDelegatedAuthority,
): boolean {
  if (
    left.kind !== right.kind ||
    left.claimId !== right.claimId ||
    left.lifecycleGeneration !== right.lifecycleGeneration ||
    left.operationalRunInstance.instanceId !== right.operationalRunInstance.instanceId ||
    left.operationalRunInstance.runId !== right.operationalRunInstance.runId
  ) {
    return false;
  }
  return left.kind === "worker" && right.kind === "worker"
    ? sameWorkerSessionTurnClaim(left.turnClaim, right.turnClaim)
    : true;
}

export function queueDelegatedApproval(params: {
  context: GatewayRequestContext;
  sessions: Map<string, GatewaySystemAgentSession>;
  session: GatewaySystemAgentSession;
  sessionId: string;
  delegation: {
    agentId?: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
  };
  proposal: NonNullable<
    ReturnType<GatewaySystemAgentSession["engine"]["getPendingOperatorProposal"]>
  >;
}): string {
  const manager = params.context.systemAgentApprovalManager;
  if (!manager) {
    throw new Error("OpenClaw approval registry unavailable");
  }
  const callerIdentity = getGatewayToolCallerIdentity();
  const approvalAuthority =
    callerIdentity?.approvalAuthority ??
    (callerIdentity?.operationalRunInstance
      ? getActiveAgentRunDelegatedAuthority(callerIdentity.operationalRunInstance)
      : undefined);
  if (!approvalAuthority) {
    throw new Error("delegated OpenClaw approval requires an active run authority");
  }
  const runtimeApprovalAuthority: AgentRuntimeDelegatedAuthority = callerIdentity?.workerTurnClaim
    ? { kind: "worker", ...approvalAuthority, turnClaim: callerIdentity.workerTurnClaim }
    : { kind: "local", ...approvalAuthority };
  const pendingApproval = params.session.pendingApproval;
  if (pendingApproval && pendingApproval.proposalHash === params.proposal.hash) {
    const closed = manager.forceDenyIfDelegatedAuthorityClosed(pendingApproval.id);
    const existing = manager.getSnapshot(pendingApproval.id);
    if (!closed && existing) {
      if (
        existing.resolvedAtMs === undefined &&
        existing.agentRuntimeDelegatedAuthority &&
        sameApprovalAuthority(existing.agentRuntimeDelegatedAuthority, runtimeApprovalAuthority)
      ) {
        return pendingApproval.id;
      }
    }
    params.session.pendingApproval = undefined;
  }
  const description = describeSystemAgentPersistentOperation(params.proposal.operation);
  const request: SystemAgentApprovalRequestPayload = {
    title: "OpenClaw change",
    description,
    command: description,
    proposalHash: params.proposal.hash,
    allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
    agentId: params.delegation?.agentId ?? null,
    sessionKey: params.delegation?.sessionKey ?? null,
    sessionId: params.sessionId,
    turnSourceChannel: params.delegation?.turnSourceChannel ?? null,
    turnSourceTo: params.delegation?.turnSourceTo ?? null,
    turnSourceAccountId: params.delegation?.turnSourceAccountId ?? null,
    turnSourceThreadId: params.delegation?.turnSourceThreadId ?? null,
    runId: callerIdentity?.operationalRunInstance?.runId ?? null,
  };
  const record = manager.create(
    request,
    SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
    `system-agent:${randomUUID()}`,
  );
  if (callerIdentity?.approvalAuthorityCheck) {
    record.approvalAuthority = callerIdentity.approvalAuthorityCheck;
  }
  record.agentRuntimeDelegatedAuthority = runtimeApprovalAuthority;
  const approvalAuthorityCheck = record.approvalAuthority;
  record.approvalAuthority = () => {
    if (
      !validateAgentRunDelegatedAuthority(approvalAuthority) ||
      approvalAuthorityCheck?.() === false
    ) {
      return false;
    }
    if (runtimeApprovalAuthority.kind === "local") {
      return true;
    }
    if (!callerIdentity) {
      return false;
    }
    return (
      params.context.validateAgentRuntimeApprovalAuthority?.({
        kind: "agentRuntime",
        agentId: callerIdentity.agentId,
        sessionKey: callerIdentity.sessionKey,
        operationalRunInstance: runtimeApprovalAuthority.operationalRunInstance,
        delegatedAuthority: runtimeApprovalAuthority,
      }) === true
    );
  };
  if (callerIdentity?.approvalSignals?.length) {
    record.approvalSignals = callerIdentity.approvalSignals;
  }
  const decisionPromise = manager.register(record, SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
  params.session.pendingApproval = { id: record.id, proposalHash: params.proposal.hash };
  const requestEvent = buildRequestedApprovalEvent(record, "system-agent");
  const publishApplicationResult = (
    decision: ExecApprovalDecision,
    applicationStatus: SystemAgentApprovalApplicationStatus,
  ) => {
    const resolvedEvent = {
      id: record.id,
      decision,
      resolvedBy: record.resolvedBy ?? null,
      ts: Date.now(),
      request,
      applicationStatus,
    } satisfies SystemAgentApprovalResolved;
    broadcastApprovalResolvedEvent({
      approvalKind: "system-agent",
      context: params.context,
      record,
      event: resolvedEvent,
    });
    params.context.approvalEvents?.publishResolved("system-agent", resolvedEvent);
  };
  void handlePendingApprovalRequest({
    manager,
    record,
    decisionPromise,
    respond: () => undefined,
    context: params.context,
    requestEventName: "openclaw.approval.requested",
    requestEvent,
    twoPhase: true,
    approvalKind: "system-agent",
    deliverRequest: () => false,
    keepPendingWithoutRoute: true,
    requireDeliveryRoute: false,
    afterDecision: async (decision) => {
      if (!decision) {
        return;
      }
      try {
        const reply = await runWithGatewayIndependentRootWorkContinuation(
          () =>
            runSystemAgentGatewayTask(async () => {
              const assertLiveApprovalAuthority = () => {
                if (
                  decision !== "deny" &&
                  (!record.approvalAuthority || record.approvalAuthority() === false)
                ) {
                  throw new Error("system-agent approval authority is no longer active");
                }
              };
              assertLiveApprovalAuthority();
              if (params.sessions.get(params.sessionId) !== params.session) {
                return null;
              }
              if (params.session.pendingApproval?.id === record.id) {
                params.session.pendingApproval = undefined;
              }
              return await params.session.engine.resolveOperatorApproval(
                decision,
                params.proposal.hash,
                assertLiveApprovalAuthority,
              );
            }),
          "system-agent:task",
        );
        publishApplicationResult(decision, reply?.applied === true ? "applied" : "not-applied");
      } catch (error) {
        publishApplicationResult(decision, "not-applied");
        throw error;
      }
    },
    afterDecisionErrorLabel: "OpenClaw approval apply failed",
  });
  return record.id;
}

const systemAgentSessionQueues = new WeakMap<
  Map<string, GatewaySystemAgentSession>,
  KeyedAsyncQueue
>();

export function getSystemAgentSessionQueue(
  sessions: Map<string, GatewaySystemAgentSession>,
): KeyedAsyncQueue {
  let queue = systemAgentSessionQueues.get(sessions);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    systemAgentSessionQueues.set(sessions, queue);
  }
  return queue;
}
