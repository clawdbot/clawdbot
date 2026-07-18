/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n, t } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { USAGE_PAYLOAD_TTL_MS, type UsageRefreshReason } from "../usage/refresh-policy.ts";
import { ProfilePage } from "./profile-page.ts";

const PROFILE_PAGE_TEST_TAG = "test-openclaw-profile-page";
// Keep the element class on the same post-reset i18n module as this test.
if (!customElements.get(PROFILE_PAGE_TEST_TAG)) {
  customElements.define(PROFILE_PAGE_TEST_TAG, class extends ProfilePage {});
}

type ProfilePageElement = HTMLElement & {
  updateComplete: Promise<boolean>;
};

function createContext(
  client: GatewayBrowserClient | null = null,
  connected = false,
): ApplicationContext<RouteId> {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    gateway: { snapshot, subscribe },
    agents: { subscribe, ensureList: vi.fn(async () => null) },
    agentIdentity: { subscribe, ensure: vi.fn(async () => undefined) },
  } as unknown as ApplicationContext<RouteId>;
}

function createCostSummary(cacheStatus?: CostUsageSummary["cacheStatus"]): CostUsageSummary {
  return {
    updatedAt: 0,
    days: 0,
    daily: [],
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 1,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

function createSessionsResult(): SessionsUsageResult {
  const totals = createCostSummary().totals;
  return {
    updatedAt: 0,
    startDate: "2026-07-08",
    endDate: "2026-07-08",
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
  };
}

function createConnectedContext(request: GatewayBrowserClient["request"]) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: { request } as GatewayBrowserClient,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const subscribe = () => () => undefined;
  const context = {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    agents: {
      state: { agentsList: null },
      ensureList: async () => null,
      subscribe,
    },
    agentIdentity: {
      get: () => null,
      ensure: async () => undefined,
      subscribe,
    },
    config: {
      current: {
        assistantIdentity: {
          name: "OpenClaw",
          avatar: null,
          avatarSource: null,
          avatarStatus: null,
          avatarReason: null,
        },
      },
      subscribe,
    },
    basePath: "",
  } as unknown as ApplicationContext<RouteId>;
  return {
    context,
    emitConnected(connected: boolean) {
      snapshot = { ...snapshot, connected };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

it("refreshes translated copy when the locale changes while mounted", async () => {
  const provider = createApplicationContextProvider(createContext());
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;

  const note = page.querySelector(".settings-empty");
  const englishNote = note?.textContent?.trim();

  await i18n.setLocale("de");
  await page.updateComplete;

  expect(note?.textContent?.trim()).toBe(t("profilePage.offline"));
  expect(note?.textContent?.trim()).not.toBe(englishNote);
});

it("gates profile usage refreshes by payload age and page visibility", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const request = vi.fn(async (method: string) => {
    if (method === "usage.cost") {
      return createCostSummary();
    }
    return createSessionsResult();
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement & {
    costSummary: CostUsageSummary | null;
    lastProfileLoadedAtMs: number | null;
    loading: boolean;
    requestProfileRefresh: (reason: UsageRefreshReason) => void;
    scheduleCacheSettleRefresh: () => void;
  };
  provider.append(page);
  document.body.append(provider);
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
  await waitForFast(() => expect(page.loading).toBe(false));

  harness.emitConnected(false);
  harness.emitConnected(true);
  expect(request).toHaveBeenCalledTimes(2);

  let reconnectPollDelayMs: number | undefined;
  const reconnectTimerSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
    _handler: TimerHandler,
    timeout?: number,
  ) => {
    reconnectPollDelayMs = Number(timeout);
    return 1;
  }) as unknown as typeof window.setTimeout);
  page.costSummary = createCostSummary({
    status: "refreshing",
    cachedFiles: 0,
    pendingFiles: 1,
    staleFiles: 0,
  });
  harness.emitConnected(false);
  harness.emitConnected(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(reconnectPollDelayMs).toBeGreaterThan(0);
  expect(reconnectPollDelayMs).toBeLessThanOrEqual(USAGE_PAYLOAD_TTL_MS);
  reconnectTimerSpy.mockRestore();

  page.lastProfileLoadedAtMs = Date.now() - USAGE_PAYLOAD_TTL_MS;
  visibility.mockReturnValue("hidden");
  harness.emitConnected(false);
  harness.emitConnected(true);
  expect(request).toHaveBeenCalledTimes(2);

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
  await waitForFast(() => expect(page.loading).toBe(false));

  page.querySelector<HTMLButtonElement>(".profile-refresh")?.click();
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(6));
  await waitForFast(() => expect(page.loading).toBe(false));

  let settlePoll: TimerHandler | null = null;
  let settleDelayMs: number | undefined;
  const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
  ) => {
    settlePoll = handler;
    settleDelayMs = Number(timeout);
    return 1;
  }) as unknown as typeof window.setTimeout);
  page.costSummary = createCostSummary({
    status: "refreshing",
    cachedFiles: 0,
    pendingFiles: 1,
    staleFiles: 0,
  });
  const nowMs = Date.now();
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
  page.lastProfileLoadedAtMs = nowMs;
  page.scheduleCacheSettleRefresh();
  expect(settleDelayMs).toBe(USAGE_PAYLOAD_TTL_MS);
  nowSpy.mockRestore();

  page.lastProfileLoadedAtMs = Date.now() - USAGE_PAYLOAD_TTL_MS;
  visibility.mockReturnValue("hidden");
  (settlePoll as (() => void) | null)?.();
  expect(request).toHaveBeenCalledTimes(6);

  setTimeoutSpy.mockRestore();
  visibility.mockReturnValue("visible");
  window.dispatchEvent(new Event("focus"));
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(8));
});
