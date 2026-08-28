/* @vitest-environment jsdom */

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CostUsageSummary,
  SessionsUsageResult,
  SessionUsageTimeSeries,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { page as usageRoute } from "./route.ts";
import type { SessionLogEntry } from "./types.ts";
import type { UsageRouteData } from "./usage-page.ts";
import "./usage-page.ts";

type TestUsagePage = HTMLElement & {
  context: ApplicationContext;
  routeData: UsageRouteData;
  usageError: string | null;
  usageSelectedSessions: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesStatus: { error: string | null; hasLoaded: boolean; stale: boolean };
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsStatus: { error: string | null; hasLoaded: boolean; stale: boolean };
  providerUsageStalled: boolean;
  providerUsageSummary: { updatedAt: number; providers: unknown[] } | null;
  providerUsageUnavailable: boolean;
  loadUsage: () => Promise<void>;
  loadSessionTimeSeries: (sessionKey: string) => Promise<void>;
  loadSessionLogs: (sessionKey: string) => Promise<void>;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function contextWithClient(client: GatewayBrowserClient): ApplicationContext {
  const subscribe = () => () => undefined;
  const snapshot = {
    client,
    phase: "connected",
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
  return {
    basePath: "",
    gateway: {
      snapshot,
      subscribe,
    },
    agents: {
      state: { agentsList: null, agentsLoading: false, agentsError: null },
      ensureList: vi.fn(async () => null),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: null, scopeId: null },
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

async function createPage(
  client: GatewayBrowserClient,
  renderView = false,
  context = contextWithClient(client),
): Promise<TestUsagePage> {
  const page = document.createElement("openclaw-usage-page") as TestUsagePage;
  page.context = context;
  if (!renderView) {
    page.render = () => nothing;
  }
  document.body.append(page);
  await page.updateComplete;
  page.usageSelectedSessions = ["agent:main:detail"];
  return page;
}

function focusDocument(): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function cacheSnapshot(
  source: "sessions" | "cost",
  status: "fresh" | "partial" | "stale" | "refreshing",
) {
  const cacheStatus = {
    status,
    cachedFiles: 1,
    pendingFiles: status === "fresh" ? 0 : 1,
    staleFiles: status === "stale" ? 1 : 0,
  };
  const totals = {
    input: 100,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100,
    totalCost: 1,
    inputCost: 1,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
  return {
    result: {
      updatedAt: Date.now(),
      startDate: "2026-08-07",
      endDate: "2026-08-07",
      sessions: [],
      totals,
      aggregates: {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
      cacheStatus: source === "sessions" ? cacheStatus : undefined,
    } satisfies SessionsUsageResult,
    costSummary: {
      updatedAt: Date.now(),
      days: 1,
      daily: [],
      totals,
      cacheStatus: source === "cost" ? cacheStatus : undefined,
    } satisfies CostUsageSummary,
  };
}

async function preloadUsage(page: TestUsagePage): Promise<void> {
  const options = {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: { pathname: "/usage", search: "", hash: "" },
    deps: "",
    cause: "navigation",
  } satisfies RouteLoaderOptions;
  page.routeData = (await usageRoute.loader!(page.context, options)) as UsageRouteData;
  await page.updateComplete;
}

function refreshButton(page: TestUsagePage): HTMLButtonElement {
  const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === "Refresh",
  );
  expect(button).toBeDefined();
  return button!;
}

describe("UsagePage cache convergence", () => {
  it("gives a debounced date change its own retries when an old poll becomes due", async () => {
    vi.useFakeTimers();
    focusDocument();
    let snapshot = cacheSnapshot("sessions", "partial");
    const request = vi.fn(async (method: string, _params?: unknown) =>
      method === "usage.status"
        ? { updatedAt: 1, providers: [] }
        : method === "usage.cost"
          ? snapshot.costSummary
          : snapshot.result,
    );
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(3);

    const input = page.querySelector<HTMLInputElement>("input.usage-date-input")!;
    input.value = "2026-08-01";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    const requests = request.mock.calls.filter(([method]) => method === "sessions.usage");
    expect(requests).toHaveLength(4);
    expect(requests[3]?.[1]).toMatchObject({ startDate: "2026-08-01" });

    snapshot = cacheSnapshot("sessions", "fresh");
    await vi.advanceTimersByTimeAsync(5_000);
    await page.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(5);
    expect(page.querySelector(".usage-cache-warning")).toBeNull();
    expect(page.providerUsageStalled).toBe(false);
  });

  it.each(["scope", "time zone", "date"] as const)(
    "starts a new bounded cache cycle after changing the %s of an exhausted query",
    async (control) => {
      vi.useFakeTimers();
      focusDocument();
      let snapshot = cacheSnapshot("sessions", "partial");
      const request = vi.fn(async (method: string) =>
        method === "usage.status"
          ? { updatedAt: 1, providers: [] }
          : method === "usage.cost"
            ? snapshot.costSummary
            : snapshot.result,
      );
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      await vi.advanceTimersByTimeAsync(20_000);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(4);
      expect(page.querySelector(".usage-cache-warning")?.textContent).toContain(
        "Automatic checks paused",
      );

      if (control === "scope") {
        const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
          (entry) => entry.textContent?.trim() === "Current instance",
        );
        expect(button).toBeDefined();
        button!.click();
      } else if (control === "time zone") {
        const select = page.querySelector<HTMLSelectElement>("select.usage-select")!;
        select.value = "utc";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const input = page.querySelector<HTMLInputElement>("input.usage-date-input")!;
        input.value = "2026-08-01";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await vi.advanceTimersByTimeAsync(400);
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(5);
      snapshot = cacheSnapshot("sessions", "fresh");
      await vi.advanceTimersByTimeAsync(5_000);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(6);
      expect(page.querySelector(".usage-cache-warning")).toBeNull();
      expect(page.providerUsageStalled).toBe(false);
    },
  );

  it("recovers incomplete caches after a reconnect load fails before provider usage settles", async () => {
    vi.useFakeTimers();
    focusDocument();
    let phase: "partial" | "failed" | "fresh" = "partial";
    const pendingProvider = deferred<{ updatedAt: number; providers: never[] }>();
    const failedCost = deferred<CostUsageSummary>();
    const request = vi.fn(async (method: string) => {
      if (method === "usage.status") {
        return phase === "failed" ? pendingProvider.promise : { updatedAt: 1, providers: [] };
      }
      if (phase === "failed" && method === "usage.cost") {
        return failedCost.promise;
      }
      const snapshot = cacheSnapshot("sessions", phase === "fresh" ? "fresh" : "partial");
      return method === "usage.cost" ? snapshot.costSummary : snapshot.result;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const base = contextWithClient(client);
    let snapshot = base.gateway.snapshot;
    let listener: ((value: ApplicationGatewaySnapshot) => void) | undefined;
    const context = {
      ...base,
      gateway: {
        ...base.gateway,
        get snapshot() {
          return snapshot;
        },
        subscribe(next: (value: ApplicationGatewaySnapshot) => void) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    };
    const page = await createPage(client, true, context);
    await preloadUsage(page);
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(1);
    phase = "failed";
    snapshot = { ...snapshot, phase: "offline" };
    listener!(snapshot);
    await page.updateComplete;
    snapshot = { ...snapshot, phase: "connected" };
    listener!(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2);
    failedCost.reject(new Error("cost unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.usageError).toBe("cost unavailable");
    phase = "fresh";
    await vi.advanceTimersByTimeAsync(5_000);
    await page.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(3);
    expect(page.usageError).toBeNull();
    expect(page.querySelector(".usage-cache-warning")).toBeNull();
    expect(page.providerUsageStalled).toBe(false);
    pendingProvider.resolve({ updatedAt: 0, providers: [] });
  });

  it.each([
    ["sessions", "refreshing"],
    ["sessions", "partial"],
    ["sessions", "stale"],
    ["cost", "refreshing"],
    ["cost", "partial"],
    ["cost", "stale"],
  ] as const)(
    "bounds %s %s retries without reporting a provider failure",
    async (source, status) => {
      vi.useFakeTimers();
      focusDocument();
      let snapshot = cacheSnapshot(source, status);
      const provider = { updatedAt: 1, providers: [] };
      const request = vi.fn(async (method: string) =>
        method === "usage.status"
          ? provider
          : method === "usage.cost"
            ? snapshot.costSummary
            : snapshot.result,
      );
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      expect(page.querySelector(".usage-cache-warning")?.textContent).toContain(
        "Checking for updated totals",
      );
      expect(page.querySelector(".usage-loading-spinner")).toBeNull();

      await vi.advanceTimersByTimeAsync(20_000);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(4);
      expect(page.querySelector(".usage-cache-warning")?.textContent).toContain(
        "Automatic checks paused; select Refresh",
      );
      expect(page.providerUsageStalled).toBe(false);
      expect(page.providerUsageUnavailable).toBe(false);
      expect(page.providerUsageSummary).toEqual(provider);
      expect(page.textContent).not.toContain("Provider usage did not finish loading");
      expect(refreshButton(page).disabled).toBe(false);

      refreshButton(page).click();
      await vi.advanceTimersByTimeAsync(0);
      snapshot = cacheSnapshot(source, "fresh");
      await vi.advanceTimersByTimeAsync(5_000);
      await page.updateComplete;
      expect(page.querySelector(".usage-cache-warning")).toBeNull();
      expect(page.querySelector(".usage-loading-spinner")).toBeNull();
      const completedCalls = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      window.dispatchEvent(new Event("focus"));
      expect(request).toHaveBeenCalledTimes(completedCalls);

      snapshot = cacheSnapshot(source, status);
      refreshButton(page).click();
      await vi.advanceTimersByTimeAsync(0);
      const callsBeforeRemoval = request.mock.calls.length;
      page.remove();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(request).toHaveBeenCalledTimes(callsBeforeRemoval);
    },
  );

  it.each(["pending", "settled"] as const)(
    "keeps cache convergence after an aggregate failure with %s provider usage",
    async (providerState) => {
      vi.useFakeTimers();
      focusDocument();
      let phase: "partial" | "failed" | "fresh" = "partial";
      const pendingProvider = deferred<{ updatedAt: number; providers: never[] }>();
      const failedCost = deferred<CostUsageSummary>();
      const request = vi.fn(async (method: string) => {
        if (method === "usage.status") {
          return phase === "failed" && providerState === "pending"
            ? pendingProvider.promise
            : { updatedAt: 1, providers: [] };
        }
        if (phase === "failed" && method === "usage.cost") {
          return failedCost.promise;
        }
        const snapshot = cacheSnapshot("sessions", phase === "fresh" ? "fresh" : "partial");
        return method === "usage.cost" ? snapshot.costSummary : snapshot.result;
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      phase = "failed";
      await vi.advanceTimersByTimeAsync(5_000);
      failedCost.reject(new Error("cost unavailable"));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.usageError).toBe("cost unavailable");
      phase = "fresh";
      await vi.advanceTimersByTimeAsync(5_000);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(3);
      expect(page.usageError).toBeNull();
      expect(page.querySelector(".usage-cache-warning")).toBeNull();
      expect(page.providerUsageStalled).toBe(false);
      pendingProvider.resolve({ updatedAt: 0, providers: [] });
    },
  );
});

describe("UsagePage provider usage outcome", () => {
  it.each(["direct", "preload"] as const)(
    "retries a failed %s provider usage result on the next page activation",
    async (loadSource) => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let providerUnavailable = loadSource === "direct";
      const request = vi.fn(async (method: string): Promise<unknown> => {
        if (method === "usage.status") {
          if (providerUnavailable) {
            throw new Error("provider usage unreachable");
          }
          return { updatedAt: 2, providers: [] };
        }
        return method === "usage.cost" ? { daily: [] } : { sessions: [], totals: null };
      });
      const page = document.createElement("openclaw-usage-page") as TestUsagePage;
      page.context = contextWithClient({ request } as unknown as GatewayBrowserClient);
      page.render = () => nothing;
      document.body.append(page);
      await page.updateComplete;
      page.routeData = {
        gateway: page.context.gateway,
        gatewaySnapshot: page.context.gateway.snapshot,
        query: {
          startDate: "2026-08-07",
          endDate: "2026-08-07",
          scope: "family",
          timeZone: "local",
          agentId: null,
        },
        result: null,
        costSummary: null,
        providerUsage:
          loadSource === "preload"
            ? {
                state: "settled",
                result: { ok: false, error: { kind: "request-failed" } },
              }
            : { state: "pending" },
        loadedAtMs: loadSource === "preload" ? Date.now() : null,
        error: null,
      };
      await page.updateComplete;
      if (loadSource === "direct") {
        (
          page as unknown as { refreshPolicy: { request: (reason: "manual") => void } }
        ).refreshPolicy.request("manual");
        await vi.waitFor(() => expect(page.providerUsageUnavailable).toBe(true));
      }
      const previousCalls = request.mock.calls.filter(
        ([method]) => method === "usage.status",
      ).length;
      providerUnavailable = false;

      window.dispatchEvent(new Event("focus"));

      await vi.waitFor(() => {
        expect(request.mock.calls.filter(([method]) => method === "usage.status")).toHaveLength(
          previousCalls + 1,
        );
      });
      await vi.waitFor(() =>
        expect(page.providerUsageSummary).toEqual({ updatedAt: 2, providers: [] }),
      );
    },
  );

  it("keeps the last successful provider usage data when a later aggregate load fails", async () => {
    let phase = 1;
    const summary = { updatedAt: 1, providers: [{ provider: "openai", windows: [] }] };
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "usage.status") {
        return summary;
      }
      if (method === "usage.cost") {
        if (phase === 2) {
          throw new Error("cost unavailable");
        }
        return { daily: [] };
      }
      return { sessions: [], totals: null };
    });
    const page = document.createElement("openclaw-usage-page") as TestUsagePage;
    page.context = contextWithClient({ request } as unknown as GatewayBrowserClient);
    page.render = () => nothing;
    document.body.append(page);
    await page.updateComplete;
    page.routeData = {
      gateway: page.context.gateway,
      gatewaySnapshot: page.context.gateway.snapshot,
      query: {
        startDate: "2026-08-07",
        endDate: "2026-08-07",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result: null,
      costSummary: null,
      providerUsage: { state: "pending" },
      loadedAtMs: null,
      error: null,
    };
    await page.updateComplete;

    const refresh = () => {
      (
        page as unknown as { refreshPolicy: { request: (reason: "manual") => void } }
      ).refreshPolicy.request("manual");
    };
    refresh();
    await vi.waitFor(() => {
      expect(page.providerUsageSummary).toEqual(summary);
    });

    phase = 2;
    refresh();
    await vi.waitFor(() => {
      expect(page.usageError).not.toBeNull();
    });
    expect(page.providerUsageSummary).toEqual(summary);
  });

  it("clears a stale provider request failure when a later aggregate load fails", async () => {
    let phase = 1;
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "usage.status") {
        if (phase === 1) {
          throw new Error("provider usage unreachable");
        }
        return { updatedAt: 2, providers: [] };
      }
      if (method === "usage.cost") {
        if (phase === 2) {
          throw new Error("cost unavailable");
        }
        return { daily: [] };
      }
      return { sessions: [], totals: null };
    });
    const page = document.createElement("openclaw-usage-page") as TestUsagePage;
    page.context = contextWithClient({ request } as unknown as GatewayBrowserClient);
    page.render = () => nothing;
    document.body.append(page);
    await page.updateComplete;
    page.routeData = {
      gateway: page.context.gateway,
      gatewaySnapshot: page.context.gateway.snapshot,
      query: {
        startDate: "2026-08-07",
        endDate: "2026-08-07",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result: null,
      costSummary: null,
      providerUsage: { state: "pending" },
      loadedAtMs: null,
      error: null,
    };
    await page.updateComplete;

    // First load: only usage.status fails; the notice flag records the failure.
    const refresh = () => {
      (
        page as unknown as { refreshPolicy: { request: (reason: "manual") => void } }
      ).refreshPolicy.request("manual");
    };
    refresh();
    await vi.waitFor(() => {
      expect(page.providerUsageUnavailable).toBe(true);
    });

    // Second load: usage.status succeeds but the aggregate fails on usage.cost.
    // The stale flag must not keep claiming the last provider request failed.
    phase = 2;
    refresh();
    await vi.waitFor(() => {
      expect(page.usageError).not.toBeNull();
    });
    expect(page.providerUsageUnavailable).toBe(false);
  });
});

describe("UsagePage detail requests", () => {
  it("marks provider usage stalled once the retry budget is spent", async () => {
    vi.useFakeTimers();
    focusDocument();
    let providerUsageRefreshing = true;
    const client = {
      request: vi.fn(async (method: string) =>
        method === "usage.status"
          ? providerUsageRefreshing
            ? { updatedAt: 1, providers: [], refreshing: true }
            : { updatedAt: 2, providers: [] }
          : method === "usage.cost"
            ? { daily: [] }
            : { sessions: [], totals: null },
      ),
    } as unknown as GatewayBrowserClient;
    const page = await createPage(client);
    const gateway = page.context.gateway;
    page.routeData = {
      gateway,
      gatewaySnapshot: gateway.snapshot,
      query: {
        startDate: "2026-05-14",
        endDate: "2026-05-14",
        scope: "family" as const,
        timeZone: "local" as const,
        agentId: null,
      },
      result: null,
      costSummary: null,
      providerUsage: {
        state: "settled" as const,
        result: {
          ok: true as const,
          value: { updatedAt: 1, providers: [], refreshing: true },
        },
      },
      loadedAtMs: 0,
      error: null,
    };
    await page.updateComplete;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(page.providerUsageStalled).toBe(true);

    providerUsageRefreshing = false;
    await page.loadUsage();
    expect(page.providerUsageStalled).toBe(false);
  });

  it("keeps rejected provider usage retries unresolved until the page reports a stall", async () => {
    vi.useFakeTimers();
    focusDocument();
    let rejectProviderUsage = true;
    const request = vi.fn(async (method: string) => {
      if (method === "usage.status") {
        if (rejectProviderUsage) {
          throw new Error("provider usage unavailable");
        }
        return { updatedAt: 2, providers: [] };
      }
      return {};
    });
    const page = await createPage({ request } as unknown as GatewayBrowserClient);
    const gateway = page.context.gateway;
    page.routeData = {
      gateway,
      gatewaySnapshot: gateway.snapshot,
      query: {
        startDate: "2026-05-14",
        endDate: "2026-05-14",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result: null,
      costSummary: null,
      providerUsage: {
        state: "settled",
        result: {
          ok: true,
          value: { updatedAt: 1, providers: [], refreshing: true },
        },
      },
      loadedAtMs: 1,
      error: null,
    } satisfies UsageRouteData;
    await page.updateComplete;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(request.mock.calls.filter(([method]) => method === "usage.status")).toHaveLength(3);
    expect(page.providerUsageStalled).toBe(true);

    rejectProviderUsage = false;
    await page.loadUsage();
    expect(page.providerUsageStalled).toBe(false);
  });

  it("commits only the latest time-series selection", async () => {
    const first = deferred<SessionUsageTimeSeries>();
    const second = deferred<SessionUsageTimeSeries>();
    const request = vi.fn((_method: string, params: { key: string }) =>
      params.key === "agent:main:a" ? first.promise : second.promise,
    );
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    page.usageSelectedSessions = ["agent:main:a"];
    const firstLoad = page.loadSessionTimeSeries("agent:main:a");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.usageSelectedSessions = ["agent:main:b"];
    const secondLoad = page.loadSessionTimeSeries("agent:main:b");
    const latest = { points: [{ timestamp: 2 }] } as SessionUsageTimeSeries;
    second.resolve(latest);
    await secondLoad;
    first.resolve({ points: [{ timestamp: 1 }] } as SessionUsageTimeSeries);
    await firstLoad;

    expect(page.usageTimeSeries).toBe(latest);
  });

  it("retains stale time-series data until a retry succeeds", async () => {
    const retry = deferred<SessionUsageTimeSeries>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
      .mockRejectedValueOnce(new Error("timeline unavailable"))
      .mockReturnValueOnce(retry.promise);
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    await page.loadSessionTimeSeries("agent:main:detail");
    const previous = page.usageTimeSeries;

    await page.loadSessionTimeSeries("agent:main:detail");
    expect(page.usageTimeSeriesStatus).toEqual({
      error: "timeline unavailable",
      hasLoaded: true,
      stale: true,
    });
    expect(page.usageTimeSeries).toBe(previous);

    const retryLoad = page.loadSessionTimeSeries("agent:main:detail");
    expect(page.usageTimeSeriesStatus).toEqual({ error: null, hasLoaded: true, stale: true });
    const result = { points: [] } as unknown as SessionUsageTimeSeries;
    retry.resolve(result);
    await retryLoad;

    expect(page.usageTimeSeries).toBe(result);
    expect(page.usageTimeSeriesStatus).toEqual({ error: null, hasLoaded: true, stale: false });
  });

  it("surfaces a session-log failure and clears it after a successful retry", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("logs unavailable"))
      .mockResolvedValueOnce({
        logs: [{ timestamp: 1, role: "user", content: "hello" }],
      });
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    await page.loadSessionLogs("agent:main:detail");
    expect(page.usageSessionLogsStatus.error).toBe("logs unavailable");
    expect(page.usageSessionLogs).toBeNull();

    await page.loadSessionLogs("agent:main:detail");
    expect(page.usageSessionLogs).toEqual([{ timestamp: 1, role: "user", content: "hello" }]);
    expect(page.usageSessionLogsStatus).toEqual({ error: null, hasLoaded: true, stale: false });
  });

  it("does not retain detail data when the selected session changes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
      .mockResolvedValueOnce({
        logs: [{ timestamp: 1, role: "user", content: "session A" }],
      })
      .mockRejectedValueOnce(new Error("timeline unavailable"))
      .mockRejectedValueOnce(new Error("logs unavailable"));
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    page.usageSelectedSessions = ["agent:main:a"];
    await page.loadSessionTimeSeries("agent:main:a");
    await page.loadSessionLogs("agent:main:a");
    page.usageSelectedSessions = ["agent:main:b"];
    await page.loadSessionTimeSeries("agent:main:b");
    await page.loadSessionLogs("agent:main:b");

    expect(page.usageTimeSeries).toBeNull();
    expect(page.usageTimeSeriesStatus).toEqual({
      error: "timeline unavailable",
      hasLoaded: false,
      stale: false,
    });
    expect(page.usageSessionLogs).toBeNull();
    expect(page.usageSessionLogsStatus).toEqual({
      error: "logs unavailable",
      hasLoaded: false,
      stale: false,
    });
  });

  it("clears retained details when read authorization is rejected", async () => {
    const authorizationError = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "missing scope: operator.read",
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
      .mockResolvedValueOnce({
        logs: [{ timestamp: 1, role: "user", content: "sensitive" }],
      })
      .mockRejectedValueOnce(authorizationError)
      .mockRejectedValueOnce(authorizationError);
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    await page.loadSessionTimeSeries("agent:main:detail");
    await page.loadSessionLogs("agent:main:detail");
    await page.loadSessionTimeSeries("agent:main:detail");
    await page.loadSessionLogs("agent:main:detail");

    expect(page.usageTimeSeries).toBeNull();
    expect(page.usageTimeSeriesStatus).toEqual({
      error: "This connection is missing operator.read, so usage details cannot be loaded yet.",
      hasLoaded: false,
      stale: false,
    });
    expect(page.usageSessionLogs).toBeNull();
    expect(page.usageSessionLogsStatus).toEqual({
      error: "This connection is missing operator.read, so usage details cannot be loaded yet.",
      hasLoaded: false,
      stale: false,
    });
  });
});
