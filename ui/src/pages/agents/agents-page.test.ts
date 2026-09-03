/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesListResult,
  AgentsListResult,
  CronJob,
  CronJobsListResult,
  ModelCatalogEntry,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "../../lib/agents/index.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-store.ts";
import { loadCronJobsPage, type CronState } from "../../lib/cron/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { AgentsRouteData } from "./route.ts";
import "./agents-page.ts";

const AGENTS_PAGE_GATEWAY_HELLO = gatewayHelloForMethods(["config.patch", "config.set"]);

type TestAgentsPage = HTMLElement & {
  context: ApplicationContext;
  readonly client: GatewayBrowserClient | null;
  readonly connected: boolean;
  agentsList: unknown;
  agentsSelectedId: string | null;
  routeData?: AgentsRouteData;
  agentFilesLoading: boolean;
  agentFilesList: AgentsFilesListResult | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentIdentityLoading: boolean;
  agentSkillsError: string | null;
  readonly agentsPanel: AgentsPanel;
  readonly sessions: ApplicationContext["sessions"];
  toolsEffectiveError: string | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelCatalogError: string | null;
  chatModelCatalogRequest: unknown;
  cron: CronState;
  requestGeneration: number;
  routeDataInitialized: boolean;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
  gateway: {
    applySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      binding: { initial: boolean; sourceChanged: boolean },
    ) => void;
    invalidate: () => void;
  };
  ensureAgentIdentities: () => void;
  loadActivePanelData: () => void;
  ensureModelCatalog: (options?: { refresh?: boolean }) => void;
  refreshCron: () => Promise<void>;
  requestUpdate: () => void;
  runCronTask: <T>(task: (cronState: CronState) => Promise<T>) => Promise<T>;
  loadEffectiveToolsForAgent: (agentId: string) => void;
  loadAgentFiles: (agentId: string, force?: boolean) => Promise<void>;
  clearAgentSkills: (agentId: string) => void;
  saveAgentConfig: () => void;
  setDefaultAgent: (agentId: string) => void;
};

function setPageGateway(
  page: TestAgentsPage,
  client: GatewayBrowserClient | null,
  connected = true,
  sourceChanged = false,
) {
  page.gateway.applySnapshot(snapshot(client, connected), { initial: false, sourceChanged });
}

