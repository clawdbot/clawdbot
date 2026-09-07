import fs, { existsSync } from "node:fs";
import path from "node:path";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "../utils.js";
import { retireWorkspaceFileCache } from "./workspace-file-cache.js";
import {
  createWorkspaceStateIdentity,
  resolveCanonicalWorkspacePath,
  resolveWorkspaceStateAliases,
  resolveWorkspaceStateIdentity,
  type WorkspaceStateIdentity,
} from "./workspace-state-identity.js";

export const WORKSPACE_SETUP_STATE_VERSION = 1 as const;
export const WORKSPACE_ATTESTATION_RECENT_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_LEGACY_STATE_MIGRATION_KIND = "legacy-workspace-setup-files";
export const WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND = "workspace-content-relocation";
const MAX_WORKSPACE_ATTESTATION_FILENAME_LENGTH = 255;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
// Attested names are joined onto the workspace dir and read back, so keep the
// accepted set closed rather than denying unsafe forms one at a time: a plain
// ASCII markdown basename excludes separators, traversal, colons, NUL, and the
// Win32 superscript/`CONIN$` device aliases in one rule.
const SAFE_ATTESTATION_BASENAME = /^[A-Za-z0-9._-]+\.md$/u;
// Win32 keeps these stems special even with an extension, so `NUL.md` names a
// device rather than a workspace file; the charset above cannot catch them.
const WINDOWS_RESERVED_DEVICE_STEMS = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;

export function isSafeWorkspaceAttestationFilename(filename: string): boolean {
  return (
    filename.length <= MAX_WORKSPACE_ATTESTATION_FILENAME_LENGTH &&
    SAFE_ATTESTATION_BASENAME.test(filename) &&
    !filename.startsWith(".") &&
    !WINDOWS_RESERVED_DEVICE_STEMS.test(filename.split(".")[0] ?? "")
  );
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function assertCanonicalTimestamp(value: string | null, label: string): void {
  if (value !== null && !isCanonicalIsoTimestamp(value)) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}

function assertCanonicalIntegerTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}

export type WorkspaceSetupState = {
  version: typeof WORKSPACE_SETUP_STATE_VERSION;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

export type WorkspaceAttestation = {
  attestedAtMs: number;
  generatedHashes: ReadonlyMap<string, string>;
};

export type WorkspaceStateSnapshot = {
  identity: WorkspaceStateIdentity;
  setupExists: boolean;
  setupUpdatedAtMs?: number;
  setup: WorkspaceSetupState;
  attestation?: WorkspaceAttestation;
};

type WorkspaceStateDeletionPlan = {
  cacheRoot: string;
  lexicalAlias: WorkspaceStateIdentity;
  currentCanonicalIdentity: WorkspaceStateIdentity;
  pathEntryExisted: boolean;
};

type WorkspaceStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "workspace_setup_state"
  | "workspace_path_aliases"
  | "workspace_generated_bootstrap_hashes"
  | "migration_runs"
  | "migration_sources"
>;

type WorkspaceStateDatabaseHandle = Pick<ReturnType<typeof openOpenClawStateDatabase>, "db">;

function workspacePathEntryExists(workspaceDir: string): boolean {
  try {
    fs.lstatSync(path.resolve(resolveUserPath(workspaceDir)));
    return true;
  } catch {
    return false;
  }
}

type WorkspaceIdentityResolution = {
  identity: WorkspaceStateIdentity;
  aliases: WorkspaceStateIdentity[];
  missingAliasKeys: string[];
};

function resolveWorkspaceIdentityFromDatabase(params: {
  workspaceDir: string;
  database: WorkspaceStateDatabaseHandle;
}): WorkspaceIdentityResolution {
  const aliases = resolveWorkspaceStateAliases(params.workspaceDir);
  const canonicalIdentity = aliases.at(-1)!;
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    kysely
      .selectFrom("workspace_path_aliases")
      .selectAll()
      .where(
        "alias_key",
        "in",
        aliases.map((alias) => alias.workspaceKey),
      ),
  ).rows;
  const aliasesByKey = new Map(aliases.map((alias) => [alias.workspaceKey, alias]));
  let storedIdentity: WorkspaceStateIdentity | undefined;
  for (const row of rows) {
    const alias = aliasesByKey.get(row.alias_key);
    if (!alias || alias.workspacePath !== row.alias_path) {
      throw new Error("workspace path alias key collision");
    }
    const rowIdentity = createWorkspaceStateIdentity(row.workspace_path);
    if (rowIdentity.workspaceKey !== row.workspace_key) {
      throw new Error("workspace path alias target is invalid");
    }
    if (storedIdentity && storedIdentity.workspaceKey !== rowIdentity.workspaceKey) {
      throw new Error("workspace path aliases resolve to conflicting state");
    }
    storedIdentity = rowIdentity;
  }
  if (
    storedIdentity &&
    workspacePathEntryExists(params.workspaceDir) &&
    storedIdentity.workspaceKey !== canonicalIdentity.workspaceKey
  ) {
    throw new Error("workspace path alias points to a different current target");
  }
  const existingAliasKeys = new Set(rows.map((row) => row.alias_key));
  return {
    identity: storedIdentity ?? canonicalIdentity,
    aliases,
    missingAliasKeys: aliases
      .map((alias) => alias.workspaceKey)
      .filter((aliasKey) => !existingAliasKeys.has(aliasKey)),
  };
}

