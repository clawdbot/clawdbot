/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionUsageTimeSeries } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SessionLogEntry } from "./types.ts";
import "./usage-page.ts";

type TestUsagePage = HTMLElement & {
  context: ApplicationContext;
  usageSelectedSessions: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesStatus: { error: string | null; hasLoaded: boolean; stale: boolean };
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
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

describe("UsagePage detail requests", () => {
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
    expect(page.usageTimeSeriesLoading).toBe(false);
    expect(page.usageTimeSeries).toBe(previous);

    const retryLoad = page.loadSessionTimeSeries("agent:main:detail");
    expect(page.usageTimeSeriesStatus).toEqual({ error: null, hasLoaded: true, stale: true });
    expect(page.usageTimeSeriesLoading).toBe(true);
    const result = { points: [] } as unknown as SessionUsageTimeSeries;
    retry.resolve(result);
    await retryLoad;

    expect(page.usageTimeSeries).toBe(result);
    expect(page.usageTimeSeriesStatus).toEqual({ error: null, hasLoaded: true, stale: false });
    expect(page.usageTimeSeriesLoading).toBe(false);
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
    expect(page.usageSessionLogsLoading).toBe(false);
    expect(page.usageSessionLogs).toBeNull();

    await page.loadSessionLogs("agent:main:detail");
    expect(page.usageSessionLogs).toEqual([{ timestamp: 1, role: "user", content: "hello" }]);
    expect(page.usageSessionLogsStatus).toEqual({ error: null, hasLoaded: true, stale: false });
    expect(page.usageSessionLogsLoading).toBe(false);
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
