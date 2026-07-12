/**
 * subagents built-in tool.
 *
 * Lists active and recent subagents controlled by the caller's session tree.
 */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
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

const SUBAGENT_ACTIONS = ["list"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  recentMinutes: optionalPositiveIntegerSchema(),
});

/** Creates the subagents list tool scoped to the caller's controlled session tree. */
export function createSubagentsTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description:
      "List requester-session active/recent subagents. If available, wait via sessions_yield; never poll-loop.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = getRuntimeConfig();
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

      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
