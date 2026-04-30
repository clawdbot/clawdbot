import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { Mock } from "vitest";
import { expect, vi } from "vitest";

export type NativeCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

export type PluginCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

type ProviderMonitorTestMocks = {
  clientDeployCommandsMock: Mock<(options?: { mode?: string }) => Promise<void>>;
  clientFetchUserMock: Mock<(target: string) => Promise<{ id: string }>>;
  clientGetPluginMock: Mock<(name: string) => unknown>;
  clientConstructorOptionsMock: Mock<(options?: unknown) => void>;
  createDiscordAutoPresenceControllerMock: Mock<() => unknown>;
  createDiscordExecApprovalButtonContextMock: Mock<
    (params?: {
      cfg?: OpenClawConfig;
      accountId?: string;
      config?: unknown;
      gatewayUrl?: string;
    }) => { getApprovers: () => string[]; resolveApproval: () => Promise<boolean> }
  >;
  createExecApprovalButtonMock: Mock<(ctx?: unknown) => unknown>;
  createDiscordNativeCommandMock: Mock<(params?: { command?: { name?: string } }) => unknown>;
  createDiscordMessageHandlerMock: Mock<() => unknown>;
  createNoopThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  createThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  reconcileAcpThreadBindingsOnStartupMock: Mock<() => unknown>;
  createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }>;
  getAcpSessionStatusMock: Mock<
    (params: {
      cfg: OpenClawConfig;
      sessionKey: string;
      signal?: AbortSignal;
    }) => Promise<{ state: string }>
  >;
  getPluginCommandSpecsMock: Mock<(provider?: string) => PluginCommandSpecMock[]>;
  listNativeCommandSpecsForConfigMock: Mock<
    (
      cfg?: unknown,
      params?: { skillCommands?: unknown[]; provider?: string },
    ) => NativeCommandSpecMock[]
  >;
  listSkillCommandsForAgentsMock: Mock<
    (params?: { cfg?: unknown; agentIds?: string[] }) => unknown[]
  >;
  monitorLifecycleMock: Mock<(params: { threadBindings: { stop: () => void } }) => Promise<void>>;
  resolveDiscordAccountMock: Mock<
    (params?: { cfg?: unknown; accountId?: string | null; token?: string | null }) => unknown
  >;
  resolveDiscordAllowlistConfigMock: Mock<() => Promise<unknown>>;
  resolveNativeCommandsEnabledMock: Mock<(params?: unknown) => boolean>;
  resolveNativeSkillsEnabledMock: Mock<(params?: unknown) => boolean>;
  isVerboseMock: Mock<() => boolean>;
  shouldLogVerboseMock: Mock<() => boolean>;
  voiceRuntimeModuleLoadedMock: Mock<() => void>;
};

export function baseDiscordAccountConfig() {
  return {
    commands: { native: true, nativeSkills: false },
    voice: { enabled: false },
    agentComponents: { enabled: false },
    execApprovals: { enabled: false },
  };
}

const providerMonitorTestMocks: ProviderMonitorTestMocks = vi.hoisted(() => {
  const createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const isVerboseMock = vi.fn(() => false);
  const shouldLogVerboseMock = vi.fn(() => false);

  return {
    clientDeployCommandsMock: vi.fn(async () => undefined),
    clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: vi.fn<(_name: string) => unknown>(() => undefined),
    clientConstructorOptionsMock: vi.fn(),
    createDiscordAutoPresenceControllerMock: vi.fn(() => ({
      enabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
      runNow: vi.fn(),
    })),
    createDiscordExecApprovalButtonContextMock: vi.fn(() => ({
      getApprovers: () => [],
      resolveApproval: async () => false,
    })),
    createExecApprovalButtonMock: vi.fn(() => ({ id: "exec-approval" })),
    createDiscordNativeCommandMock: vi.fn((params?: { command?: { name?: string } }) => ({
      name: params?.command?.name ?? "mock-command",
    })),
    createDiscordMessageHandlerMock: vi.fn(() =>
      Object.assign(
        vi.fn(async () => undefined),
        {
          deactivate: vi.fn(),
        },
      ),
    ),
    createNoopThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    reconcileAcpThreadBindingsOnStartupMock: vi.fn(() => ({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    })),
    createdBindingManagers,
    getAcpSessionStatusMock: vi.fn(
      async (_params: { cfg: OpenClawConfig; sessionKey: string; signal?: AbortSignal }) => ({
        state: "idle",
      }),
    ),
    getPluginCommandSpecsMock: vi.fn<(provider?: string) => PluginCommandSpecMock[]>(() => []),
    listNativeCommandSpecsForConfigMock: vi.fn<
      (
        cfg?: unknown,
        params?: { skillCommands?: unknown[]; provider?: string },
      ) => NativeCommandSpecMock[]
    >(() => [{ name: "cmd", description: "built-in", acceptsArgs: false }]),
    listSkillCommandsForAgentsMock: vi.fn<
      (params?: { cfg?: unknown; agentIds?: string[] }) => unknown[]
    >(() => []),
    monitorLifecycleMock: vi.fn(async (params: { threadBindings: { stop: () => void } }) => {
      params.threadBindings.stop();
    }),
    resolveDiscordAccountMock: vi.fn((_) => ({
      accountId: "default",
      token: "cfg-token",
      config: baseDiscordAccountConfig(),
    })),
    resolveDiscordAllowlistConfigMock: vi.fn(async () => ({
      guildEntries: undefined,
      allowFrom: undefined,
    })),
    resolveNativeCommandsEnabledMock: vi.fn((_params) => true),
    resolveNativeSkillsEnabledMock: vi.fn((_params) => false),
    isVerboseMock,
    shouldLogVerboseMock,
    voiceRuntimeModuleLoadedMock: vi.fn(),
  };
});

