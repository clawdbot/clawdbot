// Regression tests: provider auth failures re-prompt instead of killing the wizard.
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filterLocalModelLeanTools, isLocalModelLeanEnabled } from "../agents/local-model-lean.js";
import {
  applyLocalSetupWorkspaceConfig,
  applySkipBootstrapConfig,
} from "../commands/onboard-config.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import { runSetupModelAuthStep } from "./setup.model-auth.js";
import { requestTelemetryConsent, requireRiskAcknowledgement } from "./setup.shared.js";

type ResolveManifestProviderAuthChoice =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoice;
type ResolvePluginSetupProvider =
  typeof import("../plugins/setup-registry.js").resolvePluginSetupProviderCore;

const applyAuthChoice = vi.hoisted(() => vi.fn());
const warnIfModelConfigLooksOff = vi.hoisted(() => vi.fn());
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn());
const promptDefaultModel = vi.hoisted(() => vi.fn());
const applyPrimaryModel = vi.hoisted(() => vi.fn((config: unknown) => config));
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn());
const promptCustomApiConfig = vi.hoisted(() => vi.fn());
const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const detectAvailableSetupProviderIds = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoice = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoice>(() => ({
    pluginId: "anthropic",
    providerId: "anthropic",
    methodId: "anthropic-cli",
    choiceId: "anthropic-cli",
    choiceLabel: "Anthropic CLI",
  })),
);
const resolvePluginSetupProviderCore = vi.hoisted(() =>
  vi.fn<ResolvePluginSetupProvider>(() => undefined),
);

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice,
  prepareAuthChoice: applyAuthChoice,
  warnIfModelConfigLooksOff,
  resolvePreferredProviderForAuthChoice,
}));

vi.mock("../commands/model-picker.js", () => ({
  applyPrimaryModel,
  promptDefaultModel,
}));

vi.mock("../commands/onboard-custom.js", () => ({ promptCustomApiConfig }));

vi.mock("../commands/auth-choice-prompt.js", () => ({
  isKeepCurrentAuthChoice: (value: unknown) => value === "__keep-current",
  promptAuthChoiceGrouped,
}));

vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../plugins/provider-setup-availability.js", () => ({
  detectAvailableSetupProviderIds,
}));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore,
}));

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
    disableBackNavigation: vi.fn(),
  } as unknown as WizardPrompter;
}

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
}

function createDefaultAgentConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: "/tmp/global-workspace" },
      entries: {
        ops: {
          default: true,
          agentDir: "/tmp/ops-agent",
          workspace: "/tmp/ops-workspace",
        },
      },
    },
  };
}

