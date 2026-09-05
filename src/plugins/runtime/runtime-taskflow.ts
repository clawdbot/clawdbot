// Runtime task-flow helpers adapt plugin task descriptors into executable task flows.
import { spawnAcpDirect } from "../../agents/subagents/spawn/acp-spawn.js";
import {
  cancelFlowByIdForOwner,
  getFlowTaskSummary,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  failFlow,
  finishFlow,
  type TaskFlowUpdateResult,
  requestFlowCancel,
  resumeFlow,
  setFlowWaiting,
} from "../../tasks/task-flow-runtime-internal.js";
import { listTasksForFlowId } from "../../tasks/task-registry.js";
import type { TaskDeliveryState } from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type {
  BoundTaskFlowAcpChildResult,
  BoundTaskFlowRuntime,
  ManagedTaskFlowMutationResult,
  ManagedTaskFlowRecord,
  PluginRuntimeTaskFlow,
} from "./runtime-taskflow.types.js";

const MANAGED_ACP_RESERVATION_ID_RE = /^[a-f0-9]{64}$/;

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function asManagedTaskFlowRecord(
  flow: TaskFlowRecord | undefined,
): ManagedTaskFlowRecord | undefined {
  if (!flow || flow.syncMode !== "managed" || !flow.controllerId) {
    return undefined;
  }
  return flow as ManagedTaskFlowRecord;
}

function mapFlowUpdateResult(result: TaskFlowUpdateResult): ManagedTaskFlowMutationResult {
  if (result.applied) {
    const managed = asManagedTaskFlowRecord(result.flow);
    if (!managed) {
      return {
        applied: false,
        code: "not_managed",
        current: result.flow,
      };
    }
    return {
      applied: true,
      flow: managed,
    };
  }
  return {
    applied: false,
    code: result.reason,
    ...(result.current ? { current: result.current } : {}),
  };
}

function applyManagedFlowMutationForOwner(params: {
  flowId: string;
  ownerKey: string;
  mutate: (flowId: string) => TaskFlowUpdateResult;
}): ManagedTaskFlowMutationResult {
  // Authorization and mode checks must complete before the mutation can touch persistence.
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.ownerKey,
  });
  if (!flow) {
    return { applied: false, code: "not_found" };
  }
  const managed = asManagedTaskFlowRecord(flow);
  if (!managed) {
    return { applied: false, code: "not_managed", current: flow };
  }
  return mapFlowUpdateResult(params.mutate(managed.flowId));
}

function resolveManagedFlowForOwner(params: {
  flowId: string;
  ownerKey: string;
}): { ok: true; flow: ManagedTaskFlowRecord } | { ok: false } {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.ownerKey,
  });
  const managed = asManagedTaskFlowRecord(flow);
  return managed ? { ok: true, flow: managed } : { ok: false };
}

