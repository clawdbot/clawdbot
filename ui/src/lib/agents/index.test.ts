// Control UI tests cover agents behavior.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createAgentCapability,
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
  setDefaultAgent,
} from "./index.ts";
import type { AgentsConfigCapability, AgentsState } from "./index.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot = { client, connected: true };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(connected: boolean) {
      snapshot = { client, connected };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createState(): { state: AgentsState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: AgentsState = {
    client: {
      request,
    } as unknown as AgentsState["client"],
    connected: true,
    requestGeneration: 0,
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
    agentsSelectedId: "main",
    sessions: {
      state: {
        result: null,
        agentId: null,
        modelOverrides: {},
        loading: false,
        error: null,
        deletedSessions: [],
        groups: [],
      },
    },
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    sessionKey: "main",
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "gpt-5-mini",
          modelProvider: "openai",
        },
      ],
    },
    chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
    agentsPanel: "overview",
  };
  return { state, request };
}

function createSaveState(): {
  state: AgentsState;
  config: AgentsConfigCapability & {
    state: {
      configFormDirty: boolean;
      configForm: Record<string, unknown>;
      configFormOriginal: Record<string, unknown>;
    };
  };
  request: ReturnType<typeof vi.fn<TestRequest>>;
} {
  const { state, request } = createState();
  const configState = {
    configFormDirty: true,
    configForm: { agents: { list: [{ id: "main" }] } },
    configFormOriginal: { agents: { list: [{ id: "main" }] } },
  };
  const config = {
    state: configState,
    save: vi.fn(async () => true),
    stageDefaultAgent: vi.fn(() => false),
  } satisfies AgentsConfigCapability;
  return {
    state,
    config,
    request,
  };
}

describe("loadAgents", () => {
  it("preserves selected agent when it still exists in the list", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = "kimi";
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("kimi");
  });

  it("resets to default when selected agent is removed", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = "removed-agent";
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("main");
  });

  it("sets default when no agent is selected", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = null;
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("main");
  });
});

describe("createAgentCapability lifecycle", () => {
  it("starts a fresh list request after a same-client reconnect", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    const staleLoad = agents.refreshList();
    harness.publish(false);
    harness.publish(true);
    const currentLoad = agents.refreshList();

    first.resolve({ defaultId: "old", agents: [{ id: "old" }] });
    await staleLoad;
    expect(agents.state.agentsList).toBeNull();
    expect(agents.state.agentsLoading).toBe(true);

    const current = { defaultId: "main", agents: [{ id: "main" }] };
    second.resolve(current);
    await currentLoad;
    expect(agents.state.agentsList).toEqual(current);
    expect(agents.state.agentsLoading).toBe(false);
    agents.dispose();
  });

  it("isolates file requests across a same-client reconnect", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    const staleLoad = agents.refreshFiles("main");
    harness.publish(false);
    harness.publish(true);
    const currentLoad = agents.refreshFiles("main");

    first.resolve({ agentId: "main", workspace: "old", files: [] });
    await staleLoad;
    expect(agents.files("main").list).toBeNull();
    expect(agents.files("main").loading).toBe(true);

    const current = { agentId: "main", workspace: "new", files: [] };
    second.resolve(current);
    await currentLoad;
    expect(agents.files("main").list).toEqual(current);
    expect(agents.files("main").loading).toBe(false);
    agents.dispose();
  });

  it("does not commit a list request after disposal", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn<TestRequest>().mockReturnValue(pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    const load = agents.refreshList();
    agents.dispose();
    pending.resolve({ defaultId: "stale", agents: [{ id: "stale" }] });
    await load;

    expect(agents.state.agentsList).toBeNull();
    expect(agents.state.agentsLoading).toBe(false);
  });
});

