/** Doctor-owned detection and non-destructive rebind for repointed workspace aliases. */
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  createWorkspaceStateIdentity,
  resolveWorkspaceStateAliases,
  type WorkspaceStateIdentity,
} from "./workspace-state-identity.js";
import {
  isValidWorkspaceAttestationHash,
  registerWorkspaceStateAliasIdentitiesInTransaction,
  workspacePathEntryExists,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
} from "./workspace-state-store.js";

type WorkspaceAliasDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "workspace_setup_state"
  | "workspace_path_aliases"
  | "workspace_generated_bootstrap_hashes"
  | "migration_sources"
>;

type WorkspaceAliasDatabaseHandle = Pick<ReturnType<typeof openOpenClawStateDatabase>, "db">;

type WorkspaceAliasFilesystemFacts = {
  aliases: readonly WorkspaceStateIdentity[];
  lexicalAlias: WorkspaceStateIdentity;
  currentCanonicalIdentity: WorkspaceStateIdentity;
  pathEntryExists: boolean;
};

export type RepointedWorkspaceAliasFacts = {
  aliasPath: string;
  storedWorkspacePath: string;
  currentWorkspacePath: string;
  storedAttestationHashes: ReadonlyMap<string, string>;
  currentTargetHasOwnState: boolean;
};

function resolveWorkspaceAliasFilesystemFacts(workspaceDir: string): WorkspaceAliasFilesystemFacts {
  const aliases = resolveWorkspaceStateAliases(workspaceDir);
  return {
    aliases,
    lexicalAlias: aliases[0]!,
    currentCanonicalIdentity: aliases.at(-1)!,
    pathEntryExists: workspacePathEntryExists(workspaceDir),
  };
}

function readRepointedWorkspaceAlias(params: {
  filesystem: WorkspaceAliasFilesystemFacts;
  database: WorkspaceAliasDatabaseHandle;
}): RepointedWorkspaceAliasFacts | undefined {
  const { lexicalAlias, currentCanonicalIdentity } = params.filesystem;
  const kysely = getNodeSqliteKysely<WorkspaceAliasDatabase>(params.database.db);
  const storedAlias = executeSqliteQueryTakeFirstSync(
    params.database.db,
    kysely
      .selectFrom("workspace_path_aliases")
      .selectAll()
      .where("alias_key", "=", lexicalAlias.workspaceKey),
  );
  if (!storedAlias || storedAlias.alias_path !== lexicalAlias.workspacePath) {
    return undefined;
  }
  const storedIdentity = createWorkspaceStateIdentity(storedAlias.workspace_path);
  if (storedIdentity.workspaceKey !== storedAlias.workspace_key) {
    throw new Error("workspace path alias target is invalid");
  }
  if (
    !params.filesystem.pathEntryExists ||
    storedIdentity.workspaceKey === currentCanonicalIdentity.workspaceKey
  ) {
    return undefined;
  }
  const hashRows = executeSqliteQuerySync(
    params.database.db,
    kysely
      .selectFrom("workspace_generated_bootstrap_hashes")
      .select(["filename", "sha256"])
      .where("workspace_key", "=", storedIdentity.workspaceKey)
      .orderBy("filename", "asc"),
  ).rows;
  const storedAttestationHashes = new Map<string, string>();
  for (const row of hashRows) {
    if (!isValidWorkspaceAttestationHash(row.filename, row.sha256)) {
      throw new Error("workspace attestation hash row is invalid");
    }
    storedAttestationHashes.set(row.filename, row.sha256);
  }
  const currentSetupRow = executeSqliteQueryTakeFirstSync(
    params.database.db,
    kysely
      .selectFrom("workspace_setup_state")
      .select("workspace_key")
      .where("workspace_key", "=", currentCanonicalIdentity.workspaceKey),
  );
  return {
    aliasPath: lexicalAlias.workspacePath,
    storedWorkspacePath: storedIdentity.workspacePath,
    currentWorkspacePath: currentCanonicalIdentity.workspacePath,
    storedAttestationHashes,
    currentTargetHasOwnState: currentSetupRow !== undefined,
  };
}

function factsMatch(
  actual: RepointedWorkspaceAliasFacts,
  expected: RepointedWorkspaceAliasFacts,
): boolean {
  if (
    actual.aliasPath !== expected.aliasPath ||
    actual.storedWorkspacePath !== expected.storedWorkspacePath ||
    actual.currentWorkspacePath !== expected.currentWorkspacePath ||
    actual.currentTargetHasOwnState !== expected.currentTargetHasOwnState ||
    actual.storedAttestationHashes.size !== expected.storedAttestationHashes.size
  ) {
    return false;
  }
  for (const [filename, sha256] of actual.storedAttestationHashes) {
    if (expected.storedAttestationHashes.get(filename) !== sha256) {
      return false;
    }
  }
  return true;
}

