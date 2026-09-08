import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { pathMayExistSync } from "../infra/path-existence.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  applyWorkspaceMigrationReceiptMove,
  prepareWorkspaceMigrationReceiptMove,
} from "../infra/state-migrations.workspace-setup-receipts.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { retireWorkspaceFileCache } from "./workspace-file-cache.js";
import {
  createWorkspaceStateIdentity,
  normalizeWorkspaceIdentityPath,
  resolveCanonicalWorkspacePath,
  resolveWorkspaceStateAliases,
  type WorkspaceStateIdentity,
} from "./workspace-state-identity.js";
import {
  readWorkspaceStateSnapshotFromDatabase,
  registerWorkspaceStateAliasIdentitiesInTransaction,
} from "./workspace-state-store.js";

type WorkspaceDatabase = Pick<
  DB,
  "workspace_setup_state" | "workspace_path_aliases" | "workspace_generated_bootstrap_hashes"
>;
type WorkspaceDatabaseHandle = Pick<ReturnType<typeof openOpenClawStateDatabase>, "db" | "path">;

function directoryIdentity(workspacePath: string): string | undefined {
  try {
    const stat = fs.statSync(workspacePath, { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : undefined;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  }
}

// Stored identities discard Unicode spelling. Inspect every matching filesystem
// spelling, including ancestors, so a surviving original cannot lose its history.
function existingWorkspacePathSpellings(storedPath: string): string[] {
  const root = path.parse(storedPath).root;
  let parents = [root];
  for (const segment of storedPath.slice(root.length).split(path.sep)) {
    parents = parents.flatMap((parent) => {
      try {
        return fs
          .readdirSync(parent)
          .filter((entry) => normalizeWorkspaceIdentityPath(entry) === segment)
          .toSorted()
          .map((entry) => path.join(parent, entry));
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      }
    });
  }
  return parents;
}

function readWorkspaceMoveState(
  database: WorkspaceDatabaseHandle,
  identity: WorkspaceStateIdentity,
) {
  const snapshot = readWorkspaceStateSnapshotFromDatabase({ database, identity });
  const kysely = getNodeSqliteKysely<WorkspaceDatabase>(database.db);
  return {
    setup: executeSqliteQueryTakeFirstSync(
      database.db,
      kysely
        .selectFrom("workspace_setup_state")
        .selectAll()
        .where("workspace_key", "=", identity.workspaceKey),
    ),
    hashes: [...(snapshot.attestation?.generatedHashes ?? [])],
    aliases: executeSqliteQuerySync(
      database.db,
      kysely
        .selectFrom("workspace_path_aliases")
        .selectAll()
        .where("workspace_key", "=", identity.workspaceKey)
        .orderBy("alias_key", "asc"),
    ).rows,
  };
}

export type RepointedWorkspaceAliasFacts = {
  aliasPath: string;
  storedWorkspacePath: string;
  currentWorkspacePath: string;
  currentDirectoryPath: string;
  currentTargetHasOwnState: boolean;
  targetDirectoryIdentity: string | undefined;
  state: ReturnType<typeof readWorkspaceMoveState>;
};

/** Read the old owner without adopting the alias's new target. */
export function detectRepointedWorkspaceAlias(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions = {},
): RepointedWorkspaceAliasFacts | undefined {
  const aliases = resolveWorkspaceStateAliases(workspaceDir);
  const lexical = aliases[0]!;
  const current = aliases.at(-1)!;
  const currentDirectoryPath = resolveCanonicalWorkspacePath(workspaceDir);
  const targetDirectoryIdentity = directoryIdentity(currentDirectoryPath);
  if (!pathMayExistSync(resolveUserPath(workspaceDir))) {
    return undefined;
  }
  return withExistingOpenClawStateDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () => {
        const kysely = getNodeSqliteKysely<WorkspaceDatabase>(database.db);
        const alias = executeSqliteQueryTakeFirstSync(
          database.db,
          kysely
            .selectFrom("workspace_path_aliases")
            .selectAll()
            .where("alias_key", "=", lexical.workspaceKey),
        );
        if (!alias) {
          return undefined;
        }
        const stored = createWorkspaceStateIdentity(alias.workspace_path);
        if (
          alias.alias_path !== lexical.workspacePath ||
          alias.workspace_key !== stored.workspaceKey
        ) {
          throw new Error("workspace path alias identity is invalid");
        }
        if (stored.workspaceKey === current.workspaceKey) {
          return undefined;
        }
        return {
          aliasPath: lexical.workspacePath,
          storedWorkspacePath: stored.workspacePath,
          currentWorkspacePath: current.workspacePath,
          currentDirectoryPath,
          currentTargetHasOwnState:
            executeSqliteQueryTakeFirstSync(
              database.db,
              kysely
                .selectFrom("workspace_setup_state")
                .select("workspace_key")
                .where("workspace_key", "=", current.workspaceKey),
            ) !== undefined,
          targetDirectoryIdentity,
          state: readWorkspaceMoveState(database, stored),
        };
      }),
    options,
  );
}

