import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  abortEmbeddedPiRunMock: vi.fn(),
  requestEmbeddedRunModelSwitchMock: vi.fn(),
  consumeEmbeddedRunModelSwitchMock: vi.fn(),
  resolveDefaultModelForAgentMock: vi.fn(),
  resolvePersistedSelectedModelRefMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  piEmbeddedModuleImported: false,
}));

vi.mock("./pi-embedded.js", () => {
  state.piEmbeddedModuleImported = true;
  return {};
});

vi.mock("./pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => state.abortEmbeddedPiRunMock(...args),
  requestEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.requestEmbeddedRunModelSwitchMock(...args),
  consumeEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.consumeEmbeddedRunModelSwitchMock(...args),
}));

vi.mock("./model-selection.js", async () => {
  const actual =
    await vi.importActual<typeof import("./model-selection.js")>("./model-selection.js");
  return {
    normalizeStoredOverrideModel: actual.normalizeStoredOverrideModel,
    resolveDefaultModelForAgent: (...args: unknown[]) =>
      state.resolveDefaultModelForAgentMock(...args),
    resolvePersistedSelectedModelRef: (...args: unknown[]) =>
      state.resolvePersistedSelectedModelRefMock(...args),
  };
});

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStoreMock(...args),
  updateSessionStore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStoreMock(...args),
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
  updateSessionStore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
}));

let mod: typeof import("./live-model-switch.js");

async function loadModule() {
  return mod;
}

type ShouldSwitchParams = Parameters<
  typeof import("./live-model-switch.js").shouldSwitchToLiveModel
>[0];

function makeShouldSwitchParams(overrides: Partial<ShouldSwitchParams> = {}): ShouldSwitchParams {
  return {
    cfg: { session: { store: "/tmp/custom-store.json" } },
    sessionKey: "main",
    agentId: "reply",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    currentProvider: "anthropic",
    currentModel: "claude-opus-4-6",
    ...overrides,
  };
}

