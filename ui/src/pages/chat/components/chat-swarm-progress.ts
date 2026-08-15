import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";

type SwarmDotStatus = "queued" | "running" | "done" | "failed";

const SWARM_DOT_STATUS_RANK = { running: 0, queued: 1, failed: 2, done: 3 } as const;
const MAX_RENDERED_DOTS_PER_PHASE = 256;

type SwarmDot = {
  key: string;
  label: string;
  status: SwarmDotStatus;
};

type SwarmPhase = {
  title?: string;
  dots: SwarmDot[];
  hidden: number;
};

type SwarmGroup = {
  groupId: string;
  label: string;
  running: number;
  done: number;
  failed: number;
  narrator?: string;
  phases: SwarmPhase[];
};

type SwarmPhaseCarrier = {
  swarmLog?: unknown;
  swarmPhase?: unknown;
  swarmPhaseRank?: unknown;
};

function swarmStatusLabel(status: SwarmDotStatus): string {
  if (status === "queued") {
    return t("tasksPage.status.queued");
  }
  if (status === "running") {
    return t("tasksPage.status.running");
  }
  if (status === "done") {
    return t("activity.status.done");
  }
  return t("tasksPage.status.failed");
}

function swarmDotStatus(row: GatewaySessionRow): SwarmDotStatus | null {
  if (row.status === "running" || row.hasActiveRun === true) {
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

function swarmLog(row: GatewaySessionRow): string | undefined {
  const log = (row as GatewaySessionRow & SwarmPhaseCarrier).swarmLog;
  return typeof log === "string" && log.trim() ? log.trim() : undefined;
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

function collectActiveSwarmGroups(
  sessions: readonly GatewaySessionRow[],
  sessionKey: string,
): SwarmGroup[] {
  const byGroup = new Map<
    string,
    Array<{ phase?: string; phaseRank: number; log?: string; dot: SwarmDot }>
  >();
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
      log: swarmLog(row),
      dot: {
        key: row.key,
        label: row.label?.trim() || row.displayName?.trim() || row.derivedTitle?.trim() || row.key,
        status,
      },
    });
    byGroup.set(groupId, entries);
  }

  return [...byGroup.entries()]
    .map(([groupId, entries]) => {
      const dots = entries.map((entry) => entry.dot);
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
        running: dots.filter((dot) => dot.status === "running").length,
        done: dots.filter((dot) => dot.status === "done").length,
        failed: dots.filter((dot) => dot.status === "failed").length,
        narrator: entries.map((entry) => entry.log).find(Boolean),
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
              dots: visibleFirst.slice(0, MAX_RENDERED_DOTS_PER_PHASE),
              hidden: Math.max(0, visibleFirst.length - MAX_RENDERED_DOTS_PER_PHASE),
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
      ${groups.map(
        (group) => html`
          <div class="chat-swarm__group" data-swarm-group=${group.groupId}>
            <div class="chat-swarm__header">
              <strong title=${group.groupId}>${group.label}</strong>
              <span
                >${group.running} ${swarmStatusLabel("running")} · ${group.done}
                ${swarmStatusLabel("done")} · ${group.failed} ${swarmStatusLabel("failed")}</span
              >
            </div>
            ${group.narrator
              ? html`<div class="chat-swarm__narrator">${group.narrator}</div>`
              : nothing}
            ${group.phases.map(
              (phase) => html`
                <div class="chat-swarm__phase-row">
                  <div class="chat-swarm__phase">
                    ${phase.title ?? t("labsPage.swarm.defaultPhase")}
                  </div>
                  <div class="chat-swarm__dots" role="list">
                    ${phase.dots.map(
                      (dot) => html`
                        <span
                          class=${`chat-swarm__dot chat-swarm__dot--${dot.status}`}
                          role="listitem"
                          title=${`${dot.label}: ${swarmStatusLabel(dot.status)}`}
                          aria-label=${`${dot.label}: ${swarmStatusLabel(dot.status)}`}
                        ></span>
                      `,
                    )}
                    ${phase.hidden > 0
                      ? html`<span class="chat-swarm__more" role="listitem">+${phase.hidden}</span>`
                      : nothing}
                  </div>
                </div>
              `,
            )}
          </div>
        `,
      )}
    </aside>
  `;
}
