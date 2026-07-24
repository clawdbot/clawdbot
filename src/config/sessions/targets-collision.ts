// Fixed-store collision ownership and physical SQLite target deduplication.
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

/** One session store path paired with its owning agent id. */
export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

export type SessionStoreTargetCollisionDiagnostic = {
  message: string;
  sqlitePath: string;
  ownerAgentId?: string;
  ignoredAgentIds: string[];
  ownerSource: "database-registry" | "database-path" | "configured-default" | "ambiguous-registry";
};

const log = createSubsystemLogger("sessions/targets");

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
