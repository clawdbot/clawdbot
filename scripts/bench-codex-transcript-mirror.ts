// Benchmarks the real Codex transcript mirror against a large indexed SQLite transcript.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { codexTranscriptMirrorRuntime } from "../extensions/codex/src/app-server/transcript-mirror.js";
import { attachCodexMirrorIdentity } from "../extensions/codex/src/app-server/upstream-prompt-provenance.js";
import { upsertSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { AgentMessage } from "../src/plugin-sdk/agent-core.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";

const DEFAULT_EVENT_COUNT = 100_000;
const DEFAULT_PAYLOAD_BYTES = 64;
const DEFAULT_RUNS = 8;
const DEFAULT_WARMUPS = 2;
const NEW_MESSAGES_PER_OPERATION = 2;

type MirrorTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

type WorkCounters = {
  fullTranscriptQueries: number;
  seededEventJsonParses: number;
  selectQueries: number;
};

function readIntegerArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function readSourceSha(): string {
  const value = process.argv
    .find((arg) => arg.startsWith("--source-sha="))
    ?.slice("--source-sha=".length);
  if (!value || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("benchmark requires --source-sha=<40-character commit SHA>");
  }
  const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  }).trim();
  if (checkoutSha !== value) {
    throw new Error(`source SHA ${value} does not match checkout HEAD ${checkoutSha}`);
  }
  return value;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const upperIndex = Math.floor(sorted.length / 2);
  const upper = sorted[upperIndex] ?? 0;
  const lower = sorted.length % 2 === 0 ? (sorted[upperIndex - 1] ?? upper) : upper;
  return Number(((lower + upper) / 2).toFixed(3));
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number((sorted[Math.max(0, index)] ?? 0).toFixed(3));
}

/** Seeds a fully indexed linear transcript without charging setup to measured owner calls. */
function seedTranscript(params: {
  database: ReturnType<typeof openOpenClawAgentDatabase>;
  eventCount: number;
  payloadText: string;
  sessionId: string;
}): void {
  const { database, eventCount, payloadText, sessionId } = params;
  const insertEvent = database.db.prepare(
    `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertIdentity = database.db.prepare(
    `INSERT INTO transcript_event_identities (
       session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
     ) VALUES (?, ?, ?, 'message', ?, ?, ?)`,
  );
  const insertActive = database.db.prepare(
    `INSERT INTO session_transcript_active_events (
       session_id, active_position, event_seq, message_position
     ) VALUES (?, ?, ?, ?)`,
  );
  const now = Date.now();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (let seq = 0; seq < eventCount; seq += 1) {
      const eventId = `benchmark-event-${seq}`;
      const parentId = seq === 0 ? null : `benchmark-event-${seq - 1}`;
      const idempotencyKey = `seed:${sessionId}:${seq}`;
      const role = seq % 2 === 0 ? "user" : "assistant";
      const event = {
        id: eventId,
        message: {
          content: role === "user" ? payloadText : [{ type: "text", text: payloadText }],
          idempotencyKey,
          role,
          timestamp: now + seq,
        },
        parentId,
        timestamp: now + seq,
        type: "message",
      };
      insertEvent.run(sessionId, seq, JSON.stringify(event), now + seq);
      const identityValues = [
        sessionId,
        eventId,
        seq,
        parentId,
        idempotencyKey,
        now + seq,
      ] satisfies SQLInputValue[];
      insertIdentity.run(...identityValues);
      insertActive.run(sessionId, seq, seq, seq);
    }
    database.db
      .prepare(
        `INSERT INTO session_transcript_index_state (
           session_id, indexed_seq, leaf_event_id, needs_rebuild,
           active_event_count, active_message_count, updated_at
         ) VALUES (?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        sessionId,
        eventCount - 1,
        `benchmark-event-${eventCount - 1}`,
        eventCount,
        eventCount,
        now + eventCount,
      );
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
}

function instrumentWork(database: ReturnType<typeof openOpenClawAgentDatabase>): {
  counters: WorkCounters;
  reset: () => void;
  restore: () => void;
} {
  const counters: WorkCounters = {
    fullTranscriptQueries: 0,
    seededEventJsonParses: 0,
    selectQueries: 0,
  };
  const originalPrepare = database.db.prepare.bind(database.db);
  const originalParse = JSON.parse;
  Object.defineProperty(database.db, "prepare", {
    configurable: true,
    value: (sql: string) => {
      const normalized = sql.replaceAll(/\s+/gu, " ").trim().toLowerCase();
      if (normalized.startsWith("select ")) {
        counters.selectQueries += 1;
      }
      if (
        /from "?transcript_events"?/u.test(normalized) &&
        normalized.includes("event_json") &&
        /order by "?seq"? asc/u.test(normalized)
      ) {
        counters.fullTranscriptQueries += 1;
      }
      return originalPrepare(sql);
    },
  });
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text.includes('"id":"benchmark-event-')) {
      counters.seededEventJsonParses += 1;
    }
    return originalParse(text, reviver);
  }) as typeof JSON.parse;
  return {
    counters,
    reset: () => {
      counters.fullTranscriptQueries = 0;
      counters.seededEventJsonParses = 0;
      counters.selectQueries = 0;
    },
    restore: () => {
      Object.defineProperty(database.db, "prepare", {
        configurable: true,
        value: originalPrepare,
      });
      JSON.parse = originalParse;
    },
  };
}

