// Pure grouping helpers for the sessions table "Group by" modes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  checkoutDisplayName,
  foldWorktreeCheckoutPath,
  sessionActorGroupId,
} from "./catalog-project-grouping.ts";
import { moveSessionOrderEntry, normalizeSessionSectionOrderTokens } from "./custom-groups.ts";
import { parseAgentSessionKey, parseSessionKeyParts } from "./session-key.ts";

export const SESSION_GROUP_MODES = [
  "none",
  "category",
  "person",
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
  id:
    | "pinned"
    | "ungrouped"
    | "groups"
    | "work"
    | `category:${string}`
    | `person:${string}`
    | `project:${string}`
    | `catalog:${string}`;
  category?: string;
  personOwner?: NonNullable<GatewaySessionRow["owner"]>["actor"] & { id: string };
  /** Repo/workspace section (project grouping); `path` disambiguates same-named repos. */
  project?: { name: string; path: string };
  /** Built-in smart group-conversation section (kind "group" rows). */
  groups?: boolean;
  /** Built-in smart coding section (worktree/exec-node/ACP sessions). */
  work?: boolean;
  rows: Row[];
};

export function collectKnownSessionGroups(
  catalog: readonly string[],
  rows: readonly GatewaySessionRow[],
): string[] {
  const catalogSet = new Set(catalog);
  const discovered = rows
    .map((row) => normalizeOptionalString(row.category))
    .filter((name): name is string => typeof name === "string" && !catalogSet.has(name))
    .toSorted((a, b) => a.localeCompare(b));
  return [...catalog, ...new Set(discovered)];
}

const DEFAULT_SESSION_SECTION_ORDER = ["ungrouped", "groups", "work"] as const;

export function normalizeSessionSectionOrder(
  stored: readonly string[],
  knownGroups: readonly string[],
  knownCatalogIds: readonly string[] = [],
): string[] {
  const groups = [...new Set(knownGroups.map((name) => name.trim()).filter(Boolean))];
  const knownGroupSet = new Set(groups);
  const catalogIds = [
    ...new Set(knownCatalogIds.map((catalogId) => catalogId.trim()).filter(Boolean)),
  ];
  const knownCatalogIdSet = new Set(catalogIds);
  const order = (normalizeSessionSectionOrderTokens(stored) ?? []).filter((token) => {
    if (token.startsWith("category:")) {
      return knownGroupSet.has(token.slice("category:".length));
    }
    if (token.startsWith("catalog:")) {
      return knownCatalogIdSet.has(token.slice("catalog:".length));
    }
    return true;
  });

  for (const group of groups) {
    const token = `category:${group}`;
    if (order.includes(token)) {
      continue;
    }
    const firstBuiltInIndex = order.findIndex((entry) =>
      DEFAULT_SESSION_SECTION_ORDER.includes(
        entry as (typeof DEFAULT_SESSION_SECTION_ORDER)[number],
      ),
    );
    order.splice(firstBuiltInIndex < 0 ? order.length : firstBuiltInIndex, 0, token);
  }

  for (const [index, sectionId] of DEFAULT_SESSION_SECTION_ORDER.entries()) {
    if (order.includes(sectionId)) {
      continue;
    }
    if (index === 0) {
      order.push(sectionId);
      continue;
    }
    const previousId = DEFAULT_SESSION_SECTION_ORDER[index - 1]!;
    order.splice(order.indexOf(previousId) + 1, 0, sectionId);
  }
  const unseenCatalogTokens = catalogIds
    .map((catalogId) => `catalog:${catalogId}`)
    .filter((token) => !order.includes(token));
  order.splice(order.indexOf("work") + 1, 0, ...unseenCatalogTokens);
  return order;
}

