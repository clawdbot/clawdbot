import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
} from "./session-cost-usage.js";

vi.mock("./session-cost-usage-aggregation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cost-usage-aggregation.js")>()),
  refreshCostUsageCacheForAgent: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session cost usage refresh", () => {
  it("doubles consecutive busy delays, caps them, and resets after success", async () => {
    const root = tempDirs.make("openclaw-session-cost-backoff-");
    const sessionFile = path.join(root, "agents", "backoff-test", "sessions", "next-session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ message: { role: "user", content: "hello" } }),
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const params = { agentId: "backoff-test", startMs: 0, endMs: Date.now() };
      const refresh = vi.mocked(refreshCostUsageCacheForAgent);
      let queuedSubset: ReturnType<typeof loadSessionCostSummariesFromCache> | undefined;
      let calls = 0;
      refresh.mockImplementation(async () => {
        calls += 1;
        if (calls <= 10) {
          return "busy";
        }
        if (calls === 11) {
          queuedSubset = loadSessionCostSummariesFromCache({
            agentId: params.agentId,
            sessions: [{ sessionFile }],
          });
          await queuedSubset;
          return "refreshed";
        }
        if (calls === 12) {
          return "busy";
        }
        return "refreshed";
      });

      vi.useFakeTimers();
      try {
        expect(await loadCostUsageSummaryFromCache(params)).toMatchObject({
          cacheStatus: { status: "refreshing", pendingFiles: 1 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledTimes(1);

        for (const [delayMs, expectedCalls] of [
          [50, 2],
          [100, 3],
          [200, 4],
          [400, 5],
          [800, 6],
          [1_600, 7],
          [3_200, 8],
          [5_000, 9],
          [5_000, 10],
        ] as const) {
          await vi.advanceTimersByTimeAsync(delayMs - 1);
          expect(refresh).toHaveBeenCalledTimes(expectedCalls - 1);
          await vi.advanceTimersByTimeAsync(1);
          expect(refresh).toHaveBeenCalledTimes(expectedCalls);
        }

        await vi.advanceTimersByTimeAsync(4_999);
        expect(refresh).toHaveBeenCalledTimes(10);
        await vi.advanceTimersByTimeAsync(1);
        // Join the subset's real filesystem lookup before advancing the retry clock.
        await queuedSubset;
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledTimes(12);
        expect(refresh.mock.calls[10]?.[0].sessionFiles).toBeUndefined();
        expect(refresh.mock.calls[11]?.[0].sessionFiles).toEqual([sessionFile]);

        await vi.advanceTimersByTimeAsync(49);
        expect(refresh).toHaveBeenCalledTimes(12);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(13);
        expect(vi.getTimerCount()).toBe(0);
        expect(
          await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false }),
        ).toMatchObject({
          cacheStatus: { status: "stale" },
        });
      } finally {
        try {
          // Complete queued work even if an assertion failed before the final retry.
          refresh.mockResolvedValue("refreshed");
          await queuedSubset;
          await vi.runOnlyPendingTimersAsync();
          expect(
            await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false }),
          ).toMatchObject({
            cacheStatus: { status: "stale" },
          });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          refresh.mockReset();
          vi.useRealTimers();
        }
      }
    });
  });

  async function withRefreshFixture(
    run: (params: { agentId: string; sessionFiles: [string, string] }) => Promise<void>,
  ): Promise<void> {
    const root = tempDirs.make("openclaw-session-cost-lifetime-");
    const agentId = "refresh-test";
    const sessionsDir = path.join(root, "agents", agentId, "sessions");
    const sessionFiles: [string, string] = [
      path.join(sessionsDir, "first.jsonl"),
      path.join(sessionsDir, "second.jsonl"),
    ];
    await fs.mkdir(sessionsDir, { recursive: true });
    await Promise.all(
      sessionFiles.map((sessionFile) =>
        fs.writeFile(sessionFile, JSON.stringify({ message: { role: "user", content: "hello" } })),
      ),
    );
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      vi.useFakeTimers();
      try {
        await run({ agentId, sessionFiles });
      } finally {
        vi.mocked(refreshCostUsageCacheForAgent).mockReset();
        vi.useRealTimers();
      }
    });
  }

  it.each(["refreshed", "busy"] as const)(
    "keeps scope drain pending until its running refresh returns %s without leaving a retry",
    async (result) => {
      await withRefreshFixture(async ({ agentId, sessionFiles }) => {
        const scope = new AsyncWorkScope();
        const release = createDeferredCore();
        const events: string[] = [];
        const work = release.promise.then(() => {
          events.push("refresh settled");
          return result;
        });
        const refresh = vi.mocked(refreshCostUsageCacheForAgent).mockReturnValueOnce(work);
        refresh.mockResolvedValue("refreshed");
        try {
          await scope.track(() =>
            loadSessionCostSummariesFromCache({
              agentId,
              sessions: [{ sessionFile: sessionFiles[0] }],
            }),
          );
          expect(refresh).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(0);
          expect(refresh).toHaveBeenCalledOnce();
          const draining = scope.drain().then(() => events.push("scope drained"));
          await vi.advanceTimersByTimeAsync(0);
          expect(events).toEqual([]);
          release.resolve();
          await draining;
          await vi.advanceTimersByTimeAsync(50);
          expect(events).toEqual(["refresh settled", "scope drained"]);
          expect(refresh).toHaveBeenCalledOnce();
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          release.resolve();
          scope.beginClose();
          await work;
          await vi.advanceTimersByTimeAsync(50);
          await scope.drain();
        }
      });
    },
  );

  it.each(["initial timer", "busy retry"] as const)(
    "cancels a queued %s when its scope closes",
    async (phase) => {
      await withRefreshFixture(async ({ agentId, sessionFiles }) => {
        const scope = new AsyncWorkScope();
        const refresh = vi.mocked(refreshCostUsageCacheForAgent).mockResolvedValue("refreshed");
        if (phase === "busy retry") {
          refresh.mockResolvedValueOnce("busy");
        }
        try {
          await scope.track(() =>
            loadSessionCostSummariesFromCache({
              agentId,
              sessions: [{ sessionFile: sessionFiles[0] }],
            }),
          );
          if (phase === "busy retry") {
            await vi.advanceTimersByTimeAsync(0);
            expect(refresh).toHaveBeenCalledOnce();
          }
          const callsBeforeClose = refresh.mock.calls.length;
          await scope.drain();
          await vi.advanceTimersByTimeAsync(50);
          expect(refresh).toHaveBeenCalledTimes(callsBeforeClose);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          scope.beginClose();
          await vi.advanceTimersByTimeAsync(50);
          await scope.drain();
        }
      });
    },
  );

  it("keeps same-agent refreshes owned by independent scopes", async () => {
    await withRefreshFixture(async ({ agentId, sessionFiles }) => {
      const first = new AsyncWorkScope();
      const second = new AsyncWorkScope();
      const releaseFirst = createDeferredCore();
      const releaseSecond = createDeferredCore();
      const completed: string[] = [];
      const firstWork = releaseFirst.promise.then(() => {
        completed.push("first");
        return "refreshed" as const;
      });
      const secondWork = releaseSecond.promise.then(() => {
        completed.push("second");
        return "refreshed" as const;
      });
      const refresh = vi
        .mocked(refreshCostUsageCacheForAgent)
        .mockImplementation((params) =>
          params.sessionFiles?.includes(sessionFiles[0]) ? firstWork : secondWork,
        );
      try {
        for (const { scope, sessionFile } of [
          { scope: first, sessionFile: sessionFiles[0] },
          { scope: second, sessionFile: sessionFiles[1] },
        ]) {
          await scope.track(() =>
            loadSessionCostSummariesFromCache({ agentId, sessions: [{ sessionFile }] }),
          );
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh.mock.calls.map(([params]) => params.sessionFiles)).toEqual(
          sessionFiles.map((sessionFile) => [sessionFile]),
        );
        let firstDrained = false;
        const drainingFirst = first.drain().then(() => {
          firstDrained = true;
        });
        releaseFirst.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(firstDrained).toBe(true);
        await drainingFirst;
        expect(completed).toEqual(["first"]);
        expect(second.signal.aborted).toBe(false);
        second.beginClose();
        releaseSecond.resolve();
        await second.drain();
        expect(completed).toEqual(["first", "second"]);
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        first.beginClose();
        second.beginClose();
        await Promise.all([firstWork, secondWork]);
        await vi.advanceTimersByTimeAsync(0);
        await Promise.all([first.drain(), second.drain()]);
      }
    });
  });
});