function registerWorkspacePathAliases(params: {
  database: WorkspaceStateDatabaseHandle;
  identity: WorkspaceStateIdentity;
  aliases: readonly WorkspaceStateIdentity[];
  updatedAtMs: number;
}): void {
  assertCanonicalIntegerTimestamp(params.updatedAtMs, "path alias update");
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db);
  for (const alias of params.aliases) {
    const existing = executeSqliteQueryTakeFirstSync(
      params.database.db,
      kysely
        .selectFrom("workspace_path_aliases")
        .selectAll()
        .where("alias_key", "=", alias.workspaceKey),
    );
    if (existing) {
      if (
        existing.alias_path !== alias.workspacePath ||
        existing.workspace_key !== params.identity.workspaceKey ||
        existing.workspace_path !== params.identity.workspacePath
      ) {
        throw new Error("workspace path alias conflicts with canonical state");
      }
      continue;
    }
    executeSqliteQuerySync(
      params.database.db,
      kysely.insertInto("workspace_path_aliases").values({
        alias_key: alias.workspaceKey,
        alias_path: alias.workspacePath,
        workspace_key: params.identity.workspaceKey,
        workspace_path: params.identity.workspacePath,
        updated_at_ms: params.updatedAtMs,
      }),
    );
  }
}

export function registerWorkspaceStateAliasesInTransaction(params: {
  database: WorkspaceStateDatabaseHandle;
  workspaceDirs: readonly string[];
  identity: WorkspaceStateIdentity;
  updatedAtMs: number;
}): void {
  const aliases = new Map<string, WorkspaceStateIdentity>();
  for (const workspaceDir of params.workspaceDirs) {
    for (const alias of resolveWorkspaceStateAliases(workspaceDir)) {
      aliases.set(alias.workspaceKey, alias);
    }
  }
  registerWorkspacePathAliases({
    database: params.database,
    identity: params.identity,
    aliases: [...aliases.values()],
    updatedAtMs: params.updatedAtMs,
  });
}

