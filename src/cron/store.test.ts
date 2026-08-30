import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
// Cron store tests cover persisted scheduled job state and run metadata.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLegacyCronQuarantineForMigration } from "../commands/doctor/cron/legacy-quarantine-migration.js";
import {
  archiveLegacyCronStoreForMigration,
  loadLegacyCronStoreForMigration,
} from "../commands/doctor/cron/legacy-store-migration.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  loadCronJobsStoreSync,
  loadCronQuarantinedJobs,
  loadCronStore,
  resolveCronStorePath,
  saveCronJobsStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "./store.js";
import { saveCronJobsStoreWithTransactionHooks } from "./store/transaction-hooks.js";
import type { CronStoreFile } from "./types.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function makeStorePath() {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
  };
}

function resolveLegacyCronQuarantinePath(storePath: string): string {
  return storePath.replace(/\.json$/, "-quarantine.json");
}

function makeStore(jobId: string, enabled: boolean): CronStoreFile {
  const now = Date.now();
  return {
    version: 1,
    jobs: [
      {
        id: jobId,
        name: `Job ${jobId}`,
        enabled,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `tick-${jobId}` },
        state: {},
      },
    ],
  };
}

function makeAuthorityStore(jobId: string): CronStoreFile {
  const store = makeStore(jobId, true);
  const job = expectDefined(store.jobs[0], `makeAuthorityStore(${jobId}) test invariant`);
  job.owner = {
    agentId: "main",
    sessionKey: "agent:main:discord:group:ops",
    accountId: "work",
  };
  job.sessionTarget = "isolated";
  job.payload = {
    kind: "agentTurn",
    message: "scheduled continuation",
    toolsAllow: ["read", "cron"],
    toolsAllowIsDefault: true,
  };
  job.scheduledToolPolicy = {
    version: 1,
    mode: "account",
    ownerSessionKey: "agent:main:discord:group:ops",
    ownerAccountId: "work",
  };
  job.toolsAllowProvenance = { version: 1, source: "final-executable-surface" };
  job.runtimeAuthority = {
    version: 1,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: { apps: [{ id: "calendar" }] },
  };
  return store;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (err) {
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

const requireRecord = createRequireRecord("record", "expected-label");

describe("resolveCronStorePath", () => {
  const envSnapshot = captureEnv(["OPENCLAW_HOME", "HOME"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    setTestEnvValue("OPENCLAW_HOME", "/srv/openclaw-home");
    setTestEnvValue("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });
});

describe("cron store", () => {
  it("returns empty store when file does not exist", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
  });

  it.each([
    {
      name: "one-shot schedule without delivery",
      schedule: { kind: "at", at: "2030-01-01T00:00:00.000Z" },
      delivery: { mode: "none" },
      failureAlert: false,
    },
    {
      name: "interval schedule with an explicitly empty failure alert",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
      delivery: { mode: "announce", channel: "telegram", threadId: 42 },
      failureAlert: {},
    },
    {
      name: "cron schedule with webhook delivery and populated failure alert",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC", staggerMs: 0 },
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      failureAlert: { after: 3, cooldownMs: 60_000, includeSkipped: true },
    },
    {
      name: "process-exit schedule with explicit failure destination clears",
      schedule: { kind: "on-exit", command: "./watch.sh", cwd: "/repo" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        failureDestination: { channel: undefined, to: "slack:C123", accountId: undefined },
      },
      failureAlert: { channel: "slack", to: "slack:C123", mode: "announce" },
    },
    {
      name: "stream schedule with completion webhook",
      schedule: {
        kind: "stream",
        command: ["node", "events.mjs"],
        mode: "match",
        match: "^ready:",
        batchMs: 100,
      },
      delivery: {
        mode: "announce",
        to: "telegram:chat",
        completionDestination: { mode: "webhook", to: "https://example.invalid/complete" },
      },
      failureAlert: { accountId: "bot-1", mode: "webhook" },
    },
  ] satisfies Array<{
    name: string;
    schedule: CronStoreFile["jobs"][number]["schedule"];
    delivery: NonNullable<CronStoreFile["jobs"][number]["delivery"]>;
    failureAlert: NonNullable<CronStoreFile["jobs"][number]["failureAlert"]>;
  }>)(
    "preserves the complete job for $name",
    async ({ name, schedule, delivery, failureAlert }) => {
      const { storePath } = await makeStorePath();
      const job = expectDefined(makeStore(name, true).jobs[0], "cron round-trip fixture");
      Object.assign(job, {
        schedule,
        delivery,
        failureAlert,
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "run" },
      });

      await saveCronStore(storePath, { version: 1, jobs: [job] });

      expect((await loadCronStore(storePath)).jobs[0]).toStrictEqual(job);
    },
  );

  it("throws when doctor migration reads invalid legacy JSON", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadLegacyCronStoreForMigration(store.storePath)).rejects.toThrow(
      /Failed to parse cron store/i,
    );
  });

  it("accepts JSON5 syntax when loading a legacy cron store for doctor migration", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      `{
        // hand-edited legacy store
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'Job 1',
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: 'every', everyMs: 60000 },
            sessionTarget: 'main',
            wakeMode: 'next-heartbeat',
            payload: { kind: 'systemEvent', text: 'tick-job-1' },
            state: {},
          },
        ],
      }`,
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    expect(loaded.version).toBe(1);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.id).toBe("job-1");
    expect(loaded.jobs[0]?.enabled).toBe(true);
  });

  it("loads legacy top-level array stores for doctor migration", async () => {
    const store = await makeStorePath();
    const first = expectDefined(
      makeStore("legacy-array-1", true).jobs[0],
      'makeStore("legacy-array-1", true).jobs[0] test invariant',
    );
    const second = makeStore("legacy-array-2", false).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify([first, "bad-row", null, second], null, 2),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.version).toBe(1);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["legacy-array-1", "legacy-array-2"]);
    expect(loaded.jobs[0]?.state).toStrictEqual(first.state);
    expect(loaded.jobs[1]?.enabled).toBe(false);
  });

  it("does not load legacy top-level array stores synchronously from core", async () => {
    const store = await makeStorePath();
    const job = makeStore("legacy-array-sync", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify([job], null, 2), "utf-8");

    const loaded = loadCronJobsStoreSync(store.storePath);

    expect(loaded.jobs).toHaveLength(0);
  });

  it("lets doctor import legacy top-level array jobs into SQLite and archive the source", async () => {
    const store = await makeStorePath();
    const legacy = expectDefined(
      makeStore("legacy-array-preserved", true).jobs[0],
      'makeStore("legacy-array-preserved", true).jobs[0] test invariant',
    );
    legacy.state = { nextRunAtMs: legacy.createdAtMs + 60_000 };
    const added = expectDefined(
      makeStore("new-job", true).jobs[0],
      'makeStore("new-job", true).jobs[0] test invariant',
    );
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify([legacy], null, 2), "utf-8");

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    loaded.jobs.push(added);
    await saveCronStore(store.storePath, loaded);
    await archiveLegacyCronStoreForMigration(store.storePath);

    const roundTrip = await loadCronStore(store.storePath);
    expect(roundTrip.jobs.map((job) => job.id)).toEqual(["legacy-array-preserved", "new-job"]);
    expect(roundTrip.jobs[0]?.state.nextRunAtMs).toBe(legacy.createdAtMs + 60_000);
    await expectPathMissing(store.storePath);
    expect(await fs.stat(`${store.storePath}.migrated`)).toBeTruthy();
  });

  it("skips non-object legacy persisted jobs during doctor migration", async () => {
    const store = await makeStorePath();
    const valid = makeStore("job-valid", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: ["bad-row", 7, null, false, valid],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.id).toBe("job-valid");
    expect(loaded.jobs[0]?.state).toStrictEqual({});
  });

  it("loads malformed legacy stores for doctor without archiving first", async () => {
    const store = await makeStorePath();
    const valid = expectDefined(
      makeStore("job-valid-unarchived", true).jobs[0],
      'makeStore("job-valid-unarchived", true).jobs[0] test invariant',
    );
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            valid,
            {
              id: "bad-schedule-unarchived",
              name: "bad schedule",
              enabled: true,
              createdAtMs: valid.createdAtMs,
              updatedAtMs: valid.updatedAtMs,
              schedule: ["every", 60_000],
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = await loadLegacyCronStoreForMigration(store.storePath);

    expect(loaded.store.jobs.map((job) => job.id)).toEqual([
      "job-valid-unarchived",
      "bad-schedule-unarchived",
    ]);
    expect(await fs.stat(store.storePath)).toBeTruthy();
    await expectPathMissing(`${store.storePath}.migrated`);
  });

  it("does not synchronously import legacy files from core reads", async () => {
    const store = await makeStorePath();
    const valid = makeStore("job-valid-sync-unarchived", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: ["bad-row", valid] }, null, 2),
      "utf-8",
    );

    const loaded = loadCronJobsStoreSync(store.storePath);

    expect(loaded.jobs.map((job) => job.id)).toEqual([]);
    expect(await fs.stat(store.storePath)).toBeTruthy();
    await expectPathMissing(`${store.storePath}.migrated`);
  });

  it("rejects unrecognized historical quarantine files without modifying them", async () => {
    const { storePath } = await makeStorePath();
    const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      quarantinePath,
      JSON.stringify({ version: 2, jobs: [{ reason: "old-shape", raw: "keep-me" }] }, null, 2),
      "utf-8",
    );

    await expect(loadLegacyCronQuarantineForMigration(storePath)).rejects.toThrow(
      /Unsupported cron quarantine file shape/,
    );

    const preserved = JSON.parse(await fs.readFile(quarantinePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(preserved.jobs[0]?.raw).toBe("keep-me");
  });

  it("stores quarantined jobs in SQLite and preserves the first recovery timestamp", async () => {
    const { storePath } = await makeStorePath();
    const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
    const entry = { sourceIndex: 0, reason: "missing-schedule", job: { id: "same-row" } };

    saveCronQuarantinedJobs({ storePath, nowMs: 100, entries: [entry] });
    saveCronQuarantinedJobs({ storePath, nowMs: 200, entries: [entry] });

    expect(loadCronQuarantinedJobs(storePath)).toEqual([{ ...entry, quarantinedAtMs: 100 }]);
    await expectPathMissing(quarantinePath);
  });

  it("rolls back quarantine records when the cron row update cannot commit", async () => {
    const { storePath } = await makeStorePath();
    const store = makeStore("atomic-quarantine-job", true);
    await saveCronStore(storePath, store);
    const database = openOpenClawStateDatabase().db;
    database.exec(
      "CREATE TEMP TRIGGER fail_cron_quarantine_update BEFORE UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT, 'cron update rejected'); END",
    );
    try {
      await expect(
        saveCronJobsStore(storePath, store, {
          quarantine: {
            nowMs: 123,
            entries: [{ sourceIndex: 0, reason: "invalid-schedule", job: { id: "bad-row" } }],
          },
        }),
      ).rejects.toThrow("cron update rejected");
      expect(loadCronQuarantinedJobs(storePath)).toEqual([]);
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
        "atomic-quarantine-job",
      ]);
    } finally {
      database.exec("DROP TRIGGER fail_cron_quarantine_update");
    }
  });

  it("runs post-commit hooks only after the cron write commits", async () => {
    const { storePath } = await makeStorePath();
    const store = makeStore("post-commit-hook", true);
    const afterCommit = vi.fn();
    await saveCronJobsStoreWithTransactionHooks(storePath, store, undefined, { afterCommit });
    expect(afterCommit).toHaveBeenCalledOnce();

    const database = openOpenClawStateDatabase().db;
    database.exec(
      "CREATE TEMP TRIGGER reject_cron_post_commit BEFORE UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT, 'cron update rejected'); END",
    );
    try {
      await expect(
        saveCronJobsStoreWithTransactionHooks(storePath, store, undefined, { afterCommit }),
      ).rejects.toThrow("cron update rejected");
      expect(afterCommit).toHaveBeenCalledOnce();
    } finally {
      database.exec("DROP TRIGGER reject_cron_post_commit");
    }
  });

  it("keeps valid cron row metadata aligned when an earlier SQLite row is malformed", async () => {
    const { storePath } = await makeStorePath();
    const malformed = expectDefined(
      makeStore("malformed-first", true).jobs[0],
      "malformed cron fixture",
    );
    const surviving = expectDefined(
      makeStore("surviving-second", true).jobs[0],
      "surviving cron fixture",
    );
    surviving.state = { nextRunAtMs: 987_654 };
    await saveCronStore(storePath, { version: 1, jobs: [malformed, surviving] });
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule.kind', ?) WHERE store_key = ? AND job_id = ?",
      )
      .run("unsupported", path.resolve(storePath), malformed.id);

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);

    expect(loaded.store.jobs.map((job) => job.id)).toEqual([surviving.id]);
    expect(loaded.configJobs.map((job) => job.id)).toEqual([surviving.id]);
    expect(loaded.configJobIndexes).toEqual([1]);
    expect(loaded.configJobRuntimeEntries[0]?.state?.nextRunAtMs).toBe(987_654);
    expect(loaded.invalidConfigRows).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: expect.objectContaining({ id: malformed.id }),
      }),
    ]);
  });

  it("loads split cron state synchronously for task reconciliation", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, makeStore("job-sync", true));

    const loaded = loadCronJobsStoreSync(storePath);

    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.id).toBe("job-sync");
    expect(loaded.jobs[0]?.state).toStrictEqual({});
    expect(loaded.jobs[0]?.updatedAtMs).toBeTypeOf("number");
  });

  it("loads split cron state for legacy jobId rows during doctor migration", async () => {
    const { storePath } = await makeStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              jobId: "legacy-sync-job",
              name: "legacy sync job",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              payload: { kind: "systemEvent", text: "tick" },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            "legacy-sync-job": {
              updatedAtMs: 123,
              state: { runningAtMs: 456 },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(storePath)).store;

    expect(loaded.jobs[0]?.state).toEqual({ runningAtMs: 456 });
    expect(loaded.jobs[0]?.updatedAtMs).toBe(123);
  });

  it("compares split state identity for flat legacy cron rows during doctor migration", async () => {
    const { storePath } = await makeStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "legacy-flat-cron",
              name: "legacy flat cron",
              enabled: true,
              kind: "cron",
              cron: "*/10 * * * *",
              tz: "UTC",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            "legacy-flat-cron": {
              updatedAtMs: 1,
              scheduleIdentity: JSON.stringify({
                version: 1,
                enabled: true,
                schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
              }),
              state: { nextRunAtMs: 123 },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(storePath)).store;

    expect(loaded.jobs[0]?.state.nextRunAtMs).toBeUndefined();
  });

  it("does not create a backup file when saving unchanged content", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);

    await saveCronStore(store.storePath, payload);
    await saveCronStore(store.storePath, payload);

    await expectPathMissing(`${store.storePath}.bak`);
  });

  it("replaces cron jobs in SQLite without rewriting legacy files", async () => {
    const store = await makeStorePath();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", false);

    await saveCronStore(store.storePath, first);
    await saveCronStore(store.storePath, second);

    const loaded = await loadCronStore(store.storePath);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-2"]);
    await expectPathMissing(store.storePath);
    await expectPathMissing(`${store.storePath}.bak`);
  });

  it("persists runtime-only state churn in SQLite", async () => {
    const store = await makeStorePath();
    const first = makeStore("job-1", true);
    const second: CronStoreFile = {
      ...first,
      jobs: first.jobs.map((job) => ({
        ...job,
        updatedAtMs: job.updatedAtMs + 60_000,
        state: {
          ...job.state,
          nextRunAtMs: job.createdAtMs + 60_000,
          lastRunAtMs: job.createdAtMs + 30_000,
        },
      })),
    };

    await saveCronStore(store.storePath, first);
    await saveCronStore(store.storePath, second);

    const loaded = await loadCronStore(store.storePath);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(
      expectDefined(first.jobs[0], "first.jobs[0] test invariant").createdAtMs + 60_000,
    );
    expect(loaded.jobs[0]?.state.lastRunAtMs).toBe(
      expectDefined(first.jobs[0], "first.jobs[0] test invariant").createdAtMs + 30_000,
    );
    await expectPathMissing(store.storePath);
    await expectPathMissing(store.storePath.replace(/\.json$/, "-state.json"));
    await expectPathMissing(`${store.storePath}.bak`);
  });

  it("round-trips the auto-disable reason through runtime state JSON", async () => {
    const store = await makeStorePath();
    const payload = makeStore("auto-disabled-job", false);
    const job = expectDefined(payload.jobs[0], "payload.jobs[0] test invariant");
    await saveCronStore(store.storePath, payload);

    job.state = {
      consecutiveErrors: 10,
      autoDisabled: {
        reason: "consecutive-failures",
        atMs: job.updatedAtMs,
        consecutiveErrors: 10,
      },
    };
    await saveCronStore(store.storePath, payload, { stateOnly: true });

    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject(job.state);
  });

  it("normalizes legacy run-status aliases into canonical runtime state JSON", async () => {
    const store = await makeStorePath();
    const payload = makeStore("legacy-run-status", true);
    const job = expectDefined(payload.jobs[0], "legacy run-status fixture");
    job.state = { lastStatus: "ok" };

    await saveCronStore(store.storePath, payload);
    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toEqual({
      lastStatus: "ok",
      lastRunStatus: "ok",
    });

    job.state = { lastStatus: "error" };
    await saveCronStore(store.storePath, payload, { stateOnly: true });
    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toEqual({
      lastStatus: "error",
      lastRunStatus: "error",
    });
  });

  it("stores queued reservations separately from active run markers", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-queued-phase", true);
    const job = expectDefined(payload.jobs[0], "payload.jobs[0] test invariant");
    job.state = {
      nextRunAtMs: job.createdAtMs,
      startupCatchupAtMs: job.createdAtMs,
      pacedNextRunAtMs: job.createdAtMs,
      queuedAtMs: job.createdAtMs + 1,
    };

    await saveCronStore(store.storePath, payload);

    const queuedRow = openOpenClawStateDatabase()
      .db.prepare("SELECT state_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { state_json: string };
    const queuedState = JSON.parse(queuedRow.state_json) as Record<string, unknown>;
    expect(queuedState.runningAtMs).toBeUndefined();
    expect(queuedState).toMatchObject({
      queuedAtMs: job.createdAtMs + 1,
      startupCatchupAtMs: job.createdAtMs,
      pacedNextRunAtMs: job.createdAtMs,
    });
    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
      queuedAtMs: job.createdAtMs + 1,
      startupCatchupAtMs: job.createdAtMs,
      pacedNextRunAtMs: job.createdAtMs,
    });

    job.state.queuedAtMs = undefined;
    job.state.runningAtMs = job.createdAtMs + 2;
    await saveCronStore(store.storePath, payload, { stateOnly: true });

    const activated = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(activated?.queuedAtMs).toBeUndefined();
    expect(activated?.runningAtMs).toBe(job.createdAtMs + 2);
  });

  it("updates runtime state without replacing concurrent cron config", async () => {
    const store = await makeStorePath();
    const stale = makeStore("job-state-only", true);
    const current: CronStoreFile = {
      version: 1,
      jobs: [
        {
          ...expectDefined(stale.jobs[0], "stale.jobs[0] test invariant"),
          name: "Job current",
          updatedAtMs: expectDefined(stale.jobs[0], "stale.jobs[0] test invariant").updatedAtMs + 1,
        },
        expectDefined(
          makeStore("job-added-concurrently", true).jobs[0],
          'makeStore("job-added-concurrently", true).jobs[0] test invariant',
        ),
      ],
    };
    expectDefined(stale.jobs[0], "stale.jobs[0] test invariant").state = {
      nextRunAtMs:
        expectDefined(stale.jobs[0], "stale.jobs[0] test invariant").createdAtMs + 60_000,
    };
    expectDefined(stale.jobs[0], "stale.jobs[0] test invariant").updatedAtMs += 2;

    await saveCronStore(store.storePath, makeStore("job-state-only", true));
    await saveCronStore(store.storePath, current);
    await saveCronStore(store.storePath, stale, { stateOnly: true });

    const loaded = await loadCronStore(store.storePath);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-state-only", "job-added-concurrently"]);
    expect(loaded.jobs[0]?.name).toBe("Job current");
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(
      expectDefined(stale.jobs[0], "stale.jobs[0] test invariant").createdAtMs + 60_000,
    );
  });

  it.each(["email", "webhook"] as const)(
    "round-trips %s agent-turn external content provenance through SQLite",
    async (externalContentSource) => {
      const store = await makeStorePath();
      const payload = makeStore("hook-job", true);
      expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").sessionTarget = "isolated";
      expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").payload = {
        kind: "agentTurn",
        message: "Summarize hook payload",
        externalContentSource,
      };

      await saveCronStore(store.storePath, payload);

      expect((await loadCronStore(store.storePath)).jobs[0]?.payload).toMatchObject({
        kind: "agentTurn",
        message: "Summarize hook payload",
        externalContentSource,
      });
    },
  );

  it("round-trips the toolsAllow default-cap flag through SQLite", async () => {
    // The flag must survive a gateway restart: without it, a CLI-resolved run
    // would re-hit the prepare.ts toolsAllow rejection after reload (#91499).
    const store = await makeStorePath();
    const payload = makeStore("tools-allow-default-job", true);
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").sessionTarget = "isolated";
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    };

    await saveCronStore(store.storePath, payload);

    expect((await loadCronStore(store.storePath)).jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    });
  });

  it("preserves runtime authority when an older writer rewrites job_json", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("downgrade-authority-job");
    const job = expectDefined(authorityStore.jobs[0], "authority job test invariant");

    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    const row = database.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id) as {
      job_json: string;
    };
    const downgradedJob = JSON.parse(row.job_json) as Record<string, unknown>;
    delete downgradedJob.runtimeAuthority;
    delete downgradedJob.runtimeAuthorityRecoveryRequired;
    downgradedJob.description = "edited by an older build";
    database
      .prepare("UPDATE cron_jobs SET description = ?, job_json = ? WHERE job_id = ?")
      .run("edited by an older build", JSON.stringify(downgradedJob), job.id);

    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.description).toBe("edited by an older build");
    expect(reloaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
    expect(reloaded?.runtimeAuthorityRecoveryRequired).toBeUndefined();
  });

  it("stores authority outside job_json and restores it after reopen", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("authority-companion-row");
    const job = expectDefined(authorityStore.jobs[0], "authority job test invariant");

    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    const parent = database
      .prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { job_json: string };
    const parentJson = JSON.parse(parent.job_json) as Record<string, unknown>;
    expect(parentJson).not.toHaveProperty("runtimeAuthority");
    expect(parentJson).not.toHaveProperty("runtimeAuthorityRecoveryRequired");
    const child = database
      .prepare(
        "SELECT authority_json, authority_input_fingerprint, recovery_required FROM cron_job_runtime_authorities WHERE job_id = ?",
      )
      .get(job.id) as {
      authority_json: string;
      authority_input_fingerprint: string;
      recovery_required: number;
    };
    expect(JSON.parse(child.authority_json)).toEqual(job.runtimeAuthority);
    expect(child.authority_input_fingerprint).toMatch(/^v1:[a-f0-9]{64}$/u);
    expect(child.recovery_required).toBe(0);

    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
    expect(reloaded?.runtimeAuthorityRecoveryRequired).toBeUndefined();
    const readOnly = (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs[0];
    expect(readOnly?.runtimeAuthority).toEqual(job.runtimeAuthority);
  });

  it("round-trips the restrict-only exec target and drops foreign shapes", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("exec-target-round-trip");
    const job = expectDefined(authorityStore.jobs[0], "exec target job test invariant");
    job.payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["exec", "read"],
    };
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    };

    await saveCronStore(storePath, authorityStore);
    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.payload.toolsAllow).toEqual(["exec", "read"]);
    expect(reloaded?.toolsAllowExecTarget).toEqual({
      version: 1,
      host: "gateway",
      ask: "always",
    });
    expect(reloaded?.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });

    // A damaged target cannot rehydrate the private exec grant.
    const database = openOpenClawStateDatabase().db;
    const row = database.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id) as {
      job_json: string;
    };
    const edited = JSON.parse(row.job_json) as Record<string, unknown>;
    expect((edited.payload as { toolsAllow?: string[] }).toolsAllow).toEqual(["read"]);
    edited.toolsAllowExecTarget = { version: 1, host: "node" };
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const rejected = (await loadCronStore(storePath)).jobs[0];
    expect(rejected?.toolsAllowExecTarget).toBeUndefined();
    expect(rejected?.payload.toolsAllow).toEqual(["read"]);

    // Older writers may drop both private fields, but cannot restore broad exec.
    const requirement = edited.toolsAllowExecTargetRequirement;
    delete edited.toolsAllowExecTarget;
    delete edited.toolsAllowExecTargetRequirement;
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const downgraded = (await loadCronStore(storePath)).jobs[0];
    expect(downgraded?.payload.toolsAllow).toEqual(["read"]);

    // Extra keys from a newer writer are tolerated: known fields rebuild cleanly.
    edited.toolsAllowExecTargetRequirement = requirement;
    edited.toolsAllowExecTarget = {
      version: 1,
      host: "gateway",
      ask: "always",
      note: "future-field",
    };
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const tolerated = (await loadCronStore(storePath)).jobs[0];
    expect(tolerated?.toolsAllowExecTarget).toEqual({
      version: 1,
      host: "gateway",
      ask: "always",
    });
    expect(tolerated?.payload.toolsAllow).toEqual(["exec", "read"]);

    edited.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "off" };
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const nonRestrictiveAsk = (await loadCronStore(storePath)).jobs[0];
    expect(nonRestrictiveAsk?.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway" });
    expect(nonRestrictiveAsk?.payload.toolsAllow).toEqual(["read"]);
  });

  it("never stores broad exec when a required target is already damaged", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("damaged-exec-target-save");
    const job = expectDefined(authorityStore.jobs[0], "exec target job test invariant");
    job.payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["read", "exec"],
    };
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = { version: 1, recoveryRequired: true };

    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    const row = database.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id) as {
      job_json: string;
    };
    const stored = JSON.parse(row.job_json) as { payload: { toolsAllow?: string[] } };
    expect(stored.payload.toolsAllow).toEqual(["read"]);
    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.payload.toolsAllow).toEqual(["read"]);
    expect(reloaded?.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      recoveryRequired: true,
    });
  });

  it("retires authority when an older writer changes its tool cap", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("downgrade-cap-change");
    const job = expectDefined(authorityStore.jobs[0], "authority job test invariant");
    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    database
      .prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.payload.toolsAllow', json(?), '$.payload.toolsAllowIsDefault', json('false')) WHERE job_id = ?",
      )
      .run(JSON.stringify(["read"]), job.id);

    const drifted = (await loadCronStore(storePath)).jobs[0];
    expect(drifted?.runtimeAuthority).toBeUndefined();
    expect(drifted?.runtimeAuthorityRecoveryRequired).toBe(true);
    expect(
      database
        .prepare("SELECT recovery_required FROM cron_job_runtime_authorities WHERE job_id = ?")
        .get(job.id),
    ).toEqual({ recovery_required: 1 });

    // Reverting the visible cap cannot revive the retired envelope.
    database
      .prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.payload.toolsAllow', json(?), '$.payload.toolsAllowIsDefault', json('true')) WHERE job_id = ?",
      )
      .run(JSON.stringify(["read", "cron"]), job.id);
    const reverted = (await loadCronStore(storePath)).jobs[0];
    expect(reverted?.runtimeAuthority).toBeUndefined();
    expect(reverted?.runtimeAuthorityRecoveryRequired).toBe(true);
  });

  it("fails closed and durably recovers malformed authority rows", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("malformed-authority-row");
    const job = expectDefined(authorityStore.jobs[0], "authority job test invariant");
    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    database
      .prepare("UPDATE cron_job_runtime_authorities SET authority_json = ? WHERE job_id = ?")
      .run("{not-json", job.id);

    const loaded = (await loadCronStore(storePath)).jobs[0];
    expect(loaded?.runtimeAuthority).toBeUndefined();
    expect(loaded?.runtimeAuthorityRecoveryRequired).toBe(true);
    expect(
      database
        .prepare(
          "SELECT authority_json, authority_input_fingerprint, recovery_required FROM cron_job_runtime_authorities WHERE job_id = ?",
        )
        .get(job.id),
    ).toEqual({
      authority_json: null,
      authority_input_fingerprint: null,
      recovery_required: 1,
    });
  });

  it("atomically rolls back parent changes when authority persistence fails", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("authority-atomic-write");
    const job = expectDefined(authorityStore.jobs[0], "authority job test invariant");
    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_cron_runtime_authority_update
      BEFORE UPDATE ON cron_job_runtime_authorities
      BEGIN
        SELECT RAISE(ABORT, 'authority write rejected');
      END;
    `);
    const changed = structuredClone(authorityStore);
    expectDefined(changed.jobs[0], "changed authority job test invariant").description =
      "must roll back";

    try {
      await expect(saveCronStore(storePath, changed)).rejects.toThrow("authority write rejected");
    } finally {
      database.exec("DROP TRIGGER reject_cron_runtime_authority_update;");
    }

    const loaded = (await loadCronStore(storePath)).jobs[0];
    expect(loaded?.description).toBeUndefined();
    expect(loaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
  });

  it("cascades authority deletion and permits a fresh recapture", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("authority-lifecycle");
    const job = expectDefined(authorityStore.jobs[0], "authority job test invariant");
    await saveCronStore(storePath, authorityStore);

    const recoveryStore = structuredClone(authorityStore);
    const recoveryJob = expectDefined(recoveryStore.jobs[0], "recovery job test invariant");
    delete recoveryJob.runtimeAuthority;
    recoveryJob.runtimeAuthorityRecoveryRequired = true;
    await saveCronStore(storePath, recoveryStore);
    expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthorityRecoveryRequired).toBe(true);

    const recapturedStore = structuredClone(authorityStore);
    const recapturedJob = expectDefined(recapturedStore.jobs[0], "recaptured job test invariant");
    recapturedJob.runtimeAuthority = {
      ...expectDefined(job.runtimeAuthority, "original runtime authority test invariant"),
      payload: { apps: [{ id: "mail" }] },
    };
    delete recapturedJob.runtimeAuthorityRecoveryRequired;
    await saveCronStore(storePath, recapturedStore);
    expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthority).toEqual(
      recapturedJob.runtimeAuthority,
    );

    await saveCronStore(storePath, { version: 1, jobs: [] });
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT job_id FROM cron_job_runtime_authorities WHERE job_id = ?")
        .get(job.id),
    ).toBeUndefined();
  });

  it("does not persist a default-cap flag for an explicit toolsAllow restriction", async () => {
    // An explicit user restriction is fail-closed: it carries no flag, so a CLI
    // run still surfaces the prepare.ts rejection rather than silently dropping
    // the requested policy.
    const store = await makeStorePath();
    const payload = makeStore("tools-allow-explicit-job", true);
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").sessionTarget = "isolated";
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["read"],
    };

    await saveCronStore(store.storePath, payload);

    const reloaded = (await loadCronStore(store.storePath)).jobs[0]?.payload;
    expect(reloaded).toMatchObject({ kind: "agentTurn", toolsAllow: ["read"] });
    expect(reloaded && "toolsAllowIsDefault" in reloaded).toBe(false);
  });

  it("round-trips command payloads through SQLite", async () => {
    const store = await makeStorePath();
    const payload = makeStore("command-job", true);
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").sessionTarget = "isolated";
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").payload = {
      kind: "command",
      argv: ["sh", "-lc", 'printf %s "$1"', "  "],
      cwd: "/srv/example",
      env: { FOO: "bar" },
      input: "stdin",
      timeoutSeconds: 45,
      noOutputTimeoutSeconds: 10,
      outputMaxBytes: 4096,
    };

    await saveCronStore(store.storePath, payload);

    expect((await loadCronStore(store.storePath)).jobs[0]?.payload).toEqual({
      kind: "command",
      argv: ["sh", "-lc", 'printf %s "$1"', "  "],
      cwd: "/srv/example",
      env: { FOO: "bar" },
      input: "stdin",
      timeoutSeconds: 45,
      noOutputTimeoutSeconds: 10,
      outputMaxBytes: 4096,
    });
  });

  it("round-trips a trigger-script systemEvent tool cap through SQLite", async () => {
    const store = await makeStorePath();
    const payload = makeStore("trigger-system-event-cap", true);
    const job = expectDefined(
      payload.jobs[0],
      'makeStore("trigger-system-event-cap", true).jobs[0] test invariant',
    );
    job.trigger = { script: "return { fire: false }" };
    job.payload = {
      kind: "systemEvent",
      text: "changed",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    };

    await saveCronStore(store.storePath, payload);

    expect((await loadCronStore(store.storePath)).jobs[0]?.payload).toEqual({
      kind: "systemEvent",
      text: "changed",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    });
  });

  it("round-trips a command payload tool cap through SQLite", async () => {
    const store = await makeStorePath();
    const payload = makeStore("command-cap-job", true);
    const job = expectDefined(
      payload.jobs[0],
      'makeStore("command-cap-job", true).jobs[0] test invariant',
    );
    job.sessionTarget = "isolated";
    job.payload = {
      kind: "command",
      argv: ["echo", "hi"],
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    };

    await saveCronStore(store.storePath, payload);

    expect((await loadCronStore(store.storePath)).jobs[0]?.payload).toEqual({
      kind: "command",
      argv: ["echo", "hi"],
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    });
  });

  it("round-trips completion destinations through canonical cron job JSON", async () => {
    const { storePath } = await makeStorePath();
    const job = expectDefined(
      makeStore("sqlite-webhook-delivery-job", true).jobs[0],
      'makeStore("sqlite-webhook-delivery-job", true).jobs[0] test invariant',
    );
    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "telegram:chat-1",
      threadId: "topic-9",
      accountId: "bot-1",
      bestEffort: true,
      completionDestination: {
        mode: "webhook",
        to: "https://example.invalid/legacy-completion",
      },
    };

    await saveCronStore(storePath, { version: 1, jobs: [job] });

    expect((await loadCronStore(storePath)).jobs[0]?.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "telegram:chat-1",
      threadId: "topic-9",
      accountId: "bot-1",
      bestEffort: true,
      completionDestination: {
        mode: "webhook",
        to: "https://example.invalid/legacy-completion",
      },
    });
  });

  it("round-trips a numeric delivery thread id through canonical cron job JSON", async () => {
    const { storePath } = await makeStorePath();
    const job = expectDefined(
      makeStore("sqlite-numeric-thread-id-job", true).jobs[0],
      'makeStore("sqlite-numeric-thread-id-job", true).jobs[0] test invariant',
    );
    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "telegram:chat-1",
      threadId: 1008013,
    };

    await saveCronStore(storePath, { version: 1, jobs: [job] });

    const loadedThreadId = (await loadCronStore(storePath)).jobs[0]?.delivery?.threadId;
    expect(loadedThreadId).toBe(1008013);
    expect(typeof loadedThreadId).toBe("number");
  });

  it.each(["42", "1737500000.123456", "007"])(
    "keeps a numeric-looking delivery thread id %s as a string through canonical cron job JSON",
    async (threadId) => {
      const { storePath } = await makeStorePath();
      const job = expectDefined(
        makeStore(`sqlite-string-thread-id-job-${threadId}`, true).jobs[0],
        "makeStore(`sqlite-string-thread-id-job-${threadId}`, true).jobs[0] test invariant",
      );
      job.delivery = {
        mode: "announce",
        channel: "telegram",
        to: "telegram:chat-1",
        threadId,
      };

      await saveCronStore(storePath, { version: 1, jobs: [job] });

      const loadedThreadId = (await loadCronStore(storePath)).jobs[0]?.delivery?.threadId;
      expect(loadedThreadId).toBe(threadId);
      expect(typeof loadedThreadId).toBe("string");
    },
  );

  it("preserves distinct numeric and string thread identities in canonical cron job JSON", async () => {
    const { storePath } = await makeStorePath();
    const numberJob = expectDefined(
      makeStore("sqlite-thread-id-number", true).jobs[0],
      'makeStore("sqlite-thread-id-number", true).jobs[0] test invariant',
    );
    numberJob.delivery = { mode: "announce", channel: "telegram", to: "telegram:a", threadId: 42 };
    const stringJob = expectDefined(
      makeStore("sqlite-thread-id-string", true).jobs[0],
      'makeStore("sqlite-thread-id-string", true).jobs[0] test invariant',
    );
    stringJob.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "telegram:b",
      threadId: "42",
    };

    await saveCronStore(storePath, { version: 1, jobs: [numberJob, stringJob] });

    const jobs = (await loadCronStore(storePath)).jobs;
    expect(jobs[0]?.delivery?.threadId).toBe(42);
    expect(typeof jobs[0]?.delivery?.threadId).toBe("number");
    expect(jobs[1]?.delivery?.threadId).toBe("42");
    expect(typeof jobs[1]?.delivery?.threadId).toBe("string");
  });

  it("round-trips explicit failure destination field clears through canonical cron job JSON", async () => {
    const { storePath } = await makeStorePath();
    const job = expectDefined(
      makeStore("sqlite-failure-destination-clear-job", true).jobs[0],
      'makeStore("sqlite-failure-destination-clear-job", true).jobs[0] test invariant',
    );
    job.sessionTarget = "isolated";
    job.payload = { kind: "agentTurn", message: "hello" };
    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "telegram:chat-1",
      failureDestination: {
        channel: undefined,
        to: "slack:C123",
        accountId: undefined,
        mode: undefined,
      },
    };

    await saveCronStore(storePath, { version: 1, jobs: [job] });

    const row = openOpenClawStateDatabase()
      .db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { job_json: string };
    expect(JSON.parse(row.job_json).delivery.failureDestination).toEqual({
      channel: null,
      to: "slack:C123",
      accountId: null,
      mode: null,
    });

    const delivery = (await loadCronStore(storePath)).jobs[0]?.delivery;
    expect(delivery?.failureDestination).toEqual({
      channel: undefined,
      to: "slack:C123",
      accountId: undefined,
      mode: undefined,
    });
    expect(Object.hasOwn(delivery?.failureDestination as object, "channel")).toBe(true);
    expect(Object.hasOwn(delivery?.failureDestination as object, "accountId")).toBe(true);
    expect(Object.hasOwn(delivery?.failureDestination as object, "mode")).toBe(true);

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const configDelivery = requireRecord(loaded.configJobs[0]?.delivery, "config delivery");
    const configFailureDestination = requireRecord(
      configDelivery.failureDestination,
      "config failure destination",
    );
    expect(Object.hasOwn(configFailureDestination, "channel")).toBe(true);
    expect(Object.hasOwn(configFailureDestination, "accountId")).toBe(true);
    expect(Object.hasOwn(configFailureDestination, "mode")).toBe(true);
  });

  it("drops stale split runtime nextRunAtMs when doctor imports edited legacy config", async () => {
    const { storePath } = await makeStorePath();
    const payload = makeStore("job-restart-drift", true);
    const staleNextRunAtMs =
      expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").createdAtMs + 3_600_000;
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").schedule = {
      kind: "cron",
      expr: "30 6 * * 0,6",
      tz: "UTC",
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.writeFile(
      storePath.replace(/\.json$/, "-state.json"),
      JSON.stringify({
        version: 1,
        jobs: {
          [expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").id]: {
            updatedAtMs: expectDefined(payload.jobs[0], "payload.jobs[0] test invariant")
              .updatedAtMs,
            scheduleIdentity: JSON.stringify({
              version: 1,
              enabled: true,
              schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
            }),
            state: { nextRunAtMs: staleNextRunAtMs },
          },
        },
      }),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(storePath)).store;

    expect(loaded.jobs[0]?.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBeUndefined();
  });

  it("does not synchronously import stale split runtime nextRunAtMs from legacy files", async () => {
    const { storePath } = await makeStorePath();
    const payload = makeStore("job-sync-restart-drift", true);
    const staleNextRunAtMs =
      expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").createdAtMs + 3_600_000;
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").schedule = {
      kind: "every",
      everyMs: 60_000,
      anchorMs: 2,
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.writeFile(
      storePath.replace(/\.json$/, "-state.json"),
      JSON.stringify({
        version: 1,
        jobs: {
          [expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").id]: {
            updatedAtMs: expectDefined(payload.jobs[0], "payload.jobs[0] test invariant")
              .updatedAtMs,
            scheduleIdentity: JSON.stringify({
              version: 1,
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
            }),
            state: { nextRunAtMs: staleNextRunAtMs },
          },
        },
      }),
      "utf-8",
    );

    const loaded = loadCronJobsStoreSync(storePath);

    expect(loaded.jobs).toEqual([]);
  });

  it("keeps custom store paths separated by SQLite store key", async () => {
    const store = await makeStorePath();
    const storePath = store.storePath.replace(/\.json$/, "");
    const first = makeStore("job-1", true);
    const second: CronStoreFile = {
      ...first,
      jobs: first.jobs.map((job) => ({
        ...job,
        updatedAtMs: job.updatedAtMs + 60_000,
        state: {
          ...job.state,
          nextRunAtMs: job.createdAtMs + 60_000,
        },
      })),
    };

    await saveCronStore(storePath, first);
    await saveCronStore(storePath, second);

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(
      expectDefined(first.jobs[0], "first.jobs[0] test invariant").createdAtMs + 60_000,
    );
    await expectPathMissing(storePath);
    await expectPathMissing(`${storePath}-state.json`);
  });

  it("leaves legacy sidecars absent after idempotent saves", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").state = {
      nextRunAtMs:
        expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").createdAtMs + 60_000,
    };

    await saveCronStore(store.storePath, payload);
    await loadCronStore(store.storePath);
    await saveCronStore(store.storePath, payload);

    await expectPathMissing(store.storePath);
    await expectPathMissing(store.storePath.replace(/\.json$/, "-state.json"));
    expect((await loadCronStore(store.storePath)).jobs[0]?.state.nextRunAtMs).toBe(
      expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").createdAtMs + 60_000,
    );
  });

  it("lets doctor migrate legacy inline state into SQLite", async () => {
    const store = await makeStorePath();
    const legacy = makeStore("job-1", true);
    expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").state = {
      lastRunAtMs:
        expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").createdAtMs + 30_000,
      nextRunAtMs:
        expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").createdAtMs + 60_000,
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(legacy, null, 2), "utf-8");

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    await saveCronStore(store.storePath, loaded);
    await archiveLegacyCronStoreForMigration(store.storePath);

    const roundTrip = await loadCronStore(store.storePath);
    expect(roundTrip.jobs[0]?.updatedAtMs).toBe(
      expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").updatedAtMs,
    );
    expect(roundTrip.jobs[0]?.state.nextRunAtMs).toBe(
      expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").createdAtMs + 60_000,
    );
    await expectPathMissing(store.storePath);
    expect(await fs.stat(`${store.storePath}.migrated`)).toBeTruthy();
  });

  it("ignores array-shaped state sidecars when doctor migrates legacy inline state", async () => {
    const store = await makeStorePath();
    const statePath = store.storePath.replace(/\.json$/, "-state.json");
    // Numeric-looking IDs catch accidental array indexing in invalid sidecars.
    const legacy = makeStore("0", true);
    expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").state = {
      lastRunAtMs:
        expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").createdAtMs + 30_000,
      nextRunAtMs:
        expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").createdAtMs + 60_000,
    };
    const staleSidecar = {
      ...legacy,
      jobs: [
        {
          ...legacy.jobs[0],
          updatedAtMs:
            expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").updatedAtMs + 10_000,
          state: {
            nextRunAtMs:
              expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").createdAtMs + 120_000,
          },
        },
      ],
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(legacy, null, 2), "utf-8");
    await fs.writeFile(statePath, JSON.stringify(staleSidecar, null, 2), "utf-8");

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    await saveCronStore(store.storePath, loaded);
    await archiveLegacyCronStoreForMigration(store.storePath);

    expect(loaded.jobs[0]?.updatedAtMs).toBe(
      expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").updatedAtMs,
    );
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(
      expectDefined(legacy.jobs[0], "legacy.jobs[0] test invariant").createdAtMs + 60_000,
    );
    await expectPathMissing(statePath);
    expect(await fs.stat(`${statePath}.migrated`)).toBeTruthy();
  });

  it("treats a corrupt state sidecar as absent during doctor migration", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").state = {
      nextRunAtMs:
        expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").createdAtMs + 60_000,
    };
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: payload.jobs.map((job) => ({ ...job, state: {}, updatedAtMs: undefined })),
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(statePath, "{ not json", "utf-8");

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs[0]?.updatedAtMs).toBe(
      expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").createdAtMs,
    );
    expect(loaded.jobs[0]?.state).toStrictEqual({});
  });

  it("propagates unreadable state sidecar errors during doctor migration", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const origReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === statePath) {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return origReadFile(filePath, options as never) as never;
    });

    try {
      await expect(loadLegacyCronStoreForMigration(store.storePath)).rejects.toThrow(
        /Failed to read cron state/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("sanitizes invalid updatedAtMs values from the state sidecar during doctor migration", async () => {
    const store = await makeStorePath();
    const job = expectDefined(
      makeStore("job-1", true).jobs[0],
      'makeStore("job-1", true).jobs[0] test invariant',
    );
    const config = {
      version: 1,
      jobs: [{ ...job, state: {}, updatedAtMs: undefined }],
    };
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(config, null, 2), "utf-8");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            [job.id]: {
              updatedAtMs: "invalid",
              state: { nextRunAtMs: job.createdAtMs + 60_000 },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs[0]?.updatedAtMs).toBe(job.createdAtMs);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(job.createdAtMs + 60_000);
  });

  it("drops non-object runtime state from split cron sidecars during doctor migration", async () => {
    const store = await makeStorePath();
    const first = expectDefined(
      makeStore("job-array-state", true).jobs[0],
      'makeStore("job-array-state", true).jobs[0] test invariant',
    );
    const second = expectDefined(
      makeStore("job-scalar-entry", true).jobs[0],
      'makeStore("job-scalar-entry", true).jobs[0] test invariant',
    );
    const config = {
      version: 1,
      jobs: [
        { ...first, state: {}, updatedAtMs: undefined },
        { ...second, state: {}, updatedAtMs: undefined },
      ],
    };
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(config, null, 2), "utf-8");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            [first.id]: {
              updatedAtMs: first.createdAtMs + 60_000,
              state: ["not", "state"],
            },
            [second.id]: "not-an-entry",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs[0]?.updatedAtMs).toBe(first.createdAtMs + 60_000);
    expect(loaded.jobs[0]?.state).toStrictEqual({});
    expect(loaded.jobs[1]?.updatedAtMs).toBe(second.createdAtMs);
    expect(loaded.jobs[1]?.state).toStrictEqual({});
  });

  it("does not create legacy store or backup files for new SQLite writes", async () => {
    const store = await makeStorePath();
    await saveCronStore(store.storePath, makeStore("job-1", true));
    await saveCronStore(store.storePath, makeStore("job-2", false));

    await expectPathMissing(store.storePath);
    await expectPathMissing(store.storePath.replace(/\.json$/, "-state.json"));
    await expectPathMissing(`${store.storePath}.bak`);
  });
});

describe("saveCronStore", () => {
  const dummyStore: CronStoreFile = { version: 1, jobs: [] };

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("persists and round-trips a store file", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, dummyStore);
    const loaded = await loadCronStore(storePath);
    expect(loaded).toEqual(dummyStore);
  });

  it("does not use legacy file writes on SQLite saves", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, dummyStore);
    await expectPathMissing(storePath);
    await expectPathMissing(`${storePath}.bak`);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
