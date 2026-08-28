/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsUsageResult, SessionUsageTimeSeries } from "../../api/types.ts";
import * as toast from "../../lib/toast.ts";
import * as usageQuery from "./query.ts";
import type { UsageSessionEntry } from "./types.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  createPage,
  deferred,
  focusDocument,
  preloadUsage,
  refreshButton,
} from "./usage-page.test-support.ts";
import type { UsageRouteData } from "./usage-page.ts";

afterEach(cleanupUsagePageTest);

function contextWeight(name: string): NonNullable<UsageSessionEntry["contextWeight"]> {
  return {
    source: "run",
    generatedAt: 1,
    systemPrompt: { chars: 80, projectContextChars: 20, nonProjectContextChars: 60 },
    skills: { promptChars: 10, entries: [{ name, blockChars: 10 }] },
    tools: { listChars: 0, schemaChars: 0, entries: [] },
    injectedWorkspaceFiles: [],
  };
}

describe("UsagePage detail requests", () => {
  it("loads context only for the selected session and fences superseded replies through retry", async () => {
    const snapshot = cacheSnapshot("sessions", "fresh");
    const keys = ["agent:main:first", "agent:main:second", "global"];
    const result = {
      ...snapshot.result,
      sessions: keys.map((key, index) => ({
        key,
        label: `Session ${index + 1}`,
        agentId: "main",
        hasContextWeight: index < 2,
        usage: snapshot.result.totals,
      })),
    };
    const first = deferred<SessionsUsageResult>();
    const second = deferred<SessionsUsageResult>();
    const request = vi.fn(
      async (
        method: string,
        params?: Record<string, unknown>,
        _options?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        if (method === "sessions.usage") {
          if (params?.key === keys[0]) {
            return first.promise;
          }
          if (params?.key === keys[1]) {
            return second.promise;
          }
          return result;
        }
        return method === "usage.cost"
          ? snapshot.costSummary
          : { providers: [], logs: [], points: [] };
      },
    );
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    const initial = request.mock.calls.find(([method]) => method === "sessions.usage")!;
    expect(initial[1]).toMatchObject({ includeContextWeight: false });
    expect(request.mock.calls.filter(([, params]) => params?.key)).toHaveLength(0);

    const selectSession = (index: number) => {
      page.querySelectorAll<HTMLButtonElement>(".session-bar-selection")[index]!.click();
    };
    selectSession(0);
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain("Loading"),
    );
    const firstContext = request.mock.calls.find(
      ([method, params]) => method === "sessions.usage" && params?.key === keys[0],
    )!;
    const contextParams = { ...initial[1] };
    delete contextParams.agentScope;
    expect(firstContext[1]).toEqual({
      ...contextParams,
      agentId: "main",
      key: keys[0],
      limit: 1,
      includeContextWeight: true,
    });
    expect(firstContext[2]?.signal?.aborted).toBe(false);

    selectSession(1);
    expect(firstContext[2]?.signal?.aborted).toBe(true);
    first.resolve({
      ...result,
      sessions: [{ ...result.sessions[0]!, contextWeight: contextWeight("stale-context") }],
    });
    second.reject(new Error("context unavailable"));
    await vi.waitFor(() =>
      expect(page.querySelector(".usage-detail-error--context")?.textContent).toContain(
        "context unavailable",
      ),
    );
    expect(page.querySelector(".context-details-panel")?.textContent).not.toContain(
      "stale-context",
    );
    expect(page.querySelector(".context-details-panel")?.textContent).not.toContain(
      "No context data",
    );

    request.mockImplementation(async (method, params) =>
      method === "sessions.usage" && params?.key === keys[1]
        ? {
            ...result,
            sessions: [
              { ...result.sessions[1]!, contextWeight: contextWeight("selected-context") },
            ],
          }
        : { logs: [], points: [] },
    );
    page.querySelector<HTMLButtonElement>(".usage-detail-error--context button")!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain(
        "selected-context",
      ),
    );
    expect(page.querySelector(".usage-detail-error--context")).toBeNull();
    expect(
      request.mock.calls.filter(([method, params]) => method === "sessions.usage" && !params?.key),
    ).toHaveLength(1);
    const contextCalls = request.mock.calls.filter(
      ([method]) => method === "sessions.usage",
    ).length;
    selectSession(2);
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain(
        "No context data",
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(
      contextCalls,
    );
  });

  it("refreshes the selected context and clears it when its report disappears", async () => {
    const snapshot = cacheSnapshot("sessions", "fresh");
    let available = true;
    let report = "original-context";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        const session = {
          key: "agent:main:context",
          label: "Context session",
          agentId: "main",
          hasContextWeight: available,
          usage: snapshot.result.totals,
        };
        return {
          ...snapshot.result,
          sessions: [params?.key ? { ...session, contextWeight: contextWeight(report) } : session],
        };
      }
      return method === "usage.cost"
        ? snapshot.costSummary
        : { providers: [], logs: [], points: [] };
    });
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain(report),
    );

    report = "refreshed-context";
    refreshButton(page).click();
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain(report),
    );
    const contextRequests = request.mock.calls.filter(
      ([method, params]) => method === "sessions.usage" && params?.key,
    ).length;
    available = false;
    refreshButton(page).click();
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain(
        "No context data",
      ),
    );
    expect(
      request.mock.calls.filter(([method, params]) => method === "sessions.usage" && params?.key),
    ).toHaveLength(contextRequests);
    expect(page.querySelector(".context-details-panel")?.textContent).not.toContain(report);
  });

  it("preserves agent-owned context in filtered JSON exports and cancels exports when scope changes", async () => {
    const snapshot = cacheSnapshot("sessions", "fresh");
    const result = {
      ...snapshot.result,
      sessions: ["First", "Second"].map((label, index) => ({
        key: "global",
        label,
        agentId: index === 0 ? "main" : "opus",
        hasContextWeight: true,
        usage: snapshot.result.totals,
      })),
    };
    let pending = deferred<SessionsUsageResult>();
    const request = vi.fn(
      async (
        method: string,
        params?: Record<string, unknown>,
        _options?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        if (method === "sessions.usage") {
          return params?.includeContextWeight ? pending.promise : result;
        }
        return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
      },
    );
    const download = vi.spyOn(usageQuery, "downloadTextFile").mockImplementation(() => {});
    const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    const query = page.querySelector<HTMLInputElement>(".usage-query-input")!;
    query.value = "label:first";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await page.updateComplete;
    const exportJson = () =>
      page
        .querySelector(".usage-export-menu")!
        .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
    exportJson();
    await page.updateComplete;
    expect(download).not.toHaveBeenCalled();
    expect(page.querySelector('.usage-export-menu button[aria-busy="true"]')).not.toBeNull();
    const initial = request.mock.calls.find(([method]) => method === "sessions.usage")!;
    const exported = request.mock.calls.find(([, params]) => params?.includeContextWeight)!;
    expect(exported[1]).toEqual({ ...initial[1], includeContextWeight: true });
    const full = {
      ...result,
      sessions: result.sessions.map((session) => ({
        ...session,
        usage: { ...session.usage, totalTokens: 9999 },
        contextWeight: contextWeight(session.label),
      })),
    };
    pending.resolve(full);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const payload = JSON.parse(download.mock.calls[0]![1]) as { sessions: UsageSessionEntry[] };
    expect(payload.sessions).toEqual([
      { ...result.sessions[0], contextWeight: contextWeight("First") },
    ]);
    expect(page.querySelector('.usage-export-menu button[aria-busy="true"]')).toBeNull();

    pending = deferred<SessionsUsageResult>();
    exportJson();
    await page.updateComplete;
    const cancelled = request.mock.calls.at(-1)!;
    const scope = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Current instance",
    )!;
    scope.click();
    expect(cancelled[2]?.signal?.aborted).toBe(true);
    pending.resolve(full);
    await vi.waitFor(() => expect(refreshButton(page).disabled).toBe(false));
    expect(download).toHaveBeenCalledOnce();

    pending = deferred<SessionsUsageResult>();
    exportJson();
    pending.resolve({ ...full, sessions: [full.sessions[1]!] });
    await vi.waitFor(() =>
      expect(notice).toHaveBeenCalledWith({
        message: expect.stringContaining("Refresh usage and try again"),
      }),
    );
    expect(download).toHaveBeenCalledOnce();
  });

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
    const firstLoad = page.details.timeSeries.load("agent:main:a");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.usageSelectedSessions = ["agent:main:b"];
    const secondLoad = page.details.timeSeries.load("agent:main:b");
    const latest = { points: [{ timestamp: 2 }] } as SessionUsageTimeSeries;
    second.resolve(latest);
    await secondLoad;
    first.resolve({ points: [{ timestamp: 1 }] } as SessionUsageTimeSeries);
    await firstLoad;

    expect(page.details.timeSeries.data).toBe(latest);
  });

  it("retains stale time-series data until a retry succeeds", async () => {
    const retry = deferred<SessionUsageTimeSeries>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
      .mockRejectedValueOnce(new Error("timeline unavailable"))
      .mockReturnValueOnce(retry.promise);
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    await page.details.timeSeries.load("agent:main:detail");
    const previous = page.details.timeSeries.data;

    await page.details.timeSeries.load("agent:main:detail");
    expect(page.details.timeSeries.status).toEqual({
      error: "timeline unavailable",
      hasLoaded: true,
      stale: true,
    });
    expect(page.details.timeSeries.data).toBe(previous);

    const retryLoad = page.details.timeSeries.load("agent:main:detail");
    expect(page.details.timeSeries.status).toEqual({ error: null, hasLoaded: true, stale: true });
    const result = { points: [] } as unknown as SessionUsageTimeSeries;
    retry.resolve(result);
    await retryLoad;

    expect(page.details.timeSeries.data).toBe(result);
    expect(page.details.timeSeries.status).toEqual({ error: null, hasLoaded: true, stale: false });
  });

  it("surfaces a session-log failure and clears it after a successful retry", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("logs unavailable"))
      .mockResolvedValueOnce({
        logs: [{ timestamp: 1, role: "user", content: "hello" }],
      });
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    await page.details.sessionLogs.load("agent:main:detail");
    expect(page.details.sessionLogs.status.error).toBe("logs unavailable");
    expect(page.details.sessionLogs.data).toBeNull();

    await page.details.sessionLogs.load("agent:main:detail");
    expect(page.details.sessionLogs.data).toEqual([
      { timestamp: 1, role: "user", content: "hello" },
    ]);
    expect(page.details.sessionLogs.status).toEqual({ error: null, hasLoaded: true, stale: false });
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
    await page.details.timeSeries.load("agent:main:a");
    await page.details.sessionLogs.load("agent:main:a");
    page.usageSelectedSessions = ["agent:main:b"];
    await page.details.timeSeries.load("agent:main:b");
    await page.details.sessionLogs.load("agent:main:b");

    expect(page.details.timeSeries.data).toBeNull();
    expect(page.details.timeSeries.status).toEqual({
      error: "timeline unavailable",
      hasLoaded: false,
      stale: false,
    });
    expect(page.details.sessionLogs.data).toBeNull();
    expect(page.details.sessionLogs.status).toEqual({
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

    await page.details.timeSeries.load("agent:main:detail");
    await page.details.sessionLogs.load("agent:main:detail");
    await page.details.timeSeries.load("agent:main:detail");
    await page.details.sessionLogs.load("agent:main:detail");

    expect(page.details.timeSeries.data).toBeNull();
    expect(page.details.timeSeries.status).toEqual({
      error: "This connection is missing operator.read, so usage details cannot be loaded yet.",
      hasLoaded: false,
      stale: false,
    });
    expect(page.details.sessionLogs.data).toBeNull();
    expect(page.details.sessionLogs.status).toEqual({
      error: "This connection is missing operator.read, so usage details cannot be loaded yet.",
      hasLoaded: false,
      stale: false,
    });
  });
});
