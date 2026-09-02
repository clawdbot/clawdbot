import { getChildLogger } from "../../logging/logger.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
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
  database: OpenClawAgentDatabase;
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
  const database = getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(params.scope));
  if (!database) {
    return;
  }
  const owner = maintenanceByStore.get(databasePath);
  if (owner?.database === database) {
    owner.activeSessionKeys.add(params.activeSessionKey);
    Object.assign(owner, params, { generation: owner.generation + 1 });
    return;
  }
  const created: SessionEntryMaintenanceOwner = {
    ...params,
    activeSessionKeys: new Set([params.activeSessionKey]),
    database,
    generation: 1,
  };
  maintenanceByStore.set(databasePath, created);
  setImmediate(() => void runPendingMaintenance(databasePath, created));
}

async function runPendingMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): Promise<void> {
  const isCurrent = () =>
    maintenanceByStore.get(databasePath) === owner && owner.database.db.isOpen;
  while (isCurrent()) {
    const generation = owner.generation;
    const activeSessionKeys = [...owner.activeSessionKeys];
    owner.activeSessionKeys.clear();
    try {
      const plan = await runExclusiveSqliteSessionWrite(owner.scope, async () => {
        // The writer queue can outlive the handle that admitted this owner.
        // Check inside the acquired lane so an evicted owner cannot reopen the path.
        if (!isCurrent()) {
          return undefined;
        }
        return runOpenClawAgentWriteTransaction(
          (database) =>
            applySessionEntryMaintenance(database, {
              activeSessionKeys,
              archiveDirectory: owner.archiveDirectory,
              maintenanceConfig: owner.maintenanceConfig,
              storePath: owner.storePath,
            }),
          toDatabaseOptions(owner.scope),
        );
      });
      if (!plan) {
        if (maintenanceByStore.get(databasePath) === owner) {
          maintenanceByStore.delete(databasePath);
        }
        return;
      }
      await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(owner.scope, [plan], {
        isCurrent,
      });
    } catch (error) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "SQLite automatic session maintenance failed",
        { error, path: databasePath },
      );
    }
    // Any write during awaited planning/finalization increments the generation.
    // Keep this owner alive so that write gets a fresh maintenance snapshot.
    if (maintenanceByStore.get(databasePath) !== owner) {
      return;
    }
    if (!owner.database.db.isOpen || owner.generation === generation) {
      maintenanceByStore.delete(databasePath);
      return;
    }
  }
  if (maintenanceByStore.get(databasePath) === owner) {
    maintenanceByStore.delete(databasePath);
  }
}
