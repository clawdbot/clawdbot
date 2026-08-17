/**
 * subagents built-in tool.
 *
 * Lists and cancels background work in the caller's session tree.
 */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listTaskRecordsUnsorted } from "../../tasks/runtime-internal.js";
import { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { TASK_STATUS_DETAIL_MAX_CHARS, sanitizeTaskStatusText } from "../../tasks/task-status.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "../subagents/registry/subagent-control.js";
import { buildSubagentList } from "../subagents/registry/subagent-list.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";

const SUBAGENT_ACTIONS = ["list", "cancel"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  recentMinutes: optionalPositiveIntegerSchema(),
  taskId: Type.Optional(Type.String({ description: "Task id" })),
});

const STATUS_MAP: Record<TaskStatus, string> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

type SubagentsToolOptions = {
  agentSessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  listTasks?: typeof listTaskRecordsUnsorted;
  cancelTask?: typeof cancelDetachedTaskRunById;
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function resolveTaskRequesterAgentId(task: TaskRecord, cfg: OpenClawConfig): string | undefined {
  if (task.requesterAgentId) {
    return task.requesterAgentId;
  }
  return resolveSessionAgentId({ sessionKey: task.ownerKey, config: cfg });
}

function taskOwnerMatches(
  task: TaskRecord,
  sessionKey: string,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  return task.ownerKey === sessionKey && resolveTaskRequesterAgentId(task, cfg) === agentId;
}

function listTreeTasks(
  tasks: TaskRecord[],
  rootSessionKey: string,
  rootAgentId: string,
  cfg: OpenClawConfig,
): TaskRecord[] {
  const visibleSessions = new Set([`${rootAgentId}\0${rootSessionKey}`]);
  const visibleTasks = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.scopeKind !== "session" || visibleTasks.has(task.taskId)) {
        continue;
      }
      const taskRequesterAgentId = resolveTaskRequesterAgentId(task, cfg);
      if (!visibleSessions.has(`${taskRequesterAgentId ?? ""}\0${task.ownerKey}`)) {
        continue;
      }
      visibleTasks.add(task.taskId);
      if (task.childSessionKey) {
        const childIdentity = `${task.agentId ?? taskRequesterAgentId ?? ""}\0${task.childSessionKey}`;
        if (!visibleSessions.has(childIdentity)) {
          visibleSessions.add(childIdentity);
          changed = true;
        }
      }
    }
  }
  return tasks.filter((task) => visibleTasks.has(task.taskId));
}

function mapTask(task: TaskRecord) {
  // Task failures can contain hidden provider/runtime context; reuse the bounded status owner.
  const error = sanitizeTaskStatusText(task.error, {
    errorContext: true,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    status:
      task.status === "succeeded" && task.terminalOutcome === "blocked"
        ? "blocked"
        : STATUS_MAP[task.status],
    ...(task.label ? { label: task.label } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
    ...(task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}),
    ...(error ? { error } : {}),
  };
}

/** Creates the subagents list tool scoped to the caller's controlled session tree. */
export function createSubagentsTool(opts: SubagentsToolOptions = {}): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description: "Background work: subagents, media gen, automation runs. list/cancel.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readToolStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = opts.config ?? getRuntimeConfig();
      const recentMinutesRaw = readPositiveIntegerParam(params, "recentMinutes");
      const recentMinutes =
        recentMinutesRaw === undefined
          ? DEFAULT_RECENT_MINUTES
          : Math.min(MAX_RECENT_MINUTES, recentMinutesRaw);
      const controller = resolveSubagentController({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
        agentId: opts.agentId,
      });
      const controllerAgentId = controller.controllerAgentId;
      if (!controllerAgentId) {
        throw new ToolInputError("subagent controller agent required");
      }
      // The caller only sees subagents controlled by its effective controller session.
      const runs = listControlledSubagentRuns(
        controller.controllerSessionKey,
        controllerAgentId,
        cfg,
      );
      const treeTasks = listTreeTasks(
        (opts.listTasks ?? listTaskRecordsUnsorted)(),
        controller.controllerSessionKey,
        controllerAgentId,
        cfg,
      );

      if (action === "list") {
        const list = buildSubagentList({
          cfg,
          runs,
          recentMinutes,
        });
        const cutoff = Date.now() - recentMinutes * 60_000;
        const tasks = treeTasks
          .filter(
            (task) =>
              task.status === "queued" ||
              task.status === "running" ||
              taskUpdatedAt(task) >= cutoff,
          )
          .toSorted((left, right) => taskUpdatedAt(right) - taskUpdatedAt(left))
          .map(mapTask);
        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey: controller.controllerSessionKey,
          callerSessionKey: controller.callerSessionKey,
          callerIsSubagent: controller.callerIsSubagent,
          total: list.total,
          taskTotal: tasks.length,
          tasks,
          active: list.active.map(({ line: _line, ...view }) => view),
          recent: list.recent.map(({ line: _line, ...view }) => view),
          text: list.text,
        });
      }

      if (action === "cancel") {
        const taskId = readToolStringParam(params, "taskId", { required: true });
        const target = treeTasks.find((task) => task.taskId === taskId);
        if (!target) {
          return jsonResult({ status: "forbidden", error: "Task outside session tree." });
        }
        // Leaf subagents may cancel only their own tasks, matching the
        // control-scope gate every other cross-session subagent mutation enforces.
        if (
          controller.controlScope !== "children" &&
          !taskOwnerMatches(target, controller.callerSessionKey, controllerAgentId, cfg)
        ) {
          return jsonResult({
            status: "forbidden",
            error: "Leaf subagents cannot cancel other sessions.",
          });
        }
        const result = await (opts.cancelTask ?? cancelDetachedTaskRunById)({ cfg, taskId });
        return jsonResult({
          status: result.cancelled ? "cancelled" : "error",
          taskId,
          found: result.found,
          cancelled: result.cancelled,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }

      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
