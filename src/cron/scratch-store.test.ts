import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "./scratch-contract.js";
import {
  hashCronScratchSource,
  readCronJobScratchState,
  writeCronJobScratch,
} from "./scratch-store.js";
import { cronStoreKey } from "./store/key.js";
import { replaceCronRows, upsertCronJobRow } from "./store/row-codec.js";
import type { CronJob } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-scratch-"));
  tempDirs.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const fixture = {
    storePath: path.join(root, "cron", "jobs.json"),
    options: { env },
  };
  const job: CronJob = {
    id: "job-1",
    name: "scratch-owner",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
  };
  runOpenClawStateWriteTransaction(
    ({ db }) => upsertCronJobRow(db, cronStoreKey(fixture.storePath), job, 0),
    fixture.options,
  );
  return fixture;
}

describe("cron job scratch store", () => {
  it("distinguishes no row from present-empty content", async () => {
    const fixture = await createFixture();
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 0,
    });

    const write = writeCronJobScratch({
      ...fixture,
      jobId: "job-1",
      content: "",
      nowMs: 10,
    });

    expect(write).toEqual({
      ok: true,
      currentRevision: 1,
      scratch: { content: "", revision: 1, updatedAtMs: 10 },
    });
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 1,
      scratch: { content: "", revision: 1, updatedAtMs: 10 },
    });
  });

  it("compare-and-swaps revisions and keeps a tombstone across unset", async () => {
    const fixture = await createFixture();
    writeCronJobScratch({ ...fixture, jobId: "job-1", content: "first", nowMs: 10 });

    expect(
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "stale",
        expectedRevision: 0,
        nowMs: 20,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 1 });

    expect(
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "second",
        expectedRevision: 1,
        nowMs: 30,
      }),
    ).toEqual({
      ok: true,
      currentRevision: 2,
      scratch: { content: "second", revision: 2, updatedAtMs: 30 },
    });

    expect(
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: null,
        expectedRevision: 2,
        nowMs: 40,
      }),
    ).toEqual({ ok: true, currentRevision: 3 });
    // The tombstone keeps the revision lineage monotonic: a stale writer that
    // read revision 2 before the unset cannot resurrect old content later.
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 3,
    });
    expect(
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "resurrected",
        expectedRevision: 2,
        nowMs: 50,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 3 });
    expect(
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "recreated",
        expectedRevision: 3,
        nowMs: 60,
      }),
    ).toEqual({
      ok: true,
      currentRevision: 4,
      scratch: { content: "recreated", revision: 4, updatedAtMs: 60 },
    });
  });

  it("rejects a late write after the owning job is durably deleted", async () => {
    const fixture = await createFixture();
    runOpenClawStateWriteTransaction(
      ({ db }) => replaceCronRows(db, cronStoreKey(fixture.storePath), { version: 1, jobs: [] }),
      fixture.options,
    );

    expect(
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "orphaned heartbeat scratch",
        expectedRevision: 0,
        nowMs: 10,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 0 });
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 0,
    });
  });

  it("records migration provenance and clears it on plain rewrites", async () => {
    const fixture = await createFixture();
    const content = "# Monitor\n\nCheck mail.\n";
    const sourceSha256 = hashCronScratchSource(content);

    writeCronJobScratch({
      ...fixture,
      jobId: "job-1",
      content,
      sourceSha256,
      nowMs: 10,
    });

    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options).scratch).toEqual({
      content,
      revision: 1,
      sourceSha256,
      updatedAtMs: 10,
    });

    writeCronJobScratch({ ...fixture, jobId: "job-1", content: "rewritten", nowMs: 20 });
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options).scratch).toEqual({
      content: "rewritten",
      revision: 2,
      updatedAtMs: 20,
    });
  });

  it("rejects content above the fixed UTF-8 byte limit", async () => {
    const fixture = await createFixture();
    const content = "é".repeat(CRON_JOB_SCRATCH_MAX_BYTES / 2 + 1);

    expect(() => writeCronJobScratch({ ...fixture, jobId: "job-1", content })).toThrow(
      `cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes`,
    );
  });
});
