import { getChildLogger } from "../../logging/logger.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { ResolvedSessionMaintenanceConfigInput } from "./store-maintenance.js";

type SessionEntryMaintenanceRequest = {
  activeSessionKey: string;
  archiveDirectory: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
  skipMaintenance?: boolean;
  storePath: string;
};
type SessionEntryMaintenanceOwner = SessionEntryMaintenanceRequest & {
  activeSessionKeys: Set<string>;
  generation: number;
};

const maintenanceByStore = new Map<string, SessionEntryMaintenanceOwner>();

/** Coalesce automatic logical maintenance outside ordinary entry-write latency. */
export function kickSessionEntryMaintenanceAfterWrite(
  params: SessionEntryMaintenanceRequest,
): void {
  if (params.skipMaintenance) {
    return;
  }
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(params.scope));
  const owner = maintenanceByStore.get(databasePath);
  if (owner) {
    owner.activeSessionKeys.add(params.activeSessionKey);
    Object.assign(owner, params, { generation: owner.generation + 1 });
    return;
  }
  const created: SessionEntryMaintenanceOwner = {
    ...params,
    activeSessionKeys: new Set([params.activeSessionKey]),
    generation: 1,
  };
  maintenanceByStore.set(databasePath, created);
  setImmediate(() => void runPendingMaintenance(databasePath, created));
}

async function runPendingMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): Promise<void> {
  while (maintenanceByStore.get(databasePath) === owner) {
    const generation = owner.generation;
    const activeSessionKeys = [...owner.activeSessionKeys];
    owner.activeSessionKeys.clear();
    try {
      const plan = await runExclusiveSqliteSessionWrite(owner.scope, async () =>
        runOpenClawAgentWriteTransaction(
          (database) =>
            applySessionEntryMaintenance(database, {
              activeSessionKeys,
              archiveDirectory: owner.archiveDirectory,
              maintenanceConfig: owner.maintenanceConfig,
              storePath: owner.storePath,
            }),
          toDatabaseOptions(owner.scope),
        ),
      );
      await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(owner.scope, [plan]);
    } catch (error) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "SQLite automatic session maintenance failed",
        { error, path: databasePath },
      );
    }
    // Any write during awaited planning/finalization increments the generation.
    // Keep this owner alive so that write gets a fresh maintenance snapshot.
    if (owner.generation === generation) {
      maintenanceByStore.delete(databasePath);
      return;
    }
  }
}
