// Hidden operator contract for isolated agent-database upgrade rehearsals.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, resolveAgentConfig, resolveAgentDir } from "../agents/agent-scope.js";
import { createConfigIO } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  isPerAgentSessionStoreConfig,
  listConfiguredSessionStoreAgentIds,
} from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { findOpenClawAgentDatabaseMediaMigrationRequiredError } from "../state/openclaw-agent-db-migration-required.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  listOpenClawRegisteredAgentDatabases,
  replaceOpenClawAgentDatabaseRegistryForRehearsal,
} from "../state/openclaw-agent-db-registry.js";
import {
  hasOpenClawAgentApplicationSchema,
  readExistingAgentSchemaMeta,
} from "../state/openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  migrateOpenClawAgentDatabaseForMaintenance,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";

const REHEARSAL_SCHEMA_VERSION = 1;
const REHEARSAL_MAX_AGENT_DATABASES = 256;
const REHEARSAL_MAX_INVENTORY_REFERENCES = 2048;

type PluginPersistenceDeclaration = {
  pluginId: string;
  kind: string;
  copiedPath: string | null;
  reason?: string;
};

type AgentDatabaseRequest = {
  agentId: string;
  copiedPath: string;
  creation: "existing" | "fresh";
};

type InventoryRequest = {
  schemaVersion: 1;
  mode: "inventory";
  stateRoot: string;
  configPath: string;
};

type RehearsalRequestBase = {
  schemaVersion: 1;
  privateStateRoot: string;
  agents: AgentDatabaseRequest[];
  pluginPersistence: PluginPersistenceDeclaration[];
};

type RehearsalRequest = RehearsalRequestBase & ({ mode: "migrate" } | { mode: "read-only" });

type ParsedRequest = InventoryRequest | RehearsalRequest;

type DatabaseSnapshot = {
  userVersion: number;
  metadataSchemaVersion: number | null;
  role: string | null;
  ownerAgentId: string | null;
};

type PreparedAgentDatabase = {
  agentId: string;
  creation: "existing" | "fresh";
  requestedPath: string;
  resolvedPath: string;
  realPath: string;
  before: DatabaseSnapshot;
};

type InventoryReference = {
  agentId: string;
  path: string;
  claimKind: "agent-dir-database" | "session-store-database" | "session-store-fixed-family";
  ownerClaim:
    | "configured-agent-dir"
    | "default-agent-dir"
    | "configured-session-store"
    | "default-session-store";
};

export class AgentDatabaseRehearsalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly unsupportedPluginPersistence?: readonly PluginPersistenceDeclaration[],
  ) {
    super(message);
    this.name = "AgentDatabaseRehearsalError";
  }
}

function fail(code: string, message: string): never {
  throw new AgentDatabaseRehearsalError(code, message);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid-request", `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function parsePluginPersistence(value: unknown): PluginPersistenceDeclaration[] {
  if (!Array.isArray(value)) {
    fail("invalid-request", "pluginPersistence must be an array.");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      fail("invalid-request", `pluginPersistence[${index}] must be an object.`);
    }
    const copiedPath = entry.copiedPath;
    if (copiedPath !== null && (typeof copiedPath !== "string" || !copiedPath.trim())) {
      fail("invalid-request", `pluginPersistence[${index}].copiedPath must be a string or null.`);
    }
    const reason = entry.reason;
    if (reason !== undefined && (typeof reason !== "string" || !reason.trim())) {
      fail("invalid-request", `pluginPersistence[${index}].reason must be a non-empty string.`);
    }
    return {
      pluginId: requiredString(entry, "pluginId"),
      kind: requiredString(entry, "kind"),
      copiedPath: copiedPath === null ? null : copiedPath.trim(),
      ...(typeof reason === "string" ? { reason: reason.trim() } : {}),
    };
  });
}

