// Shared fixtures for cron-page tests. Kept out of the spec files so each
// stays under the max-lines lint budget.
import { nothing } from "lit";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";

export type CronTestPage = HTMLElement & {
  context: ApplicationContext;
  routeSearch: string;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  render: () => typeof nothing;
  cron: import("../../lib/cron/index.ts").CronState;
  cronModelSuggestions: string[];
};

export function waitForCronPage(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

export type TestGateway = ApplicationContext["gateway"] & {
  emitSnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  emitRetiredEvent: (event: Parameters<GatewayEventListener>[0]) => void;
};

export function createGateway(client: GatewayBrowserClient, connected: boolean): TestGateway {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const allEventListeners: GatewayEventListener[] = [];
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      allEventListeners.push(listener);
      return () => eventListeners.delete(listener);
    },
    emitSnapshot(patch: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, patch);
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
    emitRetiredEvent(event: Parameters<GatewayEventListener>[0]) {
      for (const listener of allEventListeners) {
        listener(event);
      }
    },
  } as unknown as TestGateway;
}

export function operatorHello(scopes: string[]): NonNullable<ApplicationGatewaySnapshot["hello"]> {
  return {
    type: "hello-ok",
    protocol: 4,
    auth: { role: "operator", scopes },
  };
}

export function createContext(
  gateway: TestGateway,
  scopeId: string | null = "main",
  selectedId: string | null = scopeId,
): ApplicationContext {
  const subscribe = () => () => undefined;
  let selectionState = { selectedId, scopeId };
  const selectionListeners = new Set<(state: typeof selectionState) => void>();
  return {
    basePath: "",
    gateway,
    agents: {
      state: {
        agentsList: { defaultId: "main", agents: [{ id: "main" }] },
        agentsLoading: false,
        agentsError: null,
      },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    channels: {
      state: {
        channelsSnapshot: null,
      },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
    runtimeConfig: {
      state: { configSnapshot: null },
      subscribe,
    },
    agentSelection: {
      get state() {
        return selectionState;
      },
      set(agentId: string | null) {
        selectionState = { selectedId: agentId, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      setScope(agentId: string | null) {
        selectionState = { ...selectionState, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      subscribe(listener: (state: typeof selectionState) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

export function createPage(
  context: ApplicationContext,
  options: { render?: boolean } = {},
): CronTestPage {
  const page = document.createElement("openclaw-cron-page") as CronTestPage;
  page.context = context;
  if (!options.render) {
    page.render = () => nothing;
  }
  document.body.append(page);
  return page;
}

export function cronListResponse(jobs: CronJob[]): CronJobsListResult {
  return {
    jobs: jobs.map((job) => ({
      configRevision: job.configRevision ?? `config-revision-${job.id}`,
      ...job,
    })),
    snapshotRevision: "cron-page-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

export function createRequest(
  cronStatus: {
    enabled: boolean;
    jobs: number;
    triggersEnabled: boolean;
    taskLanesConfigured?: boolean;
  } = {
    enabled: true,
    jobs: 0,
    triggersEnabled: true,
  },
) {
  return vi.fn(async (method: string) => {
    if (method === "cron.status") {
      return { ...cronStatus };
    }
    if (method === "cron.list") {
      return cronListResponse([]);
    }
    if (method === "cron.runs") {
      return { entries: [], total: 0, offset: 0, hasMore: false };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    return {};
  });
}
