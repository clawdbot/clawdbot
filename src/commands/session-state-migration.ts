import fs from "node:fs";
import {
  importLegacySessionStoreIntoSqlite,
  loadExistingSqliteSessionStoreReadOnly,
  resolveSqliteSessionStoreDatabasePath,
} from "../config/sessions/store-sqlite.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { readSessionStoreJson5 } from "../infra/state-migrations.fs.js";

export {
  ensureSessionStateMigrated as ensureSessionStateMigratedForCommand,
  resetSessionStateMigratedForTest as resetSessionStateMigratedForCommandForTest,
} from "../infra/session-state-migration.js";

function resolveEntryUpdatedAt(entry: { updatedAt?: unknown } | undefined): number {
  return typeof entry?.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

function prepareExplicitLegacySessionEntry(entry: Record<string, unknown>): SessionEntry {
  const normalized = { ...entry } as SessionEntry;
  const snapshot = normalized.skillsSnapshot as { resolvedSkills?: unknown } | undefined;
  if (snapshot?.resolvedSkills !== undefined) {
    delete snapshot.resolvedSkills;
  }
  return normalized;
}

function mergeExplicitLegacySessionStore(params: {
  storePath: string;
  store: Record<string, unknown>;
}): Record<string, SessionEntry> {
  const merged = { ...loadExistingSqliteSessionStoreForPreview(params.storePath) };
  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const incoming = prepareExplicitLegacySessionEntry(entry as Record<string, unknown>);
    const existing = merged[key];
    if (!existing || resolveEntryUpdatedAt(incoming) > resolveEntryUpdatedAt(existing)) {
      merged[key] = incoming;
    }
  }
  return merged;
}

function loadExistingSqliteSessionStoreForPreview(storePath: string): Record<string, SessionEntry> {
  if (!fs.existsSync(resolveSqliteSessionStoreDatabasePath(storePath))) {
    return {};
  }
  try {
    return loadExistingSqliteSessionStoreReadOnly(storePath);
  } catch {
    return {};
  }
}

export function loadExplicitSessionStorePreviewForCommand(
  storePath: string,
): Record<string, SessionEntry> {
  if (!fs.existsSync(storePath)) {
    return loadExistingSqliteSessionStoreForPreview(storePath);
  }
  const parsed = readSessionStoreJson5(storePath);
  return parsed.ok
    ? mergeExplicitLegacySessionStore({ storePath, store: parsed.store })
    : loadExistingSqliteSessionStoreForPreview(storePath);
}

export async function ensureExplicitSessionStoreMigratedForCommand(
  storePath: string,
  opts?: { onWarning?: (warning: string) => void },
): Promise<void> {
  if (!fs.existsSync(storePath)) {
    return;
  }
  const parsed = readSessionStoreJson5(storePath);
  if (!parsed.ok) {
    return;
  }
  const merged = mergeExplicitLegacySessionStore({ storePath, store: parsed.store });
  importLegacySessionStoreIntoSqlite({ storePath, store: merged });
  try {
    fs.rmSync(storePath, { force: true });
  } catch (error) {
    opts?.onWarning?.(
      `Imported legacy session store into SQLite, but failed removing ${storePath}: ${String(
        error,
      )}`,
    );
  }
}
