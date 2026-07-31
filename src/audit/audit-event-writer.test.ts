import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listAuditEvents } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";
import { createAuditEventWriter } from "./audit-event-writer.js";

const tempDirs: string[] = [];

function input(): AuditEventInput {
  return {
    sourceId: "run-1:1:started",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-1",
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("audit event worker", () => {
  it("returns immediately under SQLite contention and flushes before stop", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    await writer.ready;
    const { db } = openOpenClawStateDatabase(database);
    db.exec("BEGIN IMMEDIATE");
    const startedAt = performance.now();
    expect(writer.record(input())).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(250);
    db.exec("ROLLBACK");

    await writer.stop();
    expect(errors).toEqual([]);
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(1);
  });
});