export function moveSessionSection(
  order: readonly string[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] {
  return moveSessionOrderEntry(order, source, target, position);
}

export function normalizeSessionsGroupBy(raw: unknown): SessionsGroupBy {
  return SESSION_GROUP_MODES.includes(raw as SessionsGroupBy) ? (raw as SessionsGroupBy) : "none";
}

function dateBucketId(updatedAt: number | null | undefined, now: number): string {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return UNGROUPED_ID;
  }
  const today = new Date(now);
  // Calendar midnights can be 23 or 25 hours apart across daylight-saving changes.
  const startOfDay = (daysAgo: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).getTime();
  if (updatedAt >= startOfDay(0)) {
    return "today";
  }
  if (updatedAt >= startOfDay(1)) {
    return "yesterday";
  }
  if (updatedAt >= startOfDay(6)) {
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
    case "person":
      return sessionActorGroupId(row.owner?.actor);
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

/** How the sidebar buckets non-pinned rows before its built-in smart zones. */
export type SidebarSessionsGrouping = "category" | "person" | "project" | "none";

export function normalizeSidebarSessionsGrouping(raw: unknown): SidebarSessionsGrouping {
  return raw === "none" || raw === "person" || raw === "project" ? raw : "category";
}

type SidebarGroupableRow = {
  pinned?: boolean;
  category?: string | null;
  owner?: GatewaySessionRow["owner"];
  /** Resolved repo/workspace of the session's checkout (project grouping). */
  workContext?: { path: string };
  /** Session kind from the gateway row; "group" rows form the Groups zone. */
  kind?: string;
  /** Session bound to a managed worktree or exec node (Coding zone). */
  workSession?: boolean;
  /** ACP-backed harness session (Coding zone). */
  acpSession?: boolean;
};

/** Clearing the manual category reveals the built-in Groups destination. */
export function categoryClearReturnsToGroups(
  row: SidebarGroupableRow,
  grouping: SidebarSessionsGrouping,
): boolean {
  return (
    grouping === "category" &&
    row.pinned !== true &&
    Boolean(row.category?.trim()) &&
    row.kind === "group"
  );
}

/**
 * Zone partition: pinned, named categories (persisted `knownGroups` order,
 * new ones alphabetical), other sessions ("ungrouped"),
 * group conversations, then coding (worktree/exec-node/ACP). An explicit user
 * category wins over the smart group/coding classification so manual curation
 * sticks. `grouping: "none"` is a flat list: every non-pinned row lands in
 * "ungrouped" with no smart zones. `grouping: "project"` buckets rows by their
 * resolved work checkout (alphabetical, ahead of the stored zones) and leaves
 * checkout-less rows in their smart zones, mirroring how "person" treats
 * ownerless rows. The coding section is always emitted (even empty) so its
 * ordered position remains a stable sibling of any catalog sections. Groups
 * also stays visible while a categorized group row can deterministically
 * return there.
 */
export function groupSidebarSessionRows<Row extends SidebarGroupableRow>(
  rows: readonly Row[],
  options: {
    knownGroups?: readonly string[];
    grouping?: SidebarSessionsGrouping;
    selfOwnerId?: string | null;
    sectionOrder?: readonly string[];
    catalogIds?: readonly string[];
  } = {},
): SidebarSessionSection<Row>[] {
  const grouping = options.grouping ?? "category";
  const pinned: Row[] = [];
  const threads: Row[] = [];
  const groups: Row[] = [];
  const coding: Row[] = [];
  const categories = new Map<string, Row[]>();
  const knownGroups: string[] = [];
  const people = new Map<string, SidebarSessionSection<Row>>();
  const projects = new Map<string, SidebarSessionSection<Row>>();
  if (grouping === "category") {
    for (const name of options.knownGroups ?? []) {
      const trimmed = name.trim();
      if (trimmed && !categories.has(trimmed)) {
        categories.set(trimmed, []);
        knownGroups.push(trimmed);
      }
    }
  }
  for (const row of rows) {
    if (row.pinned === true) {
      pinned.push(row);
      continue;
    }
    if (grouping === "none") {
      threads.push(row);
      continue;
    }
    // Fold worktree checkouts into their origin repo so gateway sessions and
    // the harness catalogs agree on what one project is.
    const projectPath =
      grouping === "project" && row.workContext
        ? foldWorktreeCheckoutPath(row.workContext.path)
        : null;
    if (projectPath) {
      const projectSection = projects.get(projectPath);
      if (projectSection) {
        projectSection.rows.push(row);
      } else {
        projects.set(projectPath, {
          id: `project:${projectPath}`,
          project: { name: checkoutDisplayName(projectPath), path: projectPath },
          rows: [row],
        });
      }
      continue;
    }
    const owner = grouping === "person" ? row.owner?.actor : undefined;
    const ownerId = owner?.identity?.id;
    const ownerKey = sessionActorGroupId(owner);
    if (owner && ownerId && ownerKey) {
      const personSection = people.get(ownerKey);
      if (personSection) {
        personSection.rows.push(row);
      } else {
        people.set(ownerKey, {
          id: `person:${ownerKey}`,
          personOwner: { ...owner, id: ownerId },
          rows: [row],
        });
      }
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
  sections.push(
    ...[...people.values()].toSorted((left, right) => {
      const leftOwner = left.personOwner!;
      const rightOwner = right.personOwner!;
      const leftRank =
        leftOwner.identity?.type === "agent"
          ? 2
          : leftOwner.identity?.type === "profile" && leftOwner.id === options.selfOwnerId
            ? 0
            : 1;
      const rightRank =
        rightOwner.identity?.type === "agent"
          ? 2
          : rightOwner.identity?.type === "profile" && rightOwner.id === options.selfOwnerId
            ? 0
            : 1;
      return (
        leftRank - rightRank ||
        (leftOwner.label || leftOwner.id).localeCompare(rightOwner.label || rightOwner.id) ||
        leftOwner.id.localeCompare(rightOwner.id)
      );
    }),
  );
  // Alphabetical and ahead of the stored zones: project sections have no
  // persisted order, so a stable name sort keeps them findable.
  sections.push(
    ...[...projects.values()].toSorted((left, right) => {
      const leftProject = left.project!;
      const rightProject = right.project!;
      return (
        leftProject.name.localeCompare(rightProject.name) ||
        leftProject.path.localeCompare(rightProject.path)
      );
    }),
  );
  const orderedCategories = [
    ...knownGroups,
    ...[...categories.keys()].slice(knownGroups.length).toSorted((a, b) => a.localeCompare(b)),
  ];
  const orderedSections: SidebarSessionSection<Row>[] = orderedCategories.map((category) => ({
    id: `category:${category}`,
    category,
    rows: categories.get(category) ?? [],
  }));
  orderedSections.push({ id: "ungrouped", rows: threads });
  const hasGroupsReturnTarget = rows.some((row) => categoryClearReturnsToGroups(row, grouping));
  if (groups.length > 0 || hasGroupsReturnTarget) {
    orderedSections.push({ id: "groups", groups: true, rows: groups });
  }
  orderedSections.push({ id: "work", work: true, rows: coding });
  const catalogIds = [
    ...new Set((options.catalogIds ?? []).map((catalogId) => catalogId.trim()).filter(Boolean)),
  ];
  orderedSections.push(
    ...catalogIds.map(
      (catalogId): SidebarSessionSection<Row> => ({ id: `catalog:${catalogId}`, rows: [] }),
    ),
  );
  if (options.sectionOrder) {
    const sectionsById = new Map(orderedSections.map((section) => [section.id, section]));
    for (const sectionId of normalizeSessionSectionOrder(
      options.sectionOrder,
      orderedCategories,
      catalogIds,
    )) {
      const section = sectionsById.get(sectionId as SidebarSessionSection<Row>["id"]);
      if (section) {
        sections.push(section);
        sectionsById.delete(section.id);
      }
    }
    sections.push(...orderedSections.filter((section) => sectionsById.has(section.id)));
    return sections;
  }
  sections.push(...orderedSections);
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
