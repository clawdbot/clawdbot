import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronJobsStoreChanges, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-shared-runtime-" });

const log = { debug() {}, info() {}, warn() {}, error() {} };

function createDisabledService(storePath: string): CronService {
  return new CronService({
    cronEnabled: false,
    storePath,
    log,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    async runIsolatedAgentJob() {
      return { status: "ok" as const, summary: "unused" };
    },
  });
}

async function addCanary(cron: CronService, suffix: string): Promise<CronJob> {
  return await cron.add({
    name: `canary-${suffix}`,
    enabled: true,
    schedule: {
      kind: "every",
      everyMs: 86_400_000,
      anchorMs: Date.now() + 86_400_000,
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run canary" },
  });
}

async function addTarget(cron: CronService, suffix: string): Promise<CronJob> {
  return await cron.add({
    name: `target-${suffix}`,
    enabled: true,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "target" },
  });
}

const schedulerChildScript = String.raw`
import path from "node:path";
import { pathToFileURL } from "node:url";
const runs = JSON.parse(process.env.OPENCLAW_CRON_SHARED_STORE_RUNS);
const { CronService } = await import(pathToFileURL(path.join(process.cwd(), "src/cron/service.ts")).href);
const log = { debug() {}, info() {}, warn() {}, error() {} };
for (const run of runs) {
  const cron = new CronService({
    cronEnabled: true,
    storePath: run.storePath,
    log,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    async runIsolatedAgentJob() {
      return { status: "ok", summary: "scheduler child completed" };
    },
  });
  await cron.start();
  const result = await cron.run(run.jobId, "force");
  cron.stop();
  if (!result.ok || !("ran" in result) || result.ran !== true) {
    throw new Error("scheduler child did not run " + run.jobId + ": " + JSON.stringify(result));
  }
}
`;

describe("scheduler-disabled shared-store mutations", () => {
  it("cannot overwrite runtime committed by a scheduler process", async () => {
    const cases = await Promise.all(
      ["add", "update", "remove", "same-job-update", "state-update"].map(async (operation) => {
        const { storePath } = await makeStorePath();
        const cron = createDisabledService(storePath);
        await cron.start();
        const canary = await addCanary(cron, operation);
        const target = ["update", "remove"].includes(operation)
          ? await addTarget(cron, operation)
          : undefined;
        return { canary, cron, operation, storePath, target };
      }),
    );

    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(process.cwd(), "scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        schedulerChildScript,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CRON_SHARED_STORE_RUNS: JSON.stringify(
            cases.map(({ canary, storePath }) => ({ jobId: canary.id, storePath })),
          ),
        },
        timeout: 60_000,
      },
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);

    for (const testCase of cases) {
      const before = (await loadCronStore(testCase.storePath)).jobs.find(
        (job) => job.id === testCase.canary.id,
      );
      expect(before?.state.lastStatus).toBe("ok");
      expect(before?.state.lastRunAtMs).toEqual(expect.any(Number));

      if (testCase.operation === "add") {
        const added = await addTarget(testCase.cron, "added");
        expect(
          (await loadCronStore(testCase.storePath)).jobs.some((job) => job.id === added.id),
        ).toBe(true);
      } else if (testCase.operation === "update" && testCase.target) {
        await testCase.cron.updateWithPrecondition(
          testCase.target.id,
          { name: "target-updated" },
          () => {},
        );
        expect(
          (await loadCronStore(testCase.storePath)).jobs.find(
            (job) => job.id === testCase.target?.id,
          )?.name,
        ).toBe("target-updated");
      } else if (testCase.operation === "same-job-update") {
        await testCase.cron.update(testCase.canary.id, { name: "canary-updated" });
      } else if (testCase.operation === "state-update") {
        await testCase.cron.update(testCase.canary.id, { state: { consecutiveErrors: 7 } });
      } else if (testCase.target) {
        await testCase.cron.remove(testCase.target.id);
        expect(
          (await loadCronStore(testCase.storePath)).jobs.some(
            (job) => job.id === testCase.target?.id,
          ),
        ).toBe(false);
      }

      const after = (await loadCronStore(testCase.storePath)).jobs.find(
        (job) => job.id === testCase.canary.id,
      );
      expect(after?.state).toEqual(
        testCase.operation === "state-update"
          ? { ...before?.state, consecutiveErrors: 7 }
          : before?.state,
      );
      testCase.cron.stop();
    }
  }, 90_000);

  it("rejects a stale config mutation instead of overwriting its peer", async () => {
    const { storePath } = await makeStorePath();
    const seed = createDisabledService(storePath);
    const target = await addTarget(seed, "config-conflict");
    seed.stop();

    const cron = new CronService({
      cronEnabled: false,
      storePath,
      log,
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      async runIsolatedAgentJob() {
        return { status: "ok" as const, summary: "unused" };
      },
      async listConfiguredChannels() {
        const peerStore = await loadCronStore(storePath);
        const peerTarget = peerStore.jobs.find((job) => job.id === target.id);
        if (!peerTarget) {
          throw new Error("missing peer target");
        }
        peerTarget.name = "peer-update";
        await saveCronStore(storePath, peerStore);
        return [];
      },
    });

    await expect(
      cron.update(target.id, {
        delivery: { mode: "webhook", to: "https://example.com/cron" },
      }),
    ).rejects.toThrow("changed after it was read");
    const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === target.id);
    expect(persisted?.name).toBe("peer-update");
    expect(persisted?.delivery).toBeUndefined();
    cron.stop();
  });

  it("rejects deleting a row whose config a peer rewrote", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDisabledService(storePath);
    const target = await addTarget(cron, "delete-conflict");
    cron.stop();
    const baseline = await loadCronStore(storePath);
    const peerStore = structuredClone(baseline);
    const peerTarget = peerStore.jobs.find((job) => job.id === target.id);
    if (!peerTarget) {
      throw new Error("missing peer delete target");
    }
    peerTarget.description = "peer rewrite";
    await saveCronStore(storePath, peerStore);

    await expect(
      saveCronJobsStoreChanges(storePath, baseline, { version: 1, jobs: [] }),
    ).rejects.toThrow("changed after it was read");
    const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === target.id);
    expect(persisted?.description).toBe("peer rewrite");
  });
});