function transferWorkspaceMigrationReceipts(params: {
  database: WorkspaceAliasDatabaseHandle;
  storedWorkspaceKey: string;
  currentWorkspaceKey: string;
}): void {
  const kysely = getNodeSqliteKysely<WorkspaceAliasDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    kysely
      .selectFrom("migration_sources")
      .select(["source_key", "report_json"])
      .where("migration_kind", "=", WORKSPACE_LEGACY_STATE_MIGRATION_KIND),
  ).rows;
  for (const row of rows) {
    let report: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.report_json) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      // SAFETY: the guard above proves parsed is a non-null, non-array object.
      report = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (report.workspaceKey !== params.storedWorkspaceKey) {
      continue;
    }
    executeSqliteQuerySync(
      params.database.db,
      kysely
        .updateTable("migration_sources")
        .set({
          report_json: JSON.stringify({ ...report, workspaceKey: params.currentWorkspaceKey }),
        })
        .where("source_key", "=", row.source_key),
    );
  }
}

/** Read-only doctor probe for a configured alias whose state belongs to another target. */
export function detectRepointedWorkspaceAlias(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions = {},
): RepointedWorkspaceAliasFacts | undefined {
  const filesystem = resolveWorkspaceAliasFilesystemFacts(workspaceDir);
  return withExistingOpenClawStateDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () =>
        readRepointedWorkspaceAlias({ filesystem, database }),
      ),
    options,
  );
}

export type WorkspaceAliasRebindOutcome =
  | "rebound"
  | "no-repoint"
  | "repoint-changed"
  | "current-target-owns-state";

/**
 * Moves the stored setup state and attestation to an approved current target.
 * The transaction revalidates the exact facts that doctor presented.
 */
export function rebindRepointedWorkspaceAlias(
  workspaceDir: string,
  expectedFacts: RepointedWorkspaceAliasFacts,
  options: OpenClawStateDatabaseOptions = {},
): WorkspaceAliasRebindOutcome {
  const filesystem = resolveWorkspaceAliasFilesystemFacts(workspaceDir);
  if (
    filesystem.lexicalAlias.workspacePath !== expectedFacts.aliasPath ||
    filesystem.currentCanonicalIdentity.workspacePath !== expectedFacts.currentWorkspacePath
  ) {
    return "repoint-changed";
  }
  // Maintainer decision pending: the accepted material persistent-store repair
  // design must be linked before merge (tracked in the PR body).
  return runOpenClawStateWriteTransaction((database) => {
    const facts = readRepointedWorkspaceAlias({ filesystem, database });
    if (!facts) {
      return "no-repoint";
    }
    if (!factsMatch(facts, expectedFacts)) {
      return "repoint-changed";
    }
    if (facts.currentTargetHasOwnState) {
      return "current-target-owns-state";
    }
    const storedIdentity = createWorkspaceStateIdentity(facts.storedWorkspacePath);
    const currentIdentity = createWorkspaceStateIdentity(facts.currentWorkspacePath);
    const kysely = getNodeSqliteKysely<WorkspaceAliasDatabase>(database.db);
    const storedSetupRow = executeSqliteQueryTakeFirstSync(
      database.db,
      kysely
        .selectFrom("workspace_setup_state")
        .selectAll()
        .where("workspace_key", "=", storedIdentity.workspaceKey),
    );
    if (storedSetupRow) {
      // Insert the new FK parent before repointing children and deleting the old parent.
      executeSqliteQuerySync(
        database.db,
        kysely.insertInto("workspace_setup_state").values({
          ...storedSetupRow,
          workspace_key: currentIdentity.workspaceKey,
          workspace_path: currentIdentity.workspacePath,
        }),
      );
      executeSqliteQuerySync(
        database.db,
        kysely
          .updateTable("workspace_generated_bootstrap_hashes")
          .set({ workspace_key: currentIdentity.workspaceKey })
          .where("workspace_key", "=", storedIdentity.workspaceKey),
      );
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("workspace_setup_state")
          .where("workspace_key", "=", storedIdentity.workspaceKey),
      );
    }
    transferWorkspaceMigrationReceipts({
      database,
      storedWorkspaceKey: storedIdentity.workspaceKey,
      currentWorkspaceKey: currentIdentity.workspaceKey,
    });
    // Remove all stale aliases before registering the prepared current identities.
    executeSqliteQuerySync(
      database.db,
      kysely
        .deleteFrom("workspace_path_aliases")
        .where("workspace_key", "=", storedIdentity.workspaceKey),
    );
    registerWorkspaceStateAliasIdentitiesInTransaction({
      database,
      aliases: filesystem.aliases,
      identity: currentIdentity,
      updatedAtMs: Date.now(),
    });
    return "rebound";
  }, options);
}
