import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
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
import { isPersistentOpenClawAgentDatabasePath } from "./openclaw-agent-db-registry.js";
import {
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import type { OpenClawSchemaVersions } from "./openclaw-schema-versions.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import {
  assertOpenClawStateDatabaseOwner,
  assertOpenClawStateDatabaseForMaintenance,
  openClawStateMigrationAssertions,
} from "./openclaw-state-db-maintenance.js";
import { assertCanonicalStateSchemaShape } from "./openclaw-state-db-schema-repair.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
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
import { readStateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";
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

export type DeferredStateSchemaPublication = {
  kind: "state";
  path: string;
  foundVersion: number;
  contentVersion: number;
  runId?: string;
  publishAfterMs?: number | null;
  message: string;
};

function describeDeferredStateSchemaPublication(
  database: DatabaseSync,
  databasePath: string,
  foundVersion: number,
  contentVersion: number,
): DeferredStateSchemaPublication {
  const blocker = readStateSchemaPublicationBlocker(database);
  return {
    kind: "state",
    path: databasePath,
    foundVersion,
    contentVersion,
    ...(blocker ? { runId: blocker.runId, publishAfterMs: blocker.publishAfterMs } : {}),
    message: blocker
      ? `Schema content applied; version publication deferred until update run ${blocker.runId} finishes and its five-minute grace expires (or the running driver is abandoned for 30 minutes).`
      : "Schema content applied; version publication will complete on the next writable database open.",
  };
}

export type OpenClawDatabaseSchemaPreflight = {
  incompatible: IncompatibleOpenClawDatabase[];
  indeterminate: IndeterminateOpenClawDatabase[];
  pendingMigrations?: Omit<IncompatibleOpenClawDatabase, "writerAppVersion">[];
  deferredSchemaPublications?: DeferredStateSchemaPublication[];
};

type OpenClawStateSchemaPreflightResult = {
  databasePath: string;
  foundVersion: number | null;
  contentVersion?: number;
  deferredPublication?: DeferredStateSchemaPublication;
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
        onDeferredSchemaPublication?: (publication: DeferredStateSchemaPublication) => void;
      }
    | { operation: "gateway-restart" }
    | { operation: "gateway-startup"; config: OpenClawConfig }
  ),
): Promise<void> {
  const schemas = await preflightOpenClawDatabaseSchemas({
    env: options.env,
    supportedVersions: {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    verifyCurrentSchemaShape: true,
    ...(options.operation === "gateway-startup"
      ? {
          requireStartupMigrationReadiness: true,
          // Inspect candidate owners from preserved snapshots: runtime target
          // resolution opens custom stores directly and can create WAL sidecars.
          configuredAgentDatabaseTargets: [],
          configuredAgentDatabaseCandidatePaths: resolveConfiguredAgentDatabaseCandidatePaths(
            options.config,
            { env: options.env },
          ),
        }
      : {}),
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
    if (options.operation === "doctor") {
      for (const publication of schemas.deferredSchemaPublications ?? []) {
        options.onDeferredSchemaPublication?.(publication);
      }
    }
    return;
  }
  const shown = schemas.indeterminate
    .slice(0, 3)
    .map((database) => `${database.kind} ${database.path}: ${database.reason}`);
  const omitted = schemas.indeterminate.length - shown.length;
  const action =
    options.operation === "doctor"
      ? "Doctor could not complete repair"
      : options.operation === "gateway-startup"
        ? "Gateway refused startup"
        : "Gateway refused restart";
  throw new Error(
    `${action} because persisted database readiness could not be verified: ${shown.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}. ${options.operation === "doctor" ? "Stop OpenClaw processes, then restore the affected database from a verified backup." : "Stop the Gateway and other OpenClaw processes, run openclaw doctor --fix, then retry."}`,
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

function inspectCurrentStateStartupSchema(
  database: DatabaseSync,
  databasePath: string,
  foundVersion: number,
) {
  assertOpenClawStateDatabaseOwner(database, { pathname: databasePath });
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== foundVersion) {
    throw new Error(
      `OpenClaw state database ${databasePath} metadata schema version ${typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid"} does not match ${foundVersion}.`,
    );
  }
  const issues = deduplicateSchemaIssues([
    ...collectSqliteSchemaIssues(
      database,
      OPENCLAW_STATE_SCHEMA_SQL,
      OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
    ),
    ...collectSqliteSchemaIssues(
      database,
      getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
    ),
  ]);
  return {
    blockingIssues: issues.filter(
      (issue) =>
        !isOpenClawStateStartupRepairableSchemaIssue(issue) &&
        !isOpenClawStateFirstUseSchemaIssue(issue),
    ),
    startupRepairableIssues: issues.filter(isOpenClawStateStartupRepairableSchemaIssue),
  };
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
  let contentVersion: number | undefined;
  let deferredPublication: DeferredStateSchemaPublication | undefined;
  let ownership: OpenClawExternalStateOwnership | null = null;
  const result = (
    status: OpenClawStateSchemaPreflightResult["status"],
    details: { issues?: SqliteSchemaIssue[]; reason?: string; requiresWrite?: boolean } = {},
  ): OpenClawStateSchemaPreflightResult => ({
    ...base,
    foundVersion,
    ...(contentVersion !== undefined && contentVersion !== foundVersion ? { contentVersion } : {}),
    ...(deferredPublication ? { deferredPublication } : {}),
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
    contentVersion =
      foundVersion > OPENCLAW_STATE_SCHEMA_VERSION
        ? foundVersion
        : readStateSchemaContentVersion(database);
    if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
      try {
        ownership = inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
      } catch {
        // A newer release can own a newer metadata contract; the numeric refusal remains decisive.
      }
      return result("incompatible");
    }
    ownership = inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
    if (contentVersion < OPENCLAW_STATE_SCHEMA_VERSION) {
      return result("migration-required", { requiresWrite: true });
    }
    if (foundVersion < contentVersion) {
      deferredPublication = describeDeferredStateSchemaPublication(
        database,
        resolvedPath,
        foundVersion,
        contentVersion,
      );
    }
    const { blockingIssues, startupRepairableIssues } = inspectCurrentStateStartupSchema(
      database,
      resolvedPath,
      foundVersion,
    );
    if (blockingIssues.length > 0) {
      return result("incompatible", { issues: blockingIssues });
    }
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
  scope?: "state";
  signal?: AbortSignal;
  supportedVersions: OpenClawSchemaVersions;
  verifyCurrentSchemaShape?: boolean;
  requireStartupMigrationReadiness?: boolean;
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
  const inspectCandidatePresence = (
    databasePath: string,
  ): { status: "present" | "absent" } | { status: "indeterminate"; reason: string } => {
    try {
      statSync(databasePath);
      return { status: "present" };
    } catch (error) {
      return hasNodeErrorCode(error, "ENOENT")
        ? { status: "absent" }
        : { status: "indeterminate", reason: formatErrorMessage(error) };
    }
  };
  const statePresence = inspectCandidatePresence(statePath);
  if (statePresence.status === "indeterminate") {
    result.indeterminate.push({ kind: "state", path: statePath, reason: statePresence.reason });
    return result;
  }
  try {
    if (statePresence.status === "present") {
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
      const contentVersion =
        stateVersion > options.supportedVersions.state
          ? stateVersion
          : readStateSchemaContentVersion(stateDatabase);
      if (contentVersion < options.supportedVersions.state) {
        (result.pendingMigrations ??= []).push({
          kind: "state",
          path: statePath,
          foundVersion: stateVersion,
          supportedVersion: options.supportedVersions.state,
        });
      }
      if (contentVersion > options.supportedVersions.state) {
        const writerAppVersion = readWriterAppVersion(stateDatabase);
        result.incompatible.push({
          kind: "state",
          path: statePath,
          foundVersion: contentVersion,
          supportedVersion: options.supportedVersions.state,
          ...(writerAppVersion ? { writerAppVersion } : {}),
        });
      }
      if (stateVersion < contentVersion) {
        (result.deferredSchemaPublications ??= []).push(
          describeDeferredStateSchemaPublication(
            stateDatabase,
            statePath,
            stateVersion,
            contentVersion,
          ),
        );
      }
      if (
        options.requireStartupMigrationReadiness &&
        contentVersion <= OPENCLAW_STATE_SCHEMA_VERSION
      ) {
        assertSqliteIntegrity(stateDatabase, statePath);
        assertCanonicalStateSchemaShape(stateDatabase, statePath);
        if (contentVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          const { blockingIssues } = inspectCurrentStateStartupSchema(
            stateDatabase,
            statePath,
            stateVersion,
          );
          if (blockingIssues.length > 0) {
            throw new Error(
              `OpenClaw state database ${statePath} requires repair: ${blockingIssues.map((issue) => issue.message).join("; ")}; run openclaw doctor --fix.`,
            );
          }
        } else {
          openClawStateMigrationAssertions.get(contentVersion)?.(stateDatabase, {
            pathname: statePath,
          });
        }
      } else if (
        options.verifyCurrentSchemaShape === true &&
        contentVersion === OPENCLAW_STATE_SCHEMA_VERSION
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

      if (options.scope === "state") {
        return result;
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
    if (options.signal?.aborted || options.requireStartupMigrationReadiness) {
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
  if (options.scope === "state") {
    return result;
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
    // Migration discovery intentionally declines ownership of foreign registry
    // paths. Preflight remains read-only, so preserve their downgrade guard.
    ...(options.configuredAgentDatabaseTargets !== undefined
      ? registeredDatabases.filter((database) =>
          isPersistentOpenClawAgentDatabasePath(database.path, options.env),
        )
      : []),
    ...(options.configuredAgentDatabaseCandidatePaths ?? []).map((candidatePath) => ({
      agentId: options.requireStartupMigrationReadiness
        ? resolveUnsuffixedSqliteTargetFromSessionStorePath(candidatePath).agentId
        : undefined,
      path: candidatePath,
    })),
  ];
  const inspectedAgentPaths = new Set<string>();
  const inspectedAgentTargets = new Set<string>();
  for (const row of inspectionTargets) {
    const agentPath = row.path;
    const presence = inspectCandidatePresence(agentPath);
    if (presence.status === "absent") {
      continue;
    }
    if (presence.status === "indeterminate") {
      result.indeterminate.push({ kind: "agent", path: agentPath, reason: presence.reason });
      continue;
    }
    let agentDatabase: DatabaseSync | undefined;
    let agentSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
    try {
      // Preserve SQLite's filesystem traversal through symlink/.. locators.
      const realAgentPath = realpathSync.native(agentPath);
      const inspectionKey = `${realAgentPath}\0${row.agentId ?? ""}`;
      if (
        inspectedAgentTargets.has(inspectionKey) ||
        (row.agentId === undefined && inspectedAgentPaths.has(realAgentPath))
      ) {
        continue;
      }
      inspectedAgentPaths.add(realAgentPath);
      inspectedAgentTargets.add(inspectionKey);
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
      if (agentVersion < options.supportedVersions.agent) {
        (result.pendingMigrations ??= []).push({
          kind: "agent",
          path: agentPath,
          ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
          foundVersion: agentVersion,
          supportedVersion: options.supportedVersions.agent,
        });
      }
      if (agentVersion <= options.supportedVersions.agent) {
        if (options.requireStartupMigrationReadiness) {
          assertSqliteIntegrity(agentDatabase, agentPath);
          assertCanonicalAgentPersistenceVersion(agentDatabase, agentPath, agentVersion);
        }
        const agentId =
          row.agentId ??
          (options.requireStartupMigrationReadiness
            ? readExistingAgentSchemaMeta(agentDatabase)?.agentId
            : undefined);
        if (
          options.verifyCurrentSchemaShape === true &&
          agentId != null &&
          (!options.requireStartupMigrationReadiness || agentVersion > 0)
        ) {
          assertOpenClawAgentDatabaseForMaintenance(agentDatabase, {
            agentId,
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
      if (options.signal?.aborted || options.requireStartupMigrationReadiness) {
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