describe("loadToolsCatalog", () => {
  it("loads catalog and stores result", async () => {
    const { state, request } = createState();
    const payload = {
      agentId: "main",
      profiles: [{ id: "full", label: "Full" }],
      groups: [
        {
          id: "media",
          label: "Media",
          source: "core",
          tools: [{ id: "tts", label: "tts", description: "Text-to-speech", source: "core" }],
        },
      ],
    };
    request.mockResolvedValue(payload);

    await loadToolsCatalog(state, "main");

    expect(request).toHaveBeenCalledWith("tools.catalog", {
      agentId: "main",
      includePlugins: true,
    });
    expect(state.toolsCatalogResult).toEqual(payload);
    expect(state.toolsCatalogError).toBeNull();
    expect(state.toolsCatalogLoading).toBe(false);
  });

  it("captures request errors for fallback UI handling", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("gateway unavailable"));

    await loadToolsCatalog(state, "main");

    expect(state.toolsCatalogResult).toBeNull();
    expect(state.toolsCatalogError).toBe("Error: gateway unavailable");
    expect(state.toolsCatalogLoading).toBe(false);
  });

  it("ignores catalog responses after selected agent changes mid-request", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const pending = loadToolsCatalog(state, "main");
    state.agentsSelectedId = "other-agent";
    resolvers.shift()?.({
      agentId: "main",
      profiles: [{ id: "full", label: "Full" }],
      groups: [],
    });
    await pending;

    expect(state.toolsCatalogResult).toBeNull();
    expect(state.toolsCatalogError).toBeNull();
    expect(state.toolsCatalogLoading).toBe(false);
  });

  it("keeps a replacement-client catalog load isolated from the old request", async () => {
    const { state, request: oldRequest } = createState();
    let resolveOld!: (value: unknown) => void;
    let resolveNext!: (value: unknown) => void;
    oldRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const nextRequest = vi.fn<TestRequest>().mockReturnValue(
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    );

    const oldLoad = loadToolsCatalog(state, "main");
    state.client = { request: nextRequest } as unknown as AgentsState["client"];
    state.requestGeneration += 1;
    state.toolsCatalogLoading = false;
    state.toolsCatalogLoadingAgentId = null;
    const nextLoad = loadToolsCatalog(state, "main");

    resolveOld({ agentId: "main", profiles: [], groups: [{ id: "old" }] });
    await oldLoad;
    expect(state.toolsCatalogResult).toBeNull();
    expect(state.toolsCatalogLoading).toBe(true);

    resolveNext({ agentId: "main", profiles: [], groups: [{ id: "new" }] });
    await nextLoad;
    expect(state.toolsCatalogResult?.groups).toEqual([{ id: "new" }]);
    expect(state.toolsCatalogLoading).toBe(false);
  });
});

describe("loadToolsEffective", () => {
  it("loads effective tools for the active session", async () => {
    const { state, request } = createState();
    const payload = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "read",
              label: "Read",
              description: "Read files",
              rawDescription: "Read files",
              source: "core",
            },
          ],
        },
      ],
    };
    request.mockResolvedValue(payload);

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(state.toolsEffectiveResult).toEqual(payload);
    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5-mini");
    expect(state.toolsEffectiveError).toBeNull();
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("captures effective-tool request errors", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("gateway unavailable"));

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(state.toolsEffectiveResult).toBeNull();
    expect(state.toolsEffectiveResultKey).toBeNull();
    expect(state.toolsEffectiveError).toBe("Error: gateway unavailable");
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("ignores effective-tool responses after selected agent changes mid-request", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const pending = loadToolsEffective(state, { agentId: "main", sessionKey: "main" });
    state.agentsSelectedId = "other-agent";
    resolvers.shift()?.({
      agentId: "main",
      profile: "coding",
      groups: [],
    });
    await pending;

    expect(state.toolsEffectiveResult).toBeNull();
    expect(state.toolsEffectiveResultKey).toBeNull();
    expect(state.toolsEffectiveError).toBeNull();
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("keeps a replacement-client effective-tools load isolated from the old request", async () => {
    const { state, request: oldRequest } = createState();
    let resolveOld!: (value: unknown) => void;
    let resolveNext!: (value: unknown) => void;
    oldRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const nextRequest = vi.fn<TestRequest>().mockReturnValue(
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    );

    const oldLoad = loadToolsEffective(state, { agentId: "main", sessionKey: "main" });
    state.client = { request: nextRequest } as unknown as AgentsState["client"];
    state.requestGeneration += 1;
    state.toolsEffectiveLoading = false;
    state.toolsEffectiveLoadingKey = null;
    const nextLoad = loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    resolveOld({ agentId: "main", profile: "old", groups: [] });
    await oldLoad;
    expect(state.toolsEffectiveResult).toBeNull();
    expect(state.toolsEffectiveLoading).toBe(true);

    resolveNext({ agentId: "main", profile: "new", groups: [] });
    await nextLoad;
    expect(state.toolsEffectiveResult?.profile).toBe("new");
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("uses the catalog provider when the active session reports a stale provider", async () => {
    const { state, request } = createState();
    const sessionsResult = state.sessionsResult!;
    state.sessionsResult = {
      ts: sessionsResult.ts,
      path: sessionsResult.path,
      count: 1,
      defaults: sessionsResult.defaults,
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "deepseek-chat",
          modelProvider: "zai",
        },
      ],
    };
    state.chatModelCatalog = [{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" }];
    request.mockResolvedValue({
      agentId: "main",
      profile: "coding",
      groups: [],
    });

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(state.toolsEffectiveResultKey).toBe("main:main:model=deepseek/deepseek-chat");
  });

  it("preserves already-qualified session models when the active session provider is stale and the catalog is empty", async () => {
    const { state, request } = createState();
    const sessionsResult = state.sessionsResult!;
    state.sessionsResult = {
      ts: sessionsResult.ts,
      path: sessionsResult.path,
      count: 1,
      defaults: sessionsResult.defaults,
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "openai/gpt-5-mini",
          modelProvider: "zai",
        },
      ],
    };
    state.chatModelCatalog = [];
    request.mockResolvedValue({
      agentId: "main",
      profile: "coding",
      groups: [],
    });

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5-mini");
  });
});

