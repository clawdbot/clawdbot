import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeCronJobScratch } from "./scratch-store.js";
import {
  loadCronJobsStoreSync,
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  saveCronJobsStore,
} from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

function job(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    agentId: "main",
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
  };
}

describe("retired Workshop cron jobs", () => {
  it.each(["async", "sync"])(
    "retires legacy rows on an already-current database through %s load",
    async (mode) => {
      await withOpenClawTestState({ label: "retired-workshop-cron" }, async (state) => {
        const storePath = state.statePath("cron", "jobs.json");
        const otherStorePath = state.statePath("other-cron", "jobs.json");
        const retired = {
          ...job("retired"),
          declarationKey: "skill-collection-review:main",
          payload: { kind: "skillCollectionReview" },
        };
        await saveCronJobsStore(storePath, { version: 1, jobs: [job("retired"), job("keep")] });
        await saveCronJobsStore(otherStorePath, { version: 1, jobs: [job("retired")] });
        for (const target of [storePath, otherStorePath]) {
          writeCronJobScratch({
            storePath: target,
            jobId: "retired",
            content: "old scratch",
            nowMs: 1,
          });
        }
        const db = openOpenClawStateDatabase().db;
        const version = db.prepare("PRAGMA user_version").get();
        db.prepare("UPDATE cron_jobs SET payload_kind = ?, job_json = ? WHERE job_id = ?").run(
          "skillCollectionReview",
          JSON.stringify(retired),
          "retired",
        );
        const count = (table: "cron_jobs" | "cron_job_scratch", target: string) =>
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM " + table + " WHERE store_key = ? AND job_id = ?",
            )
            .get(cronStoreKey(target), "retired");

        await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
        expect(count("cron_jobs", storePath)).toEqual({ count: 1 });
        const loaded =
          mode === "sync"
            ? loadCronJobsStoreSync(storePath)
            : (await loadCronJobsStoreWithConfigJobs(storePath)).store;
        expect(loaded.jobs.map((entry) => entry.id)).toEqual(["keep"]);
        expect(count("cron_jobs", storePath)).toEqual({ count: 0 });
        expect(count("cron_job_scratch", storePath)).toEqual({ count: 0 });
        expect(count("cron_jobs", otherStorePath)).toEqual({ count: 1 });
        expect(count("cron_job_scratch", otherStorePath)).toEqual({ count: 1 });
        expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
        expect((await loadCronJobsStoreWithConfigJobs(storePath)).invalidConfigRows).toEqual([]);
      });
    },
  );
});
