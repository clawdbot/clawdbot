// Model auth tests cover provider auth status, expiry, and display helpers.

import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

type AuthRunCall = {
  agentDir?: string;
  signal?: AbortSignal;
  workspaceDir?: string;
};

type ResolvePluginProvidersCall = {
  activate?: boolean;
  config?: unknown;
  includeUntrustedWorkspacePlugins?: boolean;
  providerRefs?: string[];
  workspaceDir?: string;
};

type UpsertAuthProfileCall = {
  agentDir?: string;
  credential?: {
    provider?: string;
    type?: string;
  };
  profileId?: string;
};

function readMockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const value = mock.mock.calls[index]?.[0];
  if (!value) {
    throw new Error("Expected mock call argument");
  }
  return value;
}

const mocks = vi.hoisted(() => ({
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackIsCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
  clackPassword: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  isCliProvider: vi.fn(),
  upsertAuthProfile: vi.fn(),
  upsertAuthProfileAfterLoginWithLock: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(),
  removeProviderAuthProfilesWithLock: vi.fn(),
  resolvePluginProvidersCore: vi.fn(),
  createClackPrompter: vi.fn(),
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
  isRemoteEnvironment: vi.fn(() => false),
  validateAnthropicSetupToken: vi.fn<() => string | undefined>(() => undefined),
  promoteAuthProfileInOrder: vi.fn(),
  callGateway: vi.fn(),
  resolvePluginSetupProviderCore: vi.fn(),
  resolvePluginSetupRegistry: vi.fn(),
}));

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  promoteAuthProfileInOrder: mocks.promoteAuthProfileInOrder,
  removeProviderAuthProfilesWithLock: mocks.removeProviderAuthProfilesWithLock,
  upsertAuthProfile: mocks.upsertAuthProfile,
  upsertAuthProfileAfterLoginWithLockOrThrow: mocks.upsertAuthProfileAfterLoginWithLock,
  upsertAuthProfileWithLock: mocks.upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow: mocks.upsertAuthProfileWithLock,
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
  password: mocks.clackPassword,
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

vi.mock("../../agents/model-selection-cli.js", () => ({
  isCliProvider: mocks.isCliProvider,
}));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: mocks.resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry: mocks.resolvePluginSetupRegistry,
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

vi.mock("../../infra/remote-env.js", () => ({
  isRemoteEnvironment: mocks.isRemoteEnvironment,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../plugins/provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: vi.fn(() => ({
    onAuth: vi.fn(),
    onPrompt: vi.fn(),
  })),
}));

vi.mock("../auth-token.js", () => ({
  validateAnthropicSetupToken: mocks.validateAnthropicSetupToken,
}));

vi.mock("../../plugins/provider-auth-choice-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/provider-auth-choice-helpers.js")>();
  const normalize = (value: string | undefined) => value?.trim().toLowerCase() ?? "";
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
    ...actual,
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
  modelsAuthPasteApiKeyCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  runModelsAuthLoginFlowCore,
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
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
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

function withPipedStdin(input: string) {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const restoreInteractive = withInteractiveStdin();
  const previousAsyncIteratorDescriptor = Object.getOwnPropertyDescriptor(
    stdin,
    Symbol.asyncIterator,
  );
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => false,
  });
  Object.defineProperty(stdin, Symbol.asyncIterator, {
    configurable: true,
    async *value() {
      yield input;
    },
  });
  return () => {
    if (previousAsyncIteratorDescriptor) {
      Object.defineProperty(stdin, Symbol.asyncIterator, previousAsyncIteratorDescriptor);
    } else {
      Reflect.deleteProperty(stdin, Symbol.asyncIterator);
    }
    restoreInteractive();
  };
}