describe("live model switch", () => {
  beforeAll(async () => {
    mod = await import("./live-model-switch.js");
  });

  beforeEach(() => {
    state.abortEmbeddedPiRunMock.mockReset().mockReturnValue(false);
    state.requestEmbeddedRunModelSwitchMock.mockReset();
    state.consumeEmbeddedRunModelSwitchMock.mockReset();
    state.piEmbeddedModuleImported = false;
    state.resolveDefaultModelForAgentMock
      .mockReset()
      .mockReturnValue({ provider: "anthropic", model: "claude-opus-4-6" });
    state.resolvePersistedSelectedModelRefMock
      .mockReset()
      .mockImplementation(
        (params: {
          defaultProvider: string;
          runtimeProvider?: string;
          runtimeModel?: string;
          overrideProvider?: string;
          overrideModel?: string;
        }) => {
          const defaultProvider = params.defaultProvider.trim();
          const overrideProvider = params.overrideProvider?.trim();
          const overrideModel = params.overrideModel?.trim();
          if (overrideModel) {
            if (overrideProvider) {
              return { provider: overrideProvider, model: overrideModel };
            }
            const slash = overrideModel.indexOf("/");
            if (slash <= 0 || slash === overrideModel.length - 1) {
              return { provider: defaultProvider, model: overrideModel };
            }
            return {
              provider: overrideModel.slice(0, slash),
              model: overrideModel.slice(slash + 1),
            };
          }
          const runtimeProvider = params.runtimeProvider?.trim();
          const runtimeModel = params.runtimeModel?.trim();
          if (runtimeModel) {
            if (runtimeProvider) {
              return { provider: runtimeProvider, model: runtimeModel };
            }
            const slash = runtimeModel.indexOf("/");
            if (slash <= 0 || slash === runtimeModel.length - 1) {
              return { provider: defaultProvider, model: runtimeModel };
            }
            return {
              provider: runtimeModel.slice(0, slash),
              model: runtimeModel.slice(slash + 1),
            };
          }
          return null;
        },
      );
    state.loadSessionStoreMock.mockReset().mockReturnValue({});
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/session-store.json");
    state.updateSessionStoreMock
      .mockReset()
      .mockImplementation(
        async (_path: string, updater: (store: Record<string, unknown>) => void) => {
          const store: Record<string, unknown> = {};
          updater(store);
        },
      );
  });
  it("resolves persisted session overrides ahead of agent defaults", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        authProfileOverride: "profile-gpt",
        authProfileOverrideSource: "user",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-gpt",
      authProfileIdSource: "user",
    });
    expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
      cfg: { session: { store: "/tmp/custom-store.json" } },
      agentId: "reply",
    });
    expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
      agentId: "reply",
    });
  });

  it("prefers persisted session overrides ahead of stale runtime model fields", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("splits legacy combined session overrides when providerOverride is missing", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "ollama-beelink2",
      model: "qwen2.5-coder:7b",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("preserves provider when runtime model is a vendor-prefixed OpenRouter id", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelProvider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("keeps nested model ids under the persisted provider override", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "nvidia",
        modelOverride: "moonshotai/kimi-k2.5",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "nvidia",
      model: "moonshotai/kimi-k2.5",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("strips duplicated provider prefixes from persisted overrides", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("routes normalized overrides back through persisted ref resolution", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "z-ai",
        modelOverride: "z-ai/deepseek-chat",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/custom-store.json" } },
      sessionKey: "main",
      agentId: "reply",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    });

    expect(state.resolvePersistedSelectedModelRefMock).toHaveBeenCalledWith({
      defaultProvider: "anthropic",
      runtimeProvider: undefined,
      runtimeModel: undefined,
      overrideProvider: "z-ai",
      overrideModel: "deepseek-chat",
    });
  });

  it("queues a live switch only when an active run was aborted", async () => {
    state.abortEmbeddedPiRunMock.mockReturnValue(true);

    const { requestLiveSessionModelSwitch } = await loadModule();

    expect(
      requestLiveSessionModelSwitch({
        sessionEntry: { sessionId: "session-1" },
        selection: { provider: "openai", model: "gpt-5.4", authProfileId: "profile-gpt" },
      }),
    ).toBe(true);
    expect(state.abortEmbeddedPiRunMock).toHaveBeenCalledWith("session-1");
    expect(state.requestEmbeddedRunModelSwitchMock).toHaveBeenCalledWith("session-1", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-gpt",
    });
  });

  it("does not import the broad pi-embedded barrel on module load", async () => {
    await loadModule();

    expect(state.piEmbeddedModuleImported).toBe(false);
  });

  it("treats auth-profile-source changes as no-op when no auth profile is selected", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          provider: "openai",
          model: "gpt-5.4",
          authProfileIdSource: "auto",
        },
        {
          provider: "openai",
          model: "gpt-5.4",
        },
      ),
    ).toBe(false);
  });

  it("does not track persisted live selection when the run started on a transient model override", async () => {
    const { shouldTrackPersistedLiveSessionModelSelection } = await loadModule();

    expect(
      shouldTrackPersistedLiveSessionModelSelection(
        {
          provider: "anthropic",
          model: "claude-haiku-4-5",
        },
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      ),
    ).toBe(false);
  });

  describe("shouldSwitchToLiveModel", () => {
    it("returns the persisted selection when liveModelSwitchPending is true and model differs", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          liveModelSwitchPending: true,
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(makeShouldSwitchParams());

      expect(result).toEqual({
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: undefined,
        authProfileIdSource: undefined,
      });
    });

    it("returns undefined when liveModelSwitchPending is false", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(makeShouldSwitchParams());

      expect(result).toBeUndefined();
    });

    it("returns undefined when liveModelSwitchPending is true but models match", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          liveModelSwitchPending: true,
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(makeShouldSwitchParams());

      expect(result).toBeUndefined();
    });

    it("clears the stale liveModelSwitchPending flag when models already match", async () => {
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });
      state.updateSessionStoreMock.mockImplementation(
        async (_path: string, updater: (store: Record<string, unknown>) => void) => {
          const store: Record<string, typeof sessionEntry> = { main: sessionEntry };
          updater(store);
        },
      );

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(makeShouldSwitchParams());

      expect(result).toBeUndefined();
      await vi.waitFor(() => expect(state.updateSessionStoreMock).toHaveBeenCalledTimes(1));
      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
    });

    it("returns undefined when sessionKey is missing", async () => {
      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(makeShouldSwitchParams({ sessionKey: undefined }));

      expect(result).toBeUndefined();
    });
  });

  describe("clearLiveModelSwitchPending", () => {
    it("calls updateSessionStore to clear the flag", async () => {
      const { clearLiveModelSwitchPending } = await loadModule();

      await clearLiveModelSwitchPending({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
      });

      expect(state.updateSessionStoreMock).toHaveBeenCalledTimes(1);
      expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
        agentId: "reply",
      });
    });

    it("deletes liveModelSwitchPending from the session entry", async () => {
      const sessionEntry = { liveModelSwitchPending: true, sessionId: "s-1" };
      state.updateSessionStoreMock.mockImplementation(
        async (_path: string, updater: (store: Record<string, unknown>) => void) => {
          const store: Record<string, typeof sessionEntry> = { main: sessionEntry };
          updater(store);
        },
      );

      const { clearLiveModelSwitchPending } = await loadModule();

      await clearLiveModelSwitchPending({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
      });

      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
    });

    it("is a no-op when sessionKey is missing", async () => {
      const { clearLiveModelSwitchPending } = await loadModule();

      await clearLiveModelSwitchPending({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: undefined,
        agentId: "reply",
      });

      expect(state.updateSessionStoreMock).not.toHaveBeenCalled();
    });
  });
});
