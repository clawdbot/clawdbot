import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as scheduleNativeTimeout } from "node:timers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCronStore, loadCronStoreSync, resolveCronStorePath, saveCronStore } from "./store.js";
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

async function captureRenameDestinations(action: () => Promise<void>): Promise<string[]> {
  const renamedDestinations: string[] = [];
  const origRename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
    renamedDestinations.push(String(dest));
    return origRename(src, dest);
  });

  try {
    await action();
  } finally {
    spy.mockRestore();
  }

  return renamedDestinations;
}

describe("resolveCronStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

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

  it("throws when store contains invalid JSON", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/Failed to parse cron store/i);
  });

  it("accepts JSON5 syntax when loading an existing cron store", async () => {
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

    await expect(loadCronStore(store.storePath)).resolves.toMatchObject({
      version: 1,
      jobs: [{ id: "job-1", enabled: true }],
    });
  });

  it("loads split cron state synchronously for task reconciliation", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, makeStore("job-sync", true));

    const loaded = loadCronStoreSync(storePath);

    expect(loaded.jobs[0]).toMatchObject({
      id: "job-sync",
      state: expect.any(Object),
      updatedAtMs: expect.any(Number),
    });
  });

  it("does not create a backup file when saving unchanged content", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);

    await saveCronStore(store.storePath, payload);
    await saveCronStore(store.storePath, payload);

    await expect(fs.stat(`${store.storePath}.bak`)).rejects.toThrow();
  });

  it("backs up previous content before replacing the store", async () => {
    const store = await makeStorePath();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", false);

    await saveCronStore(store.storePath, first);
    await saveCronStore(store.storePath, second);

    const currentRaw = await fs.readFile(store.storePath, "utf-8");
    const backupRaw = await fs.readFile(`${store.storePath}.bak`, "utf-8");
    const current = JSON.parse(currentRaw);
    const backup = JSON.parse(backupRaw);
    // jobs.json now contains config-only (state stripped to {}).
    expect(current.jobs[0].id).toBe("job-2");
    expect(current.jobs[0].state).toEqual({});
    expect(backup.jobs[0].id).toBe("job-1");
    expect(backup.jobs[0].state).toEqual({});
  });

  it("skips backup files for runtime-only state churn", async () => {
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

    // jobs.json should NOT be rewritten (only runtime changed).
    const configRaw = await fs.readFile(store.storePath, "utf-8");
    const config = JSON.parse(configRaw);
    expect(config.jobs[0].state).toEqual({});
    expect(config.jobs[0]).not.toHaveProperty("updatedAtMs");

    // State file should contain runtime fields.
    const statePath = store.storePath.replace(/\.json$/, "-state.json");
    const stateRaw = await fs.readFile(statePath, "utf-8");
    const stateFile = JSON.parse(stateRaw);
    expect(stateFile.jobs[first.jobs[0].id].state.nextRunAtMs).toBe(
      first.jobs[0].createdAtMs + 60_000,
    );

    await expect(fs.stat(`${store.storePath}.bak`)).rejects.toThrow();
  });

  it("keeps state separate for custom store paths without a json suffix", async () => {
    const store = await makeStorePath();
    const storePath = store.storePath.replace(/\.json$/, "");
    const statePath = `${storePath}-state.json`;
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

    const config = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(Array.isArray(config.jobs)).toBe(true);
    expect(config.jobs[0].id).toBe("job-1");
    expect(config.jobs[0].state).toEqual({});

    const stateFile = JSON.parse(await fs.readFile(statePath, "utf-8"));
    expect(stateFile.jobs["job-1"].state.nextRunAtMs).toBe(first.jobs[0].createdAtMs + 60_000);

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(first.jobs[0].createdAtMs + 60_000);
  });

  it("recreates a missing state sidecar without rewriting unchanged config", async () => {
    const store = await makeStorePath();
    const statePath = store.storePath.replace(/\.json$/, "-state.json");
    const payload = makeStore("job-1", true);
    payload.jobs[0].state = { nextRunAtMs: payload.jobs[0].createdAtMs + 60_000 };

    await saveCronStore(store.storePath, payload);
    await loadCronStore(store.storePath);
    const configRawBefore = await fs.readFile(store.storePath, "utf-8");
    await fs.rm(statePath);

    const renamedDestinations = await captureRenameDestinations(() =>
      saveCronStore(store.storePath, payload),
    );

    const configRawAfter = await fs.readFile(store.storePath, "utf-8");
    const stateFile = JSON.parse(await fs.readFile(statePath, "utf-8"));

    expect(configRawAfter).toBe(configRawBefore);
    expect(renamedDestinations).toContain(statePath);
    expect(renamedDestinations).not.toContain(store.storePath);
    expect(stateFile.jobs["job-1"].state.nextRunAtMs).toBe(payload.jobs[0].createdAtMs + 60_000);
  });

  it("recreates a missing config file without rewriting unchanged state", async () => {
    const store = await makeStorePath();
    const statePath = store.storePath.replace(/\.json$/, "-state.json");
    const payload = makeStore("job-1", true);
    payload.jobs[0].state = { nextRunAtMs: payload.jobs[0].createdAtMs + 60_000 };

    await saveCronStore(store.storePath, payload);
    await loadCronStore(store.storePath);
    const stateRawBefore = await fs.readFile(statePath, "utf-8");
    await fs.rm(store.storePath);

    const renamedDestinations = await captureRenameDestinations(() =>
      saveCronStore(store.storePath, payload),
    );

    const config = JSON.parse(await fs.readFile(store.storePath, "utf-8"));
    const stateRawAfter = await fs.readFile(statePath, "utf-8");

    expect(config.jobs[0].id).toBe("job-1");
    expect(config.jobs[0].state).toEqual({});
    expect(stateRawAfter).toBe(stateRawBefore);
    expect(renamedDestinations).toContain(store.storePath);
    expect(renamedDestinations).not.toContain(statePath);
  });

  it("migrates legacy inline state into the state sidecar", async () => {
    const store = await makeStorePath();
    const statePath = store.storePath.replace(/\.json$/, "-state.json");
    const legacy = makeStore("job-1", true);
    legacy.jobs[0].state = {
      lastRunAtMs: legacy.jobs[0].createdAtMs + 30_000,
      nextRunAtMs: legacy.jobs[0].createdAtMs + 60_000,
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(legacy, null, 2), "utf-8");

    const loaded = await loadCronStore(store.storePath);
    await saveCronStore(store.storePath, loaded);

    const config = JSON.parse(await fs.readFile(store.storePath, "utf-8"));
    const stateFile = JSON.parse(await fs.readFile(statePath, "utf-8"));

    expect(config.jobs[0]).not.toHaveProperty("updatedAtMs");
    expect(config.jobs[0].state).toEqual({});
    expect(stateFile.jobs["job-1"].updatedAtMs).toBe(legacy.jobs[0].updatedAtMs);
    expect(stateFile.jobs["job-1"].state.nextRunAtMs).toBe(legacy.jobs[0].createdAtMs + 60_000);
  });

  it("ignores array-shaped state sidecars when migrating legacy inline state", async () => {
    const store = await makeStorePath();
    const statePath = store.storePath.replace(/\.json$/, "-state.json");
    // Numeric-looking IDs catch accidental array indexing in invalid sidecars.
    const legacy = makeStore("0", true);
    legacy.jobs[0].state = {
      lastRunAtMs: legacy.jobs[0].createdAtMs + 30_000,
      nextRunAtMs: legacy.jobs[0].createdAtMs + 60_000,
    };
    const staleSidecar = {
      ...legacy,
      jobs: [
        {
          ...legacy.jobs[0],
          updatedAtMs: legacy.jobs[0].updatedAtMs + 10_000,
          state: {
            nextRunAtMs: legacy.jobs[0].createdAtMs + 120_000,
          },
        },
      ],
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(legacy, null, 2), "utf-8");
    await fs.writeFile(statePath, JSON.stringify(staleSidecar, null, 2), "utf-8");

    const loaded = await loadCronStore(store.storePath);
    await saveCronStore(store.storePath, loaded);

    const stateFile = JSON.parse(await fs.readFile(statePath, "utf-8"));

    expect(loaded.jobs[0]?.updatedAtMs).toBe(legacy.jobs[0].updatedAtMs);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(legacy.jobs[0].createdAtMs + 60_000);
    expect(Array.isArray(stateFile.jobs)).toBe(false);
    expect(stateFile.jobs["0"].updatedAtMs).toBe(legacy.jobs[0].updatedAtMs);
    expect(stateFile.jobs["0"].state.nextRunAtMs).toBe(legacy.jobs[0].createdAtMs + 60_000);
  });

  it("treats a corrupt state sidecar as absent", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    payload.jobs[0].state = { nextRunAtMs: payload.jobs[0].createdAtMs + 60_000 };
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await saveCronStore(store.storePath, payload);
    await fs.writeFile(statePath, "{ not json", "utf-8");

    const loaded = await loadCronStore(store.storePath);

    expect(loaded.jobs[0]?.updatedAtMs).toBe(payload.jobs[0].createdAtMs);
    expect(loaded.jobs[0]?.state).toEqual({});
  });

  it("propagates unreadable state sidecar errors", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await saveCronStore(store.storePath, payload);

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
      await expect(loadCronStore(store.storePath)).rejects.toThrow(/Failed to read cron state/);
    } finally {
      spy.mockRestore();
    }
  });

  it("sanitizes invalid updatedAtMs values from the state sidecar", async () => {
    const store = await makeStorePath();
    const job = makeStore("job-1", true).jobs[0];
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

    const loaded = await loadCronStore(store.storePath);

    expect(loaded.jobs[0]?.updatedAtMs).toBe(job.createdAtMs);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(job.createdAtMs + 60_000);
  });

  it.skipIf(process.platform === "win32")(
    "writes store and backup files with secure permissions",
    async () => {
      const store = await makeStorePath();
      const first = makeStore("job-1", true);
      const second = makeStore("job-2", false);

      await saveCronStore(store.storePath, first);
      await saveCronStore(store.storePath, second);

      const storeMode = (await fs.stat(store.storePath)).mode & 0o777;
      const backupMode = (await fs.stat(`${store.storePath}.bak`)).mode & 0o777;

      expect(storeMode).toBe(0o600);
      expect(backupMode).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "hardens an existing cron store directory to owner-only permissions",
    async () => {
      const store = await makeStorePath();
      const storeDir = path.dirname(store.storePath);
      await fs.mkdir(storeDir, { recursive: true, mode: 0o755 });
      await fs.chmod(storeDir, 0o755);

      await saveCronStore(store.storePath, makeStore("job-1", true));

      const storeDirMode = (await fs.stat(storeDir)).mode & 0o777;
      expect(storeDirMode).toBe(0o700);
    },
  );
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

  it("retries rename on EBUSY then succeeds", async () => {
    const { storePath } = await makeStorePath();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
        scheduleNativeTimeout(handler, 0, ...args)) as typeof setTimeout);
    const origRename = fs.rename.bind(fs);
    let ebusyCount = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
      if (ebusyCount < 2) {
        ebusyCount++;
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return origRename(src, dest);
    });

    try {
      await saveCronStore(storePath, dummyStore);

      expect(ebusyCount).toBe(2);
      const loaded = await loadCronStore(storePath);
      expect(loaded).toEqual(dummyStore);
    } finally {
      spy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("falls back to copyFile on EPERM (Windows)", async () => {
    const { storePath } = await makeStorePath();

    const spy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    await saveCronStore(storePath, dummyStore);
    const loaded = await loadCronStore(storePath);
    expect(loaded).toEqual(dummyStore);

    spy.mockRestore();
  });
});