function createProvider(params: {
  id: string;
  label?: string;
  auth?: ProviderPlugin["auth"];
  run: NonNullable<ProviderPlugin["auth"]>[number]["run"];
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: params.auth ?? [
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
    mocks.clackPassword.mockReset();
    mocks.clackSelect.mockReset();
    mocks.clackText.mockReset();
    mocks.validateAnthropicSetupToken.mockReset();
    mocks.validateAnthropicSetupToken.mockReturnValue(undefined);
    mocks.upsertAuthProfileWithLock.mockReset();
    mocks.upsertAuthProfileWithLock.mockResolvedValue({ version: 1, profiles: {} });
    mocks.upsertAuthProfileAfterLoginWithLock.mockReset();
    mocks.upsertAuthProfileAfterLoginWithLock.mockResolvedValue(undefined);
    mocks.promoteAuthProfileInOrder.mockReset();
    mocks.removeProviderAuthProfilesWithLock.mockReset();
    mocks.removeProviderAuthProfilesWithLock.mockResolvedValue({ version: 1, profiles: {} });

    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.isRemoteEnvironment.mockReturnValue(false);
    mocks.isCliProvider.mockReturnValue(false);
    mocks.resolvePluginSetupProviderCore.mockReturnValue(undefined);
    mocks.resolvePluginSetupRegistry.mockReturnValue({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    });
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
          profileId: "openai:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
      defaultModel: "openai/gpt-5.5",
    });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        label: "OpenAI Codex",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);
    mocks.callGateway.mockReset();
    mocks.callGateway.mockResolvedValue({});
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

  it("runs plugin-owned openai login", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai" }, runtime);

    expect(runProviderAuth).toHaveBeenCalledOnce();
    const upsertCall = readMockCallArg(
      mocks.upsertAuthProfileAfterLoginWithLock,
    ) as UpsertAuthProfileCall;
    expect(upsertCall.profileId).toBe("openai:user@example.com");
    expect(upsertCall.credential?.type).toBe("oauth");
    expect(upsertCall.credential?.provider).toBe("openai");
    expect(upsertCall.agentDir).toBe("/tmp/openclaw/agents/main");
    expect(mocks.promoteAuthProfileInOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      provider: "openai",
      profileId: "openai:user@example.com",
      createIfMissing: false,
    });
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    expect(lastUpdatedConfig).toBeNull();
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai:user@example.com (openai/oauth)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai/gpt-5.5 (current default unchanged; run openclaw models set openai/gpt-5.5 to apply)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Tip: Codex-capable models can use native Codex web search. Configure the `web_search` tool with `openclaw configure --section web`. Docs: https://docs.openclaw.ai/tools/web",
    );
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "models.authStatus",
      params: { refresh: true, agentId: "main" },
      timeoutMs: 3000,
    });
  });

  it("keeps login successful when the running gateway cannot refresh auth state", async () => {
    const runtime = createRuntime();
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(modelsAuthLoginCommand({ provider: "openai" }, runtime)).resolves.toBeUndefined();

    expect(mocks.upsertAuthProfileAfterLoginWithLock).toHaveBeenCalledOnce();
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "models.authStatus",
      params: { refresh: true, agentId: "main" },
      timeoutMs: 3000,
    });
  });

  it("creates store order for relogin when configured profiles would shadow the new profile", async () => {
    const runtime = createRuntime();
    currentConfig = {
      auth: {
        profiles: {
          "openai:old-login": {
            provider: "openai",
            mode: "oauth",
          },
        },
      },
    };

    await modelsAuthLoginCommand({ provider: "openai" }, runtime);

    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.promoteAuthProfileInOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      provider: "openai",
      profileId: "openai:user@example.com",
      createIfMissing: true,
      createFromOrder: ["openai:old-login"],
    });
  });

  it("creates store order for relogin when configured order would shadow the new profile", async () => {
    const runtime = createRuntime();
    currentConfig = {
      auth: {
        order: {
          openai: ["openai:old-login"],
        },
      },
    };

    await modelsAuthLoginCommand({ provider: "openai" }, runtime);

    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.promoteAuthProfileInOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      provider: "openai",
      profileId: "openai:user@example.com",
      createIfMissing: true,
      createFromOrder: ["openai:old-login"],
    });
  });

  it("defaults OpenAI login to ChatGPT OAuth when API key is also available", async () => {
    const runtime = createRuntime();
    const initialConfig = currentConfig;
    const runOauthAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "openai:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
    });
    const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
    const select = vi.fn();
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select,
    });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        label: "OpenAI runtime",
        run: runApiKeyAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "api-key",
            label: "OpenAI API Key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
        ],
      }),
    ]);
    mocks.resolvePluginSetupProviderCore.mockReturnValue(
      createProvider({
        id: "openai",
        label: "OpenAI",
        run: runOauthAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "oauth",
            label: "ChatGPT Login",
            kind: "oauth",
            run: runOauthAuth,
          },
          {
            id: "api-key",
            label: "OpenAI API Key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
        ],
      }),
    );

    await modelsAuthLoginCommand({ provider: "openai" }, runtime);

    expect(mocks.resolvePluginSetupProviderCore).toHaveBeenCalledWith({
      provider: "openai",
      config: initialConfig,
      workspaceDir: "/tmp/openclaw/workspace",
    });
    expect(runOauthAuth).toHaveBeenCalledOnce();
    expect(runApiKeyAuth).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("honors --method api-key for OpenAI login", async () => {
    const runtime = createRuntime();
    const runOauthAuth = vi.fn().mockResolvedValue({ profiles: [] });
    const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        label: "OpenAI runtime",
        run: runApiKeyAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "api-key",
            label: "OpenAI API Key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
        ],
      }),
    ]);
    mocks.resolvePluginSetupProviderCore.mockReturnValue(
      createProvider({
        id: "openai",
        label: "OpenAI",
        run: runOauthAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "oauth",
            label: "ChatGPT Login",
            kind: "oauth",
            run: runOauthAuth,
          },
          {
            id: "api-key",
            label: "OpenAI API Key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
        ],
      }),
    );

    await modelsAuthLoginCommand({ provider: "openai", method: "api-key" }, runtime);

    expect(runOauthAuth).not.toHaveBeenCalled();
    expect(runApiKeyAuth).toHaveBeenCalledOnce();
  });

  it("rejects unknown explicit OpenAI auth methods instead of falling back to OAuth", async () => {
    const runtime = createRuntime();
    const runOauthAuth = vi.fn().mockResolvedValue({ profiles: [] });
    const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
    mocks.resolvePluginSetupProviderCore.mockReturnValue(
      createProvider({
        id: "openai",
        label: "OpenAI",
        run: runOauthAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "oauth",
            label: "ChatGPT Login",
            kind: "oauth",
            run: runOauthAuth,
          },
          {
            id: "api-key",
            label: "OpenAI API Key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
        ],
      }),
    );

    await expect(
      modelsAuthLoginCommand({ provider: "openai", method: "api_key" }, runtime),
    ).rejects.toThrow("Unknown auth method");

    expect(runOauthAuth).not.toHaveBeenCalled();
    expect(runApiKeyAuth).not.toHaveBeenCalled();
  });

  it("prompts when a provider exposes multiple non-OAuth login methods", async () => {
    const runtime = createRuntime();
    const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
    const runCliAuth = vi.fn().mockResolvedValue({ profiles: [] });
    const select = vi.fn().mockResolvedValue("cli");
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select,
    });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "anthropic",
        label: "Anthropic",
        run: runApiKeyAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "api-key",
            label: "Anthropic API Key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
          {
            id: "cli",
            label: "Claude CLI",
            kind: "custom",
            run: runCliAuth,
          },
        ],
      }),
    ]);

    await modelsAuthLoginCommand({ provider: "anthropic" }, runtime);

    expect(select).toHaveBeenCalledWith({
      message: "Auth method for Anthropic",
      options: [
        {
          value: "api-key",
          label: "Anthropic API Key",
          hint: undefined,
        },
        {
          value: "cli",
          label: "Claude CLI",
          hint: undefined,
        },
      ],
    });
    expect(runApiKeyAuth).not.toHaveBeenCalled();
    expect(runCliAuth).toHaveBeenCalledOnce();
  });

  it("uses the requested agent store for provider auth login", async () => {
    const runtime = createRuntime();
    const originalConfig = useCoderAgentConfig();

    await modelsAuthLoginCommand({ provider: "openai", agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentDir).toHaveBeenCalledWith(originalConfig, "coder");
    const authRunCall = readMockCallArg(runProviderAuth) as AuthRunCall;
    expect(authRunCall.agentDir).toBe("/tmp/openclaw/agents/coder");
    expect(authRunCall.workspaceDir).toBe("/tmp/openclaw/workspaces/coder");
    expect(
      (readMockCallArg(mocks.upsertAuthProfileAfterLoginWithLock) as UpsertAuthProfileCall)
        .agentDir,
    ).toBe("/tmp/openclaw/agents/coder");
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "models.authStatus",
      params: { refresh: true, agentId: "coder" },
      timeoutMs: 3000,
    });
  });

  it("forwards an app-owned cancellation signal to provider auth", async () => {
    const runtime = createRuntime();
    const abortController = new AbortController();

    await runModelsAuthLoginFlowCore({
      provider: "openai",
      method: "oauth",
      config: currentConfig,
      runtime,
      prompter: mocks.createClackPrompter(),
      signal: abortController.signal,
    });

    expect((readMockCallArg(runProviderAuth) as AuthRunCall).signal).toBe(abortController.signal);
  });

  it("does not persist credentials returned after app-owned cancellation", async () => {
    const runtime = createRuntime();
    const abortController = new AbortController();
    const cancellation = new Error("Login was replaced");
    runProviderAuth.mockImplementationOnce(() => {
      abortController.abort(cancellation);
      return {
        profiles: [
          {
            profileId: "openai:late@example.com",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "late-access-token",
              refresh: "late-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        ],
      };
    });

    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        method: "oauth",
        config: currentConfig,
        runtime,
        prompter: mocks.createClackPrompter(),
        signal: abortController.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileAfterLoginWithLock).not.toHaveBeenCalled();
    expect(mocks.promoteAuthProfileInOrder).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
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
    mocks.resolvePluginProvidersCore.mockImplementation(
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

    const providerResolutionCall = readMockCallArg(
      mocks.resolvePluginProvidersCore,
    ) as ResolvePluginProvidersCall;
    expect(providerResolutionCall.config).toEqual({});
    expect(providerResolutionCall.workspaceDir).toBe("/tmp/openclaw/workspace");
    expect(providerResolutionCall.includeUntrustedWorkspacePlugins).toBe(false);
    expect(providerResolutionCall.providerRefs).toEqual(["anthropic"]);
    expect(providerResolutionCall.activate).toBe(true);
    expect(runClaudeCliMigration).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
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
    mocks.resolvePluginProvidersCore.mockReturnValue([
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
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
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

  it("preserves other providers' allowlist entries on an openai OAuth login", async () => {
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
          profileId: "openai:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "a",
            refresh: "r",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
      configPatch: { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } },
      defaultModel: "openai/gpt-5.5",
    });

    await modelsAuthLoginCommand({ provider: "openai" }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual(existingModels);
  });

  it("keeps an existing primary when login omits --set-default and the patch recommends another", async () => {
    const runtime = createRuntime();
    currentConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4", fallbacks: [] },
          models: {
            "openai/gpt-5.4": {},
            "anthropic/claude-sonnet-4-6": {},
          },
        },
      },
    };
    runProviderAuth.mockResolvedValue({
      profiles: [
        {
          profileId: "openai:default",
          credential: { type: "api_key", provider: "openai", key: "sk-demo" },
        },
      ],
      configPatch: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { alias: "GPT" } },
          },
        },
      },
      defaultModel: "openai/gpt-5.5",
    });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        label: "OpenAI",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);

    await modelsAuthLoginCommand({ provider: "openai" }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: [],
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "openai/gpt-5.4": {},
      "anthropic/claude-sonnet-4-6": {},
      "openai/gpt-5.5": { alias: "GPT" },
    });
    expect(lastUpdatedConfig?.auth).toBeUndefined();
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai/gpt-5.5 (current default unchanged; run openclaw models set openai/gpt-5.5 to apply)",
    );
  });

  it("normalizes retired Google Gemini login defaults before config writes", async () => {
    const runtime = createRuntime();
    runProviderAuth.mockResolvedValue({
      profiles: [
        {
          profileId: "google:default",
          credential: { type: "api_key", provider: "google", key: "gemini-demo" },
        },
      ],
      defaultModel: "google/gemini-3-pro-preview",
    });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "google",
        label: "Google",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);

    await modelsAuthLoginCommand({ provider: "google", setDefault: true }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {},
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to google/gemini-3.1-pro-preview");
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

    await modelsAuthLoginCommand({ provider: "openai", setDefault: true }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-4-6": {},
      "openai/gpt-5.5": {},
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to openai/gpt-5.5");
  });

  it("leaves stored auth state untouched when provider login fails", async () => {
    const runtime = createRuntime();
    const loginFailure = new Error("provider rejected login");
    runProviderAuth.mockRejectedValueOnce(loginFailure);

    await expect(modelsAuthLoginCommand({ provider: "openai" }, runtime)).rejects.toBe(
      loginFailure,
    );

    expect(runProviderAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfileAfterLoginWithLock).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
  });

  it("--force purges cached profiles for the provider before login", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai", force: true }, runtime);

    expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(runProviderAuth).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('Removed cached auth profiles for provider "openai"'),
    );
  });

  it("--force does not purge when omitted", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai" }, runtime);

    expect(mocks.removeProviderAuthProfilesWithLock).not.toHaveBeenCalled();
    expect(runProviderAuth).toHaveBeenCalledOnce();
  });

  it("--force fails before login when purge throws", async () => {
    const runtime = createRuntime();
    mocks.removeProviderAuthProfilesWithLock.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      modelsAuthLoginCommand({ provider: "openai", force: true }, runtime),
    ).rejects.toThrow('Could not clear cached profiles for "openai" before re-login: disk full');

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runProviderAuth).not.toHaveBeenCalled();
  });

  it("--force fails before login when purge cannot update the profile store", async () => {
    const runtime = createRuntime();
    mocks.removeProviderAuthProfilesWithLock.mockResolvedValueOnce(null);

    await expect(
      modelsAuthLoginCommand({ provider: "openai", force: true }, runtime),
    ).rejects.toThrow(
      'Could not clear cached profiles for "openai" before re-login: profile store update failed',
    );

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runProviderAuth).not.toHaveBeenCalled();
  });

  it("--force does NOT purge cached profiles when the requested auth method is unknown", async () => {
    const runtime = createRuntime();
    const runOauthAuth = vi.fn().mockResolvedValue({ profiles: [] });
    const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
    mocks.resolvePluginSetupProviderCore.mockReturnValue(
      createProvider({
        id: "openai",
        label: "OpenAI",
        run: runOauthAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "oauth",
            label: "ChatGPT Login",
            kind: "oauth",
            run: runOauthAuth,
          },
          {
            id: "api-key",
            label: "OpenAI API Key",
            kind: "api_key",
            run: runApiKeyAuth,
          },
        ],
      }),
    );

    // Using the wrong method id ("api_key" vs the registered "api-key") forces
    // pickProviderAuthMethod to return null, which throws "Unknown auth method".
    // The purge must NOT have run, otherwise the user's working credentials
    // would be deleted before any auth flow had a chance to start.
    await expect(
      modelsAuthLoginCommand({ provider: "openai", method: "api_key", force: true }, runtime),
    ).rejects.toThrow("Unknown auth method");

    expect(mocks.removeProviderAuthProfilesWithLock).not.toHaveBeenCalled();
    expect(runOauthAuth).not.toHaveBeenCalled();
    expect(runApiKeyAuth).not.toHaveBeenCalled();
  });

  it("reports loaded plugin providers when requested provider is unavailable", async () => {
    const runtime = createRuntime();

    await expect(modelsAuthLoginCommand({ provider: "anthropic" }, runtime)).rejects.toThrow(
      'Unknown provider "anthropic". Loaded providers: openai. Verify plugins via `openclaw plugins list --json`.',
    );
  });

  it("opens the provider picker when a CLI backend has no provider auth method", async () => {
    const runtime = createRuntime();
    const prompter = {
      note: vi.fn(async () => {}),
      select: vi.fn(async () => "openai"),
    };
    mocks.createClackPrompter.mockReturnValue(prompter);
    mocks.isCliProvider.mockImplementation((provider: string) => provider === "claude-cli");
    const openaiProvider = createProvider({
      id: "openai",
      label: "OpenAI Codex",
      run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
    });
    mocks.resolvePluginProvidersCore.mockImplementation(
      (params: ResolvePluginProvidersCall | undefined) =>
        params?.providerRefs?.includes("claude-cli") ? [] : [openaiProvider],
    );

    await modelsAuthLoginCommand({ provider: "claude-cli" }, runtime);

    expect(prompter.note).toHaveBeenCalledWith(
      'Provider "claude-cli" uses its own CLI login. Select a provider with an OpenClaw auth flow.',
      "Provider auth",
    );
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select a provider" }),
    );
    expect(runProviderAuth).toHaveBeenCalledOnce();
    expect(mocks.resolvePluginProvidersCore).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerRefs: ["claude-cli"], activate: true }),
    );
    expect(mocks.resolvePluginProvidersCore).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ providerRefs: expect.anything() }),
    );
  });

  it.each(["openai-codex", "codex-cli"])(
    "rejects retired manual auth provider %s",
    async (provider) => {
      await expect(modelsAuthLoginCommand({ provider }, createRuntime())).rejects.toThrow(
        `"${provider}" is a legacy provider ID; use --provider openai.`,
      );
    },
  );

  it("does not persist a cancelled manual token entry", async () => {
    const runtime = createRuntime();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code ?? "")}`);
    }) as typeof process.exit);
    try {
      const cancelSymbol = Symbol.for("clack:cancel");
      mocks.clackPassword.mockResolvedValue(cancelSymbol);
      mocks.clackIsCancel.mockImplementation((value: unknown) => value === cancelSymbol);

      await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
        "exit:0",
      );

      expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
      expect(mocks.updateConfig).not.toHaveBeenCalled();
      expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("reads the pasted token through the masked password prompt", async () => {
    const runtime = createRuntime();
    mocks.clackPassword.mockResolvedValue("openai-token");

    await modelsAuthPasteTokenCommand({ provider: "openai" }, runtime);

    expect(mocks.clackPassword).toHaveBeenCalledTimes(1);
    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({ type: "token", token: "openai-token" }),
      }),
    );
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "models.authStatus",
      params: { refresh: true, agentId: "main" },
      timeoutMs: 3000,
    });
  });

  it("writes pasted Anthropic setup-tokens and logs the preference note", async () => {
    const runtime = createRuntime();
    mocks.clackPassword.mockResolvedValue(`sk-ant-oat01-${"a".repeat(80)}`);

    await modelsAuthPasteTokenCommand({ provider: "anthropic" }, runtime);

    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
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
    mocks.clackPassword.mockResolvedValue("openai-token");

    await modelsAuthPasteTokenCommand({ provider: "openai", agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
      profileId: "openai:manual",
      credential: {
        type: "token",
        provider: "openai",
        token: "openai-token",
      },
      agentDir: "/tmp/openclaw/agents/coder",
    });
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "models.authStatus",
      params: { refresh: true, agentId: "coder" },
      timeoutMs: 3000,
    });
  });

  it("rejects pasted token expiries that cannot fit in the Date timestamp range", async () => {
    const runtime = createRuntime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    mocks.clackPassword.mockResolvedValue("openai-token");
    try {
      await expect(
        modelsAuthPasteTokenCommand({ provider: "openai", expiresIn: "1ms" }, runtime),
      ).rejects.toThrow("resulting token expiry is outside Date range");
    } finally {
      nowSpy.mockRestore();
    }

    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("rejects OpenAI API keys pasted as OpenAI Codex token material", async () => {
    const runtime = createRuntime();
    const validateMessages: string[] = [];
    mocks.clackPassword.mockImplementation(
      async (params: { validate?: (value: string) => string | undefined }) => {
        const message = params.validate?.("sk-openai-chatgpt-api-key-value");
        if (message) {
          validateMessages.push(message);
          throw new Error(message);
        }
        return "sk-openai-chatgpt-api-key-value";
      },
    );

    await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
      "paste-api-key --provider openai",
    );

    expect(validateMessages).toEqual([
      "That looks like an OpenAI API key. Use openclaw models auth paste-api-key --provider openai for API-key auth.",
    ]);
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("rejects piped OpenAI API keys as OpenAI Codex token material", async () => {
    const runtime = createRuntime();
    restoreStdin?.();
    restoreStdin = withPipedStdin("sk-openai-chatgpt-api-key-value\n");

    await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
      "paste-api-key --provider openai",
    );

    expect(mocks.clackPassword).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("rejects line-wrapped piped OpenAI API keys as OpenAI Codex token material", async () => {
    const runtime = createRuntime();
    restoreStdin?.();
    restoreStdin = withPipedStdin("sk-openai-\nchat-api-key-value\n");

    await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
      "paste-api-key --provider openai",
    );

    expect(mocks.clackPassword).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("rejects oversized piped auth input before buffering it", async () => {
    const runtime = createRuntime();
    restoreStdin?.();
    const oversized = "x".repeat(1024 * 1024 + 1);
    restoreStdin = withPipedStdin(oversized);

    await expect(modelsAuthPasteApiKeyCommand({ provider: "openai" }, runtime)).rejects.toThrow(
      "Piped auth input exceeds 1048576 bytes.",
    );

    expect(mocks.clackPassword).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("writes pasted API keys to the requested agent store", async () => {
    const runtime = createRuntime();
    useCoderAgentConfig();
    mocks.clackPassword.mockResolvedValue("sk-openai-chatgpt-api-key-value");

    await modelsAuthPasteApiKeyCommand({ provider: "openai", agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
      profileId: "openai:manual",
      credential: {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-chatgpt-api-key-value",
      },
      agentDir: "/tmp/openclaw/agents/coder",
    });
    expect(lastUpdatedConfig?.auth?.profiles?.["openai:manual"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
    expect(runtime.log).toHaveBeenCalledWith("Auth profile: openai:manual (openai/api_key)");
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "models.authStatus",
      params: { refresh: true, agentId: "coder" },
      timeoutMs: 3000,
    });
  });

  it("writes piped OpenAI Codex API keys to API-key profiles", async () => {
    const runtime = createRuntime();
    restoreStdin?.();
    restoreStdin = withPipedStdin("sk-openai-chatgpt-api-key-value\n");

    await modelsAuthPasteApiKeyCommand({ provider: "openai" }, runtime);

    expect(mocks.clackPassword).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
      profileId: "openai:manual",
      credential: {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-chatgpt-api-key-value",
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(lastUpdatedConfig?.auth?.profiles?.["openai:manual"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("normalizes line-wrapped piped OpenAI Codex API keys before storing", async () => {
    const runtime = createRuntime();
    restoreStdin?.();
    restoreStdin = withPipedStdin("sk-openai-\nchat-api-key-value\n");

    await modelsAuthPasteApiKeyCommand({ provider: "openai" }, runtime);

    expect(mocks.clackPassword).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
      profileId: "openai:manual",
      credential: {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-chat-api-key-value",
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(lastUpdatedConfig?.auth?.profiles?.["openai:manual"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("rejects token material pasted into the OpenAI Codex API-key command", async () => {
    const runtime = createRuntime();
    const jwtLikeToken = ["eyJhbGciOiJub25l", "eyJzdWIiOiJjb2RleCJ9", "signature123456"].join(".");
    const validateMessages: string[] = [];
    mocks.clackPassword.mockImplementation(
      async (params: { validate?: (value: string) => string | undefined }) => {
        const message = params.validate?.(jwtLikeToken);
        if (message) {
          validateMessages.push(message);
          throw new Error(message);
        }
        return jwtLikeToken;
      },
    );

    await expect(modelsAuthPasteApiKeyCommand({ provider: "openai" }, runtime)).rejects.toThrow(
      "paste-token --provider openai",
    );

    expect(validateMessages).toEqual([
      "That looks like token or OAuth material, not an OpenAI API key. Use openclaw models auth paste-token --provider openai for token auth material.",
    ]);
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent before prompting for pasted tokens", async () => {
    const runtime = createRuntime();
    currentConfig = { agents: { list: [{ id: "main" }] } };

    await expect(
      modelsAuthPasteTokenCommand({ provider: "openai", agent: "missing" }, runtime),
    ).rejects.toThrow(
      'Unknown agent id "missing". Use "openclaw agents list" to see configured agents.',
    );

    expect(mocks.clackPassword).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
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
    mocks.resolvePluginProvidersCore.mockReturnValue([
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
    expect(mocks.upsertAuthProfileAfterLoginWithLock).toHaveBeenCalledWith({
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
    mocks.resolvePluginProvidersCore.mockReturnValue([
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
    const tokenAuthCall = readMockCallArg(runTokenAuth) as AuthRunCall;
    expect(tokenAuthCall.agentDir).toBe("/tmp/openclaw/agents/coder");
    expect(tokenAuthCall.workspaceDir).toBe("/tmp/openclaw/workspaces/coder");
    expect(
      (readMockCallArg(mocks.upsertAuthProfileAfterLoginWithLock) as UpsertAuthProfileCall)
        .agentDir,
    ).toBe("/tmp/openclaw/agents/coder");
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
    mocks.resolvePluginProvidersCore.mockReturnValue([
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
    const tokenAuthCall = readMockCallArg(runTokenAuth) as AuthRunCall;
    expect(tokenAuthCall.agentDir).toBe("/tmp/openclaw/agents/coder");
    expect(tokenAuthCall.workspaceDir).toBe("/tmp/openclaw/workspaces/coder");
    expect(
      (readMockCallArg(mocks.upsertAuthProfileAfterLoginWithLock) as UpsertAuthProfileCall)
        .agentDir,
    ).toBe("/tmp/openclaw/agents/coder");
  });

  it("keeps the requested agent store when interactive auth add falls back to paste-token", async () => {
    const runtime = createRuntime();
    useCoderAgentConfig();
    mocks.resolvePluginProvidersCore.mockReturnValue([]);
    mocks.clackSelect.mockResolvedValue("custom");
    mocks.clackText.mockResolvedValueOnce("openai").mockResolvedValueOnce("openai:manual");
    mocks.clackPassword.mockResolvedValue("openai-token");
    mocks.clackConfirm.mockResolvedValue(false);

    await modelsAuthAddCommand({ agent: "coder" }, runtime);

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
