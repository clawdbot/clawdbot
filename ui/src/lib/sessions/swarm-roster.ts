import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { fetchChildSessionRows } from "./child-session-data.ts";
import type { SessionCapability } from "./index.ts";
import { normalizeAgentId, areUiSessionKeysEquivalent } from "./session-key.ts";

const SWARM_SESSION_PAGE_SIZE = 10_000;

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
  const normalizedAgentId = agentId ? normalizeAgentId(agentId) : null;
  const authoredAgentId = normalizedAgentId
    ? Object.keys(entries ?? {}).find(
        (candidate) => normalizeAgentId(candidate) === normalizedAgentId,
      )
    : null;
  const agent = authoredAgentId ? asNullableRecord(entries?.[authoredAgentId]) : null;
  const agentEnabled = readSwarmEnabled(asNullableRecord(agent?.tools)?.swarm);
  return agentEnabled ?? globalEnabled ?? true;
}

function isNewerSessionRow(candidate: GatewaySessionRow, current: GatewaySessionRow): boolean {
  // Callers pass hydrated rows first and the current lifecycle-decorated page
  // second, so equal persisted timestamps intentionally prefer the latter.
  return (candidate.updatedAt ?? 0) >= (current.updatedAt ?? 0);
}

export function mergeSwarmSessionRows(
  childRows: readonly GatewaySessionRow[],
  currentRows: readonly GatewaySessionRow[],
): GatewaySessionRow[] {
  const merged = new Map<string, GatewaySessionRow>();
  for (const row of [...childRows, ...currentRows]) {
    const current = merged.get(row.key);
    if (!current || isNewerSessionRow(row, current)) {
      merged.set(row.key, row);
    }
  }
  return [...merged.values()];
}

export async function hydrateSwarmSessionRows(params: {
  sessions: SessionCapability;
  parentKey: string;
  currentRows: readonly GatewaySessionRow[];
  isCurrent: () => boolean;
}): Promise<GatewaySessionRow[] | null> {
  const childRows = await fetchChildSessionRows({
    sessions: params.sessions,
    parentKey: params.parentKey,
    isCurrent: params.isCurrent,
    pageSize: SWARM_SESSION_PAGE_SIZE,
  });
  return childRows ? mergeSwarmSessionRows(params.currentRows, childRows) : null;
}

type SwarmHydrationParams = {
  sessions: SessionCapability;
  agentId?: string;
  readParent: () => Promise<GatewaySessionRow | null>;
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
  private currentRowsByKey = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  update(params: SwarmHydrationParams): void {
    const key = `${params.sourceEpoch}:${params.agentId ?? ""}:${params.parentKey}`;
    if (this.key !== key) {
      this.reset(key);
    }
    const currentRows = params
      .currentRows()
      .filter((row) => !areUiSessionKeysEquivalent(row.key, params.parentKey));
    const currentRowsByKey = new Map(currentRows.map((row) => [row.key, JSON.stringify(row)]));
    // A repeated page is not a new lifecycle observation. Reapplying it can
    // overwrite a newer child fetch whose persisted timestamp did not change.
    this.rows = mergeSwarmSessionRows(
      this.rows,
      currentRows.filter(
        (row) => this.currentRowsByKey.get(row.key) !== currentRowsByKey.get(row.key),
      ),
    );
    this.currentRowsByKey = currentRowsByKey;
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
    const generation = ++this.generation;
    const revision = params.sessions.canonicalListRevision;
    const key = `${params.sourceEpoch}:${params.agentId ?? ""}:${params.parentKey}`;
    const isCurrent = () => generation === this.generation && this.key === key;
    const currentRowsAtStart = params
      .currentRows()
      .filter((row) => !areUiSessionKeysEquivalent(row.key, params.parentKey));
    const currentRowsAtStartByKey = new Map(
      currentRowsAtStart.map((row) => [row.key, JSON.stringify(row)]),
    );
    let hydrated = false;
    let retrying = false;
    this.attempts += 1;
    const scheduleRetry = () => {
      retrying = true;
      this.revision = -1;
      const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts - 1, 5));
      this.timer = setTimeout(() => {
        this.timer = null;
        if (isCurrent()) {
          this.update(params);
        }
      }, delayMs);
    };
    // Counts belong to the parent read; optional child names must never hold them hostage.
    const children = hydrateSwarmSessionRows({
      sessions: params.sessions,
      parentKey: params.parentKey,
      currentRows: currentRowsAtStart,
      isCurrent,
    }).catch(() => null);
    void params
      .readParent()
      .then((parent) => {
        if (!isCurrent()) {
          return;
        }
        hydrated = true;
        this.revision = revision;
        this.rows = parent ? mergeSwarmSessionRows(this.rows, [parent]) : [];
        params.onRows(this.rows);
        if (!parent) {
          return;
        }
        void children.then((rows) => {
          if (!isCurrent()) {
            return;
          }
          const changedCurrentRows = params
            .currentRows()
            .filter(
              (row) =>
                !areUiSessionKeysEquivalent(row.key, params.parentKey) &&
                currentRowsAtStartByKey.get(row.key) !== JSON.stringify(row),
            );
          this.rows = rows
            ? mergeSwarmSessionRows(mergeSwarmSessionRows(rows, [parent]), changedCurrentRows)
            : [parent];
          params.onRows(this.rows);
          if (!rows) {
            scheduleRetry();
          }
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        if (error instanceof GatewayRequestError && error.code === "INVALID_REQUEST") {
          this.rows = [];
          params.onRows(this.rows);
        }
        scheduleRetry();
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
    this.currentRowsByKey.clear();
    this.key = key;
    this.revision = -1;
    this.generation += 1;
    this.attemptRevision = -1;
    this.attempts = 0;
    this.timer = null;
  }
}