function createBoundTaskFlowRuntime(params: {
  sessionKey: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  spawnAcp?: typeof spawnAcpDirect;
}): BoundTaskFlowRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;
  const spawnAcp = params.spawnAcp ?? spawnAcpDirect;
  const tryCreateManaged: BoundTaskFlowRuntime["tryCreateManaged"] = (input) => {
    const flow = createManagedTaskFlow({
      ownerKey,
      controllerId: input.controllerId,
      requesterOrigin,
      status: input.status,
      notifyPolicy: input.notifyPolicy,
      goal: input.goal,
      currentStep: input.currentStep,
      stateJson: input.stateJson,
      waitJson: input.waitJson,
      cancelRequestedAt: input.cancelRequestedAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      endedAt: input.endedAt,
    });
    return asManagedTaskFlowRecord(flow ?? undefined) ?? null;
  };

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    createManaged: (input) => {
      const flow = tryCreateManaged(input);
      if (!flow) {
        throw new Error("TaskFlow persistence failed.");
      }
      return flow;
    },
    tryCreateManaged,
    get: (flowId) =>
      getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      }),
    list: () =>
      listTaskFlowsForOwner({
        callerOwnerKey: ownerKey,
      }),
    findLatest: () =>
      findLatestTaskFlowForOwner({
        callerOwnerKey: ownerKey,
      }),
    resolve: (token) =>
      resolveTaskFlowForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      }),
    getTaskSummary: (flowId) => {
      const flow = getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      });
      return flow ? getFlowTaskSummary(flow.flowId) : undefined;
    },
    setWaiting: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          setFlowWaiting({
            flowId,
            expectedRevision: input.expectedRevision,
            currentStep: input.currentStep,
            stateJson: input.stateJson,
            waitJson: input.waitJson,
            blockedTaskId: input.blockedTaskId,
            blockedSummary: input.blockedSummary,
            updatedAt: input.updatedAt,
          }),
      }),
    resume: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          resumeFlow({
            flowId,
            expectedRevision: input.expectedRevision,
            status: input.status,
            currentStep: input.currentStep,
            stateJson: input.stateJson,
            updatedAt: input.updatedAt,
          }),
      }),
    finish: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          finishFlow({
            flowId,
            expectedRevision: input.expectedRevision,
            stateJson: input.stateJson,
            updatedAt: input.updatedAt,
            endedAt: input.endedAt,
          }),
      }),
    fail: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          failFlow({
            flowId,
            expectedRevision: input.expectedRevision,
            stateJson: input.stateJson,
            blockedTaskId: input.blockedTaskId,
            blockedSummary: input.blockedSummary,
            updatedAt: input.updatedAt,
            endedAt: input.endedAt,
          }),
      }),
    requestCancel: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          requestFlowCancel({
            flowId,
            expectedRevision: input.expectedRevision,
            cancelRequestedAt: input.cancelRequestedAt,
          }),
      }),
    cancel: ({ flowId, cfg }) =>
      cancelFlowByIdForOwner({
        cfg,
        flowId,
        callerOwnerKey: ownerKey,
      }),
    spawnAcpChild: async (input): Promise<BoundTaskFlowAcpChildResult> => {
      const flow = resolveManagedFlowForOwner({ flowId: input.flowId, ownerKey });
      if (!flow.ok) return { accepted: false, reason: "Managed TaskFlow was not found." };
      if (flow.flow.revision !== input.expectedRevision) {
        return { accepted: false, reason: "Managed TaskFlow revision changed." };
      }
      if (flow.flow.cancelRequestedAt != null) {
        return { accepted: false, reason: "Managed TaskFlow cancellation was requested." };
      }
      if (flow.flow.status !== "queued" && flow.flow.status !== "running") {
        return { accepted: false, reason: `Managed TaskFlow is ${flow.flow.status}.` };
      }
      if (!MANAGED_ACP_RESERVATION_ID_RE.test(input.reservationId)) {
        return { accepted: false, reason: "Managed ACP reservation ID is invalid." };
      }
      if (!input.agentId.trim() || !input.label.trim() || !input.task.trim()) {
        return { accepted: false, reason: "Managed ACP child identity is incomplete." };
      }

      const existing = listTasksForFlowId(flow.flow.flowId).filter(
        (task) => task.runtime === "acp" && task.runId === input.reservationId,
      );
      if (existing.length > 1) {
        return { accepted: false, reason: "Managed ACP reservation has multiple child tasks." };
      }
      if (existing.length === 1 && existing[0].childSessionKey) {
        return {
          accepted: true,
          taskId: existing[0].taskId,
          childSessionKey: existing[0].childSessionKey,
          runId: existing[0].runId ?? input.reservationId,
          reused: true,
        };
      }
      if (existing.length === 1) {
        return { accepted: false, reason: "Managed ACP child has no session identity." };
      }

      const spawned = await spawnAcp(
        {
          task: input.task,
          label: input.label,
          agentId: input.agentId,
          mode: "run",
          idempotencyKey: input.reservationId,
        },
        { agentSessionKey: ownerKey },
      );
      if (spawned.status !== "accepted") return { accepted: false, reason: spawned.error };
      const linked = runTaskInFlowForOwner({
        flowId: flow.flow.flowId,
        callerOwnerKey: ownerKey,
        runtime: "acp",
        sourceId: input.reservationId,
        childSessionKey: spawned.childSessionKey,
        agentId: input.agentId,
        runId: spawned.runId,
        label: input.label,
        task: input.task,
        preferMetadata: true,
        status: "running",
      });
      if (!linked.created || !linked.task) {
        return {
          accepted: false,
          reason: linked.reason ?? "Managed ACP child task was not recorded exactly once.",
        };
      }
      return {
        accepted: true,
        taskId: linked.task.taskId,
        childSessionKey: spawned.childSessionKey,
        runId: spawned.runId,
        reused: false,
      };
    },
    runTask: (input) => {
      const created = runTaskInFlowForOwner({
        flowId: input.flowId,
        callerOwnerKey: ownerKey,
        runtime: input.runtime,
        sourceId: input.sourceId,
        childSessionKey: input.childSessionKey,
        parentTaskId: input.parentTaskId,
        agentId: input.agentId,
        runId: input.runId,
        label: input.label,
        task: input.task,
        preferMetadata: input.preferMetadata,
        notifyPolicy: input.notifyPolicy,
        deliveryStatus: input.deliveryStatus,
        status: input.status,
        startedAt: input.startedAt,
        lastEventAt: input.lastEventAt,
        progressSummary: input.progressSummary,
      });
      if (!created.created) {
        return {
          created: false,
          found: created.found,
          reason: created.reason ?? "Task was not created.",
          ...(created.flow ? { flow: created.flow } : {}),
        };
      }
      const managed = asManagedTaskFlowRecord(created.flow);
      if (!managed) {
        return {
          created: false,
          found: true,
          reason: "TaskFlow does not accept managed child tasks.",
          flow: created.flow,
        };
      }
      if (!created.task) {
        return {
          created: false,
          found: true,
          reason: "Task was not created.",
          flow: created.flow,
        };
      }
      return {
        created: true,
        flow: managed,
        task: created.task,
      };
    },
  };
}

export function createRuntimeTaskFlow(
  options: { spawnAcp?: typeof spawnAcpDirect } = {},
): PluginRuntimeTaskFlow {
  return {
    bindSession: (params) =>
      createBoundTaskFlowRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
        spawnAcp: options.spawnAcp,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskFlowRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "TaskFlow runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
        spawnAcp: options.spawnAcp,
      }),
  };
}
