/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionUsageTimeSeries } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import type { SessionLogEntry } from "./types.ts";
import type { UsageRouteData } from "./usage-page.ts";
import "./usage-page.ts";

type TestUsagePage = HTMLElement & {
  context: ApplicationContext;
  routeData: UsageRouteData;
  usageSelectedSessions: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesStatus: { error: string | null; hasLoaded: boolean; stale: boolean };
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsStatus: { error: string | null; hasLoaded: boolean; stale: boolean };
  loadSessionTimeSeries: (sessionKey: string) => Promise<void>;
  loadSessionLogs: (sessionKey: string) => Promise<void>;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function gatewaySnapshot(
  client: GatewayBrowserClient | null,
  phase: "connected" | "reconnecting",
): ApplicationGatewaySnapshot {
  return {
    client,
    phase,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
}

/** Gateway stub whose snapshot publishes reach subscribers, for reconnect tests. */
function publishableGateway(client: GatewayBrowserClient) {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    snapshot: gatewaySnapshot(client, "connected"),
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: ApplicationGatewaySnapshot) {
      gateway.snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
  return gateway;
}

function contextWithClient(client: GatewayBrowserClient): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway: publishableGateway(client),
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

async function createPage(client: GatewayBrowserClient): Promise<TestUsagePage> {
  const page = document.createElement("openclaw-usage-page") as TestUsagePage;
  page.context = contextWithClient(client);
  page.render = () => nothing;
  document.body.append(page);
  await page.updateComplete;
  page.usageSelectedSessions = ["agent:main:detail"];
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const loadedProviderUsage: ProviderUsageSummary = {
  updatedAt: 2,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 10 }],
    },
  ],
};

function usageRouteData(
  context: ApplicationContext,
  providerUsageSummary: ProviderUsageSummary,
): UsageRouteData {
  return {
    gateway: context.gateway,
    gatewaySnapshot: context.gateway.snapshot,
    query: {
      startDate: "2026-08-05",
      endDate: "2026-08-05",
      scope: "family",
      timeZone: "local",
      agentId: null,
    },
    result: null,
    costSummary: null,
    providerUsageSummary,
    loadedAtMs: Date.now(),
    error: null,
  };
}

describe("UsagePage provider usage", () => {
  it("fills the provider panel after a refreshing payload without user action", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "usage.status") {
          return loadedProviderUsage;
        }
        return method === "usage.cost" ? { daily: [] } : { sessions: [], totals: null };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const page = document.createElement("openclaw-usage-page") as TestUsagePage;
      page.context = contextWithClient(client);
      document.body.append(page);
      await page.updateComplete;

      // A Gateway that has not loaded provider usage yet answers with the marker only.
      page.routeData = usageRouteData(page.context, {
        updatedAt: 1,
        providers: [],
        refreshing: true,
      });
      await page.updateComplete;
      expect(document.querySelector(".provider-usage-card")).toBeNull();
      expect(request).not.toHaveBeenCalledWith("usage.status", undefined, expect.anything());

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith("usage.status", undefined, expect.anything());
      });
      await vi.waitFor(async () => {
        await page.updateComplete;
        expect(document.querySelector(".provider-usage-card__name")?.textContent).toContain(
          "OpenAI",
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the exhausted retry budget after a same-client reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const refreshingUsage: ProviderUsageSummary = {
        updatedAt: 1,
        providers: [],
        refreshing: true,
      };
      let usageStatusCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "usage.status") {
          usageStatusCalls += 1;
          return refreshingUsage;
        }
        return method === "usage.cost" ? { daily: [] } : { sessions: [], totals: null };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const page = document.createElement("openclaw-usage-page") as TestUsagePage;
      page.context = contextWithClient(client);
      document.body.append(page);
      await page.updateComplete;
      page.routeData = usageRouteData(page.context, refreshingUsage);
      await page.updateComplete;

      // Every response stays refreshing, so the bounded budget spends itself:
      // three fetches, then silence.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      await vi.waitFor(() => {
        expect(usageStatusCalls).toBe(3);
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(usageStatusCalls).toBe(3);

      // The transport supervisor reconnects inside the same client object; only
      // the connection is new. The reconnect fetch must run with a re-armed
      // budget so its refreshing answer schedules a bounded follow-up retry.
      const gateway = page.context.gateway as unknown as ReturnType<typeof publishableGateway>;
      gateway.publish(gatewaySnapshot(client, "reconnecting"));
      gateway.publish(gatewaySnapshot(client, "connected"));
      await vi.waitFor(() => {
        expect(usageStatusCalls).toBe(4);
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(usageStatusCalls).toBe(5);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("UsagePage detail requests", () => {
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