function buildPromptFinalBatch(ordinal: number): AgentMessage[] {
  return [
    attachCodexMirrorIdentity(
      {
        role: "user",
        content: `benchmark prompt ${ordinal}`,
        timestamp: 2_000_000_000_000 + ordinal,
      } as AgentMessage,
      `turn-${ordinal}:prompt`,
    ),
    attachCodexMirrorIdentity(
      {
        role: "assistant",
        content: [{ type: "text", text: `benchmark final ${ordinal}` }],
        timestamp: 2_000_000_100_000 + ordinal,
      } as AgentMessage,
      `turn-${ordinal}:assistant`,
    ),
  ];
}

async function runMirror(target: MirrorTarget, ordinal: number): Promise<void> {
  await codexTranscriptMirrorRuntime.mirror({
    ...target,
    idempotencyScope: "codex-app-server:benchmark",
    messages: buildPromptFinalBatch(ordinal),
  });
}

async function main(): Promise<void> {
  const sourceSha = readSourceSha();
  const eventCount = readIntegerArg("events", DEFAULT_EVENT_COUNT);
  const payloadBytes = readIntegerArg("payload-bytes", DEFAULT_PAYLOAD_BYTES);
  const runs = readIntegerArg("runs", DEFAULT_RUNS);
  const warmups = readIntegerArg("warmups", DEFAULT_WARMUPS);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-mirror-bench-"));
  const agentId = "benchmark";
  const sessionId = "codex-mirror-benchmark";
  const sessionKey = `agent:${agentId}:${sessionId}`;
  try {
    const database = openOpenClawAgentDatabase({
      agentId,
      path: path.join(stateDir, "openclaw-agent.sqlite"),
    });
    await upsertSessionEntry(
      { agentId, sessionKey, storePath: database.path },
      { sessionId, updatedAt: 1 },
    );
    seedTranscript({
      database,
      eventCount,
      payloadText: "x".repeat(payloadBytes),
      sessionId,
    });
    const target = { agentId, sessionId, sessionKey, storePath: database.path };
    const instrumentation = instrumentWork(database);
    try {
      for (let ordinal = 0; ordinal < warmups; ordinal += 1) {
        await runMirror(target, ordinal);
      }
      instrumentation.reset();
      const beforeMaxRssKb = process.resourceUsage().maxRSS;
      const durations: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        const startedAt = performance.now();
        await runMirror(target, warmups + run);
        durations.push(performance.now() - startedAt);
      }
      const afterMaxRssKb = process.resourceUsage().maxRSS;
      const measuredWork = { ...instrumentation.counters };
      const lastOrdinal = warmups + runs - 1;
      await runMirror(target, lastOrdinal);
      const row = database.db
        .prepare(
          `SELECT COUNT(*) AS count,
                  SUM(LENGTH(CAST(event_json AS BLOB))) AS bytes
             FROM transcript_events
            WHERE session_id = ?`,
        )
        .get(sessionId) as { bytes: number; count: number };
      const expectedEvents = eventCount + NEW_MESSAGES_PER_OPERATION * (warmups + runs);
      if (row.count !== expectedEvents) {
        throw new Error(`mirror wrote ${row.count} events; expected ${expectedEvents}`);
      }
      console.log(
        JSON.stringify(
          {
            sourceSha,
            fixture: {
              initialMessageEvents: eventCount,
              payloadBytes,
              sqliteTranscriptBytesAfterOperations: row.bytes,
            },
            operation: "real Codex mirror owner with one new prompt and one new final",
            runtime: {
              arch: process.arch,
              node: process.version,
              platform: `${os.platform()} ${os.release()}`,
            },
            warmups,
            runs,
            latencyMs: {
              median: median(durations),
              p95: percentile(durations, 0.95),
              raw: durations.map((value) => Number(value.toFixed(3))),
            },
            memoryProxy: {
              maxRssKbBeforeOperations: beforeMaxRssKb,
              maxRssKbAfterOperations: afterMaxRssKb,
              maxRssGrowthKb: Math.max(0, afterMaxRssKb - beforeMaxRssKb),
            },
            measuredWork: {
              ...measuredWork,
              perOperation: {
                fullTranscriptQueries: Number(
                  (measuredWork.fullTranscriptQueries / runs).toFixed(3),
                ),
                seededEventJsonParses: Number(
                  (measuredWork.seededEventJsonParses / runs).toFixed(3),
                ),
                selectQueries: Number((measuredWork.selectQueries / runs).toFixed(3)),
              },
            },
            correctness: {
              idempotentReplayAddedRows: 0,
              storedEventCount: row.count,
            },
          },
          null,
          2,
        ),
      );
    } finally {
      instrumentation.restore();
    }
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
}

await main();
