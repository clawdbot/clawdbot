/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n, t } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { ProfilePage } from "./profile-page.ts";

const PROFILE_PAGE_TEST_TAG = "test-openclaw-profile-page";
// Keep the element class on the same post-reset i18n module as this test.
if (!customElements.get(PROFILE_PAGE_TEST_TAG)) {
  customElements.define(PROFILE_PAGE_TEST_TAG, class extends ProfilePage {});
}

type ProfilePageElement = HTMLElement & {
  updateComplete: Promise<boolean>;
};

type ProfilePageLifecycle = HTMLElement & {
  context: ApplicationContext<RouteId>;
  client: GatewayBrowserClient | null;
  connected: boolean;
  costSummary: CostUsageSummary | null;
  sessionsResult: SessionsUsageResult | null;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
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

it("keeps settled profile usage across a same-client reconnect", async () => {
  const request = vi.fn();
  const client = { request } as unknown as GatewayBrowserClient;
  const context = createContext(client, true);
  const page = new ProfilePage() as unknown as ProfilePageLifecycle;
  page.context = context;
  page.client = client;
  page.connected = true;
  page.costSummary = createCostSummary();
  page.sessionsResult = createSessionsResult();

  page.applyGatewaySnapshot({ ...context.gateway.snapshot, connected: false });
  page.applyGatewaySnapshot(context.gateway.snapshot);
  await Promise.resolve();

  expect(request).not.toHaveBeenCalled();
});

it("resumes a settling profile cache after a same-client reconnect", async () => {
  const request = vi.fn(async (method: string) =>
    method === "sessions.usage" ? { sessions: [] } : createCostSummary(),
  );
  const client = { request } as unknown as GatewayBrowserClient;
  const context = createContext(client, true);
  const page = new ProfilePage() as unknown as ProfilePageLifecycle;
  page.context = context;
  page.client = client;
  page.connected = true;
  page.costSummary = createCostSummary({
    status: "refreshing",
    cachedFiles: 0,
    pendingFiles: 1,
    staleFiles: 0,
  });
  page.sessionsResult = createSessionsResult();

  page.applyGatewaySnapshot({ ...context.gateway.snapshot, connected: false });
  page.applyGatewaySnapshot(context.gateway.snapshot);

  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("usage.cost", expect.any(Object)));
});
