// Gateway-owned custom session group catalog.
// Membership stays on each session entry's category field; this module owns
// which groups exist, their display order, and bulk member category updates.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions.js";
import {
  applySessionEntryReplacements,
  listSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { ensureColumn, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  SessionMutationAuthorizationChangedError,
  type SessionMutationTarget,
} from "./session-mutation-authorization-error.js";

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

export class SessionGroupNotEmptyError extends Error {
  constructor(readonly groups: ReadonlyArray<{ name: string; memberSessions: number }>) {
    super(
      `sessions.groups.put cannot drop groups that still have member sessions: ${groups
        .map((group) => `"${group.name}" (${group.memberSessions})`)
        .join(", ")}; include them in names or remove them via sessions.groups.delete`,
    );
    this.name = "SessionGroupNotEmptyError";
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

export function normalizeGroupNames(names: readonly string[]): string[] {
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

/**
 * Replaces the ordered catalog. Dropping a name whose group still has member
 * sessions is rejected: member sweeps stay owned by sessions.groups.delete,
 * so a put can never leave dangling categories that resurrect the group.
 */
export function putSessionGroups(params: {
  cfg: OpenClawConfig;
  names: readonly string[];
  sectionOrder?: readonly string[];
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId?: string; sessionKey: string }) => void;
}): SessionGroupRecord[] {
  const { cfg, names, sectionOrder, env = process.env } = params;
  const normalized = normalizeGroupNames(names);
  const normalizedSectionOrder =
    sectionOrder === undefined ? undefined : normalizeSidebarSectionOrder(sectionOrder, normalized);
  params.assertCurrent?.();
  const dropped = listSessionGroups(env).filter((group) => !normalized.includes(group.name));
  if (dropped.length > 0) {
    // Accepted race: sessions.patch can assign a dropped category between this scan and commit.
    // That residue self-heals via ensureSessionGroupRegistered absorption on the next patch.
    const targetsByName = resolveSessionGroupMutationTargetsByName(cfg, env);
    // Unlike updateMemberCategories, put has not committed any catalog changes yet.
    // Fail closed on changed targets before disclosing any member counts.
    for (const { name } of dropped) {
      for (const target of targetsByName.get(name) ?? []) {
        params.assertTargetCurrent?.({ agentId: target.agentId, sessionKey: target.sessionKey });
      }
    }
    const nonEmpty = dropped
      .map(({ name }) => ({ name, memberSessions: targetsByName.get(name)?.length ?? 0 }))
      .filter((group) => group.memberSessions > 0);
    if (nonEmpty.length > 0) {
      throw new SessionGroupNotEmptyError(nonEmpty);
    }
  }
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

function readCatalogEntry(db: DatabaseSync, name: string) {
  const query = kyselyFor(db).selectFrom("session_groups").where("name", "=", name).limit(1);
  return executeSqliteQuerySync(
    db,
    hasSessionGroupDefaultsSchema(db)
      ? query.selectAll()
      : query.select(["name", "position", "created_at"]),
  ).rows[0];
}

function prepareCatalogRename(from: string, to: string, env: NodeJS.ProcessEnv) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const source = readCatalogEntry(db, from);
      if (!source) {
        throw new SessionGroupNotFoundError(from);
      }
      // Both names must exist while member writes span agent databases. Retain
      // the source until every guarded write succeeds; existing targets keep their defaults.
      if (!readCatalogEntry(db, to)) {
        executeSqliteQuerySync(
          db,
          kyselyFor(db)
            .insertInto("session_groups")
            .values({ ...source, name: to }),
        );
      }
      return source;
    },
    { env },
  );
}

function retireCatalogEntry(
  from: string,
  to: string | undefined,
  source: ReturnType<typeof readCatalogEntry>,
  env: NodeJS.ProcessEnv,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // A successful concurrent defaults edit, reorder, or recreation owns the
      // retained source. Never erase it using a pre-sweep snapshot.
      if (!isDeepStrictEqual(readCatalogEntry(db, from), source)) {
        throw new Error(`session group ${JSON.stringify(from)} changed before completion`);
      }
      if (to !== undefined && !readCatalogEntry(db, to)) {
        throw new SessionGroupNotFoundError(to);
      }
      const sourceSectionId = `category:${from}`;
      const targetSectionId = to === undefined ? undefined : `category:${to}`;
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("session_groups").where("name", "=", from),
      );
      updateSidebarSectionOrder(db, (current) => {
        if (!current?.includes(sourceSectionId)) {
          return undefined;
        }
        // A target slot already owns the merged group's position; retire the source slot.
        return targetSectionId === undefined || current.includes(targetSectionId)
          ? current.filter((sectionId) => sectionId !== sourceSectionId)
          : current.map((sectionId) =>
              sectionId === sourceSectionId ? targetSectionId : sectionId,
            );
      });
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

