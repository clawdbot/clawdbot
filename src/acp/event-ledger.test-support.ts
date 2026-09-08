import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createSqliteAcpEventLedger, type AcpEventLedger } from "./event-ledger.js";
import type { AcpLedgerOptions } from "./event-ledger.types.js";

type TestAcpLedgerHandle = {
  databasePath: string;
  tempDir: string;
};

const testLedgerHandles: TestAcpLedgerHandle[] = [];

/** Creates a test-owned SQLite ACP ledger and registers its DB/tempdir cleanup. */
export function createTestAcpEventLedger(options: AcpLedgerOptions = {}): AcpEventLedger {
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-acp-ledger-")));
  const databasePath = path.join(tempDir, "openclaw.sqlite");
  testLedgerHandles.push({ databasePath, tempDir });
  return createSqliteAcpEventLedger({ ...options, path: databasePath });
}

export async function withTestAcpEventLedgerDatabase<T>(
  fn: (paths: { databasePath: string }) => T | Promise<T>,
): Promise<T> {
  return await withTestDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
    const databasePath = path.join(dir, "openclaw.sqlite");
    try {
      return await fn({ databasePath });
    } finally {
      closeOpenClawStateDatabaseByPath(databasePath);
    }
  });
}

function closeTestAcpEventLedgers(): void {
  const handles = testLedgerHandles.splice(0).toReversed();
  const errors: unknown[] = [];
  for (const { databasePath, tempDir } of handles) {
    try {
      closeOpenClawStateDatabaseByPath(databasePath);
    } catch (error) {
      errors.push(error);
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to clean up ACP test event ledgers");
  }
}

afterEach(() => {
  closeTestAcpEventLedgers();
});

/** Independent stored-content ground truth, including NUL and replacement characters. */
export function expectAcpReplayUtf8Accounting(db: DatabaseSync): number {
  const encoder = new TextEncoder();
  const bytes = (value: unknown) => (typeof value === "string" ? encoder.encode(value).length : 0);
  const sessions = db.prepare("SELECT * FROM acp_replay_sessions ORDER BY session_id").all();
  const events = db.prepare("SELECT * FROM acp_replay_events ORDER BY session_id, seq").all();
  let total = 0;
  for (const session of sessions) {
    let expected = bytes(session.session_id) + bytes(session.session_key) + bytes(session.cwd) + 32;
    for (const event of events.filter((row) => row.session_id === session.session_id)) {
      const eventBytes =
        bytes(event.session_id) +
        bytes(event.session_key) +
        bytes(event.run_id) +
        bytes(event.update_json) +
        32;
      expect(Number(event.estimated_bytes)).toBe(eventBytes);
      expected += eventBytes;
    }
    expect(Number(session.estimated_bytes)).toBe(expected);
    total += expected;
  }
  return total;
}