function parseRequest(value: unknown): ParsedRequest {
  if (!isRecord(value)) {
    fail("invalid-request", "request must be a JSON object.");
  }
  if (value.schemaVersion !== REHEARSAL_SCHEMA_VERSION) {
    fail("unsupported-request-version", "schemaVersion must be 1.");
  }
  const mode = value.mode;
  if (mode === "inventory") {
    return {
      schemaVersion: 1,
      mode,
      stateRoot: requiredString(value, "stateRoot"),
      configPath: requiredString(value, "configPath"),
    };
  }
  if (mode !== "migrate" && mode !== "read-only") {
    fail("invalid-request", "mode must be inventory, migrate, or read-only.");
  }
  if (!Array.isArray(value.agents)) {
    fail("invalid-request", "agents must be an array.");
  }
  if (value.agents.length > REHEARSAL_MAX_AGENT_DATABASES) {
    fail(
      "agent-limit-exceeded",
      `agents exceeds the ${REHEARSAL_MAX_AGENT_DATABASES}-entry limit.`,
    );
  }
  const agents: AgentDatabaseRequest[] = value.agents.map((entry, index) => {
    if (!isRecord(entry)) {
      fail("invalid-request", `agents[${index}] must be an object.`);
    }
    const creation = entry.creation;
    if (creation !== "existing" && creation !== "fresh") {
      fail("invalid-request", `agents[${index}].creation must be existing or fresh.`);
    }
    return {
      agentId: normalizeAgentId(requiredString(entry, "agentId")),
      copiedPath: requiredString(entry, "copiedPath"),
      creation,
    };
  });
  return {
    schemaVersion: 1,
    mode,
    privateStateRoot: requiredString(value, "privateStateRoot"),
    agents,
    pluginPersistence: parsePluginPersistence(value.pluginPersistence),
  };
}

function requireAbsoluteDirectory(
  rawPath: string,
  field: string,
): { resolved: string; real: string } {
  if (!path.isAbsolute(rawPath)) {
    fail("path-not-absolute", `${field} must be absolute.`);
  }
  const resolved = path.resolve(rawPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    fail("path-unavailable", `${field} is unavailable: ${formatErrorMessage(error)}`);
  }
  if (!stat.isDirectory()) {
    fail("path-not-directory", `${field} must be an existing directory.`);
  }
  return { resolved, real: fs.realpathSync.native(resolved) };
}

function requireAbsoluteConfigPath(rawPath: string): string {
  if (!path.isAbsolute(rawPath)) {
    fail("path-not-absolute", "configPath must be absolute.");
  }
  const resolved = path.resolve(rawPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    fail("config-unavailable", `configPath is unavailable: ${formatErrorMessage(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail("config-unavailable", "configPath must be a regular non-symlink file.");
  }
  return resolved;
}

function assertPathInsideRoot(root: string, candidate: string, label: string): void {
  if (candidate !== root && !isPathInside(root, candidate)) {
    fail("path-escape", `${label} must remain inside the private state root.`);
  }
}

function realpathExistingAncestor(pathname: string, label: string): string {
  let current = path.resolve(pathname);
  while (true) {
    try {
      return fs.realpathSync.native(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail("path-unavailable", `${label} is unavailable: ${formatErrorMessage(error)}`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        fail("path-unavailable", `${label} has no existing ancestor.`);
      }
      current = parent;
    }
  }
}

function assertPrivateDatabaseFamily(params: {
  root: string;
  pathname: string;
  requireMain: boolean;
  label: string;
}): string {
  const resolved = path.resolve(params.pathname);
  assertPathInsideRoot(params.root, resolved, params.label);
  const parentReal = realpathExistingAncestor(path.dirname(resolved), `${params.label} parent`);
  assertPathInsideRoot(params.root, parentReal, `${params.label} parent`);
  let mainReal: string | undefined;
  for (const candidate of resolveSqliteDatabaseFilePaths(resolved)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      fail("path-unavailable", `${params.label} is unavailable: ${formatErrorMessage(error)}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      fail(
        "path-not-private",
        `${params.label} and its SQLite sidecars must be private regular files without symlink or hardlink aliases.`,
      );
    }
    const real = fs.realpathSync.native(candidate);
    assertPathInsideRoot(params.root, real, params.label);
    if (candidate === resolved) {
      mainReal = real;
    }
  }
  if (params.requireMain && !mainReal) {
    fail("database-missing", `${params.label} must be an existing SQLite file.`);
  }
  return mainReal ?? resolved;
}

