/**
 * Active subagent prompt context builder.
 *
 * Renders sanitized runtime-owned subagent facts for the current-turn carrier.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { sanitizeForPromptLiteral } from "../../sanitize-for-prompt.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import { listControlledSubagentRuns } from "./subagent-control.js";
import { buildSubagentList } from "./subagent-list.js";

// Prompt data is sanitized then JSON-quoted so active subagent state cannot add
// executable prompt instructions through labels or task text.
function quotePromptData(value: string): string {
  return JSON.stringify(sanitizeForPromptLiteral(value));
}

/** Builds a bounded, deterministic snapshot without repeating system instructions. */
export function buildActiveSubagentRuntimeContext(params: {
  cfg: OpenClawConfig;
  controllerSessionKey?: string;
  controllerAgentId?: string;
  recentMinutes?: number;
}): string | undefined {
  const rawControllerSessionKey = params.controllerSessionKey?.trim();
  if (!rawControllerSessionKey) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const controllerSessionKey = resolveInternalSessionKey({
    key: rawControllerSessionKey,
    alias,
    mainKey,
  });
  const runs = listControlledSubagentRuns(
    controllerSessionKey,
    params.controllerAgentId,
    params.cfg,
  );
  if (runs.length === 0) {
    return undefined;
  }
  const list = buildSubagentList({
    cfg: params.cfg,
    runs,
    recentMinutes: params.recentMinutes ?? 30,
    taskMaxChars: 96,
  });
  if (list.active.length === 0) {
    return undefined;
  }
  return [
    "## Active Subagents",
    ...list.active
      .toSorted((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
      .slice(0, 16)
      .map((entry) =>
        [
          "-",
          entry.taskName ? `taskName=${entry.taskName};` : undefined,
          `session=${entry.sessionKey};`,
          `run=${entry.runId};`,
          `status=${entry.status};`,
          `label_json=${quotePromptData(entry.label)};`,
          `task_json=${quotePromptData(entry.task)}`,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ...(list.active.length > 16 ? [`- additional_runs=${list.active.length - 16}`] : []),
  ].join("\n");
}
