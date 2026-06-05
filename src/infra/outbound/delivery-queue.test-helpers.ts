// Test helpers provide isolated delivery-queue state directories and logger
// stubs for queue/recovery tests.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import type { DeliverFn, RecoveryLogger } from "./delivery-queue.js";

/** Installs Vitest hooks that provide a fresh delivery-queue state dir per case. */
export function installDeliveryQueueTmpDirHooks(): { readonly tmpDir: () => string } {
  let tmpDir = "";
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-suite-"));
  });

  beforeEach(() => {
    tmpDir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    if (!fixtureRoot) {
      return;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  return {
    tmpDir: () => tmpDir,
  };
}

export function readQueuedEntry(tmpDir: string, id: string): Record<string, unknown> {
  const { db } = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } });
  const row = db
    .prepare(
      "SELECT entry_json FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?",
    )
    .get(id) as { entry_json?: string } | undefined;
  if (!row?.entry_json) {
    throw new Error(`Missing queued entry ${id}`);
  }
  return JSON.parse(row.entry_json) as Record<string, unknown>;
}

export function readQueuedEntries(tmpDir: string): Record<string, unknown>[] {
  const { db } = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } });
  const rows = db
    .prepare(
      `
        SELECT entry_json
          FROM delivery_queue_entries
         WHERE queue_name = 'outbound' AND status = 'pending'
         ORDER BY enqueued_at ASC, id ASC
      `,
    )
    .all() as Array<{ entry_json: string }>;
  return rows.map((row) => JSON.parse(row.entry_json) as Record<string, unknown>);
}

export function setQueuedEntryState(
  tmpDir: string,
  id: string,
  state: {
    retryCount: number;
    lastAttemptAt?: number;
    lastError?: string;
    enqueuedAt?: number;
    platformSendStartedAt?: number;
    recoveryState?: "send_attempt_started" | "unknown_after_send";
  },
): void {
  const entry = readQueuedEntry(tmpDir, id);
  entry.retryCount = state.retryCount;
  if (state.lastAttemptAt === undefined) {
    delete entry.lastAttemptAt;
  } else {
    entry.lastAttemptAt = state.lastAttemptAt;
  }
  if (state.enqueuedAt !== undefined) {
    entry.enqueuedAt = state.enqueuedAt;
  }
  if (state.lastError === undefined) {
    delete entry.lastError;
  } else {
    entry.lastError = state.lastError;
  }
  if (state.platformSendStartedAt !== undefined) {
    entry.platformSendStartedAt = state.platformSendStartedAt;
  }
  if (state.recoveryState !== undefined) {
    entry.recoveryState = state.recoveryState;
  }
  const { db } = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } });
  db.prepare(
    `
      UPDATE delivery_queue_entries
         SET retry_count = ?,
             enqueued_at = ?,
             last_attempt_at = ?,
             last_error = ?,
             platform_send_started_at = ?,
             recovery_state = ?,
             entry_json = ?,
             updated_at = ?
       WHERE queue_name = 'outbound' AND id = ?
    `,
  ).run(
    state.retryCount,
    state.enqueuedAt ?? Number(entry.enqueuedAt ?? 0),
    state.lastAttemptAt ?? null,
    state.lastError ?? null,
    state.platformSendStartedAt ?? null,
    state.recoveryState ?? null,
    JSON.stringify(entry),
    Date.now(),
    id,
  );
}

export function createRecoveryLog(): RecoveryLogger & {
  info: ReturnType<typeof vi.fn<(msg: string) => void>>;
  warn: ReturnType<typeof vi.fn<(msg: string) => void>>;
  error: ReturnType<typeof vi.fn<(msg: string) => void>>;
} {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  };
}

export function asDeliverFn(deliver: ReturnType<typeof vi.fn>): DeliverFn {
  return deliver as DeliverFn;
}
