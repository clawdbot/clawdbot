import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  MAX_STEER_MESSAGE_CHARS,
  resolveControlledSubagentTarget,
  resolveSubagentController,
  steerControlledSubagentRun,
} from "../subagent-control.js";
import {
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
} from "../subagent-list.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SUBAGENT_ACTIONS = ["list", "kill", "steer"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  target: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  recentMinutes: Type.Optional(Type.Number({ minimum: 1 })),
});

export function createSubagentsTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description:
      "On-demand list, kill, or steer spawned sub-agents for this requester session. If sessions_yield is available, use it to wait for completion events; do not poll this tool in wait loops.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = getRuntimeConfig();
      const controller = resolveSubagentController({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
      });
      const runs = listControlledSubagentRuns(controller.controllerSessionKey);
      const recentMinutesRaw = readNumberParam(params, "recentMinutes");
      const recentMinutes = recentMinutesRaw
        ? Math.max(1, Math.min(MAX_RECENT_MINUTES, Math.floor(recentMinutesRaw)))
        : DEFAULT_RECENT_MINUTES;
      const pendingDescendantCount = createPendingDescendantCounter();
      const isActive = (entry: (typeof runs)[number]) =>
        isActiveSubagentRun(entry, pendingDescendantCount);

      if (action === "list") {
        const list = buildSubagentList({
          cfg,
          runs,
          recentMinutes,
        });
        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey: controller.controllerSessionKey,
          callerSessionKey: controller.callerSessionKey,
          callerIsSubagent: controller.callerIsSubagent,
          total: list.total,
          active: list.active.map(({ line: _line, ...view }) => view),
          recent: list.recent.map(({ line: _line, ...view }) => view),
          text: list.text,
        });
      }

      if (action === "kill") {
        const target = readStringParam(params, "target", { required: true });
        if (target === "all" || target === "*") {
          const result = await killAllControlledSubagentRuns({
            cfg,
            controller,
            runs,
          });
          if (result.status === "forbidden") {
            return jsonResult({
              status: "forbidden",
              action: "kill",
              target: "all",
              error: result.error,
            });
          }
          return jsonResult({
            status: "ok",
            action: "kill",
            target: "all",
            killed: result.killed,
            labels: result.labels,
            text:
              result.killed > 0
                ? `killed ${result.killed} subagent${result.killed === 1 ? "" : "s"}.`
                : "no running subagents to kill.",
          });
        }
        const resolved = resolveControlledSubagentTarget(runs, target, {
          recentMinutes,
          isActive,
        });
        if (!resolved.entry) {
          return jsonResult({
            status: "error",
            action: "kill",
            target,
            error: resolved.error ?? "Unknown subagent target.",
          });
        }
        const result = await killControlledSubagentRun({
          cfg,
          controller,
          entry: resolved.entry,
        });
        return jsonResult({
          status: result.status,
          action: "kill",
          target,
          runId: result.runId,
          sessionKey: result.sessionKey,
          label: result.label,
          cascadeKilled: "cascadeKilled" in result ? result.cascadeKilled : undefined,
          cascadeLabels: "cascadeLabels" in result ? result.cascadeLabels : undefined,
          error: "error" in result ? result.error : undefined,
          text: result.text,
        });
      }

      if (action === "steer") {
        const target = readStringParam(params, "target", { required: true });
        const message = readStringParam(params, "message", { required: true });
        if (message.length > MAX_STEER_MESSAGE_CHARS) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: `Message too long (${message.length} chars, max ${MAX_STEER_MESSAGE_CHARS}).`,
          });
        }
        const resolved = resolveControlledSubagentTarget(runs, target, {
          recentMinutes,
          isActive,
        });
        if (!resolved.entry) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: resolved.error ?? "Unknown subagent target.",
          });
        }
        const result = await steerControlledSubagentRun({
          cfg,
          controller,
          entry: resolved.entry,
          message,
        });
        return jsonResult({
          status: result.status,
          action: "steer",
          target,
          runId: result.runId,
          sessionKey: result.sessionKey,
          sessionId: result.sessionId,
          mode: "mode" in result ? result.mode : undefined,
          label: "label" in result ? result.label : undefined,
          error: "error" in result ? result.error : undefined,
          text: result.text,
        });
      }

      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
