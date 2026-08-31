// Session store target discovery maps configured and on-disk agent stores to canonical targets.
import fsSync from "node:fs";
import path from "node:path";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  listOpenClawRegisteredAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../legacy.default-agent-owner.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import { readSessionEntryKeys } from "./session-accessor.sqlite-entry-store.js";
import {
  listDurableSqliteTargetOwnersForSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "./session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "./session-store-config.js";
import {
  resolvePersistedSessionStoreOwner,
  resolvePersistedSessionStoreOwnerForTarget,
} from "./session-store-owner.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  type SessionStoreTarget,
} from "./targets-collision.js";
import {
  dedupeTargetsByStorePath,
  isWithinRoot,
  resolveValidatedManagedFilePathSync,
  shouldSkipDiscoveryError,
  shouldSkipDiscoveredAgentDirName,
} from "./targets-path-validation.js";

export type { SessionStoreTarget } from "./targets-collision.js";
export { dedupeSessionStoreTargetsBySqliteTarget } from "./targets-collision.js";
export { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
export { isPerAgentSessionStoreConfig } from "./session-store-config.js";

/** CLI/session-store target selection options. */
export type SessionStoreSelectionOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
};

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
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
  const ids = new Set(listConfiguredSessionStoreAgentIds(cfg));
  if (!isPerAgentSessionStoreConfig(cfg.session?.store)) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: defaultAgentId,
      env,
    });
    const durableTarget = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: defaultAgentId,
      defaultAgentId,
      env,
      isSameDatabasePath,
    });
    // Fixed stores can outlive their registry row. Preserve the database-recorded
    // owner so combined views and reapers do not drop a retired agent's live sessions.
    if (durableTarget.unsuffixedOwnerAgentId) {
      ids.add(normalizeAgentId(durableTarget.unsuffixedOwnerAgentId));
    } else if (durableTarget.ownerSource === "database-path" && durableTarget.agentId) {
      ids.add(normalizeAgentId(durableTarget.agentId));
    }
    // Retired owners may survive only in suffixed fixed-store databases after
    // their registry rows are removed. Scan this store's exact sibling family.
    for (const durableOwner of listDurableSqliteTargetOwnersForSessionStorePath(storePath)) {
      ids.add(normalizeAgentId(durableOwner));
    }
    if (durableTarget.shared && durableTarget.agentId && fsSync.existsSync(durableTarget.path)) {
      try {
        const logicalOwners = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readSessionEntryKeys(database).flatMap((sessionKey) => {
              const parsed = parseAgentSessionKey(sessionKey);
              return parsed ? [normalizeAgentId(parsed.agentId)] : [];
            }),
          { agentId: durableTarget.agentId, env, path: durableTarget.path },
        );
        if (logicalOwners.found) {
          for (const logicalOwner of logicalOwners.value) {
            ids.add(logicalOwner);
          }
        }
      } catch {
        // Best-effort discovery: unreadable stores remain owned by their normal diagnostics path.
      }
    }
  }
  for (const registered of listOpenClawRegisteredAgentDatabases({ env })) {
    const agentId = normalizeAgentId(registered.agentId);
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
    const expectedPath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId,
      defaultAgentId,
      env,
      isSameDatabasePath,
    }).path;
    if (isSameDatabasePath(registered.path, expectedPath)) {
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

function resolveValidatedDiscoveredStorePathSync(params: {
  sessionsDir: string;
  agentsRoot: string;
  realAgentsRoot?: string;
  sqliteOnly?: boolean;
}): string | undefined {
  const storePath = path.join(params.sessionsDir, "sessions.json");
  if (!params.sqliteOnly) {
    const validatedStorePath = resolveValidatedManagedFilePathSync({
      agentsRoot: params.agentsRoot,
      filePath: storePath,
      realAgentsRoot: params.realAgentsRoot,
    });
    if (validatedStorePath) {
      return validatedStorePath;
    }
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
  const storePath = resolveSessionStorePathCore(params.store, {
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
    { defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg), env },
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
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  if (!isPerAgentSessionStoreConfig(storeConfig)) {
    const fixedTarget = {
      agentId: requested,
      storePath: resolveSessionStorePathCore(storeConfig, { agentId: requested, env }),
    };
    const configuredTargets = listConfiguredSessionStoreAgentIds(cfg).map((configuredAgentId) => ({
      agentId: configuredAgentId,
      storePath: resolveSessionStorePathCore(storeConfig, { agentId: configuredAgentId, env }),
    }));
    if (!configuredTargets.some((target) => normalizeAgentId(target.agentId) === requested)) {
      configuredTargets.push(fixedTarget);
    }
    const resolvedTarget = resolveSqliteTargetFromSessionStorePath(fixedTarget.storePath, {
      agentId: requested,
      defaultAgentId,
      env,
    });
    if (
      !resolvedTarget.shared &&
      !dedupeSessionStoreTargetsBySqliteTarget(configuredTargets, {
        defaultAgentId,
        env,
      }).some((target) => normalizeAgentId(target.agentId) === requested)
    ) {
      return [];
    }
    const sqlitePath = resolvedTarget.path;
    if (sqlitePath && fsSync.existsSync(sqlitePath)) {
      try {
        const databaseAgentId = resolvedTarget.shared
          ? normalizeAgentId(resolvedTarget.agentId ?? defaultAgentId)
          : requested;
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readSessionEntryKeys(database).some((sessionKey) => {
              const parsed = parseAgentSessionKey(sessionKey);
              // Unscoped keys belong to the validated database owner. Explicit agent keys must
              // match so a fixed store containing only another agent's rows proves nothing.
              return parsed
                ? normalizeAgentId(parsed.agentId) === requested
                : databaseAgentId === requested;
            }),
          { agentId: databaseAgentId, env, path: sqlitePath },
        );
        return result.found && result.value ? [fixedTarget] : [];
      } catch {
        return [];
      }
    }
    return [];
  }
  // Validate the runtime SQLite artifact once; Doctor's broader discovery still accepts JSON.
  const targets = resolveAgentSessionStoreTargets(cfg, requested, { env, sqliteOnly: true });
  if (isConfiguredSessionStoreAgentId(cfg, requested)) {
    return targets;
  }
  // Always run sqlite-target dedupe for retired/manual agents: it probes the agent database
  // registry, so an unreadable registry surfaces as an ambiguous-ownership result rather than a
  // silent "absent" verdict in placement evidence (see server-worker-placement-session-evidence
  // "keeps a placement when the agent database registry is unreadable"). Retired/manual lookups are
  // not the configured-agent hot path, so the registry probe cost is acceptable here.
  return dedupeSessionStoreTargetsBySqliteTarget(targets, { defaultAgentId, env });
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
    { defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg), env },
  );
}

