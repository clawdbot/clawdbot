// Benchmarks generation-aware raw transcript reads against a 100k-event session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadTranscriptEventsSync,
  readTranscriptRawDelta,
} from "../src/config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";

const EVENT_COUNT = 100_000;
const DELTA_COUNT = 20;
const RUNS = 12;

type Timing = {
  p50Ms: number;
  p95Ms: number;
};

function percentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return Number((sorted[index] ?? 0).toFixed(3));
}

function measure(operation: () => void): Timing {
  const values: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
}

function seedTranscript(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionId: string,
  sessionKey: string,
): void {
  database.db.exec("BEGIN IMMEDIATE");
  try {
    const now = Date.now();
    database.db
      .prepare(
        `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
         VALUES (?, ?, '{}', ?)`,
      )
      .run(sessionKey, sessionId, now);
    database.db
      .prepare(
        `INSERT INTO session_windows (
           session_id, session_key, session_scope, created_at, updated_at
         ) VALUES (?, ?, 'conversation', ?, ?)`,
      )
      .run(sessionId, sessionKey, now, now);
    database.db
      .prepare(
        `INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
         VALUES (?, 'benchmark-generation', ?)`,
      )
      .run(sessionId, now);
    const insert = database.db.prepare(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (let seq = 0; seq < EVENT_COUNT; seq += 1) {
      insert.run(
        sessionId,
        seq,
        JSON.stringify({ id: `event-${seq}`, text: "x".repeat(64), type: "custom" }),
        now + seq,
      );
    }
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
}

function appendDelta(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionId: string,
): void {
  const insert = database.db.prepare(
    `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (let offset = 0; offset < DELTA_COUNT; offset += 1) {
      const seq = EVENT_COUNT + offset;
      insert.run(
        sessionId,
        seq,
        JSON.stringify({ id: `delta-${offset}`, text: "delta", type: "custom" }),
        Date.now() + offset,
      );
    }
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
}

function readFrontierCursor(scope: Parameters<typeof readTranscriptRawDelta>[0]): string {
  let cursor: string | undefined;
  for (;;) {
    const page = readTranscriptRawDelta(scope, {
      ...(cursor ? { cursor } : {}),
      maxBytes: 64 * 1024 * 1024,
      maxEvents: 10_000,
    });
    if (page.kind !== "page") {
      throw new Error(`unexpected cursor bootstrap result: ${page.kind}`);
    }
    cursor = page.cursor;
    if (!page.hasMore) {
      return cursor;
    }
  }
}

function main(): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-bench-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const agentId = "benchmark";
  const sessionId = "cursor-benchmark";
  const sessionKey = `agent:${agentId}:cursor-benchmark`;
  try {
    const database = openOpenClawAgentDatabase({ agentId, env });
    seedTranscript(database, sessionId, sessionKey);
    const scope = { agentId, sessionId, sessionKey, storePath: database.path };

    const bootstrap = measure(() => {
      const page = readTranscriptRawDelta(scope, { maxBytes: 1_000_000, maxEvents: 1_000 });
      if (page.kind !== "page" || page.events.length !== 1_000) {
        throw new Error("raw bootstrap did not return 1,000 events");
      }
    });
    const activeMemoryBounded = measure(() => {
      const page = readTranscriptRawDelta(scope, {
        maxBytes: 50 * 1024 * 1024,
        maxEvents: 2_000,
      });
      if (page.kind !== "page" || page.events.length !== 2_000) {
        throw new Error("active-memory bounds did not return 2,000 events");
      }
    });
    const frontierCursor = readFrontierCursor(scope);
    appendDelta(database, sessionId);
    const shortDelta = measure(() => {
      const page = readTranscriptRawDelta(scope, {
        cursor: frontierCursor,
        maxBytes: 1_000_000,
        maxEvents: 100,
      });
      if (page.kind !== "page" || page.events.length !== DELTA_COUNT || page.hasMore) {
        throw new Error("raw delta did not return the appended frontier");
      }
    });
    const fullRead = measure(() => {
      if (loadTranscriptEventsSync(scope).length !== EVENT_COUNT + DELTA_COUNT) {
        throw new Error("full transcript read returned the wrong row count");
      }
    });

    console.log(
      JSON.stringify(
        {
          events: EVENT_COUNT,
          appendedEvents: DELTA_COUNT,
          runs: RUNS,
          timings: { activeMemoryBounded, bootstrap, fullRead, shortDelta },
        },
        null,
        2,
      ),
    );
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
}

main();
