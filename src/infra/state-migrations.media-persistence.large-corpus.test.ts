import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabases,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";

const SESSION_COUNT = 2_640;
const ACTIVE_SESSIONS = 40;
const EVENTS_PER_SESSION = 128;
const PAYLOAD = "x".repeat(48 * 1024);
const tempDir = useAutoCleanupTempDirTracker(afterEach);
const CHILD_SCRIPT = String.raw`
  import { createHash } from "node:crypto";
  import { DatabaseSync } from "node:sqlite";
  import { resolveOpenClawAgentSqlitePath } from "./src/state/openclaw-agent-db.ts";
  import { migrateLegacyMediaPersistence } from "./src/infra/state-migrations.media-persistence.ts";
  const path = resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env });
  let db = new DatabaseSync(path, { readOnly: true });
  const read = (session, seq) => db.prepare(
    "SELECT event_json FROM transcript_events WHERE session_id=? AND seq=?",
  ).get(session, seq).event_json;
  const readTrajectory = (seq) => db.prepare(
    "SELECT event_json FROM trajectory_runtime_events WHERE session_id=? AND seq=?",
  ).get("large-corpus-0", seq).event_json;
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const before = [hash(read("large-corpus-20", 64)), hash(read("large-corpus-39", 127))];
  db.close();
  const migration = migrateLegacyMediaPersistence({
    configuredAgentDatabaseTargets: [{ agentId: "main", path }], env: process.env,
  });
  db = new DatabaseSync(path, { readOnly: true });
  const count = (table) => db.prepare("SELECT COUNT(*) count FROM " + table).get().count;
  const first = JSON.parse(read("large-corpus-0", 0));
  const boundary = JSON.parse(read("large-corpus-0", 64));
  const trajectoryBoundary = JSON.parse(readTrajectory(64));
  process.stdout.write(JSON.stringify({
    warnings: migration.warnings,
    changeCount: migration.changes.length,
    sessions: count("session_nodes"), windows: count("session_windows"),
    events: count("transcript_events"),
    trajectoryEvents: count("trajectory_runtime_events"),
    firstIdentity: [first.type, first.id, first.parentId],
    firstMediaPath: first.message.__openclaw?.media?.[0]?.path,
    firstHasLegacyCarrier: Object.hasOwn(first.message, "MediaPath"),
    boundaryMediaPath: boundary.message.__openclaw?.media?.[0]?.path,
    boundaryHasLegacyCarrier: Object.hasOwn(boundary.message, "MediaPath"),
    trajectoryBoundaryMediaPath:
      trajectoryBoundary.data.messagesSnapshot[0].__openclaw?.media?.[0]?.path,
    trajectoryBoundaryHasLegacyCarrier: Object.hasOwn(
      trajectoryBoundary.data.messagesSnapshot[0],
      "MediaPath",
    ),
    middlePreserved: hash(read("large-corpus-20", 64)) === before[0],
    lastPreserved: hash(read("large-corpus-39", 127)) === before[1],
  }) + "\n");
  db.close();
`;

function createCorpus(stateDir: string): void {
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  database.db.exec("BEGIN");
  database.db
    .prepare(`WITH RECURSIVE n(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1 < ?
  ) INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at)
    SELECT 'agent:main:large-corpus-'||i, 'large-corpus-'||i,
      json_object('sessionId','large-corpus-'||i,'updatedAt',i+1), 1, i+1 FROM n`)
    .run(SESSION_COUNT);
  database.db
    .prepare(`WITH RECURSIVE n(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1 < ?
  ) INSERT INTO session_windows(session_id,session_key,created_at,updated_at)
    SELECT 'large-corpus-'||i, 'agent:main:large-corpus-'||i, i+1, i+1 FROM n`)
    .run(SESSION_COUNT);
  database.db
    .prepare(`WITH RECURSIVE s(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM s WHERE i+1 < ?
  ), e(seq) AS (VALUES(0) UNION ALL SELECT seq+1 FROM e WHERE seq+1 < ?)
  INSERT INTO transcript_events(session_id,seq,event_json,created_at)
    SELECT 'large-corpus-'||i, seq,
      json_object('type','message','id','event-'||i||'-'||seq,'parentId',NULL,'message',
        CASE WHEN i=0 AND seq=0
          THEN json_object('role','user','content',?,'MediaPath','/media/legacy.png')
          WHEN i=0 AND seq=64
          THEN json_object('role','user','content',?,'MediaPath','/media/boundary.png')
          ELSE json_object('role','user','content',?) END), seq+1 FROM s CROSS JOIN e`)
    .run(ACTIVE_SESSIONS, EVENTS_PER_SESSION, PAYLOAD, PAYLOAD, PAYLOAD);
  database.db
    .prepare(`WITH RECURSIVE e(seq) AS (
    VALUES(0) UNION ALL SELECT seq+1 FROM e WHERE seq+1 < ?
  ) INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at)
    SELECT 'large-corpus-0', seq, 'run-large-corpus',
      json_object('type','model.completed','data',json_object('messagesSnapshot',json_array(
        CASE WHEN seq=64
          THEN json_object('role','user','content','trajectory','MediaPath','/media/trajectory-boundary.png')
          ELSE json_object('role','user','content','trajectory') END))), seq+1 FROM e`)
    .run(EVENTS_PER_SESSION);
  database.db.exec("COMMIT; UPDATE session_nodes SET entry_valid=1");
  closeOpenClawAgentDatabases();
}

describe("legacy media persistence large corpus", () => {
  it("rewrites bounded batches under a 256 MiB old-space cap", () => {
    const stateDir = tempDir.make("openclaw-media-corpus-");
    try {
      createCorpus(stateDir);
      const result = spawnSync(
        process.execPath,
        ["--max-old-space-size=256", "--import", "tsx", "--input-type=module", "-e", CHILD_SCRIPT],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          timeout: 120_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        warnings: [],
        changeCount: 1,
        sessions: SESSION_COUNT,
        windows: SESSION_COUNT,
        events: ACTIVE_SESSIONS * EVENTS_PER_SESSION,
        trajectoryEvents: EVENTS_PER_SESSION,
        firstIdentity: ["message", "event-0-0", null],
        firstMediaPath: "/media/legacy.png",
        firstHasLegacyCarrier: false,
        boundaryMediaPath: "/media/boundary.png",
        boundaryHasLegacyCarrier: false,
        trajectoryBoundaryMediaPath: "/media/trajectory-boundary.png",
        trajectoryBoundaryHasLegacyCarrier: false,
        middlePreserved: true,
        lastPreserved: true,
      });
    } finally {
      closeOpenClawAgentDatabases();
      closeOpenClawStateDatabase();
    }
  }, 130_000);
});
