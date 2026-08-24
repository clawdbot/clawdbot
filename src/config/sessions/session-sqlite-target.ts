import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawRegisteredAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  isSameOpenClawAgentDatabasePath,
  listOpenClawRegisteredAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import {
  inspectOpenClawAgentDatabaseOwner,
  isIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";

/** SQLite database target resolved from a legacy session store path. */
type ResolvedSqliteStoreTarget = {
  agentId?: string;
  ownerSource?:
    | "database-registry"
    | "database-path"
    | "registered-suffixed"
    | "occupied-unsuffixed"
    | "configured-default"
    | "ambiguous-registry";
  path: string;
  shared?: boolean;
  unsuffixedOwnerAgentId?: string;
};

type ResolveSqliteStoreTargetOptions = {
  agentId?: string;
  defaultAgentId?: string;
  env?: NodeJS.ProcessEnv;
  registeredDatabases?: readonly Pick<OpenClawRegisteredAgentDatabase, "agentId" | "path">[];
  isSameDatabasePath?: (left: string, right: string) => boolean;
};

function resolveRegisteredOwners(
  pathname: string,
  registeredDatabases: readonly Pick<OpenClawRegisteredAgentDatabase, "agentId" | "path">[],
  isSameDatabasePath: (left: string, right: string) => boolean,
): string[] {
  return [
    ...new Set(
      registeredDatabases
        .filter((entry) => isSameDatabasePath(entry.path, pathname))
        .map((entry) => normalizeAgentId(entry.agentId)),
    ),
  ];
}

function resolveDatabaseOwner(pathname: string): string | undefined {
  if (!hasFilesystemEntry(pathname)) {
    return undefined;
  }
  const owner = inspectOpenClawAgentDatabaseOwner(pathname);
  return owner.status === "owned" ? normalizeAgentId(owner.agentId) : undefined;
}

function hasFilesystemEntry(pathname: string): boolean {
  try {
    lstatSync(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function resolveCustomStoreSqlitePath(params: {
  unsuffixedPath: string;
  options: ResolveSqliteStoreTargetOptions;
}): ResolvedSqliteStoreTarget {
  const unsuffixedPath = path.resolve(params.unsuffixedPath);
  const sqliteBaseName = path.basename(unsuffixedPath, ".sqlite");
  const sessionsDir = path.dirname(unsuffixedPath);
  const defaultAgentId = normalizeAgentId(params.options.defaultAgentId ?? "main");
  const agentId = normalizeAgentId(params.options.agentId ?? defaultAgentId);
  const registeredDatabases =
    params.options.registeredDatabases ??
    listOpenClawRegisteredAgentDatabases(params.options.env ? { env: params.options.env } : {});
  const isSameDatabasePath = params.options.isSameDatabasePath ?? isSameOpenClawAgentDatabasePath;
  const resolvePersistedOwner = (candidatePath: string) => {
    const registeredOwners = resolveRegisteredOwners(
      candidatePath,
      registeredDatabases,
      isSameDatabasePath,
    );
    const databaseOwner = resolveDatabaseOwner(candidatePath);
    return {
      effectiveOwner:
        registeredOwners.length === 1
          ? registeredOwners[0]
          : registeredOwners.length === 0
            ? databaseOwner
            : undefined,
      registeredOwners,
    };
  };
  const registeredUnsuffixedOwners = resolveRegisteredOwners(
    unsuffixedPath,
    registeredDatabases,
    isSameDatabasePath,
  );
  const durableUnsuffixedOwner = resolveDatabaseOwner(unsuffixedPath);
  const persistedUnsuffixedOwner =
    registeredUnsuffixedOwners.length === 1
      ? registeredUnsuffixedOwners[0]
      : registeredUnsuffixedOwners.length === 0
        ? durableUnsuffixedOwner
        : undefined;
  const suffixedPathFor = (ownerAgentId: string) =>
    path.join(sessionsDir, `${sqliteBaseName}.${ownerAgentId}.sqlite`);
  const resolveSuffixedTarget = (ownerAgentId: string) => {
    const prefix = `${sqliteBaseName}.${ownerAgentId}`;
    const parseIndex = (fileName: string): number | undefined => {
      if (fileName === `${prefix}.sqlite`) {
        return 1;
      }
      if (!fileName.startsWith(`${prefix}.`) || !fileName.endsWith(".sqlite")) {
        return undefined;
      }
      const rawValue = fileName.slice(prefix.length + 1, -".sqlite".length);
      if (!/^[1-9]\d*$/.test(rawValue)) {
        return undefined;
      }
      const value = Number(rawValue);
      return Number.isSafeInteger(value) && value >= 2 && String(value) === rawValue
        ? value
        : undefined;
    };
    const occupiedIndexes = new Set<number>();
    for (const registered of registeredDatabases) {
      if (!isSameDatabasePath(path.dirname(registered.path), sessionsDir)) {
        continue;
      }
      const index = parseIndex(path.basename(registered.path));
      if (index !== undefined) {
        occupiedIndexes.add(index);
      }
    }
    try {
      for (const fileName of readdirSync(sessionsDir)) {
        const index = parseIndex(fileName);
        if (index !== undefined) {
          occupiedIndexes.add(index);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // A missing target directory has no occupied on-disk suffixes.
    }
    const candidatePathAt = (index: number) =>
      index === 1
        ? suffixedPathFor(ownerAgentId)
        : path.join(sessionsDir, `${prefix}.${index}.sqlite`);
    const sortedOccupiedIndexes = [...occupiedIndexes].toSorted((left, right) => left - right);
    for (const index of sortedOccupiedIndexes) {
      const candidatePath = candidatePathAt(index);
      if (resolvePersistedOwner(candidatePath).effectiveOwner === ownerAgentId) {
        return { owned: true, path: candidatePath };
      }
    }
    let firstMissingIndex = 1;
    for (const index of sortedOccupiedIndexes) {
      if (index === firstMissingIndex) {
        firstMissingIndex += 1;
      } else if (index > firstMissingIndex) {
        break;
      }
    }
    for (let index = firstMissingIndex; ; index += 1) {
      const candidatePath = candidatePathAt(index);
      const candidateOwner = resolvePersistedOwner(candidatePath);
      if (candidateOwner.effectiveOwner === ownerAgentId) {
        return { owned: true, path: candidatePath };
      }
      if (candidateOwner.registeredOwners.length === 0 && !hasFilesystemEntry(candidatePath)) {
        return { owned: false, path: candidatePath };
      }
    }
  };
  const defaultSuffixedTarget = resolveSuffixedTarget(defaultAgentId);
  const agentSuffixedTarget =
    agentId === defaultAgentId ? defaultSuffixedTarget : resolveSuffixedTarget(agentId);
  const defaultOwnsSuffixedPath = defaultSuffixedTarget.owned;
  const agentOwnsSuffixedPath = agentSuffixedTarget.owned;
  const unsuffixedAvailable =
    registeredUnsuffixedOwners.length === 0 && !hasFilesystemEntry(unsuffixedPath);
  const fallbackUnsuffixedOwner =
    persistedUnsuffixedOwner || defaultOwnsSuffixedPath || !unsuffixedAvailable
      ? undefined
      : defaultAgentId;
  const unsuffixedOwnerAgentId = persistedUnsuffixedOwner ?? fallbackUnsuffixedOwner;
  const useUnsuffixedPath =
    agentId === persistedUnsuffixedOwner ||
    (!agentOwnsSuffixedPath && agentId === fallbackUnsuffixedOwner);
  const ownerSource = persistedUnsuffixedOwner
    ? registeredUnsuffixedOwners.length === 1
      ? "database-registry"
      : "database-path"
    : defaultOwnsSuffixedPath
      ? "registered-suffixed"
      : registeredUnsuffixedOwners.length > 1
        ? "ambiguous-registry"
        : !unsuffixedAvailable
          ? "occupied-unsuffixed"
          : "configured-default";
  // Fixed-store precedence is: persisted unsuffixed owner, the agent's own persisted suffix,
  // configured-default unsuffixed ownership, then a new suffix. Filenames never infer ownership.
  // This keeps promotions stable and guarantees one physical SQLite target per agent.
  return {
    agentId,
    path: useUnsuffixedPath ? unsuffixedPath : agentSuffixedTarget.path,
    ownerSource,
    ...(unsuffixedOwnerAgentId ? { unsuffixedOwnerAgentId } : {}),
  };
}

/** Resolves only the legacy unsuffixed target, without reading ownership state. */
export function resolveUnsuffixedSqliteTargetFromSessionStorePath(
  storePath: string,
): ResolvedSqliteStoreTarget {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) === "openclaw-agent.sqlite" || resolved.endsWith(".sqlite")) {
    const agentId = resolveAgentIdFromSqliteDatabasePath(resolved);
    return { path: resolved, ...(agentId ? { agentId } : {}) };
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(resolved) !== "sessions.json") {
    const sqliteBaseName = path.basename(resolved, path.extname(resolved)) || "openclaw-agent";
    return { path: path.join(sessionsDir, `${sqliteBaseName}.sqlite`) };
  }
  if (path.basename(sessionsDir) !== "sessions") {
    return { path: path.join(sessionsDir, "openclaw-agent.sqlite") };
  }
  const agentDir = path.dirname(sessionsDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return { path: path.join(sessionsDir, "openclaw-agent.sqlite") };
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir)),
    path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
  };
}

/** Resolves the SQLite database target that owns a legacy session store path. */
export function resolveSqliteTargetFromSessionStorePath(
  storePath: string,
  options: ResolveSqliteStoreTargetOptions = {},
): ResolvedSqliteStoreTarget {
  const unsuffixedTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const requestedAgentId = options.agentId ? normalizeAgentId(options.agentId) : undefined;
  if (
    requestedAgentId &&
    isIncognitoOpenClawAgentSqlitePath(unsuffixedTarget.path, {
      agentId: requestedAgentId,
      env: options.env,
    })
  ) {
    return { agentId: requestedAgentId, path: unsuffixedTarget.path };
  }
  if (unsuffixedTarget.agentId) {
    return unsuffixedTarget;
  }
  if (path.resolve(storePath).endsWith(".sqlite")) {
    const registeredDatabases =
      options.registeredDatabases ??
      listOpenClawRegisteredAgentDatabases(options.env ? { env: options.env } : {});
    const registeredOwners = resolveRegisteredOwners(
      unsuffixedTarget.path,
      registeredDatabases,
      options.isSameDatabasePath ?? isSameOpenClawAgentDatabasePath,
    );
    const databaseOwner = resolveDatabaseOwner(unsuffixedTarget.path);
    const configuredDefaultAgentId = normalizeAgentId(
      options.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
    );
    const ownerAgentId =
      (registeredOwners.length === 1 ? registeredOwners[0] : undefined) ??
      databaseOwner ??
      configuredDefaultAgentId;
    return {
      ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
      path: unsuffixedTarget.path,
      // Exact locators are shared session stores: scoped keys partition rows inside one file.
      // The physical schema owner must never turn the first caller into the store's sole owner.
      shared: true,
      ...(registeredOwners.length === 1
        ? { ownerSource: "database-registry" as const }
        : databaseOwner
          ? { ownerSource: "database-path" as const }
          : registeredOwners.length > 1
            ? { ownerSource: "ambiguous-registry" as const }
            : { ownerSource: "configured-default" as const }),
    };
  }
  return resolveCustomStoreSqlitePath({ unsuffixedPath: unsuffixedTarget.path, options });
}

/** Lists durable owners recorded in the fixed store's bounded SQLite sibling family. */
export function listDurableSqliteTargetOwnersForSessionStorePath(storePath: string): string[] {
  const owners = new Set<string>();
  for (const candidatePath of listSqliteTargetCandidatePathsForSessionStorePath(storePath)) {
    const owner = resolveDatabaseOwner(candidatePath);
    if (owner) {
      owners.add(owner);
    }
  }
  return [...owners];
}

function listSqliteTargetCandidatePathsForSessionStorePath(storePath: string): string[] {
  const unsuffixedTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  if (unsuffixedTarget.agentId || path.resolve(storePath).endsWith(".sqlite")) {
    return [unsuffixedTarget.path];
  }
  const directory = path.dirname(unsuffixedTarget.path);
  const baseName = path.basename(unsuffixedTarget.path, ".sqlite");
  const candidateNames = new Set([path.basename(unsuffixedTarget.path)]);
  try {
    for (const fileName of readdirSync(directory)) {
      if (fileName.startsWith(`${baseName}.`) && fileName.endsWith(".sqlite")) {
        candidateNames.add(fileName);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return [...candidateNames].map((fileName) => path.join(directory, fileName));
}

/** Lists the logical store's unsuffixed target plus durable owned partitions. */
export function listDurableSqliteTargetPathsForSessionStorePath(storePath: string): string[] {
  const candidates = listSqliteTargetCandidatePathsForSessionStorePath(storePath);
  return candidates.filter(
    (candidatePath, index) => index === 0 || resolveDatabaseOwner(candidatePath) !== undefined,
  );
}

/** Extracts the agent id from the canonical per-agent SQLite database path. */
function resolveAgentIdFromSqliteDatabasePath(databasePath: string): string | undefined {
  if (path.basename(databasePath) !== "openclaw-agent.sqlite") {
    return undefined;
  }
  const agentDbDir = path.dirname(databasePath);
  if (path.basename(agentDbDir) !== "agent") {
    return undefined;
  }
  const agentDir = path.dirname(agentDbDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return undefined;
  }
  return normalizeAgentId(path.basename(agentDir));
}
