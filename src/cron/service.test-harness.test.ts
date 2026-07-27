// Cron service harness tests cover per-case SQLite and filesystem cleanup.
import { describe, expect, it } from "vitest";
import { createCronStoreHarness, writeCronStoreSnapshot } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-harness-" });
let previousStorePath: string | undefined;

function testJob() {
  return {
    id: "job-1",
    name: "Test job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every" as const, everyMs: 60_000 },
    sessionTarget: "main" as const,
    wakeMode: "next-heartbeat" as const,
    payload: { kind: "systemEvent" as const, text: "tick" },
    state: {},
  };
}

describe("createCronStoreHarness", () => {
  it("tracks stores that callers do not explicitly clean", async () => {
    const store = await makeStorePath();
    previousStorePath = store.storePath;
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [testJob()] });
    expect((await loadCronStore(store.storePath)).jobs).toHaveLength(1);
  });

  it("clears tracked SQLite rows after each test", async () => {
    if (!previousStorePath) {
      throw new Error("expected previous test store path");
    }
    expect((await loadCronStore(previousStorePath)).jobs).toEqual([]);
  });

  it("supports explicit idempotent cleanup", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [testJob()] });

    await store.cleanup();
    await store.cleanup();

    expect((await loadCronStore(store.storePath)).jobs).toEqual([]);
  });
});