describe("runSetupModelAuthStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptDefaultModel.mockResolvedValue({});
    warnIfModelConfigLooksOff.mockResolvedValue(undefined);
    detectAvailableSetupProviderIds.mockResolvedValue(new Set(["ollama"]));
  });

  it.each([false, true])(
    "targets the configured default agent across setup copies (migrated: %s)",
    async (migrated) => {
      let config = createDefaultAgentConfig();
      const prompter = createPrompter();
      if (migrated) {
        config.agents!.entries = { alpha: {}, ...config.agents!.entries };
        config = migratePersistedImplicitMainRoster(config).config as OpenClawConfig;
        config = await requireRiskAcknowledgement({ config, opts: { acceptRisk: true }, prompter });
        vi.mocked(prompter.select).mockResolvedValueOnce(false);
        config = await requestTelemetryConsent({ config, opts: {}, prompter });
        config = applySkipBootstrapConfig(applyLocalSetupWorkspaceConfig(config, "/tmp/requested"));
      }
      promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
      applyAuthChoice.mockResolvedValueOnce({
        config: { ...config },
        authProfiles: [],
        persistAuthProfiles: async () => {},
      });

      await runSetupModelAuthStep({
        config,
        opts: {},
        prompter,
        runtime: createRuntime(),
      });

      expect(ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/ops-agent", {
        allowKeychainPrompt: false,
        readOnly: true,
      });
      expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceDir: "/tmp/ops-workspace",
          detectedProviderIds: new Set(["ollama"]),
        }),
      );
      expect(applyAuthChoice).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "ops",
          agentDir: "/tmp/ops-agent",
        }),
      );
      expect(promptDefaultModel).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "ops",
          agentDir: "/tmp/ops-agent",
          workspaceDir: "/tmp/ops-workspace",
        }),
      );
      expect(warnIfModelConfigLooksOff).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        agentId: "ops",
        agentDir: "/tmp/ops-agent",
        pendingAuthProfiles: [],
        validateCatalog: false,
      });
    },
  );

  it("stages provider auth on the pending named agent without nesting its workspace", async () => {
    const workspaceDir = "/tmp/robby-workspace";
    const config: OpenClawConfig = { agents: { defaults: { workspace: workspaceDir } } };
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
    applyAuthChoice.mockResolvedValueOnce({
      config,
      authProfiles: [],
      persistAuthProfiles: async () => {},
    });

    await runSetupModelAuthStep({
      config,
      opts: {},
      pendingAgent: { name: "Robby!", workspaceDir },
      prompter: createPrompter(),
      runtime: createRuntime(),
    });

    const agentDir = expect.stringMatching(/[/\\]agents[/\\]robby[/\\]agent$/);
    expect(ensureAuthProfileStore).toHaveBeenCalledWith(agentDir, {
      allowKeychainPrompt: false,
      readOnly: true,
    });
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir }));
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "robby", agentDir, workspaceDir }),
    );
    expect(promptDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "robby", agentDir, workspaceDir }),
    );
    expect(warnIfModelConfigLooksOff).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ agentId: "robby", agentDir }),
    );
  });

  it("targets the system agent when an explicit fleet selects Claude CLI", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { agentDir: "/tmp/main-agent", workspace: "/tmp/main-workspace" },
          ops: { agentDir: "/tmp/ops-agent", workspace: "/tmp/ops-workspace" },
        },
      },
    };
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
    applyAuthChoice.mockResolvedValueOnce({
      config,
      authProfiles: [],
      persistAuthProfiles: async () => {},
    });

    await runSetupModelAuthStep({
      config,
      opts: {},
      prompter: createPrompter(),
      runtime: createRuntime(),
    });

    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/main-agent", {
      allowKeychainPrompt: false,
      readOnly: true,
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "anthropic-cli",
        agentId: "main",
        agentDir: "/tmp/main-agent",
      }),
    );
    expect(promptDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        agentDir: "/tmp/main-agent",
        workspaceDir: "/tmp/main-workspace",
      }),
    );
  });

  it.each([false, true])(
    "keeps model and tool settings owned by the selected fleet agent (managed: %s)",
    async (managed) => {
      const selectedModel = managed ? "managed-local/selected" : "provider/selected";
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "ops" },
            model: { primary: "global/current" },
            models: { "global/current": { alias: "global" } },
          },
          entries: {
            ops: {
              model: { primary: "ops/current" },
              models: { "ops/current": { alias: "existing" } },
              agentDir: "/tmp/ops-agent",
              workspace: "/tmp/ops-workspace",
            },
            main: { model: { primary: "main/current" } },
          },
        },
      };
      const persistAuthProfiles = vi.fn(async () => {});
      applyAuthChoice.mockImplementationOnce(
        async ({ config: authConfig }: { config: OpenClawConfig }) => ({
          config: {
            ...authConfig,
            agents: {
              ...authConfig.agents,
              defaults: {
                ...authConfig.agents?.defaults,
                model: { primary: selectedModel },
                models: {
                  ...authConfig.agents?.defaults?.models,
                  [selectedModel]: { alias: "selected" },
                },
              },
            },
            ...(managed
              ? {
                  models: {
                    providers: {
                      "managed-local": {
                        baseUrl: "http://127.0.0.1:8080/v1",
                        models: [],
                        localService: { command: "/fixture/server" },
                      },
                    },
                  },
                }
              : {}),
          },
          authProfiles: [],
          persistAuthProfiles,
        }),
      );

      const result = await runSetupModelAuthStep({
        config,
        opts: { authChoice: "anthropic-cli" },
        prompter: createPrompter(),
        runtime: createRuntime(),
      });

      expect(applyAuthChoice).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "ops",
          config: expect.objectContaining({
            agents: expect.objectContaining({
              defaults: expect.objectContaining({
                model: { primary: "ops/current" },
                models: { "ops/current": { alias: "existing" } },
              }),
            }),
          }),
        }),
      );
      expect(result.config.agents?.defaults?.model).toEqual({ primary: "global/current" });
      expect(result.config.agents?.defaults?.models).toEqual({
        "global/current": { alias: "global" },
      });
      expect(result.config.agents?.entries?.ops?.model).toEqual({ primary: selectedModel });
      expect(result.config.agents?.entries?.ops?.models).toEqual({
        "ops/current": { alias: "existing" },
        [selectedModel]: { alias: "selected" },
      });
      expect(result.config.agents?.entries?.main?.model).toEqual({ primary: "main/current" });
      expect(result.persistAuthProfiles).toBe(persistAuthProfiles);
      expect(persistAuthProfiles).not.toHaveBeenCalled();
      const tools = ["read", "browser"].map((name) => ({
        name,
        label: name,
        description: `Fixture ${name} tool`,
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: {} }),
      }));
      expect({
        targetLean: isLocalModelLeanEnabled({ config: result.config, agentId: "ops" }),
        siblingLean: isLocalModelLeanEnabled({ config: result.config, agentId: "main" }),
        targetTools: filterLocalModelLeanTools({
          tools,
          config: result.config,
          agentId: "ops",
        }).map((tool) => tool.name),
        siblingTools: filterLocalModelLeanTools({
          tools,
          config: result.config,
          agentId: "main",
        }).map((tool) => tool.name),
        defaults: result.config.agents?.defaults,
        sibling: result.config.agents?.entries?.main,
      }).toEqual({
        targetLean: false,
        siblingLean: false,
        targetTools: ["read", "browser"],
        siblingTools: ["read", "browser"],
        defaults: config.agents?.defaults,
        sibling: config.agents?.entries?.main,
      });
    },
  );

  it("passes the explicit system agent to custom setup while preserving its existing model", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" }, model: { primary: "global/current" } },
        entries: {
          ops: { model: { primary: "ops/current" }, workspace: "/tmp/ops-workspace" },
        },
      },
    };
    promptCustomApiConfig.mockResolvedValueOnce({ config });

    const result = await runSetupModelAuthStep({
      config,
      opts: { authChoice: "custom-api-key" },
      preserveExistingModelSelection: true,
      prompter: createPrompter(),
      runtime: createRuntime(),
    });

    expect(promptCustomApiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ agentId: "ops", workspaceDir: "/tmp/ops-workspace" }),
        setAsPrimary: false,
      }),
    );
    expect(result.config.agents?.entries?.ops?.model).toEqual({ primary: "ops/current" });
    expect(result.config.agents?.defaults?.model).toEqual({ primary: "global/current" });
  });

  it("validates an interactive skip against the configured default agent", async () => {
    const config = createDefaultAgentConfig();
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");

    await runSetupModelAuthStep({
      config,
      opts: {},
      prompter: createPrompter(),
      runtime: createRuntime(),
    });

    expect(warnIfModelConfigLooksOff).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      validateCatalog: false,
    });
  });

  it("passes collected auth profiles to the model check before persistence", async () => {
    const config = createDefaultAgentConfig();
    const pendingAuthProfiles = [
      {
        profileId: "anthropic:default",
        credential: {
          type: "api_key" as const,
          provider: "anthropic",
          key: "test-anthropic-key",
        },
      },
    ];
    const persistAuthProfiles = vi.fn(async () => {});
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
    applyAuthChoice.mockResolvedValueOnce({
      config,
      authProfiles: pendingAuthProfiles,
      persistAuthProfiles,
    });

    await runSetupModelAuthStep({
      config,
      opts: {},
      prompter: createPrompter(),
      runtime: createRuntime(),
    });

    expect(warnIfModelConfigLooksOff).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      pendingAuthProfiles,
      validateCatalog: false,
    });
    expect(persistAuthProfiles).not.toHaveBeenCalled();
  });

  it("applies an interactive model selection to the agent override", async () => {
    const config = createDefaultAgentConfig();
    config.agents!.defaults!.model = "openai/global-model";
    config.agents!.entries!.ops!.model = {
      primary: "anthropic/old-model",
      fallbacks: ["openai/fallback-model"],
    };
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    promptDefaultModel.mockResolvedValueOnce({ model: "google/new-model" });

    const result = await runSetupModelAuthStep({
      config,
      opts: {},
      prompter: createPrompter(),
      runtime: createRuntime(),
    });

    expect(result.config.agents?.entries?.ops?.model).toEqual({
      primary: "google/new-model",
      fallbacks: ["openai/fallback-model"],
    });
    expect(result.config.agents?.defaults?.model).toBe("openai/global-model");
  });

  it.each([
    { selectedModel: "managed-local/selected", explicitLean: undefined },
    { selectedModel: "openai/selected", explicitLean: undefined },
    { selectedModel: "openai/selected", explicitLean: true },
    { selectedModel: "managed-local/selected", explicitLean: false },
  ])(
    "preserves explicit lean=$explicitLean when selecting $selectedModel",
    async ({ selectedModel, explicitLean }) => {
      const previousModel = "managed-local/previous";
      const config: OpenClawConfig =
        explicitLean !== undefined
          ? {
              agents: {
                defaults: { model: previousModel, experimental: { localModelLean: explicitLean } },
              },
            }
          : {};
      const preparedConfig: OpenClawConfig = {
        ...config,
        agents: { defaults: { ...config.agents?.defaults, model: "managed-local/prepared" } },
        models: {
          providers: {
            "managed-local": {
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [],
              localService: { command: "/fixture/server" },
            },
          },
        },
      };
      promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
      applyAuthChoice.mockResolvedValueOnce({
        config: preparedConfig,
        authProfiles: [],
        persistAuthProfiles: async () => {},
      });
      promptDefaultModel.mockResolvedValueOnce({ model: selectedModel });

      const result = await runSetupModelAuthStep({
        config,
        opts: {},
        prompter: createPrompter(),
        runtime: createRuntime(),
      });

      expect(result.config.agents?.defaults?.experimental?.localModelLean).toBe(explicitLean);
      expect(result.config.wizard).toBeUndefined();
      expect(config.agents?.defaults?.model).toBe(
        explicitLean !== undefined ? previousModel : undefined,
      );
    },
  );

  it.each(["skip", "__keep-current"])(
    "keeps %s free of automatic lean changes",
    async (authChoice) => {
      const config: OpenClawConfig = {
        agents: { defaults: { model: "managed-local/model" } },
        models: {
          providers: {
            "managed-local": {
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [],
              localService: { command: "/fixture/server" },
            },
          },
        },
      };
      promptAuthChoiceGrouped.mockResolvedValueOnce(authChoice);

      const result = await runSetupModelAuthStep({
        config,
        opts: {},
        prompter: createPrompter(),
        runtime: createRuntime(),
      });

      expect(result.config).toBe(config);
      expect(applyAuthChoice).not.toHaveBeenCalled();
    },
  );

  it("re-prompts after a provider setup error instead of aborting", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli").mockResolvedValueOnce("skip");
    applyAuthChoice.mockRejectedValueOnce(
      new Error("Claude CLI is not authenticated on this host."),
    );
    const prompter = createPrompter();

    const result = await runSetupModelAuthStep({
      config: {},
      opts: {},
      prompter,
      runtime: createRuntime(),
    });

    expect(result).toEqual({
      config: {},
      authProfiles: [],
      persistAuthProfiles: expect.any(Function),
    });
    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Claude CLI is not authenticated on this host."),
      "Provider setup failed",
    );
  });

  it("still fails loudly when the auth choice came from a flag", async () => {
    applyAuthChoice.mockRejectedValueOnce(
      new Error("Claude CLI is not authenticated on this host."),
    );

    await expect(
      runSetupModelAuthStep({
        config: {},
        opts: { authChoice: "anthropic-cli" },
        prompter: createPrompter(),
        runtime: createRuntime(),
      }),
    ).rejects.toThrow("Claude CLI is not authenticated");
  });

  it("propagates wizard cancellation from provider setup", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
    applyAuthChoice.mockRejectedValueOnce(new WizardCancelledError());

    await expect(
      runSetupModelAuthStep({
        config: {},
        opts: {},
        prompter: createPrompter(),
        runtime: createRuntime(),
      }),
    ).rejects.toThrow(WizardCancelledError);
  });
});
