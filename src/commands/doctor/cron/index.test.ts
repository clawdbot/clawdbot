// Doctor cron index tests cover cron doctor checks and repair entrypoints.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { readCronRunLogEntriesSync } from "../../../cron/run-log.js";
import {
  loadCronQuarantineFile,
  loadCronStore,
  resolveCronQuarantinePath,
  saveCronStore,
} from "../../../cron/store.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  maybeRepairLegacyCronStore,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./index.js";

type TerminalNote = (message: string, title?: string) => void;

const noteMock = vi.hoisted(() => vi.fn<TerminalNote>());

vi.mock("../../../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

let tempRoot: string | null = null;

async function makeTempStorePath() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  return path.join(tempRoot, "cron", "jobs.json");
}

afterEach(async () => {
  noteMock.mockClear();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makePrompter(confirmResult = true) {
  return {
    confirm: vi.fn().mockResolvedValue(confirmResult),
  };
}

function createCronConfig(storePath: string): OpenClawConfig {
  return {
    cron: {
      store: storePath,
      webhook: "https://example.invalid/cron-finished",
    },
  };
}

function createLegacyCronJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
    payload: {
      kind: "systemEvent",
      text: "Morning brief",
    },
    state: {},
    ...overrides,
  };
}

function createCurrentCronJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "sqlite-job",
    name: "SQLite job",
    enabled: true,
    createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: "SQLite brief",
    },
    state: {},
    ...overrides,
  };
}

async function writeCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function writeCurrentCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await saveCronStore(storePath, {
    version: 1,
    jobs: jobs as never,
  });
}

function insertEarlySQLiteCronRow(
  storePath: string,
  job: Record<string, unknown>,
  options: { payloadMessage?: string | null } = {},
) {
  const schedule = requireRecord(job.schedule, "cron schedule");
  const payload = requireRecord(job.payload, "cron payload");
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      `INSERT INTO cron_jobs (
        store_key, job_id, name, enabled, created_at_ms, updated_at,
        schedule_kind, every_ms, session_target, wake_mode, payload_kind, payload_message,
        job_json, state_json
      ) VALUES (
        $storeKey, $jobId, $name, $enabled, $createdAtMs, $updatedAt,
        $scheduleKind, $everyMs, $sessionTarget, $wakeMode, $payloadKind, $payloadMessage,
        $jobJson, $stateJson
      )`,
    ).run({
      $storeKey: path.resolve(storePath),
      $jobId: String(job.id),
      $name: String(job.name),
      $enabled: job.enabled === false ? 0 : 1,
      $createdAtMs: Number(job.createdAtMs),
      $updatedAt: Number(job.updatedAtMs),
      $scheduleKind: String(schedule.kind),
      $everyMs: Number(schedule.everyMs),
      $sessionTarget: String(job.sessionTarget),
      $wakeMode: String(job.wakeMode),
      $payloadKind: String(payload.kind),
      $payloadMessage: options.payloadMessage ?? null,
      $jobJson: JSON.stringify(job),
      $stateJson: JSON.stringify(job.state ?? {}),
    });
  });
}

async function writeLegacyCronArrayStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(jobs, null, 2), "utf-8");
}

async function readPersistedJobs(storePath: string): Promise<Array<Record<string, unknown>>> {
  return (await loadCronStore(storePath)).jobs as unknown as Array<Record<string, unknown>>;
}

function requirePersistedJob(jobs: Array<Record<string, unknown>>, index: number) {
  const job = jobs[index];
  if (!job) {
    throw new Error(`expected persisted cron job ${index}`);
  }
  return job;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectNoteContaining(message: string, title: string): void {
  expect(
    noteMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes(message) && call[1] === title,
    ),
  ).toBe(true);
}

function expectNoNoteContaining(message: string, title: string): void {
  expect(
    noteMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes(message) && call[1] === title,
    ),
  ).toBe(false);
}

