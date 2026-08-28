import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { STATE_SCHEMA_10_TO_9_DOWNGRADE_SQL } from "../state/openclaw-state-schema-v10-retirement.test-support.js";
import { STATE_SCHEMA_11_TO_10_TABLES_SQL } from "../state/openclaw-state-schema-v11-retirement.test-support.js";
import { STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL } from "../state/openclaw-state-schema-v12-foldin.test-support.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "../state/openclaw-state-schema-v13-widerow.test-support.js";
import { recordAuditEvent } from "./audit-event-store.js";
import type { OutboundMessageProgressInput } from "./audit-event-types.js";
import {
  createExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionToken,
} from "./execution-identity-admission.js";
import {
  countOutboundMessageAuditEventsForRun,
  pageOutboundMessageAuditEventsForRun,
} from "./message-delivery-audit-store.js";
import {
  pruneExpiredOutboundMessageProgress,
  recordOutboundMessageProgress,
} from "./message-delivery-progress-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PINNED_PRE_C04_READER_SHA = "5dc4cf602bc5e263e83cd16a12bb1e100544f4c3";
const OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT = 1_024;

function ensurePinnedReaderCommit(repositoryRoot: string): void {
  try {
    execFileSync("git", ["cat-file", "-e", `${PINNED_PRE_C04_READER_SHA}^{commit}`], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
  } catch {
    // CI checks out a depth-one synthetic merge. Fetch only the immutable proof
    // reader when that object is absent; never substitute the moving base ref.
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", PINNED_PRE_C04_READER_SHA], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
  }
}

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("message-progress-") } };
}

function progressInput(
  action: OutboundMessageProgressInput["action"],
  overrides: Partial<OutboundMessageProgressInput> = {},
): OutboundMessageProgressInput {
  const queued = action === "message.outbound.queued";
  return {
    sourceId: queued ? "queue:payload:0:queued" : "queue:payload:0:platform-started",
    sourceSequence: queued ? 1 : 2,
    occurredAt: Date.now(),
    kind: "message",
    action,
    status: "started",
    outcome: queued ? "queued" : "platform_started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-progress",
    direction: "outbound",
    channel: "qa-channel",
    conversationKind: "direct",
    durationMs: queued ? 1 : 2,
    resultCount: 0,
    accountId: "raw-account",
    conversationId: "raw-conversation",
    targetId: "raw-target",
    ...overrides,
  } as OutboundMessageProgressInput;
}

