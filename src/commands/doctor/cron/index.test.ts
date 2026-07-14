// Doctor cron index tests cover cron doctor checks and repair entrypoints.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronQuarantineFile,
  loadCronStore,
  resolveCronQuarantinePath,
  saveCronStore,
} from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { readCronTaskRunHistoryPage } from "../../../cron/task-run-history.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { withRestoredMocks } from "../../../test-utils/vitest-spies.js";
import {
  collectLegacyCronStoreHealthFindings,
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
  vi.unstubAllEnvs();
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

function createFsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function mockExdevRename(filePath: string) {
  const realRename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
    if (oldPath === filePath) {
      throw createFsError("EXDEV", "cross-device link not permitted, rename");
    }
    return await realRename(oldPath, newPath);
  });
}

describe("collectLegacyCronStoreHealthFindings", () => {
  it("reports legacy cron store, run-log, and payload findings without mutating files", async () => {
    const storePath = await makeTempStorePath();
    await writeLegacyCronArrayStore(storePath, [
      createLegacyCronJob({
        jobId: "legacy-notify",
        payload: {
          kind: "systemEvent",
          text: "Morning brief",
        },
      }),
    ]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "legacy-notify.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(runLogPath, "", "utf-8");

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(storePath),
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "core/doctor/legacy-cron-store",
          severity: "warning",
          path: storePath,
          requirement: "legacy-cron-store",
        }),
        expect.objectContaining({
          checkId: "core/doctor/legacy-cron-store",
          severity: "warning",
          path: storePath,
          requirement: "legacy-notify-fallback",
        }),
      ]),
    );
    expect(findings.some((finding) => finding.requirement === "legacy-cron-run-logs")).toBe(true);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("legacy-notify");
    await expect(fs.stat(runLogPath)).resolves.toBeDefined();
  });

  it("reports quarantined cron rows while leaving the active store untouched", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, []);
    await fs.mkdir(path.dirname(resolveCronQuarantinePath(storePath)), { recursive: true });
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

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(storePath),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/legacy-cron-store",
        path: resolveCronQuarantinePath(storePath),
        requirement: "quarantined-cron-rows",
      }),
    ]);
    await expect(readPersistedJobs(storePath)).resolves.toEqual([]);
  });

  it("returns no findings for an already-normalized empty cron store", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, []);

    await expect(
      collectLegacyCronStoreHealthFindings({ cfg: createCronConfig(storePath) }),
    ).resolves.toEqual([]);
  });
});

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

  describe("in-flight cron job advisory", () => {
    const RUNNING_AT_MS = Date.parse("2026-05-01T00:00:00.000Z");

    it("warns about jobs still marked in-flight without touching the store", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({ id: "running-job", state: { runningAtMs: RUNNING_AT_MS } }),
      ]);
      const prompter = makePrompter(true);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter,
      });

      expectNoteContaining("1 cron job is still marked in-flight", "Cron");
      expectNoteContaining("shows it as `running`", "Cron");
      expectNoteContaining("marks such runs interrupted the next time it starts", "Cron");
      expectNoteContaining("openclaw cron show <id>", "Cron");

      // Observer-only: no repair prompt and the running marker is left untouched.
      expect(prompter.confirm).not.toHaveBeenCalled();
      const jobs = await readPersistedJobs(storePath);
      const state = requireRecord(requirePersistedJob(jobs, 0).state, "cron state");
      expect(state.runningAtMs).toBe(RUNNING_AT_MS);
      expect(state.lastRunStatus).toBeUndefined();
    });

    it("pluralizes the advisory when multiple jobs are in-flight", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({ id: "running-a", state: { runningAtMs: RUNNING_AT_MS } }),
        createCurrentCronJob({ id: "running-b", state: { runningAtMs: RUNNING_AT_MS + 1000 } }),
      ]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoteContaining("2 cron jobs are still marked in-flight", "Cron");
      expectNoteContaining("shows them as `running`", "Cron");
    });

    it("stays silent when no job is marked in-flight", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [createCurrentCronJob({ id: "idle-job" })]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoNoteContaining("still marked in-flight", "Cron");
    });
  });

  describe("chronic failure advisory", () => {
    it("warns about repeatedly failing jobs without touching the store", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "failing-job",
          state: { lastRunStatus: "error", consecutiveErrors: 5, lastError: "boom" },
        }),
      ]);
      const prompter = makePrompter(true);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter,
      });

      expectNoteContaining("1 cron job has failed 3+ runs in a row", "Cron");
      expectNoteContaining("re-fires it on error backoff", "Cron");
      expectNoteContaining("resets on the next successful run", "Cron");
      expectNoteContaining("interrupted by a gateway restart", "Cron");
      expectNoteContaining("openclaw cron show <id>", "Cron");

      // Observer-only: no repair prompt and the failure counters stay untouched.
      expect(prompter.confirm).not.toHaveBeenCalled();
      const jobs = await readPersistedJobs(storePath);
      const state = requireRecord(requirePersistedJob(jobs, 0).state, "cron state");
      expect(state.consecutiveErrors).toBe(5);
    });

    it("pluralizes and only counts enabled jobs at or above the threshold", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "failing-a",
          state: { lastRunStatus: "error", consecutiveErrors: 3 },
        }),
        createCurrentCronJob({
          id: "failing-b",
          state: { lastRunStatus: "error", consecutiveErrors: 12 },
        }),
        createCurrentCronJob({
          id: "recovering",
          state: { lastRunStatus: "error", consecutiveErrors: 2 },
        }),
        // Exhausted one-shot jobs get disabled with their error state retained;
        // they no longer re-fire, so the advisory must not count them.
        createCurrentCronJob({
          id: "disabled-exhausted",
          enabled: false,
          state: { lastRunStatus: "error", consecutiveErrors: 9 },
        }),
      ]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoteContaining("2 cron jobs have failed 3+ runs in a row", "Cron");
    });

    it("stays silent when failure streaks are below the threshold", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "single-failure",
          state: { lastRunStatus: "error", consecutiveErrors: 2 },
        }),
      ]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoNoteContaining("runs in a row", "Cron");
    });
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

  it("falls back to copy+unlink when renaming the legacy cron store fails with EXDEV", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    const sourceMtime = new Date("2026-01-02T03:04:05.000Z");
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.chmod(storePath, 0o640);
    await fs.utimes(storePath, sourceMtime, sourceMtime);

    const renameSpy = mockExdevRename(storePath);
    const realOpen = fs.open.bind(fs);
    let archiveFileSynced = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === archivePath && args[1] === "r+") {
        const realSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          archiveFileSynced = true;
          await realSync();
        });
      }
      return handle;
    });

    await withRestoredMocks([openSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expect(renameSpy).toHaveBeenCalled();
      expect(archiveFileSynced).toBe(true);
      await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(archivePath, "utf-8")).resolves.toContain("legacy-job");
      const archiveStat = await fs.stat(archivePath);
      if (process.platform !== "win32") {
        expect(archiveStat.mode & 0o777).toBe(0o640);
      }
      expect(archiveStat.mtimeMs).toBe(sourceMtime.getTime());
      expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
      expectNoNoteContaining("could not archive the legacy cron file", "Doctor warnings");
    });

    // A second doctor pass must not re-detect (and re-warn about) the archived store.
    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    expectNoNoteContaining("Legacy cron job storage detected", "Cron");
  });

  it("refuses a migration plan when the legacy source changes during confirmation", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);
    const changedJob = createLegacyCronJob({ jobId: "changed-job", name: "Changed job" });
    const prompter = {
      confirm: vi.fn(async () => {
        await writeCronStore(storePath, [changedJob]);
        return true;
      }),
    };

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    expect(await readPersistedJobs(storePath)).toHaveLength(0);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("changed-job");
    await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("changed while doctor was preparing", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    expect((await readPersistedJobs(storePath)).map((job) => job.id)).toEqual(["changed-job"]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("keeps a source that changes during an EXDEV copy and imports it on retry", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realCopyFile = fs.copyFile.bind(fs);
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest, mode) => {
      await realCopyFile(src, dest, mode);
      if (src === storePath) {
        await writeCronStore(storePath, [
          createLegacyCronJob({ jobId: "late-job", name: "Late job" }),
        ]);
      }
    });

    await withRestoredMocks([copyFileSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    expect((await readPersistedJobs(storePath)).map((job) => job.id)).toEqual(["legacy-job"]);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("late-job");
    await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("changed during archival", "Doctor warnings");

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    expect((await readPersistedJobs(storePath)).map((job) => job.id)).toEqual([
      "legacy-job",
      "late-job",
    ]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(archivePath)).resolves.toBeTruthy();
  });

  it("restores an archived state sidecar when the primary archive fails", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (oldPath === storePath) {
        throw createFsError("EIO", "primary archive failed");
      }
      return await realRename(oldPath, newPath);
    });

    await withRestoredMocks([renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    await expect(fs.stat(statePath)).resolves.toBeTruthy();
    await expect(fs.stat(`${statePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("EIO", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${statePath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("restores the primary source when a state sidecar is recreated during archival", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (oldPath === storePath) {
        await fs.writeFile(
          statePath,
          JSON.stringify({ version: 1, jobs: { "legacy-job": { state: { lastRunAtMs: 2 } } } }),
          "utf-8",
        );
      }
      return await realRename(oldPath, newPath);
    });

    await withRestoredMocks([renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    await expect(fs.readFile(statePath, "utf-8")).resolves.toContain("lastRunAtMs");
    await expect(fs.stat(`${statePath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("state appeared after", "Doctor warnings");
    expectNoteContaining("archive rollback failed", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("reports a late state access failure without rejecting doctor", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const realAccess = fs.access.bind(fs);
    let stateAccesses = 0;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (args[0] === statePath && ++stateAccesses === 2) {
        throw createFsError("EIO", "state access failed");
      }
      return await realAccess(...args);
    });

    await withRestoredMocks([accessSpy], async () => {
      await expect(
        maybeRepairLegacyCronStore({
          cfg: createCronConfig(storePath),
          options: {},
          prompter: makePrompter(true),
        }),
      ).resolves.toBeUndefined();
    });

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    expectNoteContaining("state access failed", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("removes a partial copy and warns honestly when archiving fails", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realCopyFile = fs.copyFile;
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest, mode) => {
      if (src === storePath) {
        await fs.writeFile(dest, "partial", "utf-8");
        throw createFsError("ENOSPC", "no space left, copyfile");
      }
      return realCopyFile(src, dest, mode);
    });

    await withRestoredMocks([copyFileSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      // Both rename and the copy+unlink fallback failed, so the legacy file must remain
      // and doctor must surface a warning instead of claiming a finished migration.
      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("could not archive the legacy cron file", "Doctor warnings");
      expectNoteContaining("ENOSPC", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it("accepts a failed copy that already removed its destination", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realCopyFile = fs.copyFile.bind(fs);
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest) => {
      if (src === storePath) {
        await fs.unlink(dest);
        throw createFsError("EIO", "copyfile failed after destination cleanup");
      }
      return await realCopyFile(src, dest);
    });

    await withRestoredMocks([copyFileSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("partial archive remains", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it("reports a source stat failure without aborting doctor", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      if (args[0] === storePath) {
        throw createFsError("EIO", "stat failed");
      }
      return await realStat(...args);
    });

    await withRestoredMocks([statSpy, renameSpy], async () => {
      await expect(
        maybeRepairLegacyCronStore({
          cfg: createCronConfig(storePath),
          options: {},
          prompter: makePrompter(true),
        }),
      ).resolves.toBeUndefined();
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
    await expect(fs.stat(storePath)).resolves.toBeTruthy();
  });

  it("reports an archive access failure instead of treating the source as missing", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const realAccess = fs.access.bind(fs);
    let sourceAccesses = 0;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (args[0] === storePath && ++sourceAccesses === 2) {
        throw createFsError("EIO", "access failed");
      }
      return await realAccess(...args);
    });

    await withRestoredMocks([accessSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
    await expect(fs.stat(storePath)).resolves.toBeTruthy();
  });

  it("keeps the source and removes the partial archive when durability sync fails", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === archivePath && args[1] === "r+") {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(createFsError("EIO", "fsync failed"));
      }
      return handle;
    });

    await withRestoredMocks([openSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it("keeps the source when syncing the archive directory fails", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realOpen = fs.open.bind(fs);
    let injectedFailure = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === path.dirname(storePath) && args[1] === "r" && !injectedFailure) {
        injectedFailure = true;
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          createFsError("EIO", "directory fsync failed"),
        );
      }
      return handle;
    });

    await withRestoredMocks([openSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it.each([
    { label: "string id", jobId: "legacy-job", expectedId: "legacy-job", jobCount: 1 },
    { label: "numeric id", jobId: 7, expectedId: "7", jobCount: 1 },
    { label: "duplicate missing ids", jobId: undefined, expectedId: undefined, jobCount: 2 },
  ])(
    "rolls back a $label archive and retries without duplicates",
    async ({ jobId, expectedId, jobCount }) => {
      const storePath = await makeTempStorePath();
      const archivePath = `${storePath}.migrated`;
      await writeCronStore(
        storePath,
        Array.from({ length: jobCount }, () => createLegacyCronJob({ id: undefined, jobId })),
      );

      const renameSpy = mockExdevRename(storePath);
      const realUnlink = fs.unlink.bind(fs);
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
        if (target === storePath) {
          throw createFsError("EBUSY", "resource busy, unlink");
        }
        return await realUnlink(target);
      });

      await withRestoredMocks([unlinkSpy, renameSpy], async () => {
        await maybeRepairLegacyCronStore({
          cfg: createCronConfig(storePath),
          options: {},
          prompter: makePrompter(true),
        });

        await expect(fs.stat(storePath)).resolves.toBeTruthy();
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        expectNoteContaining("EBUSY", "Doctor warnings");
        expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
      });

      const firstJobs = await readPersistedJobs(storePath);
      expect(firstJobs).toHaveLength(jobCount);
      if (expectedId) {
        expect(firstJobs[0]?.id).toBe(expectedId);
      } else {
        const ids = firstJobs.map((job) => job.id);
        expect(ids).toHaveLength(new Set(ids).size);
        for (const id of ids) {
          expect(id).toMatch(/^cron-migrated-\d+-[a-f0-9]{64}$/);
        }
      }

      noteMock.mockClear();
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(archivePath)).resolves.toBeTruthy();
      await expect(fs.stat(`${archivePath}.2`)).rejects.toMatchObject({ code: "ENOENT" });
      const secondJobs = await readPersistedJobs(storePath);
      expect(secondJobs).toHaveLength(jobCount);
      expect(secondJobs.map((job) => job.id)).toEqual(firstJobs.map((job) => job.id));
      expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    },
  );

  it("does not resurrect a migrated job removed before an archive retry", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob({ id: undefined, jobId: undefined })]);

    const renameSpy = mockExdevRename(storePath);
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (target === storePath) {
        throw createFsError("EBUSY", "resource busy, unlink");
      }
      return await realUnlink(target);
    });

    await withRestoredMocks([unlinkSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
      expectNoteContaining("EBUSY", "Doctor warnings");
    });
    expect(await readPersistedJobs(storePath)).toHaveLength(1);

    // Simulate runtime-owned one-shot deletion after SQLite import but before cleanup retry.
    await writeCurrentCronStore(storePath, []);
    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expect(await readPersistedJobs(storePath)).toHaveLength(0);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(archivePath)).resolves.toBeTruthy();
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

    const entries = readCronTaskRunHistoryPage({
      storeKey: cronStoreKey(storePath),
      jobId: "sqlite-job",
    }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobId).toBe("sqlite-job");
    expect(entries[0]?.summary).toBe("done");
    await expect(fs.stat(runLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${runLogPath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("legacy JSON cron run logs will be imported into SQLite", "Cron");
    expectNoteContaining("Cron run logs migrated to SQLite", "Doctor changes");
  });

  it("does not report store normalization when run-log migration fails", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [createCurrentCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "sqlite-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(runLogPath, "{}\n", "utf-8");

    const realReadFileSync = fsSync.readFileSync.bind(fsSync);
    const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, options) => {
      if (filePath === runLogPath) {
        throw createFsError("EIO", "run-log read failed");
      }
      return realReadFileSync(filePath as never, options as never) as never;
    });

    await withRestoredMocks([readSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    await expect(fs.stat(runLogPath)).resolves.toBeTruthy();
    expectNoteContaining("run-log read failed", "Doctor warnings");
    expectNoNoteContaining("Cron store normalized", "Doctor changes");
    expectNoNoteContaining("Cron run logs migrated", "Doctor changes");
  });

  it("does not claim legacy store detected when only non-legacy issues exist (#92683)", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "notify-job",
        name: "Notify job",
        notify: true,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store issues detected", "Cron");
    expectNoteContaining("1 job still uses legacy", "Cron");
  });

  it("advises on isolated shell-prompt jobs without a non-actionable --fix repair note (#94655)", async () => {
    const storePath = await makeTempStorePath();
    const shellPromptJobs: Array<Record<string, unknown>> = [
      createCurrentCronJob({
        id: "shell-prompt-job-1",
        name: "Shell prompt job 1",
        schedule: { kind: "cron", expr: "*/30 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message:
            "Run python3 scripts/check_mail.py and send a compact summary if anything changed.",
          toolsAllow: ["*"],
        },
        delivery: { mode: "announce" },
      }),
      createCurrentCronJob({
        id: "shell-prompt-job-2",
        name: "Shell prompt job 2",
        schedule: { kind: "cron", expr: "15 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Run node scripts/check_mail.js and summarize any new messages.",
          toolsAllow: ["bash"],
        },
        delivery: { mode: "announce" },
      }),
      createCurrentCronJob({
        id: "shell-prompt-job-3",
        name: "Shell prompt job 3",
        schedule: { kind: "cron", expr: "45 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Execute ./scripts/check_mail.sh and report changed mailbox counts.",
          toolsAllow: ["shell"],
        },
        delivery: { mode: "announce" },
      }),
    ];
    const shellPromptJob = requirePersistedJob(shellPromptJobs, 0);
    await writeCurrentCronStore(storePath, shellPromptJobs);

    const prompter = makePrompter(true);
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    // The advisory is informational only: doctor --fix cannot rewrite a working
    // isolated agentTurn job, so the misleading repair note must stay absent.
    expectNoNoteContaining("Cron store issues detected", "Cron");
    expectNoteContaining(
      "3 isolated cron jobs drive shell/process tools from the agent prompt and keep running as-is: `Shell prompt job 1`, `Shell prompt job 2`, `Shell prompt job 3`.",
      "Cron",
    );
    expectNoteContaining("informational only", "Cron");
    expectNoteContaining("Shell prompt job 1", "Cron");
    expectNoteContaining("Shell prompt job 2", "Cron");
    expectNoteContaining("Shell prompt job 3", "Cron");
    expectNoNoteContaining("openclaw doctor --fix", "Cron");
    expectNoNoteContaining("jobs.json", "Cron");
    expect(prompter.confirm).not.toHaveBeenCalled();

    // No churn: the advisory does not rewrite the still-working jobs.
    const persistedJobs = await readPersistedJobs(storePath);
    expect(persistedJobs).toEqual(shellPromptJobs);
    const job = requirePersistedJob(persistedJobs, 0);
    expect(job).toEqual(shellPromptJob);
    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    expect(reloaded.configJobIndexes).toEqual([0, 1, 2]);
    expect(reloaded.invalidConfigRows).toEqual([]);
    const configJob = requirePersistedJob(reloaded.configJobs, 0);
    expect(configJob).toEqual(
      Object.fromEntries(Object.entries(shellPromptJob).filter(([key]) => key !== "updatedAtMs")),
    );
    expect(reloaded.configJobRuntimeEntries[0]).toEqual({
      updatedAtMs: shellPromptJob.updatedAtMs,
      state: {},
      scheduleIdentity: JSON.stringify({
        version: 1,
        enabled: shellPromptJob.enabled,
        schedule: shellPromptJob.schedule,
      }),
    });
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain("python3 scripts/check_mail.py");
  });

  it("keeps restricted command prompts actionable without a --fix repair note", async () => {
    const storePath = await makeTempStorePath();
    const commandPromptJob = createCurrentCronJob({
      id: "restricted-command-prompt",
      name: "Restricted command prompt",
      schedule: { kind: "cron", expr: "*/30 * * * *", tz: "UTC" },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: [
          "Command to run:",
          "- command: python3 scripts/check_mail.py",
          "- workdir: /home/openclaw/.razor/clawd",
        ].join("\n"),
        toolsAllow: ["read", "message"],
      },
      delivery: { mode: "announce" },
    });
    await writeCurrentCronStore(storePath, [commandPromptJob]);

    const prompter = makePrompter(true);
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    expectNoNoteContaining("Cron store issues detected", "Cron");
    expectNoteContaining(
      "1 isolated cron job describes a shell command in the agent prompt but lacks shell/process tool access: `Restricted command prompt`.",
      "Cron",
    );
    expectNoteContaining("not the supported shell-tool prompt shape", "Cron");
    expectNoteContaining("Recreate the job as a command cron job", "Cron");
    expectNoNoteContaining("informational only", "Cron");
    expectNoNoteContaining("keep running as-is", "Cron");
    expectNoNoteContaining("openclaw doctor --fix", "Cron");
    expect(prompter.confirm).not.toHaveBeenCalled();

    const job = requirePersistedJob(await readPersistedJobs(storePath), 0);
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain("python3 scripts/check_mail.py");
    expect(payload.toolsAllow).toEqual(["read", "message"]);
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
    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = reloaded.configJobs as unknown as Array<Record<string, unknown>>;
    expect(persisted[0]?.notify).toBe(true);
    expectNoteContaining(
      "cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically",
      "Doctor warnings",
    );
  });

  it("removes inert legacy notify:true for delivery.mode none when cron.webhook is unset and stops looping (#44460)", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createCurrentCronJob({
        id: "notify-none-unset",
        name: "Notify none unset",
        notify: true,
        delivery: { mode: "none" },
      }),
    ]);

    const cfg = { cron: { store: storePath } } as OpenClawConfig;
    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = reloaded.configJobs as unknown as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.notify).toBeUndefined();
    expect(requireRecord(persisted[0]?.delivery, "cron delivery").mode).toBe("none");
    expectNoNoteContaining(
      "cron.webhook is unset so doctor cannot migrate it automatically",
      "Doctor warnings",
    );

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });
    expectNoNoteContaining("still uses legacy `notify: true`", "Cron");
  });

  it("drops inert legacy notify alongside existing announce delivery without changing it when cron.webhook is unset (#44460)", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createCurrentCronJob({
        id: "notify-announce-unset",
        name: "Notify announce unset",
        notify: true,
        payload: { kind: "agentTurn", message: "Status" },
        delivery: { mode: "announce", to: "telegram:123" },
      }),
    ]);

    const cfg = { cron: { store: storePath } } as OpenClawConfig;
    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = reloaded.configJobs as unknown as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.notify).toBeUndefined();
    const delivery = requireRecord(persisted[0]?.delivery, "cron delivery");
    expect(delivery.mode).toBe("announce");
    expect(delivery.to).toBe("telegram:123");
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
