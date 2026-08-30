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
} from "./workspace-state-identity.js";
import {
  registerWorkspaceStateAliasesInTransaction,
  workspacePathEntryExists,
} from "./workspace-state-store.js";

type WorkspaceAliasDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "workspace_setup_state" | "workspace_path_aliases" | "workspace_generated_bootstrap_hashes"
>;

type WorkspaceAliasDatabaseHandle = Pick<ReturnType<typeof openOpenClawStateDatabase>, "db">;

export type RepointedWorkspaceAliasFacts = {
  aliasPath: string;
  storedWorkspacePath: string;
  currentWorkspacePath: string;
  storedAttestationHashes: ReadonlyMap<string, string>;
  currentTargetHasOwnState: boolean;
};

function readRepointedWorkspaceAlias(params: {
  workspaceDir: string;
  database: WorkspaceAliasDatabaseHandle;
}): RepointedWorkspaceAliasFacts | undefined {
  const aliases = resolveWorkspaceStateAliases(params.workspaceDir);
  const lexicalAlias = aliases[0]!;
  const currentCanonicalIdentity = aliases.at(-1)!;
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
    !workspacePathEntryExists(params.workspaceDir) ||
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
    storedAttestationHashes: new Map(hashRows.map((row) => [row.filename, row.sha256])),
    currentTargetHasOwnState: currentSetupRow !== undefined,
  };
}

/** Read-only doctor probe: reports a configured alias whose stored state belongs to a different canonical target. */
export function detectRepointedWorkspaceAlias(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions = {},
): RepointedWorkspaceAliasFacts | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () =>
        readRepointedWorkspaceAlias({ workspaceDir, database }),
      ),
    options,
  );
}

export type WorkspaceAliasRebindOutcome = "rebound" | "no-repoint" | "current-target-owns-state";

/**
 * Non-destructive doctor repair: moves the stored setup state and attestation
 * onto the alias's current canonical target and rewrites the alias rows.
 * Workspace files are never touched; refuses when the current target already
 * owns state so a repair cannot silently merge two workspaces.
 */
export function rebindRepointedWorkspaceAlias(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions = {},
): WorkspaceAliasRebindOutcome {
  return runOpenClawStateWriteTransaction((database) => {
    const facts = readRepointedWorkspaceAlias({ workspaceDir, database });
    if (!facts) {
      return "no-repoint";
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
      // The hash table's FK references the setup row's key, so adopt by
      // inserting the new parent first, repointing children, then deleting the
      // old parent — an in-place key UPDATE would violate the constraint.
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
    // The old canonical identity no longer owns state, so drop every alias that
    // resolved to it before re-registering the configured spelling; a stale row
    // would otherwise collide with the fresh registration below.
    executeSqliteQuerySync(
      database.db,
      kysely
        .deleteFrom("workspace_path_aliases")
        .where("workspace_key", "=", storedIdentity.workspaceKey),
    );
    registerWorkspaceStateAliasesInTransaction({
      database,
      workspaceDirs: [workspaceDir],
      identity: currentIdentity,
      updatedAtMs: Date.now(),
    });
    return "rebound";
  }, options);
}