function buildDiscordSourceModuleId(artifactBasename: string): string {
  return `../${artifactBasename}`;
}

const {
  clientDeployCommandsMock,
  clientFetchUserMock,
  clientGetPluginMock,
  clientConstructorOptionsMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordExecApprovalButtonContextMock,
  createExecApprovalButtonMock,
  createDiscordNativeCommandMock,
  createDiscordMessageHandlerMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartupMock,
  createdBindingManagers,
  getAcpSessionStatusMock,
  getPluginCommandSpecsMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  isVerboseMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = providerMonitorTestMocks;

export function getProviderMonitorTestMocks(): typeof providerMonitorTestMocks {
  return providerMonitorTestMocks;
}

export function mockResolvedDiscordAccountConfig(overrides: Record<string, unknown>) {
  resolveDiscordAccountMock.mockImplementation(() => ({
    accountId: "default",
    token: "cfg-token",
    config: {
      ...baseDiscordAccountConfig(),
      ...overrides,
    },
  }));
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe handler params shape.
export function getFirstDiscordMessageHandlerParams<T extends object>() {
  expect(createDiscordMessageHandlerMock).toHaveBeenCalledTimes(1);
  const firstCall = createDiscordMessageHandlerMock.mock.calls.at(0) as [T] | undefined;
  return firstCall?.[0];
}

export function resetDiscordProviderMonitorMocks(params?: {
  nativeCommands?: NativeCommandSpecMock[];
}) {
  clientDeployCommandsMock.mockClear().mockResolvedValue(undefined);
  clientFetchUserMock.mockClear().mockResolvedValue({ id: "bot-1" });
  clientGetPluginMock.mockClear().mockReturnValue(undefined);
  clientConstructorOptionsMock.mockClear();
  createDiscordAutoPresenceControllerMock.mockClear().mockImplementation(() => ({
    enabled: false,
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
    runNow: vi.fn(),
  }));
  createDiscordExecApprovalButtonContextMock.mockClear().mockImplementation(() => ({
    getApprovers: () => [],
    resolveApproval: async () => false,
  }));
  createExecApprovalButtonMock.mockClear().mockImplementation(() => ({ id: "exec-approval" }));
  createDiscordNativeCommandMock.mockClear().mockImplementation((input) => ({
    name: input?.command?.name ?? "mock-command",
  }));
  createDiscordMessageHandlerMock.mockClear().mockImplementation(() =>
    Object.assign(
      vi.fn(async () => undefined),
      {
        deactivate: vi.fn(),
      },
    ),
  );
  createNoopThreadBindingManagerMock.mockClear();
  createThreadBindingManagerMock.mockClear();
  reconcileAcpThreadBindingsOnStartupMock.mockClear().mockReturnValue({
    checked: 0,
    removed: 0,
    staleSessionKeys: [],
  });
  createdBindingManagers.length = 0;
  getAcpSessionStatusMock.mockClear().mockResolvedValue({ state: "idle" });
  getPluginCommandSpecsMock.mockClear().mockReturnValue([]);
  listNativeCommandSpecsForConfigMock
    .mockClear()
    .mockReturnValue(
      params?.nativeCommands ?? [{ name: "cmd", description: "built-in", acceptsArgs: false }],
    );
  listSkillCommandsForAgentsMock.mockClear().mockReturnValue([]);
  monitorLifecycleMock.mockClear().mockImplementation(async (monitorParams) => {
    monitorParams.threadBindings.stop();
  });
  resolveDiscordAccountMock.mockClear().mockReturnValue({
    accountId: "default",
    token: "cfg-token",
    config: baseDiscordAccountConfig(),
  });
  resolveDiscordAllowlistConfigMock.mockClear().mockResolvedValue({
    guildEntries: undefined,
    allowFrom: undefined,
  });
  resolveNativeCommandsEnabledMock.mockClear().mockReturnValue(true);
  resolveNativeSkillsEnabledMock.mockClear().mockReturnValue(false);
  isVerboseMock.mockClear().mockReturnValue(false);
  shouldLogVerboseMock.mockClear().mockReturnValue(false);
  voiceRuntimeModuleLoadedMock.mockClear();
}

export const baseRuntime = (): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

export const baseConfig = (): OpenClawConfig =>
  ({
    channels: {
      discord: {
        accounts: {
          default: {
            token: "MTIz.abc.def",
          },
        },
      },
    },
  }) as OpenClawConfig;

vi.mock("../internal/discord.js", async () => {
  const actual =
    await vi.importActual<typeof import("../internal/discord.js")>("../internal/discord.js");
  class RateLimitError extends Error {
    status = 429;
    discordCode?: number;
    retryAfter: number;
    scope: string | null;
    bucket: string | null;
    constructor(
      response: Response,
      body: { message: string; retry_after: number; global: boolean },
    ) {
      super(body.message);
      this.retryAfter = body.retry_after;
      this.scope = body.global ? "global" : response.headers.get("X-RateLimit-Scope");
      this.bucket = response.headers.get("X-RateLimit-Bucket");
    }
  }
  class Client {
    listeners: unknown[];
    rest: {
      get: ReturnType<typeof vi.fn>;
      post: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
      patch: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    options: unknown;
    constructor(options: unknown, handlers: { listeners?: unknown[] }) {
      this.options = options;
      this.listeners = handlers.listeners ?? [];
      this.rest = {
        get: vi.fn(async () => undefined),
        post: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
        patch: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      };
      clientConstructorOptionsMock(options);
    }
    async deployCommands(options?: { mode?: string }) {
      return await clientDeployCommandsMock(options);
    }
    async fetchUser(target: string) {
      return await clientFetchUserMock(target);
    }
    getPlugin(name: string) {
      return clientGetPluginMock(name);
    }
  }
  return { ...actual, Client, RateLimitError };
});

vi.mock("../internal/gateway.js", () => ({
  GatewayCloseCodes: { DisallowedIntents: 4014 },
}));

vi.mock("../internal/voice.js", () => ({
  VoicePlugin: function VoicePlugin() {},
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  return {
    ...actual,
    getAcpSessionManager: () => ({
      getSessionStatus: getAcpSessionStatusMock,
    }),
    isAcpRuntimeError: (error: unknown): error is { code: string } =>
      error instanceof Error && "code" in error,
  };
});

vi.mock("openclaw/plugin-sdk/command-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/command-auth")>(
    "openclaw/plugin-sdk/command-auth",
  );
  return {
    ...actual,
    listNativeCommandSpecsForConfig: listNativeCommandSpecsForConfigMock,
    listSkillCommandsForAgents: listSkillCommandsForAgentsMock,
  };
});
vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    resolveTextChunkLimit: () => 2000,
  };
});

