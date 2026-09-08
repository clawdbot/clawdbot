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

// Hard cap on completed children in the parent prompt. Bursty sequential
// spawn/finish cycles would otherwise grow every later parent turn unbounded.
const RECENT_PROMPT_MAX_ENTRIES = 8;

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
  const recentMinutes = params.recentMinutes ?? 30;
  const list = buildSubagentList({
    cfg: params.cfg,
    runs,
    recentMinutes,
    taskMaxChars: 96,
  });
  // buildSubagentList returns recent runs in registry order, so sort before
  // capping to keep the prompt block deterministic across turns.
  const recentForPrompt = list.recent
    .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, RECENT_PROMPT_MAX_ENTRIES);
  if (list.active.length === 0 && recentForPrompt.length === 0) {
    return undefined;
  }
  const formatEntry = (entry: (typeof list.active)[number]) =>
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
      .join(" ");
  const lines: string[] = [];
  if (list.active.length > 0) {
    lines.push(
      "## Active Subagents",
      ...list.active
        .toSorted((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
        .slice(0, 16)
        .map(formatEntry),
      ...(list.active.length > 16 ? [`- additional_runs=${list.active.length - 16}`] : []),
    );
  }
  if (recentForPrompt.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      "## Recently Completed Subagents",
      `Children that ended in the last ${recentMinutes}m, newest first:`,
      ...recentForPrompt.map(formatEntry),
    );
  }
  return lines.join("\n");
}
