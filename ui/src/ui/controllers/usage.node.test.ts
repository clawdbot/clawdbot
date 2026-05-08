// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __test,
  loadSessionLogs,
  loadSessionTimeSeries,
  loadUsage,
  type UsageState,
} from "./usage.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<UsageState> = {}): UsageState {
  return {
    client: { request } as unknown as UsageState["client"],
    connected: true,
    usageLoading: false,
    usageResult: null,
    usageCostSummary: null,
    usageError: null,
    usageStartDate: "2026-02-16",
    usageEndDate: "2026-02-16",
    usageScope: "family",
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageTimeSeries: null,
    usageTimeSeriesLoading: false,
    usageTimeSeriesCursorStart: null,
    usageTimeSeriesCursorEnd: null,
    usageSessionLogs: null,
    usageSessionLogsLoading: false,
    usageTimeZone: "local",
    ...overrides,
  };
}

function expectSpecificTimezoneCalls(request: ReturnType<typeof vi.fn>, startCall: number): void {
  expect(request).toHaveBeenNthCalledWith(startCall, "sessions.usage", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    mode: "specific",
    utcOffset: "UTC+5:30",
    groupBy: "family",
    includeHistorical: true,
    limit: 1000,
    includeContextWeight: true,
  });
  expect(request).toHaveBeenNthCalledWith(startCall + 1, "usage.cost", {
    startDate: "2026-02-16",
    endDate: "2026-02-16",
    mode: "specific",
    utcOffset: "UTC+5:30",
  });
}

describe("usage controller date interpretation params", () => {
  beforeEach(() => {
    __test.resetLegacyUsageDateParamsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats UTC offsets for whole and half-hour timezones", () => {
    expect(__test.formatUtcOffset(240)).toBe("UTC-4");
    expect(__test.formatUtcOffset(-330)).toBe("UTC+5:30");
    expect(__test.formatUtcOffset(0)).toBe("UTC+0");
  });

  it("sends specific mode with browser offset when usage timezone is local", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState(request, { usageTimeZone: "local" });
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);

    await loadUsage(state);

    expectSpecificTimezoneCalls(request, 1);
  });

  it("sends utc mode without offset when usage timezone is utc", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState(request, { usageTimeZone: "utc" });

    await loadUsage(state);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.usage", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      mode: "utc",
      groupBy: "family",
      includeHistorical: true,
      limit: 1000,
      includeContextWeight: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "usage.cost", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      mode: "utc",
    });
  });

  it("captures useful error strings in loadUsage", async () => {
    const request = vi.fn(async () => {
      throw new Error("request failed");
    });
    const state = createState(request);

    await loadUsage(state);

    expect(state.usageError).toBe("request failed");
  });

  it("serializes non-Error objects without object-to-string coercion", () => {
    expect(__test.toErrorMessage({ reason: "nope" })).toBe('{"reason":"nope"}');
  });

  it("falls back and remembers compatibility when sessions.usage rejects mode/utcOffset", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);

    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.usage") {
        const record = (params ?? {}) as Record<string, unknown>;
        if ("mode" in record || "utcOffset" in record) {
          throw new Error(
            "invalid sessions.usage params: at root: unexpected property 'mode'; at root: unexpected property 'utcOffset'",
          );
        }
        return { sessions: [] };
      }
      return {};
    });

    const state = createState(request, {
      usageTimeZone: "local",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });

    await loadUsage(state);

    expectSpecificTimezoneCalls(request, 1);
    expect(request).toHaveBeenNthCalledWith(3, "sessions.usage", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      groupBy: "family",
      includeHistorical: true,
      limit: 1000,
      includeContextWeight: true,
    });
    expect(request).toHaveBeenNthCalledWith(4, "usage.cost", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
    });

    // Subsequent loads for the same gateway should skip mode/utcOffset immediately.
    await loadUsage(state);

    expect(request).toHaveBeenNthCalledWith(5, "sessions.usage", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      groupBy: "family",
      includeHistorical: true,
      limit: 1000,
      includeContextWeight: true,
    });
    expect(request).toHaveBeenNthCalledWith(6, "usage.cost", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
    });

    // Persisted flag should survive cache resets (simulating app reload).
    __test.resetLegacyUsageDateParamsCache();
    expect(__test.shouldSendLegacyDateInterpretation(state)).toBe(false);

    vi.unstubAllGlobals();
  });

  it("falls back and remembers compatibility when sessions.usage rejects lineage params", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage as unknown as Storage);
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);

    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.usage") {
        const record = (params ?? {}) as Record<string, unknown>;
        if ("groupBy" in record || "includeHistorical" in record) {
          throw new Error(
            "invalid sessions.usage params: at root: unexpected property 'groupBy'; at root: unexpected property 'includeHistorical'",
          );
        }
        return { sessions: [] };
      }
      return {};
    });

    const state = createState(request, {
      usageTimeZone: "local",
      settings: { gatewayUrl: "ws://127.0.0.1:18789" },
    });

    await loadUsage(state);

    expectSpecificTimezoneCalls(request, 1);
    expect(request).toHaveBeenNthCalledWith(3, "sessions.usage", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      mode: "specific",
      utcOffset: "UTC+5:30",
      limit: 1000,
      includeContextWeight: true,
    });
    expect(request).toHaveBeenNthCalledWith(4, "usage.cost", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      mode: "specific",
      utcOffset: "UTC+5:30",
    });

    // Subsequent loads for the same gateway should still send date params but skip lineage params.
    await loadUsage(state);

    expect(request).toHaveBeenNthCalledWith(5, "sessions.usage", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      mode: "specific",
      utcOffset: "UTC+5:30",
      limit: 1000,
      includeContextWeight: true,
    });
    expect(request).toHaveBeenNthCalledWith(6, "usage.cost", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      mode: "specific",
      utcOffset: "UTC+5:30",
    });

    vi.unstubAllGlobals();
  });

  it("keeps optional loaders resilient when requests fail", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage.timeseries" || method === "sessions.usage.logs") {
        throw new Error("optional endpoint unavailable");
      }
      return {};
    });
    const state = createState(request);

    await loadSessionTimeSeries(state, "session-1");
    await loadSessionLogs(state, "session-1");

    expect(state.usageTimeSeries).toBeNull();
    expect(state.usageSessionLogs).toBeNull();
    expect(state.usageTimeSeriesLoading).toBe(false);
    expect(state.usageSessionLogsLoading).toBe(false);
  });

  it("normalizes usage logs payloads when logs is not an array", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage.logs") {
        return { logs: "unexpected-shape" };
      }
      return {};
    });
    const state = createState(request);

    await loadSessionLogs(state, "session-1");

    expect(state.usageSessionLogs).toBeNull();
    expect(state.usageSessionLogsLoading).toBe(false);
  });
});

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}