describe("maybeRepairLegacyCronStore", () => {
  it("reports quarantined cron rows even when the active store is already sanitized", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, []);
    await fs.writeFile(
      resolveCronQuarantinePath(storePath),
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              quarantinedAtMs: Date.parse("2026-05-29T09:00:00.000Z"),
              sourceIndex: 1,
              reason: "missing-schedule",
              job: { id: "bad-cron", name: "Bad cron" },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoteContaining("Quarantined cron job rows found", "Cron");
    expectNoteContaining("1 row was removed from the active cron store", "Cron");
  });

  it("surfaces cron payload model overrides without rewriting current jobs", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "api-pinned",
        name: "API pinned",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "openai/gpt-5.4",
          thinking: "high",
        },
        state: {},
      },
      {
        id: "other-pinned",
        name: "Other pinned",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "anthropic/claude-sonnet-4-6",
        },
        state: {},
      },
      {
        id: "inherits-default",
        name: "Inherits default",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        state: {},
      },
    ]);
    const prompter = makePrompter(true);

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: [] },
          },
        },
      },
      options: {},
      prompter,
    });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Cron model overrides detected", "Cron");
    expectNoteContaining("2 jobs set `payload.model`", "Cron");
    expectNoteContaining("Provider namespaces: anthropic=1, openai=1", "Cron");
    expectNoteContaining("2 jobs use a different model than `agents.defaults.model`", "Cron");

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.model).toBe("openai/gpt-5.4");
    expect(payload.thinking).toBe("high");
  });

  it("does not surface cron model override diagnostics when jobs inherit the default", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "inherits-default",
        name: "Inherits default",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoNoteContaining("Cron model overrides detected", "Cron");
  });

  it("counts alias model pins as default mismatches", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "alias-pinned",
        name: "Alias the native runtime",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "gpt",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "test:opus", fallbacks: [] },
          },
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    expectNoteContaining("1 job set `payload.model`", "Cron");
    expectNoteContaining("Provider namespaces: bare/alias=1", "Cron");
    expectNoteContaining("1 job uses a different model than `agents.defaults.model`", "Cron");
    expectNoteContaining("Examples: alias-pinned -> gpt", "Cron");
  });

  it("repairs legacy cron store fields and migrates notify fallback to webhook delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const cfg = createCronConfig(storePath);

    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.jobId).toBeUndefined();
    expect(job.id).toBe("legacy-job");
    expect(job.notify).toBeUndefined();
    const schedule = requireRecord(job.schedule, "cron schedule");
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("0 7 * * *");
    expect(schedule.tz).toBe("UTC");
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("systemEvent");
    expect(payload.text).toBe("Morning brief");

    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("repairs legacy top-level array cron stores instead of treating them as empty (#60799)", async () => {
    const storePath = await makeTempStorePath();
    await writeLegacyCronArrayStore(storePath, [createLegacyCronJob()]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.jobId).toBeUndefined();
    expect(job.id).toBe("legacy-job");
    expect(job.notify).toBeUndefined();
    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("archives legacy cron stores when an older migrated archive already exists", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.writeFile(`${storePath}.migrated`, "old archive", "utf-8");

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(`${storePath}.migrated`, "utf-8")).resolves.toBe("old archive");
    await expect(fs.stat(`${storePath}.migrated.2`)).resolves.toBeTruthy();
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("imports legacy-only jobs when SQLite already has cron rows", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "legacy-job",
        name: "SQLite wins",
      }),
    ]);
    await writeCronStore(storePath, [
      createLegacyCronJob({
        name: "Stale duplicate",
      }),
      createLegacyCronJob({
        jobId: "legacy-only",
        name: "Legacy only",
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.id)).toEqual(["legacy-job", "legacy-only"]);
    expect(requirePersistedJob(jobs, 0).name).toBe("SQLite wins");
    expect(requirePersistedJob(jobs, 1).name).toBe("Legacy only");
    expectNoteContaining("1 legacy JSON cron job will be imported into SQLite", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("backfills early SQLite rows from job_json before runtime relies on split columns", async () => {
    const storePath = await makeTempStorePath();
    insertEarlySQLiteCronRow(storePath, {
      id: "early-sqlite-agent-turn",
      name: "Early SQLite agent turn",
      enabled: true,
      createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "use config json" },
      state: {},
    });

    expect(await readPersistedJobs(storePath)).toEqual([]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.id).toBe("early-sqlite-agent-turn");
    expect(job.payload).toEqual({ kind: "agentTurn", message: "use config json" });
    expectNoteContaining("1 SQLite cron row will be backfilled", "Cron");
  });

  it("backfills parseable SQLite rows when optional config fields only exist in job_json", async () => {
    const storePath = await makeTempStorePath();
    insertEarlySQLiteCronRow(
      storePath,
      {
        id: "early-sqlite-model",
        name: "Early SQLite model",
        enabled: true,
        createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
        schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "use split text", model: "openai/gpt-5.5" },
        state: {},
      },
      { payloadMessage: "use split text" },
    );

    expect(requirePersistedJob(await readPersistedJobs(storePath), 0).payload).toEqual({
      kind: "agentTurn",
      message: "use split text",
    });

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const job = requirePersistedJob(await readPersistedJobs(storePath), 0);
    expect(job.payload).toEqual({
      kind: "agentTurn",
      message: "use split text",
      model: "openai/gpt-5.5",
    });
    expectNoteContaining("1 SQLite cron row will be backfilled", "Cron");
  });

  it("migrates legacy run logs even when the legacy job store was already archived", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [createCurrentCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "sqlite-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(
      runLogPath,
      `${JSON.stringify({
        ts: Date.parse("2026-02-04T00:00:00.000Z"),
        jobId: "sqlite-job",
        action: "finished",
        status: "ok",
        summary: "done",
      })}\n`,
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const entries = readCronRunLogEntriesSync({ storePath, jobId: "sqlite-job" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobId).toBe("sqlite-job");
    expect(entries[0]?.summary).toBe("done");
    await expect(fs.stat(runLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${runLogPath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("legacy JSON cron run logs will be imported into SQLite", "Cron");
    expectNoteContaining("Cron run logs migrated to SQLite", "Doctor changes");
  });

  it("repairs malformed persisted cron ids before list rendering sees them", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: 42,
        jobId: undefined,
        notify: false,
      }),
      createLegacyCronJob({
        id: undefined,
        jobId: undefined,
        name: "Missing id",
        notify: false,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const firstJob = requirePersistedJob(jobs, 0);
    const secondJob = requirePersistedJob(jobs, 1);
    expect(firstJob.id).toBe("42");
    expect(typeof secondJob.id).toBe("string");
    expect(String(secondJob.id)).toMatch(/^cron-/);
    expectNoteContaining("stores `id` as a non-string value", "Cron");
    expectNoteContaining("missing a canonical string `id`", "Cron");
  });

  it("migrates notify fallback alongside announce delivery without replacing it", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-and-announce",
              name: "Notify and announce",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Status" },
              delivery: { to: "telegram:123" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: { nonInteractive: true },
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBeUndefined();
    expect(delivery.to).toBe("telegram:123");
    expect(delivery.completionDestination).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
    expectNoNoteContaining(
      "uses legacy notify fallback alongside delivery mode",
      "Doctor warnings",
    );
  });

  it("does not auto-repair in non-interactive mode without explicit repair approval", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const prompter = makePrompter(false);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: { nonInteractive: true },
      prompter,
    });

    expect(await readPersistedJobs(storePath)).toEqual([]);
    const legacy = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const job = requirePersistedJob(legacy.jobs, 0);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Repair legacy cron jobs now?",
      initialValue: true,
    });
    expect(job.jobId).toBe("legacy-job");
    expect(job.id).toBeUndefined();
    expect(job.notify).toBe(true);
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("migrates notify fallback none delivery jobs to cron.webhook", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-none",
              name: "Notify none",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              payload: {
                kind: "systemEvent",
                text: "Status",
              },
              delivery: { mode: "none", to: "123456789" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
  });

  it("migrates invalid legacy notify webhook delivery jobs to cron.webhook", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-invalid-webhook",
              name: "Notify invalid webhook",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              payload: {
                kind: "systemEvent",
                text: "Status",
              },
              delivery: { mode: "webhook", to: "ftp://example.invalid/cron" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
  });

  it("warns when cron.webhook is invalid for a legacy notify fallback", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: "notify-invalid-config",
        jobId: undefined,
        delivery: undefined,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "ftp://example.invalid/cron-finished",
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    expect(job.delivery).toBeUndefined();
    expectNoteContaining(
      "cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically",
      "Doctor warnings",
    );
  });

  it("quarantines invalid legacy rows before saving the repaired store", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: "invalid-legacy-cron",
        jobId: undefined,
        schedule: { kind: "cron" },
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expect(await readPersistedJobs(storePath)).toEqual([]);
    const quarantine = await loadCronQuarantineFile(resolveCronQuarantinePath(storePath));
    expect(quarantine.jobs[0]?.reason).toBe("invalid-schedule");
    expect(quarantine.jobs[0]?.job?.id).toBe("invalid-legacy-cron");
  });

  it("repairs legacy root delivery threadId hints into delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "legacy-thread-hint",
        name: "Legacy thread hint",
        enabled: true,
        createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
        schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        channel: " telegram ",
        to: "-1001234567890",
        threadId: " 99 ",
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.channel).toBeUndefined();
    expect(job.to).toBeUndefined();
    expect(job.threadId).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("-1001234567890");
    expect(delivery.threadId).toBe("99");
  });

  it("rewrites stale managed dreaming jobs to the isolated agentTurn shape", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "memory-dreaming",
        name: "Memory Dreaming Promotion",
        description:
          "[managed-by=memory-core.short-term-promotion] Promote weighted short-term recalls.",
        enabled: true,
        createdAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.sessionTarget).toBe("isolated");
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toBe("__openclaw_memory_core_short_term_promotion_dream__");
    expect(payload.lightContext).toBe(true);
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("none");
    expectNoteContaining("managed dreaming job", "Cron");
    expectNoteContaining("Rewrote 1 managed dreaming job", "Doctor changes");
  });

  it("warns and continues when the cron job store cannot be read", async () => {
    const storePath = await makeTempStorePath();
    // Force loadCronStore to throw a non-ENOENT read error by placing a
    // directory where the cron job store file would be. This mirrors the
    // Docker-on-root permission failure reported in #86102 without depending
    // on the test runner's effective uid (root bypasses chmod gates).
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(storePath);
    const prompter = makePrompter(true);

    await expect(
      maybeRepairLegacyCronStore({
        cfg: { cron: { store: storePath } },
        options: {},
        prompter,
      }),
    ).resolves.toBeUndefined();

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Unable to read cron job store at", "Cron");
    expectNoteContaining("later health checks will continue", "Cron");
  });
});

