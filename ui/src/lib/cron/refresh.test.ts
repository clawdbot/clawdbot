// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createInitialCronState, loadCronRuns, loadCronStatus, type CronState } from "./index.ts";

function createRefreshHarness(method: "cron.status" | "cron.runs") {
  const pending: Array<ReturnType<typeof createDeferred<unknown>>> = [];
  const request = vi.fn(() => {
    const response = createDeferred<unknown>();
    pending.push(response);
    return response.promise;
  });
  const state = createInitialCronState({
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
  });
  const loads: Promise<unknown>[] = [];
  const load = (coalesce = true) => {
    const promise =
      method === "cron.status"
        ? loadCronStatus(state, { coalesce })
        : loadCronRuns(state, null, { coalesce });
    loads.push(promise);
    return promise;
  };
  const payload = (revision: number) =>
    method === "cron.status"
      ? { enabled: true, triggersEnabled: true, jobs: revision }
      : {
          entries: [{ ts: revision, jobId: "job", action: "finished", status: "ok" }],
          total: 1,
          hasMore: false,
          nextOffset: null,
        };
  return {
    state,
    request,
    pending,
    response(index: number) {
      const response = pending[index];
      if (!response) {
        throw new Error(`No pending response at index ${index}`);
      }
      return response;
    },
    load,
    payload,
    settle: () => Promise.all(loads),
    revision: () => (method === "cron.status" ? state.cronStatus?.jobs : state.cronRuns[0]?.ts),
    async close() {
      state.connected = false;
      pending.forEach((response) => response.resolve(payload(0)));
      await Promise.all(loads);
    },
  };
}

describe.each(["cron.status", "cron.runs"] as const)("%s event refresh ownership", (method) => {
  it("publishes progress during sustained events while keeping one trailing reread", async () => {
    const harness = createRefreshHarness(method);
    try {
      const initial = harness.load();
      for (let revision = 1; revision <= 3; revision += 1) {
        if (revision < 3) {
          for (let event = 0; event < 20; event += 1) {
            void harness.load();
          }
        }
        expect(harness.request).toHaveBeenCalledTimes(revision);
        harness.response(revision - 1).resolve(harness.payload(revision));
        await vi.waitFor(() => expect(harness.revision()).toBe(revision));
        if (revision < 3) {
          expect(harness.request).toHaveBeenCalledTimes(revision + 1);
        }
      }
      await initial;
      await harness.settle();
      expect(harness.state.cronError).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it.each([true, false])(
    "keeps the latest error outcome when firstFails=%s",
    async (firstFails) => {
      const harness = createRefreshHarness(method);
      try {
        const initial = harness.load();
        void harness.load();
        expect(harness.request).toHaveBeenCalledTimes(1);
        if (firstFails) {
          harness.response(0).reject(new Error("obsolete refresh failed"));
        } else {
          harness.response(0).resolve(harness.payload(1));
        }
        await vi.waitFor(() => expect(harness.pending).toHaveLength(2));
        expect(harness.state.cronError).toBeNull();
        if (firstFails) {
          harness.response(1).resolve(harness.payload(2));
        } else {
          expect(harness.revision()).toBe(1);
          harness.response(1).reject(new Error("latest refresh failed"));
        }
        await initial;
        await harness.settle();
        expect(harness.revision()).toBe(firstFails ? 2 : 1);
        expect(harness.state.cronError).toBe(firstFails ? null : "latest refresh failed");
      } finally {
        await harness.close();
      }
    },
  );

  it("completes an explicit read without waiting for its queued event refresh", async () => {
    const harness = createRefreshHarness(method);
    try {
      const explicit = harness.load(false);
      const queued = harness.load();
      let queuedSettled = false;
      void queued.then(() => {
        queuedSettled = true;
      });
      expect(harness.request).toHaveBeenCalledTimes(1);
      harness.response(0).resolve(harness.payload(1));
      await explicit;
      expect(harness.revision()).toBe(1);
      expect(harness.pending).toHaveLength(2);
      expect(queuedSettled).toBe(false);
      harness.response(1).resolve(harness.payload(2));
      await queued;
      expect(harness.revision()).toBe(2);
    } finally {
      await harness.close();
    }
  });
});

describe("cron event refresh replacement", () => {
  it.each<Partial<CronState>>([
    { cronRunsQuery: "new filter" },
    { cronRunsScope: "job", cronRunsJobId: "selected-job" },
    { cronAgentId: "writer" },
    { cronRunsLimit: 10 },
    { cronRunsStatuses: ["error"] },
    { cronRunsStatusFilter: "error" },
    { cronRunsDeliveryStatuses: ["not-delivered"] },
    { cronRunsSortDir: "asc" },
  ])("supersedes queued reads when the current query changes: %j", async (patch) => {
    const harness = createRefreshHarness("cron.runs");
    try {
      const initial = harness.load();
      const queued = harness.load();
      Object.assign(harness.state, patch);
      const current = harness.load();
      expect(harness.request).toHaveBeenCalledTimes(2);
      harness.response(1).resolve(harness.payload(2));
      await current;
      harness.response(0).reject(new Error("superseded query failed"));
      await expect(initial).resolves.toBe("skipped");
      await expect(queued).resolves.toBe("skipped");
      expect(harness.request).toHaveBeenCalledTimes(2);
      expect(harness.revision()).toBe(2);
      expect(harness.state.cronError).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("supersedes an append when an event refreshes page zero", async () => {
    const harness = createRefreshHarness("cron.runs");
    try {
      harness.state.cronRuns = [{ ts: 1, jobId: "job", action: "finished", status: "ok" }];
      harness.state.cronRunsHasMore = true;
      harness.state.cronRunsNextOffset = 1;
      const append = loadCronRuns(harness.state, null, { append: true });
      const current = harness.load();
      expect(harness.request).toHaveBeenCalledTimes(2);
      expect(harness.state.cronRunsLoadingMore).toBe(false);
      harness.response(1).resolve(harness.payload(2));
      await current;
      harness.response(0).resolve(harness.payload(0));
      await expect(append).resolves.toBe("skipped");
      expect(harness.state.cronRuns.map((entry) => entry.ts)).toEqual([2]);
      expect(harness.state.cronRunsHasMore).toBe(false);
      expect(harness.state.cronRunsNextOffset).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
