import { cancelTaskById, listTasksForFlowId } from "../../tasks/runtime-internal.js";
import {
  mapTaskFlowDetail,
  mapTaskFlowView,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "../../tasks/task-domain-views.js";
import { getFlowTaskSummary } from "../../tasks/task-executor.js";
import {
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  findLatestTaskFlowForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import {
  findLatestTaskForRelatedSessionKeyForOwner,
  getTaskByIdForOwner,
  listTasksForRelatedSessionKeyForOwner,
  resolveTaskForLookupTokenForOwner,
} from "../../tasks/task-owner-access.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { PluginRuntimeTaskFlow } from "./runtime-taskflow.types.js";
import type {
  BoundTaskFlowsRuntime,
  BoundTaskRunsRuntime,
  PluginRuntimeTaskFlows,
  PluginRuntimeTaskRuns,
  PluginRuntimeTasks,
  TaskFlowDetail,
  TaskRunCancelResult,
} from "./runtime-tasks.types.js";
export type {
  BoundTaskFlowsRuntime,
  BoundTaskRunsRuntime,
  PluginRuntimeTaskFlows,
  PluginRuntimeTaskRuns,
  PluginRuntimeTasks,
} from "./runtime-tasks.types.js";

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function mapCancelledTaskResult(
  result: Awaited<ReturnType<typeof cancelTaskById>>,
): TaskRunCancelResult {
  return {
    found: result.found,
    cancelled: result.cancelled,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.task ? { task: mapTaskRunDetail(result.task) } : {}),
  };
}

function createBoundTaskRunsRuntime(params: {
  sessionKey: string;
  requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
}): BoundTaskRunsRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "Tasks runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;
  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    get: (taskId) => {
      const task = getTaskByIdForOwner({ taskId, callerOwnerKey: ownerKey });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    list: () =>
      listTasksForRelatedSessionKeyForOwner({
        relatedSessionKey: ownerKey,
        callerOwnerKey: ownerKey,
      }).map((task) => mapTaskRunView(task)),
    findLatest: () => {
      const task = findLatestTaskForRelatedSessionKeyForOwner({
        relatedSessionKey: ownerKey,
        callerOwnerKey: ownerKey,
      });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    resolve: (token) => {
      const task = resolveTaskForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    cancel: async ({ taskId, cfg }) => {
      const task = getTaskByIdForOwner({
        taskId,
        callerOwnerKey: ownerKey,
      });
      if (!task) {
        return {
          found: false,
          cancelled: false,
          reason: "Task not found.",
        };
      }
      return mapCancelledTaskResult(
        await cancelTaskById({
          cfg,
          taskId: task.taskId,
        }),
      );
    },
  };
}

function createBoundTaskFlowsRuntime(params: {
  sessionKey: string;
  requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
}): BoundTaskFlowsRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;

  const getDetail = (flowId: string): TaskFlowDetail | undefined => {
    const flow = getTaskFlowByIdForOwner({
      flowId,
      callerOwnerKey: ownerKey,
    });
    if (!flow) {
      return undefined;
    }
    const tasks = listTasksForFlowId(flow.flowId);
    return mapTaskFlowDetail({
      flow,
      tasks,
      summary: getFlowTaskSummary(flow.flowId),
    });
  };

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    get: (flowId) => getDetail(flowId),
    list: () =>
      listTaskFlowsForOwner({
        callerOwnerKey: ownerKey,
      }).map((flow) => mapTaskFlowView(flow)),
    findLatest: () => {
      const flow = findLatestTaskFlowForOwner({
        callerOwnerKey: ownerKey,
      });
      return flow ? getDetail(flow.flowId) : undefined;
    },
    resolve: (token) => {
      const flow = resolveTaskFlowForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      });
      return flow ? getDetail(flow.flowId) : undefined;
    },
    getTaskSummary: (flowId) => {
      const flow = getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      });
      return flow ? mapTaskRunAggregateSummary(getFlowTaskSummary(flow.flowId)) : undefined;
    },
  };
}

export function createRuntimeTaskRuns(): PluginRuntimeTaskRuns {
  return {
    bindSession: (params) =>
      createBoundTaskRunsRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskRunsRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "Tasks runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}

export function createRuntimeTaskFlows(): PluginRuntimeTaskFlows {
  return {
    bindSession: (params) =>
      createBoundTaskFlowsRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskFlowsRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "TaskFlow runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}

export function createRuntimeTasks(params: {
  legacyTaskFlow: PluginRuntimeTaskFlow;
}): PluginRuntimeTasks {
  return {
    runs: createRuntimeTaskRuns(),
    flows: createRuntimeTaskFlows(),
    flow: params.legacyTaskFlow,
  };
}