/** Resolves session store targets for one agent, including retired/manual stores. */
export function resolveAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  agentId: string,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  return resolveAgentSessionStoreTargets(cfg, agentId, params);
}

function resolveAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  agentId: string,
  params: { env?: NodeJS.ProcessEnv; sqliteOnly?: boolean },
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const requested = normalizeAgentId(agentId);
  const storePaths = new Set<string>([
    resolveSessionStorePathCore(cfg.session?.store, { agentId: requested, env }),
    resolveSessionStorePathCore(undefined, { agentId: requested, env }),
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
      if (params.sqliteOnly) {
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: requested,
        }).path;
        if (!sqlitePath || !fsSync.existsSync(sqlitePath)) {
          continue;
        }
      }
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
      sqliteOnly: params.sqliteOnly,
    });
    if (validatedStorePath) {
      targets.push({ agentId: requested, storePath: validatedStorePath });
    }
  }

  // Configured agents own canonical direct paths; broad discovery is retired/manual-only.
  // Falling through here makes per-agent Gateway prewarm scan the full roster quadratically.
  if (isConfiguredSessionStoreAgentId(cfg, requested)) {
    return dedupeTargetsByStorePath(targets);
  }

  const { agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  for (const agentsDir of agentsRoots) {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        continue;
      }
      for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(
        agentsDir,
        (dirName) => normalizeAgentId(dirName) === requested,
      )) {
        const target = toDiscoveredSessionStoreTarget(
          sessionsDir,
          path.join(sessionsDir, "sessions.json"),
        );
        if (!target) {
          continue;
        }
        const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
          sessionsDir,
          agentsRoot: agentsDir,
          realAgentsRoot,
          sqliteOnly: params.sqliteOnly,
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

/** Project configured session-store selection to the exact database migration owners. */
export function resolveConfiguredAgentDatabaseTargets(
  cfg: OpenClawConfig,
  params: { env: NodeJS.ProcessEnv },
): Array<{ agentId: string; path: string }> {
  return resolveSessionStoreTargets(cfg, { allAgents: true }, params).map((target) => {
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
      defaultAgentId: isPerAgentSessionStoreConfig(cfg.session?.store)
        ? target.agentId
        : resolveSessionStoreCompatibilityAgentId(cfg),
      env: params.env,
    });
    // Shared stores partition logical agents inside one physical schema owner.
    return { agentId: resolved.agentId ?? target.agentId, path: resolved.path };
  });
}

