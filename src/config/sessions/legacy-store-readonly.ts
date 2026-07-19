// Read-only compatibility for discovered legacy stores that predate the SQLite session store.
// Callers must establish that the target already exists; this seam never provisions or writes it.
import fs from "node:fs";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { loadSessionStore } from "./store-load.js";
import type { SessionEntry } from "./types.js";

export function isLegacyOnlySessionStoreTarget(storePath: string, agentId?: string): boolean {
  if (!fs.existsSync(storePath)) {
    return false;
  }
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
  return !sqlitePath || !fs.existsSync(sqlitePath);
}

export function readLegacySessionStoreTarget(
  storePath: string,
  agentId?: string,
): Record<string, SessionEntry> | undefined {
  if (!isLegacyOnlySessionStoreTarget(storePath, agentId)) {
    return undefined;
  }
  return loadSessionStore(storePath, {
    clone: true,
    hydrateSkillPromptRefs: false,
    skipCache: true,
  });
}