function readSnapshotFromDatabase(params: {
  identity: WorkspaceStateIdentity;
  database: WorkspaceStateDatabaseHandle;
}): WorkspaceStateSnapshot {
  const identity = params.identity;
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db);
  const setupRow = executeSqliteQueryTakeFirstSync(
    params.database.db,
    kysely
      .selectFrom("workspace_setup_state")
      .selectAll()
      .where("workspace_key", "=", identity.workspaceKey),
  );
  // A NULL path marks a legacy orphan attestation; the first live access to a
  // matching workspace adopts it, so only a differing recorded path collides.
  if (setupRow?.workspace_path != null && setupRow.workspace_path !== identity.workspacePath) {
    throw new Error("workspace state key collision");
  }
  if (setupRow?.version != null && setupRow.version !== WORKSPACE_SETUP_STATE_VERSION) {
    throw new Error("workspace setup state version requires openclaw doctor --fix");
  }
  if (setupRow?.version != null) {
    assertCanonicalTimestamp(setupRow.bootstrap_seeded_at, "bootstrap seeded");
    assertCanonicalTimestamp(setupRow.setup_completed_at, "setup completed");
    if (setupRow.updated_at == null) {
      throw new Error("workspace setup update timestamp is invalid");
    }
    assertCanonicalIntegerTimestamp(setupRow.updated_at, "setup update");
  }
  const attestationPresent = setupRow?.attested_at_ms != null;
  const generatedHashes = new Map<string, string>();
  if (setupRow && attestationPresent) {
    assertCanonicalIntegerTimestamp(setupRow.attested_at_ms!, "attestation");
    const hashRows = executeSqliteQuerySync(
      params.database.db,
      kysely
        .selectFrom("workspace_generated_bootstrap_hashes")
        .select(["filename", "sha256"])
        .where("workspace_key", "=", identity.workspaceKey)
        .orderBy("filename", "asc"),
    ).rows;
    for (const row of hashRows) {
      // Validate names structurally rather than against today's bootstrap set:
      // retiring a seeded file must not make an existing attestation unreadable.
      if (
        !isSafeWorkspaceAttestationFilename(row.filename) ||
        !SHA256_HEX_PATTERN.test(row.sha256)
      ) {
        throw new Error("workspace attestation hash row is invalid");
      }
      generatedHashes.set(row.filename, row.sha256);
    }
  }
  const setupExists = setupRow?.version != null;
  return {
    identity,
    setupExists,
    ...(setupExists && setupRow?.updated_at != null
      ? { setupUpdatedAtMs: setupRow.updated_at }
      : {}),
    setup: {
      version: WORKSPACE_SETUP_STATE_VERSION,
      ...(setupRow?.bootstrap_seeded_at ? { bootstrapSeededAt: setupRow.bootstrap_seeded_at } : {}),
      ...(setupRow?.setup_completed_at ? { setupCompletedAt: setupRow.setup_completed_at } : {}),
    },
    ...(attestationPresent
      ? {
          attestation: {
            attestedAtMs: setupRow!.attested_at_ms!,
            generatedHashes,
          },
        }
      : {}),
  };
}

export function readWorkspaceStateSnapshot(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions = {},
): WorkspaceStateSnapshot {
  if (options.readOnly) {
    const snapshot = withExistingOpenClawStateDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
          return readSnapshotFromDatabase({ identity: resolution.identity, database });
        }),
      options,
    );
    return (
      snapshot ?? {
        identity: resolveWorkspaceStateIdentity(workspaceDir),
        setupExists: false,
        setup: { version: WORKSPACE_SETUP_STATE_VERSION },
      }
    );
  }
  const database = openOpenClawStateDatabase(options);
  const initial = runSqliteDeferredTransactionSync(database.db, () => {
    const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
    return {
      resolution,
      snapshot: readSnapshotFromDatabase({ identity: resolution.identity, database }),
    };
  });
  if (
    initial.resolution.missingAliasKeys.length === 0 ||
    (!initial.snapshot.setupExists && !initial.snapshot.attestation)
  ) {
    return initial.snapshot;
  }
  // Register a newly observed configured spelling once state proves the target
  // identity. Later disappearance must still find the same safety evidence.
  return runOpenClawStateWriteTransaction((writeDatabase) => {
    const currentAliases = resolveWorkspaceStateAliases(workspaceDir);
    const currentCanonicalIdentity = currentAliases.at(-1)!;
    if (
      workspacePathEntryExists(workspaceDir) &&
      currentCanonicalIdentity.workspaceKey !== initial.resolution.identity.workspaceKey
    ) {
      throw new Error("workspace path alias points to a different current target");
    }
    const snapshot = readSnapshotFromDatabase({
      identity: initial.resolution.identity,
      database: writeDatabase,
    });
    if (snapshot.setupExists || snapshot.attestation) {
      const aliases = new Map(
        [...initial.resolution.aliases, ...currentAliases].map((alias) => [
          alias.workspaceKey,
          alias,
        ]),
      );
      registerWorkspacePathAliases({
        database: writeDatabase,
        identity: initial.resolution.identity,
        aliases: [...aliases.values()],
        updatedAtMs: Date.now(),
      });
    }
    return snapshot;
  }, options);
}

