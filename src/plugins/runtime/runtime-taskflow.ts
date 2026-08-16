// Runtime task-flow helpers adapt plugin task descriptors into executable task flows.
import {
  cancelFlowByIdForOwner,
  getFlowTaskSummary,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import {
  CONTINUATION_DELEGATE_CONTROLLER_ID,
  CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
  isContinuationDelegateFlow,
  scrubStoredDelegateAttachmentState,
} from "../../tasks/task-flow-continuation-state.js";
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
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-runtime-internal.js";
import type { TaskDeliveryState } from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type {
  BoundTaskFlowRuntime,
  ManagedTaskFlowMutationResult,
  ManagedTaskFlowRecord,
  PluginRuntimeTaskFlow,
} from "./runtime-taskflow.types.js";

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function isManagedTaskFlowRecord(flow: TaskFlowRecord): flow is ManagedTaskFlowRecord {
  return flow.syncMode === "managed" && Boolean(flow.controllerId);
}

function asManagedTaskFlowRecord(
  flow: TaskFlowRecord | undefined,
): ManagedTaskFlowRecord | undefined {
  if (!flow || !isManagedTaskFlowRecord(flow)) {
    return undefined;
  }
  return flow;
}

function isContinuationDelegateControllerId(controllerId: string): boolean {
  const normalized = controllerId.trim();
  return (
    normalized === CONTINUATION_DELEGATE_CONTROLLER_ID ||
    normalized === CONTINUATION_POST_COMPACTION_CONTROLLER_ID
  );
}

function projectTaskFlowForPublicView<T extends TaskFlowRecord>(flow: T): T {
  if (!isContinuationDelegateFlow(flow)) {
    return flow;
  }
  return {
    ...flow,
    stateJson: scrubStoredDelegateAttachmentState(flow.stateJson),
  };
}

function projectManagedTaskFlowForPublicView(flow: ManagedTaskFlowRecord): ManagedTaskFlowRecord {
  return projectTaskFlowForPublicView(flow);
}

function mapFlowUpdateResult(result: TaskFlowUpdateResult): ManagedTaskFlowMutationResult {
  if (result.applied) {
    const managed = asManagedTaskFlowRecord(result.flow);
    if (!managed) {
      return {
        applied: false,
        code: "not_managed",
        current: projectTaskFlowForPublicView(result.flow),
      };
    }
    return {
      applied: true,
      flow: projectManagedTaskFlowForPublicView(managed),
    };
  }
  return {
    applied: false,
    code: result.reason,
    ...(result.current ? { current: projectTaskFlowForPublicView(result.current) } : {}),
  };
}

function applyManagedFlowMutationForOwner(params: {
  flowId: string;
  ownerKey: string;
  mutate: (flow: ManagedTaskFlowRecord) => TaskFlowUpdateResult;
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
  return mapFlowUpdateResult(params.mutate(managed));
}

function createBoundTaskFlowRuntime(params: {
  sessionKey: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): BoundTaskFlowRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;
  const tryCreateManaged: BoundTaskFlowRuntime["tryCreateManaged"] = (input) => {
    const flow = createManagedTaskFlow({
      ownerKey,
      controllerId: input.controllerId,
      requesterOrigin,
      status: input.status,
      notifyPolicy: input.notifyPolicy,
      goal: input.goal,
      currentStep: input.currentStep,
      // Plugin runtime callers are not a continuation attachment persistence
      // path. Core delegate writers own validated snapshot persistence; a
      // generic plugin write may only carry the redacted state projection.
      stateJson: isContinuationDelegateControllerId(input.controllerId)
        ? scrubStoredDelegateAttachmentState(input.stateJson)
        : input.stateJson,
      waitJson: input.waitJson,
      cancelRequestedAt: input.cancelRequestedAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      endedAt: input.endedAt,
    });
    const managed = asManagedTaskFlowRecord(flow ?? undefined);
    return managed ? projectManagedTaskFlowForPublicView(managed) : null;
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
    get: (flowId) => {
      const flow = getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      });
      return flow ? projectTaskFlowForPublicView(flow) : undefined;
    },
    list: () =>
      listTaskFlowsForOwner({
        callerOwnerKey: ownerKey,
      }).map(projectTaskFlowForPublicView),
    findLatest: () => {
      const flow = findLatestTaskFlowForOwner({
        callerOwnerKey: ownerKey,
      });
      return flow ? projectTaskFlowForPublicView(flow) : undefined;
    },
    resolve: (token) => {
      const flow = resolveTaskFlowForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      });
      return flow ? projectTaskFlowForPublicView(flow) : undefined;
    },
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
        mutate: (flow) =>
          setFlowWaiting({
            flowId: flow.flowId,
            expectedRevision: input.expectedRevision,
            currentStep: input.currentStep,
            stateJson: isContinuationDelegateFlow(flow)
              ? scrubStoredDelegateAttachmentState(
                  input.stateJson === undefined ? flow.stateJson : input.stateJson,
                )
              : input.stateJson,
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
        mutate: (flow) =>
          resumeFlow({
            flowId: flow.flowId,
            expectedRevision: input.expectedRevision,
            status: input.status,
            currentStep: input.currentStep,
            stateJson: isContinuationDelegateFlow(flow)
              ? scrubStoredDelegateAttachmentState(
                  input.stateJson === undefined ? flow.stateJson : input.stateJson,
                )
              : input.stateJson,
            updatedAt: input.updatedAt,
          }),
      }),
    finish: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flow) =>
          finishFlow({
            flowId: flow.flowId,
            expectedRevision: input.expectedRevision,
            stateJson: isContinuationDelegateFlow(flow)
              ? scrubStoredDelegateAttachmentState(
                  input.stateJson === undefined ? flow.stateJson : input.stateJson,
                )
              : input.stateJson,
            updatedAt: input.updatedAt,
            endedAt: input.endedAt,
          }),
      }),
    fail: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flow) =>
          failFlow({
            flowId: flow.flowId,
            expectedRevision: input.expectedRevision,
            stateJson: isContinuationDelegateFlow(flow)
              ? scrubStoredDelegateAttachmentState(
                  input.stateJson === undefined ? flow.stateJson : input.stateJson,
                )
              : input.stateJson,
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
        mutate: (flow) =>
          isContinuationDelegateFlow(flow)
            ? updateFlowRecordByIdExpectedRevision({
                flowId: flow.flowId,
                expectedRevision: input.expectedRevision,
                patch: {
                  stateJson: scrubStoredDelegateAttachmentState(flow.stateJson),
                  cancelRequestedAt: input.cancelRequestedAt ?? Date.now(),
                },
              })
            : requestFlowCancel({
                flowId: flow.flowId,
                expectedRevision: input.expectedRevision,
                cancelRequestedAt: input.cancelRequestedAt,
              }),
      }),
    cancel: async ({ flowId, cfg }) => {
      const result = await cancelFlowByIdForOwner({
        cfg,
        flowId,
        callerOwnerKey: ownerKey,
      });
      return {
        ...result,
        ...(result.flow ? { flow: projectTaskFlowForPublicView(result.flow) } : {}),
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
          ...(created.flow ? { flow: projectTaskFlowForPublicView(created.flow) } : {}),
        };
      }
      const flow = created.flow;
      if (!flow) {
        return {
          created: false,
          found: true,
          reason: "TaskFlow was not returned after child-task creation.",
        };
      }
      const managed = asManagedTaskFlowRecord(flow);
      if (!managed) {
        return {
          created: false,
          found: true,
          reason: "TaskFlow does not accept managed child tasks.",
          flow: projectTaskFlowForPublicView(flow),
        };
      }
      if (!created.task) {
        return {
          created: false,
          found: true,
          reason: "Task was not created.",
          flow: projectTaskFlowForPublicView(flow),
        };
      }
      return {
        created: true,
        flow: projectManagedTaskFlowForPublicView(managed),
        task: created.task,
      };
    },
  };
}

export function createRuntimeTaskFlow(): PluginRuntimeTaskFlow {
  return {
    bindSession: (params) =>
      createBoundTaskFlowRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskFlowRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "TaskFlow runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}
