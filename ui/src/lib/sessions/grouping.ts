// Pure grouping helpers for the sessions table "Group by" modes.
import type { GatewaySessionRow } from "../../api/types.ts";
import { parseSessionKeyParts } from "../format.ts";
import { parseAgentSessionKey } from "./session-key.ts";

export const SESSION_GROUP_MODES = [
  "none",
  "category",
  "channel",
  "kind",
  "agent",
  "date",
] as const;

export type SessionsGroupBy = (typeof SESSION_GROUP_MODES)[number];

/** Group id for rows without a value in the active mode (category-less, key-less, etc.). */
export const UNGROUPED_ID = "";

const DATE_BUCKET_ORDER = ["today", "yesterday", "week", "older", UNGROUPED_ID] as const;

export type SessionRowGroup = {
  id: string;
  rows: GatewaySessionRow[];
};

type SidebarSessionSection<Row> = {
  id: "pinned" | "ungrouped" | `category:${string}`;
  category?: string;
  rows: Row[];
};

export function normalizeSessionsGroupBy(raw: unknown): SessionsGroupBy {
  return SESSION_GROUP_MODES.includes(raw as SessionsGroupBy) ? (raw as SessionsGroupBy) : "none";
}

function dateBucketId(updatedAt: number | null | undefined, now: number): string {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return UNGROUPED_ID;
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (updatedAt >= startOfToday.getTime()) {
    return "today";
  }
  if (updatedAt >= startOfToday.getTime() - dayMs) {
    return "yesterday";
  }
  if (updatedAt >= startOfToday.getTime() - 6 * dayMs) {
    return "week";
  }
  return "older";
}

function sessionRowChannel(row: GatewaySessionRow): string {
  return row.channel ?? parseSessionKeyParts(row.key)?.channel ?? UNGROUPED_ID;
}

export function resolveSessionGroupId(
  row: GatewaySessionRow,
  mode: SessionsGroupBy,
  now: number,
): string {
  switch (mode) {
    case "category":
      return row.category?.trim() ?? UNGROUPED_ID;
    case "channel":
      return sessionRowChannel(row);
    case "kind":
      return row.kind;
    case "agent":
      // parseSessionKeyParts only matches channel-style keys; plain agent
      // sessions like "agent:main:main" need the agent:<id>:<rest> parser.
      return parseAgentSessionKey(row.key)?.agentId ?? UNGROUPED_ID;
    case "date":
      return dateBucketId(row.updatedAt, now);
    default:
      return UNGROUPED_ID;
  }
}

/**
 * Partition sorted rows into ordered groups; row order within groups is preserved.
 * Category mode also emits empty groups for `knownCategories` so they stay drop targets,
 * and always emits the trailing ungrouped bucket.
 */
export function groupSessionRows(params: {
  rows: readonly GatewaySessionRow[];
  mode: SessionsGroupBy;
  knownCategories?: readonly string[];
  now?: number;
}): SessionRowGroup[] {
  const now = params.now ?? Date.now();
  const byId = new Map<string, GatewaySessionRow[]>();
  for (const row of params.rows) {
    const id = resolveSessionGroupId(row, params.mode, now);
    const bucket = byId.get(id);
    if (bucket) {
      bucket.push(row);
    } else {
      byId.set(id, [row]);
    }
  }
  const ids = orderedGroupIds(params.mode, byId, params.knownCategories ?? []);
  return ids.map((id) => ({ id, rows: byId.get(id) ?? [] }));
}

/** How the sidebar buckets non-pinned rows: category sections or one flat list. */
export type SidebarSessionsGrouping = "category" | "none";

export function normalizeSidebarSessionsGrouping(raw: unknown): SidebarSessionsGrouping {
  return raw === "none" ? "none" : "category";
}

/**
 * Pinned first, named categories alphabetically, then uncategorized rows.
 * `knownGroups` keeps stored-but-empty groups visible as move targets;
 * `grouping: "none"` collapses categories into the ungrouped list (pinned stays).
 */
export function groupSidebarSessionRows<Row extends { pinned?: boolean; category?: string | null }>(
  rows: readonly Row[],
  options: { knownGroups?: readonly string[]; grouping?: SidebarSessionsGrouping } = {},
): SidebarSessionSection<Row>[] {
  const grouping = options.grouping ?? "category";
  const pinned: Row[] = [];
  const ungrouped: Row[] = [];
  const categories = new Map<string, Row[]>();
  if (grouping === "category") {
    for (const name of options.knownGroups ?? []) {
      const trimmed = name.trim();
      if (trimmed && !categories.has(trimmed)) {
        categories.set(trimmed, []);
      }
    }
  }
  for (const row of rows) {
    if (row.pinned === true) {
      pinned.push(row);
      continue;
    }
    const category = grouping === "category" ? row.category?.trim() : undefined;
    if (!category) {
      ungrouped.push(row);
      continue;
    }
    const categoryRows = categories.get(category);
    if (categoryRows) {
      categoryRows.push(row);
    } else {
      categories.set(category, [row]);
    }
  }

  const sections: SidebarSessionSection<Row>[] = [];
  if (pinned.length > 0) {
    sections.push({ id: "pinned", rows: pinned });
  }
  for (const category of [...categories.keys()].toSorted((a, b) => a.localeCompare(b))) {
    sections.push({ id: `category:${category}`, category, rows: categories.get(category) ?? [] });
  }
  sections.push({ id: "ungrouped", rows: ungrouped });
  return sections;
}

function orderedGroupIds(
  mode: SessionsGroupBy,
  byId: ReadonlyMap<string, GatewaySessionRow[]>,
  knownCategories: readonly string[],
): string[] {
  if (mode === "date") {
    return DATE_BUCKET_ORDER.filter((id) => byId.has(id));
  }
  if (mode === "category") {
    const known = [...new Set(knownCategories.map((name) => name.trim()).filter(Boolean))];
    const extras = [...byId.keys()]
      .filter((id) => id !== UNGROUPED_ID && !known.includes(id))
      .toSorted((a, b) => a.localeCompare(b));
    return [...known, ...extras, UNGROUPED_ID];
  }
  const ids = [...byId.keys()].filter((id) => id !== UNGROUPED_ID);
  ids.sort((a, b) => a.localeCompare(b));
  if (byId.has(UNGROUPED_ID)) {
    ids.push(UNGROUPED_ID);
  }
  return ids;
}
