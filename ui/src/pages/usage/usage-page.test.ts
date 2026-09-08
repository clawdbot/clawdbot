/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWithClient,
  createPage,
  deferred,
  focusDocument,
  preloadUsage,
  refreshButton,
  type TestUsagePage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

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
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.usage.timeseries") {
          return { points: [] };
        }
        if (method === "sessions.usage.logs") {
          return { logs: [] };
        }
        return method === "usage.status"
          ? provider
          : method === "usage.cost"
            ? snapshot.costSummary
            : {
                ...snapshot.result,
                sessions: [{ key: "agent:main:poll", usage: snapshot.result.totals }],
              };
      });
      const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
      await preloadUsage(page);
      page.querySelector<HTMLButtonElement>(".session-bar-selection")!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(page.querySelector(".usage-cache-warning")?.textContent).toContain(
        "Checking for updated totals",
      );
      expect(page.querySelector(".usage-loading-spinner")).toBeNull();

      await vi.advanceTimersByTimeAsync(20_000);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(4);
      for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
      }
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

  it("does not transfer a manual detail refresh to a replacement selection", async () => {
    const snapshot = cacheSnapshot("sessions", "fresh");
    const keys = ["agent:main:a", "agent:main:b"];
    const result = {
      ...snapshot.result,
      sessions: keys.map((key) => ({ key, usage: snapshot.result.totals })),
    };
    const manual = deferred<typeof result>();
    let refreshing = false;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        return refreshing ? manual.promise : result;
      }
      if (method === "sessions.usage.timeseries") {
        return { points: [] };
      }
      if (method === "sessions.usage.logs") {
        return { logs: [{ timestamp: Date.now(), role: "user", content: String(params?.key) }] };
      }
      return method === "usage.cost" ? snapshot.costSummary : { providers: [] };
    });
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page.querySelectorAll<HTMLButtonElement>(".session-bar-selection")[0]!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".session-log-content")?.textContent).toBe(keys[0]),
    );

    refreshing = true;
    refreshButton(page).click();
    page.querySelectorAll<HTMLButtonElement>(".session-bar-selection")[1]!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".session-log-content")?.textContent).toBe(keys[1]),
    );
    manual.resolve(result);
    await vi.waitFor(() => expect(refreshButton(page).disabled).toBe(false));

    expect(page.querySelector(".session-log-content")?.textContent).toBe(keys[1]);
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
      expect(
        request.mock.calls.filter(([called]) => called === method).map(([, params]) => params?.key),
      ).toEqual(keys);
    }
  });

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