export function resolveSessionGroupMutationTargetsByName(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, SessionMutationTarget[]> {
  const targetsByName = new Map<string, SessionMutationTarget[]>();
  for (const storeTarget of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      agentId: storeTarget.agentId,
      storePath: storeTarget.storePath,
    })) {
      const groupName = normalizeOptionalString(entry.category);
      if (!groupName) {
        continue;
      }
      const targets = targetsByName.get(groupName) ?? [];
      targets.push({ sessionKey, agentId: storeTarget.agentId });
      targetsByName.set(groupName, targets);
    }
  }
  return targetsByName;
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
    let changedSessionKeys: string[] = [];
    updated += await applySessionEntryReplacements<number>({
      storePath: target.storePath,
      assertCommitAllowed: () => {
        // The replacement writer awaits planning; recheck the same members at
        // its synchronous commit so a closed caller cannot write stale work.
        for (const sessionKey of changedSessionKeys) {
          assertTargetCurrent?.({ agentId: target.agentId, sessionKey });
        }
        if (to !== undefined && !readCatalogEntry(dbFor(env), to)) {
          throw new SessionGroupNotFoundError(to);
        }
      },
      update: (entries) => {
        const replacements = entries.flatMap(({ sessionKey, entry }) => {
          if (entry.category?.trim() !== from) {
            return [];
          }
          assertTargetCurrent?.({ agentId: target.agentId, sessionKey });
          const next = { ...entry };
          if (to === undefined) {
            delete next.category;
          } else {
            next.category = to;
          }
          return [{ sessionKey, entry: next }];
        });
        changedSessionKeys = replacements.map(({ sessionKey }) => sessionKey);
        return { replacements, result: replacements.length };
      },
    });
  }
  return updated;
}

type SessionGroupMutationParams = {
  cfg: OpenClawConfig;
  name: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void;
};

async function mutateSessionGroup(
  params: SessionGroupMutationParams & { to?: string },
  action: "rename" | "delete",
): Promise<{ groups: SessionGroupRecord[]; sectionOrder: string[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  const from = normalizeOptionalString(params.name);
  const to = action === "rename" ? normalizeOptionalString(params.to) : undefined;
  if (!from || (action === "rename" && !to)) {
    throw new Error(
      action === "rename"
        ? "group rename requires non-empty names"
        : "group delete requires a non-empty name",
    );
  }
  let updatedSessions = 0;
  if (from !== to) {
    params.assertCurrent?.();
    const source =
      to === undefined ? readCatalogEntry(dbFor(env), from) : prepareCatalogRename(from, to, env);
    try {
      updatedSessions = await updateMemberCategories(
        params.cfg,
        from,
        to,
        env,
        params.assertTargetCurrent,
      );
      params.assertCurrent?.();
      // A new assignment can enter a store already visited by the sweep.
      // Keep its catalog name instead of stranding that newer member.
      if (resolveSessionGroupMutationTargetsByName(params.cfg, env).get(from)?.length) {
        throw new Error(`session group ${JSON.stringify(from)} still has members`);
      }
      retireCatalogEntry(from, to, source, env);
    } catch (error) {
      const message = `${formatErrorMessage(error)}. Group changes may be partial; reload groups and retry the same operation.`;
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw new SessionMutationAuthorizationChangedError({ ...error.error, message });
      }
      throw new Error(message, { cause: error });
    }
  }
  return {
    groups: listSessionGroups(env),
    sectionOrder: listSidebarSectionOrder(env),
    updatedSessions,
  };
}

export async function renameSessionGroup(params: SessionGroupMutationParams & { to: string }) {
  return await mutateSessionGroup(params, "rename");
}

export async function deleteSessionGroup(params: SessionGroupMutationParams) {
  return await mutateSessionGroup(params, "delete");
}
