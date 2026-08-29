import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPortableAuthProfileStoreForAgentCopy } from "../../src/agents/auth-profiles/portability.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "../../src/agents/auth-profiles/sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  withAuthProfileStoreAgentDir,
} from "../../src/agents/auth-profiles/store.js";
import { DEFAULT_AGENT_ID } from "../../src/routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";

export function stageLiveAuthProfiles(realStateDir: string, tempStateDir: string): void {
  const agentsDir = path.join(realStateDir, "agents");
  const agentIds = new Set([
    DEFAULT_AGENT_ID,
    ...(fs.existsSync(agentsDir)
      ? fs
          .readdirSync(agentsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : []),
  ]);
  for (const agentId of agentIds) {
    const sourceAgentDir = path.join(agentsDir, agentId, "agent");
    const sourceDatabasePath = resolveAuthProfileDatabasePath(sourceAgentDir);
    const sourceSnapshot = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        database.db.exec("BEGIN");
        try {
          const snapshot = {
            store: inspectPersistedAuthProfileStoreRaw(sourceAgentDir, database),
            state: inspectPersistedAuthProfileStateRaw(sourceAgentDir, database),
          };
          database.db.exec("COMMIT");
          return snapshot;
        } catch (error) {
          if (database.db.isTransaction) {
            database.db.exec("ROLLBACK");
          }
          throw error;
        }
      },
      {
        agentId: resolveAuthProfileDatabaseOwnerId(sourceAgentDir),
        path: sourceDatabasePath,
      },
    );
    if (!sourceSnapshot.found) {
      if (sourceSnapshot.reason === "schema-missing") {
        throw new Error(`Could not safely stage SQLite auth profiles for live agent "${agentId}".`);
      }
    }
    const sourceStore = sourceSnapshot.found ? sourceSnapshot.value.store : undefined;
    const sourceState = sourceSnapshot.found ? sourceSnapshot.value.state : undefined;
    if (sourceStore?.status === "unreadable" || sourceState?.status === "unreadable") {
      throw new Error(`Could not safely stage SQLite auth profiles for live agent "${agentId}".`);
    }
    const storeTableMissing = sourceStore?.status === "missing" && sourceStore.reason === "table";
    const stateTableMissing = sourceState?.status === "missing" && sourceState.reason === "table";
    if (storeTableMissing || stateTableMissing) {
      throw new Error(
        `Could not safely stage SQLite auth profiles for live agent "${agentId}": canonical auth schema is incomplete.`,
      );
    }
    const portable = withAuthProfileStoreAgentDir(sourceAgentDir, realStateDir, () =>
      buildPortableAuthProfileStoreForAgentCopy(
        ensureAuthProfileStoreWithoutExternalProfiles(sourceAgentDir, {
          readOnly: true,
          syncExternalCli: false,
        }),
      ),
    );
    if (portable.copiedProfileIds.length === 0) {
      continue;
    }
    const targetAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
    // Copy the canonical portable view, including shared static credentials;
    // never clone session databases or acquire another OAuth refresh owner.
    withAuthProfileStoreAgentDir(targetAgentDir, tempStateDir, () =>
      saveAuthProfileStore(portable.store, targetAgentDir, { syncExternalCli: false }),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [realStateDir, tempStateDir] = process.argv.slice(2);
  if (!realStateDir || !tempStateDir) {
    throw new Error("Expected source and target state directories.");
  }
  stageLiveAuthProfiles(realStateDir, tempStateDir);
}