export function mergeWorkspaceSetupState(
  workspaceDir: string,
  next: Partial<Omit<WorkspaceSetupState, "version">>,
  nowMs = Date.now(),
  options: OpenClawStateDatabaseOptions = {},
): WorkspaceSetupState {
  assertCanonicalIntegerTimestamp(nowMs, "setup update");
  if (next.bootstrapSeededAt) {
    assertCanonicalTimestamp(next.bootstrapSeededAt, "bootstrap seeded");
  }
  if (next.setupCompletedAt) {
    assertCanonicalTimestamp(next.setupCompletedAt, "setup completed");
  }
  return runOpenClawStateWriteTransaction((database) => {
    const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
    const identity = resolution.identity;
    const snapshot = readSnapshotFromDatabase({ identity, database });
    const bootstrapSeededAt = snapshot.setup.bootstrapSeededAt ?? next.bootstrapSeededAt;
    const setupCompletedAt = snapshot.setup.setupCompletedAt ?? next.setupCompletedAt;
    const merged: WorkspaceSetupState = {
      version: WORKSPACE_SETUP_STATE_VERSION,
      ...(bootstrapSeededAt ? { bootstrapSeededAt } : {}),
      ...(setupCompletedAt ? { setupCompletedAt } : {}),
    };
    const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      kysely
        .insertInto("workspace_setup_state")
        .values({
          workspace_key: identity.workspaceKey,
          workspace_path: identity.workspacePath,
          version: WORKSPACE_SETUP_STATE_VERSION,
          bootstrap_seeded_at: merged.bootstrapSeededAt ?? null,
          setup_completed_at: merged.setupCompletedAt ?? null,
          updated_at: nowMs,
        })
        .onConflict((conflict) =>
          conflict.column("workspace_key").doUpdateSet({
            workspace_path: identity.workspacePath,
            version: WORKSPACE_SETUP_STATE_VERSION,
            bootstrap_seeded_at: merged.bootstrapSeededAt ?? null,
            setup_completed_at: merged.setupCompletedAt ?? null,
            updated_at: nowMs,
          }),
        ),
    );
    registerWorkspacePathAliases({
      database,
      identity,
      aliases: resolution.aliases,
      updatedAtMs: nowMs,
    });
    return merged;
  }, options);
}

export function replaceWorkspaceAttestation(params: {
  workspaceDir: string;
  attestedAtMs: number;
  generatedHashes: ReadonlyMap<string, string>;
  nowMs?: number;
}): WorkspaceAttestation {
  assertCanonicalIntegerTimestamp(params.attestedAtMs, "attestation");
  if (params.nowMs !== undefined) {
    assertCanonicalIntegerTimestamp(params.nowMs, "attestation update");
  }
  for (const [filename, sha256] of params.generatedHashes) {
    if (!isSafeWorkspaceAttestationFilename(filename) || !SHA256_HEX_PATTERN.test(sha256)) {
      throw new Error("workspace attestation hash is invalid");
    }
  }
  const sortedHashes = [...params.generatedHashes.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return runOpenClawStateWriteTransaction((database) => {
    // Capture the comparison clock only after BEGIN IMMEDIATE acquires the
    // writer lock, so a newer committed row cannot look future-dated.
    const updatedAtMs = params.nowMs ?? Date.now();
    assertCanonicalIntegerTimestamp(updatedAtMs, "attestation update");
    const resolution = resolveWorkspaceIdentityFromDatabase({
      workspaceDir: params.workspaceDir,
      database,
    });
    const identity = resolution.identity;
    const snapshot = readSnapshotFromDatabase({ identity, database });
    if (
      snapshot.attestation &&
      snapshot.attestation.attestedAtMs > params.attestedAtMs &&
      snapshot.attestation.attestedAtMs <= updatedAtMs
    ) {
      registerWorkspacePathAliases({
        database,
        identity,
        aliases: resolution.aliases,
        updatedAtMs,
      });
      return snapshot.attestation;
    }
    const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      kysely
        .insertInto("workspace_setup_state")
        .values({
          workspace_key: identity.workspaceKey,
          workspace_path: identity.workspacePath,
          attested_at_ms: params.attestedAtMs,
          attestation_updated_at_ms: updatedAtMs,
        })
        .onConflict((conflict) =>
          conflict.column("workspace_key").doUpdateSet({
            // Heals the NULL path on adopted legacy orphan attestation rows.
            workspace_path: identity.workspacePath,
            attested_at_ms: params.attestedAtMs,
            attestation_updated_at_ms: updatedAtMs,
          }),
        ),
    );
    executeSqliteQuerySync(
      database.db,
      kysely
        .deleteFrom("workspace_generated_bootstrap_hashes")
        .where("workspace_key", "=", identity.workspaceKey),
    );
    if (sortedHashes.length > 0) {
      executeSqliteQuerySync(
        database.db,
        kysely.insertInto("workspace_generated_bootstrap_hashes").values(
          sortedHashes.map(([filename, sha256]) => ({
            workspace_key: identity.workspaceKey,
            filename,
            sha256,
          })),
        ),
      );
    }
    registerWorkspacePathAliases({
      database,
      identity,
      aliases: resolution.aliases,
      updatedAtMs,
    });
    return {
      attestedAtMs: params.attestedAtMs,
      generatedHashes: new Map(sortedHashes),
    };
  });
}

