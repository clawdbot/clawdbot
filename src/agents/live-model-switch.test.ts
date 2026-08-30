// Verifies live session model selection, switch queuing, and pending-flag cleanup.
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installTemporaryCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";

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

vi.mock("./model-selection.js", () => {
  return {
    resolveDefaultModelForAgent: (...args: unknown[]) =>
      state.resolveDefaultModelForAgentMock(...args),
    resolvePersistedSelectedModelRef: (...args: unknown[]) =>
      state.resolvePersistedSelectedModelRefMock(...args),
  };
});

vi.mock("../config/sessions/session-accessor.js", () => {
  const loadSessionEntry = (scope: { sessionKey: string }) => {
    const store = state.loadSessionStoreMock(scope) as Record<string, unknown> | undefined;
    return store?.[scope.sessionKey];
  };
  return {
    loadSessionEntry,
    loadSessionEntryReadOnly: loadSessionEntry,
    patchSessionEntryCore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
  };
});

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

let mod: typeof import("./live-model-switch.js");
let realResolvePersistedSelectedModelRef: typeof import("./model-selection.js").resolvePersistedSelectedModelRef;

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

function resolvePendingSelection(
  entry: Record<string, unknown>,
  overrides: Partial<ShouldSwitchParams> = {},
) {
  state.loadSessionStoreMock.mockReturnValue({
    main: { liveModelSwitchPending: true, ...entry },
  });
  return mod.shouldSwitchToLiveModel(makeShouldSwitchParams(overrides));
}

