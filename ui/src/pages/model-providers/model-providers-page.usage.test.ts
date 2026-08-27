/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  advanceUsageRetries,
  appendPage,
  createHarness,
  focusDocument,
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

    // loadModelProvidersData turns a rejected usage.status into providerUsage:
    // null. Read as a completed load that would reset the budget and erase the
    // notice, leaving broken usage looking exactly like absent usage.
    harness.failUsageStatus();
    page.querySelector<HTMLButtonElement>(".settings-section__actions button")?.click();
    await page.updateComplete;
    await advanceUsageRetries();
    await page.updateComplete;

    expect(page.textContent ?? "").toContain("did not finish loading");
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
      ).toBe(2),
    );
    releaseOldLoad();
    await vi.waitFor(() =>
      expect(page.data?.providerUsage).toMatchObject({
        ok: true,
        value: { updatedAt: 2 },
      }),
    );
  });
});
