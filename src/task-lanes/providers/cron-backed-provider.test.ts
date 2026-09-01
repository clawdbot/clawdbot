// Cron-backed task-lane provider: run-log projection and clamps.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import { readCronTaskRunHistoryPage } from "../../cron/task-run-history.js";
import { TASK_LANE_MAX_ITEMS_PER_LANE } from "../types.js";
import { createCronBackedProvider } from "./cron-backed-provider.js";

vi.mock("../../cron/task-run-history.js", () => ({
  readCronTaskRunHistoryPage: vi.fn(),
}));

const readMock = vi.mocked(readCronTaskRunHistoryPage);

function entry(overrides: Partial<CronRunLogEntry>): CronRunLogEntry {
  return {
    ts: 1_700_000_000_000,
    jobId: "job-1",
    action: "finished",
    status: "ok",
    runId: "run-1",
    ...overrides,
  } as CronRunLogEntry;
}

describe("cron-backed task-lane provider", () => {
  beforeEach(() => {
    readMock.mockReset();
  });

  it("projects run log entries into one lane with mapped states", async () => {
    readMock.mockReturnValue({
      entries: [
        entry({ runId: "r1", status: "ok", runAtMs: 1_700_000_001_000 }),
        entry({ runId: "r2", status: "error", runAtMs: 1_700_000_002_000 }),
        entry({ runId: "r3", status: "skipped", runAtMs: 1_700_000_003_000 }),
        entry({ runId: "r4", status: undefined, runAtMs: 1_700_000_004_000 }),
      ],
      total: 4,
      offset: 0,
      limit: 20,
      hasMore: false,
      nextOffset: null,
    });
    const provider = createCronBackedProvider("cron", { storeKey: "/store.sqlite" });
    const { lanes } = await provider.load();
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.id).toBe("cron");
    expect(lanes[0]?.items.map((item) => item.state)).toEqual([
      "succeeded",
      "failed",
      "canceled",
      "unknown",
    ]);
  });

  it("threads storeKey and optional filters to the read API", async () => {
    readMock.mockReturnValue({
      entries: [],
      total: 0,
      offset: 0,
      limit: 20,
      hasMore: false,
      nextOffset: null,
    });
    const provider = createCronBackedProvider("cron", {
      storeKey: "/store.sqlite",
      agentId: "ops",
      jobNameById: { "job-1": "Nightly digest" },
    });
    await provider.load();
    expect(readMock).toHaveBeenCalledWith({
      storeKey: "/store.sqlite",
      limit: 20,
      offset: 0,
      agentId: "ops",
      jobNameById: { "job-1": "Nightly digest" },
    });
  });

  it("falls back to jobId:ts ids and jobNameById titles", async () => {
    readMock.mockReturnValue({
      entries: [
        entry({ runId: undefined, ts: 1_700_000_000_123 }),
        entry({ runId: "r9", jobId: "job-2", ts: 1_700_000_000_456 }),
      ],
      total: 2,
      offset: 0,
      limit: 20,
      hasMore: false,
      nextOffset: null,
    });
    const provider = createCronBackedProvider("cron", {
      storeKey: "/store.sqlite",
      jobNameById: { "job-2": "Backup sweep" },
    });
    const { lanes } = await provider.load();
    expect(lanes[0]?.items[0]?.id).toBe("job-1:1700000000123");
    expect(lanes[0]?.items[1]?.id).toBe("r9");
    expect(lanes[0]?.items[0]?.title).toBe("job-1");
    expect(lanes[0]?.items[1]?.title).toBe("Backup sweep");
  });

  it("clamps the requested limit to the lane item cap", async () => {
    readMock.mockReturnValue({
      entries: [],
      total: 0,
      offset: 0,
      limit: TASK_LANE_MAX_ITEMS_PER_LANE,
      hasMore: false,
      nextOffset: null,
    });
    const provider = createCronBackedProvider("cron", {
      storeKey: "/store.sqlite",
      limit: 5_000,
    });
    await provider.load();
    expect(readMock.mock.calls[0]?.[0]).toMatchObject({
      limit: TASK_LANE_MAX_ITEMS_PER_LANE,
    });
  });

  it("returns an empty lane when run history is empty", async () => {
    readMock.mockReturnValue({
      entries: [],
      total: 0,
      offset: 0,
      limit: 20,
      hasMore: false,
      nextOffset: null,
    });
    const provider = createCronBackedProvider("cron", { storeKey: "/store.sqlite" });
    const { lanes } = await provider.load();
    expect(lanes).toEqual([{ id: "cron", label: "Cron runs", items: [] }]);
  });

  it("surfaces the completion cause as the item outcome", async () => {
    readMock.mockReturnValue({
      entries: [entry({ runId: "r1", completionCause: "gateway-restart" })],
      total: 1,
      offset: 0,
      limit: 20,
      hasMore: false,
      nextOffset: null,
    });
    const provider = createCronBackedProvider("cron", { storeKey: "/store.sqlite" });
    const { lanes } = await provider.load();
    expect(lanes[0]?.items[0]?.outcome).toBe("gateway-restart");
  });
});