function inspectDatabaseSnapshot(pathname: string): DatabaseSnapshot {
  if (!fs.existsSync(pathname)) {
    return {
      userVersion: 0,
      metadataSchemaVersion: null,
      role: null,
      ownerAgentId: null,
    };
  }
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    const metadata = readExistingAgentSchemaMeta(database);
    return {
      userVersion: readSqliteUserVersion(database),
      metadataSchemaVersion: metadata?.schemaVersion ?? null,
      role: metadata?.role ?? null,
      ownerAgentId: metadata?.agentId ?? null,
    };
  } finally {
    database.close();
  }
}

function hasApplicationSchema(pathname: string): boolean {
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return hasOpenClawAgentApplicationSchema(database);
  } finally {
    database.close();
  }
}

function prepareAgentDatabases(
  request: RehearsalRequest,
  root: { resolved: string; real: string },
): PreparedAgentDatabase[] {
  const seen = new Set<string>();
  return request.agents.map((entry, index) => {
    if (!path.isAbsolute(entry.copiedPath)) {
      fail("path-not-absolute", `agents[${index}].copiedPath must be absolute.`);
    }
    const requestedPath = path.resolve(entry.copiedPath);
    assertPathInsideRoot(root.resolved, requestedPath, `agents[${index}].copiedPath`);
    const realPath = assertPrivateDatabaseFamily({
      root: root.real,
      pathname: fs.realpathSync.native(requestedPath),
      requireMain: true,
      label: `agents[${index}].copiedPath`,
    });
    const compositeKey = `${entry.agentId}\0${realPath}`;
    if (seen.has(compositeKey)) {
      fail(
        "duplicate-agent-database",
        `agents[${index}] duplicates ${entry.agentId} at ${realPath}.`,
      );
    }
    seen.add(compositeKey);
    const before = inspectDatabaseSnapshot(realPath);
    const ownerMatches =
      before.role === "agent" &&
      before.ownerAgentId !== null &&
      normalizeAgentId(before.ownerAgentId) === entry.agentId;
    if (request.mode === "migrate" && entry.creation === "fresh") {
      if (
        before.userVersion !== 0 ||
        before.metadataSchemaVersion !== null ||
        before.role !== null ||
        before.ownerAgentId !== null ||
        hasApplicationSchema(realPath)
      ) {
        fail(
          "fresh-database-not-empty",
          `agents[${index}] is marked fresh but already contains application schema or ownership.`,
        );
      }
    } else if (!ownerMatches) {
      fail(
        "agent-owner-mismatch",
        `agents[${index}] must be owned by agent ${entry.agentId} for ${request.mode} mode.`,
      );
    }
    return {
      agentId: entry.agentId,
      creation: entry.creation,
      requestedPath,
      resolvedPath: requestedPath,
      realPath,
      before,
    };
  });
}

function compareRegistryExact(
  expected: readonly { agentId: string; path: string; schemaVersion: number }[],
  actual: readonly { agentId: string; path: string; schemaVersion: number }[],
): void {
  const key = (entry: { agentId: string; path: string; schemaVersion: number }) =>
    `${normalizeAgentId(entry.agentId)}\0${path.resolve(entry.path)}\0${entry.schemaVersion}`;
  const expectedKeys = expected.map(key).toSorted();
  const actualKeys = actual.map(key).toSorted();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((entry, index) => entry !== actualKeys[index])
  ) {
    fail(
      "registry-mismatch",
      "private agent database registry does not exactly match the manifest.",
    );
  }
}

function referenceKey(reference: InventoryReference): string {
  return [reference.agentId, reference.path, reference.claimKind, reference.ownerClaim].join("\0");
}

