/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  advanceUsageRetries,
  appendPage,
  createHarness,
  deferred,
  focusDocument,
  requestCount,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage usage convergence", () => {
  it("restarts an exhausted retry cycle on same-client reconnect", async () => {
    vi.useFakeTimers();
    focusDocument();
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
    const page = appendPage(harness.context);
    await page.updateComplete;
    await advanceUsageRetries();

    const usageCallsBeforeReconnect = harness.request.mock.calls.filter(
      ([method]) => method === "usage.status",
    ).length;
    expect(usageCallsBeforeReconnect).toBe(4);

    harness.publishPhase("offline");
    await page.updateComplete;
    harness.publishPhase("connected");
    await page.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.request.mock.calls.filter(([method]) => method === "usage.status").length).toBe(
      5,
    );
  });

  it("reports a stalled provider refresh once the retry budget is spent", async () => {
    vi.useFakeTimers();
    focusDocument();
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
    const page = appendPage(harness.context);
    await page.updateComplete;

    // Nothing is visible while retries are still in flight: a converging load is
    // not a failure and must not warn.
    expect(page.textContent ?? "").not.toContain("did not finish loading");

    await advanceUsageRetries();
    await page.updateComplete;

    // Budget spent and the payload is still incomplete. Rendering the ordinary
    // cards with no usage and no notice is indistinguishable from a provider
    // that simply reports none.
    expect(page.textContent ?? "").toContain("did not finish loading");

    // The notice says "Refresh to retry", so a manual refresh has to hand back a
    // budget — otherwise the button is a dead end and nothing ever converges.
    const callsBeforeManual = harness.request.mock.calls.filter(
      ([method]) => method === "usage.status",
    ).length;
    page.querySelector<HTMLButtonElement>(".settings-section__actions button")?.click();
    await page.updateComplete;
    await advanceUsageRetries();
    expect(
      harness.request.mock.calls.filter(([method]) => method === "usage.status").length,
    ).toBeGreaterThan(callsBeforeManual + 1);
  });

  it("keeps the stalled explanation when usage.status starts rejecting", async () => {
    vi.useFakeTimers();
    focusDocument();
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
    const page = appendPage(harness.context);
    await page.updateComplete;
    await advanceUsageRetries();
    await page.updateComplete;
    expect(page.textContent ?? "").toContain("did not finish loading");

    // The supplemental load turns a rejected usage.status into a failed result.
    // Treating it as complete would reset the budget and erase the notice,
    // leaving broken usage looking exactly like absent usage.
    harness.failUsageStatus();
    page.querySelector<HTMLButtonElement>(".settings-section__actions button")?.click();
    await page.updateComplete;
    await advanceUsageRetries();
    await page.updateComplete;

    expect(page.textContent ?? "").toContain("did not finish loading");
  });

  it("retries incomplete usage without restarting pending cost", async () => {
    vi.useFakeTimers();
    focusDocument();
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
    const pendingCost = deferred<unknown>();
    const originalRequest = harness.request.getMockImplementation()!;
    let costSignal: AbortSignal | undefined;
    harness.request.mockImplementation(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "sessions.usage") {
          costSignal = options?.signal;
          return pendingCost.promise;
        }
        return originalRequest(method);
      },
    );

    const page = appendPage(harness.context);
    await page.updateComplete;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestCount(harness.request, "usage.status")).toBeGreaterThan(1);
    expect(requestCount(harness.request, "sessions.usage")).toBe(1);
    expect(costSignal?.aborted).toBe(false);

    pendingCost.resolve({ aggregates: { byProvider: [] } });
    await vi.waitFor(() => expect(page.data?.costByProvider).toEqual([]));
  });

  it("does not warn about a stall while disconnected", async () => {
    vi.useFakeTimers();
    const harness = createHarness("main");
    const page = appendPage(harness.context);
    await page.updateComplete;

    // Disconnected route data carries providerUsage: null for the ordinary
    // "nothing loaded yet" reason. Treating that as unresolved would count down
    // the budget and warn about a stall that never happened.
    page.routeData = {
      gateway: harness.context.gateway,
      gatewaySnapshot: harness.context.gateway.snapshot,
      data: EMPTY_MODEL_PROVIDERS_DATA,
      client: null,
      agentId: "main",
    };
    page.requestUpdate();
    await page.updateComplete;
    await vi.advanceTimersByTimeAsync(60_000);
    await page.updateComplete;

    expect(page.textContent ?? "").not.toContain("did not finish loading");
  });

  it("replaces a pending pre-disconnect load before it can publish", async () => {
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [] });
    const releaseOldLoad = harness.deferNextAuthStatus();
    const page = appendPage(harness.context);
    await page.updateComplete;

    harness.publishPhase("offline");
    await page.updateComplete;
    harness.setUsageStatus({ updatedAt: 2, providers: [] });
    harness.publishPhase("connected");
    await page.updateComplete;

    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === "usage.status").length,
      ).toBe(1),
    );
    releaseOldLoad();
    await vi.waitFor(() =>
      expect(page.data?.providerUsage).toMatchObject({
        ok: true,
        value: { updatedAt: 2 },
      }),
    );
  });

  it("cancels and replaces supplemental work on forced refresh", async () => {
    const harness = createHarness("main");
    const oldUsage = deferred<unknown>();
    const oldCost = deferred<unknown>();
    const originalRequest = harness.request.getMockImplementation()!;
    let firstUsageSignal: AbortSignal | undefined;
    let firstCostSignal: AbortSignal | undefined;
    let usageCall = 0;
    let costCall = 0;
    harness.request.mockImplementation(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "sessions.usage") {
          costCall += 1;
          if (costCall === 1) {
            firstCostSignal = options?.signal;
            return oldCost.promise;
          }
          return originalRequest(method);
        }
        if (method === "usage.status") {
          usageCall += 1;
          if (usageCall === 1) {
            firstUsageSignal = options?.signal;
            return oldUsage.promise;
          }
          return { updatedAt: 2, providers: [] };
        }
        return originalRequest(method);
      },
    );
    const page = appendPage(harness.context);
    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(1));
    await vi.waitFor(() => expect(requestCount(harness.request, "sessions.usage")).toBe(1));

    const releaseCoreRefresh = harness.deferNextAuthStatus();
    const refresh = page.refresh({ force: true });
    expect(firstUsageSignal?.aborted).toBe(true);
    expect(firstCostSignal?.aborted).toBe(true);

    oldUsage.resolve({ updatedAt: 1, providers: [] });
    oldCost.resolve({
      aggregates: { byProvider: [{ provider: "stale", totals: { totalCost: 1 } }] },
    });
    await Promise.resolve();
    expect(page.data?.providerUsage).toBeNull();
    expect(page.data?.costByProvider).toBeNull();

    releaseCoreRefresh();
    await refresh;

    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(2));
    await vi.waitFor(() => expect(requestCount(harness.request, "sessions.usage")).toBe(2));
    await vi.waitFor(() =>
      expect(page.data?.providerUsage).toMatchObject({ ok: true, value: { updatedAt: 2 } }),
    );
    await vi.waitFor(() => expect(page.data?.costByProvider).toEqual([]));

    expect(requestCount(harness.request, "usage.status")).toBe(2);
    expect(requestCount(harness.request, "sessions.usage")).toBe(2);
    expect(page.data?.providerUsage).toMatchObject({ ok: true, value: { updatedAt: 2 } });
  });
});
