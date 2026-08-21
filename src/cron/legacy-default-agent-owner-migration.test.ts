import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { materializeLegacyDefaultCronJobOwners } from "./legacy-default-agent-owner-migration.js";
import { CronService } from "./service.js";
import * as cronStoreModule from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { loadCronRows, replaceCronRows } from "./store/row-codec.js";
import { ensureCronStoreEpochSchema } from "./store/schema.js";
import type { CronStoreFile } from "./types.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const migrate = (storePath: string, env: NodeJS.ProcessEnv) =>
  materializeLegacyDefaultCronJobOwners({ storePath, legacyDefaultAgentId: "ops", env });

function fixture(label: string) {
  const root = tempDirs.make(label);
  const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
  const storePath = path.join(root, "cron", "jobs.json");
  const storeKey = cronStoreKey(storePath);
  const database = openOpenClawStateDatabase({ env }).db;
  replaceCronRows(database, storeKey, { version: 1, jobs: [makeCronJob({ id: "ownerless" })] });
  return { env, storePath, storeKey, database };
}

it("preserves undecodable JSON and bumps the epoch once", async () => {
  const { env, storePath, storeKey, database } = fixture("openclaw-cron-owner-");
  database
    .prepare("UPDATE cron_jobs SET agent_id = ' ', job_json = ? WHERE store_key = ?")
    .run("{malformed", storeKey);

  expect(await migrate(storePath, env)).toBe(1);
  expect(loadCronRows(database, storeKey)[0]).toMatchObject({
    agent_id: "ops",
    job_json: "{malformed",
  });
  expect(
    (
      database
        .prepare("SELECT store_epoch FROM cron_store_epochs WHERE store_key = ?")
        .get(storeKey) as { store_epoch: number }
    ).store_epoch,
  ).toBe(1);
});

it("preserves a session-scoped owner stored only in job JSON", async () => {
  const { env, storePath, storeKey, database } = fixture("openclaw-cron-json-owner-");
  const row = loadCronRows(database, storeKey)[0];
  const jobJson = JSON.parse(row?.job_json ?? "{}") as Record<string, unknown>;
  delete jobJson.agentId;
  jobJson.sessionKey = "agent:research:main";
  database
    .prepare(
      "UPDATE cron_jobs SET agent_id = NULL, session_key = NULL, job_json = ? WHERE store_key = ?",
    )
    .run(JSON.stringify(jobJson), storeKey);

  expect(await migrate(storePath, env)).toBe(0);
  const preserved = loadCronRows(database, storeKey)[0];
  const preservedJobJson = JSON.parse(preserved?.job_json ?? "{}") as Record<string, unknown>;
  expect(preserved?.agent_id).toBeNull();
  expect(preservedJobJson).toMatchObject({
    sessionKey: "agent:research:main",
  });
  expect(preservedJobJson).not.toHaveProperty("agentId");
});

it("rolls back the row when the epoch bump fails", async () => {
  const { env, storePath, storeKey, database } = fixture("openclaw-cron-atomic-");
  ensureCronStoreEpochSchema(database);
  database.exec(`CREATE TRIGGER fail_epoch BEFORE UPDATE OF store_epoch ON cron_store_epochs
      BEGIN SELECT RAISE(ABORT, 'synthetic epoch failure'); END`);

  await expect(migrate(storePath, env)).rejects.toThrow("synthetic epoch failure");
  expect(loadCronRows(database, storeKey)[0]?.agent_id).toBeNull();
});

it("materializes before scheduler startup", async () => {
  const { env, storePath } = fixture("openclaw-cron-startup-");
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  closeOpenClawStateDatabaseForTest();
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    legacyDefaultAgentId: "ops",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  try {
    await cron.start();
    expect(cron.getLoadedJobs()?.[0]?.agentId).toBe("ops");
  } finally {
    cron.stop();
  }
});

it("owns rows imported from a JSON-only store on first startup load", async () => {
  const root = tempDirs.make("openclaw-cron-json-startup-");
  const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
  const storePath = path.join(root, "cron", "jobs.json");
  const storeKey = cronStoreKey(storePath);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify({ version: 1, jobs: [makeCronJob({ id: "json-only" })] }),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);

  const realLoad = cronStoreModule.loadCronJobsStoreWithConfigJobs;
  let imported = false;
  const loadSpy = vi
    .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
    .mockImplementation(async (requestedStorePath) => {
      if (!imported) {
        imported = true;
        const legacyStore = JSON.parse(
          await fs.readFile(requestedStorePath, "utf8"),
        ) as CronStoreFile;
        replaceCronRows(openOpenClawStateDatabase({ env }).db, storeKey, legacyStore);
      }
      return await realLoad(requestedStorePath);
    });

  const cron = new CronService({
    storePath,
    cronEnabled: true,
    legacyDefaultAgentId: "ops",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  try {
    await cron.start();
    expect(imported).toBe(true);
    expect(cron.getLoadedJobs()?.[0]?.agentId).toBe("ops");
    expect(loadCronRows(openOpenClawStateDatabase({ env }).db, storeKey)[0]?.agent_id).toBe("ops");
  } finally {
    cron.stop();
    loadSpy.mockRestore();
  }
});
