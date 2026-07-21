// Doctor migration for the shipped custom-store SQLite path owned by legacy main.
import fs from "node:fs";
import path from "node:path";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { closeOpenClawAgentDatabaseByPath } from "../../../state/openclaw-agent-db.js";

const LEGACY_IMPLICIT_AGENT_ID = "main";
const SQLITE_FILE_SUFFIXES = ["-wal", "-shm", "-journal", ""] as const;

type PlannedMove = { sourcePath: string; targetPath: string };

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function planSqliteFileSetMove(sourcePath: string, targetPath: string): PlannedMove[] {
  return SQLITE_FILE_SUFFIXES.flatMap((suffix) => {
    const sourceFile = `${sourcePath}${suffix}`;
    return pathExists(sourceFile)
      ? [{ sourcePath: sourceFile, targetPath: `${targetPath}${suffix}` }]
      : [];
  });
}

function moveSqliteFileSet(moves: PlannedMove[]): void {
  const completed: PlannedMove[] = [];
  try {
    for (const move of moves) {
      fs.renameSync(move.sourcePath, move.targetPath);
      completed.push(move);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const move of completed.toReversed()) {
      try {
        fs.renameSync(move.targetPath, move.sourcePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Failed to migrate legacy main session SQLite files and rollback cleanly: ${rollbackErrors.map(String).join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function maybeMigrateLegacyMainSessionSqlite(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ changes: string[]; warnings: string[] }> {
  const hasMain = (cfg.agents?.list ?? []).some(
    (agent) => normalizeAgentId(agent.id) === LEGACY_IMPLICIT_AGENT_ID,
  );
  if (!hasMain) {
    return { changes: [], warnings: [] };
  }
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: LEGACY_IMPLICIT_AGENT_ID,
    env,
  });
  const legacyPath = resolveSqliteTargetFromSessionStorePath(storePath).path;
  const rosterPath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: LEGACY_IMPLICIT_AGENT_ID,
  }).path;
  if (legacyPath === rosterPath || !pathExists(legacyPath)) {
    return { changes: [], warnings: [] };
  }

  const collisionPath = SQLITE_FILE_SUFFIXES.map((suffix) => `${rosterPath}${suffix}`).find(
    pathExists,
  );
  if (collisionPath) {
    return {
      changes: [],
      warnings: [
        `Skipped legacy main session SQLite migration because the roster target already exists: ${collisionPath}`,
      ],
    };
  }

  closeOpenClawAgentDatabaseByPath(legacyPath);
  const moves = planSqliteFileSetMove(legacyPath, rosterPath);
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  moveSqliteFileSet(moves);
  return {
    changes: [`Migrated legacy main session SQLite store to ${rosterPath}.`],
    warnings: [],
  };
}
