import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackIsCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  upsertAuthProfile: vi.fn(),
  resolvePluginProviders: vi.fn(),
  createClackPrompter: vi.fn(),
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
  isRemoteEnvironment: vi.fn(() => false),
  loadAuthProfileStoreForRuntime: vi.fn(),
  listProfilesForProvider: vi.fn(),
  promoteAuthProfileInOrder: vi.fn(),
  clearAuthProfileCooldown: vi.fn(),
}));

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  listProfilesForProvider: mocks.listProfilesForProvider,
  promoteAuthProfileInOrder: mocks.promoteAuthProfileInOrder,
  upsertAuthProfile: mocks.upsertAuthProfile,
}));

vi.mock("../../agents/auth-profiles/store.js", () => ({
  loadAuthProfileStoreForRuntime: mocks.loadAuthProfileStoreForRuntime,
}));

vi.mock("../../agents/auth-profiles/usage.js", () => ({
  clearAuthProfileCooldown: mocks.clearAuthProfileCooldown,
}));

vi.mock("../../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig: (
    cfg: OpenClawConfig,
    params: {
      profileId: string;
      provider: string;
      mode: "api_key" | "aws-sdk" | "oauth" | "token";
      email?: string;
      displayName?: string;
    },
  ): OpenClawConfig => ({
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles: {
        ...cfg.auth?.profiles,
        [params.profileId]: {
          provider: params.provider,
          mode: params.mode,
          ...(params.email ? { email: params.email } : {}),
          ...(params.displayName ? { displayName: params.displayName } : {}),
        },
      },
    },
  }),
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.clackCancel,
  confirm: mocks.clackConfirm,
  isCancel: mocks.clackIsCancel,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  openUrl: mocks.openUrl,
}));

vi.mock("../oauth-env.js", () => ({
  isRemoteEnvironment: mocks.isRemoteEnvironment,
}));

vi.mock("../../plugins/provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: vi.fn(() => ({
    onAuth: vi.fn(),
    onPrompt: vi.fn(),
  })),
}));

vi.mock("../auth-token.js", () => ({
  validateAnthropicSetupToken: vi.fn(() => undefined),
}));

vi.mock("../../plugins/provider-auth-choice-helpers.js", () => {
  const normalize = (value: string | undefined) => value?.trim().toLowerCase() ?? "";
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value));
  const mergePatch = <T>(base: T, patch: unknown): T => {
    if (!isRecord(base) || !isRecord(patch)) {
      return patch as T;
    }
    const next: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = mergePatch(next[key], value);
    }
    return next as T;
  };

  return {
    resolveProviderMatch: vi.fn((providers: ProviderPlugin[], rawProvider?: string) => {
      const requested = normalize(rawProvider);
      return (
        providers.find((provider) => normalize(provider.id) === requested) ??
        providers.find((provider) =>
          provider.aliases?.some((alias) => normalize(alias) === requested),
        ) ??
        null
      );
    }),
    pickAuthMethod: vi.fn((provider: ProviderPlugin, rawMethod?: string) => {
      const requested = normalize(rawMethod);
      return (
        provider.auth.find((method) => normalize(method.id) === requested) ??
        provider.auth.find((method) => normalize(method.label) === requested) ??
        null
      );
    }),
    applyProviderAuthConfigPatch: vi.fn(
      (cfg: OpenClawConfig, patch: unknown, options?: { replaceDefaultModels?: boolean }) => {
        const merged = mergePatch(cfg, patch);
        if (!options?.replaceDefaultModels) {
          return merged;
        }
        const patchModels = (patch as { agents?: { defaults?: { models?: unknown } } })?.agents
          ?.defaults?.models;
        return isRecord(patchModels)
          ? {
              ...merged,
              agents: {
                ...merged.agents,
                defaults: {
                  ...merged.agents?.defaults,
                  models: patchModels,
                },
              },
            }
          : merged;
      },
    ),
    applyDefaultModel: vi.fn((cfg: OpenClawConfig, model: string) => ({
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: {
            ...cfg.agents?.defaults?.models,
            [model]: cfg.agents?.defaults?.models?.[model] ?? {},
          },
          model: {
            ...(typeof cfg.agents?.defaults?.model === "object" &&
            "fallbacks" in cfg.agents.defaults.model
              ? { fallbacks: cfg.agents.defaults.model.fallbacks }
              : undefined),
            primary: model,
          },
        },
      },
    })),
  };
});

