import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../sessions/session-key.ts";
import { hydrateSwarmSessionRows, mergeSwarmSessionRows } from "./swarm-dashboard-roster.ts";
import type { BoardSnapshot } from "./types.ts";
import type { BoardViewSnapshot } from "./view-types.ts";

const SWARM_TAB_ID = "builtin-swarm";
const SWARM_WIDGET_NAME = "builtin:swarm";

function readSwarmEnabled(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const enabled = asNullableRecord(value)?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

export function isSwarmEnabledInConfig(config: unknown, agentId?: string): boolean {
  const root = asNullableRecord(config);
  const globalEnabled = readSwarmEnabled(asNullableRecord(root?.tools)?.swarm);
  const agents = asNullableRecord(root?.agents);
  const entries = asNullableRecord(agents?.entries);
  const listedEntries = Array.isArray(agents?.list)
    ? agents.list
    : Array.isArray(agents?.entries)
      ? agents.entries
      : [];
  const listedAgent = agentId
    ? listedEntries.map((entry) => asNullableRecord(entry)).find((entry) => entry?.id === agentId)
    : undefined;
  const agent = agentId ? (asNullableRecord(entries?.[agentId]) ?? listedAgent) : null;
  const agentEnabled = readSwarmEnabled(asNullableRecord(agent?.tools)?.swarm);
  return agentEnabled ?? globalEnabled ?? false;
}

type SwarmHydrationParams = {
  sessions: SessionCapability;
  parentKey: string;
  sourceEpoch: number;
  currentRows: () => readonly GatewaySessionRow[];
  onRows: (rows: GatewaySessionRow[]) => void;
};

export class SwarmRosterHydrator {
  rows: GatewaySessionRow[] = [];
  private key = "";
  private revision = -1;
  private generation = 0;
  private attemptRevision = -1;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  update(params: SwarmHydrationParams): void {
    const key = `${params.sourceEpoch}:${params.parentKey}`;
    if (this.key !== key) {
      this.reset(key);
    }
    this.rows = mergeSwarmSessionRows(this.rows, params.currentRows());
    params.onRows(this.rows);
    const revision = params.sessions.canonicalListRevision;
    if (this.attemptRevision !== revision) {
      this.attemptRevision = revision;
      this.attempts = 0;
    }
    if (this.revision === revision || this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => this.hydrate(params), 250);
  }

  dispose(): void {
    this.reset("");
  }

  private hydrate(params: SwarmHydrationParams): void {
    const generation = this.generation;
    const revision = params.sessions.canonicalListRevision;
    const key = `${params.sourceEpoch}:${params.parentKey}`;
    const isCurrent = () => generation === this.generation && this.key === key;
    const currentRowsAtStart = params.currentRows();
    const currentRowsAtStartByKey = new Map(
      currentRowsAtStart.map((row) => [row.key, JSON.stringify(row)]),
    );
    let hydrated = false;
    let retrying = false;
    this.attempts += 1;
    void hydrateSwarmSessionRows({
      sessions: params.sessions,
      parentKey: params.parentKey,
      currentRows: currentRowsAtStart,
      isCurrent,
    })
      .then((rows) => {
        if (!rows || !isCurrent()) {
          return;
        }
        hydrated = true;
        this.revision = revision;
        const changedCurrentRows = params
          .currentRows()
          .filter((row) => currentRowsAtStartByKey.get(row.key) !== JSON.stringify(row));
        this.rows = mergeSwarmSessionRows(rows, changedCurrentRows);
        params.onRows(this.rows);
      })
      .catch(() => {
        if (!isCurrent()) {
          return;
        }
        retrying = true;
        const retryDelayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts - 1, 5));
        this.timer = setTimeout(() => {
          this.timer = null;
          if (isCurrent()) {
            this.update(params);
          }
        }, retryDelayMs);
      })
      .finally(() => {
        if (!isCurrent()) {
          return;
        }
        if (!retrying) {
          this.timer = null;
        }
        if (hydrated && this.revision !== params.sessions.canonicalListRevision) {
          this.update(params);
        }
      });
  }

  private reset(key: string): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.rows = [];
    this.key = key;
    this.revision = -1;
    this.generation += 1;
    this.attemptRevision = -1;
    this.attempts = 0;
    this.timer = null;
  }
}

function hasSwarmRowsForSession(
  sessions: readonly GatewaySessionRow[],
  sessionKey: string,
): boolean {
  return sessions.some(
    (row) =>
      Boolean(row.swarmGroupId?.trim()) &&
      ((row.parentSessionKey && areUiSessionKeysEquivalent(row.parentSessionKey, sessionKey)) ||
        (row.spawnedBy && areUiSessionKeysEquivalent(row.spawnedBy, sessionKey)) ||
        ((): boolean => {
          const owner = row.swarmGroupId?.split(":").slice(1, -1).join(":");
          return Boolean(owner && areUiSessionKeysEquivalent(owner, sessionKey));
        })()),
  );
}

/** Creates the ephemeral board card from the live session roster, never from persisted board state. */
export function withSwarmWidget(
  snapshot: BoardSnapshot,
  sessions: readonly GatewaySessionRow[],
): BoardViewSnapshot {
  // Keep the card mounted through terminal collector updates so its explicit
  // empty state is visible before the retention sweep removes the group.
  if (!hasSwarmRowsForSession(sessions, snapshot.sessionKey)) {
    return snapshot;
  }
  const tabs = snapshot.tabs.some((tab) => tab.tabId === SWARM_TAB_ID)
    ? snapshot.tabs
    : [
        ...snapshot.tabs,
        {
          tabId: SWARM_TAB_ID,
          title: t("labsPage.swarm.title"),
          position: Math.max(-1, ...snapshot.tabs.map((tab) => tab.position)) + 1,
          chatDock: "right" as const,
        },
      ];
  const widget = {
    name: SWARM_WIDGET_NAME,
    tabId: SWARM_TAB_ID,
    title: t("labsPage.swarm.title"),
    contentKind: "builtin" as const,
    builtin: "swarm" as const,
    readOnly: true,
    sizeW: 12,
    sizeH: 4,
    position: 0,
    grantState: "granted" as const,
    revision: snapshot.revision,
  } satisfies BoardViewSnapshot["widgets"][number];
  const widgets = snapshot.widgets.some((candidate) => candidate.name === SWARM_WIDGET_NAME)
    ? snapshot.widgets.map((candidate) =>
        candidate.name === SWARM_WIDGET_NAME ? widget : candidate,
      )
    : [...snapshot.widgets, widget];
  return { ...snapshot, tabs, widgets };
}
