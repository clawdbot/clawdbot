import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import {
  collectSqliteSchemaIssues,
  type SqliteSchemaIssue,
} from "../infra/sqlite-schema-contract.js";
import {
  describeRunningOpenClawBuild,
  readSqliteUserVersion,
  SqliteSchemaVersionError,
} from "../infra/sqlite-user-version.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import type { OpenClawSchemaVersions } from "./openclaw-schema-versions.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import {
  assertOpenClawStateDatabaseOwner,
  assertOpenClawStateDatabaseForMaintenance,
} from "./openclaw-state-db-maintenance.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";
import {
  inspectOpenClawStateOwnershipFromDatabase,
  type OpenClawExternalStateOwnership,
} from "./openclaw-state-ownership.js";
import {
  getOpenClawStateRuntimeSchema,
  isOpenClawStateFirstUseSchemaIssue,
  isOpenClawStateStartupRepairableSchemaIssue,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "./openclaw-state-db.js";

export type IncompatibleOpenClawDatabase = {
  kind: "agent" | "state";
  path: string;
  agentId?: string;
  foundVersion: number;
  supportedVersion: number;
  writerAppVersion?: string;
};

export type IndeterminateOpenClawDatabase = {
  kind: "agent" | "state";
  path: string;
  reason: string;
};

export type OpenClawDatabaseSchemaPreflight = {
  incompatible: IncompatibleOpenClawDatabase[];
  indeterminate: IndeterminateOpenClawDatabase[];
};

type OpenClawStateSchemaPreflightResult = {
  databasePath: string;
  foundVersion: number | null;
  issues: SqliteSchemaIssue[];
  ownership: OpenClawExternalStateOwnership | null;
  reason?: string;
  requiresWrite: boolean;
  schema: "openclaw.state-schema-preflight.v1";
  status: "exact" | "startup-repairable" | "migration-required" | "incompatible" | "indeterminate";
  targetVersion: number;
};

type AgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

type OpenClawDatabaseSchemaPreflightOperation = "doctor" | "gateway-restart" | "gateway-startup";

function formatDoctorIncompatibleDatabase(database: IncompatibleOpenClawDatabase): string {
  const agent = database.agentId ? ` for agent ${database.agentId}` : "";
  const writer = database.writerAppVersion ? `; writer build ${database.writerAppVersion}` : "";
  return `${database.kind} database${agent} ${database.path} uses schema ${database.foundVersion}; this build supports ${database.supportedVersion}${writer}.`;
}

/** Fatal refusal when persisted schemas were written by a newer build. */
export class OpenClawDatabaseSchemaPreflightError extends SqliteSchemaVersionError {
  constructor(
    readonly incompatibleDatabases: readonly IncompatibleOpenClawDatabase[],
    options: { operation?: OpenClawDatabaseSchemaPreflightOperation } = {},
  ) {
    const operation = options.operation ?? "gateway-startup";
    const prefix =
      operation === "doctor"
        ? "Doctor refused to continue"
        : operation === "gateway-restart"
          ? "Gateway refused restart"
          : "Gateway refused startup";
    const doctorGuidance =
      operation === "doctor"
        ? ` ${incompatibleDatabases.map(formatDoctorIncompatibleDatabase).join(" ")} Run Doctor with the OpenClaw install that wrote this state (typically the active Gateway install), or another build that supports these schemas.`
        : "";
    super(
      `${prefix} because ${incompatibleDatabases.length} OpenClaw database schema(s) are newer than this build. ` +
        `Refused by ${describeRunningOpenClawBuild()}.${doctorGuidance} See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
    );
    this.name = "OpenClawDatabaseSchemaPreflightError";
  }
}

/** Verify persisted runtime schemas before certifying repair or accepting restart. */
export async function assertOpenClawDatabasesReady(
  options: {
    env: NodeJS.ProcessEnv;
  } & (
    | {
        operation: "doctor";
        configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
      }
    | { operation: "gateway-restart" }
  ),
): Promise<void> {
  const schemas = await preflightOpenClawDatabaseSchemas({
    env: options.env,
    supportedVersions: {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    verifyCurrentSchemaShape: true,
    ...(options.operation === "doctor"
      ? { configuredAgentDatabaseTargets: options.configuredAgentDatabaseTargets }
      : {}),
  });
  if (schemas.incompatible.length > 0) {
    throw new OpenClawDatabaseSchemaPreflightError(schemas.incompatible, {
      operation: options.operation,
    });
  }
  if (schemas.indeterminate.length === 0) {
    return;
  }
  const shown = schemas.indeterminate
    .slice(0, 3)
    .map((database) => `${database.kind} ${database.path}: ${database.reason}`);
  const omitted = schemas.indeterminate.length - shown.length;
  const action =
    options.operation === "doctor" ? "Doctor could not complete repair" : "Gateway refused restart";
  throw new Error(
    `${action} because persisted database readiness could not be verified: ${shown.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}. Stop the Gateway and other OpenClaw processes, run openclaw doctor --fix, then retry.`,
  );
}

function readWriterAppVersion(database: DatabaseSync): string | undefined {
  try {
    const row = database
      .prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
      .get() as { app_version?: unknown } | undefined;
    return typeof row?.app_version === "string" && row.app_version.length > 0
      ? row.app_version
      : undefined;
  } catch {
    return undefined;
  }
}

function readRegisteredAgentDatabases(
  database: DatabaseSync,
  registryPath: string,
): Array<{
  agentId: string;
  path: string;
}> {
  const table = database
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'agent_databases'")
    .get();
  if (!table) {
    return [];
  }
  const db = getNodeSqliteKysely<AgentRegistryDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_databases").select(["agent_id", "path"]),
  ).rows.flatMap((row) =>
    typeof row.agent_id === "string" && typeof row.path === "string"
      ? [
          {
            agentId: row.agent_id,
            path: resolveOpenClawRegisteredAgentDatabasePath(registryPath, row.path),
          },
        ]
      : [],
  );
}

function deduplicateSchemaIssues(issues: readonly SqliteSchemaIssue[]): SqliteSchemaIssue[] {
  return [
    ...new Map(
      issues.map((issue) => [`${issue.code}\0${issue.objectName}`, issue] as const),
    ).values(),
  ];
}

/** Compare one explicit SQLite file with this release's canonical shared-state schema. */
export async function preflightOpenClawStateDatabasePath(
  databasePath: string,
): Promise<OpenClawStateSchemaPreflightResult> {
  const resolvedPath = path.resolve(databasePath);
  const base = {
    schema: "openclaw.state-schema-preflight.v1",
    databasePath: resolvedPath,
    targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
  } as const;
  let database: DatabaseSync | undefined;
  let foundVersion: number | null = null;
  let ownership: OpenClawExternalStateOwnership | null = null;
  const result = (
    status: OpenClawStateSchemaPreflightResult["status"],
    details: { issues?: SqliteSchemaIssue[]; reason?: string; requiresWrite?: boolean } = {},
  ): OpenClawStateSchemaPreflightResult => ({
    ...base,
    foundVersion,
    ownership,
    issues: details.issues ?? [],
    status,
    requiresWrite: details.requiresWrite ?? false,
    ...(details.reason ? { reason: details.reason } : {}),
  });
  try {
    const inspectionPath = realpathSync.native(resolvedPath);
    const sidecars = ["-wal", "-shm", "-journal"].filter((suffix) =>
      existsSync(`${inspectionPath}${suffix}`),
    );
    if (sidecars.length > 0) {
      throw new Error(
        `SQLite preflight requires a consolidated snapshot with no sidecars; found ${sidecars.join(", ")}. Create a WAL-aware online backup and preflight the resulting standalone file.`,
      );
    }
    database = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(inspectionPath), {
      readOnly: true,
    });
    database.exec(
      `PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`,
    );
    assertSqliteIntegrity(database, resolvedPath);
    foundVersion = readSqliteUserVersion(database);
    if (!Number.isSafeInteger(foundVersion) || foundVersion < 0) {
      throw new Error(
        `OpenClaw state database ${resolvedPath} has invalid schema version metadata.`,
      );
    }
    if (foundVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
      try {
        ownership = inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
      } catch {
        // A newer release can own a newer metadata contract; the numeric refusal remains decisive.
      }
      return result("incompatible");
    }
    ownership = inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
    if (foundVersion < OPENCLAW_STATE_SCHEMA_VERSION) {
      return result("migration-required", { requiresWrite: true });
    }
    assertOpenClawStateDatabaseOwner(database, { pathname: resolvedPath });
    const metadata = database
      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
      .get() as { schema_version?: unknown } | undefined;
    if (metadata?.schema_version !== foundVersion) {
      throw new Error(
        `OpenClaw state database ${resolvedPath} metadata schema version ${typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid"} does not match ${foundVersion}.`,
      );
    }
    const maintenanceIssues = collectSqliteSchemaIssues(
      database,
      OPENCLAW_STATE_SCHEMA_SQL,
      OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
    );
    const blockingIssues = maintenanceIssues.filter(
      (issue) =>
        !isOpenClawStateStartupRepairableSchemaIssue(issue) &&
        !isOpenClawStateFirstUseSchemaIssue(issue),
    );
    if (blockingIssues.length > 0) {
      return result("incompatible", { issues: deduplicateSchemaIssues(blockingIssues) });
    }
    const projectedRuntimeIssues = collectSqliteSchemaIssues(
      database,
      getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
    );
    const projectedRuntimeBlockingIssues = projectedRuntimeIssues.filter(
      (issue) =>
        !isOpenClawStateStartupRepairableSchemaIssue(issue) &&
        !isOpenClawStateFirstUseSchemaIssue(issue),
    );
    if (projectedRuntimeBlockingIssues.length > 0) {
      return result("incompatible", {
        issues: deduplicateSchemaIssues(projectedRuntimeBlockingIssues),
      });
    }
    const startupRepairableIssues = deduplicateSchemaIssues([
      ...maintenanceIssues.filter(isOpenClawStateStartupRepairableSchemaIssue),
      ...projectedRuntimeIssues.filter(isOpenClawStateStartupRepairableSchemaIssue),
    ]);
    return result(startupRepairableIssues.length > 0 ? "startup-repairable" : "exact", {
      issues: startupRepairableIssues,
      requiresWrite: startupRepairableIssues.length > 0,
    });
  } catch (error) {
    return result("indeterminate", { reason: formatErrorMessage(error) });
  } finally {
    database?.close();
  }
}

/** Read schema headers and optionally verify current schema shape without repairing it. */
export async function preflightOpenClawDatabaseSchemas(options: {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  supportedVersions: OpenClawSchemaVersions;
  verifyCurrentSchemaShape?: boolean;
  configuredAgentDatabaseTargets?:
    | readonly { agentId: string; path: string }[]
    | ((
        registeredDatabases: readonly { agentId: string; path: string }[],
      ) => readonly { agentId: string; path: string }[]);
  configuredAgentDatabaseCandidatePaths?: readonly string[];
}): Promise<OpenClawDatabaseSchemaPreflight> {
  options.signal?.throwIfAborted();
  const result: OpenClawDatabaseSchemaPreflight = { incompatible: [], indeterminate: [] };
  const statePath = path.resolve(resolveOpenClawStateSqlitePath(options.env));
  let registeredDatabases: ReturnType<typeof readRegisteredAgentDatabases> = [];
  let stateDatabase: DatabaseSync | undefined;
  let stateSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
  try {
    if (existsSync(statePath)) {
      // Even a read-only source connection can create WAL/SHM. The copy worker
      // preserves source artifacts and cannot release this process's writer locks.
      stateSnapshot = await prepareSqliteReadOnlyLocation(realpathSync.native(statePath), {
        preserveSourceArtifacts: true,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      stateDatabase = openNodeSqliteDatabase(stateSnapshot.location, {
        readOnly: true,
      });
      stateDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      const stateVersion = readSqliteUserVersion(stateDatabase);
      if (stateVersion > options.supportedVersions.state) {
        const writerAppVersion = readWriterAppVersion(stateDatabase);
        result.incompatible.push({
          kind: "state",
          path: statePath,
          foundVersion: stateVersion,
          supportedVersion: options.supportedVersions.state,
          ...(writerAppVersion ? { writerAppVersion } : {}),
        });
      }
      if (
        options.verifyCurrentSchemaShape === true &&
        stateVersion === OPENCLAW_STATE_SCHEMA_VERSION
      ) {
        try {
          assertOpenClawStateDatabaseForMaintenance(stateDatabase, { pathname: statePath });
        } catch (error) {
          result.indeterminate.push({
            kind: "state",
            path: statePath,
            reason: formatErrorMessage(error),
          });
        }
      }

      try {
        registeredDatabases = readRegisteredAgentDatabases(stateDatabase, statePath);
      } catch (error) {
        result.indeterminate.push({
          kind: "state",
          path: statePath,
          reason: `agent database registry query failed: ${formatErrorMessage(error)}`,
        });
        return result;
      }
    }
  } catch (error) {
    // Accepted stop must not turn cancellation or failed cleanup into a
    // warn-and-continue result that launches the remaining startup runtime.
    if (options.signal?.aborted) {
      throw error;
    }
    result.indeterminate.push({
      kind: "state",
      path: statePath,
      reason: formatErrorMessage(error),
    });
    return result;
  } finally {
    try {
      if (stateDatabase) {
        clearNodeSqliteKyselyCacheForDatabase(stateDatabase);
        stateDatabase.close();
      }
    } finally {
      stateSnapshot?.cleanup();
    }
  }
  let agentTargets = registeredDatabases;
  if (options.configuredAgentDatabaseTargets !== undefined) {
    // Doctor must resolve configured paths from these read-only facts: the
    // runtime registry reader rejects the very legacy schema Doctor repairs.
    const configuredTargets =
      typeof options.configuredAgentDatabaseTargets === "function"
        ? options.configuredAgentDatabaseTargets(registeredDatabases)
        : options.configuredAgentDatabaseTargets;
    const discovery = discoverAgentDatabaseMigrationTargets({
      env: options.env,
      configuredAgentDatabaseTargets: configuredTargets,
      registeredAgentDatabases: registeredDatabases,
    });
    agentTargets = discovery.targets;
    for (const failure of discovery.failures) {
      result.indeterminate.push({ kind: "agent", ...failure });
    }
  }
  // An occupied custom-store candidate can have a newer, unreadable owner.
  // Check its version without promoting it into an owned migration target.
  const inspectionTargets: Array<{ agentId?: string; path: string }> = [
    ...agentTargets,
    ...(options.configuredAgentDatabaseCandidatePaths ?? []).map((candidatePath) => ({
      path: candidatePath,
    })),
  ];
  const inspectedAgentPaths = new Set<string>();
  for (const row of inspectionTargets) {
    const agentPath = row.path;
    if (!existsSync(agentPath)) {
      continue;
    }
    let agentDatabase: DatabaseSync | undefined;
    let agentSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
    try {
      // Preserve SQLite's filesystem traversal through symlink/.. locators.
      const realAgentPath = realpathSync.native(agentPath);
      if (row.agentId === undefined && inspectedAgentPaths.has(realAgentPath)) {
        continue;
      }
      inspectedAgentPaths.add(realAgentPath);
      agentSnapshot = await prepareSqliteReadOnlyLocation(realAgentPath, {
        preserveSourceArtifacts: true,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      agentDatabase = openNodeSqliteDatabase(agentSnapshot.location, {
        readOnly: true,
      });
      agentDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      const agentVersion = readSqliteUserVersion(agentDatabase);
      if (agentVersion <= options.supportedVersions.agent) {
        if (options.verifyCurrentSchemaShape === true && row.agentId !== undefined) {
          // Existing agent databases require Doctor-owned migration before
          // startup; a successor cannot safely repair them after close.
          assertOpenClawAgentDatabaseForMaintenance(agentDatabase, {
            agentId: row.agentId,
            pathname: agentPath,
          });
        }
        continue;
      }
      const writerAppVersion = readWriterAppVersion(agentDatabase);
      result.incompatible.push({
        kind: "agent",
        path: agentPath,
        ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
        foundVersion: agentVersion,
        supportedVersion: options.supportedVersions.agent,
        ...(writerAppVersion ? { writerAppVersion } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      result.indeterminate.push({
        kind: "agent",
        path: agentPath,
        reason: formatErrorMessage(error),
      });
    } finally {
      try {
        agentDatabase?.close();
      } finally {
        agentSnapshot?.cleanup();
      }
    }
  }
  return result;
}