const {
  modelsAuthAddCommand,
  modelsAuthLoginCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
} = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function withInteractiveStdin() {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => true,
  });
  return () => {
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

function createProvider(params: {
  id: string;
  label?: string;
  run: NonNullable<ProviderPlugin["auth"]>[number]["run"];
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        run: params.run,
      },
    ],
  };
}

describe("modelsAuthLoginCommand", () => {
  let restoreStdin: (() => void) | null = null;
  let currentConfig: OpenClawConfig;
  let lastUpdatedConfig: OpenClawConfig | null;
  let runProviderAuth: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreStdin = withInteractiveStdin();
    currentConfig = {};
    lastUpdatedConfig = null;
    mocks.clackCancel.mockReset();
    mocks.clackConfirm.mockReset();
    mocks.clackIsCancel.mockImplementation(
      (value: unknown) => value === Symbol.for("clack:cancel"),
    );
    mocks.clackSelect.mockReset();
    mocks.clackText.mockReset();
    mocks.upsertAuthProfile.mockReset();
    mocks.promoteAuthProfileInOrder.mockReset();

    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.isRemoteEnvironment.mockReturnValue(false);
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        lastUpdatedConfig = mutator(currentConfig);
        currentConfig = lastUpdatedConfig;
        return lastUpdatedConfig;
      },
    );
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select: vi.fn(),
    });
    runProviderAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "openai-codex:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
      defaultModel: "openai-codex/gpt-5.5",
    });
    mocks.resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "openai-codex",
        label: "OpenAI Codex",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {}, usageStats: {} });
    mocks.listProfilesForProvider.mockReturnValue([]);
    mocks.clearAuthProfileCooldown.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
  });

  function useCoderAgentConfig() {
    currentConfig = {
      agents: {
        list: [{ id: "main" }, { id: "coder", workspace: "/tmp/openclaw/workspaces/coder" }],
      },
    };
    const originalConfig = currentConfig;
    mocks.resolveAgentDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "coder" ? "/tmp/openclaw/agents/coder" : "/tmp/openclaw/agents/main",
    );
    mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "coder" ? "/tmp/openclaw/workspaces/coder" : "/tmp/openclaw/workspace",
    );
    return originalConfig;
  }

  it("runs plugin-owned openai-codex login", async () => {
    const runtime = createRuntime();
    const fakeStore = {
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
        },
      },
      usageStats: {
        "openai-codex:user@example.com": {
          disabledUntil: Date.now() + 3_600_000,
          disabledReason: "auth_permanent",
          errorCount: 3,
        },
      },
    };
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue(fakeStore);
    mocks.listProfilesForProvider.mockReturnValue(["openai-codex:user@example.com"]);

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(mocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/openclaw/agents/main", {
      externalCli: {
        mode: "scoped",
        allowKeychainPrompt: false,
        providerIds: ["openai-codex"],
      },
    });
    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledWith({
      store: fakeStore,
      profileId: "openai-codex:user@example.com",
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(mocks.clearAuthProfileCooldown.mock.invocationCallOrder[0]).toBeLessThan(
      runProviderAuth.mock.invocationCallOrder[0],
    );
    expect(runProviderAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "openai-codex:user@example.com",
      credential: expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
      }),
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(mocks.promoteAuthProfileInOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      provider: "openai-codex",
      profileId: "openai-codex:user@example.com",
    });
    expect(lastUpdatedConfig?.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:user@example.com (openai-codex/oauth)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai-codex/gpt-5.5 (use --set-default to apply)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Tip: Codex-capable models can use native Codex web search. Enable it with openclaw configure --section web (recommended mode: cached). Docs: https://docs.openclaw.ai/tools/web",
    );
  });

  it("uses the requested agent store for provider auth login", async () => {
    const runtime = createRuntime();
    const coderStore = {
      profiles: {
        "openai-codex:coder@example.com": {
          type: "oauth",
          provider: "openai-codex",
        },
      },
      usageStats: {},
    };
    const originalConfig = useCoderAgentConfig();
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue(coderStore);

    await modelsAuthLoginCommand({ provider: "openai-codex", agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentDir).toHaveBeenCalledWith(originalConfig, "coder");
    expect(mocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/coder",
      {
        externalCli: {
          mode: "scoped",
          allowKeychainPrompt: false,
          providerIds: ["openai-codex"],
        },
      },
    );
    expect(runProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/coder",
        workspaceDir: "/tmp/openclaw/workspaces/coder",
      }),
    );
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/openclaw/agents/coder" }),
    );
  });

  it("loads the owning plugin for an explicit provider even in a clean config", async () => {
    const runtime = createRuntime();
    const runClaudeCliMigration = vi.fn().mockResolvedValue({
      profiles: [],
      defaultModel: "claude-cli/claude-sonnet-4-6",
      configPatch: {
        agents: {
          defaults: {
            models: {
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
      },
    });
    mocks.resolvePluginProviders.mockImplementation(
      (params: { activate?: boolean; providerRefs?: string[] } | undefined) =>
        params?.activate === true && params?.providerRefs?.[0] === "anthropic"
          ? [
              {
                id: "anthropic",
                label: "Anthropic",
                auth: [
                  {
                    id: "cli",
                    label: "Claude CLI",
                    kind: "custom",
                    run: runClaudeCliMigration,
                  },
                ],
              },
            ]
          : [],
    );

    await modelsAuthLoginCommand(
      { provider: "anthropic", method: "cli", setDefault: true },
      runtime,
    );

    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        workspaceDir: "/tmp/openclaw/workspace",
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
        includeUntrustedWorkspacePlugins: false,
        providerRefs: ["anthropic"],
        activate: true,
      }),
    );
    expect(runClaudeCliMigration).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "claude-cli/claude-sonnet-4-6",
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "claude-cli/claude-sonnet-4-6": {},
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to claude-cli/claude-sonnet-4-6");
  });

  it("runs the requested anthropic cli auth method with the full login context", async () => {
    const runtime = createRuntime();
    currentConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };
    const note = vi.fn(async () => {});
    const select = vi.fn();
    mocks.createClackPrompter.mockReturnValue({
      note,
      select,
    });
    const runApiKeyAuth = vi.fn();
    const runClaudeCliMigration = vi.fn().mockImplementation(async (ctx) => {
      expect(ctx.config).toEqual(currentConfig);
      expect(ctx.agentDir).toBe("/tmp/openclaw/agents/main");
      expect(ctx.workspaceDir).toBe("/tmp/openclaw/workspace");
      expect(ctx.prompter.note).toBe(note);
      expect(ctx.prompter.select).toBe(select);
      expect(ctx.runtime).toBe(runtime);
      expect(ctx.env).toBe(process.env);
      expect(ctx.allowSecretRefPrompt).toBe(false);
      expect(ctx.isRemote).toBe(false);
      await ctx.openUrl("https://example.com/auth");
      expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/auth");
      expect(ctx.oauth.createVpsAwareHandlers).toBeTypeOf("function");
      return {
        profiles: [],
        defaultModel: "claude-cli/claude-sonnet-4-6",
        configPatch: {
          agents: {
            defaults: {
              model: {
                primary: "claude-cli/claude-sonnet-4-6",
                fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
              },
              models: {
                "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
                "claude-cli/claude-opus-4-6": { alias: "Opus" },
                "openai/gpt-5.2": {},
              },
            },
          },
        },
        replaceDefaultModels: true,
        notes: [
          "Claude CLI auth detected; switched Anthropic model selection to the local Claude CLI backend.",
          "Existing Anthropic auth profiles are kept for rollback.",
        ],
      };
    });
    const fakeStore = {
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "anthropic",
        },
        "anthropic:legacy": {
          type: "token",
          provider: "anthropic",
        },
      },
      usageStats: {
        "anthropic:claude-cli": {
          disabledUntil: Date.now() + 3_600_000,
          disabledReason: "auth_permanent",
          errorCount: 2,
        },
      },
    };
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue(fakeStore);
    mocks.listProfilesForProvider.mockReturnValue(["anthropic:claude-cli", "anthropic:legacy"]);
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [
          {
            id: "cli",
            label: "Claude CLI",
            kind: "custom",
            run: runClaudeCliMigration,
          },
          {
            id: "api-key",
            label: "Anthropic API key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
        ],
      },
    ]);

    await modelsAuthLoginCommand(
      { provider: "anthropic", method: "cli", setDefault: true },
      runtime,
    );

    expect(runClaudeCliMigration).toHaveBeenCalledOnce();
    expect(runApiKeyAuth).not.toHaveBeenCalled();
    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledTimes(2);
    expect(mocks.clearAuthProfileCooldown).toHaveBeenNthCalledWith(1, {
      store: fakeStore,
      profileId: "anthropic:claude-cli",
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(mocks.clearAuthProfileCooldown).toHaveBeenNthCalledWith(2, {
      store: fakeStore,
      profileId: "anthropic:legacy",
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(
      mocks.clearAuthProfileCooldown.mock.invocationCallOrder.every(
        (order) => order < runClaudeCliMigration.mock.invocationCallOrder[0],
      ),
    ).toBe(true);
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "claude-cli/claude-sonnet-4-6",
      fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
      "claude-cli/claude-opus-4-6": { alias: "Opus" },
      "openai/gpt-5.2": {},
    });
    expect(note).toHaveBeenCalledWith(
      [
        "Claude CLI auth detected; switched Anthropic model selection to the local Claude CLI backend.",
        "Existing Anthropic auth profiles are kept for rollback.",
      ].join("\n"),
      "Provider notes",
    );
    expect(runtime.log).toHaveBeenCalledWith("Default model set to claude-cli/claude-sonnet-4-6");
  });

  it("preserves other providers' allowlist entries on an openai-codex OAuth login", async () => {
    const runtime = createRuntime();
    const existingModels = {
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      "anthropic/claude-opus-4-6": { alias: "opus" },
      "moonshot/kimi-k2.5": { alias: "kimi" },
      "openai/gpt-5.5": { alias: "gpt55" },
    };
    currentConfig = { agents: { defaults: { models: existingModels } } };
    runProviderAuth.mockResolvedValue({
      profiles: [
        {
          profileId: "openai-codex:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: "a",
            refresh: "r",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
      configPatch: { agents: { defaults: { models: { "openai-codex/gpt-5.5": {} } } } },
      defaultModel: "openai-codex/gpt-5.5",
    });

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      ...existingModels,
      "openai-codex/gpt-5.5": {},
    });
  });

  it("overwrites an existing primary when login uses --set-default", async () => {
    const runtime = createRuntime();
    currentConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: { "anthropic/claude-opus-4-6": {} },
        },
      },
    };

    await modelsAuthLoginCommand({ provider: "openai-codex", setDefault: true }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.5",
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-4-6": {},
      "openai-codex/gpt-5.5": {},
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to openai-codex/gpt-5.5");
  });

  it("survives lockout clearing failure without blocking login", async () => {
    const runtime = createRuntime();
    mocks.loadAuthProfileStoreForRuntime.mockImplementation(() => {
      throw new Error("corrupt auth-profiles.json");
    });

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(runProviderAuth).toHaveBeenCalledOnce();
  });

  it("reports loaded plugin providers when requested provider is unavailable", async () => {
    const runtime = createRuntime();

    await expect(modelsAuthLoginCommand({ provider: "anthropic" }, runtime)).rejects.toThrow(
      'Unknown provider "anthropic". Loaded providers: openai-codex. Verify plugins via `openclaw plugins list --json`.',
    );
  });

  it("does not persist a cancelled manual token entry", async () => {
    const runtime = createRuntime();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code ?? "")}`);
    }) as typeof process.exit);
    try {
      const cancelSymbol = Symbol.for("clack:cancel");
      mocks.clackText.mockResolvedValue(cancelSymbol);
      mocks.clackIsCancel.mockImplementation((value: unknown) => value === cancelSymbol);

      await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
        "exit:0",
      );

      expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
      expect(mocks.updateConfig).not.toHaveBeenCalled();
      expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("writes pasted Anthropic setup-tokens and logs the preference note", async () => {
    const runtime = createRuntime();
    mocks.clackText.mockResolvedValue(`sk-ant-oat01-${"a".repeat(80)}`);

    await modelsAuthPasteTokenCommand({ provider: "anthropic" }, runtime);

    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "anthropic:manual",
      credential: {
        type: "token",
        provider: "anthropic",
        token: `sk-ant-oat01-${"a".repeat(80)}`,
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Anthropic setup-token auth is supported in OpenClaw.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "OpenClaw prefers Claude CLI reuse when it is available on the host.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Anthropic staff told us this OpenClaw path is allowed again.",
    );
  });

  it("writes pasted tokens to the requested agent store", async () => {
    const runtime = createRuntime();
    useCoderAgentConfig();
    mocks.clackText.mockResolvedValue("openai-token");

    await modelsAuthPasteTokenCommand({ provider: "openai", agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "openai:manual",
      credential: {
        type: "token",
        provider: "openai",
        token: "openai-token",
      },
      agentDir: "/tmp/openclaw/agents/coder",
    });
  });

  it("rejects an unknown agent before prompting for pasted tokens", async () => {
    const runtime = createRuntime();
    currentConfig = { agents: { list: [{ id: "main" }] } };

    await expect(
      modelsAuthPasteTokenCommand({ provider: "openai", agent: "missing" }, runtime),
    ).rejects.toThrow(
      'Unknown agent id "missing". Use "openclaw agents list" to see configured agents.',
    );

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("runs token auth for any token-capable provider plugin", async () => {
    const runtime = createRuntime();
    const runTokenAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "moonshot:token",
          credential: {
            type: "token",
            provider: "moonshot",
            token: "moonshot-token",
          },
        },
      ],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "moonshot",
        label: "Moonshot",
        auth: [
          {
            id: "setup-token",
            label: "setup-token",
            kind: "token",
            run: runTokenAuth,
          },
        ],
      },
    ]);

    await modelsAuthSetupTokenCommand({ provider: "moonshot", yes: true }, runtime);

    expect(runTokenAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "moonshot:token",
      credential: {
        type: "token",
        provider: "moonshot",
        token: "moonshot-token",
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
  });

  it("uses the requested agent store for setup-token provider auth", async () => {
    const runtime = createRuntime();
    useCoderAgentConfig();
    const runTokenAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "moonshot:token",
          credential: {
            type: "token",
            provider: "moonshot",
            token: "moonshot-token",
          },
        },
      ],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "moonshot",
        label: "Moonshot",
        auth: [
          {
            id: "setup-token",
            label: "setup-token",
            kind: "token",
            run: runTokenAuth,
          },
        ],
      },
    ]);

    await modelsAuthSetupTokenCommand({ provider: "moonshot", yes: true, agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(runTokenAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/coder",
        workspaceDir: "/tmp/openclaw/workspaces/coder",
      }),
    );
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/openclaw/agents/coder" }),
    );
  });

  it("uses the requested agent store for interactive token auth add", async () => {
    const runtime = createRuntime();
    useCoderAgentConfig();
    const runTokenAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "moonshot:token",
          credential: {
            type: "token",
            provider: "moonshot",
            token: "moonshot-token",
          },
        },
      ],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "moonshot",
        label: "Moonshot",
        auth: [
          {
            id: "setup-token",
            label: "setup-token",
            kind: "token",
            run: runTokenAuth,
          },
        ],
      },
    ]);
    mocks.clackSelect.mockResolvedValueOnce("moonshot").mockResolvedValueOnce("setup-token");

    await modelsAuthAddCommand({ agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(runTokenAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/coder",
        workspaceDir: "/tmp/openclaw/workspaces/coder",
      }),
    );
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/openclaw/agents/coder" }),
    );
  });

  it("keeps the requested agent store when interactive auth add falls back to paste-token", async () => {
    const runtime = createRuntime();
    useCoderAgentConfig();
    mocks.resolvePluginProviders.mockReturnValue([]);
    mocks.clackSelect.mockResolvedValue("custom");
    mocks.clackText
      .mockResolvedValueOnce("openai")
      .mockResolvedValueOnce("openai:manual")
      .mockResolvedValueOnce("openai-token");
    mocks.clackConfirm.mockResolvedValue(false);

    await modelsAuthAddCommand({ agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "openai:manual",
      credential: {
        type: "token",
        provider: "openai",
        token: "openai-token",
      },
      agentDir: "/tmp/openclaw/agents/coder",
    });
  });
});
