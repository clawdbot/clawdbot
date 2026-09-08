import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { nothing } from "lit";
import { expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { UsageDetailsController } from "./detail-controller.ts";
import { page as usageRoute } from "./route.ts";
import type { UsageRouteData } from "./usage-page.ts";
import "./usage-page.ts";

export type TestUsagePage = HTMLElement & {
  context: ApplicationContext;
  routeData: UsageRouteData;
  usageError: string | null;
  usageSelectedSessions: string[];
  details: UsageDetailsController;
  providerUsageStalled: boolean;
  providerUsageSummary: { updatedAt: number; providers: unknown[] } | null;
  providerUsageUnavailable: boolean;
  loadUsage: () => Promise<void>;
  requestUpdate: () => void;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function contextWithClient(client: GatewayBrowserClient): ApplicationContext & {
  setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
} {
  const subscribe = () => () => undefined;
  let snapshot = {
    client,
    phase: "connected",
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  return {
    setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    basePath: "",
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
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
  } as unknown as ReturnType<typeof contextWithClient>;
}

export async function createPage(
  client: GatewayBrowserClient,
  renderView = false,
  context: ApplicationContext = contextWithClient(client),
): Promise<TestUsagePage> {
  const page = document.createElement("openclaw-usage-page") as TestUsagePage;
  page.context = context;
  if (!renderView) {
    page.render = () => nothing;
  }
  document.body.append(page);
  await page.updateComplete;
  return page;
}

export function focusDocument(): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
}

export function cleanupUsagePageTest(): void {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
}

export function cacheSnapshot(
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

export async function preloadUsage(page: TestUsagePage): Promise<void> {
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

export function refreshButton(page: TestUsagePage): HTMLButtonElement {
  const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === "Refresh",
  );
  expect(button).toBeDefined();
  return button!;
}