vi.mock("openclaw/plugin-sdk/native-command-config-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/native-command-config-runtime")
  >("openclaw/plugin-sdk/native-command-config-runtime");
  return {
    ...actual,
    isNativeCommandsExplicitlyDisabled: () => false,
    resolveNativeCommandsEnabled: resolveNativeCommandsEnabledMock,
    resolveNativeSkillsEnabled: resolveNativeSkillsEnabledMock,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: () => ({}),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    danger: (value: string) => value,
    isVerbose: isVerboseMock,
    logVerbose: vi.fn(),
    shouldLogVerbose: shouldLogVerboseMock,
    warn: (value: string) => value,
    createSubsystemLogger: () => {
      const logger = {
        child: vi.fn(() => logger),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };
      return logger;
    },
    createNonExitingRuntime: () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }),
  };
});

vi.mock("openclaw/plugin-sdk/error-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/error-runtime")>(
    "openclaw/plugin-sdk/error-runtime",
  );
  return {
    ...actual,
    formatErrorMessage: (error: unknown) => String(error),
  };
});

vi.mock(buildDiscordSourceModuleId("accounts.js"), () => ({
  resolveDiscordAccount: resolveDiscordAccountMock,
}));

vi.mock(buildDiscordSourceModuleId("probe.js"), () => ({
  fetchDiscordApplicationId: async () => "app-1",
  parseApplicationIdFromToken: (token: string) => {
    const segment = token.trim().split(".")[0];
    if (!segment) {
      return undefined;
    }
    try {
      const decoded = Buffer.from(segment, "base64url").toString("utf8").trim();
      return /^\d+$/.test(decoded) ? decoded : undefined;
    } catch {
      return undefined;
    }
  },
}));

