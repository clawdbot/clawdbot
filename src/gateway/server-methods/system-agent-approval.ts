// Owns delegated system-agent authorization and exact-proposal completion.
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

export async function reconcileSystemAgentApproval(
  session: GatewaySystemAgentSession,
  manager: GatewayRequestContext["systemAgentApprovalManager"],
): Promise<void> {
  const pending = session.pendingApproval;
  if (!pending) {
    return;
  }
  const closed = manager?.forceDenyIfRuntimeAuthorityClosed(pending.id);
  const snapshot = manager?.getSnapshot(pending.id);
  if (
    !closed &&
    snapshot &&
    (snapshot.resolvedAtMs === undefined || snapshot.decision === "allow-once")
  ) {
    return;
  }
  // Terminal approvals cannot survive as executable proposals. Reconcile before
  // routing so a later Full Access request cannot apply an old cancelled change.
  session.pendingApproval = undefined;
  await session.engine.resolveOperatorApproval(null, pending.proposalHash);
}

export async function resolveDelegatedSystemAgentProposal(params: {
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
}): Promise<
  | { kind: "approval"; id: string }
  | {
      kind: "completed";
      reply: NonNullable<
        Awaited<ReturnType<GatewaySystemAgentSession["engine"]["resolveOperatorApproval"]>>
      >;
    }
> {
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
  const isAuthorityActive = () => {
    if (
      !validateAgentRunDelegatedAuthority(approvalAuthority) ||
      callerIdentity?.approvalAuthorityCheck?.() === false ||
      callerIdentity?.receiptAuthority?.() === false ||
      callerIdentity?.approvalSignals?.some((signal) => signal.aborted) ||
      (callerIdentity?.gatewayContextResolver && !callerIdentity.gatewayContextResolver())
    ) {
      return false;
    }
    return (
      runtimeApprovalAuthority.kind === "local" ||
      (callerIdentity !== undefined &&
        params.context.validateAgentRuntimeApprovalAuthority?.({
          kind: "agentRuntime",
          agentId: callerIdentity.agentId,
          sessionKey: callerIdentity.sessionKey,
          operationalRunInstance: runtimeApprovalAuthority.operationalRunInstance,
          delegatedAuthority: runtimeApprovalAuthority,
        }) === true)
    );
  };
  const assertLiveApprovalAuthority = () => {
    if (!isAuthorityActive() || params.sessions.get(params.sessionId) !== params.session) {
      throw new Error("system-agent approval authority is no longer active");
    }
  };
  const applyDecision = async (decision: ExecApprovalDecision | null) => {
    try {
      if (decision && decision !== "deny") {
        assertLiveApprovalAuthority();
      }
      return await params.session.engine.resolveOperatorApproval(
        decision,
        params.proposal.hash,
        assertLiveApprovalAuthority,
      );
    } catch (error) {
      // Authority can close before the executor consumes the proposal.
      // Invalidate that exact operation instead of leaving it for a later run.
      if (params.sessions.get(params.sessionId) === params.session) {
        await params.session.engine.resolveOperatorApproval(null, params.proposal.hash);
      }
      throw error;
    }
  };
  // Full Access authorizes this exact proposal, not the model's approval claims.
  // Use the same one-use executor and late commit fence as a human decision.
  if (callerIdentity?.fullPermission === true) {
    const reply = await applyDecision("allow-once");
    if (!reply) {
      throw new Error("OpenClaw change is no longer pending. Retry the request.");
    }
    return { kind: "completed", reply };
  }
  const manager = params.context.systemAgentApprovalManager;
  if (!manager) {
    throw new Error("OpenClaw approval registry unavailable");
  }
  const pendingApproval = params.session.pendingApproval;
  if (pendingApproval && pendingApproval.proposalHash === params.proposal.hash) {
    const closed = manager.forceDenyIfRuntimeAuthorityClosed(pendingApproval.id);
    const existing = manager.getSnapshot(pendingApproval.id);
    if (!closed && existing) {
      if (
        existing.resolvedAtMs === undefined &&
        existing.agentRuntimeDelegatedAuthority &&
        sameApprovalAuthority(existing.agentRuntimeDelegatedAuthority, runtimeApprovalAuthority)
      ) {
        return { kind: "approval", id: pendingApproval.id };
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
  record.agentRuntimeDelegatedAuthority = runtimeApprovalAuthority;
  record.approvalAuthority = isAuthorityActive;
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
      try {
        const reply = await runWithGatewayIndependentRootWorkContinuation(
          () =>
            runSystemAgentGatewayTask(async () => {
              if (
                params.sessions.get(params.sessionId) !== params.session ||
                params.session.pendingApproval?.id !== record.id
              ) {
                return null;
              }
              params.session.pendingApproval = undefined;
              return await applyDecision(decision);
            }),
          "system-agent:task",
        );
        if (decision) {
          publishApplicationResult(decision, reply?.applied === true ? "applied" : "not-applied");
        }
      } catch (error) {
        if (decision) {
          publishApplicationResult(decision, "not-applied");
        }
        throw error;
      }
    },
    afterDecisionErrorLabel: "OpenClaw approval apply failed",
  });
  return { kind: "approval", id: record.id };
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
