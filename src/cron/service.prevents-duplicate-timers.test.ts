// Duplicate timer tests cover cron service guards against repeated timer arms.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { locked } from "./service/locked.js";
import { createCronServiceState } from "./service/state.js";
import { loadCronStore } from "./store.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-" });
installCronTestHooks({
  logger: noopLogger,
  baseTimeIso: "2025-12-13T00:00:00.000Z",
});

describe("CronService", () => {
  it.each([
    { name: "the same store path", alias: "none" },
    { name: "lexically different paths to the same store", alias: "lexical" },
  ] as const)("avoids duplicate runs when two services share $name", async ({ alias }) => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));

    const cronA = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await cronA.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cronA.add({
      name: "shared store job",
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });

    let aliasedStorePath = store.storePath;
    if (alias === "lexical") {
      aliasedStorePath = `${path.dirname(store.storePath)}/../${path.basename(path.dirname(store.storePath))}/${path.basename(store.storePath)}`;
    }

    const cronB = new CronService({
      storePath: aliasedStorePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await cronB.start();
    expect((await loadCronStore(aliasedStorePath)).jobs).toHaveLength(1);

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await cronA.status();
    await cronB.status();

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(requestHeartbeat).toHaveBeenCalledTimes(1);

    cronA.stop();
    cronB.stop();
    await store.cleanup();
  });

  it("serializes concurrent operations for the same SQLite cron partition", async () => {
    const store = await makeStorePath();
    const aliasedStorePath = `${path.dirname(store.storePath)}/../${path.basename(path.dirname(store.storePath))}/${path.basename(store.storePath)}`;
    const createState = (storePath: string) =>
      createCronServiceState({
        storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = locked(createState(store.storePath), async () => {
      events.push("first-started");
      await firstReleased;
      events.push("first-finished");
    });
    const second = locked(createState(aliasedStorePath), async () => {
      events.push("second-started");
    });

    try {
      await vi.waitFor(() => {
        expect(events).toEqual(["first-started"]);
      });
    } finally {
      releaseFirst?.();
      await Promise.all([first, second]);
      await store.cleanup();
    }

    expect(events).toEqual(["first-started", "first-finished", "second-started"]);
  });

  it("keeps sibling jobs when separately loaded services mutate the same partition", async () => {
    const store = await makeStorePath();
    const createService = () =>
      new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
    const cronA = createService();
    const cronB = createService();
    await cronA.status();
    await cronB.status();

    const addJob = (service: CronService, id: string) =>
      service.add({
        id,
        name: id,
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: id },
      });

    await addJob(cronA, "first-cached-service-job");
    await addJob(cronB, "second-cached-service-job");

    expect((await loadCronStore(store.storePath)).jobs.map((job) => job.id)).toEqual([
      "first-cached-service-job",
      "second-cached-service-job",
    ]);
    cronA.stop();
    cronB.stop();
    await store.cleanup();
  });
});
