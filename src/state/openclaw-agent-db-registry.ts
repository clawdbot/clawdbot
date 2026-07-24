import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawRegisteredAgentDatabase,
} from "./openclaw-agent-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  detectOpenClawStateDatabaseSchemaMigrations,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

type AgentDatabasePathIdentity = {
  lexicalPath: string;
  realPath?: string;
  device?: bigint | number;
  inode?: bigint | number;
  parentDevice?: bigint | number;
  parentInode?: bigint | number;
  parentRealPath?: string;
  unresolvedSuffix?: string;
};

const parentCaseSemanticsCache = new Map<string, boolean>();

function swapFirstAsciiLetterCase(value: string): string | undefined {
  const index = value.search(/[A-Za-z]/u);
  if (index < 0) {
    return undefined;
  }
  const letter = value[index]!;
  const swapped = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
  return `${value.slice(0, index)}${swapped}${value.slice(index + 1)}`;
}

function areAsciiCaseVariants(left: string | undefined, right: string | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    /^[\x00-\x7F]*$/u.test(left) &&
    /^[\x00-\x7F]*$/u.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function isParentFilesystemCaseInsensitive(params: {
  device: bigint | number;
  inode: bigint | number;
  realPath: string;
}): boolean | undefined {
  const cacheKey = `${params.device}:${params.inode}:${params.realPath}`;
  const cached = parentCaseSemanticsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let entries: string[];
  try {
    entries = readdirSync(params.realPath);
  } catch {
    return undefined;
  }
  const entryNames = new Set(entries);
  for (const entry of entries) {
    const alternateName = swapFirstAsciiLetterCase(entry);
    if (!alternateName) {
      continue;
    }
    const entryPath = path.join(params.realPath, entry);
    const alternatePath = path.join(params.realPath, alternateName);
    if (entryNames.has(alternateName)) {
      // Both spellings are distinct directory entries. Even if hard-linked, the
      // directory itself is case-sensitive and missing leaves must stay distinct.
      parentCaseSemanticsCache.set(cacheKey, false);
      return false;
    }
    let entryStat: ReturnType<typeof lstatSync>;
    try {
      entryStat = lstatSync(entryPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    try {
      const alternateStat = lstatSync(alternatePath, { bigint: true });
      const caseInsensitive =
        alternateStat.dev === entryStat.dev && alternateStat.ino === entryStat.ino;
      parentCaseSemanticsCache.set(cacheKey, caseInsensitive);
      return caseInsensitive;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      parentCaseSemanticsCache.set(cacheKey, false);
      return false;
    }
  }

  // Empty directories offer no existing spelling to probe. Use an atomic,
  // process-owned leaf and remove it immediately; failure to probe stays unknown.
  const probeName = `.openclaw-case-probe-${randomUUID()}`;
  const alternateProbeName = swapFirstAsciiLetterCase(probeName);
  if (!alternateProbeName) {
    return undefined;
  }
  const probePath = path.join(params.realPath, probeName);
  const alternateProbePath = path.join(params.realPath, alternateProbeName);
  let created = false;
  try {
    const descriptor = openSync(probePath, "wx", 0o600);
    created = true;
    closeSync(descriptor);
    const probeStat = lstatSync(probePath, { bigint: true });
    try {
      const alternateStat = lstatSync(alternateProbePath, { bigint: true });
      const caseInsensitive =
        alternateStat.dev === probeStat.dev && alternateStat.ino === probeStat.ino;
      parentCaseSemanticsCache.set(cacheKey, caseInsensitive);
      return caseInsensitive;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      parentCaseSemanticsCache.set(cacheKey, false);
      return false;
    }
  } catch {
    return undefined;
  } finally {
    if (created) {
      try {
        unlinkSync(probePath);
      } catch {
        // Best-effort cleanup of the process-owned probe; comparison already failed closed.
      }
    }
  }
}

function resolveCanonicalPathFromExistingParent(lexicalPath: string): {
  realPath: string;
  parentDevice: bigint;
  parentInode: bigint;
  parentRealPath: string;
  unresolvedSuffix: string;
} {
  const missingSegments: string[] = [];
  let current = lexicalPath;
  while (true) {
    try {
      const stat = statSync(current, { bigint: true });
      const parentRealPath = realpathSync.native(current);
      return {
        realPath: path.join(parentRealPath, ...missingSegments),
        parentDevice: stat.dev,
        parentInode: stat.ino,
        parentRealPath,
        unresolvedSuffix: missingSegments.join(path.sep),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot resolve an existing parent for ${lexicalPath}.`);
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
}

function resolveDanglingSymlinkTargetPath(lexicalPath: string): string {
  let resolved = path.parse(lexicalPath).root;
  const remaining = lexicalPath.slice(resolved.length).split(path.sep).filter(Boolean);
  const visitedStates = new Set<string>();
  while (remaining.length > 0) {
    const segment = remaining.shift();
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    try {
      const stat = lstatSync(candidate);
      if (!stat.isSymbolicLink()) {
        resolved = candidate;
        continue;
      }
      const stateKey = `${candidate}\0${remaining.join(path.sep)}`;
      if (visitedStates.has(stateKey)) {
        const error = new Error(
          `Symlink loop while resolving ${lexicalPath}.`,
        ) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedStates.add(stateKey);
      const target = readlinkSync(candidate);
      if (path.isAbsolute(target)) {
        resolved = path.parse(target).root;
        remaining.unshift(...target.slice(resolved.length).split(path.sep));
      } else {
        // Process raw target components in order: normalizing `..` here would skip
        // filesystem resolution of a preceding symlink and could change ownership.
        remaining.unshift(...target.split(path.sep));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return path.join(resolved, segment, ...remaining);
      }
      throw error;
    }
  }
  return resolved;
}

function resolveAgentDatabasePathIdentity(pathname: string): AgentDatabasePathIdentity {
  const lexicalPath = path.resolve(pathname);
  try {
    const stat = statSync(lexicalPath, { bigint: true });
    return {
      lexicalPath,
      realPath: realpathSync.native(lexicalPath),
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Preserve symlink/alias identity before the leaf exists by canonicalizing its nearest parent.
    const parentIdentity = resolveCanonicalPathFromExistingParent(
      resolveDanglingSymlinkTargetPath(lexicalPath),
    );
    return {
      lexicalPath,
      ...parentIdentity,
    };
  }
}

/** Compare two database locators by canonical filesystem identity when available. */
export function isSameOpenClawAgentDatabasePath(left: string, right: string): boolean {
  const leftIdentity = resolveAgentDatabasePathIdentity(left);
  const rightIdentity = resolveAgentDatabasePathIdentity(right);
  if (leftIdentity.lexicalPath === rightIdentity.lexicalPath) {
    return true;
  }
  if (leftIdentity.realPath && leftIdentity.realPath === rightIdentity.realPath) {
    return true;
  }
  const parentDevice = leftIdentity.parentDevice;
  const parentInode = leftIdentity.parentInode;
  const sameMissingParent =
    parentDevice !== undefined &&
    parentInode !== undefined &&
    parentDevice === rightIdentity.parentDevice &&
    parentInode === rightIdentity.parentInode;
  const sameMissingSuffix =
    leftIdentity.unresolvedSuffix === rightIdentity.unresolvedSuffix ||
    (sameMissingParent &&
      parentDevice !== undefined &&
      parentInode !== undefined &&
      leftIdentity.parentRealPath !== undefined &&
      areAsciiCaseVariants(leftIdentity.unresolvedSuffix, rightIdentity.unresolvedSuffix) &&
      isParentFilesystemCaseInsensitive({
        device: parentDevice,
        inode: parentInode,
        realPath: leftIdentity.parentRealPath,
      }) === true);
  return (
    (leftIdentity.device !== undefined &&
      leftIdentity.inode !== undefined &&
      leftIdentity.device === rightIdentity.device &&
      leftIdentity.inode === rightIdentity.inode) ||
    (sameMissingParent && sameMissingSuffix)
  );
}

export function registerOpenClawAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId: params.agentId, path: params.path },
    { env: params.env },
  );
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(params.path).size;
  } catch {
    sizeBytes = null;
  }
  const lastSeenAt = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      assertAgentDeletionPathFence(database.db, deletionFence);
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_databases")
          .values({
            agent_id: params.agentId,
            path: params.path,
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
            last_seen_at: lastSeenAt,
            size_bytes: sizeBytes,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "path"]).doUpdateSet({
              schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
              last_seen_at: lastSeenAt,
              size_bytes: sizeBytes,
            }),
          ),
      );
    },
    { env: params.env },
  );
}

export function unregisterOpenClawAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("agent_databases")
          .where("agent_id", "=", params.agentId)
          .where("path", "=", params.path),
      );
    },
    { env: params.env },
  );
}

function hasUnavailableMissingSqlitePath(pathname: string): boolean {
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
  }

  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return !stat.isDirectory();
      }
      try {
        return !statSync(ancestor).isDirectory();
      } catch {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

/** List agent databases recorded in the shared OpenClaw state registry. */
export function listOpenClawRegisteredAgentDatabases(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawRegisteredAgentDatabase[] {
  const pathname = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!existsSync(pathname)) {
    if (hasUnavailableMissingSqlitePath(pathname)) {
      throw new Error(`OpenClaw state database ${pathname} is unavailable.`);
    }
    return [];
  }
  if (detectOpenClawStateDatabaseSchemaMigrations(options).length > 0) {
    throw new Error(
      `OpenClaw state database ${pathname} has a legacy agent database registry schema; run openclaw doctor --fix to migrate it.`,
    );
  }

  const database = openNodeSqliteDatabase(pathname, {
    readOnly: true,
  });
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    if (readSqliteUserVersion(database) > OPENCLAW_STATE_SCHEMA_VERSION) {
      throw new Error(
        `OpenClaw state database ${pathname} uses a newer schema than this OpenClaw build.`,
      );
    }
    const registryTable = database
      .prepare("SELECT type FROM sqlite_master WHERE name = 'agent_databases'")
      .get() as { type?: unknown } | undefined;
    if (!registryTable) {
      return [];
    }
    if (registryTable.type !== "table") {
      throw new Error(`OpenClaw state database ${pathname} has an invalid agent registry.`);
    }
    const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("agent_databases")
        .selectAll()
        .orderBy("agent_id", "asc")
        .orderBy("path", "asc"),
    ).rows;
    return rows.map((row) => ({
      agentId: normalizeAgentId(row.agent_id),
      path: row.path,
      schemaVersion: row.schema_version,
      lastSeenAt: row.last_seen_at,
      sizeBytes: row.size_bytes,
    }));
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}
