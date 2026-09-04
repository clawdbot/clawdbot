// Fixed-store collision ownership and physical SQLite target deduplication.
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  listOpenClawRegisteredAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  resolveUnsuffixedSqliteTargetFromSessionStorePath,
} from "./session-sqlite-target.js";

/** One session store path paired with its owning agent id. */
export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

type SessionStoreTargetCollisionDiagnostic = {
  message: string;
  sqlitePath: string;
  ownerAgentId?: string;
  ignoredAgentIds: string[];
  ownerSource:
    | "database-registry"
    | "database-path"
    | "registered-suffixed"
    | "occupied-unsuffixed"
    | "configured-default"
    | "ambiguous-registry";
};

const log = createSubsystemLogger("sessions/targets");

export function dedupeSessionStoreTargetsBySqliteTarget(
  targets: SessionStoreTarget[],
  options: {
    defaultAgentId: string;
    env?: NodeJS.ProcessEnv;
    registeredDatabases?: readonly { agentId: string; path: string }[];
    onDiagnostic?: (diagnostic: SessionStoreTargetCollisionDiagnostic) => void;
    onSharedTarget?: (selected: SessionStoreTarget, sharedStorePaths: ReadonlySet<string>) => void;
  },
): SessionStoreTarget[] {
  // Ownership must not fall back while the authoritative registry is unreadable:
  // doing so can project the same physical DB under a different configured default.
  const registeredDatabases =
    options.registeredDatabases ?? listOpenClawRegisteredAgentDatabases({ env: options.env });
  const grouped = new Map<
    string,
    Array<{ target: SessionStoreTarget; databaseOwnerAgentId?: string; shared: boolean }>
  >();
  const logicalGroups = new Map<
    string,
    Array<{
      target: SessionStoreTarget;
      ownerSource?: SessionStoreTargetCollisionDiagnostic["ownerSource"];
      unsuffixedOwnerAgentId?: string;
    }>
  >();
  // Alias targets can change between calls. Reuse prepared identities only for this
  // synchronous dedupe invocation so collision ownership never relies on stale paths.
  const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
  const resolvePhysicalGroupKey = <T>(groups: ReadonlyMap<string, T>, pathname: string) =>
    [...groups.keys()].find((candidate) => isSameDatabasePath(candidate, pathname)) ??
    path.resolve(pathname);
  for (const target of targets) {
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
      defaultAgentId: options.defaultAgentId,
      env: options.env,
      registeredDatabases,
      isSameDatabasePath,
    });
    const sqlitePath = resolvePhysicalGroupKey(grouped, resolved.path ?? target.storePath);
    const group = grouped.get(sqlitePath) ?? [];
    group.push({
      target,
      shared: resolved.shared === true,
      ...(resolved.agentId ? { databaseOwnerAgentId: normalizeAgentId(resolved.agentId) } : {}),
    });
    grouped.set(sqlitePath, group);
    // Exact shared locators do not allocate legacy per-agent suffixes.
    if (resolved.shared) {
      continue;
    }
    const resolvedUnsuffixedPath = path.resolve(
      resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path ?? target.storePath,
    );
    const unsuffixedPath = resolvePhysicalGroupKey(logicalGroups, resolvedUnsuffixedPath);
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
        : ownerSource === "registered-suffixed"
          ? `Session store target collision at ${sqlitePath}: configured default retains its registered suffixed target; all claimant(s) use suffixed targets: ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`
          : ownerSource === "occupied-unsuffixed"
            ? `Session store target collision at ${sqlitePath}: unsuffixed target is occupied without a durable owner; all claimant(s) use suffixed targets: ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`
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
    const pathOwners = [...new Set(group.flatMap((entry) => entry.databaseOwnerAgentId ?? []))];
    // A unique path owner outranks registry owners, so identity matching cannot change the result.
    // Registry loading above still preserves unreadable-registry semantics.
    const registeredOwners =
      pathOwners.length === 1
        ? []
        : [
            ...new Set(
              registeredDatabases
                .filter((entry) => isSameDatabasePath(entry.path, sqlitePath))
                .map((entry) => normalizeAgentId(entry.agentId)),
            ),
          ];
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
    const ownerTarget = byAgentId.get(ownerAgentId);
    // An exact shared database can outlive its schema owner's roster entry. Keep one
    // configured claimant so the accessor can reopen the path under its durable owner.
    const selected =
      ownerTarget ??
      (group.some((entry) => entry.shared)
        ? (byAgentId.get(normalizeAgentId(options.defaultAgentId)) ?? group[0]?.target)
        : undefined);
    if (selected) {
      deduped.push(selected);
      if (options.onSharedTarget) {
        // A shared alias can select a per-agent registry spelling. Preserve its
        // original shared claims so consumers need no second ownership scan.
        const sharedStorePaths = new Set(
          group.filter((entry) => entry.shared).map((entry) => entry.target.storePath),
        );
        if (sharedStorePaths.size > 0) {
          options.onSharedTarget(selected, sharedStorePaths);
        }
      }
    }
    const selectedAgentId = selected ? normalizeAgentId(selected.agentId) : ownerAgentId;
    const ignoredAgentIds = [...byAgentId.keys()].filter((agentId) => agentId !== selectedAgentId);
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
