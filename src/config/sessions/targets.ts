// Session store target discovery maps configured and on-disk agent stores to canonical targets.
import fsSync from "node:fs";
import path from "node:path";
import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isValidAgentId,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveStorePath } from "./paths.js";
import { readSqliteSessionEntryKeys } from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

/** CLI/session-store target selection options. */
export type SessionStoreSelectionOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
};

/** One session store path paired with its owning agent id. */
export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

const NON_FATAL_DISCOVERY_ERROR_CODES = new Set([
  "EACCES",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "ESTALE",
]);
const log = createSubsystemLogger("sessions/targets");

function dedupeTargetsByStorePath(targets: SessionStoreTarget[]): SessionStoreTarget[] {
  const deduped = new Map<string, SessionStoreTarget>();
  for (const target of targets) {
    if (!deduped.has(target.storePath)) {
      deduped.set(target.storePath, target);
    }
  }
  return [...deduped.values()];
}

export type SessionStoreTargetCollisionDiagnostic = {
  message: string;
  sqlitePath: string;
  ownerAgentId?: string;
  ignoredAgentIds: string[];
  ownerSource: "database-registry" | "database-path" | "configured-default" | "ambiguous-registry";
};

export function dedupeSessionStoreTargetsBySqliteTarget(
  targets: SessionStoreTarget[],
  options: {
    defaultAgentId: string;
    env?: NodeJS.ProcessEnv;
    onDiagnostic?: (diagnostic: SessionStoreTargetCollisionDiagnostic) => void;
  },
): SessionStoreTarget[] {
  // Ownership must not fall back while the authoritative registry is unreadable:
  // doing so can project the same physical DB under a different configured default.
  const registeredDatabases = listOpenClawRegisteredAgentDatabases({ env: options.env });
  const grouped = new Map<
    string,
    Array<{ target: SessionStoreTarget; databaseOwnerAgentId?: string }>
  >();
  const logicalGroups = new Map<
    string,
    Array<{
      target: SessionStoreTarget;
      ownerSource?: SessionStoreTargetCollisionDiagnostic["ownerSource"];
      unsuffixedOwnerAgentId?: string;
    }>
  >();
  for (const target of targets) {
    const unsuffixedPath = path.resolve(
      resolveSqliteTargetFromSessionStorePath(target.storePath, {
        defaultAgentId: options.defaultAgentId,
        env: options.env,
        registeredOwnerAgentIds: [],
      }).path ?? target.storePath,
    );
    const registeredOwnerAgentIds = registeredDatabases
      .filter((entry) => path.resolve(entry.path) === unsuffixedPath)
      .map((entry) => entry.agentId);
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
      defaultAgentId: options.defaultAgentId,
      env: options.env,
      registeredOwnerAgentIds,
    });
    const sqlitePath = path.resolve(resolved.path ?? target.storePath);
    const group = grouped.get(sqlitePath) ?? [];
    group.push({
      target,
      ...(resolved.agentId ? { databaseOwnerAgentId: normalizeAgentId(resolved.agentId) } : {}),
    });
    grouped.set(sqlitePath, group);
    const logicalGroup = logicalGroups.get(unsuffixedPath) ?? [];
    logicalGroup.push({
      target,
      ...(resolved.ownerSource ? { ownerSource: resolved.ownerSource } : {}),
      ...(resolved.unsuffixedOwnerAgentId
        ? { unsuffixedOwnerAgentId: resolved.unsuffixedOwnerAgentId }
        : {}),
    });
    logicalGroups.set(unsuffixedPath, logicalGroup);
  }
  for (const [sqlitePath, group] of logicalGroups) {
    const agentIds = [...new Set(group.map(({ target }) => normalizeAgentId(target.agentId)))];
    if (agentIds.length <= 1 || group.some((entry) => !entry.ownerSource)) {
      continue;
    }
    const ownerAgentId = group[0]?.unsuffixedOwnerAgentId;
    const ownerSource = group[0]?.ownerSource ?? "configured-default";
    const ignoredAgentIds = ownerAgentId
      ? agentIds.filter((agentId) => agentId !== ownerAgentId)
      : agentIds;
    const diagnostic: SessionStoreTargetCollisionDiagnostic = {
      message: ownerAgentId
        ? `Session store target collision at ${sqlitePath}: owner "${ownerAgentId}" selected by ${ownerSource}; suffixed owner(s): ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`
        : `Session store target collision at ${sqlitePath}: registry ownership is ambiguous; all claimant(s) use suffixed targets: ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`,
      sqlitePath,
      ...(ownerAgentId ? { ownerAgentId } : {}),
      ignoredAgentIds,
      ownerSource,
    };
    if (options.onDiagnostic) {
      options.onDiagnostic(diagnostic);
    } else {
      log.warn(diagnostic.message);
    }
  }
  const deduped: SessionStoreTarget[] = [];
  for (const [sqlitePath, group] of grouped) {
    const byAgentId = new Map(
      group.map(({ target }) => [normalizeAgentId(target.agentId), target] as const),
    );
    const registeredOwners = [
      ...new Set(
        registeredDatabases
          .filter((entry) => path.resolve(entry.path) === sqlitePath)
          .map((entry) => normalizeAgentId(entry.agentId)),
      ),
    ];
    const pathOwners = [...new Set(group.flatMap((entry) => entry.databaseOwnerAgentId ?? []))];
    const collision = byAgentId.size > 1;
    if (pathOwners.length !== 1 && registeredOwners.length > 1) {
      const diagnostic: SessionStoreTargetCollisionDiagnostic = {
        message: `Session store target collision at ${sqlitePath}: registry ownership is ambiguous across ${registeredOwners.map((id) => `"${id}"`).join(", ")}; no owner selected.`,
        sqlitePath,
        ignoredAgentIds: [...byAgentId.keys()],
        ownerSource: "ambiguous-registry",
      };
      if (options.onDiagnostic) {
        options.onDiagnostic(diagnostic);
      } else {
        log.warn(diagnostic.message);
      }
      continue;
    }
    const ownerSource =
      pathOwners.length === 1
        ? "database-path"
        : registeredOwners.length === 1
          ? "database-registry"
          : "configured-default";
    const ownerAgentId = normalizeAgentId(
      pathOwners[0] ??
        registeredOwners[0] ??
        (collision ? options.defaultAgentId : group[0]!.target.agentId),
    );
    const selected = byAgentId.get(ownerAgentId);
    if (selected) {
      deduped.push(selected);
    }
    const ignoredAgentIds = [...byAgentId.keys()].filter((agentId) => agentId !== ownerAgentId);
    if (!selected || ignoredAgentIds.length > 0) {
      const effectiveIgnoredAgentIds = selected ? ignoredAgentIds : [...byAgentId.keys()];
      const diagnostic: SessionStoreTargetCollisionDiagnostic = {
        message: `Session store target collision at ${sqlitePath}: owner "${ownerAgentId}" selected by ${ownerSource}; ignored owner(s): ${effectiveIgnoredAgentIds.map((id) => `"${id}"`).join(", ")}.`,
        sqlitePath,
        ownerAgentId,
        ignoredAgentIds: effectiveIgnoredAgentIds,
        ownerSource,
      };
      if (options.onDiagnostic) {
        options.onDiagnostic(diagnostic);
      } else {
        log.warn(diagnostic.message);
      }
    }
  }
  return deduped;
}

