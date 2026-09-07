// Pure helpers for custom session groups and their sidebar section tokens.
// Catalog storage and member updates live on the gateway (sessions.groups.*);
// the SessionCapability mirrors the catalog into state.groups.

import { moveArrayEntry } from "../array-order.ts";

const BUILT_IN_SESSION_SECTION_IDS = new Set(["ungrouped", "groups", "work"]);

export type SessionGroupSettings = {
  name: string;
  position: number;
  cwd?: string;
  worktree?: boolean;
};

export function readSessionCustomGroups(payload: unknown): SessionGroupSettings[] {
  const groups = (payload as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups.flatMap((entry, index) => {
    const group = entry as Record<string, unknown> | null;
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (!name) {
      return [];
    }
    return [
      {
        name,
        position:
          typeof group?.position === "number" && Number.isSafeInteger(group.position)
            ? group.position
            : index,
      },
    ];
  });
}

export function mergeSessionGroupDefaults(
  groups: readonly SessionGroupSettings[],
  payload: unknown,
): SessionGroupSettings[] {
  const values = (payload as { defaults?: unknown } | null)?.defaults;
  const defaults = new Map<string, { cwd?: string; worktree?: boolean }>();
  if (Array.isArray(values)) {
    for (const value of values) {
      const record = value as Record<string, unknown> | null;
      const name = typeof record?.name === "string" ? record.name.trim() : "";
      if (!name) {
        continue;
      }
      const cwd = typeof record?.cwd === "string" ? record.cwd.trim() : "";
      defaults.set(name, {
        ...(cwd ? { cwd } : {}),
        ...(typeof record?.worktree === "boolean" ? { worktree: record.worktree } : {}),
      });
    }
  }
  return groups.map((group) => ({ ...group, ...defaults.get(group.name) }));
}

export function readSidebarSectionOrder(payload: unknown): string[] {
  return (
    normalizeSessionSectionOrderTokens(
      (payload as { sectionOrder?: unknown } | null)?.sectionOrder,
    ) ?? []
  );
}

/** Validate and deduplicate a persisted partial section order. */
export function normalizeSessionSectionOrderTokens(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    // Catalog-backed sections (session catalog providers) order alongside the
    // built-ins and custom categories, so their ids must survive normalization.
    const catalogName = trimmed.startsWith("catalog:")
      ? trimmed.slice("catalog:".length).trim()
      : "";
    if (catalogName) {
      const catalogSectionId = `catalog:${catalogName}`;
      if (!normalized.includes(catalogSectionId)) {
        normalized.push(catalogSectionId);
      }
      continue;
    }
    let token: string | null = null;
    if (BUILT_IN_SESSION_SECTION_IDS.has(trimmed)) {
      token = trimmed;
    } else if (trimmed.startsWith("category:")) {
      const name = trimmed.slice("category:".length).trim();
      token = name ? `category:${name}` : null;
    }
    if (token && !normalized.includes(token)) {
      normalized.push(token);
    }
  }
  return normalized;
}

/** Move one entry relative to another while preserving every other entry. */
export function moveSessionOrderEntry(
  order: readonly string[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] {
  return moveArrayEntry(order, source, target, position);
}
