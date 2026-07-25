import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { CronJob } from "../types.js";
import {
  loadedCronStoreFromRows,
  loadCronRows,
  replaceCronRows,
  updateCronRuntimeRows,
} from "./row-codec.js";
import type { CronJobRow } from "./schema.js";
import { bindTriggerColumns, triggerFromRow } from "./trigger-codec.js";

describe("cron trigger SQLite codec", () => {
  it("round-trips trigger columns", () => {
    const columns = bindTriggerColumns({ script: "json({ fire: true })", once: true });
    expect(columns).toEqual({ trigger_script: "json({ fire: true })", trigger_once: 1 });
    expect(triggerFromRow(columns as CronJobRow)).toEqual({
      script: "json({ fire: true })",
      once: true,
    });
    expect(triggerFromRow(bindTriggerColumns(undefined) as CronJobRow)).toBeUndefined();
  });

  it("round-trips trigger state through updateCronRuntimeRows", async () => {
    const job = {
      id: "job-1",
      name: "watcher",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: "json({ fire: false })", once: false },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "changed" },
      state: {
        lastTriggerEvalAtMs: 10,
        triggerEvalCount: 3,
        lastTriggerFireAtMs: 8,
        triggerState: { status: "green" },
      },
    } satisfies CronJob;

    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-trigger-codec-"));
    const handle = openOpenClawStateDatabase({ path: path.join(fixtureRoot, "state.sqlite") });
    try {
      replaceCronRows(handle.db, "test", { version: 1, jobs: [{ ...job, state: {} }] });
      updateCronRuntimeRows(handle.db, "test", { version: 1, jobs: [job] });
      const [decoded] = loadedCronStoreFromRows(loadCronRows(handle.db, "test")).store.jobs;
      expect(decoded?.trigger).toEqual(job.trigger);
      expect(decoded?.state).toEqual(job.state);
    } finally {
      handle.walMaintenance.close();
      handle.db.close();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