describe("setDefaultAgent", () => {
  it("stages the default agent and persists a clean draft", async () => {
    const { config } = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configForm = { agents: { list: [{ id: "main" }, { id: "kimi" }] } };
    config.state.configFormOriginal = { agents: { list: [{ id: "main" }, { id: "kimi" }] } };
    config.state.configFormDirty = false;
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configFormDirty = true;
      return true;
    });
    await setDefaultAgent(config, "kimi", refreshAgents);

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("kimi");
    expect(config.save).toHaveBeenCalledTimes(1);
    expect(refreshAgents).toHaveBeenCalledTimes(1);
  });

  it("does not persist when the agent is absent from the config list", async () => {
    const { config } = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configForm = { agents: { list: [{ id: "main" }] } };
    vi.mocked(config.stageDefaultAgent).mockReturnValue(false);

    await setDefaultAgent(config, "ghost", refreshAgents);

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("ghost");
    expect(config.save).not.toHaveBeenCalled();
    expect(refreshAgents).not.toHaveBeenCalled();
  });

  it("does not persist unrelated dirty agent config drafts", async () => {
    const { config } = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configFormDirty = true;
    config.state.configFormOriginal = { agents: { list: [{ id: "main" }, { id: "kimi" }] } };
    config.state.configForm = {
      agents: {
        list: [{ id: "main", model: "gpt-5.5" }, { id: "kimi" }],
      },
    };
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configForm = {
        agents: {
          list: [
            { id: "main", model: "gpt-5.5" },
            { id: "kimi", default: true },
          ],
        },
      };
      config.state.configFormDirty = true;
      return true;
    });

    await setDefaultAgent(config, "kimi", refreshAgents);

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("kimi");
    expect(config.save).not.toHaveBeenCalled();
    expect(refreshAgents).not.toHaveBeenCalled();
    expect(config.state.configForm).toEqual({
      agents: {
        list: [
          { id: "main", model: "gpt-5.5" },
          { id: "kimi", default: true },
        ],
      },
    });
    expect(config.state.configFormDirty).toBe(true);
  });

  it("keeps the shared agent cache unchanged when saving fails", async () => {
    const { config } = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configFormDirty = false;
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configFormDirty = true;
      return true;
    });
    vi.mocked(config.save).mockResolvedValue(false);

    await setDefaultAgent(config, "kimi", refreshAgents);

    expect(refreshAgents).not.toHaveBeenCalled();
  });
});
