import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "./home-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { resolveUpdateCandidateStatePath } from "./update-candidate-paths.js";

const UpdateStateSchemaVersionsSchema = z.array(
  z.object({
    path: z.string(),
    userVersion: z.number().nullable(),
    contentVersion: z.number().optional(),
  }),
);
export type UpdateStateSchemaVersion = z.infer<typeof UpdateStateSchemaVersionsSchema>[number];
export const UpdateCandidateStateSnapshotSchema = z.object({
  versions: UpdateStateSchemaVersionsSchema,
  pluginPaths: z.record(z.string(), z.string()),
});
type StateInput = { stateDir: string; config: OpenClawConfig; env?: NodeJS.ProcessEnv };
type CandidateStateDatabase = Pick<
  DB,
  "agent_databases" | "agent_database_leases" | "state_leases"
>;

/** Older inspection workers report only the published version; agent stores never defer it. */
export function resolveUpdateStateContentVersion(entry: UpdateStateSchemaVersion): number | null {
  return entry.contentVersion ?? entry.userVersion;
}

export function updateStateSchemaVersionsMatch(
  before: readonly UpdateStateSchemaVersion[],
  after: readonly UpdateStateSchemaVersion[],
  params: { sharedPath: string; candidateSchemaVersions?: OpenClawSchemaVersions },
): boolean {
  const versions = new Map(
    after.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
  );
  const candidate = params.candidateSchemaVersions;
  if (!candidate) {
    return (
      before.length === after.length &&
      before.every((entry) => versions.get(entry.path) === resolveUpdateStateContentVersion(entry))
    );
  }
  const baseline = new Map(
    before.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
  );
  return (
    before.every(
      (entry) =>
        resolveUpdateStateContentVersion(entry) === null ||
        versions.get(entry.path) === resolveUpdateStateContentVersion(entry),
    ) &&
    after.every((entry) => {
      const version = resolveUpdateStateContentVersion(entry);
      if (version === null || baseline.get(entry.path) === version) {
        return true;
      }
      // Verification can create a store for the first time. All collected paths
      // except the shared database are configured or registered agent stores.
      const supported = entry.path === params.sharedPath ? candidate.state : candidate.agent;
      return baseline.get(entry.path) == null && version === supported;
    })
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

function collectRegisteredPaths(db: DatabaseSync, shared: string, files: string[]) {
  const rows = tableExists(db, "agent_databases")
    ? executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<CandidateStateDatabase>(db)
          .selectFrom("agent_databases")
          .select("path")
          .orderBy("path"),
      ).rows
    : [];
  return rows.map(({ path: stored }) => {
    const source = resolveOpenClawRegisteredAgentDatabasePath(shared, stored);
    // Discover registrations from the exact private generation being inspected.
    if (!files.includes(source)) {
      files.push(source);
    }
    return { stored, source };
  });
}

async function withStateDatabaseSnapshot<T>(
  file: string,
  read: (location: string) => T | Promise<T>,
): Promise<T> {
  // The sync snapshot never attaches SQLite to the live family. Production runs
  // in our dedicated child so filesystem closes cannot release updater locks.
  const snapshot = prepareSqliteReadOnlyLocationSyncInProcess(file);
  try {
    return await read(snapshot.location);
  } finally {
    snapshot.cleanup();
  }
}

async function collectStateDatabasePaths(input: StateInput): Promise<string[]> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const files = new Set([shared]);
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

/** Missing databases stay explicit so creation is schema-checked and loss blocks rollback. */
export async function readUpdateStateSchemaVersionsInProcess(
  input: StateInput,
): Promise<UpdateStateSchemaVersion[]> {
  const versions: UpdateStateSchemaVersion[] = [];
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const files = await collectStateDatabasePaths(input);
  for (const file of files) {
    versions.push({
      path: file,
      ...((await fileExists(file))
        ? await withStateDatabaseSnapshot(file, (location) => {
            const db = openNodeSqliteDatabase(location, { readOnly: true });
            try {
              if (file === shared) {
                collectRegisteredPaths(db, shared, files);
              }
              return {
                userVersion: readSqliteUserVersion(db),
                ...(file === shared ? { contentVersion: readStateSchemaContentVersion(db) } : {}),
              };
            } finally {
              db.close();
            }
          })
        : { userVersion: null }),
    });
  }
  return versions;
}

/** Schema fencing reads private copies in a child under a fixed inspection deadline. */
export async function readUpdateStateSchemaVersions({
  root,
  nodeRunner = process.execPath,
  ...input
}: StateInput & {
  // Omit only before activation; null forbids falling back after an uncertain swap.
  root?: string | null;
  nodeRunner?: string;
}): Promise<UpdateStateSchemaVersion[]> {
  if (root === null) {
    throw new Error("The active installation root is unknown; state inspection is unsafe.");
  }
  const sourceEnv = input.env ?? process.env;
  const result = await runCommandBuffered(
    [
      nodeRunner,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl({ ...runtimeProcessEntrypoints.updateCandidateState, root }),
        nodeRunner,
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
  return UpdateStateSchemaVersionsSchema.parse(JSON.parse(result.stdout.toString("utf8")));
}

/** Keep snapshot dependencies out of schema inspection; rebind registry paths to private copies. */
export async function snapshotUpdateCandidateState(
  input: StateInput & { targetStateDir: string; candidateRoot: string },
): Promise<z.infer<typeof UpdateCandidateStateSnapshotSchema>> {
  const { createVerifiedSqliteSnapshot } = await import("./sqlite-snapshot.js");
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
    let contentVersion: number | undefined;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const snapshot = await withStateDatabaseSnapshot(file, (sourcePath) =>
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath: target,
        ...(file === shared
          ? {
              transform: (db: DatabaseSync) => {
                contentVersion = readStateSchemaContentVersion(db);
                const queries = getNodeSqliteKysely<CandidateStateDatabase>(db);
                // Source process leases cannot own the independently opened rehearsal copy.
                for (const table of ["agent_database_leases", "state_leases"] as const) {
                  if (tableExists(db, table)) {
                    executeSqliteQuerySync(db, queries.deleteFrom(table));
                  }
                }
                for (const { stored, source } of collectRegisteredPaths(db, shared, files)) {
                  const rebound = targetPath(source);
                  const reboundStored = path.relative(input.targetStateDir, rebound);
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
      }),
    );
    versions.push({
      path: file,
      userVersion: snapshot.userVersion,
      ...(contentVersion === undefined ? {} : { contentVersion }),
    });
  }
  const { projectUpdateCandidatePlugins } = await import("./update-candidate-plugins.js");
  const pluginPaths = await projectUpdateCandidatePlugins(input);
  return { versions, pluginPaths };
}
