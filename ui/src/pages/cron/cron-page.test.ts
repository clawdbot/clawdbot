import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { CronState } from "../../lib/cron/index.ts";
import "./cron-page.ts";

type CronTestPage = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  render: () => typeof nothing;
  cron: CronState;
  cronModelSuggestions: string[];
  quickCreateOpen: boolean;
  quickCreateDraft: { prompt: string; name: string; schedulePreset: string } | null;
  openQuickCreate: (patch?: Record<string, unknown>) => void;
  createFromQuickCreate: (options?: { runNow?: boolean }) => Promise<void>;
};

type TestGateway = ApplicationContext["gateway"] & {
  emitSnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  emitRetiredEvent: (event: Parameters<GatewayEventListener>[0]) => void;
};

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred callback to be initialized");
  }
  return { promise, resolve };
}

function createGateway(client: GatewayBrowserClient, connected: boolean): TestGateway {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected,
    reconnecting: false,
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

function createContext(gateway: TestGateway): ApplicationContext {
  const subscribe = () => () => undefined;
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
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

function createPage(context: ApplicationContext): CronTestPage {
  const page = document.createElement("openclaw-cron-page") as CronTestPage;
  page.context = context;
  page.render = () => nothing;
  document.body.append(page);
  return page;
}

function createRequest() {
  return vi.fn(async (method: string) => {
    if (method === "cron.list") {
      return { jobs: [], total: 0, offset: 0, hasMore: false };
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

function createQuickCreateRequest() {
  return vi.fn(async (method: string) => {
    if (method === "cron.add") {
      return { created: true, job: { id: "job-fresh" } };
    }
    if (method === "cron.list") {
      return { jobs: [], total: 0, offset: 0, hasMore: false };
    }
    if (method === "cron.runs") {
      return { entries: [], total: 0, offset: 0, hasMore: false };
    }
    if (method === "cron.status") {
      return { enabled: true, jobs: 1, nextWakeAtMs: null };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    return {};
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage lifecycle", () => {
  it("registers idempotently after a module reset with the shared custom element registry", async () => {
    const registered = customElements.get("openclaw-cron-page");
    expect(registered).toBeDefined();

    vi.resetModules();
    await expect(import("./cron-page.ts")).resolves.toBeDefined();

    expect(customElements.get("openclaw-cron-page")).toBe(registered);
  });

  it("replaces all mutable page state on each connection epoch", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway));
    await page.updateComplete;
    const connectedState = page.cron;
    page.cron = {
      ...connectedState,
      cronStatus: { enabled: true, jobs: 1 },
      cronJobs: [{ id: "old" } as never],
    };
    page.cronModelSuggestions = ["old/model"];
    page.quickCreateOpen = true;

    gateway.emitSnapshot({ connected: false });
    const disconnectedState = page.cron;

    expect(disconnectedState).not.toBe(connectedState);
    expect(disconnectedState.cronStatus).toBeNull();
    expect(disconnectedState.cronJobs).toEqual([]);
    expect(page.cronModelSuggestions).toEqual([]);
    expect(page.quickCreateOpen).toBe(false);

    gateway.emitSnapshot({ connected: true });
    expect(page.cron).not.toBe(disconnectedState);
  });

  it("rejects model suggestions from an earlier connection epoch", async () => {
    const staleModels = createDeferred<{ models: Array<{ id: string }> }>();
    let modelRequestCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        modelRequestCount += 1;
        return modelRequestCount === 1 ? staleModels.promise : { models: [{ id: "fresh/model" }] };
      }
      if (method === "cron.list") {
        return { jobs: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, false);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    gateway.emitSnapshot({ connected: true });
    await vi.waitFor(() => expect(modelRequestCount).toBe(1));
    gateway.emitSnapshot({ connected: false });
    gateway.emitSnapshot({ connected: true });
    await vi.waitFor(() => expect(page.cronModelSuggestions).toEqual(["fresh/model"]));

    staleModels.resolve({ models: [{ id: "stale/model" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.cronModelSuggestions).toEqual(["fresh/model"]);
  });

  it("opens quick create pre-filled from a suggestion draft", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    page.openQuickCreate({
      prompt: "Scan the logs",
      name: "Night watch",
      schedulePreset: "hourly",
    });

    expect(page.quickCreateOpen).toBe(true);
    expect(page.quickCreateDraft?.prompt).toBe("Scan the logs");
    expect(page.quickCreateDraft?.name).toBe("Night watch");
    expect(page.quickCreateDraft?.schedulePreset).toBe("hourly");
  });

  it("create & run now issues cron.run for the job returned by cron.add", async () => {
    const request = createQuickCreateRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    page.openQuickCreate({ prompt: "Do the thing", name: "Thing" });
    await page.createFromQuickCreate({ runNow: true });

    const methods = request.mock.calls.map((call) => call[0]);
    expect(methods.indexOf("cron.run")).toBeGreaterThan(methods.indexOf("cron.add"));
    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-fresh", mode: "force" });
    expect(page.quickCreateOpen).toBe(false);
  });

  it("plain create does not trigger an immediate run", async () => {
    const request = createQuickCreateRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    page.openQuickCreate({ prompt: "Do the thing", name: "Thing" });
    await page.createFromQuickCreate();

    expect(request.mock.calls.map((call) => call[0])).not.toContain("cron.run");
    expect(page.quickCreateOpen).toBe(false);
  });

  it("ignores a cron event callback retained by a replaced gateway source", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const firstGateway = createGateway(client, true);
    const secondGateway = createGateway(client, true);
    const firstContext = createContext(firstGateway);
    const secondContext = createContext(secondGateway);
    const page = createPage(firstContext);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());

    page.context = secondContext;
    page.requestUpdate();
    await page.updateComplete;
    await vi.waitFor(() => expect(page.cron.client).toBe(client));
    request.mockClear();
    vi.mocked(secondContext.channels.refresh).mockClear();

    firstGateway.emitRetiredEvent({ event: "cron" } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(secondContext.channels.refresh).not.toHaveBeenCalled();
  });
});
