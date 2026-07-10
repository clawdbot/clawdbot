// Verifies live session model selection, switch queuing, and pending-flag cleanup.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolveDefaultModelForAgentMock: vi.fn(),
  resolvePersistedSelectedModelRefMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  embeddedAgentModuleImported: false,
}));

vi.mock("./embedded-agent.js", () => {
  state.embeddedAgentModuleImported = true;
  return {};
});

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

vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: (scope: { sessionKey: string }) => {
    const store = state.loadSessionStoreMock(scope) as Record<string, unknown> | undefined;
    return store?.[scope.sessionKey];
  },
  patchSessionEntry: (...args: unknown[]) => state.updateSessionStoreMock(...args),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

let mod: typeof import("./live-model-switch.js");

async function loadModule() {
  return mod;
}

type ShouldSwitchParams = Parameters<
  typeof import("./live-model-switch.js").shouldSwitchToLiveModel
>[0];

function makeShouldSwitchParams(overrides: Partial<ShouldSwitchParams> = {}): ShouldSwitchParams {
  // Defaults model an active Anthropic run so individual tests can override
  // only the persisted/live selection fields under scrutiny.
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
    state.embeddedAgentModuleImported = false;
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
        async (
          scope: { sessionKey: string },
          updater: (
            entry: Record<string, unknown>,
          ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
        ) => {
          const store = state.loadSessionStoreMock(scope) as Record<
            string,
            Record<string, unknown>
          >;
          const entry = store?.[scope.sessionKey];
          if (!entry) {
            return null;
          }
          const next = await updater(entry);
          if (!next) {
            return entry;
          }
          for (const key of Object.keys(entry)) {
            delete entry[key];
          }
          Object.assign(entry, next);
          return entry;
        },
      );
  });
  it("resolves persisted session overrides ahead of agent defaults", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        agentRuntimeOverride: "codex",
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
      agentRuntimeOverride: "codex",
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
    expect(state.loadSessionStoreMock).toHaveBeenCalledWith({
      storePath: "/tmp/session-store.json",
      sessionKey: "main",
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
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
    // OpenRouter models often contain provider-like slashes. An explicit
    // runtime provider must keep the full nested model id intact.
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
        providerOverride: "openai",
        modelOverride: "openai/gpt-5.4",
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
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("routes normalized overrides back through persisted ref resolution", async () => {
    // Normalization strips duplicate provider prefixes before handing the
    // choice to the shared persisted-ref resolver.
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

  it("does not import the broad embedded-agent barrel on module load", async () => {
    await loadModule();

    expect(state.embeddedAgentModuleImported).toBe(false);
  });

  it("treats active openai as an already-applied openai runtime promotion", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          provider: "openai",
          model: "gpt-5.5",
        },
        {
          provider: "openai",
          model: "gpt-5.5",
        },
      ),
    ).toBe(false);
  });

  it("does not suppress explicit runtime provider switches with the same model", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
        {
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
        },
      ),
    ).toBe(true);
  });

  it("does not suppress switch when model actually differs across runtime alias", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          provider: "openai",
          model: "gpt-5.5",
        },
        {
          provider: "openai",
          model: "gpt-5.4",
        },
      ),
    ).toBe(true);
  });

  it("treats a same-model runtime change as a live switch", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          provider: "openai",
          model: "gpt-5.6-luna",
          agentRuntimeOverride: "openclaw",
        },
        {
          provider: "openai",
          model: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        },
      ),
    ).toBe(true);
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

  describe("shouldSwitchToLiveModel", () => {
    it("returns the persisted selection when liveModelSwitchPending is true and model differs", async () => {
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      };
      state.loadSessionStoreMock.mockReturnValue({
        main: sessionEntry,
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
      expect(state.loadSessionStoreMock).toHaveBeenCalledWith({
        hydrateSkillPromptRefs: false,
        clone: false,
        readConsistency: "latest",
        sessionKey: "main",
        storePath: "/tmp/session-store.json",
      });
    });

    it("returns undefined when liveModelSwitchPending is true but models match", async () => {
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
      };
      state.loadSessionStoreMock.mockReturnValue({
        main: sessionEntry,
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(makeShouldSwitchParams());

      expect(result).toBeUndefined();
    });

    it("returns the persisted selection when only the runtime changed", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          liveModelSwitchPending: true,
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(
        makeShouldSwitchParams({
          currentProvider: "openai",
          currentModel: "gpt-5.6-luna",
          currentAgentRuntimeOverride: "openclaw",
          defaultProvider: "openai",
          defaultModel: "gpt-5.6-luna",
        }),
      );

      expect(result).toEqual({
        provider: "openai",
        model: "gpt-5.6-luna",
        agentRuntimeOverride: "codex",
        authProfileId: undefined,
        authProfileIdSource: undefined,
      });
    });

    it("clears the stale liveModelSwitchPending flag when models already match", async () => {
      // A stale pending flag should self-heal once the active runtime already
      // matches the persisted selection.
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

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

    it("does not trigger switch when runtime promotes openai to openai", async () => {
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel(
        makeShouldSwitchParams({
          currentProvider: "openai",
          currentModel: "gpt-5.5",
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
        }),
      );

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
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

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
