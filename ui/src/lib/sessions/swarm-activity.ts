import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";

// Lifecycle notes are transient UI state, so bound them for long-lived board tabs.
const MAX_TRACKED_SWARM_GROUPS = 128;
const MAX_TRACKED_SWARM_CHILDREN = 2_048;

type SwarmDisplayCarrier = {
  swarmPhaseRank?: number;
  swarmLog?: string;
  swarmPhase?: string;
};

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

/** Tracks transient, group-scoped Swarm notes across canonical session-list refreshes. */
export class SwarmActivityTracker {
  private readonly currentPhaseByGroup = new Map<string, string>();
  // First-observation rank per "<groupId>\u0000<phase>": buckets render in the
  // order phases were announced, not in canonical session-list row order.
  private readonly phaseRankByGroupPhase = new Map<string, number>();
  private nextPhaseRank = 0;
  private readonly latestLogByGroup = new Map<string, string>();
  private readonly phaseByChild = new Map<string, string>();

  clear(): void {
    this.currentPhaseByGroup.clear();
    this.phaseRankByGroupPhase.clear();
    this.nextPhaseRank = 0;
    this.latestLogByGroup.clear();
    this.phaseByChild.clear();
  }

  observe(payload: unknown): void {
    const event = asNullableRecord(payload);
    if (!event) {
      return;
    }
    const source = asNullableRecord(event.session) ?? event;
    const groupId = normalizedString(event.swarmGroupId) ?? normalizedString(source.swarmGroupId);
    if (!groupId) {
      return;
    }

    const kind = normalizedString(event.kind);
    const text = normalizedString(event.text);
    if ((kind === "phase" || kind === "log") && text) {
      if (kind === "phase") {
        const rankKey = `${groupId}\u0000${text}`;
        if (!this.phaseRankByGroupPhase.has(rankKey)) {
          setBounded(
            this.phaseRankByGroupPhase,
            rankKey,
            this.nextPhaseRank,
            MAX_TRACKED_SWARM_CHILDREN,
          );
          this.nextPhaseRank += 1;
        }
      }
      setBounded(
        kind === "phase" ? this.currentPhaseByGroup : this.latestLogByGroup,
        groupId,
        text,
        MAX_TRACKED_SWARM_GROUPS,
      );
      return;
    }

    const childKey = normalizedString(source.key) ?? normalizedString(event.sessionKey);
    if (!childKey) {
      return;
    }
    const explicitPhase = normalizedString(source.swarmPhase) ?? normalizedString(event.swarmPhase);
    if (explicitPhase) {
      setBounded(this.phaseByChild, childKey, explicitPhase, MAX_TRACKED_SWARM_CHILDREN);
      return;
    }
    // Implicit phase assignment is a creation-time fact: only a child ADMITTED
    // after phase('X') belongs to X. Status/completion updates for a child that
    // predates any phase note must never retro-stamp it out of Unphased.
    if (normalizedString(event.reason) === "create" && !this.phaseByChild.has(childKey)) {
      const currentPhase = this.currentPhaseByGroup.get(groupId);
      if (currentPhase) {
        setBounded(this.phaseByChild, childKey, currentPhase, MAX_TRACKED_SWARM_CHILDREN);
      }
    }
  }

  decorate(result: SessionsListResult | null): SessionsListResult | null {
    if (!result) {
      return result;
    }
    let changed = false;
    const sessions = result.sessions.map((row): GatewaySessionRow => {
      const carrier = row as GatewaySessionRow & SwarmDisplayCarrier;
      const phase = this.phaseByChild.get(row.key) ?? carrier.swarmPhase;
      const groupId = row.swarmGroupId?.trim();
      const log = (groupId ? this.latestLogByGroup.get(groupId) : undefined) ?? carrier.swarmLog;
      const phaseRank =
        (phase && groupId
          ? this.phaseRankByGroupPhase.get(`${groupId}\u0000${phase}`)
          : undefined) ?? carrier.swarmPhaseRank;
      if (
        phase === carrier.swarmPhase &&
        log === carrier.swarmLog &&
        phaseRank === carrier.swarmPhaseRank
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        ...(phase ? { swarmPhase: phase } : {}),
        ...(phaseRank !== undefined ? { swarmPhaseRank: phaseRank } : {}),
        ...(log ? { swarmLog: log } : {}),
      };
    });
    return changed ? { ...result, sessions } : result;
  }
}
