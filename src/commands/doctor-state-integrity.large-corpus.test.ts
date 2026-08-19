import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabases,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";

const LARGE_CORPUS_SCRIPT = String.raw`
  import fs from "node:fs";
  import { noteStateIntegrity } from "./src/commands/doctor-state-integrity.ts";
  import { resolveOpenClawAgentSqlitePath } from "./src/state/openclaw-agent-db.ts";
  import { closeOpenClawAgentDatabases } from "./src/state/openclaw-agent-db.ts";
  import { closeOpenClawStateDatabase } from "./src/state/openclaw-state-db.ts";
  import { migrateLegacyMediaPersistence } from "./src/infra/state-migrations.media-persistence.ts";

  try {
    const migration = migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [
        {
          agentId: "main",
          path: resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env }),
        },
      ],
      env: process.env,
    });
    if (migration.warnings.length > 0) {
      throw new Error(migration.warnings.join("\n"));
    }
    await noteStateIntegrity(
      { agents: { entries: { main: { default: true } } } },
      { confirmRuntimeRepair: async () => false, note: () => {} },
    );
    process.stdout.write(
      JSON.stringify({
        maxRssMiB: process.resourceUsage().maxRSS / 1024,
        sessionCount: 2_640,
      }) + "\n",
    );
  } finally {
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabase();
  }
`;

function createLargeSessionCorpus(stateDir: string): void {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const insert = database.db.prepare(
    "INSERT INTO session_nodes " +
      "(session_key, current_session_id, entry_json, entry_valid, updated_at) " +
      "VALUES (?, ?, ?, 1, ?)",
  );
  const insertWindow = database.db.prepare(
    "INSERT INTO session_windows " +
      "(session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  const insertEvent = database.db.prepare(
    "INSERT INTO transcript_events " +
      "(session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
  );
  const payload = "x".repeat(96 * 1024);
  database.db.exec("BEGIN");
  for (let index = 0; index < 2_640; index += 1) {
    const sessionId = `large-corpus-${index}`;
    const sessionKey = `agent:main:${sessionId}`;
    insert.run(
      sessionKey,
      sessionId,
      JSON.stringify({
        sessionId,
        updatedAt: index + 1,
      }),
      index + 1,
    );
    insertWindow.run(sessionId, sessionKey, index + 1, index + 1);
    insertEvent.run(
      sessionId,
      JSON.stringify({
        id: `event-${index}`,
        message: { content: payload, role: "user" },
        parentId: null,
        type: "message",
      }),
      index + 1,
    );
  }
  database.db.exec("COMMIT");
  database.db.exec("UPDATE session_nodes SET entry_valid = 1");
  closeOpenClawAgentDatabases();
}

describe("doctor state integrity large corpus", () => {
  it("completes a 2,640-session SQLite scan under a 256 MiB old-space cap", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-large-corpus-"));
    try {
      createLargeSessionCorpus(stateDir);
      const result = spawnSync(
        process.execPath,
        [
          "--max-old-space-size=256",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          LARGE_CORPUS_SCRIPT,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: stateDir,
            OPENCLAW_HOME: stateDir,
            OPENCLAW_STATE_DIR: stateDir,
          },
          timeout: 120_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ sessionCount: 2_640 });
    } finally {
      closeOpenClawAgentDatabases();
      closeOpenClawStateDatabase();
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  }, 130_000);
});
