/**
 * sessions.list resolves row owners through the session SQLite target path.
 * That owner read must reuse a process-held handle instead of opening per row.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");

function buildConnectionReuseProbe(): string {
  const agentDbUrl = pathToFileURL(path.join(repoRoot, "src/state/openclaw-agent-db.ts")).href;
  const stateDbUrl = pathToFileURL(path.join(repoRoot, "src/state/openclaw-state-db.ts")).href;
  return `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const agentDb = await import(${JSON.stringify(agentDbUrl)});
const stateDb = await import(${JSON.stringify(stateDbUrl)});
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-connection-reuse-"));
const env = { OPENCLAW_STATE_DIR: stateDir };
let databasePath;
let movedPath;
try {
  const database = agentDb.openOpenClawAgentDatabase({ agentId: "main", env });
  databasePath = database.path;
  movedPath = databasePath + ".connection-reuse-probe";
  // The live handle survives this rename; a fresh pathname open does not.
  fs.renameSync(databasePath, movedPath);
  const inspections = Array.from({ length: 40 }, () =>
    agentDb.inspectOpenClawAgentDatabaseOwner(databasePath),
  );
  if (inspections.some((entry) => entry.status !== "owned" || entry.agentId !== "main")) {
    throw new Error("unexpected ownership inspections: " + JSON.stringify(inspections));
  }
  process.stdout.write(JSON.stringify({ inspections: inspections.length }) + "\\n");
} finally {
  if (databasePath && movedPath && fs.existsSync(movedPath)) {
    fs.renameSync(movedPath, databasePath);
  }
  agentDb.closeOpenClawAgentDatabasesForTest();
  stateDb.closeOpenClawStateDatabaseForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
`;
}

test.runIf(process.platform !== "win32")(
  "sessions.list owner reads reuse the process-held connection",
  async () => {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", buildConnectionReuseProbe()],
      { cwd: repoRoot, maxBuffer: 1024 * 1024 },
    );

    expect(JSON.parse(result.stdout) as unknown).toEqual({ inspections: 40 });
  },
);
