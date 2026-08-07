import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { pruneExpiredAuditEvents, recordAuditEvent } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const AUDIT_EVENT_RETENTION_MS_CONTRACT = 30 * 24 * 60 * 60_000;

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-adoption-") } };
}

function auditInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  const input = {
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  } as AuditEventInput;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("audit event source adoption", () => {
  it("adopts one equivalent generation-aware replay against a shipped legacy source key", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const legacySourceId = `run-legacy:1:${occurredAt}:agent.run.started`;
    expect(
      recordAuditEvent(
        auditInput({ sourceId: legacySourceId, sourceSequence: 1, occurredAt }),
        database,
      ),
    ).toBeDefined();
    const { db: legacyDb } = openOpenClawStateDatabase(database);
    legacyDb.exec("DROP TABLE audit_event_source_adoptions");
    closeOpenClawStateDatabaseForTest();

    expect(
      recordAuditEvent(
        auditInput({
          sourceId: `lifecycle:generation-1:${legacySourceId}`,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
        }),
        database,
      ),
    ).toBeUndefined();
    expect(
      recordAuditEvent(
        auditInput({
          sourceId: `lifecycle:generation-1:${legacySourceId}`,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
          actorId: "changed-after-adoption",
        }),
        database,
      ),
    ).toBeUndefined();
    closeOpenClawStateDatabaseForTest();
    expect(
      recordAuditEvent(
        auditInput({
          sourceId: `lifecycle:generation-2:${legacySourceId}`,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
        }),
        database,
      ),
    ).toBeDefined();

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare("SELECT source_id FROM audit_events ORDER BY sequence")
        .all()
        .map((row) => (row as { source_id: string }).source_id),
    ).toEqual([legacySourceId, `lifecycle:generation-2:${legacySourceId}`]);
    expect(db.prepare("SELECT * FROM audit_event_source_adoptions").all()).toEqual([
      {
        legacy_source_id: legacySourceId,
        adopted_source_id: `lifecycle:generation-1:${legacySourceId}`,
      },
    ]);
  });

  it("adopts an equivalent tool replay when the tool name is absent", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const legacySourceId = `run-tool:1:${occurredAt}:tool.action.started`;
    // Recreate the shipped row shape that allowed tool_name to remain NULL
    // before current producers enforced a normalized tool name.
    const legacyInput = auditInput({
      sourceId: legacySourceId,
      sourceSequence: 1,
      occurredAt,
      kind: "tool_action",
      action: "tool.action.started",
      status: "started",
      toolCallId: "call-1",
    });
    expect(recordAuditEvent(legacyInput, database)).toBeDefined();
    const { db: legacyDb } = openOpenClawStateDatabase(database);
    legacyDb.exec("DROP TABLE audit_event_source_adoptions");
    closeOpenClawStateDatabaseForTest();

    const replayInput = {
      ...legacyInput,
      sourceId: `tool:generation-1:${legacySourceId}`,
      legacySourceId,
      toolName: "bash",
    } as AuditEventInput;
    expect(recordAuditEvent(replayInput, database)).toBeUndefined();

    const { db } = openOpenClawStateDatabase(database);
    expect(db.prepare("SELECT source_id FROM audit_events").all()).toEqual([
      { source_id: legacySourceId },
    ]);
  });

  it("reserves a legacy source for the first non-equivalent versioned event", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const legacySourceId = `run-reserved:1:${occurredAt}:agent.run.started`;
    expect(
      recordAuditEvent(
        auditInput({ sourceId: legacySourceId, sourceSequence: 1, occurredAt }),
        database,
      ),
    ).toBeDefined();
    const { db: legacyDb } = openOpenClawStateDatabase(database);
    legacyDb.exec("DROP TABLE audit_event_source_adoptions");
    closeOpenClawStateDatabaseForTest();

    const firstVersionedSourceId = `lifecycle:generation-1:${legacySourceId}`;
    expect(
      recordAuditEvent(
        auditInput({
          sourceId: firstVersionedSourceId,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
          actorId: "generation-1",
          agentId: "generation-1",
        }),
        database,
      ),
    ).toBeDefined();
    const secondVersionedSourceId = `lifecycle:generation-2:${legacySourceId}`;
    expect(
      recordAuditEvent(
        auditInput({
          sourceId: secondVersionedSourceId,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
        }),
        database,
      ),
    ).toBeDefined();

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare("SELECT source_id FROM audit_events ORDER BY sequence")
        .all()
        .map((row) => (row as { source_id: string }).source_id),
    ).toEqual([legacySourceId, firstVersionedSourceId, secondVersionedSourceId]);
    expect(db.prepare("SELECT * FROM audit_event_source_adoptions").all()).toEqual([
      {
        legacy_source_id: legacySourceId,
        adopted_source_id: firstVersionedSourceId,
      },
    ]);
  });

  it("prunes orphaned source adoptions after a process restart", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const legacySourceId = `run-expired:1:${occurredAt}:agent.run.started`;
    expect(
      recordAuditEvent(
        auditInput({ sourceId: legacySourceId, sourceSequence: 1, occurredAt }),
        database,
      ),
    ).toBeDefined();
    expect(
      recordAuditEvent(
        auditInput({
          sourceId: `lifecycle:generation-1:${legacySourceId}`,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
        }),
        database,
      ),
    ).toBeUndefined();
    closeOpenClawStateDatabaseForTest();

    pruneExpiredAuditEvents({
      database,
      now: occurredAt + AUDIT_EVENT_RETENTION_MS_CONTRACT + 1,
    });

    const { db } = openOpenClawStateDatabase(database);
    expect(db.prepare("SELECT source_id FROM audit_events").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM audit_event_source_adoptions").all()).toEqual([]);
  });

  it("does not materialize the lazy adoption table during cleanup", () => {
    const database = createDatabaseOptions();
    const tableQuery =
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'audit_event_source_adoptions'";
    const { db } = openOpenClawStateDatabase(database);
    db.exec("DROP TABLE audit_event_source_adoptions");
    closeOpenClawStateDatabaseForTest();
    expect(openOpenClawStateDatabase(database).db.prepare(tableQuery).get()).toBeUndefined();
    closeOpenClawStateDatabaseForTest();

    pruneExpiredAuditEvents({ database });

    expect(openOpenClawStateDatabase(database).db.prepare(tableQuery).get()).toBeUndefined();
  });
});