const mainModelsList = { view: "configured", agentId: "main" };
const workerModelsList = { view: "configured", agentId: "worker" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function snapshot(
  client: GatewayBrowserClient | null,
  connected = true,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: AGENTS_PAGE_GATEWAY_HELLO,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function gateway(current: ApplicationGatewaySnapshot): ApplicationContext["gateway"] {
  return {
    snapshot: current,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

const files = (agentId: string, workspace: string) => ({ agentId, workspace, files: [] });

function cronJob(id: string, agentId?: string): CronJob {
  return {
    id,
    ...(agentId ? { agentId } : {}),
    name: `Scheduled job ${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
  } as CronJob;
}

function cronListResponse(
  jobs: CronJob[],
  options: { total?: number; offset?: number; limit?: number } = {},
): CronJobsListResult {
  const total = options.total ?? jobs.length;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const nextOffset = offset + jobs.length;
  const hasMore = nextOffset < total;
  return {
    jobs,
    snapshotRevision: "agents-page-cron-fixture",
    total,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };
}

const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main", name: "Main" }],
};

function agentsRouteData(
  currentGateway: ApplicationContext["gateway"],
  roster: AgentsListResult | null = agentsList,
  requestedAgentId: string | null = "main",
): AgentsRouteData {
  const pathname = requestedAgentId ? `/settings/agents/${requestedAgentId}` : "/settings/agents";
  return {
    gateway: currentGateway,
    gatewaySnapshot: currentGateway.snapshot,
    location: { pathname, search: "", hash: "" },
    requestedAgentId,
    panel: "files",
    agentsList: roster,
    error: null,
  };
}

function agentsCapability(ensureFiles: () => Promise<AgentsFilesListResult>) {
  return {
    state: {
      client: null,
      connected: true,
      agentsLoading: false,
      agentsError: null,
      agentsList,
    },
    files: () => ({ list: null, loading: false, error: null }),
    ensureList: vi.fn(async () => agentsList),
    refreshList: vi.fn(async () => agentsList),
    ensureFiles,
    refreshFiles: ensureFiles,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["agents"];
}

function pageContext(
  currentGateway: ApplicationContext["gateway"],
  agents: ApplicationContext["agents"],
  options?: {
    agentIdentity?: ApplicationContext["agentIdentity"];
    sessions?: ApplicationContext["sessions"];
  },
): ApplicationContext {
  const subscribe = vi.fn(() => () => undefined);
  return {
    gateway: currentGateway,
    agents,
    agentIdentity:
      options?.agentIdentity ??
      ({
        get: () => ({ agentId: "main" }),
        entries: () => [],
        ensure: vi.fn(async () => undefined),
        subscribe,
      } as unknown as ApplicationContext["agentIdentity"]),
    sessions:
      options?.sessions ??
      ({
        state: { result: null, modelOverrides: {} },
        subscribe,
      } as unknown as ApplicationContext["sessions"]),
    channels: { subscribe },
    runtimeConfig: { subscribe },
  } as unknown as ApplicationContext;
}

describe("AgentsPage gateway lifecycle", () => {
  it("retires visible-session effective tools across a same-client reconnect", async () => {
    const staleResult = deferred<ToolsEffectiveResult>();
    const client = { request: vi.fn(() => staleResult.promise) } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = pageContext(
      gateway(snapshot(client)),
      agentsCapability(async () => files("main", "unused")),
    );
    page.routeData = { panel: "tools" } as AgentsRouteData;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";

    const pending = refreshVisibleToolsEffectiveForCurrentSession(page);
    expect(page.toolsEffectiveLoading).toBe(true);
    setPageGateway(page, client, false);
    setPageGateway(page, client);
    staleResult.resolve({ profile: "retired-connection" } as ToolsEffectiveResult);
    await pending;

    expect(page.toolsEffectiveResult).toBeNull();
    expect(page.toolsEffectiveError).toBeNull();
    expect(page.toolsEffectiveLoading).toBe(false);
  });

  it("does not stage a default-agent change after a same-client reconnect", async () => {
    const loading = deferred<void>();
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const stageDefaultAgent = vi.fn(() => true);
    const save = vi.fn(async () => true);
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const context = pageContext(currentGateway, agents);
    page.context = {
      ...context,
      runtimeConfig: {
        state: { configFormDirty: false },
        ensureLoaded: vi.fn(() => loading.promise),
        stageDefaultAgent,
        save,
        subscribe: vi.fn(() => () => undefined),
      },
    } as unknown as ApplicationContext;
    setPageGateway(page, client);

    page.setDefaultAgent("research");
    setPageGateway(page, client, false);
    setPageGateway(page, client);
    loading.resolve();
    await loading.promise;
    await Promise.resolve();

    expect(stageDefaultAgent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("invalidates a queued agent skills clear across a same-client reconnect", async () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const patch = vi.fn(
      async (_options: Parameters<ApplicationContext["runtimeConfig"]["patch"]>[0]) => false,
    );
    const runtimeConfig = {
      state: {},
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "main"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["runtimeConfig"];
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = { ...pageContext(currentGateway, agents), runtimeConfig };
    setPageGateway(page, client);
    page.agentsSelectedId = "main";

    page.clearAgentSkills("main");
    await waitForFast(() => expect(patch).toHaveBeenCalledOnce());
    const canDispatch = vi.mocked(patch).mock.calls[0]?.[0]?.canDispatch;
    expect(canDispatch?.()).toBe(true);

    setPageGateway(page, client, false);
    setPageGateway(page, client);

    expect(canDispatch?.()).toBe(false);
  });

  it("surfaces a rejected agent skills clear in the panel", async () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const runtimeConfig = {
      state: { lastError: "Gateway rejected the patch." },
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "main"],
        entry: { skills: ["coding-agent"] },
      })),
      patch: vi.fn(async () => false),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["runtimeConfig"];
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = { ...pageContext(currentGateway, agents), runtimeConfig };
    setPageGateway(page, client);
    page.agentsSelectedId = "main";

    page.clearAgentSkills("main");

    await waitForFast(() => expect(page.agentSkillsError).toBe("Gateway rejected the patch."));
  });

  it("does not refresh the agent roster after a rejected config save", async () => {
    const client = {} as GatewayBrowserClient;
    const refreshList = vi.fn(async () => agentsList);
    const save = vi.fn(async () => false);
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    setPageGateway(page, client, false);
    page.agentsSelectedId = "main";
    page.context = {
      gateway: gateway(snapshot(client)),
      agents: {
        state: { agentsLoading: false, agentsError: null, agentsList },
        refreshList,
      },
      runtimeConfig: { save },
    } as unknown as ApplicationContext;

    page.saveAgentConfig();
    await waitForFast(() => expect(save).toHaveBeenCalledOnce());
    expect(refreshList).not.toHaveBeenCalled();
  });

  it("loads the selected agent's configured model catalog once for the overview model picker", async () => {
    const models = [
      {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        alias: "opus",
        provider: "anthropic",
      },
    ];
    const request = vi.fn(async () => ({ models }));
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, { request } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    page.loadActivePanelData();

    await waitForFast(() => expect(page.chatModelCatalog).toEqual(models));
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("models.list", mainModelsList);
  });

  it("re-reads the configured model catalog for each selected agent", async () => {
    const defaultModels = [{ id: "default-model", name: "Default model", provider: "openai" }];
    const workerModels = [{ id: "worker-model", name: "Worker model", provider: "anthropic" }];
    const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
      models: params?.agentId === "worker" ? workerModels : defaultModels,
    }));
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, { request } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(defaultModels));

    page.agentsSelectedId = "worker";
    page.loadActivePanelData();
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(workerModels));

    page.agentsSelectedId = "main";
    page.loadActivePanelData();
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(defaultModels));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(1, "models.list", mainModelsList);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", workerModelsList);
    expect(request).toHaveBeenNthCalledWith(3, "models.list", mainModelsList);
  });

  it("rejects a stale default-agent catalog after switching to a worker agent", async () => {
    const defaultModels = [{ id: "default-model", name: "Default model", provider: "openai" }];
    const workerModels = [{ id: "worker-model", name: "Worker model", provider: "anthropic" }];
    const defaultResult = deferred<{ models: ModelCatalogEntry[] }>();
    const request = vi.fn((_method: string, params?: { agentId?: string }) =>
      params?.agentId === "worker"
        ? Promise.resolve({ models: workerModels })
        : defaultResult.promise,
    );
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, { request } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    page.agentsSelectedId = "worker";
    page.loadActivePanelData();

    await waitForFast(() => expect(page.chatModelCatalog).toEqual(workerModels));
    defaultResult.resolve({ models: defaultModels });
    await defaultResult.promise;
    await Promise.resolve();

    expect(page.chatModelCatalog).toEqual(workerModels);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", workerModelsList);
  });

  it("reads the model catalog when the picker opens and refreshes on retry", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const refreshedModels = [
      { id: "refreshed", name: "Opus 4.9", alias: "opus", provider: "anthropic" },
    ];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: oldModels })
      .mockResolvedValueOnce({ models: nextModels })
      .mockResolvedValueOnce({ models: refreshedModels });
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, { request } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(oldModels));

    page.ensureModelCatalog();
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(nextModels));
    expect(request).toHaveBeenNthCalledWith(2, "models.list", mainModelsList);

    page.ensureModelCatalog({ refresh: true });
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(refreshedModels));
    expect(request.mock.calls[2]?.[1]).toMatchObject({ refresh: true });
  });

  it("rejects an old-client model catalog after the Gateway client changes", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const oldResult = deferred<{ models: ModelCatalogEntry[] }>();
    const oldRequest = vi.fn(() => oldResult.promise);
    const nextRequest = vi.fn(async () => ({ models: nextModels }));
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, { request: oldRequest } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    page.gateway.invalidate();
    setPageGateway(page, { request: nextRequest } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";
    page.loadActivePanelData();

    await waitForFast(() => expect(page.chatModelCatalog).toEqual(nextModels));
    oldResult.resolve({ models: oldModels });
    await oldResult.promise;
    await Promise.resolve();

    expect(page.chatModelCatalog).toEqual(nextModels);
    expect(oldRequest).toHaveBeenCalledOnce();
    expect(nextRequest).toHaveBeenCalledOnce();
  });

  it("refreshes a stale in-flight model catalog after a same-client reconnect", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const oldResult = deferred<{ models: ModelCatalogEntry[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockResolvedValueOnce({ models: nextModels });
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, { request } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    page.gateway.invalidate();
    invalidateChatMetadataStore(page.client as GatewayBrowserClient);
    page.loadActivePanelData();

    await waitForFast(() => expect(page.chatModelCatalog).toEqual(nextModels));
    oldResult.resolve({ models: oldModels });
    await oldResult.promise;
    await Promise.resolve();

    expect(page.chatModelCatalog).toEqual(nextModels);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", mainModelsList);
  });

  it("refreshes a settled model catalog after a same-client reconnect", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: oldModels })
      .mockResolvedValueOnce({ models: nextModels });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(oldModels));

    setPageGateway(page, client, false);
    expect(page.chatModelCatalog).toEqual([]);
    invalidateChatMetadataStore(client);
    setPageGateway(page, client);
    page.loadActivePanelData();

    await waitForFast(() => expect(page.chatModelCatalog).toEqual(nextModels));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", mainModelsList);
  });

  it("surfaces a rejected agent-scoped metadata RPC and retries without marking an empty catalog loaded", async () => {
    const models = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("model catalog unavailable"))
      .mockResolvedValueOnce({ models });
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "overview" } as AgentsRouteData;
    setPageGateway(page, { request } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";

    page.loadActivePanelData();
    await waitForFast(() => {
      expect(page.chatModelCatalogError).toBe("model catalog unavailable");
      expect(page.chatModelCatalogRequest).toBeNull();
    });
    expect(page.chatModelCatalog).toEqual([]);

    page.loadActivePanelData();
    await waitForFast(() => expect(page.chatModelCatalog).toEqual(models));

    expect(page.chatModelCatalogError).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", mainModelsList);
  });

  it("requests the selected agent's implicit default cron job before the first 50 unrelated jobs", async () => {
    const unrelatedJobs = Array.from({ length: 50 }, (_, index) =>
      cronJob(`other-${index}`, "other"),
    );
    const globalNextWakeAtMs = Date.now() + 60_000;
    const scopedNextWakeAtMs = globalNextWakeAtMs + 3_600_000;
    const implicitDefaultJob = {
      ...cronJob("default-job"),
      state: { nextRunAtMs: scopedNextWakeAtMs },
    };
    const request = vi.fn(async (method: string, params?: { agentId?: string; limit?: number }) => {
      if (method === "cron.status") {
        return { enabled: true, jobs: 51, nextWakeAtMs: globalNextWakeAtMs };
      }
      if (method === "cron.list") {
        const scoped = params?.agentId === "main";
        return cronListResponse(scoped ? [implicitDefaultJob] : unrelatedJobs, {
          total: scoped ? 1 : 51,
          limit: params?.limit,
        });
      }
      throw new Error(`Unexpected gateway method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "cron" } as AgentsRouteData;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";
    page.cron = { ...page.cron, client, connected: true };

    page.loadActivePanelData();

    await waitForFast(() => {
      expect(page.cron.cronJobs).toEqual([implicitDefaultJob]);
      expect(page.cron.cronScopedTotal).toBe(1);
      expect(page.cron.cronScopedNextWakeAtMs).toBe(scopedNextWakeAtMs);
    });
    expect(page.cron.cronStatus).toEqual({
      enabled: true,
      jobs: 51,
      nextWakeAtMs: globalNextWakeAtMs,
    });
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "main", limit: 50, offset: 0 }),
    );
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "main", limit: 1, enabled: "enabled" }),
    );
  });

  it("loads the selected agent's remaining cron jobs after preserving the first-page total", async () => {
    const jobs = Array.from({ length: 50 }, (_, index) => cronJob(`main-${index}`, "main"));
    const lastJob = cronJob("main-50", "main");
    const request = vi.fn(
      async (method: string, params?: { agentId?: string; limit?: number; offset?: number }) => {
        if (method === "cron.status") {
          return { enabled: true, jobs: 80, nextWakeAtMs: null };
        }
        if (params?.limit === 1) {
          return cronListResponse([jobs[0]!], { total: 51, limit: 1 });
        }
        if (params?.offset === 50) {
          return cronListResponse([lastJob], { total: 51, offset: 50 });
        }
        return cronListResponse(jobs, { total: 51 });
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "cron" } as AgentsRouteData;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";
    page.cron = { ...page.cron, client, connected: true };

    page.loadActivePanelData();

    await waitForFast(() => {
      expect(page.cron.cronJobs).toHaveLength(50);
      expect(page.cron.cronJobsTotal).toBe(51);
      expect(page.cron.cronScopedTotal).toBe(51);
    });
    expect(page.cron.cronJobsHasMore).toBe(true);

    await page.runCronTask((cronState) =>
      loadCronJobsPage(cronState, { append: true, tableFilters: true }),
    );

    expect(page.cron.cronJobs).toHaveLength(51);
    expect(page.cron.cronJobs.at(-1)).toEqual(lastJob);
    expect(page.cron.cronJobsTotal).toBe(51);
    expect(page.cron.cronScopedTotal).toBe(51);
    expect(page.cron.cronJobsHasMore).toBe(false);
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "main", limit: 50, offset: 50 }),
    );
  });

  it("reloads cron jobs when the selected agent changes", async () => {
    const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
      if (method === "cron.status") {
        return { enabled: true, jobs: 2, nextWakeAtMs: null };
      }
      return cronListResponse([cronJob(`${params?.agentId}-job`, params?.agentId)]);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "cron" } as AgentsRouteData;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";
    page.cron = { ...page.cron, client, connected: true };

    page.loadActivePanelData();
    await waitForFast(() => expect(page.cron.cronJobs[0]?.id).toBe("main-job"));

    page.agentsSelectedId = "other";
    page.loadActivePanelData();
    expect(page.cron.cronJobs).toEqual([]);

    await waitForFast(() => expect(page.cron.cronJobs[0]?.id).toBe("other-job"));
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "other" }),
    );
  });

  it("keeps an in-flight scoped cron request attached to a same-client gateway snapshot", async () => {
    const job = cronJob("same-client-job", "main");
    const pendingJobs = deferred<CronJobsListResult>();
    const request = vi.fn((method: string, params?: { limit?: number }) => {
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, jobs: 1, nextWakeAtMs: null });
      }
      if (params?.limit === 50) {
        return pendingJobs.promise;
      }
      return Promise.resolve(cronListResponse([job]));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = { panel: "cron" } as AgentsRouteData;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";
    page.cron = { ...page.cron, client, connected: true };

    page.loadActivePanelData();
    await waitForFast(() => expect(page.cron.cronLoading).toBe(true));
    const inFlightState = page.cron;

    setPageGateway(page, client);
    expect(page.cron).toBe(inFlightState);

    pendingJobs.resolve(cronListResponse([job]));
    await waitForFast(() => {
      expect(page.cron.cronJobs).toEqual([job]);
      expect(page.cron.cronLoading).toBe(false);
    });
  });

  it("immediately publishes cron loading and ignores a second refresh while the first is pending", async () => {
    const job = cronJob("double-refresh-job", "main");
    const pendingJobs = deferred<CronJobsListResult>();
    const request = vi.fn((method: string, params?: { limit?: number }) => {
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, jobs: 1, nextWakeAtMs: null });
      }
      if (params?.limit === 50) {
        return pendingJobs.promise;
      }
      return Promise.resolve(cronListResponse([job]));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    setPageGateway(page, client);
    page.cron = { ...page.cron, client, connected: true, cronAgentId: "main" };
    const requestUpdate = vi.spyOn(page, "requestUpdate");

    const firstRefresh = page.refreshCron();
    expect(page.cron.cronLoading).toBe(true);
    expect(requestUpdate).toHaveBeenCalled();

    await page.refreshCron();
    expect(
      request.mock.calls.filter(
        ([method, params]) => method === "cron.list" && params?.limit === 50,
      ),
    ).toHaveLength(1);

    pendingJobs.resolve(cronListResponse([job]));
    await firstRefresh;

    expect(page.cron.cronLoading).toBe(false);
    expect(page.cron.cronJobs).toEqual([job]);
  });

  it("preserves matching initial route data, then resets it on provider replacement", () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client, false));
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = agentsRouteData(currentGateway);
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;
    setPageGateway(page, client, false);
    page.willUpdate(new Map([["routeData", undefined]]));

    page.subscriptions.hostConnected();
    expect(page.client).toBe(client);
    expect(page.agentsList).toBe(agentsList);
    expect(page.agentsSelectedId).toBe("main");
    // Route-driven selection application resets per-agent panel caches, which
    // bumps the request generation; capture it instead of pinning zero.
    const boundGeneration = page.requestGeneration;

    page.context = { gateway: gateway(snapshot(client, false)) } as unknown as ApplicationContext;
    setPageGateway(page, client, false, true);
    expect(page.agentsList).toBeNull();
    expect(page.agentsSelectedId).toBeNull();
    expect(page.requestGeneration).toBeGreaterThan(boundGeneration);
    page.subscriptions.hostDisconnected();
  });

  it("rejects preloaded data after a same-client gateway source replacement", async () => {
    const client = {} as GatewayBrowserClient;
    const preloadedSnapshot = snapshot(client);
    const preloadedGateway = gateway(preloadedSnapshot);
    const currentGateway = gateway(preloadedSnapshot);
    const ensureList = vi.fn(async () => null);
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    setPageGateway(page, client);
    page.routeData = agentsRouteData(preloadedGateway);
    page.context = {
      gateway: currentGateway,
      agents: {
        state: { agentsLoading: false, agentsError: null, agentsList: null },
        ensureList,
        files: () => ({ list: null, loading: false, error: null }),
      },
      agentIdentity: { get: () => null },
      runtimeConfig: { state: { configSnapshot: {}, configLoading: false } },
    } as unknown as ApplicationContext;

    page.willUpdate(new Map([["routeData", undefined]]));
    await Promise.resolve();

    expect(page.agentsList).toBeNull();
    expect(ensureList).toHaveBeenCalledOnce();
  });

  it("does not let an old-client file load overwrite a replacement load", async () => {
    let resolveFirst!: (value: AgentsFilesListResult) => void;
    let resolveSecond!: (value: AgentsFilesListResult) => void;
    const first = new Promise<AgentsFilesListResult>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<AgentsFilesListResult>((resolve) => {
      resolveSecond = resolve;
    });
    const ensureFiles = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const oldClient = {} as GatewayBrowserClient;
    const nextClient = {} as GatewayBrowserClient;
    setPageGateway(page, oldClient);
    page.agentsSelectedId = "main";
    page.context = {
      agents: {
        files: () => ({ list: null, loading: false, error: null }),
        ensureFiles,
        refreshFiles: ensureFiles,
      },
    } as unknown as ApplicationContext;

    const oldLoad = page.loadAgentFiles("main");
    expect(page.agentFilesLoading).toBe(true);

    setPageGateway(page, nextClient);
    page.agentsSelectedId = "main";
    const replacementLoad = page.loadAgentFiles("main");
    expect(page.agentFilesLoading).toBe(true);

    resolveFirst(files("main", "old"));
    await oldLoad;
    expect(page.agentFilesList).toBeNull();
    expect(page.agentFilesLoading).toBe(true);

    resolveSecond(files("main", "new"));
    await replacementLoad;
    expect(page.agentFilesList?.workspace).toBe("new");
    expect(page.agentFilesLoading).toBe(false);
  });

  it("selects and loads AGENTS.md when the file list opens", async () => {
    const fileList: AgentsFilesListResult = {
      agentId: "main",
      workspace: "/tmp/workspace",
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          missing: false,
        },
        {
          name: "SOUL.md",
          path: "/tmp/workspace/SOUL.md",
          missing: false,
        },
      ],
    };
    const request = vi.fn(async () => ({
      file: {
        ...fileList.files[0],
        content: "# Instructions",
      },
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";
    page.context = {
      agents: {
        files: () => ({ list: null, loading: false, error: null }),
        ensureFiles: vi.fn(async () => fileList),
        refreshFiles: vi.fn(async () => fileList),
        recordFile: vi.fn(),
      },
    } as unknown as ApplicationContext;

    await page.loadAgentFiles("main");

    expect(page.agentFileActive).toBe("AGENTS.md");
    expect(page.agentFileContents["AGENTS.md"]).toBe("# Instructions");
    expect(request).toHaveBeenCalledWith("agents.files.get", {
      agentId: "main",
      name: "AGENTS.md",
    });
  });

  it("retries an in-flight panel load after a same-client disconnect", async () => {
    let resolveFirst!: (value: AgentsFilesListResult) => void;
    let resolveSecond!: (value: AgentsFilesListResult) => void;
    const first = new Promise<AgentsFilesListResult>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<AgentsFilesListResult>((resolve) => {
      resolveSecond = resolve;
    });
    const ensureFiles = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = {} as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    setPageGateway(page, client);
    page.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Main" }],
    };
    page.agentsSelectedId = "main";
    page.agentFileContents = { "cached.md": "keep" };
    page.routeDataInitialized = true;
    page.context = {
      agents: {
        files: () => ({ list: null, loading: false, error: null }),
        ensureFiles,
        refreshFiles: ensureFiles,
      },
      agentIdentity: { get: () => ({ agentId: "main" }) },
      runtimeConfig: { state: { configSnapshot: {}, configLoading: false } },
    } as unknown as ApplicationContext;

    const oldLoad = page.loadAgentFiles("main");
    expect(page.agentFilesLoading).toBe(true);

    setPageGateway(page, client, false);
    expect(page.agentFilesLoading).toBe(false);
    expect(page.agentFileContents).toEqual({ "cached.md": "keep" });

    setPageGateway(page, client);
    expect(ensureFiles).toHaveBeenCalledTimes(2);
    expect(page.agentFilesLoading).toBe(true);

    resolveFirst(files("main", "old"));
    await oldLoad;
    expect(page.agentFilesList).toBeNull();
    expect(page.agentFilesLoading).toBe(true);

    resolveSecond(files("main", "new"));
    await waitForFast(() => expect(page.agentFilesList?.workspace).toBe("new"));
    expect(page.agentFilesLoading).toBe(false);
  });

  it("rejects a file result from a replaced agents capability", async () => {
    const oldFiles = deferred<AgentsFilesListResult>();
    const nextFiles = deferred<AgentsFilesListResult>();
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const oldAgents = agentsCapability(() => oldFiles.promise);
    const nextAgents = agentsCapability(() => nextFiles.promise);
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const context = pageContext(currentGateway, oldAgents);
    page.context = context;
    setPageGateway(page, client);
    page.subscriptions.hostConnected();

    const oldLoad = page.loadAgentFiles("main");
    expect(page.agentFilesLoading).toBe(true);

    page.context = { ...context, agents: nextAgents };
    page.subscriptions.hostUpdate();
    const nextLoad = page.loadAgentFiles("main");
    expect(page.agentFilesLoading).toBe(true);

    oldFiles.resolve(files("main", "old"));
    await oldLoad;
    expect(page.agentFilesList).toBeNull();
    expect(page.agentFilesLoading).toBe(true);

    nextFiles.resolve(files("main", "new"));
    await nextLoad;
    expect(page.agentFilesList?.workspace).toBe("new");
    expect(page.agentFilesLoading).toBe(false);
    page.subscriptions.hostDisconnected();
  });

  it("keeps replacement identity loading active when the old capability settles", async () => {
    const oldEnsure = deferred<void>();
    const nextEnsure = deferred<void>();
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const identity = (ensure: () => Promise<void>) =>
      ({
        get: () => null,
        entries: () => [],
        ensure: vi.fn(ensure),
        subscribe: vi.fn(() => () => undefined),
      }) as unknown as ApplicationContext["agentIdentity"];
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const context = pageContext(currentGateway, agents, {
      agentIdentity: identity(() => oldEnsure.promise),
    });
    page.context = context;
    setPageGateway(page, client);
    page.subscriptions.hostConnected();
    page.ensureAgentIdentities();
    expect(page.agentIdentityLoading).toBe(true);

    page.context = {
      ...context,
      agentIdentity: identity(() => nextEnsure.promise),
    };
    page.subscriptions.hostUpdate();
    expect(page.agentIdentityLoading).toBe(true);

    oldEnsure.resolve();
    await oldEnsure.promise;
    await Promise.resolve();
    expect(page.agentIdentityLoading).toBe(true);

    nextEnsure.resolve();
    await nextEnsure.promise;
    await waitForFast(() => expect(page.agentIdentityLoading).toBe(false));
    page.subscriptions.hostDisconnected();
  });

  it("rejects effective-tools results from a replaced sessions capability", async () => {
    const oldResult = deferred<ToolsEffectiveResult>();
    const nextResult = deferred<ToolsEffectiveResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(nextResult.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const oldSessions = {
      state: { result: null, modelOverrides: {} },
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["sessions"];
    const nextSessions = {
      state: { result: null, modelOverrides: {} },
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["sessions"];
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const context = pageContext(currentGateway, agents, { sessions: oldSessions });
    page.context = context;
    setPageGateway(page, client);
    page.subscriptions.hostConnected();
    page.loadEffectiveToolsForAgent("main");
    expect(page.toolsEffectiveLoading).toBe(true);

    page.context = { ...context, sessions: nextSessions };
    page.subscriptions.hostUpdate();
    page.loadEffectiveToolsForAgent("main");
    expect(page.toolsEffectiveLoading).toBe(true);

    oldResult.resolve({ profile: "old" } as ToolsEffectiveResult);
    await oldResult.promise;
    await Promise.resolve();
    expect(page.toolsEffectiveResult).toBeNull();
    expect(page.toolsEffectiveLoading).toBe(true);

    nextResult.resolve({ profile: "new" } as ToolsEffectiveResult);
    await nextResult.promise;
    await waitForFast(() => expect(page.toolsEffectiveResult?.profile).toBe("new"));
    expect(page.toolsEffectiveLoading).toBe(false);
    page.subscriptions.hostDisconnected();
  });
});

describe("AgentsPage routing", () => {
  it.each([
    { requestedAgentId: "research", expectedAgentId: "research" },
    { requestedAgentId: "missing", expectedAgentId: "main" },
    { requestedAgentId: null, expectedAgentId: "main" },
  ])(
    "resolves $requestedAgentId against the current roster after stale route data",
    ({ requestedAgentId, expectedAgentId }) => {
      const currentGateway = gateway(snapshot(null, false));
      const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
      page.context = {
        basePath: "",
        gateway: currentGateway,
      } as unknown as ApplicationContext;
      page.agentsList = {
        ...agentsList,
        agents: [...agentsList.agents, { id: "research", name: "Research" }],
      };
      page.agentsSelectedId = requestedAgentId === "research" ? "main" : "research";
      page.agentFileContents = { "AGENTS.md": "Previous agent's file" };
      page.routeData = {
        ...agentsRouteData(currentGateway, null, requestedAgentId),
        gatewaySnapshot: snapshot(null, false),
        panel: "tools",
      };

      page.willUpdate(new Map([["routeData", undefined]]));

      expect(page.agentsPanel).toBe("tools");
      expect(page.agentsSelectedId).toBe(expectedAgentId);
      expect(page.agentFileContents).toEqual({});
    },
  );
});
