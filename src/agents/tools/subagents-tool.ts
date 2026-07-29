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
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "../subagent-control.js";
import { buildSubagentList } from "../subagent-list.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readPositiveIntegerParam, readStringParam } from "./common.js";

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
  config?: OpenClawConfig;
  listTasks?: typeof listTaskRecordsUnsorted;
  cancelTask?: typeof cancelDetachedTaskRunById;
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function listTreeTasks(tasks: TaskRecord[], rootSessionKey: string): TaskRecord[] {
  const visibleKeys = new Set([rootSessionKey]);
  const visibleTasks = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.scopeKind !== "session" || visibleTasks.has(task.taskId)) {
        continue;
      }
      if (!visibleKeys.has(task.ownerKey)) {
        continue;
      }
      visibleTasks.add(task.taskId);
      if (task.childSessionKey && !visibleKeys.has(task.childSessionKey)) {
        visibleKeys.add(task.childSessionKey);
        changed = true;
      }
    }
  }
  return tasks.filter((task) => visibleTasks.has(task.taskId));
}

function mapTask(task: TaskRecord) {
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    status: STATUS_MAP[task.status],
    ...(task.label ? { label: task.label } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
  };
}

/** Creates the subagents list tool scoped to the caller's controlled session tree. */
export function createSubagentsTool(opts: SubagentsToolOptions = {}): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description: "Background work: subagents, media gen, cron runs. list/cancel.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = opts.config ?? getRuntimeConfig();
      const recentMinutesRaw = readPositiveIntegerParam(params, "recentMinutes");
      const recentMinutes =
        recentMinutesRaw === undefined
          ? DEFAULT_RECENT_MINUTES
          : Math.min(MAX_RECENT_MINUTES, recentMinutesRaw);
      const controller = resolveSubagentController({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
      });
      // The caller only sees subagents controlled by its effective controller session.
      const runs = listControlledSubagentRuns(controller.controllerSessionKey);
      const treeTasks = listTreeTasks(
        (opts.listTasks ?? listTaskRecordsUnsorted)(),
        controller.controllerSessionKey,
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
        const taskId = readStringParam(params, "taskId", { required: true });
        const target = treeTasks.find((task) => task.taskId === taskId);
        if (!target) {
          return jsonResult({ status: "forbidden", error: "Task outside session tree." });
        }
        // Leaf subagents may cancel only their own tasks, matching the
        // control-scope gate every other cross-session subagent mutation enforces.
        if (
          controller.controlScope !== "children" &&
          target.ownerKey !== controller.callerSessionKey
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
