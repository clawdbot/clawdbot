import { describe, expect, it, vi } from "vitest";
import { loadAgents, loadToolsCatalog, loadToolsEffective, saveAgentsConfig } from "./agents.ts";
import type { AgentsConfigSaveState, AgentsState } from "./agents.ts";

function createState(): { state: AgentsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: AgentsState = {
    client: {
      request,
    } as unknown as AgentsState["client"],
    connected: true,
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
    agentsSelectedId: "main",
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
    chatModelOverrides: {},
    chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
    agentsPanel: "overview",
  };
  return { state, request };
}

function createSaveState(): {
  state: AgentsConfigSaveState;
  request: ReturnType<typeof vi.fn>;
} {
  const { state, request } = createState();
  return {
    state: {
      ...state,
      applySessionKey: "session-1",
      configLoading: false,
      configRawOriginal: "{}",
      configValid: true,
      configIssues: [],
      configSaving: false,
      configApplying: false,
      updateRunning: false,
      configSnapshot: { hash: "hash-1" },
      configFormDirty: true,
      configFormMode: "form",
      configForm: { agents: { list: [{ id: "main" }] } },
      configRaw: "{}",
      configSchema: null,
      configSchemaVersion: null,
      configSchemaLoading: false,
      configUiHints: {},
      configFormOriginal: { agents: { list: [{ id: "main" }] } },
      configSearchQuery: "",
      configActiveSection: null,
      configActiveSubsection: null,
      pendingUpdateExpectedVersion: null,
      updateStatusBanner: null,
      lastError: null,
    },
    request,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function requireFirstRequestCall(request: ReturnType<typeof vi.fn>): unknown[] {
  const [call] = request.mock.calls;
  if (!call) {
    throw new Error("Expected client request call");
  }
  return call;
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

describe("saveAgentsConfig", () => {
  it("restores the pre-save agent after reload when it still exists", async () => {
    const { state, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        state.agentsSelectedId = null;
        return {
          hash: "hash-2",
          raw: '{"agents":{"list":[{"id":"main"},{"id":"kimi"}]}}',
          config: {
            agents: {
              list: [{ id: "main" }, { id: "kimi" }],
            },
          },
          valid: true,
          issues: [],
        };
      })
      .mockImplementationOnce(async () => {
        state.agentsSelectedId = null;
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "main" },
            { id: "kimi", name: "kimi" },
          ],
        };
      });

    await saveAgentsConfig(state);

    const [method, params] = requireFirstRequestCall(request);
    const requestParams = requireRecord(params);
    expect(method).toBe("config.set");
    expect(requestParams.baseHash).toBe("hash-1");
    expect(JSON.parse(String(requestParams.raw))).toEqual({
      agents: { list: [{ id: "main" }] },
    });
    expect(request).toHaveBeenNthCalledWith(2, "config.get", {});
    expect(request).toHaveBeenNthCalledWith(3, "agents.list", {});
    expect(state.agentsSelectedId).toBe("kimi");
  });

  it("falls back to the default agent when the saved agent disappears", async () => {
    const { state, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        hash: "hash-2",
        raw: '{"agents":{"list":[{"id":"main"}]}}',
        config: {
          agents: {
            list: [{ id: "main" }],
          },
        },
        valid: true,
        issues: [],
      })
      .mockResolvedValueOnce({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", name: "main" }],
      });

    await saveAgentsConfig(state);

    expect(state.agentsSelectedId).toBe("main");
  });
});
