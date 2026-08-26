import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact } from "../../../lib/format.ts";
import { isSessionRunActive } from "../../../lib/session-run-state.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { replaceComposerPopoverAnchor } from "./chat-composer-dom.ts";

type SwarmDotStatus = "queued" | "running" | "done" | "failed";

const SWARM_DOT_STATUS_RANK = { running: 0, queued: 1, failed: 2, done: 3 } as const;
const MAX_RENDERED_DOTS_PER_PHASE = 256;

type SwarmDot = {
  key: string;
  label: string;
  status: SwarmDotStatus;
  duration: string;
};

type SwarmPhase = {
  title?: string;
  dots: SwarmDot[];
};

type SwarmGroup = {
  groupId: string;
  label: string;
  phases: SwarmPhase[];
};

type SwarmPhaseCarrier = {
  swarmPhase?: unknown;
  swarmPhaseRank?: unknown;
};

function swarmDotStatus(row: GatewaySessionRow): SwarmDotStatus | null {
  if (row.status === "queued") {
    return "queued";
  }
  if (isSessionRunActive(row)) {
    return "running";
  }
  if (row.status === "done") {
    return "done";
  }
  if (row.status === "failed" || row.status === "killed" || row.status === "timeout") {
    return "failed";
  }
  return row.subagentRunState === "active" ? "queued" : null;
}

function groupTail(groupId: string): string {
  return groupId.split(":").findLast(Boolean) ?? groupId;
}

function swarmPhaseRank(row: GatewaySessionRow): number {
  const rank = (row as GatewaySessionRow & SwarmPhaseCarrier).swarmPhaseRank;
  return typeof rank === "number" && Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER;
}

function swarmPhase(row: GatewaySessionRow): string | undefined {
  const phase = (row as GatewaySessionRow & SwarmPhaseCarrier).swarmPhase;
  return typeof phase === "string" && phase.trim() ? phase.trim() : undefined;
}

function isSwarmChildForSession(row: GatewaySessionRow, sessionKey: string): boolean {
  if (
    (row.parentSessionKey && areUiSessionKeysEquivalent(row.parentSessionKey, sessionKey)) ||
    (row.spawnedBy && areUiSessionKeysEquivalent(row.spawnedBy, sessionKey))
  ) {
    return true;
  }
  const owner = row.swarmGroupId?.split(":").slice(1, -1).join(":");
  return Boolean(owner && areUiSessionKeysEquivalent(owner, sessionKey));
}

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

function collectActiveSwarmGroups(
  sessions: readonly GatewaySessionRow[],
  sessionKey: string,
): SwarmGroup[] {
  const byGroup = new Map<string, Array<{ phase?: string; phaseRank: number; dot: SwarmDot }>>();
  for (const row of sessions) {
    const groupId = row.swarmGroupId?.trim();
    if (!groupId || !isSwarmChildForSession(row, sessionKey)) {
      continue;
    }
    const status = swarmDotStatus(row);
    if (!status) {
      continue;
    }
    const entries = byGroup.get(groupId) ?? [];
    entries.push({
      phase: swarmPhase(row),
      phaseRank: swarmPhaseRank(row),
      dot: {
        key: row.key,
        label: row.label?.trim() || row.displayName?.trim() || row.derivedTitle?.trim() || row.key,
        status,
        duration: swarmDuration(row, status),
      },
    });
    byGroup.set(groupId, entries);
  }

  return [...byGroup.entries()]
    .map(([groupId, entries]) => {
      const phases = new Map<string | undefined, { rank: number; dots: SwarmDot[] }>();
      for (const entry of entries) {
        const bucket = phases.get(entry.phase) ?? { rank: entry.phaseRank, dots: [] };
        bucket.rank = Math.min(bucket.rank, entry.phaseRank);
        bucket.dots.push(entry.dot);
        phases.set(entry.phase, bucket);
      }
      return {
        groupId,
        label: groupTail(groupId),
        phases: [...phases.entries()]
          .toSorted((left, right) => left[1].rank - right[1].rank)
          .map(([title, bucket]) => {
            const visibleFirst =
              bucket.dots.length > MAX_RENDERED_DOTS_PER_PHASE
                ? bucket.dots.toSorted(
                    (left, right) =>
                      SWARM_DOT_STATUS_RANK[left.status] - SWARM_DOT_STATUS_RANK[right.status],
                  )
                : bucket.dots;
            return {
              title,
              dots: visibleFirst,
            };
          }),
      } satisfies SwarmGroup;
    })
    .filter((group) =>
      group.phases.some((phase) =>
        phase.dots.some((dot) => dot.status === "queued" || dot.status === "running"),
      ),
    )
    .toSorted((left, right) => left.groupId.localeCompare(right.groupId));
}

export function renderChatSwarmProgress({
  sessions,
  sessionKey,
}: {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
}): TemplateResult | typeof nothing {
  const groups = collectActiveSwarmGroups(sessions, sessionKey);
  if (groups.length === 0) {
    return nothing;
  }
  return html`
    <aside
      class="chat-swarm"
      data-test-id="chat-swarm"
      role="status"
      aria-live="off"
      aria-label=${t("labsPage.swarm.title")}
    >
      ${groups.map((group) => {
        const allTasks = group.phases.flatMap((phase) => phase.dots);
        const tasks = group.phases.flatMap((phase) =>
          phase.dots.slice(0, MAX_RENDERED_DOTS_PER_PHASE),
        );
        const complete = allTasks.filter(
          (task) => task.status === "done" || task.status === "failed",
        ).length;
        const hasFailure = allTasks.some((task) => task.status === "failed");
        let popoverAnchor: HTMLElement | null = null;
        return html`
          <div
            class="chat-swarm__group ${hasFailure ? "chat-swarm__group--failed" : ""}"
            data-swarm-group=${group.groupId}
            tabindex="0"
            ${ref((element) => {
              popoverAnchor = replaceComposerPopoverAnchor(popoverAnchor, element);
            })}
          >
            <div class="chat-swarm__header">
              <strong title=${group.groupId}>${group.label}</strong>
              <span
                >${t("labsPage.swarm.progress", {
                  complete: String(complete),
                  total: String(allTasks.length),
                })}</span
              >
            </div>
            <div class="chat-swarm__progress" aria-hidden="true">
              ${group.phases.map((phase) => {
                const phaseProgress =
                  phase.dots.length === 0
                    ? 0
                    : Math.round(
                        (phase.dots.filter(
                          (task) => task.status === "done" || task.status === "failed",
                        ).length /
                          phase.dots.length) *
                          100,
                      );
                const phaseFailed = phase.dots.some((task) => task.status === "failed");
                return html`<span class="chat-swarm__progress-segment">
                  <span
                    class=${phaseFailed ? "chat-swarm__progress-fill--failed" : ""}
                    style=${`width:${phaseProgress}%`}
                  ></span>
                </span>`;
              })}
            </div>
            <div class="chat-swarm__tasks" role="list">
              ${tasks.map(
                (task) => html`
                  <div class="chat-swarm__task" role="listitem">
                    <span class=${`chat-swarm__task-icon chat-swarm__task-icon--${task.status}`}>
                      ${task.status === "done"
                        ? icons.check
                        : task.status === "failed"
                          ? icons.alertTriangle
                          : task.status === "running"
                            ? icons.loader
                            : icons.clock}
                    </span>
                    <span class="chat-swarm__task-name">${task.label}</span>
                    <span class="chat-swarm__task-duration">${task.duration}</span>
                  </div>
                `,
              )}
            </div>
          </div>
        `;
      })}
    </aside>
  `;
}