export type WorkspaceAliasRebindOutcome =
  | "rebound"
  | "no-repoint"
  | "repoint-changed"
  | "current-target-owns-state"
  | "original-workspace-exists"
  | "target-directory-missing"
  | "configured-workspace-conflict";

export function inspectWorkspaceAliasMove(
  workspaceDir: string,
  expected: RepointedWorkspaceAliasFacts,
  configuredWorkspaceDirs: readonly string[] = [workspaceDir],
):
  | { kind: "ready"; aliases: WorkspaceStateIdentity[] }
  | { kind: "blocked"; outcome: Exclude<WorkspaceAliasRebindOutcome, "rebound"> } {
  if (expected.currentTargetHasOwnState) {
    return { kind: "blocked", outcome: "current-target-owns-state" };
  }
  const stored = createWorkspaceStateIdentity(expected.storedWorkspacePath);
  const current = createWorkspaceStateIdentity(expected.currentWorkspacePath);
  if (!expected.targetDirectoryIdentity) {
    return { kind: "blocked", outcome: "target-directory-missing" };
  }
  if (directoryIdentity(expected.currentDirectoryPath) !== expected.targetDirectoryIdentity) {
    return { kind: "blocked", outcome: "repoint-changed" };
  }
  const matchesDestination = (candidate: string) =>
    resolveWorkspaceStateAliases(candidate).at(-1)!.workspaceKey === current.workspaceKey &&
    directoryIdentity(resolveCanonicalWorkspacePath(candidate)) ===
      expected.targetDirectoryIdentity;
  if (
    existingWorkspacePathSpellings(stored.workspacePath).some(
      (candidate) => !matchesDestination(candidate),
    )
  ) {
    return { kind: "blocked", outcome: "original-workspace-exists" };
  }
  const aliases = new Map<string, WorkspaceStateIdentity>();
  const oldAliasKeys = new Set(expected.state.aliases.map((alias) => alias.alias_key));
  const configuredPaths = new Set(configuredWorkspaceDirs);
  for (const candidate of [
    ...expected.state.aliases.flatMap((alias) => [
      alias.alias_path,
      ...existingWorkspacePathSpellings(alias.alias_path),
    ]),
    ...configuredPaths,
    workspaceDir,
  ]) {
    const resolved = resolveWorkspaceStateAliases(candidate);
    const lexical = resolved[0]!;
    const target = resolved.at(-1)!;
    if (configuredPaths.has(candidate) && target.workspaceKey === stored.workspaceKey) {
      return { kind: "blocked", outcome: "configured-workspace-conflict" };
    }
    if (matchesDestination(candidate)) {
      for (const alias of resolved) {
        aliases.set(alias.workspaceKey, alias);
      }
    } else if (
      oldAliasKeys.has(lexical.workspaceKey) &&
      (pathMayExistSync(resolveUserPath(candidate)) || configuredPaths.has(candidate))
    ) {
      return { kind: "blocked", outcome: "configured-workspace-conflict" };
    }
  }
  if (resolveWorkspaceStateAliases(workspaceDir).at(-1)!.workspaceKey !== current.workspaceKey) {
    return { kind: "blocked", outcome: "repoint-changed" };
  }
  return { kind: "ready", aliases: [...aliases.values()] };
}