describe("live model switch", () => {
  beforeAll(async () => {
    mod = await import("./live-model-switch.js");
    ({ resolvePersistedSelectedModelRef: realResolvePersistedSelectedModelRef } =
      await vi.importActual<typeof import("./model-selection.js")>("./model-selection.js"));
  });

  beforeEach(() => {
    const cfg: OpenClawConfig = { session: { store: "/tmp/custom-store.json" } };
    const metadata = installTemporaryCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config: cfg,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
      { config: cfg },
    );
    onTestFinished(() => {
      metadata.release();
    });
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
  it("resolves persisted session overrides ahead of agent defaults", () => {
    expect(
      resolvePendingSelection({
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        agentRuntimeOverride: "codex",
        authProfileOverride: "profile-gpt",
        authProfileOverrideSource: "user",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      agentRuntimeOverride: "codex",
      authProfileId: "profile-gpt",
      authProfileIdSource: "user",
    });
    expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        agentId: "reply",
      }),
    );
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

  it.each([
    {
      name: "legacy source-less user",
      authProfileOverrideCompactionCount: undefined,
      expectedSource: "user",
    },
    {
      name: "legacy source-less automatic",
      authProfileOverrideCompactionCount: 0,
      expectedSource: "auto",
    },
  ])("projects $name auth provenance", ({ authProfileOverrideCompactionCount, expectedSource }) => {
    expect(
      resolvePendingSelection({
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        authProfileOverride: "profile-gpt",
        authProfileOverrideCompactionCount,
      }),
    ).toMatchObject({
      authProfileId: "profile-gpt",
      authProfileIdSource: expectedSource,
    });
  });

  it("prefers persisted session overrides ahead of stale runtime model fields", () => {
    expect(
      resolvePendingSelection(
        {
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
        },
        { currentModel: "claude-sonnet-4-6" },
      ),
    ).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("splits legacy combined session overrides when providerOverride is missing", () => {
    expect(
      resolvePendingSelection({
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      }),
    ).toEqual({
      provider: "ollama-beelink2",
      model: "qwen2.5-coder:7b",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("preserves provider when runtime model is a vendor-prefixed OpenRouter id", () => {
    // OpenRouter models often contain provider-like slashes. An explicit
    // runtime provider must keep the full nested model id intact.
    expect(
      resolvePendingSelection({
        modelProvider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("keeps nested model ids under the persisted provider override", () => {
    expect(
      resolvePendingSelection({
        providerOverride: "nvidia",
        modelOverride: "moonshotai/kimi-k2.5",
      }),
    ).toEqual({
      provider: "nvidia",
      model: "moonshotai/kimi-k2.5",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it.each([
    {
      name: "a duplicated OpenAI provider prefix",
      provider: "openai",
      model: "openai/gpt-5.4",
      configured: false,
      provenance: "raw",
      expected: "gpt-5.4",
      runtimeCalls: 0,
    },
    {
      name: "a raw plugin model",
      provider: "stored-provider",
      model: "legacy",
      configured: false,
      provenance: "raw",
      expected: "runtime-retained-legacy",
      runtimeCalls: 1,
    },
    {
      name: "a literal configured self-prefix",
      provider: "stored-provider",
      model: "stored-provider/legacy",
      configured: true,
      provenance: "raw",
      expected: "stored-provider/legacy",
      runtimeCalls: 0,
    },
    ...(["explicit", "legacy"] as const).map((provenance) => ({
      name: `${provenance} resolved provenance`,
      provider: "stored-provider",
      model: "legacy",
      configured: false,
      provenance,
      expected: "retained-legacy",
      runtimeCalls: 0,
    })),
  ])(
    "honors $name when reading a pending live switch",
    ({ provider, model, configured, provenance, expected, runtimeCalls }) => {
      state.resolvePersistedSelectedModelRefMock.mockImplementation(
        realResolvePersistedSelectedModelRef,
      );
      const cfg: OpenClawConfig = {
        session: { store: "/tmp/custom-store.json" },
        agents: { entries: { reply: { workspace: "/tmp/configured-reply-workspace" } } },
      };
      if (configured) {
        cfg.models = {
          providers: {
            [provider]: {
              baseUrl: "https://stored-provider.test/v1",
              models: [
                {
                  id: model,
                  name: model,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 1024,
                },
              ],
            },
          },
        };
      }
      const manifestRegistry = makeRegistry([
        { id: "stored-provider", channels: [], providers: ["stored-provider"] },
      ]);
      const manifest = manifestRegistry.plugins[0]!;
      manifest.modelIdNormalization = {
        providers: { "stored-provider": { aliases: { legacy: "retained-legacy" } } },
      };
      const normalizeModelId = vi.fn(({ modelId }: { modelId: string }) => `runtime-${modelId}`);
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.plugins.push(
        createPluginRecord({
          id: manifest.id,
          source: manifest.source,
          rootDir: manifest.rootDir,
          origin: manifest.origin,
          providerIds: manifest.providers,
        }),
      );
      pluginRegistry.providers.push({
        pluginId: manifest.id,
        source: manifest.source,
        rootDir: manifest.rootDir,
        provider: { id: manifest.id, label: "Stored provider", auth: [], normalizeModelId },
      });

      const selected = withPluginRuntimeGenerationScope(
        {
          config: cfg,
          metadataSnapshot: createPluginMetadataSnapshot({
            config: cfg,
            manifestRegistry,
            workspaceDir: "/tmp/retained-generation-workspace",
          }),
          pluginRegistry,
        },
        () =>
          resolvePendingSelection(
            {
              providerOverride: provider,
              modelOverride: model,
              ...(provenance === "explicit"
                ? { modelOverrideRouteResolution: "resolved" }
                : provenance === "legacy"
                  ? {
                      modelOverrideFallbackOriginProvider: "origin-provider",
                      modelOverrideFallbackOriginModel: "origin-model",
                    }
                  : {}),
            },
            { cfg },
          ),
      );

      expect(selected).toEqual({
        provider,
        model: expected,
        authProfileId: undefined,
        authProfileIdSource: undefined,
      });
      expect(normalizeModelId).toHaveBeenCalledTimes(runtimeCalls);
    },
  );

  it("does not import the broad embedded-agent barrel on module load", async () => {
    await loadModule();

    expect(state.embeddedAgentModuleImported).toBe(false);
  });

  it("treats active openai as an already-applied openai runtime promotion", () => {
    expect(
      resolvePendingSelection(
        { providerOverride: "openai", modelOverride: "gpt-5.5" },
        { currentProvider: "openai", currentModel: "gpt-5.5" },
      ),
    ).toBeUndefined();
  });

  it("does not suppress explicit runtime provider switches with the same model", () => {
    expect(
      resolvePendingSelection(
        { providerOverride: "claude-cli", modelOverride: "claude-sonnet-4-6" },
        {
          currentProvider: "anthropic",
          currentModel: "claude-sonnet-4-6",
        },
      ),
    ).toMatchObject({ provider: "claude-cli", model: "claude-sonnet-4-6" });
  });

  it("does not suppress switch when model actually differs across runtime alias", () => {
    expect(
      resolvePendingSelection(
        { providerOverride: "openai", modelOverride: "gpt-5.4" },
        { currentProvider: "openai", currentModel: "gpt-5.5" },
      ),
    ).toMatchObject({ provider: "openai", model: "gpt-5.4" });
  });

  it("treats a same-model runtime change as a live switch", () => {
    expect(
      resolvePendingSelection(
        {
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        },
        {
          currentProvider: "openai",
          currentModel: "gpt-5.6-luna",
          currentAgentRuntimeOverride: "openclaw",
        },
      ),
    ).toMatchObject({ agentRuntimeOverride: "codex" });
  });

  it("treats auth-profile-source changes as no-op when no auth profile is selected", () => {
    expect(
      resolvePendingSelection(
        { providerOverride: "openai", modelOverride: "gpt-5.4" },
        {
          currentProvider: "openai",
          currentModel: "gpt-5.4",
          currentAuthProfileIdSource: "auto",
        },
      ),
    ).toBeUndefined();
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

  describe("consolidateLiveModelSwitchAfterRun", () => {
    const consolidateParams = {
      cfg: { session: { store: "/tmp/custom-store.json" } },
      sessionKey: "main",
      agentId: "reply",
    };

    it("clears the pending flag when the run executed the persisted selection", async () => {
      // CLI harness runs never pass the embedded attempt-recovery clear; the
      // post-run consolidation is what stops /status reporting a stale switch.
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "claude-cli",
        modelOverride: "claude-opus-4-6",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

      const { consolidateLiveModelSwitchAfterRun } = await loadModule();

      await consolidateLiveModelSwitchAfterRun({
        ...consolidateParams,
        providerUsed: "claude-cli",
        modelUsed: "claude-opus-4-6",
      });

      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
    });

    it("keeps the pending flag when the run executed a different model", async () => {
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

      const { consolidateLiveModelSwitchAfterRun } = await loadModule();

      await consolidateLiveModelSwitchAfterRun({
        ...consolidateParams,
        providerUsed: "anthropic",
        modelUsed: "claude-opus-4-6",
      });

      expect(sessionEntry.liveModelSwitchPending).toBe(true);
    });

    it("clears via the openai runtime promotion when providers differ only by alias", async () => {
      const sessionEntry = {
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

      const { consolidateLiveModelSwitchAfterRun } = await loadModule();

      await consolidateLiveModelSwitchAfterRun({
        ...consolidateParams,
        providerUsed: "OpenAI",
        modelUsed: "gpt-5.5",
      });

      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
    });

    it("leaves the entry untouched when the flag is not set", async () => {
      const sessionEntry = {
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

      const { consolidateLiveModelSwitchAfterRun } = await loadModule();

      await consolidateLiveModelSwitchAfterRun({
        ...consolidateParams,
        providerUsed: "openai",
        modelUsed: "gpt-5.5",
      });

      expect(sessionEntry).toEqual({ providerOverride: "openai", modelOverride: "gpt-5.5" });
    });

    it("resolves the owning agent's default when the caller has no agent id", async () => {
      // Without an explicit agentId the session key still identifies the
      // owning agent; /model default must consolidate against that agent's
      // configured default, not library-wide constants.
      const sessionEntry = {
        liveModelSwitchPending: true,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

      const { consolidateLiveModelSwitchAfterRun } = await loadModule();

      await consolidateLiveModelSwitchAfterRun({
        cfg: consolidateParams.cfg,
        sessionKey: "main",
        providerUsed: "anthropic",
        modelUsed: "claude-opus-4-6",
      });

      // The derived agent must also target the store so agent-scoped store
      // templates resolve the row that actually holds the pending flag.
      expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
        agentId: "main",
      });
      expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalled();
      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
    });

    it("clears a pending default switch once the agent default actually ran", async () => {
      // /model default clears the override and leaves only runtime fields; the
      // selection then resolves to the agent default, which just ran.
      const sessionEntry = {
        liveModelSwitchPending: true,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });

      const { consolidateLiveModelSwitchAfterRun } = await loadModule();

      await consolidateLiveModelSwitchAfterRun({
        ...consolidateParams,
        providerUsed: "anthropic",
        modelUsed: "claude-opus-4-6",
      });

      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
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
