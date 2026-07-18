// Cron store tests cover persisted scheduled job state and run metadata.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveLegacyCronStoreForMigration,
  loadLegacyCronStoreForMigration,
} from "../commands/doctor/cron/legacy-store-migration.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreSync,
  loadCronQuarantineFile,
  loadCronStore,
  resolveCronQuarantinePath,
  resolveCronStorePath,
  saveCronQuarantineFile,
  saveCronStore,
} from "./store.js";
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

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (err) {
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

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

  it("fails closed instead of overwriting unrecognized quarantine files", async () => {
    const { storePath } = await makeStorePath();
    const quarantinePath = resolveCronQuarantinePath(storePath);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      quarantinePath,
      JSON.stringify({ version: 2, jobs: [{ reason: "old-shape", raw: "keep-me" }] }, null, 2),
      "utf-8",
    );

    await expect(loadCronQuarantineFile(quarantinePath)).rejects.toThrow(
      /Unsupported cron quarantine file shape/,
    );
    await expect(
      saveCronQuarantineFile({
        storePath,
        nowMs: 123,
        entries: [{ sourceIndex: 0, reason: "missing-schedule", job: { id: "new-row" } }],
      }),
    ).rejects.toThrow(/Unsupported cron quarantine file shape/);

    const preserved = JSON.parse(await fs.readFile(quarantinePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(preserved.jobs[0]?.raw).toBe("keep-me");
  });

  it("does not rewrite quarantine files when every entry is already present", async () => {
    const { storePath } = await makeStorePath();
    const quarantinePath = resolveCronQuarantinePath(storePath);
    const entry = { sourceIndex: 0, reason: "missing-schedule", job: { id: "same-row" } };

    await saveCronQuarantineFile({ storePath, nowMs: 100, entries: [entry] });
    const firstRaw = await fs.readFile(quarantinePath, "utf-8");
    await saveCronQuarantineFile({ storePath, nowMs: 200, entries: [entry] });

    expect(await fs.readFile(quarantinePath, "utf-8")).toBe(firstRaw);
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

  it("stores queued reservations separately from active run markers", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-queued-phase", true);
    const job = expectDefined(payload.jobs[0], "payload.jobs[0] test invariant");
    job.state = {
      nextRunAtMs: job.createdAtMs,
      startupCatchupAtMs: job.createdAtMs,
      queuedAtMs: job.createdAtMs + 1,
    };

    await saveCronStore(store.storePath, payload);

    const queuedRow = openOpenClawStateDatabase()
      .db.prepare("SELECT running_at_ms, state_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { running_at_ms: number | null; state_json: string };
    expect(queuedRow.running_at_ms).toBeNull();
    expect(JSON.parse(queuedRow.state_json)).toMatchObject({
      queuedAtMs: job.createdAtMs + 1,
      startupCatchupAtMs: job.createdAtMs,
    });
    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
      queuedAtMs: job.createdAtMs + 1,
      startupCatchupAtMs: job.createdAtMs,
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

  it("round-trips agent-turn external content provenance through SQLite", async () => {
    const store = await makeStorePath();
    const payload = makeStore("hook-job", true);
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").sessionTarget = "isolated";
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").payload = {
      kind: "agentTurn",
      message: "Summarize hook payload",
      externalContentSource: "webhook",
    };

    await saveCronStore(store.storePath, payload);

    expect((await loadCronStore(store.storePath)).jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: "Summarize hook payload",
      externalContentSource: "webhook",
    });
  });

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

  it("round-trips completion destinations through SQLite delivery columns", async () => {
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

  it("round-trips a numeric delivery thread id through SQLite delivery columns", async () => {
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
    "keeps a numeric-looking delivery thread id %s as a string through SQLite delivery columns",
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

  it("does not resurrect a cleared thread id from the stored config copy", async () => {
    const { storePath } = await makeStorePath();
    const job = expectDefined(
      makeStore("sqlite-early-row-thread-id-job", true).jobs[0],
      'makeStore("sqlite-early-row-thread-id-job", true).jobs[0] test invariant',
    );
    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "telegram:chat-1",
      threadId: 1008013,
    };

    await saveCronStore(storePath, { version: 1, jobs: [job] });
    openOpenClawStateDatabase()
      .db.prepare("UPDATE cron_jobs SET delivery_thread_id = NULL WHERE job_id = ?")
      .run(job.id);

    const loadedThreadId = (await loadCronStore(storePath)).jobs[0]?.delivery?.threadId;
    expect(loadedThreadId).toBeUndefined();
  });

  it("uses the normalized thread id when the stored config copy is stale", async () => {
    const { storePath } = await makeStorePath();
    const job = expectDefined(
      makeStore("sqlite-stale-thread-id-job", true).jobs[0],
      'makeStore("sqlite-stale-thread-id-job", true).jobs[0] test invariant',
    );
    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "telegram:chat-1",
      threadId: 1008013,
    };

    await saveCronStore(storePath, { version: 1, jobs: [job] });
    openOpenClawStateDatabase()
      .db.prepare("UPDATE cron_jobs SET delivery_thread_id = ? WHERE job_id = ?")
      .run("replacement", job.id);

    const loadedThreadId = (await loadCronStore(storePath)).jobs[0]?.delivery?.threadId;
    expect(loadedThreadId).toBe("replacement");
  });

  it("disambiguates identical thread id text using the normalized type marker", async () => {
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

  it("round-trips explicit failure destination field clears through SQLite delivery columns", async () => {
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
