import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginStateLease } from "./plugin-state-lease.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("lease aborted", { cause: signal.reason });
}

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("plugin state SQLite leases", () => {
  it("places shared and agent leases in their canonical databases", async () => {
    await withOpenClawTestState({ label: "plugin-lease-placement" }, async (state) => {
      const sharedEntered = deferred();
      const releaseShared = deferred();
      const shared = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => {
          sharedEntered.resolve();
          await releaseShared.promise;
        },
      );
      await sharedEntered.promise;
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT scope, lease_key FROM state_leases")
          .all(),
      ).toEqual([{ scope: "plugin:memory-core:qmd", lease_key: "embed" }]);
      releaseShared.resolve();
      await shared;

      const agentEntered = deferred();
      const releaseAgent = deferred();
      const agent = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "write",
          database: { scope: "agent", agentId: "main" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => {
          agentEntered.resolve();
          await releaseAgent.promise;
        },
      );
      await agentEntered.promise;
      expect(
        openOpenClawAgentDatabase({ agentId: "main", env: state.env })
          .db.prepare("SELECT scope, lease_key FROM state_leases")
          .all(),
      ).toEqual([{ scope: "plugin:memory-core:qmd", lease_key: "write" }]);
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT scope, lease_key FROM state_leases")
          .all(),
      ).toEqual([]);
      releaseAgent.resolve();
      await agent;
    });
  });

  it("serializes contenders and times out without entering the callback", async () => {
    await withOpenClawTestState({ label: "plugin-lease-contenders" }, async () => {
      const firstEntered = deferred();
      const releaseFirst = deferred();
      const first = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 2_000,
          waitMs: 0,
        },
        async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
        },
      );
      await firstEntered.promise;

      const timedOutCallback = vi.fn(async () => undefined);
      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "shared" },
            leaseMs: 2_000,
            waitMs: 0,
          },
          timedOutCallback,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_TIMEOUT" });
      expect(timedOutCallback).not.toHaveBeenCalled();

      const waitAbort = new AbortController();
      const abortedCallback = vi.fn(async () => undefined);
      const abortedWait = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 2_000,
          waitMs: 2_000,
          signal: waitAbort.signal,
        },
        abortedCallback,
      );
      const aborted = expect(abortedWait).rejects.toMatchObject({
        code: "PLUGIN_STATE_LEASE_ABORTED",
      });
      waitAbort.abort(new Error("stop waiting"));
      await aborted;
      expect(abortedCallback).not.toHaveBeenCalled();

      const secondEntered = deferred();
      const second = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 2_000,
          waitMs: 2_000,
        },
        async () => {
          secondEntered.resolve();
        },
      );
      let entered = false;
      void secondEntered.promise.then(() => {
        entered = true;
      });
      await Promise.resolve();
      expect(entered).toBe(false);
      releaseFirst.resolve();
      await first;
      await second;
      expect(entered).toBe(true);
    });
  });

  it("does not enter the callback after acquisition expires", async () => {
    await withOpenClawTestState({ label: "plugin-lease-expired-entry" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env }).db;
      const callback = vi.fn(async () => undefined);
      const now = vi.spyOn(Date, "now").mockImplementation(() => {
        const acquired = database
          .prepare("SELECT 1 FROM state_leases WHERE lease_key = 'embed'")
          .get();
        // Model a wall-clock jump immediately after the acquisition row is
        // committed but before the callback can enter.
        return acquired ? 11_001 : 10_000;
      });
      try {
        await expect(
          withPluginStateLease(
            "memory-core",
            {
              namespace: "qmd",
              key: "embed",
              database: { scope: "shared" },
              leaseMs: 1_000,
              waitMs: 0,
            },
            callback,
          ),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_LOST" });
        expect(callback).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
      }
    });
  });

  it("does not serialize different per-agent databases", async () => {
    await withOpenClawTestState({ label: "plugin-lease-agents" }, async () => {
      const release = deferred();
      const entered: string[] = [];
      const runs = ["main", "research"].map((agentId) =>
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "write",
            database: { scope: "agent", agentId },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async () => {
            entered.push(agentId);
            if (entered.length === 2) {
              release.resolve();
            }
            await release.promise;
          },
        ),
      );
      await Promise.all(runs);
      expect(entered.toSorted()).toEqual(["main", "research"]);
    });
  });

  it("aborts the critical section when ownership is replaced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await withOpenClawTestState({ label: "plugin-lease-loss" }, async (state) => {
      const entered = deferred();
      const run = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async ({ signal }) => {
          entered.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
          });
        },
      );
      const lost = expect(run).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_LOST" });
      await entered.promise;
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          `UPDATE state_leases
           SET owner = 'successor', expires_at = ?, updated_at = ?
           WHERE scope = 'plugin:memory-core:qmd' AND lease_key = 'embed'`,
        )
        .run(20_000, 10_100);
      await vi.advanceTimersByTimeAsync(334);
      await lost;
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT owner FROM state_leases WHERE lease_key = 'embed'")
          .get(),
      ).toEqual({ owner: "successor" });

      openOpenClawStateDatabase({ env: state.env })
        .db.prepare("DELETE FROM state_leases WHERE lease_key = 'embed'")
        .run();
      const ignoredSignalEntered = deferred();
      const finishIgnoringSignal = deferred();
      const ignoresSignal = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => {
          ignoredSignalEntered.resolve();
          await finishIgnoringSignal.promise;
          return "must-not-succeed";
        },
      );
      const ignoredLost = expect(ignoresSignal).rejects.toMatchObject({
        code: "PLUGIN_STATE_LEASE_LOST",
      });
      await ignoredSignalEntered.promise;
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          `UPDATE state_leases
           SET owner = 'second-successor', expires_at = ?, updated_at = ?
           WHERE scope = 'plugin:memory-core:qmd' AND lease_key = 'embed'`,
        )
        .run(30_000, 10_500);
      await vi.advanceTimersByTimeAsync(334);
      finishIgnoringSignal.resolve();
      await ignoredLost;
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT owner FROM state_leases WHERE lease_key = 'embed'")
          .get(),
      ).toEqual({ owner: "second-successor" });
    });
  });

  it("renews ownership and preserves callback failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    await withOpenClawTestState({ label: "plugin-lease-renewal" }, async (state) => {
      const entered = deferred();
      const release = deferred();
      const run = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      const database = openOpenClawStateDatabase({ env: state.env }).db;
      expect(database.prepare("SELECT expires_at FROM state_leases").get()).toEqual({
        expires_at: 31_000,
      });
      await vi.advanceTimersByTimeAsync(334);
      expect(
        (database.prepare("SELECT expires_at FROM state_leases").get() as { expires_at: number })
          .expires_at,
      ).toBeGreaterThan(31_000);
      await vi.advanceTimersByTimeAsync(800);
      expect(
        (database.prepare("SELECT expires_at FROM state_leases").get() as { expires_at: number })
          .expires_at,
      ).toBeGreaterThan(Date.now());
      release.resolve();
      await run;
      expect(database.prepare("SELECT owner FROM state_leases").get()).toBeUndefined();

      const callbackError = new Error("qmd failed");
      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async () => {
            throw callbackError;
          },
        ),
      ).rejects.toBe(callbackError);
      expect(database.prepare("SELECT owner FROM state_leases").get()).toBeUndefined();
    });
  });

  it("retries contended cleanup without replacing the stable timeout outcome", async () => {
    await withOpenClawTestState({ label: "plugin-lease-release-retry" }, async () => {
      const opened = openOpenClawStateDatabase();
      let blocker: DatabaseSync | undefined;
      let unblockTimer: ReturnType<typeof setTimeout> | undefined;
      const callback = vi.fn(async () => undefined);
      const realNow = performance.now.bind(performance);
      const realStartedAt = realNow();
      let nowCalls = 0;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
        nowCalls += 1;
        if (nowCalls === 1) {
          return 0;
        }
        if (nowCalls === 2) {
          const sqlite = requireNodeSqlite();
          blocker = new sqlite.DatabaseSync(opened.path);
          blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
          unblockTimer = setTimeout(() => {
            blocker?.exec("ROLLBACK");
            blocker?.close();
          }, 50);
          return 2;
        }
        return 2 + (realNow() - realStartedAt);
      });
      try {
        await expect(
          withPluginStateLease(
            "memory-core",
            {
              namespace: "qmd",
              key: "embed",
              database: { scope: "shared" },
              leaseMs: 60_000,
              waitMs: 1,
            },
            callback,
          ),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_TIMEOUT" });
      } finally {
        nowSpy.mockRestore();
        if (unblockTimer) {
          clearTimeout(unblockTimer);
        }
        if (blocker?.isOpen) {
          if (blocker.isTransaction) {
            blocker.exec("ROLLBACK");
          }
          blocker.close();
        }
      }
      expect(callback).not.toHaveBeenCalled();
      expect(opened.db.prepare("SELECT owner FROM state_leases").get()).toBeUndefined();
    });
  });

  it("reclaims expired rows and aborts an active callback on caller cancellation", async () => {
    await withOpenClawTestState({ label: "plugin-lease-expiry-abort" }, async (state) => {
      const now = Date.now();
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          `INSERT INTO state_leases
             (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run("plugin:memory-core:qmd", "embed", "expired", now - 1, now - 10, now - 10, now - 10);
      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async () => "reclaimed",
        ),
      ).resolves.toBe("reclaimed");

      const controller = new AbortController();
      const entered = deferred();
      const run = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
          signal: controller.signal,
        },
        async ({ signal }) => {
          entered.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
          });
        },
      );
      const aborted = expect(run).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_ABORTED" });
      await entered.promise;
      controller.abort(new Error("cancelled"));
      await aborted;
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT owner FROM state_leases WHERE lease_key = 'embed'")
          .get(),
      ).toBeUndefined();

      const checkpointController = new AbortController();
      const checkpointEntered = deferred();
      const reachCheckpoint = deferred();
      const checkpointRun = withPluginStateLease(
        "memory-core",
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
          signal: checkpointController.signal,
        },
        async (lease) => {
          checkpointEntered.resolve();
          await reachCheckpoint.promise;
          lease.assertOwned();
        },
      );
      const checkpointAborted = expect(checkpointRun).rejects.toMatchObject({
        code: "PLUGIN_STATE_LEASE_ABORTED",
      });
      await checkpointEntered.promise;
      checkpointController.abort(new Error("cancel before marker"));
      reachCheckpoint.resolve();
      await checkpointAborted;
    });
  });

  it("rejects invalid inputs and pre-aborted acquisition", async () => {
    await withOpenClawTestState({ label: "plugin-lease-validation" }, async () => {
      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "shared" },
            leaseMs: 999,
            waitMs: 0,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_INVALID_INPUT" });

      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: undefined as never,
            leaseMs: 1_000,
            waitMs: 0,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_INVALID_INPUT" });

      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "agent", agentId: 42 } as never,
            leaseMs: 1_000,
            waitMs: 0,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_INVALID_INPUT" });

      const controller = new AbortController();
      controller.abort(new Error("stop"));
      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
            signal: controller.signal,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_ABORTED" });

      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "max-duration",
            database: { scope: "shared" },
            leaseMs: MAX_TIMER_TIMEOUT_MS,
            waitMs: MAX_TIMER_TIMEOUT_MS,
          },
          async (lease) => {
            lease.assertOwned();
            return "ok";
          },
        ),
      ).resolves.toBe("ok");
    });
  });

  it("bounds SQLite transaction admission by waitMs", async () => {
    await withOpenClawTestState({ label: "plugin-lease-admission-timeout" }, async () => {
      const opened = openOpenClawStateDatabase();
      const sqlite = requireNodeSqlite();
      const blocker = new sqlite.DatabaseSync(opened.path);
      blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      const callback = vi.fn(async () => undefined);
      const startedAt = performance.now();
      try {
        await expect(
          withPluginStateLease(
            "memory-core",
            {
              namespace: "qmd",
              key: "embed",
              database: { scope: "shared" },
              leaseMs: 1_000,
              waitMs: 0,
            },
            callback,
          ),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_TIMEOUT" });
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(callback).not.toHaveBeenCalled();
      expect(opened.db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
    });
  });

  it("keeps ownership checks nonblocking during SQLite contention", async () => {
    await withOpenClawTestState({ label: "plugin-lease-nonblocking-ownership" }, async () => {
      const opened = openOpenClawStateDatabase();
      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async (lease) => {
            const sqlite = requireNodeSqlite();
            const blocker = new sqlite.DatabaseSync(opened.path);
            blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
            const startedAt = performance.now();
            try {
              expect(() => lease.assertOwned()).not.toThrow();
            } finally {
              blocker.exec("ROLLBACK");
              blocker.close();
            }
            expect(performance.now() - startedAt).toBeLessThan(1_000);
            expect(opened.db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
          },
        ),
      ).resolves.toBeUndefined();
    });
  });

  it("maps database open failures to the stable storage error", async () => {
    await withOpenClawTestState({ label: "plugin-lease-storage-error" }, async (state) => {
      const blockedStatePath = state.path("not-a-directory");
      await fs.writeFile(blockedStatePath, "blocked", "utf8");
      process.env.OPENCLAW_STATE_DIR = blockedStatePath;
      await expect(
        withPluginStateLease(
          "memory-core",
          {
            namespace: "qmd",
            key: "embed",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_LEASE_STORAGE_FAILED" });
    });
  });
});