describe("legacy WhatsApp crontab health check", () => {
  it("collects a warning about legacy ensure-whatsapp crontab entries on Linux", async () => {
    const warning = await collectLegacyWhatsAppCrontabHealthWarning({
      platform: "linux",
      readCrontab: async () => ({
        stdout: [
          "# keep comments ignored",
          "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
          "0 9 * * * /usr/bin/true",
          "",
        ].join("\n"),
      }),
    });

    expect(warning).toContain("Legacy WhatsApp crontab health check detected");
    expect(warning).toContain("systemd user bus environment is missing");
    expect(warning).toContain("Matched 1 entry");
  });

  it("warns about legacy ensure-whatsapp crontab entries on Linux", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => ({
        stdout: [
          "# keep comments ignored",
          "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
          "0 9 * * * /usr/bin/true",
          "",
        ].join("\n"),
      }),
    });

    expectNoteContaining("Legacy WhatsApp crontab health check detected", "Cron");
    expectNoteContaining("systemd user bus environment is missing", "Cron");
    expectNoteContaining("Matched 1 entry", "Cron");
  });

  it("ignores missing crontab support and non-Linux hosts", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "darwin",
      readCrontab: async () => {
        throw new Error("should not read crontab on non-Linux");
      },
    });
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => {
        throw Object.assign(new Error("crontab missing"), { code: "ENOENT" });
      },
    });

    expect(noteMock).not.toHaveBeenCalled();
  });

  it("ignores malformed crontab output instead of crashing", async () => {
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: undefined,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: 12345,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: { lines: ["*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh"] },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(noteMock).not.toHaveBeenCalled();
  });
});
