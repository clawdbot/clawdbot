// Duplicate timer tests cover cron service guards against repeated timer arms.
import { mkdir, symlink } from "node:fs/promises";
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
    { name: "a symlinked path to the same store", alias: "symlink" },
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
    } else if (alias === "symlink") {
      const symlinkedStoreDirectory = path.join(
        path.dirname(path.dirname(store.storePath)),
        "symlinked-cron",
      );
      await symlink(
        path.dirname(store.storePath),
        symlinkedStoreDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      aliasedStorePath = path.join(symlinkedStoreDirectory, path.basename(store.storePath));
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

  it.each([
    { name: "lexical", alias: "lexical" },
    { name: "symlink", alias: "symlink" },
    ...(process.platform === "win32"
      ? []
      : [{ name: "dangling file symlink", alias: "file-symlink" } as const]),
  ] as const)(
    "serializes concurrent operations for $name cron store aliases",
    async ({ alias }) => {
      const store = await makeStorePath();
      let aliasedStorePath = `${path.dirname(store.storePath)}/../${path.basename(path.dirname(store.storePath))}/${path.basename(store.storePath)}`;
      if (alias === "symlink") {
        const realStoreDirectory = path.dirname(store.storePath);
        await mkdir(realStoreDirectory, { recursive: true });
        const symlinkedStoreDirectory = path.join(
          path.dirname(realStoreDirectory),
          "symlinked-cron-lock",
        );
        await symlink(
          realStoreDirectory,
          symlinkedStoreDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
        aliasedStorePath = path.join(symlinkedStoreDirectory, path.basename(store.storePath));
      } else if (alias === "file-symlink") {
        await mkdir(path.dirname(store.storePath), { recursive: true });
        aliasedStorePath = path.join(path.dirname(store.storePath), "symlinked-jobs.json");
        await symlink(path.basename(store.storePath), aliasedStorePath, "file");
      }
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
    },
  );
});
