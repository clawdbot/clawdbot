import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "./update-run-watcher.js";

vi.mock("./update-run-notice.runtime.js", () => ({ notifyUpdateRunPhase: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const now = Date.parse("2026-09-07T12:00:00Z");
const graceMs = 5 * 60_000;
let watcher: ReturnType<typeof startUpdateRunWatcher> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-watcher-publication-"));
});
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function createDeferredState() {
  const { db } = openOpenClawStateDatabase();
  const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
  // The runner tests cover the v15 rewrite; this fixture starts at its committed result.
  db.prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
    VALUES ('state.schema.contentVersion', ?, ?)`).run(String(OPENCLAW_STATE_SCHEMA_VERSION), now);
  db.exec(`PRAGMA user_version = 15;
    UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
  closeOpenClawStateDatabaseForTest();
  return { db: openOpenClawStateDatabase().db, runId: run.runId };
}

function expectVersion(db: DatabaseSync, version: number) {
  // Read the held SQLite connection directly: opening a new runner would hide a broken timer.
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: version });
}

function startWatcher() {
  const log = { warn: vi.fn() };
  watcher = startUpdateRunWatcher({ broadcast: vi.fn(), log });
  return log;
}

describe("Gateway schema publication timer", () => {
  it("anchors a restarted watcher's timer to the existing terminal timestamp", async () => {
    const { db, runId } = createDeferredState();
    finishUpdateRun(runId, { status: "succeeded" });
    vi.setSystemTime(now + 2 * 60_000);
    const log = startWatcher();
    expectVersion(db, 15);
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expectVersion(db, 15);
    await vi.advanceTimersByTimeAsync(1);
    expectVersion(db, OPENCLAW_STATE_SCHEMA_VERSION);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("publishes after observing the old updater finish without another database open", async () => {
    const { db, runId } = createDeferredState();
    const log = startWatcher();
    await vi.advanceTimersByTimeAsync(10_000);
    finishUpdateRun(runId, { status: "succeeded" });
    await vi.advanceTimersByTimeAsync(graceMs - 1);
    expectVersion(db, 15);
    await vi.advanceTimersByTimeAsync(1);
    expectVersion(db, OPENCLAW_STATE_SCHEMA_VERSION);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rechecks new running rows at the deadline and reschedules for their terminal grace", async () => {
    const { db, runId } = createDeferredState();
    finishUpdateRun(runId, { status: "succeeded" });
    const log = startWatcher();
    await vi.advanceTimersByTimeAsync(graceMs - 1);
    const next = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    // No wake: the already scheduled timer must discover this new driver itself.
    await vi.advanceTimersByTimeAsync(1);
    expectVersion(db, 15);
    wakeUpdateRunWatcher();
    finishUpdateRun(next.runId, { status: "succeeded" });
    await vi.advanceTimersByTimeAsync(graceMs - 1);
    expectVersion(db, 15);
    await vi.advanceTimersByTimeAsync(1);
    expectVersion(db, OPENCLAW_STATE_SCHEMA_VERSION);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("cancels pending publication when the watcher stops", async () => {
    const { db, runId } = createDeferredState();
    finishUpdateRun(runId, { status: "succeeded" });
    const log = startWatcher();
    await watcher?.stop();
    wakeUpdateRunWatcher();
    await vi.advanceTimersByTimeAsync(graceMs + 1);
    expectVersion(db, 15);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