/** Resolves session store targets from explicit CLI-style selection options. */
export function resolveSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
  params: { env?: NodeJS.ProcessEnv; diagnostics?: string[] } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const requestedAgent = opts.agent?.trim();
  if (opts.agent !== undefined && !requestedAgent) {
    throw new Error("--agent must not be blank");
  }
  const hasAgent = requestedAgent !== undefined;
  const allAgents = opts.allAgents === true;
  if (hasAgent && allAgents) {
    throw new Error("--agent and --all-agents cannot be used together");
  }
  if (opts.store && allAgents) {
    throw new Error("--store cannot be combined with --all-agents");
  }
  if (opts.store) {
    const persistedStoreOwner = resolvePersistedSessionStoreOwnerForTarget({
      config: cfg,
      sessionKey: "main",
      storePath: opts.store,
      env,
    });
    if (persistedStoreOwner.kind === "retired") {
      throw new Error(`Session store owner is retired: ${persistedStoreOwner.agentId}`);
    }
    const requestedAgentId = requestedAgent ? normalizeAgentId(requestedAgent) : undefined;
    if (
      requestedAgentId &&
      persistedStoreOwner.kind === "configured" &&
      persistedStoreOwner.agentId !== requestedAgentId
    ) {
      throw new Error(
        `Session store belongs to agent "${persistedStoreOwner.agentId}", not requested agent "${requestedAgentId}".`,
      );
    }
    const defaultAgentId =
      requestedAgentId ??
      (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
      // Session-store selection enumerates agents: silently adopting the system
      // agent would hide the other agents' sessions, so this stays explicit and
      // offers --agent/--all-agents instead of the ambient owner chain.
      tryResolveLegacyCompatibilityAgentId(cfg) ??
      resolveDefaultAgentId(cfg);
    if (hasAgent) {
      resolveConfiguredAgentId(cfg, defaultAgentId);
    }
    const target = resolveExplicitSessionStoreTarget({ defaultAgentId, env, store: opts.store });
    if (
      (hasAgent || persistedStoreOwner.kind === "configured") &&
      target.agentId !== defaultAgentId
    ) {
      throw new Error(
        `Session store belongs to agent "${target.agentId}", not requested agent "${defaultAgentId}".`,
      );
    }
    return [target];
  }

  if (allAgents) {
    const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
    const targets = listConfiguredSessionStoreAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId, env }),
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
    const requested = normalizeAgentId(requestedAgent);
    resolveConfiguredAgentId(cfg, requested);
    return [
      {
        agentId: requested,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: requested, env }),
      },
    ];
  }

  const persistedStoreOwner = resolvePersistedSessionStoreOwner(cfg);
  if (persistedStoreOwner.kind === "retired") {
    throw new Error(`Session store owner is retired: ${persistedStoreOwner.agentId}`);
  }
  const defaultAgentId =
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    // Explicit selection, not ambient ownership: see listConfiguredSessionStoreAgentIds.
    tryResolveLegacyCompatibilityAgentId(cfg) ??
    resolveDefaultAgentId(cfg);
  return [
    {
      agentId: defaultAgentId,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: defaultAgentId, env }),
    },
  ];
}
