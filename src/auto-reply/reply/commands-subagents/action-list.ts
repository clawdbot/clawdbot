// Lists subagent runs with lifecycle status.
import { buildSubagentList } from "../../../agents/subagents/registry/subagent-list.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { type SubagentsCommandContext, RECENT_WINDOW_MINUTES } from "./shared.js";

export function handleSubagentsListAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, runs } = ctx;
  const list = buildSubagentList({
    cfg: params.cfg,
    runs,
    recentMinutes: RECENT_WINDOW_MINUTES,
    taskMaxChars: 110,
  });
  const lines = ["active subagents:", "-----"];
  if (list.active.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(list.active.map((entry) => entry.line).join("\n"));
  }
  lines.push("", `recent subagents (last ${RECENT_WINDOW_MINUTES}m):`, "-----");
  if (list.recent.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(list.recent.map((entry) => entry.line).join("\n"));
  }
  if (list.sharedCwdGroupTotal > 0) {
    lines.push(
      "",
      `shared working directories (${list.sharedCwdGroups.length}/${list.sharedCwdGroupTotal} shown):`,
    );
    for (const group of list.sharedCwdGroups) {
      lines.push(
        `[cwd ${group.id}] ${group.runCount} live runs: ${group.path} (sample: ${group.runIds.join(", ")})`,
      );
    }
  }

  return commandReply(lines.join("\n"));
}