function deleteWorkspaceRows(
  database: WorkspaceStateDatabaseHandle,
  { workspaceKey, workspacePath }: WorkspaceStateIdentity,
): void {
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
  const receiptRows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("migration_sources")
      .select(["source_key", "last_run_id", "report_json"])
      .where("migration_kind", "in", [
        WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
        WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
      ]),
  ).rows.filter((row) => {
    try {
      const report = JSON.parse(row.report_json) as Record<string, unknown>;
      return report.workspaceKey === workspaceKey;
    } catch {
      return false;
    }
  });
  if (receiptRows.length > 0) {
    const receiptKeys = receiptRows.map((row) => row.source_key);
    executeSqliteQuerySync(
      database.db,
      kysely.deleteFrom("migration_sources").where("source_key", "in", receiptKeys),
    );
    const runIds = [...new Set(receiptRows.map((row) => row.last_run_id))];
    const referencedRunIds = new Set(
      executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("migration_sources")
          .select("last_run_id")
          .where("last_run_id", "in", runIds),
      ).rows.map((row) => row.last_run_id),
    );
    const orphanedRunIds = runIds.filter((runId) => !referencedRunIds.has(runId));
    if (orphanedRunIds.length > 0) {
      executeSqliteQuerySync(
        database.db,
        kysely.deleteFrom("migration_runs").where("id", "in", orphanedRunIds),
      );
    }
  }
  executeSqliteQuerySync(
    database.db,
    kysely
      .deleteFrom("workspace_generated_bootstrap_hashes")
      .where("workspace_key", "=", workspaceKey),
  );
  executeSqliteQuerySync(
    database.db,
    kysely.deleteFrom("workspace_setup_state").where("workspace_key", "=", workspaceKey),
  );
  executeSqliteQuerySync(
    database.db,
    kysely.deleteFrom("workspace_path_aliases").where("workspace_key", "=", workspaceKey),
  );
  // Both deletion paths retire the actual stored identity only after the outer
  // commit; a failed transaction must retain content for the surviving workspace.
  deferSqlitePostCommitPublication(database.db, () => retireWorkspaceFileCache(workspacePath));
}

/** The migration owner has verified the same workspace and every relocated byte before this commit. */
export function retireWorkspaceRelocationAttestation(params: {
  database: WorkspaceStateDatabaseHandle;
  identity: WorkspaceStateIdentity;
  attestedAtMs: number;
}): boolean {
  const snapshot = readSnapshotFromDatabase(params);
  if (
    snapshot.setupExists ||
    snapshot.attestation?.attestedAtMs !== params.attestedAtMs ||
    snapshot.attestation.generatedHashes.size > 0
  ) {
    return false;
  }
  executeSqliteQuerySync(
    params.database.db,
    getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db)
      .updateTable("workspace_setup_state")
      .set({ attested_at_ms: null, attestation_updated_at_ms: null })
      .where("workspace_key", "=", params.identity.workspaceKey),
  );
  return true;
}

