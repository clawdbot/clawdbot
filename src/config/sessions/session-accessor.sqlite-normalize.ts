import { randomUUID } from "node:crypto";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

/** Projects runtime session state into SQLite's canonical entry JSON shape. */
export function projectSqliteSessionEntryShape(value: Record<string, unknown>): SessionEntry {
  const canonicalEntry = projectCanonicalSessionEntryShape(value);
  const snapshot = canonicalEntry.skillsSnapshot;
  if (snapshot?.resolvedSkills === undefined) {
    return canonicalEntry;
  }
  const { resolvedSkills: _resolvedSkills, ...persistedSnapshot } = snapshot;
  if (Object.keys(persistedSnapshot).length === 0) {
    const { skillsSnapshot: _skillsSnapshot, ...entry } = canonicalEntry;
    return entry;
  }
  return { ...canonicalEntry, skillsSnapshot: persistedSnapshot };
}

export function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
  };
}

export function normalizeSqliteText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeSqliteChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

export function normalizeSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}
