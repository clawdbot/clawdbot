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

export type SidebarSessionSection<Row> = {
  id: "pinned" | "ungrouped" | "groups" | "work" | `category:${string}`;
  category?: string;
  /** Built-in smart group-conversation section (kind "group" rows). */
  groups?: boolean;
  /** Built-in smart coding section (worktree/exec-node/ACP sessions). */
  work?: boolean;
  rows: Row[];
};

/**
 * Sections that render a header (and therefore can collapse). Pinned rows
 * render headerless like the nav entries above them; every other zone shows
 * one — Threads hosts the sort and new-session actions on its header.
 * Shared by the renderer and keyboard-order walker so collapse behavior
 * cannot drift between them.
 */
export function sidebarSectionHasHeader(
  sectionId: string,
  _grouping: SidebarSessionsGrouping,
): boolean {
  return sectionId !== "pinned";
}

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

function resolveSessionGroupId(row: GatewaySessionRow, mode: SessionsGroupBy, now: number): string {
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

type SidebarGroupableRow = {
  pinned?: boolean;
  category?: string | null;
  /** Session kind from the gateway row; "group" rows form the Groups zone. */
  kind?: string;
  /** Session bound to a managed worktree or exec node (Coding zone). */
  workSession?: boolean;
  /** ACP-backed harness session (Coding zone). */
  acpSession?: boolean;
};

/**
 * Zone partition: pinned, named categories (persisted `knownGroups` order,
 * new ones alphabetical), threads ("ungrouped" — the agent's chat sessions),
 * group conversations, then coding (worktree/exec-node/ACP). An explicit user
 * category wins over the smart group/coding classification so manual curation
 * sticks. `grouping: "none"` only disables categories; the kind-based Groups
 * and Coding zones always split so chat threads stay readable. The coding
 * section is always emitted (even empty) because the renderer appends CLI
 * catalog sessions into it.
 */
export function groupSidebarSessionRows<Row extends SidebarGroupableRow>(
  rows: readonly Row[],
  options: { knownGroups?: readonly string[]; grouping?: SidebarSessionsGrouping } = {},
): SidebarSessionSection<Row>[] {
  const grouping = options.grouping ?? "category";
  const pinned: Row[] = [];
  const threads: Row[] = [];
  const groups: Row[] = [];
  const coding: Row[] = [];
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
    if (category) {
      const categoryRows = categories.get(category);
      if (categoryRows) {
        categoryRows.push(row);
      } else {
        categories.set(category, [row]);
      }
      continue;
    }
    if (row.kind === "group") {
      groups.push(row);
      continue;
    }
    if (row.workSession === true || row.acpSession === true) {
      coding.push(row);
      continue;
    }
    threads.push(row);
  }

  const sections: SidebarSessionSection<Row>[] = [];
  if (pinned.length > 0) {
    sections.push({ id: "pinned", rows: pinned });
  }
  const knownGroups = [
    ...new Set((options.knownGroups ?? []).map((name) => name.trim()).filter(Boolean)),
  ];
  const orderedCategories = [
    ...knownGroups.filter((name) => categories.has(name)),
    ...[...categories.keys()]
      .filter((name) => !knownGroups.includes(name))
      .toSorted((a, b) => a.localeCompare(b)),
  ];
  for (const category of orderedCategories) {
    sections.push({ id: `category:${category}`, category, rows: categories.get(category) ?? [] });
  }
  sections.push({ id: "ungrouped", rows: threads });
  if (groups.length > 0) {
    sections.push({ id: "groups", groups: true, rows: groups });
  }
  sections.push({ id: "work", work: true, rows: coding });
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
