import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact } from "../../../lib/format.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";

type SwarmDotStatus = "queued" | "running" | "done" | "failed";

type SwarmDot = {
  key: string;
  label: string;
  status: SwarmDotStatus;
  duration: string;
};

function swarmDuration(row: GatewaySessionRow, status: SwarmDotStatus): string {
  if (status === "queued") {
    return "—";
  }
  let durationMs = row.runtimeMs;
  if (durationMs != null && status === "running" && row.runtimeSampledAt != null) {
    durationMs += Math.max(0, Date.now() - row.runtimeSampledAt);
  } else if (durationMs == null && row.startedAt != null) {
    const endAt = row.endedAt ?? (status === "running" ? Date.now() : undefined);
    if (endAt != null) {
      durationMs = Math.max(0, endAt - row.startedAt);
    }
  }
  return formatDurationCompact(durationMs) ?? "—";
}

function collectSwarmTasks(
  sessions: readonly GatewaySessionRow[],
  groups: NonNullable<GatewaySessionRow["swarm"]>["groups"],
): Map<string, SwarmDot[]> {
  const byGroup = new Map<string, Array<{ phaseRank: number; dot: SwarmDot }>>();
  const members = new Map(
    groups.map((group) => [
      group.groupId,
      new Map((group.children ?? []).map((child) => [child.sessionKey, child.status])),
    ]),
  );
  for (const row of sessions) {
    const groupId = row.swarmGroupId?.trim();
    const status = groupId ? members.get(groupId)?.get(row.key) : undefined;
    if (!status || !groupId) {
      continue;
    }
    const entries = byGroup.get(groupId) ?? [];
    entries.push({
      phaseRank: row.swarmPhaseRank ?? Number.MAX_SAFE_INTEGER,
      dot: {
        key: row.key,
        label: resolveSessionDisplayName(row.key, row, { includeSubagentPrefix: false }),
        status,
        duration: swarmDuration(row, status),
      },
    });
    byGroup.set(groupId, entries);
  }
  return new Map(
    [...byGroup].map(([groupId, entries]) => [
      groupId,
      entries.toSorted((left, right) => left.phaseRank - right.phaseRank).map((entry) => entry.dot),
    ]),
  );
}

export function renderChatSwarmProgress({
  sessions,
  sessionKey,
  agentId,
}: {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
  agentId?: string;
}): TemplateResult | typeof nothing {
  const summary = sessions.find(
    (row) =>
      areUiSessionKeysEquivalent(row.key, sessionKey) &&
      ((sessionKey !== "global" && sessionKey !== "unknown") ||
        Boolean(agentId && row.agentId === agentId)),
  )?.swarm;
  if (!summary?.groups.length) {
    return nothing;
  }
  const details = collectSwarmTasks(sessions, summary.groups);
  return html` <aside
    class="chat-swarm"
    data-test-id="chat-swarm"
    role="status"
    aria-live="off"
    aria-label=${t("labsPage.swarm.title")}
  >
    ${repeat(
      summary.groups,
      (group) => group.groupId,
      (group) => {
        const tasks = details.get(group.groupId) ?? [];
        const total = group.queued + group.running + group.done + group.failed;
        const complete = group.done + group.failed;
        const terminal = complete === total;
        const label = total === 1 && tasks[0] ? tasks[0].label : t("labsPage.swarm.groupTitle");
        const counts = t(terminal ? "labsPage.swarm.finished" : "labsPage.swarm.active", {
          running: String(group.running),
          queued: String(group.queued),
          done: String(group.done),
          failed: String(group.failed),
        });
        // Counts come from the requester registry, not the surviving child-session page.
        const markers = (["running", "queued", "failed", "done"] as const)
          .flatMap((status) => Array.from({ length: Math.min(group[status], 64) }, () => status))
          .slice(0, 64);
        return html` <details
          class="chat-swarm__group ${group.failed > 0 ? "chat-swarm__group--failed" : ""}"
          data-swarm-group=${group.groupId}
        >
          <summary class="chat-swarm__summary">
            <div class="chat-swarm__header">
              <strong title=${label}>${label}</strong>
              <span
                >${t("labsPage.swarm.progress", { complete: String(complete), total: String(total) })}</span
              >
            </div>
            <div class="chat-swarm__markers" role="img" aria-label=${counts}>
              ${markers.map((status) => html`<span class=${`chat-swarm__marker chat-swarm__marker--${status}`} aria-hidden="true"></span>`)}
              ${total > markers.length ? html`<span>+${total - markers.length}</span>` : nothing}
            </div>
            <div class="chat-swarm__counts">${counts}</div>
            ${terminal ? html`<div class="chat-swarm__outcome">${t("labsPage.swarm.childOutcome")}</div>` : nothing}
            <span class="chat-swarm__disclosure"
              >${t("labsPage.swarm.details")} ${icons.chevronDown}</span
            >
          </summary>
          <div class="chat-swarm__tasks" role="list">
            ${tasks.length === 0 ? html`<div class="chat-swarm__outcome">${t("labsPage.swarm.detailsUnavailable")}</div>` : nothing}
            ${tasks.map(
              (task) => html` <div class="chat-swarm__task" role="listitem">
                <span class=${`chat-swarm__task-icon chat-swarm__task-icon--${task.status}`}>
                  ${task.status === "done" ? icons.check : task.status === "failed" ? icons.alertTriangle : task.status === "running" ? icons.loader : icons.clock}
                </span>
                <span class="chat-swarm__task-name">${task.label}</span>
                <span class="chat-swarm__task-duration">${task.duration}</span>
              </div>`,
            )}
          </div>
        </details>`;
      },
    )}
    ${summary.otherActiveGroups > 0 ? html`<div class="chat-swarm__outcome">${t("labsPage.swarm.otherGroups", { count: String(summary.otherActiveGroups) })}</div>` : nothing}
  </aside>`;
}