/** Clear expired state only when no concurrent writer refreshed the vanished workspace. */
export function clearExpiredWorkspaceStateForVanishedWorkspace(
  workspaceDir: string,
  nowMs = Date.now(),
): boolean {
  assertCanonicalIntegerTimestamp(nowMs, "workspace expiry check");
  return runOpenClawStateWriteTransaction((database) => {
    const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
    const identity = resolution.identity;
    const snapshot = readSnapshotFromDatabase({ identity, database });
    const preserveRecentState = () => {
      registerWorkspacePathAliases({
        database,
        identity,
        aliases: resolution.aliases,
        updatedAtMs: nowMs,
      });
      return false;
    };
    if (snapshot.attestation) {
      const ageMs = nowMs - snapshot.attestation.attestedAtMs;
      if (ageMs <= WORKSPACE_ATTESTATION_RECENT_MS) {
        return preserveRecentState();
      }
    }
    if (
      (snapshot.setup.bootstrapSeededAt || snapshot.setup.setupCompletedAt) &&
      snapshot.setupUpdatedAtMs !== undefined
    ) {
      const ageMs = nowMs - snapshot.setupUpdatedAtMs;
      if (ageMs <= WORKSPACE_ATTESTATION_RECENT_MS) {
        return preserveRecentState();
      }
    }
    deleteWorkspaceRows(database, identity);
    return true;
  });
}

/** Capture workspace identity before the filesystem entry is removed. */
export function prepareWorkspaceStateDeletion(workspaceDir: string): WorkspaceStateDeletionPlan {
  const aliases = resolveWorkspaceStateAliases(workspaceDir);
  return {
    cacheRoot: resolveCanonicalWorkspacePath(workspaceDir),
    lexicalAlias: aliases[0]!,
    currentCanonicalIdentity: aliases.at(-1)!,
    pathEntryExisted: workspacePathEntryExists(workspaceDir),
  };
}

export function deleteWorkspaceState(plan: WorkspaceStateDeletionPlan): void {
  // Delete-only cleanup must not recreate state after reset/uninstall removed
  // the canonical database successfully or partially.
  if (!existsSync(resolveOpenClawStateSqlitePath())) {
    retireWorkspaceFileCache(plan.cacheRoot);
    return;
  }
  runOpenClawStateWriteTransaction((database) => {
    const { lexicalAlias, currentCanonicalIdentity } = plan;
    const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
    const storedAlias = executeSqliteQueryTakeFirstSync(
      database.db,
      kysely
        .selectFrom("workspace_path_aliases")
        .selectAll()
        .where("alias_key", "=", lexicalAlias.workspaceKey),
    );
    if (storedAlias && storedAlias.alias_path !== lexicalAlias.workspacePath) {
      throw new Error("workspace path alias key collision");
    }
    const storedIdentity = storedAlias
      ? createWorkspaceStateIdentity(storedAlias.workspace_path)
      : undefined;
    if (storedIdentity && storedIdentity.workspaceKey !== storedAlias?.workspace_key) {
      throw new Error("workspace path alias target is invalid");
    }
    if (
      storedIdentity &&
      plan.pathEntryExisted &&
      storedIdentity.workspaceKey !== currentCanonicalIdentity.workspaceKey
    ) {
      // A repointed configured alias no longer owns its former canonical
      // workspace. Remove only that stale association, then clean current state.
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("workspace_path_aliases")
          .where("alias_key", "=", lexicalAlias.workspaceKey),
      );
      const currentResolution = resolveWorkspaceIdentityFromDatabase({
        workspaceDir: currentCanonicalIdentity.workspacePath,
        database,
      });
      return deleteWorkspaceRows(database, currentResolution.identity);
    }
    if (storedIdentity) {
      return deleteWorkspaceRows(database, storedIdentity);
    }
    const resolution = resolveWorkspaceIdentityFromDatabase({
      workspaceDir: currentCanonicalIdentity.workspacePath,
      database,
    });
    return deleteWorkspaceRows(database, resolution.identity);
  });
}
