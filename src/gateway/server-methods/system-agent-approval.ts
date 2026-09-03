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

async function retireSystemAgentProposal(
  session: GatewaySystemAgentSession,
  manager: GatewayRequestContext["systemAgentApprovalManager"],
  proposalHash: string,
): Promise<void> {
  try {
    const pending = session.pendingApproval;
    if (pending?.proposalHash === proposalHash) {
      // Retire the exact local owner before closing its record; storage failure cannot retain it.
      session.pendingApproval = undefined;
      manager?.forceDenyIfRuntimeAuthorityClosed(pending.id);
    }
  } finally {
    await session.engine.resolveOperatorApproval(null, proposalHash);
  }
}

async function reconcileSystemAgentApproval(
  session: GatewaySystemAgentSession,
  manager: GatewayRequestContext["systemAgentApprovalManager"],
  authority: AgentRuntimeDelegatedAuthority,
): Promise<GatewaySystemAgentSession["pendingApproval"]> {
  const pending = session.pendingApproval;
  if (!pending) {
    return undefined;
  }
  const closed = manager?.forceDenyIfRuntimeAuthorityClosed(pending.id);
  const snapshot = manager?.getSnapshot(pending.id);
  if (
    !closed &&
    snapshot &&
    (snapshot.resolvedAtMs === undefined || snapshot.decision === "allow-once") &&
    snapshot.agentRuntimeDelegatedAuthority &&
    sameApprovalAuthority(snapshot.agentRuntimeDelegatedAuthority, authority) &&
    session.engine.getPendingOperatorProposal()?.hash === pending.proposalHash
  ) {
    return pending;
  }
  // A new run cannot inherit even a still-live run's proposal. Retire it before input;
  // skip a second store transition when the registry already closed the record above.
  await retireSystemAgentProposal(session, closed ? undefined : manager, pending.proposalHash);
  return undefined;
}

type DelegatedProposalResolver = (
  proposal: NonNullable<
    ReturnType<GatewaySystemAgentSession["engine"]["getPendingOperatorProposal"]>
  >,
) => Promise<
  | { kind: "approval"; id: string }
  | {
      kind: "completed";
      reply: NonNullable<
        Awaited<ReturnType<GatewaySystemAgentSession["engine"]["resolveOperatorApproval"]>>
      >;
    }
>;

export async function prepareDelegatedSystemAgentApproval(params: {
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
}): Promise<DelegatedProposalResolver> {
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
  const manager = params.context.systemAgentApprovalManager;
  assertLiveApprovalAuthority();
  await reconcileSystemAgentApproval(params.session, manager, runtimeApprovalAuthority);
  assertLiveApprovalAuthority();

  return async (proposal) => {
    const withProposalFailureCleanup = async <T>(resolve: () => Promise<T>): Promise<T> => {
      try {
        return await resolve();
      } catch (error) {
        // Entry, registration, and apply failures all retire this exact proposal.
        // Otherwise a later run can inherit it without the failed run's authority.
        if (params.sessions.get(params.sessionId) === params.session) {
          await retireSystemAgentProposal(params.session, manager, proposal.hash);
        }
        throw error;
      }
    };
    return await withProposalFailureCleanup(async (): ReturnType<DelegatedProposalResolver> => {
      assertLiveApprovalAuthority();
      if (params.session.pendingApproval) {
        const pending = await reconcileSystemAgentApproval(
          params.session,
          manager,
          runtimeApprovalAuthority,
        );
        if (pending?.proposalHash === proposal.hash) {
          return { kind: "approval", id: pending.id };
        }
        throw new Error("OpenClaw change is no longer pending. Retry the request.");
      }
      const applyDecision = async (decision: ExecApprovalDecision | null) => {
        if (decision && decision !== "deny") {
          assertLiveApprovalAuthority();
        }
        return await params.session.engine.resolveOperatorApproval(
          decision,
          proposal.hash,
          assertLiveApprovalAuthority,
        );
      };
      // Only a fresh proposal belongs to this input. An existing operator request
      // stays bound to its original decision, even if this caller has Full Access.
      if (callerIdentity?.fullPermission === true) {
        const reply = await applyDecision("allow-once");
        if (!reply) {
          throw new Error("OpenClaw change is no longer pending. Retry the request.");
        }
        return { kind: "completed", reply };
      }
      if (!manager) {
        throw new Error("OpenClaw approval registry unavailable");
      }
      const description = describeSystemAgentPersistentOperation(proposal.operation);
      const request: SystemAgentApprovalRequestPayload = {
        title: "OpenClaw change",
        description,
        command: description,
        proposalHash: proposal.hash,
        allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
        agentId: params.delegation.agentId ?? null,
        sessionKey: params.delegation.sessionKey ?? null,
        sessionId: params.sessionId,
        turnSourceChannel: params.delegation.turnSourceChannel ?? null,
        turnSourceTo: params.delegation.turnSourceTo ?? null,
        turnSourceAccountId: params.delegation.turnSourceAccountId ?? null,
        turnSourceThreadId: params.delegation.turnSourceThreadId ?? null,
        runId: callerIdentity?.operationalRunInstance?.runId ?? null,
      };
      const record = manager.create(
        request,
        SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
        `system-agent:${randomUUID()}`,
      );
      const pendingApproval = { id: record.id, proposalHash: proposal.hash };
      params.session.pendingApproval = pendingApproval;
      record.agentRuntimeDelegatedAuthority = runtimeApprovalAuthority;
      // The request loses authority when replaced, even while its source run lives.
      record.approvalAuthority = () =>
        isAuthorityActive() &&
        params.sessions.get(params.sessionId) === params.session &&
        params.session.pendingApproval === pendingApproval;
      if (callerIdentity?.approvalSignals?.length) {
        record.approvalSignals = callerIdentity.approvalSignals;
      }
      const decisionPromise = manager.register(record, SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
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
                    params.session.pendingApproval !== pendingApproval
                  ) {
                    return null;
                  }
                  params.session.pendingApproval = undefined;
                  // Retire failures before releasing this task; a later run may propose the same hash.
                  return await withProposalFailureCleanup(() => applyDecision(decision));
                }),
              "system-agent:task",
            );
            if (decision) {
              const applicationStatus = reply?.applied === true ? "applied" : "not-applied";
              publishApplicationResult(decision, applicationStatus);
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
    });
  };
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