function terminalInput(
  overrides: {
    sourceId?: string;
    sourceSequence?: number;
    occurredAt?: number;
    runId?: string;
    executionIdentityToken?: ExecutionIdentityAdmissionToken;
  } = {},
) {
  return {
    sourceId: "queue:payload:0",
    sourceSequence: 3,
    occurredAt: Date.now(),
    kind: "message" as const,
    action: "message.outbound.finished" as const,
    status: "succeeded" as const,
    outcome: "sent" as const,
    actorType: "agent" as const,
    actorId: "main",
    agentId: "main",
    runId: "run-progress",
    direction: "outbound" as const,
    channel: "qa-channel",
    conversationKind: "direct" as const,
    durationMs: 3,
    resultCount: 1,
    accountId: "raw-account",
    conversationId: "raw-conversation",
    messageId: "raw-platform-message",
    targetId: "raw-target",
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("outbound message progress companion", () => {
  it("upgrades the predecessor progress table before a run-only insert", () => {
    const database = databaseOptions();
    const { db } = openOpenClawStateDatabase(database);
    const schema = fs
      .readFileSync(new URL("../state/openclaw-state-schema.sql", import.meta.url), "utf8")
      .replace("  context_id TEXT,\n  execution_id TEXT,\n", "");
    const start = schema.indexOf("CREATE TABLE IF NOT EXISTS outbound_message_progress (");
    const end = schema.indexOf(") STRICT;", start);
    db.exec(schema.slice(start, end + ") STRICT;".length));

    expect(
      recordOutboundMessageProgress(progressInput("message.outbound.queued"), database),
    ).toBeDefined();
    const columns = db.prepare("PRAGMA table_info(outbound_message_progress)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["context_id", "execution_id"]),
    );
  });

  it("stays absent through startup, reads, and terminal-only writes at the current schema", () => {
    const database = databaseOptions();
    const opened = openOpenClawStateDatabase(database);
    expect(opened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(OPENCLAW_STATE_SCHEMA_VERSION).toBe(13);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);
    expect(tableExists(opened.db, "outbound_message_execution_bindings")).toBe(false);

    expect(countOutboundMessageAuditEventsForRun({ runId: "missing", database })).toBe(0);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);

    recordAuditEvent(terminalInput(), database);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);
    expect(tableExists(opened.db, "outbound_message_execution_bindings")).toBe(false);
    expect(
      (
        opened.db
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action != ?")
          .get("message.outbound.finished") as { count: number }
      ).count,
    ).toBe(0);
  });

  it("ensures idempotently, deduplicates replay, and stores no raw message material", () => {
    const database = databaseOptions();
    const queued = progressInput("message.outbound.queued");
    const first = recordOutboundMessageProgress(queued, database);
    closeOpenClawStateDatabaseForTest();
    const recoveredReplay = recordOutboundMessageProgress(queued, database);
    recordOutboundMessageProgress(progressInput("message.outbound.platform-started"), database);

    expect(first).toMatchObject({ action: "message.outbound.queued", outcome: "queued" });
    expect(recoveredReplay).toBeUndefined();
    const { db } = openOpenClawStateDatabase(database);
    expect(tableExists(db, "outbound_message_progress")).toBe(true);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get() as {
          count: number;
        }
      ).count,
    ).toBe(2);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
    ).toBe(0);
    const stored = JSON.stringify(
      db.prepare("SELECT * FROM outbound_message_progress ORDER BY sequence").all(),
    );
    for (const raw of [
      "raw-account",
      "raw-conversation",
      "raw-target",
      "raw-platform-message",
      "message text",
      "https://example.test",
      "callback payload",
      "session-key",
      "secret-value",
    ]) {
      expect(stored).not.toContain(raw);
    }
  });

  it("merges tied progress and terminal rows with stable paging across restart", () => {
    const database = databaseOptions();
    const occurredAt = Date.now();
    recordOutboundMessageProgress(
      progressInput("message.outbound.queued", { occurredAt }),
      database,
    );
    recordOutboundMessageProgress(
      progressInput("message.outbound.platform-started", { occurredAt }),
      database,
    );
    recordAuditEvent(terminalInput({ occurredAt }), database);

    const first = pageOutboundMessageAuditEventsForRun({
      runId: "run-progress",
      database,
      now: occurredAt,
      limit: 1,
    });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    closeOpenClawStateDatabaseForTest();

    const second = pageOutboundMessageAuditEventsForRun({
      runId: "run-progress",
      database,
      now: occurredAt,
      after: first.nextCursor,
      limit: 2,
    });
    const allEntries = [...first.entries, ...second.entries];
    const all = allEntries.map((entry) => entry.event);
    expect(all.map((event) => event.outcome)).toEqual(["queued", "platform_started", "sent"]);
    expect(new Set(all.map((event) => event.eventId)).size).toBe(3);
    expect(new Set(allEntries.map((entry) => entry.rowId)).size).toBe(3);
    expect(
      pageOutboundMessageAuditEventsForRun({
        runId: "run-progress",
        database,
        now: occurredAt,
        limit: 3,
      }).entries,
    ).toEqual(allEntries);
    expect(
      countOutboundMessageAuditEventsForRun({ runId: "run-progress", database, now: occurredAt }),
    ).toBe(3);
  });

  it(`preserves the ${PINNED_PRE_C04_READER_SHA} terminal-only reader contract across reopen`, () => {
    const database = databaseOptions();
    const occurredAt = Date.now();
    recordOutboundMessageProgress(
      progressInput("message.outbound.queued", { occurredAt }),
      database,
    );
    recordOutboundMessageProgress(
      progressInput("message.outbound.platform-started", { occurredAt }),
      database,
    );
    recordAuditEvent(
      terminalInput({
        occurredAt,
        executionIdentityToken: createExecutionIdentityAdmissionToken("run-progress"),
      }),
      database,
    );
    openOpenClawStateDatabase(database);
    expect(
      tableExists(openOpenClawStateDatabase(database).db, "outbound_message_execution_bindings"),
    ).toBe(true);
    // This pinned reader predates the Workshop's first-use column and requires present lazy tables
    // to retain its exact shape; project that unrelated table to the reader's historical contract.
    // The v9-era reader needs the v13 projection removal, v12 singleton fold-in,
    // v11 curator retirement, and v10 dead-table retirement reversed in order.
    const projectedDatabase = openOpenClawStateDatabase(database).db;
    projectedDatabase.exec("ALTER TABLE skill_workshop_proposals DROP COLUMN claim_released_time;");
    projectedDatabase.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
    projectedDatabase.exec(STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL);
    projectedDatabase.exec(STATE_SCHEMA_11_TO_10_TABLES_SQL);
    projectedDatabase.exec(STATE_SCHEMA_10_TO_9_DOWNGRADE_SQL);
    closeOpenClawStateDatabaseForTest();

    const repositoryRoot = process.cwd();
    ensurePinnedReaderCommit(repositoryRoot);
    const checkoutParent = tempDirs.make("message-progress-pinned-reader-");
    const pinnedCheckout = path.join(checkoutParent, "checkout");
    execFileSync(
      "git",
      ["worktree", "add", "--detach", pinnedCheckout, PINNED_PRE_C04_READER_SHA],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
    try {
      fs.symlinkSync(
        path.join(repositoryRoot, "node_modules"),
        path.join(pinnedCheckout, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const pinnedResult = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `
            const stateDir = process.env.OPENCLAW_C04_PINNED_READER_STATE_DIR;
            const { listAuditEvents } = await import("./src/audit/audit-event-store.ts");
            const {
              closeOpenClawStateDatabaseForTest,
              openOpenClawStateDatabase,
            } = await import("./src/state/openclaw-state-db.ts");
            const database = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
            const opened = openOpenClawStateDatabase(database);
            const schemaVersion = opened.db.prepare("PRAGMA user_version").get().user_version;
            const quickCheck = opened.db.prepare("PRAGMA quick_check").get().quick_check;
            const events = listAuditEvents({
              filters: { runId: "run-progress", kind: "message", direction: "outbound" },
              limit: 10,
              database,
            }).events;
            closeOpenClawStateDatabaseForTest();
            console.log("C04_PINNED_READER_RESULT=" + JSON.stringify({
              schemaVersion,
              quickCheck,
              actions: events.map((event) => event.action),
              outcomes: events.map((event) => event.outcome),
            }));
          `,
        ],
        {
          cwd: pinnedCheckout,
          env: {
            ...process.env,
            OPENCLAW_C04_PINNED_READER_STATE_DIR: database.env.OPENCLAW_STATE_DIR,
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const resultLine = pinnedResult
        .split("\n")
        .find((line) => line.startsWith("C04_PINNED_READER_RESULT="));
      expect(resultLine).toBeDefined();
      expect(JSON.parse(resultLine?.slice("C04_PINNED_READER_RESULT=".length) ?? "null")).toEqual({
        schemaVersion: 9,
        quickCheck: "ok",
        actions: ["message.outbound.finished"],
        outcomes: ["sent"],
      });
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", pinnedCheckout], {
        cwd: repositoryRoot,
        stdio: "pipe",
      });
    }

    const reopened = openOpenClawStateDatabase(database).db;
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(reopened.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      pageOutboundMessageAuditEventsForRun({
        runId: "run-progress",
        database,
        now: occurredAt,
        limit: 10,
      }).entries.map((entry) => entry.event.outcome),
    ).toEqual(["queued", "platform_started", "sent"]);
    // A pinned-SHA worktree plus a cold tsx compile of the audit/state modules costs
    // minutes on a contended runner; the 120s default makes this fail by construction.
  }, 300_000);

  it("pages large offsets across bounded owner-stream chunks", () => {
    const database = databaseOptions();
    const occurredAt = Date.now();
    recordOutboundMessageProgress(
      progressInput("message.outbound.queued", { occurredAt }),
      database,
    );
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("DELETE FROM outbound_message_progress").run();
    const insert = db.prepare(`
      INSERT INTO outbound_message_progress (
        progress_id, source_id, source_sequence, schema_version, occurred_at,
        action, outcome, actor_type, actor_id, agent_id, run_id, channel,
        conversation_kind, duration_ms
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 'agent', 'main', 'main', 'run-progress',
        'qa-channel', 'direct', 1)
    `);
    db.exec("BEGIN");
    try {
      for (let index = 0; index < 300; index += 1) {
        for (const [stage, action, outcome] of [
          ["queued", "message.outbound.queued", "queued"],
          ["platform", "message.outbound.platform-started", "platform_started"],
        ] as const) {
          insert.run(
            `progress:${index}:${stage}`,
            `source:${index}:${stage}`,
            index * 2 + (stage === "queued" ? 1 : 2),
            occurredAt + index,
            action,
            outcome,
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const page = pageOutboundMessageAuditEventsForRun({
      runId: "run-progress",
      database,
      now: occurredAt,
      offset: 510,
      limit: 4,
    });
    expect(page.entries.map((entry) => entry.event.outcome)).toEqual([
      "queued",
      "platform_started",
      "queued",
      "platform_started",
    ]);
    expect(page.nextCursor).toBeDefined();
    expect(
      pageOutboundMessageAuditEventsForRun({
        runId: "run-progress",
        database,
        now: occurredAt,
        after: page.nextCursor,
        limit: 2,
      }).entries.map((entry) => entry.event.outcome),
    ).toEqual(["queued", "platform_started"]);
  });

  it("rejects a cursor whose owner row was pruned while preserving the other owner", () => {
    const database = databaseOptions();
    const occurredAt = Date.now();
    recordAuditEvent(terminalInput({ occurredAt }), database);
    recordOutboundMessageProgress(
      progressInput("message.outbound.queued", { occurredAt }),
      database,
    );
    const first = pageOutboundMessageAuditEventsForRun({
      runId: "run-progress",
      database,
      now: occurredAt,
      limit: 2,
    });
    const progress = first.entries.find((entry) => entry.event.outcome === "queued");
    expect(progress).toBeDefined();
    const progressCursor = {
      occurredAt,
      rowId: progress?.rowId ?? 0,
    };
    openOpenClawStateDatabase(database).db.prepare("DELETE FROM outbound_message_progress").run();

    expect(() =>
      pageOutboundMessageAuditEventsForRun({
        runId: "run-progress",
        database,
        now: occurredAt,
        after: progressCursor,
        limit: 1,
      }),
    ).toThrow("cursor is no longer retained");
    expect(
      pageOutboundMessageAuditEventsForRun({
        runId: "run-progress",
        database,
        now: occurredAt,
        limit: 10,
      }).entries.map((entry) => entry.event.outcome),
    ).toEqual(["sent"]);
  });

  it("prunes expired progress without touching retained terminal rows", () => {
    const database = databaseOptions();
    const occurredAt = Date.now() - 31 * 24 * 60 * 60_000;
    recordOutboundMessageProgress(
      progressInput("message.outbound.queued", { occurredAt }),
      database,
    );
    recordAuditEvent(terminalInput({ occurredAt: Date.now() }), database);

    pruneExpiredOutboundMessageProgress({ database, now: Date.now() });
    const { db } = openOpenClawStateDatabase(database);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
    ).toBe(1);
  });

  it("bounds each expired progress maintenance transaction", () => {
    const database = databaseOptions();
    recordOutboundMessageProgress(progressInput("message.outbound.queued"), database);
    const { db } = openOpenClawStateDatabase(database);
    db.exec("DELETE FROM outbound_message_progress");
    const now = Date.now();
    const expiredAt = now - 31 * 24 * 60 * 60_000;
    db.prepare(
      `WITH RECURSIVE numbers(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM numbers WHERE n < ?
       )
       INSERT INTO outbound_message_progress (
         progress_id, source_id, source_sequence, schema_version, occurred_at, action,
         outcome, actor_type, actor_id, agent_id, run_id, channel, conversation_kind
       )
       SELECT 'expired-progress-' || n, 'expired-progress-source-' || n, n, 1, ?,
              'message.outbound.queued', 'queued', 'agent', 'main', 'main',
              'expired-progress-run-' || n, 'qa-channel', 'direct'
       FROM numbers`,
    ).run(OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT + 1, expiredAt);

    expect(pruneExpiredOutboundMessageProgress({ database, now })).toBe(
      OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get()).toEqual({
      count: 1,
    });
    expect(pruneExpiredOutboundMessageProgress({ database, now })).toBe(1);
    expect(pruneExpiredOutboundMessageProgress({ database, now })).toBe(0);
  });
});
