import path from "node:path";
import { sql } from "kysely";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { listRegistryWorktreesForMigration } from "../../agents/worktrees/registry.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { resolveProjectRegistry } from "../../projects/project-registry.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { patchSessionEntryCore } from "./session-accessor.js";
import { parseReadableSqliteSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveLegacyCanonicalWorkspace(params: {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  env: NodeJS.ProcessEnv;
  sessionKey: string;
  worktrees: ReturnType<typeof listRegistryWorktreesForMigration>;
}): string | undefined {
  const worktree = params.entry.worktree;
  if (!worktree || worktree.canonicalWorkspaceDir) {
    return undefined;
  }
  const recordedRepoRoot = path.resolve(worktree.repoRoot);
  if (params.entry.projectId) {
    const project = resolveProjectRegistry(params.cfg, params.entry.projectId, { env: params.env });
    const projectRoot = project ? path.resolve(project.repoRoot) : undefined;
    return projectRoot && isInside(recordedRepoRoot, projectRoot) ? projectRoot : undefined;
  }
  const record = params.worktrees.find((candidate) => candidate.id === worktree.id);
  const spawnedCwd = params.entry.spawnedCwd;
  if (
    record?.ownerKind === "session" &&
    record.ownerId === params.sessionKey &&
    spawnedCwd &&
    path.resolve(record.repoRoot) === path.resolve(worktree.repoRoot)
  ) {
    const relative = path.relative(path.resolve(record.path), path.resolve(spawnedCwd));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return path.resolve(recordedRepoRoot, relative);
    }
  }
  const agentWorkspace = path.resolve(
    resolveAgentWorkspaceDir(params.cfg, params.agentId, params.env),
  );
  return agentWorkspace && agentWorkspace === recordedRepoRoot ? agentWorkspace : undefined;
}

function listLegacyWorktreeSessionEntries(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  storePath: string;
}): Array<{ databasePath: string; entry: SessionEntry; sessionKey: string }> {
  const resolved = resolveSqliteScope({ ...params, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .selectAll()
        .where(
          /* kysely-allow-raw: Startup migration targets the retired JSON shape without materializing every session. */
          sql<boolean>`session_nodes.entry_valid != 1 OR (
            json_valid(session_nodes.entry_json)
            AND json_type(session_nodes.entry_json, '$.worktree') = 'object'
            AND (
              json_type(session_nodes.entry_json, '$.worktree.canonicalWorkspaceDir') IS NULL
              OR json_extract(session_nodes.entry_json, '$.worktree.canonicalWorkspaceDir') = ''
            )
          )`,
        )
        .orderBy("session_key", "asc"),
    ).rows;
    return rows.flatMap((row) => {
      const entry = parseReadableSqliteSessionEntryRow(database, row);
      return entry ? [{ databasePath: database.path, entry, sessionKey: row.session_key }] : [];
    });
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

export async function migrateManagedWorktreeCanonicalWorkspaces(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  storePath: string;
}): Promise<number> {
  const env = params.env ?? process.env;
  const worktrees = listRegistryWorktreesForMigration(env);
  let migrated = 0;
  for (const { databasePath, entry, sessionKey } of listLegacyWorktreeSessionEntries({
    agentId: params.agentId,
    env,
    storePath: params.storePath,
  })) {
    // Select the workspace by logical owner, but keep writes in the source database:
    // resolving a custom store selector for another agent can choose a sibling partition.
    const agentId = resolveAgentIdFromSessionKey(sessionKey, params.agentId);
    const canonicalWorkspaceDir = resolveLegacyCanonicalWorkspace({
      agentId,
      cfg: params.cfg,
      entry,
      env,
      sessionKey,
      worktrees,
    });
    if (!canonicalWorkspaceDir) {
      continue;
    }
    const updated = await patchSessionEntryCore(
      { agentId, env, sessionKey, storePath: databasePath },
      (current) => {
        if (
          !current.worktree ||
          current.worktree.id !== entry.worktree?.id ||
          current.worktree.canonicalWorkspaceDir
        ) {
          return null;
        }
        return {
          worktree: { ...current.worktree, canonicalWorkspaceDir },
        };
      },
      { preserveActivity: true, skipMaintenance: true },
    );
    if (updated?.worktree?.canonicalWorkspaceDir === canonicalWorkspaceDir) {
      migrated += 1;
    }
  }
  return migrated;
}