async function runInventory(request: InventoryRequest) {
  const root = requireAbsoluteDirectory(request.stateRoot, "stateRoot");
  const configPath = requireAbsoluteConfigPath(request.configPath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: root.real,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const io = createConfigIO({
    configPath,
    env,
    logger: { error: () => undefined, warn: () => undefined },
    observe: false,
    pluginValidation: "skip",
    shellEnvFallback: "defer",
  });
  const snapshot = await io.readConfigFileSnapshot();
  if (!snapshot.valid) {
    fail("config-invalid", "configPath could not be resolved as a valid effective config.");
  }
  const config = snapshot.runtimeConfig;
  const references = new Map<string, InventoryReference>();
  const addReference = (reference: InventoryReference) => {
    references.set(referenceKey(reference), reference);
    if (references.size > REHEARSAL_MAX_INVENTORY_REFERENCES) {
      fail(
        "inventory-limit-exceeded",
        `inventory exceeds the ${REHEARSAL_MAX_INVENTORY_REFERENCES}-reference limit.`,
      );
    }
  };
  for (const agentId of listAgentIds(config)) {
    const normalizedAgentId = normalizeAgentId(agentId);
    const configuredAgentDir = Boolean(
      resolveAgentConfig(config, normalizedAgentId)?.agentDir?.trim(),
    );
    const agentDir = resolveAgentDir(config, normalizedAgentId, env);
    addReference({
      agentId: normalizedAgentId,
      path: path.resolve(agentDir, "openclaw-agent.sqlite"),
      claimKind: "agent-dir-database",
      ownerClaim: configuredAgentDir ? "configured-agent-dir" : "default-agent-dir",
    });
  }
  const storeConfig = config.session?.store;
  const configuredSessionStore = Boolean(storeConfig?.trim());
  for (const agentId of listConfiguredSessionStoreAgentIds(config)) {
    const normalizedAgentId = normalizeAgentId(agentId);
    const storePath = resolveSessionStorePathCore(storeConfig, {
      agentId: normalizedAgentId,
      env,
    });
    const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
    addReference({
      agentId: normalizedAgentId,
      path: path.resolve(target.path),
      claimKind:
        isPerAgentSessionStoreConfig(storeConfig) || path.resolve(storePath).endsWith(".sqlite")
          ? "session-store-database"
          : "session-store-fixed-family",
      ownerClaim: configuredSessionStore ? "configured-session-store" : "default-session-store",
    });
  }
  const pluginPersistence: PluginPersistenceDeclaration[] =
    config.plugins?.enabled === false
      ? []
      : [
          {
            pluginId: "*",
            kind: "indeterminate",
            copiedPath: null,
            reason: "enabled plugin persistence has no manifest declaration surface",
          },
        ];
  return {
    schemaVersion: 1 as const,
    ok: true as const,
    mode: "inventory" as const,
    runtimeVersion: VERSION,
    stateRoot: root.resolved,
    configPath,
    references: [...references.values()].toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) ||
        left.path.localeCompare(right.path) ||
        left.claimKind.localeCompare(right.claimKind),
    ),
    pluginPersistence,
    complete: pluginPersistence.length === 0,
  };
}

async function runReadOnly(
  request: RehearsalRequest & { mode: "read-only" },
  root: { resolved: string; real: string },
  agents: PreparedAgentDatabase[],
  env: NodeJS.ProcessEnv,
) {
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  const stateBefore = inspectDatabaseSnapshot(sharedPath);
  const state = await openExistingOpenClawStateDatabaseReadOnly({ env });
  if (!state) {
    fail("shared-state-missing", "private shared state database is missing.");
  }
  try {
    const results = agents.map((agent) => {
      const result = withOpenClawAgentDatabaseReadOnly(
        (database) => inspectDatabaseSnapshot(database.path),
        { agentId: agent.agentId, env, path: agent.realPath },
      );
      if (!result.found) {
        fail(
          "agent-database-unreadable",
          `${agent.agentId} at ${agent.realPath} is unavailable (${result.reason}).`,
        );
      }
      return {
        ...agent,
        after: result.value,
        migrated: false,
        registry: {
          path: agent.realPath,
          schemaVersion: result.value.userVersion,
        },
      };
    });
    const registry = listOpenClawRegisteredAgentDatabases({
      env,
      includeIncompatibleSchemaVersions: true,
    });
    compareRegistryExact(
      results.map((result) => ({
        agentId: result.agentId,
        path: result.realPath,
        schemaVersion: result.after.userVersion,
      })),
      registry,
    );
    const stateAfter = inspectDatabaseSnapshot(sharedPath);
    return {
      schemaVersion: 1 as const,
      ok: true as const,
      mode: request.mode,
      runtimeVersion: VERSION,
      privateStateRoot: root.resolved,
      sharedState: {
        path: path.join(root.resolved, "state", "openclaw.sqlite"),
        schemaVersionBefore: stateBefore.userVersion,
        schemaVersionAfter: stateAfter.userVersion,
        role: stateAfter.role,
        readOnly: true,
      },
      agents: results,
      pluginPersistence: request.pluginPersistence,
    };
  } finally {
    state.walMaintenance.close();
  }
}

