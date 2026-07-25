/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesListResult,
  AgentsListResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { AgentsRouteData } from "./agents-page.ts";
import "./agents-page.ts";

type TestAgentsPage = HTMLElement & {
  context: ApplicationContext;
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsList: unknown;
  agentsSelectedId: string | null;
  routeData?: AgentsRouteData;
  agentFilesLoading: boolean;
  agentFilesList: AgentsFilesListResult | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentIdentityLoading: boolean;
  agentsPanel: string;
  toolsEffectiveLoading: boolean;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  requestGeneration: number;
  routeDataInitialized: boolean;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot, sourceChanged: boolean) => void;
  ensureAgentIdentities: () => void;
  loadEffectiveToolsForAgent: (agentId: string) => void;
  loadAgentFiles: (agentId: string, force?: boolean) => Promise<void>;
};

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
    hello: null,
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

function files(agentId: string, workspace: string): AgentsFilesListResult {
  return { agentId, workspace, files: [] };
}

const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main", name: "Main" }],
};

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
  it("preserves matching initial route data, then resets it on provider replacement", () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client, false));
    const preloadedAgents = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Main" }],
    };
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.routeData = {
      gateway: currentGateway,
      gatewaySnapshot: currentGateway.snapshot,
      agentsList: preloadedAgents,
      selectedAgentId: "main",
      error: null,
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;
    page.willUpdate(new Map([["routeData", undefined]]));

    page.subscriptions.hostConnected();
    expect(page.client).toBe(client);
    expect(page.agentsList).toBe(preloadedAgents);
    expect(page.agentsSelectedId).toBe("main");
    // Route-driven selection application resets per-agent panel caches, which
    // bumps the request generation; capture it instead of pinning zero.
    const boundGeneration = page.requestGeneration;

    page.context = { gateway: gateway(snapshot(client, false)) } as unknown as ApplicationContext;
    page.subscriptions.hostUpdate();
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
    page.client = client;
    page.connected = true;
    page.routeData = {
      gateway: preloadedGateway,
      gatewaySnapshot: preloadedSnapshot,
      agentsList,
      selectedAgentId: "main",
      error: null,
    };
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
    page.client = oldClient;
    page.connected = true;
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

    page.applyGatewaySnapshot(snapshot(nextClient), false);
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
    page.client = client;
    page.connected = true;
    page.agentsSelectedId = "main";
    page.context = {
      agents: {
        files: () => ({ list: null, loading: false, error: null }),
        ensureFiles: vi.fn(async () => fileList),
        refreshFiles: vi.fn(async () => fileList),
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
    page.client = client;
    page.connected = true;
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

    page.applyGatewaySnapshot(snapshot(client, false), false);
    expect(page.agentFilesLoading).toBe(false);
    expect(page.agentFileContents).toEqual({ "cached.md": "keep" });

    page.applyGatewaySnapshot(snapshot(client), false);
    expect(ensureFiles).toHaveBeenCalledTimes(2);
    expect(page.agentFilesLoading).toBe(true);

    resolveFirst(files("main", "old"));
    await oldLoad;
    expect(page.agentFilesList).toBeNull();
    expect(page.agentFilesLoading).toBe(true);

    resolveSecond(files("main", "new"));
    await vi.waitFor(() => expect(page.agentFilesList?.workspace).toBe("new"));
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
    await vi.waitFor(() => expect(page.agentIdentityLoading).toBe(false));
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
    page.subscriptions.hostConnected();
    page.agentsPanel = "overview";

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
    await vi.waitFor(() => expect(page.toolsEffectiveResult?.profile).toBe("new"));
    expect(page.toolsEffectiveLoading).toBe(false);
    page.subscriptions.hostDisconnected();
  });
});
