import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEvent } from "./audit-event-store.js";
import type { OutboundMessageProgressInput } from "./audit-event-types.js";
import {
  countOutboundMessageAuditEventsForRun,
  pageOutboundMessageAuditEventsForRun,
} from "./message-delivery-audit-store.js";
import {
  pruneExpiredOutboundMessageProgress,
  recordOutboundMessageProgress,
} from "./message-delivery-progress-store.js";

const tempDirs: string[] = [];

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "message-progress-") } };
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

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("outbound message progress companion", () => {
  it("stays absent through startup, reads, and terminal-only writes at schema v7", () => {
    const database = databaseOptions();
    const opened = openOpenClawStateDatabase(database);
    expect(OPENCLAW_STATE_SCHEMA_VERSION).toBe(7);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);

    expect(countOutboundMessageAuditEventsForRun({ runId: "missing", database })).toBe(0);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);

    recordAuditEvent(terminalInput(), database);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);
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
    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    closeOpenClawStateDatabaseForTest();

    const second = pageOutboundMessageAuditEventsForRun({
      runId: "run-progress",
      database,
      now: occurredAt,
      after: first.nextCursor,
      limit: 2,
    });
    const all = [...first.events, ...second.events];
    expect(all.map((event) => event.outcome)).toEqual(["queued", "platform_started", "sent"]);
    expect(new Set(all.map((event) => event.eventId)).size).toBe(3);
    expect(
      countOutboundMessageAuditEventsForRun({ runId: "run-progress", database, now: occurredAt }),
    ).toBe(3);
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
    const progress = first.events.find((event) => event.outcome === "queued");
    expect(progress).toBeDefined();
    const progressCursor = {
      occurredAt,
      rowId: progress?.sequence ?? 0,
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
      }).events.map((event) => event.outcome),
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
});
