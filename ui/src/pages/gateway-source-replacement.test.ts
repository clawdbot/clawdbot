/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { SessionsRouteData } from "./sessions/sessions-page.ts";
import type { SkillsRouteData } from "./skills/skills-page.ts";
import { USAGE_PAYLOAD_TTL_MS, type UsageRefreshReason } from "./usage/refresh-policy.ts";
import type { UsageRouteData } from "./usage/usage-page.ts";
import "./cron/cron-page.ts";
import "./debug/debug-page.ts";
import "./logs/logs-page.ts";
import "./sessions/sessions-page.ts";
import "./skills/skills-page.ts";
import "./tasks/tasks-page.ts";
import "./usage/usage-page.ts";

type TestPage = HTMLElement & {
  context: ApplicationContext;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function gatewayWithClient(
  client: GatewayBrowserClient,
  connected: boolean,
): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected,
    offlineStable: false,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    eventLog: [],
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
}

function contextWithClient(
  client: GatewayBrowserClient,
  options: {
    connected?: boolean;
    agentsList?: unknown;
    ensureList?: () => Promise<unknown>;
  } = {},
): ApplicationContext {
  const subscribe = () => () => undefined;
  const agentsList = options.agentsList ?? null;
  return {
    basePath: "",
    gateway: gatewayWithClient(client, options.connected ?? false),
    agents: {
      state: { agentsList, agentsLoading: false, agentsError: null },
      ensureList: options.ensureList ?? vi.fn(async () => agentsList),
      subscribe,
    },
    agentIdentity: { get: () => undefined, ensure: vi.fn(async () => undefined), subscribe },
    agentSelection: {
      state: { selectedId: null, scopeId: null },
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe,
    },
    channels: { subscribe },
    runtimeConfig: { state: { configSnapshot: null }, subscribe },
    sessions: {
      state: { result: null, loading: false },
      list: vi.fn(async () => null),
      subscribe,
    },
    workboard: { subscribe },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

function contextWithMutableGateway(client: GatewayBrowserClient) {
  const context = contextWithClient(client, { connected: true });
  let currentSnapshot = context.gateway.snapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    ...context.gateway,
    get snapshot() {
      return currentSnapshot;
    },
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as ApplicationContext["gateway"];
  Object.defineProperty(context, "gateway", { value: gateway });
  return {
    context,
    emitConnected(connected: boolean) {
      currentSnapshot = { ...currentSnapshot, connected };
      for (const listener of listeners) {
        listener(currentSnapshot);
      }
    },
  };
}

function createPage(tagName: string, context: ApplicationContext): TestPage {
  const page = document.createElement(tagName) as TestPage;
  page.context = context;
  page.render = () => nothing;
  return page;
}

async function replaceContext(
  page: TestPage,
  replacementClient: GatewayBrowserClient,
  options: { connected?: boolean; agentsList?: unknown } = {},
): Promise<void> {
  page.remove();
  page.context = contextWithClient(replacementClient, options);
  document.body.append(page);
  await page.updateComplete;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("gateway source replacement across reconnect with a reused client", () => {
  it("preserves matching sessions route data on the first bind", async () => {
    const client = {} as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      result: { count: 1, sessions: [{ key: "old" }] },
      error: null,
      expandedSessionKey: null,
      statusFilter: "active",
    } as unknown as SessionsRouteData;
    const page = createPage("openclaw-sessions-page", context) as TestPage & {
      routeData: SessionsRouteData;
      result: SessionsRouteData["result"];
    };
    page.routeData = routeData;

    document.body.append(page);
    await page.updateComplete;

    expect(page.result?.sessions.map((session) => session.key)).toEqual(["old"]);
    expect(context.sessions.list).not.toHaveBeenCalled();
  });

  it("preserves matching usage route data on the first bind", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const result = { sessions: [{ key: "old" }] } as unknown as UsageRouteData["result"];
    const routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      query: {
        startDate: "2026-07-08",
        endDate: "2026-07-08",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result,
      costSummary: null,
      providerUsageSummary: null,
      loadedAtMs: Date.now(),
      error: null,
    } satisfies UsageRouteData;
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      usageResult: UsageRouteData["result"];
    };
    page.routeData = routeData;

    document.body.append(page);
    await page.updateComplete;

    expect(page.usageResult).toBe(result);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects usage route data from an earlier same-client gateway epoch", async () => {
    const freshResult = { sessions: [{ key: "fresh" }] } as unknown as UsageRouteData["result"];
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return freshResult;
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const staleResult = { sessions: [{ key: "stale" }] } as unknown as UsageRouteData["result"];
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      usageResult: UsageRouteData["result"];
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      query: {
        startDate: "2026-07-08",
        endDate: "2026-07-08",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result: staleResult,
      costSummary: null,
      providerUsageSummary: null,
      loadedAtMs: Date.now(),
      error: null,
    };

    document.body.append(page);
    await page.updateComplete;
    await waitForFast(() => expect(page.usageResult).toBe(freshResult));

    expect(request).toHaveBeenCalledWith("sessions.usage", expect.any(Object));
    expect(page.usageResult).not.toBe(staleResult);
  });

  it("keeps loaded usage data across a same-client reconnect", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const result = { sessions: [{ key: "cached" }] } as unknown as UsageRouteData["result"];
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      refreshRuntime: {
        applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
      };
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      query: {
        startDate: "2026-07-08",
        endDate: "2026-07-08",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result,
      costSummary: null,
      providerUsageSummary: null,
      loadedAtMs: Date.now(),
      error: null,
    };

    document.body.append(page);
    await page.updateComplete;
    page.refreshRuntime.applyGatewaySnapshot({
      ...context.gateway.snapshot,
      connected: false,
    });
    page.refreshRuntime.applyGatewaySnapshot(context.gateway.snapshot);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });

  it("retries a usage load interrupted by a same-client disconnect", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const request = vi.fn(async (method: string) =>
      method === "sessions.usage" ? { sessions: [] } : {},
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      usageLoading: boolean;
      refreshRuntime: {
        applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
      };
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      query: {
        startDate: "2026-07-08",
        endDate: "2026-07-08",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result: { sessions: [{ key: "cached" }] } as unknown as UsageRouteData["result"],
      costSummary: null,
      providerUsageSummary: null,
      loadedAtMs: Date.now(),
      error: null,
    };

    document.body.append(page);
    await page.updateComplete;
    page.usageLoading = true;
    page.refreshRuntime.applyGatewaySnapshot({
      ...context.gateway.snapshot,
      connected: false,
    });
    page.refreshRuntime.applyGatewaySnapshot(context.gateway.snapshot);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.usage", expect.any(Object)),
    );
  });

  it("gates same-client usage reconnects by payload age and page visibility", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return { sessions: [] };
      }
      if (method === "usage.status") {
        return { providers: [] };
      }
      return { daily: [] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = contextWithMutableGateway(client);
    const result = { sessions: [] } as unknown as UsageRouteData["result"];
    const page = createPage("openclaw-usage-page", harness.context) as TestPage & {
      routeData: UsageRouteData;
      usageLoading: boolean;
      refreshRuntime: {
        request: (reason: UsageRefreshReason) => void;
        setLastLoadedAtMs: (value: number | null) => void;
      };
    };
    page.routeData = {
      gateway: harness.context.gateway,
      gatewaySnapshot: harness.context.gateway.snapshot,
      query: {
        startDate: "2026-07-08",
        endDate: "2026-07-08",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result,
      costSummary: null,
      providerUsageSummary: null,
      loadedAtMs: Date.now(),
      error: null,
    };

    document.body.append(page);
    await page.updateComplete;

    harness.emitConnected(false);
    harness.emitConnected(true);
    expect(request).not.toHaveBeenCalled();

    page.refreshRuntime.setLastLoadedAtMs(Date.now() - USAGE_PAYLOAD_TTL_MS);
    visibility.mockReturnValue("hidden");
    harness.emitConnected(false);
    harness.emitConnected(true);
    expect(request).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await waitForFast(() => expect(page.usageLoading).toBe(false));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.usage",
      "usage.cost",
      "usage.status",
    ]);

    page.usageLoading = true;
    page.refreshRuntime.request("manual");
    await waitForFast(() => expect(page.usageLoading).toBe(false));
    expect(request).toHaveBeenCalledTimes(6);

    const failedRefresh = deferred<never>();
    request.mockImplementationOnce(() => failedRefresh.promise);
    page.refreshRuntime.setLastLoadedAtMs(Date.now() - USAGE_PAYLOAD_TTL_MS);
    page.refreshRuntime.request("manual");
    expect(request).toHaveBeenCalledTimes(9);
    page.refreshRuntime.request("focus");
    failedRefresh.reject(new Error("connection interrupted"));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(12));
    await waitForFast(() => expect(page.usageLoading).toBe(false));
  });
  it("preserves matching skills route data on the first bind", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const context = contextWithClient(client, { connected: true, agentsList });
    const report = { skills: [{ skillKey: "old" }] } as unknown as SkillsRouteData["report"];
    const routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      agents: context.agents,
      agentsList,
      selectedAgentId: "main",
      report,
      error: null,
    } as unknown as SkillsRouteData;
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      routeData: SkillsRouteData;
      skillsReport: SkillsRouteData["report"];
    };
    page.routeData = routeData;

    document.body.append(page);
    await page.updateComplete;

    expect(page.skillsReport).toBe(report);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects skills route data from an earlier same-client gateway epoch", async () => {
    const freshReport = { skills: [{ skillKey: "fresh" }] } as unknown as SkillsRouteData["report"];
    const request = vi.fn(async (method: string) =>
      method === "skills.status" ? freshReport : undefined,
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const context = contextWithClient(client, { connected: true, agentsList });
    const staleReport = { skills: [{ skillKey: "stale" }] } as unknown as SkillsRouteData["report"];
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      routeData: SkillsRouteData;
      skillsReport: SkillsRouteData["report"];
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      agents: context.agents,
      agentsList,
      selectedAgentId: "main",
      report: staleReport,
      error: null,
    } as unknown as SkillsRouteData;

    document.body.append(page);
    await page.updateComplete;
    await waitForFast(() => expect(page.skillsReport).toBe(freshReport));

    expect(page.skillsReport).not.toBe(staleReport);
  });

  it("clears sessions loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-sessions-page", contextWithClient(client)) as TestPage & {
      result: unknown;
      selectedKeys: Set<string>;
      checkpointItemsByKey: Record<string, unknown>;
    };
    document.body.append(page);
    await page.updateComplete;
    page.result = { sessions: [{ key: "old" }] };
    page.selectedKeys = new Set(["old"]);
    page.checkpointItemsByKey = { old: [{}] };

    await replaceContext(page, client);

    expect(page.result).toBeNull();
    expect(page.selectedKeys.size).toBe(0);
    expect(page.checkpointItemsByKey).toEqual({});
  });

  it("clears usage loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-usage-page", contextWithClient(client)) as TestPage & {
      usageResult: unknown;
      providerUsageSummary: unknown;
      usageSelectedSessions: string[];
    };
    document.body.append(page);
    await page.updateComplete;
    page.usageResult = { sessions: [{ key: "old" }] };
    page.providerUsageSummary = { providers: [{ provider: "old" }] };
    page.usageSelectedSessions = ["old"];

    await replaceContext(page, client);

    expect(page.usageResult).toBeNull();
    expect(page.providerUsageSummary).toBeNull();
    expect(page.usageSelectedSessions).toEqual([]);
  });

  it("clears skills loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-skills-page", contextWithClient(client)) as TestPage & {
      agentsList: unknown;
      skillsReport: unknown;
      skillCardContents: Record<string, string>;
    };
    document.body.append(page);
    await page.updateComplete;
    page.agentsList = { agents: [{ id: "old" }] };
    page.skillsReport = { skills: [{ key: "old" }] };
    page.skillCardContents = { old: "stale" };

    await replaceContext(page, client);

    expect(page.agentsList).toBeNull();
    expect(page.skillsReport).toBeNull();
    expect(page.skillCardContents).toEqual({});
  });

  it("discards an agent list from a replaced skills source that reuses its client", async () => {
    const pending = deferred<SkillsRouteData["agentsList"]>();
    const ensureList = vi.fn(() => pending.promise);
    const request = vi.fn(async () => ({ skills: [] }));
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { ensureList });
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      agentsList: SkillsRouteData["agentsList"];
      connected: boolean;
      loadAgents: () => Promise<void>;
    };
    document.body.append(page);
    await page.updateComplete;
    (context.gateway.snapshot as ApplicationGatewaySnapshot).connected = true;
    page.connected = true;

    const load = page.loadAgents();
    await waitForFast(() => expect(ensureList).toHaveBeenCalledOnce());
    const replacementAgents = {
      defaultId: "fresh",
      mainKey: "agent:fresh:main",
      scope: "all",
      agents: [{ id: "fresh" }],
    } as unknown as NonNullable<SkillsRouteData["agentsList"]>;
    await replaceContext(page, client, { connected: true, agentsList: replacementAgents });

    pending.resolve({
      defaultId: "stale",
      mainKey: "agent:stale:main",
      scope: "all",
      agents: [{ id: "stale" }],
    } as unknown as NonNullable<SkillsRouteData["agentsList"]>);
    await load;

    expect(page.agentsList).toBe(replacementAgents);
  });

  it("clears logs loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-logs-page", contextWithClient(client)) as TestPage & {
      logsEntries: unknown[];
      logsFile: string | null;
      logsCursor: number | null;
    };
    document.body.append(page);
    await page.updateComplete;
    page.logsEntries = [{ raw: "old" }];
    page.logsFile = "/old/provider.log";
    page.logsCursor = 42;

    await replaceContext(page, client);

    expect(page.logsEntries).toEqual([]);
    expect(page.logsFile).toBeNull();
    expect(page.logsCursor).toBeNull();
  });

  it("clears diagnostics loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-debug-page", contextWithClient(client)) as TestPage & {
      debugStatus: unknown;
      debugHealth: unknown;
      debugModels: unknown[];
      debugHeartbeat: unknown;
    };
    document.body.append(page);
    await page.updateComplete;
    page.debugStatus = { version: "old" };
    page.debugHealth = { ok: true };
    page.debugModels = [{ id: "old" }];
    page.debugHeartbeat = { provider: "old" };

    await replaceContext(page, client);

    expect(page.debugStatus).toBeNull();
    expect(page.debugHealth).toBeNull();
    expect(page.debugModels).toEqual([]);
    expect(page.debugHeartbeat).toBeNull();
  });

  it("discards diagnostics from a replaced provider that reuses its client", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client);
    const page = createPage("openclaw-debug-page", context) as TestPage & {
      connected: boolean;
      debugLoading: boolean;
      debugStatus: unknown;
      loadDiagnostics: () => Promise<void>;
    };
    document.body.append(page);
    await page.updateComplete;
    (context.gateway.snapshot as ApplicationGatewaySnapshot).connected = true;
    page.connected = true;

    const load = page.loadDiagnostics();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    await replaceContext(page, client);
    pending.resolve({ models: [{ id: "stale" }], stale: true });
    await load;

    expect(page.debugLoading).toBe(false);
    expect(page.debugStatus).toBeNull();
  });

  it("clears cron data loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-cron-page", contextWithClient(client)) as TestPage & {
      cron: {
        client: GatewayBrowserClient | null;
        connected: boolean;
        cronStatus: unknown;
        cronJobs: unknown[];
      };
    };
    document.body.append(page);
    await page.updateComplete;
    page.cron = {
      ...page.cron,
      cronStatus: { enabled: true },
      cronJobs: [{ id: "old" }],
    };

    await replaceContext(page, client);

    expect(page.cron.cronStatus).toBeNull();
    expect(page.cron.cronJobs).toEqual([]);
  });

  it("clears tasks loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-tasks-page", contextWithClient(client)) as TestPage & {
      tasks: unknown[];
      error: string | null;
      cancellingTaskIds: Set<string>;
    };
    document.body.append(page);
    await page.updateComplete;
    page.tasks = [{ taskId: "old" }];
    page.error = "old error";
    page.cancellingTaskIds = new Set(["old"]);

    await replaceContext(page, client);

    expect(page.tasks).toEqual([]);
    expect(page.error).toBeNull();
    expect(page.cancellingTaskIds.size).toBe(0);
  });
});
