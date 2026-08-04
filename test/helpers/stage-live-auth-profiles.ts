import fs from "node:fs";
import path from "node:path";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../src/agents/auth-profiles/sqlite.js";

const [realStateDir, tempStateDir] = process.argv.slice(2);

if (!realStateDir || !tempStateDir) {
  throw new Error("Expected source and target state directories.");
}

const agentsDir = path.join(realStateDir, "agents");
if (!fs.existsSync(agentsDir)) {
  process.exit(0);
}

for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const sourceAgentDir = path.join(agentsDir, entry.name, "agent");
  const sourceStore = inspectPersistedAuthProfileStoreRaw(sourceAgentDir);
  const sourceState = inspectPersistedAuthProfileStateRaw(sourceAgentDir);
  if (sourceStore.status === "unreadable" || sourceState.status === "unreadable") {
    throw new Error(`Could not safely stage SQLite auth profiles for live agent "${entry.name}".`);
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