function shouldSkipDiscoveryError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && NON_FATAL_DISCOVERY_ERROR_CODES.has(code);
}

function isWithinRoot(realPath: string, realRoot: string): boolean {
  return realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`);
}

function shouldSkipDiscoveredAgentDirName(dirName: string, agentId: string): boolean {
  return (
    !/[a-z0-9]/i.test(dirName) ||
    !isValidAgentId(agentId) ||
    (agentId === LEGACY_IMPLICIT_AGENT_ID && dirName.toLowerCase() !== LEGACY_IMPLICIT_AGENT_ID)
  );
}

function resolveValidatedManagedFilePathSync(params: {
  agentsRoot: string;
  filePath: string;
  realAgentsRoot?: string;
}): string | undefined {
  try {
    const stat = fsSync.lstatSync(params.filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return undefined;
    }
    const realFilePath = fsSync.realpathSync.native(params.filePath);
    const realAgentsRoot = params.realAgentsRoot ?? fsSync.realpathSync.native(params.agentsRoot);
    return isWithinRoot(realFilePath, realAgentsRoot) ? params.filePath : undefined;
  } catch (err) {
    if (shouldSkipDiscoveryError(err)) {
      return undefined;
    }
    throw err;
  }
}

/** Lists agent ids whose session stores should be considered configured. */
export function listConfiguredSessionStoreAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set(listAgentIds(cfg).map((agentId) => normalizeAgentId(agentId)));
  const addAcpAgentId = (agentId: string | undefined) => {
    const raw = agentId?.trim() ?? "";
    if (!raw || raw === "*") {
      return;
    }
    const normalized = normalizeAgentId(raw);
    ids.add(normalized);
  };

  addAcpAgentId(cfg.acp?.defaultAgent);
  for (const agentId of cfg.acp?.allowedAgents ?? []) {
    addAcpAgentId(agentId);
  }
  for (const agent of listAgentEntries(cfg)) {
    if (agent.runtime?.type === "acp") {
      addAcpAgentId(agent.runtime.acp?.agent ?? agent.id);
    }
  }

  return [...ids];
}

/** Lists configured owners plus persisted owners whose registered DB still matches this store. */
export function listKnownSessionStoreAgentIds(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): string[] {
  const env = params.env ?? process.env;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const ids = new Set(listConfiguredSessionStoreAgentIds(cfg));
  for (const registered of listOpenClawRegisteredAgentDatabases({ env })) {
    const agentId = normalizeAgentId(registered.agentId);
    const storePath = resolveStorePath(cfg.session?.store, { agentId, env });
    const expectedPath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId,
      defaultAgentId,
      env,
    }).path;
    if (path.resolve(registered.path) === path.resolve(expectedPath)) {
      ids.add(agentId);
    }
  }
  return [...ids];
}

/** Checks whether an agent is configured to own a session store. */
export function isConfiguredSessionStoreAgentId(cfg: OpenClawConfig, agentId: string): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  return listConfiguredSessionStoreAgentIds(cfg).includes(normalizedAgentId);
}

/** Whether session.store resolves to a distinct store for each agent. */
export function isPerAgentSessionStoreConfig(storeConfig: string | undefined): boolean {
  const normalized = storeConfig?.trim();
  return !normalized || normalized.includes("{agentId}");
}

function resolveValidatedDiscoveredStorePathSync(params: {
  sessionsDir: string;
  agentsRoot: string;
  realAgentsRoot?: string;
}): string | undefined {
  const storePath = path.join(params.sessionsDir, "sessions.json");
  const validatedStorePath = resolveValidatedManagedFilePathSync({
    agentsRoot: params.agentsRoot,
    filePath: storePath,
    realAgentsRoot: params.realAgentsRoot,
  });
  if (validatedStorePath) {
    return validatedStorePath;
  }
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
  if (!sqlitePath) {
    return undefined;
  }
  return resolveValidatedManagedFilePathSync({
    agentsRoot: params.agentsRoot,
    filePath: sqlitePath,
    realAgentsRoot: params.realAgentsRoot,
  })
    ? storePath
    : undefined;
}

function resolveValidatedExistingSessionStoreTargetSync(
  target: SessionStoreTarget,
): SessionStoreTarget | undefined {
  // Runtime existing-store lookups are SQLite-only; broad discovery remains
  // available to Doctor/startup migration without making JSON authoritative.
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
  }).path;
  if (!sqlitePath) {
    return undefined;
  }
  const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
  if (!agentsRoot) {
    return fsSync.existsSync(sqlitePath) ? target : undefined;
  }
  return resolveValidatedManagedFilePathSync({
    agentsRoot,
    filePath: sqlitePath,
  })
    ? target
    : undefined;
}

function isValidatedRecoveryCandidateSessionsDir(params: {
  allowMissingAgentDir?: boolean;
  realAgentsRoot: string;
  sessionsDir: string;
}): boolean {
  const agentDir = path.dirname(params.sessionsDir);
  try {
    const agentStat = fsSync.lstatSync(agentDir);
    if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) {
      return false;
    }
    if (!isWithinRoot(fsSync.realpathSync.native(agentDir), params.realAgentsRoot)) {
      return false;
    }
    try {
      const sessionsStat = fsSync.lstatSync(params.sessionsDir);
      return (
        !sessionsStat.isSymbolicLink() &&
        sessionsStat.isDirectory() &&
        isWithinRoot(fsSync.realpathSync.native(params.sessionsDir), params.realAgentsRoot)
      );
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return params.allowMissingAgentDir === true;
    }
    if (shouldSkipDiscoveryError(err)) {
      return false;
    }
    throw err;
  }
}

function resolveSessionStoreDiscoveryState(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): {
  configuredTargets: SessionStoreTarget[];
  agentsRoots: string[];
} {
  const configuredTargets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env });
  const agentsRoots = new Set<string>();
  for (const target of configuredTargets) {
    const agentsDir = resolveAgentsDirFromSessionStorePath(target.storePath);
    if (agentsDir) {
      agentsRoots.add(agentsDir);
    }
  }
  agentsRoots.add(path.join(resolveStateDir(env), "agents"));
  // Search both configured template roots and the default state root so retired/manual agents are
  // visible even when no longer listed in config.
  return {
    configuredTargets,
    agentsRoots: [...agentsRoots],
  };
}

function toDiscoveredSessionStoreTarget(
  sessionsDir: string,
  storePath: string,
): SessionStoreTarget | undefined {
  const dirName = path.basename(path.dirname(sessionsDir));
  const agentId = normalizeAgentId(dirName);
  if (shouldSkipDiscoveredAgentDirName(dirName, agentId)) {
    return undefined;
  }
  return {
    agentId,
    // Keep the actual on-disk store path so retired/manual agent dirs remain discoverable
    // even if their directory name no longer round-trips through normalizeAgentId().
    storePath,
  };
}

function resolveExplicitSessionStoreTarget(params: {
  defaultAgentId: string;
  env: NodeJS.ProcessEnv;
  store: string;
}): SessionStoreTarget {
  const storePath = resolveStorePath(params.store, {
    agentId: params.defaultAgentId,
    env: params.env,
  });
  const discovered = resolveAgentsDirFromSessionStorePath(storePath)
    ? toDiscoveredSessionStoreTarget(path.dirname(storePath), storePath)
    : undefined;
  return discovered ?? { agentId: params.defaultAgentId, storePath };
}

/** Resolves all configured and discoverable agent session stores synchronously. */
export function resolveAllAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  const realAgentsRoots = new Map<string, string>();
  const getRealAgentsRoot = (agentsRoot: string): string | undefined => {
    const cached = realAgentsRoots.get(agentsRoot);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const realAgentsRoot = fsSync.realpathSync.native(agentsRoot);
      realAgentsRoots.set(agentsRoot, realAgentsRoot);
      return realAgentsRoot;
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return undefined;
      }
      throw err;
    }
  };
  const validatedConfiguredTargets = configuredTargets.flatMap((target) => {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
    // Configured explicit non-agent paths are accepted as-is; only agent-tree paths need
    // containment validation.
    if (!agentsRoot) {
      return [target];
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    if (!realAgentsRoot) {
      return [];
    }
    const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
      sessionsDir: path.dirname(target.storePath),
      agentsRoot,
      realAgentsRoot,
    });
    return validatedStorePath ? [{ ...target, storePath: validatedStorePath }] : [];
  });
  const discoveredTargets = agentsRoots.flatMap((agentsDir) => {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        return [];
      }
      return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).flatMap((sessionsDir) => {
        const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
          sessionsDir,
          agentsRoot: agentsDir,
          realAgentsRoot,
        });
        const target = validatedStorePath
          ? toDiscoveredSessionStoreTarget(sessionsDir, validatedStorePath)
          : undefined;
        return target ? [target] : [];
      });
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return [];
      }
      throw err;
    }
  });
  return dedupeSessionStoreTargetsBySqliteTarget(
    [...validatedConfiguredTargets, ...discoveredTargets],
    { defaultAgentId: resolveDefaultAgentId(cfg), env },
  );
}

/** Resolves only already-existing stores for one configured, retired, or manual agent. */
export function resolveExistingAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  agentId: string,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const requested = normalizeAgentId(agentId);
  const storeConfig = cfg.session?.store;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (!isPerAgentSessionStoreConfig(storeConfig)) {
    const fixedTarget = {
      agentId: requested,
      storePath: resolveStorePath(storeConfig, { agentId: requested, env }),
    };
    const configuredTargets = listConfiguredSessionStoreAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveStorePath(storeConfig, { agentId, env }),
    }));
    if (!configuredTargets.some((target) => normalizeAgentId(target.agentId) === requested)) {
      configuredTargets.push(fixedTarget);
    }
    const ownedTarget = dedupeSessionStoreTargetsBySqliteTarget(configuredTargets, {
      defaultAgentId,
      env,
    }).find((target) => normalizeAgentId(target.agentId) === requested);
    if (!ownedTarget) {
      return [];
    }
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(fixedTarget.storePath, {
      agentId: requested,
      defaultAgentId,
      env,
    }).path;
    if (sqlitePath && fsSync.existsSync(sqlitePath)) {
      try {
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readSqliteSessionEntryKeys(database).some((sessionKey) => {
              const parsed = parseAgentSessionKey(sessionKey);
              // Unscoped keys belong to the validated database owner. Explicit agent keys must
              // match so a fixed store containing only another agent's rows proves nothing.
              return !parsed || normalizeAgentId(parsed.agentId) === requested;
            }),
          { agentId: requested, env, path: sqlitePath },
        );
        return result.found && result.value ? [fixedTarget] : [];
      } catch {
        return [];
      }
    }
    return [];
  }
  const requestedTarget = {
    agentId: requested,
    storePath: resolveStorePath(storeConfig, { agentId: requested, env }),
  };
  // Directory discovery cannot enumerate arbitrary templates. Keep an existing retired store
  // visible by checking the requested agent's deterministic target alongside discovered stores.
  const discoveredTargets = resolveAllAgentSessionStoreTargetsSync(cfg, { env }).flatMap(
    (target) => {
      if (normalizeAgentId(target.agentId) !== requested) {
        return [];
      }
      const validated = resolveValidatedExistingSessionStoreTargetSync(target);
      return validated ? [validated] : [];
    },
  );
  const validatedRequestedTarget = resolveValidatedExistingSessionStoreTargetSync(requestedTarget);
  return dedupeSessionStoreTargetsBySqliteTarget(
    [...(validatedRequestedTarget ? [validatedRequestedTarget] : []), ...discoveredTargets],
    { defaultAgentId, env },
  );
}

/**
 * Resolves recovery candidates without requiring either the legacy store or SQLite file.
 * Callers must validate the selected artifact before performing filesystem mutations.
 */
export function resolveAllAgentSessionStoreCandidateTargetsSync(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  const realAgentsRoots = new Map<string, string | undefined>();
  const getRealAgentsRoot = (agentsRoot: string): string | undefined => {
    if (realAgentsRoots.has(agentsRoot)) {
      return realAgentsRoots.get(agentsRoot);
    }
    try {
      const realAgentsRoot = fsSync.realpathSync.native(agentsRoot);
      realAgentsRoots.set(agentsRoot, realAgentsRoot);
      return realAgentsRoot;
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        realAgentsRoots.set(agentsRoot, undefined);
        return undefined;
      }
      throw err;
    }
  };
  const validatedConfiguredTargets = configuredTargets.flatMap((target) => {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
    if (!agentsRoot) {
      return [target];
    }
    if (!fsSync.existsSync(agentsRoot)) {
      return [target];
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    return realAgentsRoot &&
      isValidatedRecoveryCandidateSessionsDir({
        allowMissingAgentDir: true,
        realAgentsRoot,
        sessionsDir: path.dirname(target.storePath),
      })
      ? [target]
      : [];
  });
  const discoveredTargets = agentsRoots.flatMap((agentsDir) => {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        return [];
      }
      return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).flatMap((sessionsDir) => {
        if (
          !isValidatedRecoveryCandidateSessionsDir({
            realAgentsRoot,
            sessionsDir,
          })
        ) {
          return [];
        }
        const target = toDiscoveredSessionStoreTarget(
          sessionsDir,
          path.join(sessionsDir, "sessions.json"),
        );
        return target ? [target] : [];
      });
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return [];
      }
      throw err;
    }
  });
  return dedupeSessionStoreTargetsBySqliteTarget(
    [...validatedConfiguredTargets, ...discoveredTargets],
    { defaultAgentId: resolveDefaultAgentId(cfg), env },
  );
}

/** Resolves session store targets for one agent, including retired/manual stores. */
export function resolveAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  agentId: string,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const requested = normalizeAgentId(agentId);
  const storePaths = new Set<string>([
    resolveStorePath(cfg.session?.store, { agentId: requested, env }),
    resolveStorePath(undefined, { agentId: requested, env }),
  ]);
  const targets: SessionStoreTarget[] = [];
  const realAgentsRoots = new Map<string, string | undefined>();
  const getRealAgentsRoot = (agentsRoot: string): string | undefined => {
    if (realAgentsRoots.has(agentsRoot)) {
      return realAgentsRoots.get(agentsRoot);
    }
    try {
      const realAgentsRoot = fsSync.realpathSync.native(agentsRoot);
      realAgentsRoots.set(agentsRoot, realAgentsRoot);
      return realAgentsRoot;
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        realAgentsRoots.set(agentsRoot, undefined);
        return undefined;
      }
      throw err;
    }
  };

  for (const storePath of storePaths) {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(storePath);
    if (!agentsRoot) {
      targets.push({ agentId: requested, storePath });
      continue;
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    if (!realAgentsRoot) {
      continue;
    }
    const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
      sessionsDir: path.dirname(storePath),
      agentsRoot,
      realAgentsRoot,
    });
    if (validatedStorePath) {
      targets.push({ agentId: requested, storePath: validatedStorePath });
    }
  }

  const { agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  for (const agentsDir of agentsRoots) {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        continue;
      }
      for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(agentsDir)) {
        const target = toDiscoveredSessionStoreTarget(
          sessionsDir,
          path.join(sessionsDir, "sessions.json"),
        );
        if (!target || normalizeAgentId(target.agentId) !== requested) {
          continue;
        }
        const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
          sessionsDir,
          agentsRoot: agentsDir,
          realAgentsRoot,
        });
        if (validatedStorePath) {
          targets.push({ ...target, storePath: validatedStorePath });
        }
      }
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        continue;
      }
      throw err;
    }
  }

  return dedupeTargetsByStorePath(targets);
}

/** Resolves session store targets from explicit CLI-style selection options. */
export function resolveSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
  params: { env?: NodeJS.ProcessEnv; diagnostics?: string[] } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const hasAgent = Boolean(opts.agent?.trim());
  const allAgents = opts.allAgents === true;
  if (hasAgent && allAgents) {
    throw new Error("--agent and --all-agents cannot be used together");
  }
  if (opts.store && (hasAgent || allAgents)) {
    throw new Error("--store cannot be combined with --agent or --all-agents");
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);

  if (opts.store) {
    return [resolveExplicitSessionStoreTarget({ defaultAgentId, env, store: opts.store })];
  }

  if (allAgents) {
    const targets = listConfiguredSessionStoreAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId, env }),
    }));
    return dedupeSessionStoreTargetsBySqliteTarget(targets, {
      defaultAgentId,
      env,
      ...(params.diagnostics
        ? { onDiagnostic: (diagnostic) => params.diagnostics?.push(diagnostic.message) }
        : {}),
    });
  }

  if (hasAgent) {
    const knownAgents = listAgentIds(cfg);
    const requested = normalizeAgentId(opts.agent ?? "");
    if (!knownAgents.includes(requested)) {
      throw new Error(
        `Unknown agent id "${opts.agent}". Use "openclaw agents list" to see configured agents.`,
      );
    }
    return [
      {
        agentId: requested,
        storePath: resolveStorePath(cfg.session?.store, { agentId: requested, env }),
      },
    ];
  }

  return [
    {
      agentId: defaultAgentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: defaultAgentId, env }),
    },
  ];
}
