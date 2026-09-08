/* @vitest-environment jsdom */

import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsUsageResult } from "../../api/types.ts";
import * as downloads from "../../lib/download.ts";
import * as toast from "../../lib/toast.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import type { UsageSessionEntry } from "./types.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWithClient,
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
  it("releases hydrated export reports after download while the page stays mounted", async () => {
    class ExportReport {
      name = "exported-context";
      blockChars = 10;
    }
    let report: WeakRef<ExportReport> | undefined;
    const snapshot = cacheSnapshot("sessions", "fresh");
    const session = {
      key: "agent:main:export-lifetime",
      label: "Export lifetime",
      agentId: "main",
      hasContextWeight: true,
      usage: snapshot.result.totals,
    };
    const request = async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        const weight = params?.includeContextWeight
          ? {
              ...contextWeight("exported-context"),
              skills: { promptChars: 10, entries: [new ExportReport()] },
            }
          : undefined;
        if (weight) {
          report = new WeakRef(weight.skills.entries[0]!);
        }
        return {
          ...snapshot.result,
          sessions: [{ ...session, ...(weight ? { contextWeight: weight } : {}) }],
        };
      }
      return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
    };
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page
      .querySelector(".usage-export-menu")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(download.mock.calls[0]![1]).toContain("exported-context");
    const collectionControl = new WeakRef({ unowned: true });
    await collectGarbageForTest(() => {
      queryObjects(ExportReport);
    });
    expect(collectionControl.deref()).toBeUndefined();
    expect(report).toBeDefined();
    expect(report!.deref()).toBeUndefined();
    expect(page.isConnected).toBe(true);
  });

  it("keeps cancelled details displayed and releases them on explicit clear", async () => {
    class DetailPayload {
      timestamp = 1;
      totalTokens = 10;
      role = "user";
      content = "Selected session";
    }
    const payloads: WeakRef<DetailPayload>[] = [];
    const request = async (method: string) => {
      const payload = new DetailPayload();
      payloads.push(new WeakRef(payload));
      return method === "sessions.usage.logs" ? { logs: [payload] } : { points: [payload] };
    };
    const page = await createPage({ request } as unknown as GatewayBrowserClient);
    await page.details.timeSeries.load("agent:main:detail-lifetime");
    await page.details.sessionLogs.load("agent:main:detail-lifetime");
    page.details.cancel();
    const collectionControl = new WeakRef({ unowned: true });
    await collectGarbageForTest(() => {
      queryObjects(DetailPayload);
    });
    expect(collectionControl.deref()).toBeUndefined();
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.deref() !== undefined)).toBe(true);
    expect(page.details.timeSeries.data).not.toBeNull();
    expect(page.details.sessionLogs.data).not.toBeNull();

    page.details.clear();
    await collectGarbageForTest(() => {
      queryObjects(DetailPayload);
    });
    expect(payloads.every((payload) => payload.deref() === undefined)).toBe(true);
    expect(page.details.timeSeries.data).toBeNull();
    expect(page.details.sessionLogs.data).toBeNull();
    expect(page.isConnected).toBe(true);
  });

  it("releases a loaded overview when its Gateway identity is replaced", async () => {
    class OverviewPayload {
      key = "agent:main:overview-lifetime";
      usage = null;
    }
    let payload: WeakRef<OverviewPayload> | undefined;
    const snapshot = cacheSnapshot("sessions", "fresh");
    const request = async (method: string) => {
      if (method === "sessions.usage") {
        const report = new OverviewPayload();
        payload = new WeakRef(report);
        return { ...snapshot.result, sessions: [report] };
      }
      return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
    };
    const page = await createPage({ request } as unknown as GatewayBrowserClient);
    await page.loadUsage();
    expect(payload).toBeDefined();
    page.context = contextWithClient({
      request: async () => ({}),
    } as unknown as GatewayBrowserClient);
    page.requestUpdate();
    await page.updateComplete;
    const collectionControl = new WeakRef({ unowned: true });
    await collectGarbageForTest(() => {
      queryObjects(OverviewPayload);
    });
    expect(collectionControl.deref()).toBeUndefined();
    expect(payload!.deref()).toBeUndefined();
    expect(page.isConnected).toBe(true);
  });

  it("keeps unavailable timeline and conversation details pending and refreshes them when admission reopens", async () => {
    const snapshot = cacheSnapshot("sessions", "fresh");
    const session = {
      key: "agent:main:detail",
      label: "Detail session",
      usage: snapshot.result.totals,
    };
    let unavailable = true;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return { ...snapshot.result, sessions: [session] };
      }
      if (method === "usage.cost") {
        return snapshot.costSummary;
      }
      if (method === "usage.status") {
        return { providers: [] };
      }
      if (unavailable) {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Gateway is suspending",
          retryable: true,
          details: { reason: "gateway-suspending", phase: "draining" },
        });
      }
      return method === "sessions.usage.logs"
        ? { logs: [{ timestamp: Date.now(), role: "user", content: "Recovered conversation" }] }
        : {
            points: [0, 1].map((offset) => ({
              timestamp: Date.now() + offset,
              totalTokens: 100,
              cost: 0.1,
              input: 100,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cumulativeTokens: 100,
              cumulativeCost: 0.1,
            })),
          };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = await createPage(client, true, context);
    await preloadUsage(page);
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
    await vi.waitFor(() => {
      expect(page.details.timeSeries.status.awaitingGateway).toBe(true);
      expect(page.details.sessionLogs.status.awaitingGateway).toBe(true);
    });
    await page.updateComplete;
    expect(page.querySelector(".usage-detail-error--timeline")).toBeNull();
    expect(page.querySelector(".usage-detail-error--conversation")).toBeNull();
    expect(page.querySelector(".session-logs-compact")?.textContent).toContain("Loading");

    unavailable = false;
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    await vi.waitFor(() => expect(page.textContent).toContain("Recovered conversation"));
    expect(page.querySelector(".timeseries-svg")).not.toBeNull();
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
      expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
    }
  });

  it("waits for pending detail failures before retrying when admission reopens first", async () => {
    const pending = deferred<never>();
    let recovered = false;
    const request = vi.fn(async (method: string) => {
      if (!recovered) {
        return pending.promise;
      }
      return method === "sessions.usage.logs"
        ? { logs: [{ timestamp: 1, role: "user", content: "Recovered after late rejection" }] }
        : { points: [{ timestamp: 1 }] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = await createPage(client, false, context);
    page.usageSelectedSessions = ["agent:main:detail"];
    const timeline = page.details.timeSeries.load("agent:main:detail");
    const conversation = page.details.sessionLogs.load("agent:main:detail");
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
    expect(request).toHaveBeenCalledTimes(2);

    recovered = true;
    pending.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Gateway was suspending",
        retryable: true,
        details: { reason: "gateway-suspending", phase: "draining" },
      }),
    );
    await Promise.all([timeline, conversation]);
    await vi.waitFor(() =>
      expect(page.details.sessionLogs.data?.[0]?.content).toBe("Recovered after late rejection"),
    );
    expect(page.details.timeSeries.data?.points).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not transfer queued detail recovery to a replacement selection", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    const request = vi.fn((_method: string, params: { key: string }) =>
      params.key === "agent:main:first" ? first.promise : second.promise,
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = await createPage(client, false, context);
    page.usageSelectedSessions = ["agent:main:first"];
    const firstLoad = page.details.timeSeries.load("agent:main:first");
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });

    page.usageSelectedSessions = ["agent:main:second"];
    const secondLoad = page.details.timeSeries.load("agent:main:second");
    second.reject(new Error("Selected timeline unavailable"));
    await secondLoad;
    first.reject(new Error("Retired timeline unavailable"));
    await firstLoad;
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.details.timeSeries.data).toBeNull();
    expect(page.details.timeSeries.status.error).toBe("Selected timeline unavailable");
  });

  it("retries interrupted detail requests on immediate same-client reconnect and fences their old replies", async () => {
    const pending = deferred<never>();
    let disconnected = false;
    const request = vi.fn(async (method: string) => {
      if (!disconnected) {
        return pending.promise;
      }
      return method === "sessions.usage.logs"
        ? { logs: [{ timestamp: 1, role: "user", content: "Recovered" }] }
        : { points: [{ timestamp: 1 }] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = await createPage(client, false, context);
    page.usageSelectedSessions = ["agent:main:detail"];
    const timeline = page.details.timeSeries.load("agent:main:detail");
    const conversation = page.details.sessionLogs.load("agent:main:detail");
    context.setGatewaySnapshot({ phase: "stopped" });
    disconnected = true;
    context.setGatewaySnapshot({ phase: "connected" });
    await vi.waitFor(() => expect(page.details.sessionLogs.data?.[0]?.content).toBe("Recovered"));
    pending.reject(new Error("gateway closed (1006): disconnected"));
    await Promise.all([timeline, conversation]);
    expect(page.details.timeSeries.status.error).toBeNull();
    expect(page.details.sessionLogs.status.error).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("loads context only for the selected session and fences superseded replies through automatic recovery", async () => {
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
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = await createPage(client, true, context);
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
    expect(page.querySelector(".usage-detail-error--context button")).toBeNull();
    context.setGatewaySnapshot({ suspensionPhase: "draining" });
    context.setGatewaySnapshot({ suspensionPhase: "accepting" });
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

  it("refreshes selected details and clears context when its report disappears", async () => {
    const snapshot = cacheSnapshot("sessions", "fresh");
    const timestamp = new Date().setHours(12, 0, 0, 0);
    let turns = 2;
    let available = true;
    let report = "original-context";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      const totals = {
        ...snapshot.result.totals,
        input: turns * 100,
        totalTokens: turns * 100,
        totalCost: turns * 0.1,
        inputCost: turns * 0.1,
      };
      if (method === "sessions.usage") {
        const session = {
          key: "agent:main:context",
          label: "Context session",
          agentId: "main",
          hasContextWeight: available,
          usage: totals,
        };
        return {
          ...snapshot.result,
          totals,
          sessions: [params?.key ? { ...session, contextWeight: contextWeight(report) } : session],
        };
      }
      if (method === "sessions.usage.timeseries") {
        return {
          points: Array.from({ length: turns }, (_, index) => ({
            timestamp: timestamp + index * 1_000,
            input: 100,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 100,
            cost: 0.1,
            cumulativeTokens: (index + 1) * 100,
            cumulativeCost: (index + 1) * 0.1,
          })),
        };
      }
      if (method === "sessions.usage.logs") {
        return {
          logs: [{ timestamp, role: "assistant", content: `${turns} completed turns` }],
        };
      }
      return method === "usage.cost" ? { ...snapshot.costSummary, totals } : { providers: [] };
    });
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain(report),
    );
    expect(page.querySelector(".timeseries-summary")?.textContent).toContain("200");
    expect(page.querySelector(".session-log-content")?.textContent).toBe("2 completed turns");

    turns = 3;
    report = "refreshed-context";
    refreshButton(page).click();
    await vi.waitFor(() =>
      expect(page.querySelector(".context-details-panel")?.textContent).toContain(report),
    );
    expect(page.querySelector(".session-detail-stats")?.textContent).toContain("300");
    expect.soft(page.querySelector(".timeseries-summary")?.textContent).toContain("300");
    expect.soft(page.querySelector(".session-log-content")?.textContent).toBe("3 completed turns");
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
        sessionId: "shared-instance",
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
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
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
        contextWeight: { ...contextWeight(session.label), sessionId: session.sessionId },
      })),
    };
    pending.resolve(full);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const payload = JSON.parse(download.mock.calls[0]![1]) as { sessions: UsageSessionEntry[] };
    expect(payload.sessions).toEqual([
      {
        ...result.sessions[0],
        contextWeight: { ...contextWeight("First"), sessionId: "shared-instance" },
      },
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

    for (const [scenario, sessionId, otherSessionId, expectedDownloads] of [
      ["matching instance", "shared-instance", "shared-instance", 1],
      ["replacement instance", "replacement-instance", "shared-instance", 0],
      ["unrelated agent replacement", "shared-instance", "other-instance", 1],
    ] as const) {
      download.mockClear();
      notice.mockClear();
      pending = deferred<SessionsUsageResult>();
      exportJson();
      await page.updateComplete;
      expect(page.querySelector('.usage-export-menu button[aria-busy="true"]')).not.toBeNull();
      pending.resolve({
        ...full,
        sessions: [
          {
            ...full.sessions[0]!,
            sessionId,
            contextWeight: { ...contextWeight("Current first"), sessionId },
          },
          {
            ...full.sessions[1]!,
            sessionId: otherSessionId,
            contextWeight: { ...contextWeight("Other agent"), sessionId: otherSessionId },
          },
        ],
      });
      await vi.waitFor(() =>
        expect(page.querySelector('.usage-export-menu button[aria-busy="true"]')).toBeNull(),
      );
      expect(download, scenario).toHaveBeenCalledTimes(expectedDownloads);
      if (expectedDownloads === 0) {
        expect(notice).toHaveBeenCalledWith({
          message: expect.stringContaining("Refresh usage and try again"),
        });
      } else {
        expect(notice).not.toHaveBeenCalled();
        const exportedPayload = JSON.parse(download.mock.calls[0]![1]) as {
          sessions: UsageSessionEntry[];
        };
        expect(exportedPayload.sessions).toMatchObject([
          {
            key: "global",
            agentId: "main",
            sessionId: "shared-instance",
            usage: { totalTokens: 100 },
            contextWeight: {
              sessionId: "shared-instance",
              skills: { entries: [{ name: "Current first" }] },
            },
          },
        ]);
      }
    }
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

  it.each(["resolve", "reject"])(
    "commits only the latest time-series selection (%s)",
    async (completion) => {
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
      if (completion === "resolve") {
        first.resolve({ points: [{ timestamp: 1 }] } as SessionUsageTimeSeries);
      } else {
        first.reject(new Error("superseded timeline failed"));
      }
      await firstLoad;

      expect(page.details.timeSeries.data).toBe(latest);
      expect(page.details.timeSeries.status.error).toBeNull();
    },
  );

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
      awaitingGateway: false,
    });
    expect(page.details.timeSeries.data).toBe(previous);

    const retryLoad = page.details.timeSeries.load("agent:main:detail");
    expect(page.details.timeSeries.status).toEqual({
      error: null,
      hasLoaded: true,
      stale: true,
      awaitingGateway: false,
    });
    const result = { points: [] } as unknown as SessionUsageTimeSeries;
    retry.resolve(result);
    await retryLoad;

    expect(page.details.timeSeries.data).toBe(result);
    expect(page.details.timeSeries.status).toEqual({
      error: null,
      hasLoaded: true,
      stale: false,
      awaitingGateway: false,
    });
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
    expect(page.details.sessionLogs.status).toEqual({
      error: null,
      hasLoaded: true,
      stale: false,
      awaitingGateway: false,
    });
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
      awaitingGateway: false,
    });
    expect(page.details.sessionLogs.data).toBeNull();
    expect(page.details.sessionLogs.status).toEqual({
      error: "logs unavailable",
      hasLoaded: false,
      stale: false,
      awaitingGateway: false,
    });
  });

  it.each(["accepting", "draining"] as const)(
    "clears retained details and preserves read authorization errors while %s",
    async (suspensionPhase) => {
      const pending = deferred<never>();
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
        .mockReturnValue(pending.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const page = await createPage(client, false, context);

      await page.details.timeSeries.load("agent:main:detail");
      await page.details.sessionLogs.load("agent:main:detail");
      const timeline = page.details.timeSeries.load("agent:main:detail");
      const conversation = page.details.sessionLogs.load("agent:main:detail");
      context.setGatewaySnapshot({ suspensionPhase });
      pending.reject(authorizationError);
      await Promise.all([timeline, conversation]);

      expect(page.details.timeSeries.data).toBeNull();
      expect(page.details.timeSeries.status).toEqual({
        error: "This connection is missing operator.read, so usage details cannot be loaded yet.",
        hasLoaded: false,
        stale: false,
        awaitingGateway: false,
      });
      expect(page.details.sessionLogs.data).toBeNull();
      expect(page.details.sessionLogs.status).toEqual({
        error: "This connection is missing operator.read, so usage details cannot be loaded yet.",
        hasLoaded: false,
        stale: false,
        awaitingGateway: false,
      });
    },
  );
});
