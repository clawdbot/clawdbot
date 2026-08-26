import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { coercePersistedAuthProfileStore } from "../../src/agents/auth-profiles/persisted.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../src/agents/auth-profiles/sqlite.js";
import {
  buildPersistedAuthProfileState,
  loadPersistedAuthProfileState,
} from "../../src/agents/auth-profiles/state.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";

const LIVE_OPENAI_PROFILE_ID = "openai:live";

function materializeLiveOpenAiProfile(tempStateDir: string, env: NodeJS.ProcessEnv): void {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return;
  }
  const targetAgentDir = path.join(tempStateDir, "agents", "main", "agent");
  fs.mkdirSync(targetAgentDir, { recursive: true });
  runAuthProfileWriteTransaction(
    targetAgentDir,
    (database) => {
      const persisted = inspectPersistedAuthProfileStoreRaw(targetAgentDir, database);
      const store =
        persisted.status === "readable"
          ? coercePersistedAuthProfileStore(persisted.raw)
          : { version: 1, profiles: {} };
      if (!store) {
        throw new Error("Could not safely materialize the live OpenAI auth profile.");
      }
      writePersistedAuthProfileStoreRaw(
        {
          version: store.version,
          profiles: {
            ...store.profiles,
            [LIVE_OPENAI_PROFILE_ID]: { type: "api_key", provider: "openai", key: apiKey },
          },
        },
        targetAgentDir,
        database,
      );

      const state = loadPersistedAuthProfileState(targetAgentDir, database);
      const openAiOrder = state.order?.openai ?? [];
      writePersistedAuthProfileStateRaw(
        buildPersistedAuthProfileState({
          ...state,
          order: {
            ...state.order,
            openai: [
              LIVE_OPENAI_PROFILE_ID,
              ...openAiOrder.filter((profileId) => profileId !== LIVE_OPENAI_PROFILE_ID),
            ],
          },
        }),
        targetAgentDir,
        database,
      );
    },
    { stateDir: tempStateDir },
  );
}

export function stageLiveAuthProfiles(
  realStateDir: string,
  tempStateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const agentsDir = path.join(realStateDir, "agents");
  for (const entry of fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir, { withFileTypes: true })
    : []) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourceAgentDir = path.join(agentsDir, entry.name, "agent");
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
        throw new Error(
          `Could not safely stage SQLite auth profiles for live agent "${entry.name}".`,
        );
      }
      continue;
    }
    const sourceStore = sourceSnapshot.value.store;
    const sourceState = sourceSnapshot.value.state;
    if (sourceStore.status === "unreadable" || sourceState.status === "unreadable") {
      throw new Error(
        `Could not safely stage SQLite auth profiles for live agent "${entry.name}".`,
      );
    }
    const storeTableMissing = sourceStore.status === "missing" && sourceStore.reason === "table";
    const stateTableMissing = sourceState.status === "missing" && sourceState.reason === "table";
    if (storeTableMissing || stateTableMissing) {
      throw new Error(
        `Could not safely stage SQLite auth profiles for live agent "${entry.name}": canonical auth schema is incomplete.`,
      );
    }
    if (sourceStore.status !== "readable" && sourceState.status !== "readable") {
      continue;
    }

    const targetAgentDir = path.join(tempStateDir, "agents", entry.name, "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    // Copy only canonical auth rows; cloning the agent database would expose
    // unrelated sessions to the isolated live-test home.
    runAuthProfileWriteTransaction(
      targetAgentDir,
      (database) => {
        if (sourceStore.status === "readable") {
          writePersistedAuthProfileStoreRaw(sourceStore.raw, targetAgentDir, database);
        }
        if (sourceState.status === "readable") {
          writePersistedAuthProfileStateRaw(sourceState.raw, targetAgentDir, database);
        }
      },
      { stateDir: tempStateDir },
    );
  }
  // OpenAI live checks intentionally resolve only from the isolated profile
  // store. Materialize the CI credential here so runtime auth never falls back
  // to the worker environment or the operator's real store.
  materializeLiveOpenAiProfile(tempStateDir, env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [realStateDir, tempStateDir] = process.argv.slice(2);
  if (!realStateDir || !tempStateDir) {
    throw new Error("Expected source and target state directories.");
  }
  stageLiveAuthProfiles(realStateDir, tempStateDir);
}