function runMigrate(
  request: RehearsalRequest & { mode: "migrate" },
  root: { resolved: string; real: string },
  agents: PreparedAgentDatabase[],
  env: NodeJS.ProcessEnv,
) {
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  assertPrivateDatabaseFamily({
    root: root.real,
    pathname: sharedPath,
    requireMain: false,
    label: "private shared state database",
  });
  const stateBefore = inspectDatabaseSnapshot(sharedPath);
  const openedPaths = new Set<string>();
  const state = openOpenClawStateDatabase({ env });
  try {
    const results = agents.map((agent) => {
      try {
        try {
          openOpenClawAgentDatabase({ agentId: agent.agentId, env, path: agent.realPath });
        } catch (error) {
          if (!findOpenClawAgentDatabaseMediaMigrationRequiredError(error)) {
            throw error;
          }
          migrateOpenClawAgentDatabaseForMaintenance({
            agentId: agent.agentId,
            env,
            pathname: agent.realPath,
          });
          openOpenClawAgentDatabase({ agentId: agent.agentId, env, path: agent.realPath });
        }
        openedPaths.add(agent.realPath);
        const after = inspectDatabaseSnapshot(agent.realPath);
        return {
          ...agent,
          after,
          migrated:
            agent.before.userVersion !== after.userVersion ||
            agent.before.metadataSchemaVersion !== after.metadataSchemaVersion,
          registry: { path: agent.realPath, schemaVersion: after.userVersion },
        };
      } finally {
        closeOpenClawAgentDatabaseByPath(agent.realPath);
        openedPaths.delete(agent.realPath);
      }
    });
    const expectedRegistry = results.map((result) => ({
      agentId: result.agentId,
      path: result.realPath,
      schemaVersion: result.after.userVersion,
    }));
    replaceOpenClawAgentDatabaseRegistryForRehearsal({ entries: expectedRegistry, env });
    const registry = listOpenClawRegisteredAgentDatabases({
      env,
      includeIncompatibleSchemaVersions: true,
    });
    compareRegistryExact(expectedRegistry, registry);
    const stateAfter = inspectDatabaseSnapshot(sharedPath);
    return {
      schemaVersion: 1 as const,
      ok: true as const,
      mode: request.mode,
      runtimeVersion: VERSION,
      privateStateRoot: root.resolved,
      sharedState: {
        path: path.join(root.resolved, "state", "openclaw.sqlite"),
        schemaVersionBefore: stateBefore.userVersion,
        schemaVersionAfter: stateAfter.userVersion,
        role: stateAfter.role,
        readOnly: false,
      },
      agents: results,
      pluginPersistence: request.pluginPersistence,
    };
  } finally {
    for (const pathname of openedPaths) {
      closeOpenClawAgentDatabaseByPath(pathname);
    }
    closeOpenClawStateDatabaseByPath(state.path);
  }
}

export async function runAgentDatabaseRehearsal(requestValue: unknown) {
  const request = parseRequest(requestValue);
  if (request.mode === "inventory") {
    return await runInventory(request);
  }
  // Unsupported plugin state must stop before any writable shared or agent open.
  if (request.pluginPersistence.length > 0) {
    throw new AgentDatabaseRehearsalError(
      "unsupported-plugin-persistence",
      "plugin-owned persistence is unsupported by rehearsal schema v1.",
      request.pluginPersistence,
    );
  }
  const root = requireAbsoluteDirectory(request.privateStateRoot, "privateStateRoot");
  const agents = prepareAgentDatabases(request, root);
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_STATE_DIR: root.real };
  if (request.mode === "read-only") {
    return await runReadOnly(request, root, agents, env);
  }
  return runMigrate(request, root, agents, env);
}
