import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "./home-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";

export type UpdateStateSchemaVersion = { path: string; userVersion: number | null };
type StateInput = { stateDir: string; config: OpenClawConfig; env?: NodeJS.ProcessEnv };
type Registry = Pick<DB, "agent_databases">;

export function updateStateSchemaVersionsMatch(
  before: readonly UpdateStateSchemaVersion[],
  after: readonly UpdateStateSchemaVersion[],
): boolean {
  const versions = new Map(after.map((entry) => [entry.path, entry.userVersion]));
  return (
    before.length === after.length &&
    before.every((entry) => versions.get(entry.path) === entry.userVersion)
  );
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function registeredPaths(db: DatabaseSync): string[] {
  return tableExists(db, "agent_databases")
    ? executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Registry>(db).selectFrom("agent_databases").select("path"),
      ).rows.map((row) => row.path)
    : [];
}

async function inspectDatabase<T>(file: string, read: (db: DatabaseSync) => T): Promise<T> {
  // Production callers run in the dedicated child, so closing this handle cannot
  // release SQLite locks held by the updater's ledger connection.
  const db = openNodeSqliteDatabase(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

async function collectStateDatabasePaths(input: StateInput): Promise<string[]> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const files = new Set([shared]);
  if (await fileExists(shared)) {
    for (const stored of await inspectDatabase(shared, registeredPaths)) {
      files.add(resolveOpenClawRegisteredAgentDatabasePath(shared, stored));
    }
  }
  let directories: string[] = [];
  try {
    directories = (await fs.readdir(path.join(input.stateDir, "agents"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  const configured = Object.entries(input.config.agents?.entries ?? {});
  for (const directory of [input.env?.OPENCLAW_AGENT_DIR, input.env?.PI_CODING_AGENT_DIR]) {
    if (directory?.trim()) {
      files.add(path.join(resolveUserPath(directory, input.env), "openclaw-agent.sqlite"));
    }
  }
  const projected = (input.config.agents?.list ?? []).map((agent) => [agent.id, agent] as const);
  for (const [id, agent] of [...configured, ...projected]) {
    directories.push(id);
    if (agent.agentDir) {
      files.add(path.join(resolveUserPath(agent.agentDir, input.env), "openclaw-agent.sqlite"));
    }
  }
  for (const id of new Set(["main", ...directories])) {
    files.add(path.resolve(input.stateDir, "agents", id, "agent", "openclaw-agent.sqlite"));
  }
  return [...files].toSorted();
}

/** Missing databases stay explicit so creation or loss cannot authorize rollback. */
export async function readUpdateStateSchemaVersionsInProcess(
  input: StateInput,
): Promise<UpdateStateSchemaVersion[]> {
  const versions: UpdateStateSchemaVersion[] = [];
  for (const file of await collectStateDatabasePaths(input)) {
    versions.push({
      path: file,
      userVersion: (await fileExists(file))
        ? await inspectDatabase(file, readSqliteUserVersion)
        : null,
    });
  }
  return versions;
}

/** Schema fencing reads only headers/registry in a child, never full database copies during downtime. */
export async function readUpdateStateSchemaVersions(
  input: StateInput,
): Promise<UpdateStateSchemaVersion[]> {
  const sourceEnv = input.env ?? process.env;
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    {
      cwd: os.tmpdir(),
      input: JSON.stringify({
        ...input,
        mode: "versions",
        env: {
          HOME: sourceEnv.HOME,
          OPENCLAW_HOME: sourceEnv.OPENCLAW_HOME,
          USERPROFILE: sourceEnv.USERPROFILE,
          OPENCLAW_AGENT_DIR: sourceEnv.OPENCLAW_AGENT_DIR,
          PI_CODING_AGENT_DIR: sourceEnv.PI_CODING_AGENT_DIR,
        },
      }),
      baseEnv: sourceEnv,
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `State schema inspection failed (${result.termination}): ${result.stderr.toString("utf8")}`,
    );
  }
  return z
    .array(z.object({ path: z.string(), userVersion: z.number().nullable() }))
    .parse(JSON.parse(result.stdout.toString("utf8")));
}

/** Shared with config projection so custom agent directories use their copied database. */
export function resolveUpdateCandidateStatePath(
  sourceRoot: string,
  targetRoot: string,
  source: string,
): string {
  // Registered link/../ locators can identify a different inode from their
  // normalized spelling; flattening them would overwrite another copied database.
  const relative =
    path.normalize(source) === source && isPathInside(sourceRoot, source)
      ? path.relative(sourceRoot, source)
      : path.join("candidate-external", createHash("sha256").update(source).digest("hex"));
  return path.join(targetRoot, relative);
}

/** Every registry path is rebound, including supported registrations outside the state directory. */
export async function snapshotUpdateCandidateState(
  input: StateInput & { targetStateDir: string },
): Promise<UpdateStateSchemaVersion[]> {
  const sourceRoot = path.resolve(input.stateDir);
  const shared = path.join(sourceRoot, "state", "openclaw.sqlite");
  const targetPath = (source: string) =>
    path.join(
      resolveUpdateCandidateStatePath(sourceRoot, input.targetStateDir, path.dirname(source)),
      path.basename(source),
    );
  const versions: UpdateStateSchemaVersion[] = [];
  const files = await collectStateDatabasePaths(input);
  for (const file of files) {
    if (!(await fileExists(file))) {
      versions.push({ path: file, userVersion: null });
      continue;
    }
    const target = targetPath(file);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const snapshot = await createVerifiedSqliteSnapshot({
      sourcePath: await fs.realpath(file),
      targetPath: target,
      ...(file === shared
        ? {
            transform: (db: DatabaseSync) => {
              for (const stored of registeredPaths(db)) {
                const source = resolveOpenClawRegisteredAgentDatabasePath(shared, stored);
                // The serving Gateway may register an agent between discovery and
                // this snapshot; include the exact registry generation we copied.
                if (!files.includes(source)) {
                  files.push(source);
                }
                const rebound = targetPath(source);
                const reboundStored = path.relative(input.targetStateDir, rebound);
                const queries = getNodeSqliteKysely<Registry>(db);
                if (
                  stored !== reboundStored &&
                  source === resolveOpenClawRegisteredAgentDatabasePath(shared, reboundStored)
                ) {
                  // A legacy absolute/relative pair names exactly the same source.
                  // Collapse only that duplicate in the copy before its unique-key update.
                  executeSqliteQuerySync(
                    db,
                    queries
                      .deleteFrom("agent_databases")
                      .where("path", "=", stored)
                      .where(
                        "agent_id",
                        "in",
                        queries
                          .selectFrom("agent_databases")
                          .select("agent_id")
                          .where("path", "=", reboundStored),
                      ),
                  );
                }
                executeSqliteQuerySync(
                  db,
                  queries
                    .updateTable("agent_databases")
                    .set({ path: reboundStored })
                    .where("path", "=", stored),
                );
              }
            },
          }
        : {}),
    });
    versions.push({ path: file, userVersion: snapshot.userVersion });
  }
  return versions;
}