vi.mock(buildDiscordSourceModuleId("token.js"), () => ({
  normalizeDiscordToken: (value?: string) => value,
}));

vi.mock(buildDiscordSourceModuleId("voice/command.js"), () => ({
  createDiscordVoiceCommand: () => ({ name: "voice-command" }),
}));

vi.mock(buildDiscordSourceModuleId("monitor/agent-components.js"), () => ({
  createAgentComponentButton: () => ({ id: "btn" }),
  createAgentSelectMenu: () => ({ id: "menu" }),
  createDiscordComponentButton: () => ({ id: "btn2" }),
  createDiscordComponentChannelSelect: () => ({ id: "channel" }),
  createDiscordComponentMentionableSelect: () => ({ id: "mentionable" }),
  createDiscordComponentModal: () => ({ id: "modal" }),
  createDiscordComponentRoleSelect: () => ({ id: "role" }),
  createDiscordComponentStringSelect: () => ({ id: "string" }),
  createDiscordComponentUserSelect: () => ({ id: "user" }),
}));

vi.mock(buildDiscordSourceModuleId("monitor/auto-presence.js"), () => ({
  createDiscordAutoPresenceController: createDiscordAutoPresenceControllerMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/commands.js"), () => ({
  resolveDiscordSlashCommandConfig: () => ({ ephemeral: false }),
}));

vi.mock(buildDiscordSourceModuleId("monitor/exec-approvals.js"), () => ({
  createExecApprovalButton: createExecApprovalButtonMock,
  createDiscordExecApprovalButtonContext: createDiscordExecApprovalButtonContextMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/gateway-plugin.js"), () => ({
  createDiscordGatewayPlugin: () => ({ id: "gateway-plugin" }),
  waitForDiscordGatewayPluginRegistration: () => undefined,
}));

vi.mock(buildDiscordSourceModuleId("monitor/listeners.js"), () => ({
  DiscordInteractionListener: function DiscordInteractionListener() {},
  DiscordMessageListener: function DiscordMessageListener() {},
  DiscordPresenceListener: function DiscordPresenceListener() {},
  DiscordReactionListener: function DiscordReactionListener() {},
  DiscordReactionRemoveListener: function DiscordReactionRemoveListener() {},
  DiscordThreadUpdateListener: function DiscordThreadUpdateListener() {},
  registerDiscordListener: vi.fn(),
}));

vi.mock(buildDiscordSourceModuleId("monitor/message-handler.js"), () => ({
  createDiscordMessageHandler: createDiscordMessageHandlerMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/native-command.js"), () => ({
  createDiscordCommandArgFallbackButton: () => ({ id: "arg-fallback" }),
  createDiscordModelPickerFallbackButton: () => ({ id: "model-fallback-btn" }),
  createDiscordModelPickerFallbackSelect: () => ({ id: "model-fallback-select" }),
  createDiscordNativeCommand: createDiscordNativeCommandMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/presence.js"), () => ({
  resolveDiscordPresenceUpdate: () => undefined,
}));

vi.mock(buildDiscordSourceModuleId("monitor/provider.allowlist.js"), () => ({
  resolveDiscordAllowlistConfig: resolveDiscordAllowlistConfigMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/provider.lifecycle.js"), () => ({
  runDiscordGatewayLifecycle: monitorLifecycleMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/rest-fetch.js"), () => ({
  resolveDiscordRestFetch: () => async () => {
    throw new Error("offline");
  },
}));

vi.mock(buildDiscordSourceModuleId("monitor/thread-bindings.js"), () => ({
  createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
  createThreadBindingManager: createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartup: reconcileAcpThreadBindingsOnStartupMock,
  resolveThreadBindingIdleTimeoutMs: vi.fn(() => 24 * 60 * 60 * 1000),
}));
