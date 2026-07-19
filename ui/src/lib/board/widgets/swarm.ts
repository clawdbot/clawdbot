import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { areUiSessionKeysEquivalent } from "../../sessions/session-key.ts";

type SwarmDotStatus = "queued" | "running" | "done" | "failed";

type SwarmDot = {
  key: string;
  label: string;
  status: SwarmDotStatus;
};

type SwarmPhase = {
  title?: string;
  dots: SwarmDot[];
};

type SwarmGroup = {
  groupId: string;
  label: string;
  running: number;
  done: number;
  failed: number;
  phases: SwarmPhase[];
};

type SwarmPhaseCarrier = {
  swarmPhase?: unknown;
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

function swarmPhase(row: GatewaySessionRow): string | undefined {
  // Phase events will attach this optional display bucket. Until then every
  // collector child belongs to the single unlabelled phase below.
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

/** Groups the live session roster into the active collector swarms for one dashboard. */
function collectActiveSwarmGroups(
  sessions: readonly GatewaySessionRow[],
  sessionKey: string,
): SwarmGroup[] {
  const byGroup = new Map<string, Array<{ phase?: string; dot: SwarmDot }>>();
  for (const row of sessions) {
    const groupId = row.swarmGroupId?.trim();
    if (!groupId || !isSwarmChildForSession(row, sessionKey)) {
      continue;
    }
    const dots = byGroup.get(groupId) ?? [];
    const status = swarmDotStatus(row);
    if (!status) {
      continue;
    }
    dots.push({
      phase: swarmPhase(row),
      dot: {
        key: row.key,
        label: row.label?.trim() || row.displayName?.trim() || row.derivedTitle?.trim() || row.key,
        status,
      },
    });
    byGroup.set(groupId, dots);
  }

  return [...byGroup.entries()]
    .map(([groupId, entries]) => {
      const dots = entries.map((entry) => entry.dot);
      const phases = new Map<string | undefined, SwarmDot[]>();
      for (const entry of entries) {
        const phaseDots = phases.get(entry.phase) ?? [];
        phaseDots.push(entry.dot);
        phases.set(entry.phase, phaseDots);
      }
      return {
        groupId,
        label: groupTail(groupId),
        running: dots.filter((dot) => dot.status === "running").length,
        done: dots.filter((dot) => dot.status === "done").length,
        failed: dots.filter((dot) => dot.status === "failed").length,
        phases: [...phases.entries()].map(([title, phaseDots]) => ({ title, dots: phaseDots })),
      } satisfies SwarmGroup;
    })
    .filter((group) =>
      group.phases.some((phase) =>
        phase.dots.some((dot) => dot.status === "queued" || dot.status === "running"),
      ),
    )
    .toSorted((left, right) => left.groupId.localeCompare(right.groupId));
}

export function renderSwarmWidget({
  sessions,
  sessionKey,
}: {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
}): TemplateResult {
  const groups = collectActiveSwarmGroups(sessions, sessionKey);
  if (groups.length === 0) {
    return html`<p class="swarm-widget__empty" data-test-id="swarm-empty">
      ${t("labsPage.swarm.empty")}
    </p>`;
  }
  return html`
    <div class="swarm-widget" data-test-id="swarm-widget">
      ${groups.map(
        (group) => html`
          <section class="swarm-widget__group" data-swarm-group=${group.groupId}>
            <header class="swarm-widget__group-header">
              <strong title=${group.groupId}>${group.label}</strong>
              <span
                >${group.running} ${swarmStatusLabel("running")} · ${group.done}
                ${swarmStatusLabel("done")} · ${group.failed} ${swarmStatusLabel("failed")}</span
              >
            </header>
            ${group.phases.map(
              (phase) => html`
                ${phase.title
                  ? html`<div class="swarm-widget__phase">${phase.title}</div>`
                  : nothing}
                <div class="swarm-widget__dots" role="list">
                  ${phase.dots.map(
                    (dot) => html`
                      <span
                        class=${`swarm-widget__dot swarm-widget__dot--${dot.status}`}
                        role="listitem"
                        title=${`${dot.label}: ${swarmStatusLabel(dot.status)}`}
                        aria-label=${`${dot.label}: ${swarmStatusLabel(dot.status)}`}
                      ></span>
                    `,
                  )}
                </div>
              `,
            )}
          </section>
        `,
      )}
    </div>
  `;
}
