// Gateway-owned custom session group catalog.
// Membership stays on each session entry's category field; this module owns
// which groups exist, their display order, and bulk member category updates.
import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { ensureColumn, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";

// Write transactions must run on the same env-scoped handle as their
// statements; a bare transaction would open the default state DB while the
// SQL hits the override, losing atomicity under OPENCLAW_STATE_DIR overrides.

type SessionGroupRecord = {
  name: string;
  position: number;
};

type SessionGroupDefaultsRecord = {
  name: string;
  cwd?: string;
  worktree?: boolean;
};

type SessionGroupsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "session_groups" | "config_machine_state"
>;

export class SessionGroupNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown session group: ${name}`);
    this.name = "SessionGroupNotFoundError";
  }
}

const ensuredSessionGroupDefaultsDatabases = new WeakSet<DatabaseSync>();
const SIDEBAR_SECTION_ORDER_STATE_KEY = "sidebar.sectionOrder";

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionGroupsDatabase>(db);
}

// Config-machine-state helpers open their own transaction; use direct Kysely
// so sidebar edits stay inside the existing session-group write transaction.
function updateSidebarSectionOrder(
  db: DatabaseSync,
  update: (current: string[] | undefined) => string[] | undefined,
): void {
  const kysely = kyselyFor(db);
  const row = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", SIDEBAR_SECTION_ORDER_STATE_KEY),
  ).rows[0];
  // SAFETY: The sidebar owner and v12 migration store this key only as a string array.
  const next = update(row ? (JSON.parse(row.value_json) as string[]) : undefined);
  if (!next) {
    return;
  }
  const valueJson = JSON.stringify(next);
  const updatedAtMs = Date.now();
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("config_machine_state")
      .values({
        state_key: SIDEBAR_SECTION_ORDER_STATE_KEY,
        value_json: valueJson,
        updated_at_ms: updatedAtMs,
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet({
          value_json: valueJson,
          updated_at_ms: updatedAtMs,
        }),
      ),
  );
}

function hasSessionGroupDefaultsSchema(db: DatabaseSync): boolean {
  return (
    tableHasColumn(db, "session_groups", "cwd") && tableHasColumn(db, "session_groups", "worktree")
  );
}

function normalizeGroupNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names) {
    const name = normalizeOptionalString(raw);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function normalizeSidebarSectionOrder(
  sectionOrder: readonly string[],
  groupNames: readonly string[],
): string[] {
  const groups = new Set(groupNames);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of sectionOrder) {
    const sectionId = raw.trim();
    let canonical: string | null = null;
    if (sectionId === "ungrouped" || sectionId === "groups" || sectionId === "work") {
      canonical = sectionId;
    } else if (sectionId.startsWith("category:")) {
      const name = normalizeOptionalString(sectionId.slice("category:".length));
      if (name && groups.has(name)) {
        canonical = `category:${name}`;
      }
    } else if (sectionId.startsWith("catalog:")) {
      const catalogId = normalizeOptionalString(sectionId.slice("catalog:".length));
      if (catalogId) {
        canonical = `catalog:${catalogId}`;
      }
    }
    if (!canonical || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

export function listSessionGroups(env: NodeJS.ProcessEnv = process.env): SessionGroupRecord[] {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("session_groups")
    .select(["name", "position"])
    .orderBy("position", "asc")
    .orderBy("name", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

export function listSessionGroupDefaults(
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupDefaultsRecord[] {
  const db = dbFor(env);
  if (!hasSessionGroupDefaultsSchema(db)) {
    return listSessionGroups(env).map(({ name }) => ({ name }));
  }
  return executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .selectFrom("session_groups")
      .select(["name", "cwd", "worktree"])
      .orderBy("position", "asc")
      .orderBy("name", "asc"),
  ).rows.map((row) => {
    const group: SessionGroupDefaultsRecord = { name: row.name };
    if (row.cwd) {
      group.cwd = row.cwd;
    }
    if (row.worktree !== null) {
      group.worktree = row.worktree === 1;
    }
    return group;
  });
}

export function listSidebarSectionOrder(env: NodeJS.ProcessEnv = process.env): string[] {
  return readConfigMachineState<string[]>(SIDEBAR_SECTION_ORDER_STATE_KEY, { env }) ?? [];
}

/** Replaces the ordered catalog. Sessions keep their category even when a name is dropped. */
export function putSessionGroups(
  names: readonly string[],
  sectionOrder?: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupRecord[] {
  const normalized = normalizeGroupNames(names);
  const normalizedSectionOrder =
    sectionOrder === undefined ? undefined : normalizeSidebarSectionOrder(sectionOrder, normalized);
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = new Map(
        executeSqliteQuerySync(
          db,
          kysely.selectFrom("session_groups").select(["name", "created_at"]),
        ).rows.map((row) => [row.name, row]),
      );
      executeSqliteQuerySync(
        db,
        normalized.length === 0
          ? kysely.deleteFrom("session_groups")
          : kysely.deleteFrom("session_groups").where("name", "not in", normalized),
      );
      normalized.forEach((name, position) => {
        const prior = existing.get(name);
        executeSqliteQuerySync(
          db,
          prior
            ? kysely.updateTable("session_groups").set({ position }).where("name", "=", name)
            : kysely.insertInto("session_groups").values({
                name,
                position,
                created_at: now,
              }),
        );
      });
      if (normalizedSectionOrder) {
        updateSidebarSectionOrder(db, () => normalizedSectionOrder);
        // `names` remains authoritative for group-only surfaces such as the Sessions page.
        // The sidebar stores the caller's cross-section order without silently deriving it.
      }
    },
    { env },
  );
  return listSessionGroups(env);
}

/**
 * Absorbs a category assigned through sessions.patch so the catalog keeps
 * covering every group an operator UI can observe, appended at the end.
 */
export function ensureSessionGroupRegistered(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    return false;
  }
  let inserted = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").where("name", "=", normalized).limit(1),
      ).rows[0];
      if (existing) {
        return;
      }
      inserted = true;
      const maxRow = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("position").orderBy("position", "desc").limit(1),
      ).rows[0];
      executeSqliteQuerySync(
        db,
        kysely.insertInto("session_groups").values({
          name: normalized,
          position: (maxRow?.position ?? -1) + 1,
          created_at: Date.now(),
        }),
      );
    },
    { env },
  );
  return inserted;
}

function renameCatalogEntry(from: string, to: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const hasDefaults = hasSessionGroupDefaultsSchema(db);
      const source = executeSqliteQuerySync(
        db,
        hasDefaults
          ? kysely.selectFrom("session_groups").selectAll().where("name", "=", from).limit(1)
          : kysely
              .selectFrom("session_groups")
              .select(["name", "position", "created_at"])
              .where("name", "=", from)
              .limit(1),
      ).rows[0];
      if (!source) {
        throw new SessionGroupNotFoundError(from);
      }
      const targetExists = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").where("name", "=", to).limit(1),
      ).rows[0];
      const sourceSectionId = `category:${from}`;
      const targetSectionId = `category:${to}`;
      executeSqliteQuerySync(db, kysely.deleteFrom("session_groups").where("name", "=", from));
      updateSidebarSectionOrder(db, (current) => {
        if (!current?.includes(sourceSectionId)) {
          return undefined;
        }
        // A target slot already owns the merged group's position; retire the source slot.
        return current.includes(targetSectionId)
          ? current.filter((sectionId) => sectionId !== sourceSectionId)
          : current.map((sectionId) =>
              sectionId === sourceSectionId ? targetSectionId : sectionId,
            );
      });
      if (targetExists) {
        // Rename into an existing group merges memberships; keep its catalog row.
        return;
      }
      const base = {
        name: to,
        position: source.position,
        created_at: source.created_at,
      };
      executeSqliteQuerySync(
        db,
        kysely.insertInto("session_groups").values(
          hasDefaults
            ? {
                ...base,
                cwd: "cwd" in source && typeof source.cwd === "string" ? source.cwd : null,
                worktree:
                  "worktree" in source && typeof source.worktree === "number"
                    ? source.worktree
                    : null,
              }
            : base,
        ),
      );
    },
    { env },
  );
}

export function updateSessionGroupDefaults(
  name: string,
  defaults: { cwd: string | null; worktree: boolean },
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupDefaultsRecord[] | null {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    throw new Error("group defaults update requires a non-empty name");
  }
  const database = openOpenClawStateDatabase({ env });
  let updated = false;
  let defaultsSchemaEnsured = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").where("name", "=", normalized).limit(1),
      ).rows[0];
      if (!existing) {
        return;
      }
      if (!ensuredSessionGroupDefaultsDatabases.has(db)) {
        ensureColumn(db, "session_groups", "cwd TEXT");
        ensureColumn(db, "session_groups", "worktree INTEGER");
        defaultsSchemaEnsured = true;
      }
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("session_groups")
          .set({
            cwd: normalizeOptionalString(defaults.cwd) ?? null,
            worktree: defaults.worktree ? 1 : 0,
          })
          .where("name", "=", normalized),
      );
      updated = result.numAffectedRows === 1n;
    },
    { env },
  );
  if (defaultsSchemaEnsured) {
    ensuredSessionGroupDefaultsDatabases.add(database.db);
  }
  return updated ? listSessionGroupDefaults(env) : null;
}

/**
 * Bulk-updates member session categories across every agent store without
 * bumping updatedAt: group maintenance must not reshuffle recency ordering.
 */
async function updateMemberCategories(
  cfg: OpenClawConfig,
  from: string,
  to: string | undefined,
  env: NodeJS.ProcessEnv,
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void,
): Promise<number> {
  let updated = 0;
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    updated += await applySessionEntryReplacements<number>({
      storePath: target.storePath,
      update: (entries) => {
        const replacements = entries.flatMap(({ sessionKey, entry }) => {
          if (entry.category?.trim() !== from) {
            return [];
          }
          try {
            assertTargetCurrent?.({ agentId: target.agentId, sessionKey });
          } catch (error) {
            if (error instanceof SessionMutationAuthorizationChangedError) {
              // Group membership spans separate agent databases. Once the catalog commit starts,
              // skip a concurrently replaced target instead of failing after earlier stores wrote.
              return [];
            }
            throw error;
          }
          const next = { ...entry };
          if (to === undefined) {
            delete next.category;
          } else {
            next.category = to;
          }
          return [{ sessionKey, entry: next }];
        });
        return { replacements, result: replacements.length };
      },
    });
  }
  return updated;
}

export async function renameSessionGroup(params: {
  cfg: OpenClawConfig;
  name: string;
  to: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void;
}): Promise<{ groups: SessionGroupRecord[]; sectionOrder: string[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  const from = normalizeOptionalString(params.name);
  const to = normalizeOptionalString(params.to);
  if (!from || !to) {
    throw new Error("group rename requires non-empty names");
  }
  if (from !== to) {
    params.assertCurrent?.();
    renameCatalogEntry(from, to, env);
  }
  const updatedSessions =
    from === to
      ? 0
      : await updateMemberCategories(params.cfg, from, to, env, params.assertTargetCurrent);
  return {
    groups: listSessionGroups(env),
    sectionOrder: listSidebarSectionOrder(env),
    updatedSessions,
  };
}

export async function deleteSessionGroup(params: {
  cfg: OpenClawConfig;
  name: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void;
}): Promise<{ groups: SessionGroupRecord[]; sectionOrder: string[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  const name = normalizeOptionalString(params.name);
  if (!name) {
    throw new Error("group delete requires a non-empty name");
  }
  params.assertCurrent?.();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      executeSqliteQuerySync(db, kysely.deleteFrom("session_groups").where("name", "=", name));
      const sectionId = `category:${name}`;
      updateSidebarSectionOrder(db, (current) =>
        current?.includes(sectionId)
          ? current.filter((section) => section !== sectionId)
          : undefined,
      );
    },
    { env },
  );
  const updatedSessions = await updateMemberCategories(
    params.cfg,
    name,
    undefined,
    env,
    params.assertTargetCurrent,
  );
  return {
    groups: listSessionGroups(env),
    sectionOrder: listSidebarSectionOrder(env),
    updatedSessions,
  };
}