/** Transfer only a confirmed move; source history is never rebuilt from templates. */
export async function rebindRepointedWorkspaceAlias(
  workspaceDir: string,
  expected: RepointedWorkspaceAliasFacts,
  options: OpenClawStateDatabaseOptions = {},
  configuredWorkspaceDirs: readonly string[] = [workspaceDir],
  verifyConfiguration?: () => Promise<void>,
): Promise<WorkspaceAliasRebindOutcome> {
  const observed = detectRepointedWorkspaceAlias(workspaceDir, options);
  if (!observed) {
    return "no-repoint";
  }
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    return "repoint-changed";
  }
  const initial = inspectWorkspaceAliasMove(workspaceDir, expected, configuredWorkspaceDirs);
  if (initial.kind === "blocked") {
    return initial.outcome;
  }
  const stored = createWorkspaceStateIdentity(expected.storedWorkspacePath);
  const current = createWorkspaceStateIdentity(expected.currentWorkspacePath);
  const database = openOpenClawStateDatabase(options);
  const receipts = await prepareWorkspaceMigrationReceiptMove({
    database: database.db,
    storedIdentity: stored,
    currentIdentity: current,
    currentDirectoryPath: expected.currentDirectoryPath,
    storedSetup: expected.state.setup,
  });
  await verifyConfiguration?.();
  // Resolve filesystem facts after asynchronous planning, before BEGIN.
  // Missing historical aliases must not let later cleanup delete the moved owner.
  const filesystem = inspectWorkspaceAliasMove(workspaceDir, expected, configuredWorkspaceDirs);
  if (filesystem.kind === "blocked") {
    return filesystem.outcome;
  }
  return runOpenClawStateWriteTransaction((writeDatabase) => {
    const state = readWorkspaceMoveState(writeDatabase, stored);
    if (JSON.stringify(state) !== JSON.stringify(expected.state)) {
      return "repoint-changed";
    }
    const kysely = getNodeSqliteKysely<WorkspaceDatabase>(writeDatabase.db);
    if (
      executeSqliteQueryTakeFirstSync(
        writeDatabase.db,
        kysely
          .selectFrom("workspace_setup_state")
          .select("workspace_key")
          .where("workspace_key", "=", current.workspaceKey),
      )
    ) {
      return "current-target-owns-state";
    }
    applyWorkspaceMigrationReceiptMove(writeDatabase.db, receipts);
    if (state.setup) {
      executeSqliteQuerySync(
        writeDatabase.db,
        kysely.insertInto("workspace_setup_state").values({
          ...state.setup,
          workspace_key: current.workspaceKey,
          workspace_path: current.workspacePath,
        }),
      );
      executeSqliteQuerySync(
        writeDatabase.db,
        kysely
          .updateTable("workspace_generated_bootstrap_hashes")
          .set({ workspace_key: current.workspaceKey })
          .where("workspace_key", "=", stored.workspaceKey),
      );
      executeSqliteQuerySync(
        writeDatabase.db,
        kysely.deleteFrom("workspace_setup_state").where("workspace_key", "=", stored.workspaceKey),
      );
    }
    executeSqliteQuerySync(
      writeDatabase.db,
      kysely.deleteFrom("workspace_path_aliases").where("workspace_key", "=", stored.workspaceKey),
    );
    registerWorkspaceStateAliasIdentitiesInTransaction({
      database: writeDatabase,
      aliases: filesystem.aliases,
      identity: current,
      updatedAtMs: Date.now(),
    });
    deferSqlitePostCommitPublication(writeDatabase.db, () => {
      retireWorkspaceFileCache(stored.workspacePath);
      retireWorkspaceFileCache(current.workspacePath);
    });
    return "rebound";
  }, options);
}
