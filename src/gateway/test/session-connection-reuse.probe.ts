import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-connection-reuse-"));
const env = { OPENCLAW_STATE_DIR: stateDir };
let databasePath: string | undefined;
let movedPath: string | undefined;

try {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const openedPath = database.path;
  databasePath = openedPath;
  movedPath = `${openedPath}.connection-reuse-probe`;
  // Renaming preserves the live SQLite handle but makes any fresh path open fail,
  // turning connection reuse into an observable contract without module mocks.
  fs.renameSync(openedPath, movedPath);

  const inspections = Array.from({ length: 40 }, () =>
    inspectOpenClawAgentDatabaseOwner(openedPath),
  );
  if (inspections.some((entry) => entry.status !== "owned" || entry.agentId !== "main")) {
    throw new Error(`unexpected ownership inspections: ${JSON.stringify(inspections)}`);
  }
  process.stdout.write(`${JSON.stringify({ inspections: inspections.length })}\n`);
} finally {
  if (databasePath && movedPath && fs.existsSync(movedPath)) {
    fs.renameSync(movedPath, databasePath);
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
