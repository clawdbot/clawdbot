import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { isActiveTask, sortTasks, taskTimestampMs, taskTitle } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderDiffStatChips } from "./chat-diff-render.ts";

const SUBAGENT_ACTIVITY_LIMIT = 5;
const SUBAGENT_ACTIVITY_TERMINAL_RETENTION_MS = 60_000;

export type SubagentActivityPresentation = {
  rows: TaskSummary[];
  overflowWorking: number;
  taskIds: ReadonlySet<string>;
  nextExpiryAt: number | null;
};

export function deriveSubagentActivity(params: {
  tasks: readonly TaskSummary[];
  sessionKey: string;
  terminalObservedAtByTask: ReadonlyMap<string, number>;
  canonicalizeSessionKey: (sessionKey: string | undefined) => string;
  now?: number;
}): SubagentActivityPresentation {
  const now = params.now ?? Date.now();
  const requesterSessionKey = params.canonicalizeSessionKey(params.sessionKey);
  const matching = sortTasks(
    params.tasks.filter((task) => {
      const taskRequesterSessionKey = params.canonicalizeSessionKey(task.sessionKey);
      return (
        task.runtime === "subagent" &&
        Boolean(requesterSessionKey) &&
        taskRequesterSessionKey === requesterSessionKey
      );
    }),
  );
  const active = matching.filter(isActiveTask);
  const recentTerminal: TaskSummary[] = [];
  let nextExpiryAt: number | null = null;
  for (const task of matching) {
    if (isActiveTask(task)) {
      continue;
    }
    const terminalAt =
      params.terminalObservedAtByTask.get(task.id) ??
      taskTimestampMs(task.endedAt ?? task.updatedAt);
    const expiresAt = terminalAt + SUBAGENT_ACTIVITY_TERMINAL_RETENTION_MS;
    if (terminalAt <= 0 || expiresAt <= now) {
      continue;
    }
    recentTerminal.push(task);
    nextExpiryAt = nextExpiryAt === null ? expiresAt : Math.min(nextExpiryAt, expiresAt);
  }
  // Active children stay visible ahead of retained completions so a burst of
  // terminal events cannot displace work that is still progressing.
  const eligible = [...active, ...recentTerminal];
  const rows = eligible.slice(0, SUBAGENT_ACTIVITY_LIMIT);
  const overflowWorking = eligible
    .slice(SUBAGENT_ACTIVITY_LIMIT)
    .filter((task) => task.status === "running").length;
  return {
    rows,
    overflowWorking,
    taskIds: new Set(eligible.map((task) => task.id)),
    nextExpiryAt,
  };
}

function subagentActivityLabel(task: TaskSummary): string {
  if (isActiveTask(task)) {
    return t("chat.backgroundTasks.subagentActivity.working");
  }
  if (task.status === "cancelled") {
    return t("chat.backgroundTasks.subagentActivity.cancelled");
  }
  if (task.status === "failed" || task.status === "timed_out") {
    return t("chat.backgroundTasks.subagentActivity.failed");
  }
  return t("chat.backgroundTasks.subagentActivity.finished");
}

function subagentActivitySnippet(task: TaskSummary): string | undefined {
  if (!isActiveTask(task) && task.terminalSummary?.trim()) {
    return task.terminalSummary.trim();
  }
  return (
    task.lastActivity?.trim() ||
    task.progressSummary?.trim() ||
    task.lastToolName?.trim() ||
    undefined
  );
}

function renderSubagentActivityIndicator(task: TaskSummary): TemplateResult {
  if (isActiveTask(task)) {
    return html`<span
      class="chat-subagent-activity__indicator chat-reading-indicator"
      aria-hidden="true"
      >${icons.claw}</span
    >`;
  }
  const failed = task.status !== "completed";
  return html`<span
    class="chat-subagent-activity__indicator chat-subagent-activity__indicator--${failed
      ? "failed"
      : "finished"}"
    aria-hidden="true"
    >${failed ? icons.x : icons.check}</span
  >`;
}

function renderSubagentActivityRow(
  task: TaskSummary,
  onOpenTaskDetail?: (task: TaskSummary) => void,
): TemplateResult {
  const snippet = subagentActivitySnippet(task);
  const label = subagentActivityLabel(task);
  const content = html`
    ${renderSubagentActivityIndicator(task)}
    <span class="chat-subagent-activity__label">${label}</span>
    ${snippet
      ? keyed(
          `${task.status}:${snippet}`,
          html`<span
            class="chat-subagent-activity__snippet chat-subagent-activity__snippet--updated"
            title=${snippet}
            >${snippet}</span
          >`,
        )
      : nothing}
    ${task.diffStat ? renderDiffStatChips(task.diffStat) : nothing}
  `;
  if (!onOpenTaskDetail) {
    return html`<div
      class="chat-subagent-activity__row"
      data-subagent-task-id=${task.id}
      role="status"
      aria-live="off"
    >
      ${content}
    </div> `;
  }
  return html`<button
    class="chat-subagent-activity__row chat-subagent-activity__row--interactive"
    data-subagent-task-id=${task.id}
    type="button"
    aria-label=${t("chat.backgroundTasks.subagentActivity.openDetails", {
      title: taskTitle(task),
    })}
    @click=${() => onOpenTaskDetail(task)}
  >
    ${content}
  </button>`;
}

export function renderSubagentActivity(
  presentation: SubagentActivityPresentation,
  onOpenTaskDetail?: (task: TaskSummary) => void,
): TemplateResult | typeof nothing {
  if (presentation.rows.length === 0) {
    return nothing;
  }
  return html`
    <div
      class="chat-subagent-activity"
      aria-label=${t("chat.backgroundTasks.subagentActivity.label")}
    >
      ${repeat(
        presentation.rows,
        (task) => task.id,
        (task) => renderSubagentActivityRow(task, onOpenTaskDetail),
      )}
      ${presentation.overflowWorking > 0
        ? html`<div class="chat-subagent-activity__overflow">
            ${t("chat.backgroundTasks.subagentActivity.moreWorking", {
              count: String(presentation.overflowWorking),
            })}
          </div>`
        : nothing}
    </div>
  `;
}
