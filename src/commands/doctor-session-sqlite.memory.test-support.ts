import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

export const sqliteImportMemorySupportUrl = import.meta.url;

async function main() {
  const [stateDir, scenario] = process.argv.slice(2);
  assert(stateDir && scenario);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  const sessionCount = scenario === "batch" ? 256 : 1;
  const eventCount = scenario === "deep" ? 100_000 : scenario === "batch" ? 64 : 8;
  const payloadBytes = scenario === "deep" ? 4096 : scenario === "batch" ? 32768 : 256;
  const sessionsDir = path.join(stateDir, "agents/main/sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const store: Record<string, { sessionId: string; updatedAt: number; sessionFile: string }> = {};
  const expected = new Map<string, string>();
  const timestamp = 1_800_000_000_000;
  for (let session = 0; session < sessionCount; session++) {
    const sessionId = `memory-${session}`;
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    store[`agent:main:memory-${session}`] = {
      sessionId,
      updatedAt: timestamp,
      sessionFile: transcriptPath,
    };
    const fd = fs.openSync(transcriptPath, "wx", 0o600);
    const hash = createHash("sha256");
    const write = (event: unknown) => {
      const json = JSON.stringify(event);
      hash.update(json).update("\n");
      fs.writeSync(fd, `${json}\n`);
    };
    try {
      write({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(timestamp).toISOString(),
        cwd: "/fixture",
      });
      for (let index = 0; index < eventCount; index++) {
        write({
          type: "message",
          id: `e-${index}`,
          parentId: index === 0 ? null : `e-${index - 1}`,
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: `call-${index}`,
            toolName: "exec",
            isError: false,
            content: [{ type: "text", text: `${session}:${index}:é🦞${"x".repeat(payloadBytes)}` }],
            timestamp,
          },
        });
      }
      // Force the full projection owner, including a deep selected ancestry.
      write({
        type: "leaf",
        id: "selected-leaf",
        parentId: `e-${eventCount - 1}`,
        targetId: `e-${eventCount - 2}`,
      });
    } finally {
      fs.closeSync(fd);
    }
    expected.set(sessionId, hash.digest("hex"));
  }
  fs.writeFileSync(storePath, JSON.stringify(store));
  process.stderr.write(`seeded ${sessionCount} sessions x ${eventCount} events; importing\n`);
  const started = performance.now();
  const report = await runDoctorSessionSqlite({
    mode: "import",
    store: storePath,
    env: process.env,
  });
  assert.equal(report.totals.issues, 0, JSON.stringify(report.targets.map((t) => t.issues)));
  assert.equal(report.totals.importedEntries, sessionCount);
  assert.equal(report.totals.importedTranscriptEvents, sessionCount * (eventCount + 2));
  const db = openNodeSqliteDatabase(resolveTargetSqlitePath({ agentId: "main", storePath }), {
    readOnly: true,
  });
  try {
    const read = db.prepare(
      "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
    );
    for (const [sessionId, digest] of expected) {
      const hash = createHash("sha256");
      for (const row of read.iterate(sessionId)) {
        hash.update(String(row.event_json)).update("\n");
      }
      assert.equal(hash.digest("hex"), digest);
      assert.deepEqual(
        {
          ...db
            .prepare(
              "SELECT active_event_count, active_message_count, leaf_event_id, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(sessionId),
        },
        {
          active_event_count: eventCount - 1,
          active_message_count: eventCount - 1,
          leaf_event_id: `e-${eventCount - 2}`,
          needs_rebuild: 0,
        },
      );
    }
  } finally {
    db.close();
  }
  const rerun = await runDoctorSessionSqlite({
    mode: "import",
    store: storePath,
    env: process.env,
  });
  assert.equal(rerun.totals.importedEntries, 0);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  process.stdout.write(
    JSON.stringify({
      scenario,
      sessionCount,
      eventCount,
      elapsedMs: performance.now() - started,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
