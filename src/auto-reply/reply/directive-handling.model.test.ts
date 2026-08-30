// Tests model directive handling, auth profiles, and persisted provider overrides.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "../../plugins/provider-thinking.types.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";

const authProfilesStoreMock = vi.hoisted(() => ({
  profiles: {} as Record<
    string,
    | { type: "api_key"; provider: string; key: string }
    | { type: "oauth"; provider: string; access: string; refresh: string; expires: number }
    | { type: "token"; provider: string; token: string }
  >,
}));
const modelsCommandMock = vi.hoisted(() => ({
  delegateToActual: false,
  resolveModelsCommandReply: vi.fn(),
}));
const stickyModelMock = vi.hoisted(() => ({
  persistBestEffort: vi.fn(),
}));
const pluginPolicyMock = vi.hoisted(() => ({
  channels: new Map<string, Pick<ChannelPlugin, "id" | "commands">>(),
  thinkingProfiles: new Map<
    string,
    (context: ProviderDefaultThinkingPolicyContext) => ProviderThinkingProfile | null | undefined
  >(),
}));

function defaultModelsCommandReply() {
  return {
    text: [
      "Providers:",
      "- anthropic (1)",
      "",
      "Use: /models <provider>",
      "Switch: /model <provider/model>",
    ].join("\n"),
  };
}

function normalizeProviderForAuthTest(provider: string) {
  return provider.trim().toLowerCase();
}

function hasAllowedPluginForAuthTest(cfg: unknown, pluginId: string): boolean {
  if (!cfg || typeof cfg !== "object" || !("plugins" in cfg)) {
    return false;
  }
  const plugins = (cfg as { plugins?: { allow?: unknown } }).plugins;
  return Array.isArray(plugins?.allow) && plugins.allow.includes(pluginId);
}

vi.mock("../../agents/auth-profiles.js", () => {
  const store = () => ({
    version: 1,
    profiles: authProfilesStoreMock.profiles,
  });
  return {
    clearRuntimeAuthProfileStoreSnapshots: () => {
      authProfilesStoreMock.profiles = {};
    },
    externalCliDiscoveryForProviderAuth: () => ({
      mode: "scoped",
      allowKeychainPrompt: false,
    }),
    ensureAuthProfileStore: store,
    ensureAuthProfileStoreWithoutExternalProfiles: store,
    getRuntimeAuthProfileStoreSnapshot: store,
    isProfileInCooldown: () => false,
    listProfilesForProvider: (_store: unknown, provider: string) =>
      Object.entries(authProfilesStoreMock.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId, profile]) => ({ profileId, profile })),
    replaceRuntimeAuthProfileStoreSnapshots: (
      snapshots: Array<{
        store?: { profiles?: Record<string, AuthProfileForTest> };
      }>,
    ) => {
      authProfilesStoreMock.profiles = snapshots[0]?.store?.profiles ?? {};
    },
    resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
    resolveAuthProfileOrder: () => [],
    resolveAuthStorePathForDisplay: () => "/tmp/auth-profiles.json",
  };
});

vi.mock("./commands-models.js", () => ({
  resolveModelsCommandReply: async (
    params: Parameters<typeof import("./commands-models.js").resolveModelsCommandReply>[0],
  ) => {
    modelsCommandMock.resolveModelsCommandReply(params);
    if (modelsCommandMock.delegateToActual) {
      const actual =
        await vi.importActual<typeof import("./commands-models.js")>("./commands-models.js");
      return actual.resolveModelsCommandReply(params);
    }
    return defaultModelsCommandReply();
  },
}));

vi.mock("../../agents/sticky-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sticky-model-selection.js")>()),
  persistStickyModelSelectionBestEffort: (params: {
    agentId: string;
    model: string;
    target?: "agent" | "defaults";
  }) => stickyModelMock.persistBestEffort(params),
}));

vi.mock("./directive-handling.auth.js", () => ({
  formatAuthLabel: (auth: { label: string; source: string }) => {
    if (!auth.source || auth.source === auth.label || auth.source === "missing") {
      return auth.label;
    }
    return `${auth.label} (${auth.source})`;
  },
  resolveAuthLabel: async (
    provider: string,
    cfg: unknown,
    _modelsPath: string,
    _agentDir?: string,
    _mode?: unknown,
    workspaceDir?: string,
    options?: { acceptedProfileTypes?: readonly string[] },
  ) => {
    const providerKey = normalizeProviderForAuthTest(provider);
    const acceptedProfileTypes = options?.acceptedProfileTypes
      ? new Set(options.acceptedProfileTypes)
      : undefined;
    const matchingProfiles = Object.entries(authProfilesStoreMock.profiles).filter(
      ([, profile]) =>
        normalizeProviderForAuthTest(profile.provider) === providerKey &&
        (!acceptedProfileTypes || acceptedProfileTypes.has(profile.type)),
    );
    if (matchingProfiles.length > 0) {
      return {
        label: matchingProfiles
          .map(([profileId, profile]) =>
            profile.type === "oauth"
              ? `${profileId}=OAuth`
              : profile.type === "token"
                ? `${profileId}=token`
                : `${profileId}=${profile.key}`,
          )
          .join(", "),
        source: `auth-profiles.json: /tmp/auth-profiles.json`,
      };
    }
    if (
      providerKey === "anthropic" &&
      workspaceDir &&
      ((process.env.WORKSPACE_MODEL_CREDENTIALS &&
        hasAllowedPluginForAuthTest(cfg, "workspace-model-auth")) ||
        (process.env.WORKSPACE_MODEL_LIST_CREDENTIALS &&
          hasAllowedPluginForAuthTest(cfg, "workspace-model-list")))
    ) {
      return {
        label: process.env.WORKSPACE_MODEL_CREDENTIALS
          ? "workspace model credentials"
          : "workspace model list credentials",
        source: "",
      };
    }
    return { label: "missing", source: "missing" };
  },
}));

vi.mock("../../agents/auth-profiles/store.js", () => {
  const store = () => ({
    version: 1,
    profiles: authProfilesStoreMock.profiles,
  });
  return {
    ensureAuthProfileStore: store,
    ensureAuthProfileStoreForLocalUpdate: store,
    findPersistedAuthProfileCredential: ({ profileId }: { profileId: string }) =>
      authProfilesStoreMock.profiles[profileId],
    getRuntimeAuthProfileStoreSnapshot: store,
    hasAnyAuthProfileStoreSource: () => Object.keys(authProfilesStoreMock.profiles).length > 0,
    loadAuthProfileStore: store,
    loadAuthProfileStoreForRuntime: store,
    loadAuthProfileStoreForSecretsRuntime: store,
    loadAuthProfileStoreWithoutExternalProfiles: store,
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async ({ update }) => update(store())),
  };
});

vi.mock("../../agents/model-auth.js", () => {
  const store = () => ({
    version: 1,
    profiles: authProfilesStoreMock.profiles,
  });
  const hasWorkspaceCredential = (env: NodeJS.ProcessEnv = process.env) =>
    Boolean(env.WORKSPACE_MODEL_LIST_CREDENTIALS || env.WORKSPACE_MODEL_CREDENTIALS);
  return {
    createRuntimeProviderAuthLookup: () => ({
      envApiKey: {
        aliasMap: {},
        candidateMap: {},
        authEvidenceMap: {},
      },
      syntheticAuthProviderRefs: [],
    }),
    ensureAuthProfileStore: store,
    hasRuntimeAvailableProviderAuth: ({
      provider,
      env,
    }: {
      provider: string;
      env?: NodeJS.ProcessEnv;
    }) => provider === "anthropic" && hasWorkspaceCredential(env),
    hasSyntheticLocalProviderAuthConfig: () => false,
    resolveProviderEntryApiKeyProfileReference: () => ({ kind: "none" }),
    resolveAuthProfileOrder: ({ provider }: { provider: string }) =>
      Object.entries(authProfilesStoreMock.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
    resolveEnvApiKey: (provider: string, env: NodeJS.ProcessEnv = process.env) => {
      if (provider !== "anthropic") {
        return null;
      }
      if (env.WORKSPACE_MODEL_CREDENTIALS) {
        return { apiKey: "sk-workspace", source: "workspace model credentials" };
      }
      if (env.WORKSPACE_MODEL_LIST_CREDENTIALS) {
        return { apiKey: "sk-workspace", source: "workspace model list credentials" };
      }
      return null;
    },
    resolveUsableCustomProviderApiKey: () => null,
    shouldPreferExplicitConfigApiKeyAuth: () => false,
  };
});

vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider,
}));

vi.mock("../../agents/cli-backends.js", () => ({
  isCliRuntimeModelBackendForProvider: () => false,
  listCliRuntimeModelBackendBindings: () => [],
  listCliRuntimeProviderIds: () => [],
  resolveCliRuntimeCanonicalProvider: () => undefined,
  resolveCliRuntimeModelBackendBinding: () => undefined,
}));

vi.mock("../../agents/harness/selection.js", () => ({
  selectAgentHarness: () => ({ id: "openclaw" }),
  resolveAgentHarnessPolicy: ({
    provider,
    modelId,
    config,
  }: {
    provider?: string;
    modelId?: string;
    config?: OpenClawConfig;
  }) => {
    const modelRuntime =
      provider && modelId
        ? config?.agents?.defaults?.models?.[`${provider}/${modelId}`]?.agentRuntime?.id
        : undefined;
    const providerRuntime = provider
      ? config?.models?.providers?.[provider]?.agentRuntime?.id
      : undefined;
    const runtime =
      modelRuntime === "default"
        ? undefined
        : (modelRuntime ??
          (providerRuntime === "default" ? undefined : providerRuntime) ??
          (provider === "openai" ? "codex" : "auto"));
    return {
      runtime,
      runtimeSource: modelRuntime ? "model" : providerRuntime ? "provider" : "implicit",
    };
  },
}));

vi.mock("../../agents/runtime-plan/auth.js", () => ({
  buildAgentRuntimeAuthPlan: ({
    provider,
    harnessRuntime,
  }: {
    provider: string;
    harnessRuntime?: string;
  }) => ({
    providerForAuth: provider,
    authProfileProviderForAuth: provider,
    ...(harnessRuntime === "codex" ? { harnessAuthProvider: "openai" } : {}),
  }),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (id: string) => pluginPolicyMock.channels.get(id),
}));

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: ({
    provider,
    context,
  }: {
    provider: string;
    context: ProviderDefaultThinkingPolicyContext;
  }) => pluginPolicyMock.thinkingProfiles.get(provider)?.(context),
}));

import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type InternalHookEvent,
} from "../../hooks/internal-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { ElevatedLevel } from "../thinking.js";

let handleDirectiveOnly: typeof import("./directive-handling.impl.js").handleDirectiveOnly;
let maybeHandleModelDirectiveInfo: typeof import("./directive-handling.model.js").maybeHandleModelDirectiveInfo;
let createModelVisibilityPolicy: typeof import("../../agents/model-visibility-policy.js").createModelVisibilityPolicy;
let buildModelAliasIndex: typeof import("../../agents/model-selection.js").buildModelAliasIndex;
let resolveModelSelectionFromDirective: typeof import("./directive-handling.model-selection.js").resolveModelSelectionFromDirective;
let parseInlineSessionDirectives: typeof import("./directive-handling.parse.js").parseInlineSessionDirectives;
let applyInlineDirectiveOverrides: typeof import("./get-reply-directives-apply.js").applyInlineDirectiveOverrides;
let createFastTestModelSelectionState: typeof import("./model-selection.js").createFastTestModelSelectionState;

beforeAll(async () => {
  ({ handleDirectiveOnly } = await import("./directive-handling.impl.js"));
  ({ maybeHandleModelDirectiveInfo } = await import("./directive-handling.model.js"));
  ({ createModelVisibilityPolicy } = await import("../../agents/model-visibility-policy.js"));
  ({ buildModelAliasIndex } = await import("../../agents/model-selection.js"));
  ({ resolveModelSelectionFromDirective } =
    await import("./directive-handling.model-selection.js"));
  ({ parseInlineSessionDirectives } = await import("./directive-handling.parse.js"));
  ({ applyInlineDirectiveOverrides } = await import("./get-reply-directives-apply.js"));
  ({ createFastTestModelSelectionState } = await import("./model-selection.js"));
});
const queueMocks = vi.hoisted(() => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

// Mock dependencies for directive handling persistence.
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: () => [],
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentEffectiveModelPrimary: vi.fn(() => undefined),
  resolveAgentModelFallbacksOverride: vi.fn(() => undefined),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveSessionAgentIds: () => ({ sessionAgentId: "main" }),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => {
  const loadModelCatalog = vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
    { provider: "localai", id: "ultra-chat", name: "Ultra Chat" },
  ]);
  return {
    loadPreparedModelCatalog: loadModelCatalog,
    loadProviderScopedThinkingCatalog: loadModelCatalog,
    loadPreparedModelCatalogSnapshot: async () => {
      const entries = await loadModelCatalog();
      return { entries, routeVariants: entries };
    },
  };
});

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) =>
    queueMocks.refreshQueuedFollowupSession(...args),
}));

const TEST_AGENT_DIR = "/tmp/agent";
const OPENAI_DATE_PROFILE_ID = "20251001";

type ApiKeyProfile = { type: "api_key"; provider: string; key: string };
type OAuthProfileForTest = {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
};
type TokenProfileForTest = { type: "token"; provider: string; token: string };
type AuthProfileForTest = ApiKeyProfile | OAuthProfileForTest | TokenProfileForTest;

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

function modelDefinition(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    delivery: { kind: "none" },
    ...overrides,
  };
}

function setDirectiveTestProviders(
  providers: Array<{
    id: string;
    label?: string;
    auth?: unknown[];
    resolveThinkingProfile?: (
      context: ProviderDefaultThinkingPolicyContext,
    ) => ProviderThinkingProfile | null | undefined;
  }>,
): void {
  pluginPolicyMock.thinkingProfiles.clear();
  for (const provider of providers) {
    if (provider.resolveThinkingProfile) {
      pluginPolicyMock.thinkingProfiles.set(provider.id, provider.resolveThinkingProfile);
    }
  }
}

function setOpenAiRuntimeScopedUltraProvider(): void {
  setDirectiveTestProviders([
    {
      id: "openai",
      label: "OpenAI",
      auth: [],
      resolveThinkingProfile: ({ agentRuntime }) => ({
        levels: [
          { id: "off" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "max" },
          ...(agentRuntime === "openclaw" ? ([{ id: "ultra" }] as const) : []),
        ],
      }),
    },
  ]);
}

beforeEach(() => {
  vi.useRealTimers();
  setDirectiveTestProviders([]);
  pluginPolicyMock.channels.clear();
  modelsCommandMock.resolveModelsCommandReply
    .mockReset()
    .mockResolvedValue(defaultModelsCommandReply());
  modelsCommandMock.delegateToActual = false;
  clearRuntimeAuthProfileStoreSnapshots();
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { version: 1, profiles: {} },
    },
  ]);
  vi.mocked(resolveAgentDir).mockReset().mockReturnValue(TEST_AGENT_DIR);
  vi.mocked(resolveSessionAgentId).mockReset().mockReturnValue("main");
  vi.mocked(enqueueSystemEvent).mockClear();
  queueMocks.refreshQueuedFollowupSession.mockReset();
  stickyModelMock.persistBestEffort.mockReset().mockReturnValue("requested");
  clearInternalHooks();
});

afterEach(() => {
  setDirectiveTestProviders([]);
  pluginPolicyMock.channels.clear();
  clearRuntimeAuthProfileStoreSnapshots();
  clearInternalHooks();
});

function setAuthProfiles(profiles: Record<string, AuthProfileForTest>) {
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { version: 1, profiles },
    },
  ]);
}

function createDateAuthProfiles(provider: string, id = OPENAI_DATE_PROFILE_ID) {
  return {
    [id]: {
      type: "api_key",
      provider,
      key: "sk-test",
    },
  } satisfies Record<string, ApiKeyProfile>;
}

function createGptAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map([["gpt", { alias: "gpt", ref: { provider: "openai", model: "gpt-4o" } }]]),
    byKey: new Map([["openai/gpt-4o", ["gpt"]]]),
  };
}

function createOpusAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map([
      [
        "opus",
        {
          alias: "Opus",
          ref: { provider: "anthropic", model: "claude-opus-4-6" },
        },
      ],
    ]),
    byKey: new Map([["anthropic/claude-opus-4-6", ["Opus"]]]),
  };
}

function resolveModelSelectionForCommand(params: {
  command: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Array<{ provider: string; id: string }>;
  cfg?: OpenClawConfig;
  agentId?: string;
}) {
  return resolveModelSelectionFromDirective({
    directives: parseInlineSessionDirectives(params.command),
    cfg: params.cfg ?? {
      commands: { text: true },
      agents: { defaults: { modelPolicy: { allow: [...params.allowedModelKeys] } } },
    },
    agentId: params.agentId,
    agentDir: TEST_AGENT_DIR,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: params.allowedModelKeys,
    allowedModelCatalog: params.allowedModelCatalog,
    provider: "anthropic",
  });
}

async function persistModelDirectiveForTest(params: {
  command: string;
  profiles?: Record<string, ApiKeyProfile>;
  cfg?: OpenClawConfig;
  aliasIndex?: ModelAliasIndex;
  allowedModelKeys: string[];
  allowedModelCatalog?: ModelCatalogEntry[];
  sessionEntry?: SessionEntry;
  provider?: string;
  model?: string;
  initialModelLabel?: string;
  canPersistStickyModelSelection?: boolean;
  isAuthorizedSender?: boolean;
}) {
  if (params.profiles) {
    setAuthProfiles(params.profiles);
  }
  const originalDirectives = parseInlineSessionDirectives(params.command);
  const commandBody = originalDirectives.cleaned.trim()
    ? params.command
    : `${params.command} continue with the request`;
  const directives = parseInlineSessionDirectives(commandBody);
  const cfg = params.cfg ?? baseConfig();
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const provider = params.provider ?? "anthropic";
  const model = params.model ?? "claude-opus-4-6";
  const sessionKey = "agent:main:dm:1";
  const modelState = createFastTestModelSelectionState({
    agentCfg: cfg.agents?.defaults,
    provider,
    model,
  });
  modelState.allowedModelKeys = new Set(params.allowedModelKeys);
  modelState.allowedModelCatalog = params.allowedModelCatalog ?? [];
  modelState.resolveThinkingCatalog = async () => params.allowedModelCatalog;
  const result = await applyInlineDirectiveOverrides({
    ctx: { Body: commandBody, Provider: "telegram", Surface: "telegram" },
    cfg,
    agentId: "main",
    agentDir: TEST_AGENT_DIR,
    workspaceDir: "/tmp/workspace",
    agentCfg: cfg.agents?.defaults ?? {},
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: params.canPersistStickyModelSelection ?? true,
      isAuthorizedSender: params.isAuthorizedSender ?? true,
      rawBodyNormalized: commandBody,
      commandBodyNormalized: commandBody,
    },
    directives,
    messageProviderKey: "telegram",
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: params.aliasIndex ?? baseAliasIndex(),
    provider,
    model,
    modelState,
    initialModelLabel: params.initialModelLabel ?? `${provider}/${model}`,
    formatModelSwitchEvent: (label) => label,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 8192,
    effectiveModelDirective: directives.rawModelDirective,
    typing: {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: () => {},
    },
  });
  const persisted =
    result.kind === "continue"
      ? {
          provider: result.provider,
          model: result.model,
          contextTokens: result.contextTokens,
          directiveAck: result.directiveAck,
          errorText: undefined,
        }
      : {
          provider,
          model,
          contextTokens: 8192,
          directiveAck: undefined,
          errorText: Array.isArray(result.reply) ? result.reply[0]?.text : result.reply?.text,
        };
  return { persisted, sessionEntry };
}

type HandleDirectiveParams = Parameters<typeof handleDirectiveOnly>[0];
const EXEC_DEFAULTS_DIRECTIVE = "/exec host=node security=allowlist ask=always node=worker-1";
const VERBOSE_DEFAULT_DIRECTIVE = "/verbose full";

function createDirectiveHandlingParams(
  overrides: Partial<HandleDirectiveParams>,
): HandleDirectiveParams {
  const sessionKey = overrides.sessionKey ?? "agent:main:main";
  const sessionEntry = overrides.sessionEntry ?? createSessionEntry();
  return {
    cfg: baseConfig(),
    directives: parseInlineSessionDirectives(""),
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    elevatedEnabled: true,
    elevatedAllowed: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    ...overrides,
  };
}

async function persistInternalOperatorWriteDirective(
  command: string,
  overrides: Partial<HandleDirectiveParams> = {},
) {
  const sessionEntry = overrides.sessionEntry ?? createSessionEntry();
  await handleDirectiveOnly(
    createDirectiveHandlingParams({
      directives: parseInlineSessionDirectives(command),
      sessionEntry,
      surface: "webchat",
      gatewayClientScopes: ["operator.write"],
      ...overrides,
    }),
  );
  return sessionEntry;
}

function externalChannelPolicy(overrides: Partial<HandleDirectiveParams> = {}) {
  return { messageProvider: "telegram", surface: "telegram", ...overrides };
}

function expectExecDefaults(sessionEntry: SessionEntry, persisted: boolean) {
  expect(sessionEntry.execHost).toBe(persisted ? "node" : undefined);
  expect(sessionEntry.execNode).toBe(persisted ? "worker-1" : undefined);
}

async function resolveModelInfoReply(
  overrides: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]> = {},
) {
  return maybeHandleModelDirectiveInfo({
    directives: parseInlineSessionDirectives("/model"),
    cfg: baseConfig(),
    agentDir: TEST_AGENT_DIR,
    activeAgentId: "main",
    provider: "anthropic",
    model: "claude-opus-4-6",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: new Set(),
    allowedModelCatalog: [],
    currentThinkLevel: "medium",
    runtimePolicySessionKey: "agent:main:main",
    resetModelOverride: false,
    ...overrides,
  });
}

type WorkspaceAuthFixture = {
  pluginId: string;
  envVar: string;
  credentialMarker: string;
  source: string;
  env?: NodeJS.ProcessEnv;
};

async function withWorkspaceAuthFixture(
  fixture: WorkspaceAuthFixture,
  run: (workspaceDir: string) => Promise<void>,
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${fixture.pluginId}-`));
  const workspaceDir = path.join(tempRoot, "workspace");
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", fixture.pluginId);
  const bundledDir = path.join(tempRoot, "bundled");
  const stateDir = path.join(tempRoot, "state");
  const credentialPath = path.join(tempRoot, "credentials.json");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}\n", "utf8");
  fs.writeFileSync(credentialPath, "{}", "utf8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: fixture.pluginId,
      configSchema: { type: "object" },
      setup: {
        providers: [
          {
            id: "anthropic",
            authEvidence: [
              {
                type: "local-file-with-env",
                fileEnvVar: fixture.envVar,
                credentialMarker: fixture.credentialMarker,
                source: fixture.source,
              },
            ],
          },
        ],
      },
    }),
    "utf8",
  );

  try {
    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_STATE_DIR: stateDir,
        [fixture.envVar]: credentialPath,
        ...fixture.env,
      },
      () => run(workspaceDir),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function nestedOpenRouterStatusFixture(configureDirectProvider: boolean) {
  return {
    directives: parseInlineSessionDirectives("/model status"),
    provider: "openrouter",
    model: "google/gemini-3-flash-preview",
    defaultProvider: "openrouter",
    defaultModel: "google/gemini-3-flash-preview",
    cfg: {
      commands: { text: true },
      models: {
        providers: {
          ...(configureDirectProvider
            ? {
                google: {
                  baseUrl: "https://google.example.test/v1",
                  models: [modelDefinition("gemini-3-flash-preview", "Gemini 3 Flash")],
                },
              }
            : {}),
          openrouter: {
            baseUrl: "https://openrouter.example.test/api/v1",
            models: [modelDefinition("google/gemini-3-flash-preview", "Gemini via OpenRouter")],
          },
        },
      },
    } as unknown as OpenClawConfig,
    allowedModelCatalog: [
      { provider: "google", id: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
      {
        provider: "openrouter",
        id: "google/gemini-3-flash-preview",
        name: "Gemini via OpenRouter",
      },
    ],
  };
}

describe("/model chat UX", () => {
  it("shows summary for /model with no args", async () => {
    const reply = await resolveModelInfoReply();

    expect(reply?.text).toContain("Current:");
    expect(reply?.text).toContain("Think: medium (change with /think <level>)");
    expect(reply?.text).toContain("Browse: /models");
    expect(reply?.text).toContain("Session: /model <provider/model> -s");
    expect(reply?.text).toContain("Agent default: /model <provider/model> -a");
    expect(reply?.text).toContain("Global default: /model <provider/model> -g");
    expect(reply?.text).toContain("Runtime: /model <provider/model> --runtime <runtime> -s");
  });

  it("marks an auth profile without a model selection as an error", async () => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model list@work"),
    });

    expect(reply).toEqual({
      text: "Auth profile override requires a model selection.",
      isError: true,
    });
  });

  it.each([
    {
      command: "/model status --runtime codex",
      text: "Runtime override requires a model selection.",
    },
    {
      command: "/model list -s",
      text: "Session-only scope requires a model selection.",
    },
    {
      command: "/model status --agent",
      text: "Agent scope requires a model selection.",
    },
    {
      command: "/model list --global",
      text: "Global scope requires a model selection.",
    },
  ])(
    "rejects action options on informational model commands: $command",
    async ({ command, text }) => {
      const reply = await resolveModelInfoReply({
        directives: parseInlineSessionDirectives(command),
      });

      expect(reply).toEqual({ text, isError: true });
    },
  );

  it("includes the thinking level in channel-specific model summaries", async () => {
    pluginPolicyMock.channels.set("telegram", {
      id: "telegram",
      commands: {
        buildModelBrowseChannelData: () => ({ telegram: { inlineKeyboard: [] } }),
      },
    });

    const reply = await resolveModelInfoReply({ surface: "telegram" });

    expect(reply?.channelData).toBeDefined();
    expect(reply?.text).toContain("Think: medium (change with /think <level>)");
    expect(reply?.text).toContain("Tap below to select a model");
    expect(reply?.text).toContain("/model <provider/model> -s for this session only");
    expect(reply?.text).toContain("/model <provider/model> -a to update this agent's default");
    expect(reply?.text).toContain("/model <provider/model> -g to update the global default");
    expect(reply?.text).toContain(
      "/model <provider/model> --runtime <runtime> -s to switch harnesses",
    );
  });

  it("shows the effective thinking level for the selected runtime", async () => {
    setDirectiveTestProviders([
      {
        id: "openai",
        label: "OpenAI",
        auth: [],
        resolveThinkingProfile: ({ agentRuntime }) => ({
          levels: [
            { id: "off" },
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            { id: "max" },
            ...(agentRuntime === "openclaw" ? ([{ id: "ultra" }] as const) : []),
          ],
        }),
      },
    ]);

    const reply = await resolveModelInfoReply({
      provider: "openai",
      model: "gpt-5.6-luna",
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-luna",
      currentThinkLevel: "ultra",
      sessionEntry: { agentRuntimeOverride: "codex" },
    });

    expect(reply?.text).toContain("Think: max (change with /think <level>)");
    expect(reply?.text).not.toContain("Think: ultra");
  });

  it("treats /model list as a models browser alias, not a model id", async () => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model list"),
    });

    expect(reply?.text).toContain("Providers:");
    expect(reply?.text).toContain("Use: /models <provider>");
    expect(reply?.text).toContain("Switch: /model <provider/model>");
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });

  it("passes workspace scope through the /model list browser alias", async () => {
    await withWorkspaceAuthFixture(
      {
        pluginId: "workspace-model-list",
        envVar: "WORKSPACE_MODEL_LIST_CREDENTIALS",
        credentialMarker: "workspace-model-list-local-credentials",
        source: "workspace model list credentials",
      },
      async (workspaceDir) => {
        modelsCommandMock.delegateToActual = true;
        const reply = await resolveModelInfoReply({
          directives: parseInlineSessionDirectives("/model list"),
          workspaceDir,
          cfg: {
            ...baseConfig(),
            plugins: { allow: ["workspace-model-list"] },
          } as unknown as OpenClawConfig,
        });

        expect(reply?.text).toContain("- anthropic");
        expect(modelsCommandMock.resolveModelsCommandReply).toHaveBeenCalledWith(
          expect.objectContaining({
            commandBodyNormalized: "/models",
            workspaceDir,
            cfg: expect.objectContaining({
              plugins: { allow: ["workspace-model-list"] },
            }),
          }),
        );
      },
    );
  });

  it("shows active runtime model when different from selected model", async () => {
    const reply = await resolveModelInfoReply({
      provider: "fireworks",
      model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      defaultProvider: "fireworks",
      defaultModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      sessionEntry: {
        modelProvider: "deepinfra",
        model: "moonshotai/Kimi-K2.5",
      },
    });

    expect(reply?.text).toContain(
      "Current: fireworks/accounts/fireworks/routers/kimi-k2p5-turbo (selected)",
    );
    expect(reply?.text).toContain("Active: deepinfra/moonshotai/Kimi-K2.5 (runtime)");
  });

  it("shows status for the allowed catalog without duplicate missing auth labels", async () => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-4.1-mini": {},
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
        { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
      ],
    });

    expect(reply?.text).toContain("anthropic/claude-opus-4-6");
    expect(reply?.text).toContain("openai/gpt-4.1-mini");
    expect(reply?.text).not.toContain("claude-sonnet-4-1");
    expect(reply?.text).toContain("auth:");
    expect(reply?.text).not.toContain("missing (missing)");
  });

  it("expands provider wildcard models without retaining a rejected default", async () => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            modelPolicy: { allow: ["anthropic/*"] },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelKeys: new Set(["anthropic/*"]),
      allowedModelCatalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      ],
    });

    expect(reply?.text).toContain("anthropic/claude-sonnet-4-6");
    expect(reply?.text).toContain("anthropic/claude-opus-4-6");
    expect(reply?.text).not.toContain("  • openai/gpt-5.5");
  });

  it("resolves config-dependent policy refs identically in enforcement and picker", async () => {
    const cfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "openrouter/meta-llama/llama-3.3-70b-instruct:free": {},
          },
          modelPolicy: { allow: ["openrouter:free"] },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      allowManifestNormalization: true,
      allowPluginNormalization: true,
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      cfg,
      allowedModelKeys: policy.allowedKeys,
      allowedModelCatalog: policy.allowedCatalog,
    });

    expect(policy.allowsKey("openrouter/meta-llama/llama-3.3-70b-instruct:free")).toBe(true);
    expect(reply?.text).toContain("openrouter/meta-llama/llama-3.3-70b-instruct:free");
    expect(reply?.text).not.toContain("anthropic/openrouter:free");
  });

  it("resolves inherited policy aliases with the default-scoped index in the picker", async () => {
    const cfg = {
      commands: { text: true },
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          model: { primary: "provider-a/model-a" },
          models: {
            "provider-a/model-a": { alias: "approved" },
          },
          modelPolicy: { allow: ["approved"] },
        },
        list: [
          {
            id: "main",
            models: {
              "provider-b/model-b": { alias: "approved" },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "provider-a",
      defaultModel: "model-a",
      agentId: "main",
    });
    const agentAliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: "provider-a",
      agentId: "main",
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      cfg,
      activeAgentId: "main",
      defaultProvider: "provider-a",
      defaultModel: "model-a",
      aliasIndex: agentAliasIndex,
      policyAliasIndex: policy.policyAliasIndex,
      allowedModelKeys: policy.allowedKeys,
      allowedModelCatalog: policy.allowedCatalog,
    });

    expect(agentAliasIndex.byAlias.get("approved")?.ref).toEqual({
      provider: "provider-b",
      model: "model-b",
    });
    expect(policy.allows({ provider: "provider-a", model: "model-a" })).toBe(true);
    expect(policy.allows({ provider: "provider-b", model: "model-b" })).toBe(false);
    expect(reply?.text).toContain("provider-a/model-a");
    expect(reply?.text).not.toContain("provider-b/model-b");
  });

  it("hides missing-auth direct provider rows covered by OpenRouter nested model ids", async () => {
    const reply = await resolveModelInfoReply(nestedOpenRouterStatusFixture(false));

    expect(reply?.text).toContain("[openrouter]");
    expect(reply?.text).toContain("openrouter/google/gemini-3-flash-preview");
    expect(reply?.text).not.toContain("\n[google]");
    expect(reply?.text).not.toContain("\n  • google/gemini-3-flash-preview");
  });

  it("keeps explicitly configured direct provider rows next to OpenRouter nested ids", async () => {
    const reply = await resolveModelInfoReply(nestedOpenRouterStatusFixture(true));

    expect(reply?.text).toContain("[google]");
    expect(reply?.text).toContain("google/gemini-3-flash-preview");
    expect(reply?.text).toContain("[openrouter]");
    expect(reply?.text).toContain("openrouter/google/gemini-3-flash-preview");
  });

  it("reports unified OpenAI OAuth auth for OpenAI status rows", async () => {
    setAuthProfiles({
      "openai:patrick@example.test": {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      "openai:runtime-token": {
        type: "token",
        provider: "openai",
        token: "token",
      },
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "openai",
      model: "gpt-5.5",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "codex/gpt-5.5": {},
              "openai/gpt-5.5": {},
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
    });

    expect(reply?.text).toContain("[openai] endpoint: default auth:");
    expect(reply?.text).not.toContain("[openai] endpoint: default auth: missing");
    expect(reply?.text).not.toContain("via codex runtime");
    expect(reply?.text).toContain("openai:patrick@example.test=OAuth");
  }, 240_000);

  it("keeps direct provider auth labels when OpenAI API key auth exists", async () => {
    setAuthProfiles({
      "openai:api-key": {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-direct",
      },
      "openai:patrick@example.test": {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "openai",
      model: "gpt-5.5",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": {},
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
    });

    expect(reply?.text).toContain("[openai] endpoint: default auth:");
    expect(reply?.text).toContain("openai:api-key=");
    expect(reply?.text).not.toContain("via codex runtime");
  });

  it("does not borrow Codex auth when OpenAI model policy pins OpenClaw runtime", async () => {
    setAuthProfiles({
      "openai:patrick@example.test": {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "openai",
      model: "gpt-5.5",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
    });

    expect(reply?.text).toContain("[openai] endpoint: default auth: missing");
    expect(reply?.text).not.toContain("via codex runtime");
    expect(reply?.text).not.toContain("openai:patrick@example.test=OAuth");
    expect(reply?.text).not.toContain("openai:runtime-token=token");
  });

  it("honors Codex session runtime overrides when labeling OpenAI status auth", async () => {
    setAuthProfiles({
      "openai:patrick@example.test": {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "openai",
      model: "gpt-5.5",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      sessionEntry: {
        agentRuntimeOverride: "codex",
      },
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
    });

    expect(reply?.text).toContain("[openai] endpoint: default auth:");
    expect(reply?.text).not.toContain("[openai] endpoint: default auth: missing");
    expect(reply?.text).toContain("openai:patrick@example.test=OAuth");
  });

  it("treats the persisted harness id as observational when labeling status auth", async () => {
    setAuthProfiles({
      "openai:patrick@example.test": {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "openai",
      model: "gpt-5.5",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      sessionEntry: {
        agentHarnessId: "codex",
      },
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
    });

    expect(reply?.text).toContain("[openai] endpoint: default auth: missing");
    expect(reply?.text).not.toContain("openai:patrick@example.test=OAuth");
  });

  it("uses workspace-scoped auth evidence in /model status labels", async () => {
    await withWorkspaceAuthFixture(
      {
        pluginId: "workspace-model-auth",
        envVar: "WORKSPACE_MODEL_CREDENTIALS",
        credentialMarker: "workspace-model-local-credentials",
        source: "workspace model credentials",
        env: {
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_OAUTH_TOKEN: undefined,
        },
      },
      async (workspaceDir) => {
        const reply = await resolveModelInfoReply({
          directives: parseInlineSessionDirectives("/model status"),
          workspaceDir,
          cfg: {
            ...baseConfig(),
            plugins: { allow: ["workspace-model-auth"] },
            agents: {
              defaults: {
                models: {
                  "anthropic/claude-opus-4-6": {},
                },
              },
            },
          } as unknown as OpenClawConfig,
          allowedModelCatalog: [
            { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
          ],
        });

        expect(reply?.text).toContain("workspace model credentials");
      },
    );
  });

  it("auto-applies closest match for typos", () => {
    const directives = parseInlineSessionDirectives("/model anthropic/claud-opus-4-5");
    const cfg: OpenClawConfig = {
      commands: { text: true },
      agents: { defaults: { modelPolicy: { allow: ["anthropic/claude-opus-4-6"] } } },
    };

    const resolved = resolveModelSelectionFromDirective({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
      allowedModelCatalog: [{ provider: "anthropic", id: "claude-opus-4-6" }],
      provider: "anthropic",
    });

    expect(resolved.modelSelection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      isDefault: true,
    });
    expect(resolved.errorText).toBeUndefined();
  });

  it("rejects numeric /model selections with a guided error", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model 99",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.modelSelection).toBeUndefined();
    expect(resolved.errorText).toContain("Numeric model selection is not supported in chat.");
    expect(resolved.errorText).toContain("Browse: /models or /models <provider>");
  });

  it("includes additive allowlist repair when a runtime switch targets a blocked model", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model openai/gpt-5.5 --runtime codex",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
      allowedModelCatalog: [],
    });

    expect(resolved.modelSelection).toBeUndefined();
    expect(resolved.errorText).toContain('Model "openai/gpt-5.5" is not allowed.');
    expect(resolved.errorText).toContain(
      'Add "openai/gpt-5.5" or its provider wildcard to agents.defaults.modelPolicy.allow.',
    );
    expect(resolved.errorText).toContain("Then retry: /model openai/gpt-5.5 --runtime codex");
    expect(resolved.errorText).toContain("openclaw plugins enable codex");
  });

  it("names the active per-agent allowlist in repair guidance", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model openai/gpt-5.5",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
      allowedModelCatalog: [],
      cfg: {
        agents: {
          list: [{ id: "ops", modelPolicy: { allow: ["anthropic/*"] } }],
        },
      },
      agentId: "ops",
    });

    expect(resolved.errorText).toContain(
      'Add "openai/gpt-5.5" or its provider wildcard to agents.entries.*.modelPolicy.allow.',
    );
  });

  it("treats explicit default /model selection as resettable default", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model anthropic/claude-opus-4-6",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      isDefault: true,
    });
  });

  it("treats /model default as a session model reset", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model default",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      isDefault: true,
    });
  });

  it("keeps openrouter provider/model split for exact selections", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model openrouter/anthropic/claude-opus-4-6",
      allowedModelKeys: new Set(["openrouter/anthropic/claude-opus-4-6"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-4-6",
      isDefault: false,
    });
  });

  it("keeps cloudflare @cf model segments for exact selections", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model openai/@cf/openai/gpt-oss-20b",
      allowedModelKeys: new Set(["openai/@cf/openai/gpt-oss-20b"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "@cf/openai/gpt-oss-20b",
      isDefault: false,
    });
  });

  it("treats @YYYYMMDD as a profile override when that profile exists for the resolved provider", () => {
    setAuthProfiles(createDateAuthProfiles("openai"));

    const resolved = resolveModelSelectionForCommand({
      command: `/model openai/gpt-4o@${OPENAI_DATE_PROFILE_ID}`,
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
    });
    expect(resolved.profileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("supports alias selections with numeric auth-profile overrides", () => {
    setAuthProfiles(createDateAuthProfiles("openai"));

    const resolved = resolveModelSelectionFromDirective({
      directives: parseInlineSessionDirectives(`/model gpt@${OPENAI_DATE_PROFILE_ID}`),
      cfg: { commands: { text: true } } as unknown as OpenClawConfig,
      agentDir: TEST_AGENT_DIR,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: createGptAliasIndex(),
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      allowedModelCatalog: [],
      provider: "anthropic",
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
      alias: "gpt",
    });
    expect(resolved.profileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("supports providerless allowlist selections with numeric auth-profile overrides", () => {
    setAuthProfiles(createDateAuthProfiles("openai"));

    const resolved = resolveModelSelectionForCommand({
      command: `/model gpt-4o@${OPENAI_DATE_PROFILE_ID}`,
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
    });
    expect(resolved.profileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("keeps @YYYYMMDD as part of the model when the stored numeric profile is for another provider", () => {
    setAuthProfiles(createDateAuthProfiles("anthropic"));

    const resolved = resolveModelSelectionForCommand({
      command: `/model custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`,
      allowedModelKeys: new Set([`custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "custom",
      model: `vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`,
      isDefault: false,
    });
    expect(resolved.profileOverride).toBeUndefined();
  }, 240_000);

  it("persists inferred numeric auth-profile overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: `/model openai/gpt-4o@${OPENAI_DATE_PROFILE_ID} hello`,
      profiles: createDateAuthProfiles("openai"),
      allowedModelKeys: ["openai/gpt-4o", `openai/gpt-4o@${OPENAI_DATE_PROFILE_ID}`],
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("persists provider-compatible runtime overrides", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime codex hello",
      allowedModelKeys: ["openai/gpt-4o"],
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
    expect(persisted.directiveAck?.text).toContain("Runtime set to codex for this session.");
  });

  it("normalizes legacy Codex app-server runtime overrides during persistence", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime codex-app-server hello",
      allowedModelKeys: ["openai/gpt-4o"],
    });

    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
  });

  it("uses Codex OAuth context config for persisted native Codex runtime directives", async () => {
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-5.5 --runtime codex hello",
      allowedModelKeys: ["openai/gpt-5.5"],
      cfg: {
        ...baseConfig(),
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT-5.5",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_050_000,
                  contextTokens: 1_000_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(persisted.provider).toBe("openai");
    expect(persisted.model).toBe("gpt-5.5");
    expect(persisted.contextTokens).toBe(1_000_000);
  });

  it("caps a cold model switch with the selected catalog row", async () => {
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-5.5 hello",
      allowedModelKeys: ["openai/gpt-5.5"],
      allowedModelCatalog: [
        {
          provider: "openai",
          id: "gpt-5.5",
          name: "GPT-5.5",
          contextWindow: 1_000_000,
          contextTokens: 272_000,
        },
      ],
      cfg: baseConfig() as OpenClawConfig,
    });

    expect(persisted.contextTokens).toBe(272_000);
  });

  it("clears runtime overrides when the model directive asks for default runtime", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime default hello",
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry: createSessionEntry({ agentRuntimeOverride: "codex" }),
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
    });

    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
  });

  it("clears a provider-incompatible runtime pin during a model switch", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      agentRuntimeOverride: "codex",
    });
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model anthropic/claude-opus-4-6 hello",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
      sessionEntry,
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
    });

    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
    expect(persisted.directiveAck?.text).toContain("Runtime reset to configured policy.");
  });

  it("rejects model/runtime transactions that target an unsupported runtime", async () => {
    vi.mocked(enqueueSystemEvent).mockClear();
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
    });
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime claude-cli hello",
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry,
    });

    expect(persisted.errorText).toBe('Runtime "claude-cli" is not supported for openai.');
    expect(sessionEntry).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("rejects the Codex runtime for providers the harness does not support", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model anthropic/claude-opus-4-6 --runtime codex hello",
      allowedModelKeys: ["anthropic/claude-opus-4-6"],
    });

    expect(persisted.errorText).toBe('Runtime "codex" is not supported for anthropic.');
    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
  });

  it("rejects unsupported mixed thinking before mutating the model/runtime transaction", async () => {
    setOpenAiRuntimeScopedUltraProvider();
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      modelOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
      thinkingLevel: "high",
    });
    const initialSessionEntry = { ...sessionEntry };
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-5.6-luna --runtime codex /think ultra please solve",
      allowedModelKeys: ["openai/gpt-5.6-luna"],
      sessionEntry,
      provider: "openai",
      model: "gpt-5.6-sol",
      initialModelLabel: "openai/gpt-5.6-sol",
    });

    expect(persisted.errorText).toBe(
      'Thinking level "ultra" is not supported for openai/gpt-5.6-luna. Use one of: off, low, medium, high, max.',
    );
    expect(sessionEntry).toEqual(initialSessionEntry);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(queueMocks.refreshQueuedFollowupSession).not.toHaveBeenCalled();
  });

  it("persists an atomic model/runtime/thinking transaction when the runtime supports it", async () => {
    setOpenAiRuntimeScopedUltraProvider();
    const sessionEntry = createSessionEntry({ thinkingLevel: "high" });
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-5.6-luna --runtime openclaw /think ultra please solve",
      allowedModelKeys: ["openai/gpt-5.6-luna"],
      sessionEntry,
    });

    expect(persisted.errorText).toBeUndefined();
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
      thinkingLevel: "ultra",
    });
  });

  it("persists alias-based numeric auth-profile overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: `/model gpt@${OPENAI_DATE_PROFILE_ID} hello`,
      profiles: createDateAuthProfiles("openai"),
      aliasIndex: createGptAliasIndex(),
      allowedModelKeys: ["openai/gpt-4o"],
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("persists providerless numeric auth-profile overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: `/model gpt-4o@${OPENAI_DATE_PROFILE_ID} hello`,
      profiles: createDateAuthProfiles("openai"),
      allowedModelKeys: ["openai/gpt-4o"],
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("resolves agentDir from the target session agent before wrapper agentDir", async () => {
    vi.mocked(resolveSessionAgentId).mockReturnValue("target");
    vi.mocked(resolveAgentDir).mockReturnValue("/tmp/target-agent");

    await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o hello",
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry: createSessionEntry(),
    });

    expect(resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey: "agent:main:dm:1",
      config: baseConfig(),
    });
    expect(resolveAgentDir).toHaveBeenCalledWith(baseConfig(), "target");
  });

  it("persists explicit auth profiles after @YYYYMMDD version suffixes in mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: `/model custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}@work hello`,
      cfg: {
        models: {
          providers: {
            custom: { api: "openai-responses", baseUrl: "https://custom.invalid/v1", models: [] },
          },
        },
      },
      profiles: {
        work: {
          type: "api_key",
          provider: "custom",
          key: "sk-test",
        },
      },
      allowedModelKeys: [`custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`],
    });

    expect(sessionEntry.providerOverride).toBe("custom");
    expect(sessionEntry.modelOverride).toBe(`vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`);
    expect(sessionEntry.authProfileOverride).toBe("work");
  });

  it("ignores invalid mixed-content model directives during persistence", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model 99 hello",
      profiles: createDateAuthProfiles("openai"),
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry: createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        authProfileOverride: OPENAI_DATE_PROFILE_ID,
        authProfileOverrideSource: "user",
      }),
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
    });

    expect(persisted.provider).toBe("openai");
    expect(persisted.model).toBe("gpt-4o");
    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
  });
});

describe("handleDirectiveOnly model persist behavior (fixes #1435)", () => {
  const allowedModelKeys = new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]);
  const allowedModelCatalog = [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ];
  const sessionKey = "agent:main:dm:1";

  type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

  function createHandleParams(overrides: Partial<HandleParams>): HandleParams {
    return createDirectiveHandlingParams({
      sessionKey,
      elevatedEnabled: false,
      elevatedAllowed: false,
      allowedModelKeys,
      allowedModelCatalog,
      ...overrides,
    });
  }

  function runHandleCommand(command: string, overrides: Partial<HandleParams> = {}) {
    return handleDirectiveOnly(
      createHandleParams({ ...overrides, directives: parseInlineSessionDirectives(command) }),
    );
  }

  beforeAll(async () => {
    const sessionEntry = createSessionEntry({ thinkingLevel: "xhigh" });
    await runHandleCommand("/model opencode/claude-opus-4-7", {
      allowedModelKeys: new Set([...allowedModelKeys, "opencode/claude-opus-4-7"]),
      allowedModelCatalog: [
        ...allowedModelCatalog,
        { provider: "opencode", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      ],
      sessionEntry,
    });
  });

  it("preserves an authorized unscoped effective-default selection", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("/model openai/gpt-4o", {
      sessionEntry,
      canPersistStickyModelSelection: true,
    });

    expect(result?.text).toContain("Model set to");
    expect(result?.text).toContain("openai/gpt-4o");
    expect(result?.text).toContain("Configured default update requested.");
    expect(result?.text).not.toContain("failed");
    expect(sessionEntry.liveModelSwitchPending).toBe(true);
    expect(stickyModelMock.persistBestEffort).toHaveBeenCalledWith({
      agentId: "main",
      model: "openai/gpt-4o",
    });
  });

  it("preserves a compatible auth profile for a mixed model directive", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5",
      authProfileOverride: "team:prod",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });

    await runHandleCommand("/model openai/gpt-4o", {
      cfg: {
        ...baseConfig(),
        auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
      },
      provider: "openai",
      model: "gpt-5",
      sessionEntry,
    });

    expect(sessionEntry.authProfileOverride).toBe("team:prod");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionEntry.authProfileOverrideCompactionCount).toBe(2);
  });

  it("uses the target session agent when persisting a model selection", async () => {
    vi.mocked(resolveSessionAgentId).mockReturnValue("work");
    const sessionEntry = createSessionEntry();

    await runHandleCommand("/model openai/gpt-4o -a", {
      sessionEntry,
      stickyModelSelectionTarget: "agent",
      canPersistStickyModelSelection: true,
    });

    expect(stickyModelMock.persistBestEffort).toHaveBeenCalledWith({
      agentId: "work",
      model: "openai/gpt-4o",
      target: "agent",
    });
  });

  it("keeps a non-owner model selection session-scoped", async () => {
    const sessionEntry = createSessionEntry();

    const result = await runHandleCommand("/model openai/gpt-4o", {
      sessionEntry,
    });

    expect(result?.text).toContain(
      "Model set to openai/gpt-4o for this session only; configured default unchanged.",
    );
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });

  it("reports immutable agent configuration without claiming an update", async () => {
    stickyModelMock.persistBestEffort.mockReturnValueOnce("skipped-immutable");
    const sessionEntry = createSessionEntry();

    const result = await runHandleCommand("/model openai/gpt-4o -a", {
      sessionEntry,
      stickyModelSelectionTarget: "agent",
      canPersistStickyModelSelection: true,
    });

    expect(result?.text).toContain(
      "Model set to openai/gpt-4o for this session. Agent default unchanged because configuration is immutable.",
    );
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
  });

  it("persists an explicit runtime with a directive-only model switch", async () => {
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineSessionDirectives("/model openai/gpt-4o --runtime openclaw"),
        sessionEntry,
      }),
    );

    expect(result?.text).toContain(
      "Model set to openai/gpt-4o for this session only; configured default unchanged.",
    );
    expect(result?.text).toContain("Runtime set to openclaw for this session.");
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
    });
  });

  it("rejects an invalid directive-only model/runtime transaction atomically", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
    });
    const initialSessionEntry = { ...sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineSessionDirectives("/model openai/gpt-4o --runtime claude-cli"),
        sessionEntry,
      }),
    );

    expect(result?.text).toBe('Runtime "claude-cli" is not supported for openai.');
    expect(result?.isError).toBe(true);
    expect(sessionEntry).toEqual(initialSessionEntry);
    expect(queueMocks.refreshQueuedFollowupSession).not.toHaveBeenCalled();
  });

  it("preserves an explicit runtime pin when a model switch omits --runtime", async () => {
    const sessionEntry = createSessionEntry({ agentRuntimeOverride: "codex" });
    await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineSessionDirectives("/model openai/gpt-4o"),
        sessionEntry,
      }),
    );

    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
  });

  it("rejects model and runtime changes for model-locked sessions", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelSelectionLocked: true,
    });
    const initialSessionEntry = { ...sessionEntry };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineSessionDirectives("/model openai/gpt-4o --runtime openclaw"),
        sessionEntry,
      }),
    );

    expect(result?.text).toBe(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(result?.isError).toBe(true);
    expect(sessionEntry).toEqual(initialSessionEntry);
  });

  it("rechecks a newly persisted model lock before committing directive changes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-directive-lock-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const lockedEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      modelSelectionLocked: true,
    };
    await replaceSessionEntry({ sessionKey, storePath }, lockedEntry);
    const sessionStore = { [sessionKey]: sessionEntry };

    try {
      const result = await handleDirectiveOnly(
        createHandleParams({
          directives: parseInlineSessionDirectives("/model openai/gpt-4o"),
          sessionEntry,
          sessionStore,
          storePath,
        }),
      );

      expect(result?.text).toBe(MODEL_SELECTION_LOCKED_MESSAGE);
      expect(result?.isError).toBe(true);
      expect(sessionEntry).toEqual(lockedEntry);
      expect(sessionStore[sessionKey]).toEqual(lockedEntry);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(lockedEntry);
      expect(queueMocks.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists /model only on the targeted session entry", async () => {
    const targetEntry = createSessionEntry();
    const otherEntry = createSessionEntry();
    const sessionStore = {
      [sessionKey]: targetEntry,
      "agent:main:dm:other": otherEntry,
    };

    await runHandleCommand("/model openai/gpt-4o", {
      sessionEntry: targetEntry,
      sessionStore,
    });

    expect(targetEntry.providerOverride).toBe("openai");
    expect(targetEntry.modelOverride).toBe("gpt-4o");
    expect(targetEntry.modelOverrideSource).toBe("user");
    expect(otherEntry.providerOverride).toBeUndefined();
    expect(otherEntry.modelOverride).toBeUndefined();
    expect(otherEntry.modelOverrideSource).toBeUndefined();
  });

  it("persists an explicitly agent-scoped mixed-command model selection", async () => {
    vi.mocked(resolveSessionAgentId).mockReturnValue("work");

    await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o -a continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
    });

    expect(stickyModelMock.persistBestEffort).toHaveBeenCalledWith({
      agentId: "work",
      model: "openai/gpt-4o",
      target: "agent",
    });
  });

  it("persists an explicitly global-scoped mixed-command model selection", async () => {
    await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o -g continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
    });

    expect(stickyModelMock.persistBestEffort).toHaveBeenCalledWith({
      agentId: "main",
      model: "openai/gpt-4o",
      target: "defaults",
    });
  });

  it("pins the current configured model when agent scope is explicit", async () => {
    await persistModelDirectiveForTest({
      command: "/model default -a continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6"],
      allowedModelCatalog: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" }],
    });

    expect(stickyModelMock.persistBestEffort).toHaveBeenCalledWith({
      agentId: "main",
      model: "anthropic/claude-opus-4-6",
      target: "agent",
    });
  });

  it("pins the current configured model when global scope is explicit", async () => {
    await persistModelDirectiveForTest({
      command: "/model default -g continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6"],
      allowedModelCatalog: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" }],
    });

    expect(stickyModelMock.persistBestEffort).toHaveBeenCalledWith({
      agentId: "main",
      model: "anthropic/claude-opus-4-6",
      target: "defaults",
    });
  });

  it("rejects persistent model scope without owner authority", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o -a continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
      canPersistStickyModelSelection: false,
    });

    expect(persisted.errorText).toContain("require owner authority");
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    ["-a", "agent"],
    ["-g", "global"],
  ])(
    "leaves a %s-scoped model directive as plain text for an unauthorized sender",
    async (flag) => {
      const { persisted, sessionEntry } = await persistModelDirectiveForTest({
        command: `/model openai/gpt-4o ${flag} continue with the request`,
        allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
        // An unauthorized sender is never the owner; setting only one of these
        // describes a state the gateway cannot produce.
        isAuthorizedSender: false,
        canPersistStickyModelSelection: false,
      });

      // An unauthorized sender's directives are cleared to plain text, so the
      // persistent-scope authority error must not surface the command at all.
      expect(persisted.errorText).toBeUndefined();
      expect(sessionEntry.providerOverride).toBeUndefined();
      expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
    },
  );

  it("rejects conflicting model scopes before changing session or config", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o -a -g continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
    });

    expect(persisted.errorText).toContain("only one model scope");
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });

  it("keeps a mixed-command model selection session-scoped without authority", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
      canPersistStickyModelSelection: false,
    });

    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });

  it("remaps unsupported stored thinking levels when persisting a model switch", async () => {
    const sessionEntry = createSessionEntry({ thinkingLevel: "adaptive" });
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
      sessionEntry,
    });

    expect(sessionEntry.thinkingLevel).toBe("medium");
    expect(persisted.directiveAck?.text).toContain(
      "Thinking level set to medium (adaptive not supported for openai/gpt-4o).",
    );
  });

  it("announces the model change before the thinking remap in the ack", async () => {
    const sessionEntry = createSessionEntry({ thinkingLevel: "adaptive" });

    const result = await runHandleCommand("/model openai/gpt-4o", {
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
      sessionEntry,
    });

    const text = result?.text ?? "";
    expect(text).toContain(
      "Model set to openai/gpt-4o for this session only; configured default unchanged.",
    );
    expect(text).toContain(
      "Thinking level set to medium (adaptive not supported for openai/gpt-4o).",
    );
    // The model change (cause) must be reported before the thinking remap (effect).
    expect(text.indexOf("Model set to")).toBeLessThan(text.indexOf("Thinking level set to"));
  });

  it("fires session:patch when /model changes the persisted session model", async () => {
    const events: InternalHookEvent[] = [];
    registerInternalHook("session:patch", async (event) => {
      events.push(event);
    });
    const sessionEntry = createSessionEntry();

    await runHandleCommand("/model openai/gpt-4o", { sessionEntry });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    const event = expectDefined(events[0], "events[0] test invariant");
    expect(event.type).toBe("session");
    expect(event.action).toBe("patch");
    expect(event.sessionKey).toBe(sessionKey);
    const context = event.context;
    expect(context.patch).toMatchObject({ key: sessionKey, model: "openai/gpt-4o" });
    expect(context.sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      liveModelSwitchPending: true,
    });
  });

  it("keeps xhigh when switching to OpenCode Claude Opus 4.7", async () => {
    setDirectiveTestProviders([
      {
        id: "opencode",
        resolveThinkingProfile: ({ modelId }) => ({
          levels:
            modelId === "claude-opus-4-7"
              ? [
                  { id: "off" },
                  { id: "minimal" },
                  { id: "low" },
                  { id: "medium" },
                  { id: "high" },
                  { id: "xhigh" },
                ]
              : [{ id: "off" }],
        }),
      },
    ]);
    const sessionEntry = createSessionEntry({ thinkingLevel: "xhigh" });

    const result = await runHandleCommand("/model opencode/claude-opus-4-7", {
      allowedModelKeys: new Set([...allowedModelKeys, "opencode/claude-opus-4-7"]),
      allowedModelCatalog: [
        ...allowedModelCatalog,
        { provider: "opencode", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      ],
      sessionEntry,
    });

    expect(result?.text).toContain(
      "Model set to opencode/claude-opus-4-7 for this session only; configured default unchanged.",
    );
    expect(result?.text ?? "").not.toContain("xhigh not supported");
    expect(sessionEntry.thinkingLevel).toBe("xhigh");
  });
  it("retargets queued followups when /model mutates session state", async () => {
    const directives = parseInlineSessionDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();

    await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(queueMocks.refreshQueuedFollowupSession).toHaveBeenCalledWith({
      key: sessionKey,
      nextProvider: "openai",
      nextModel: "gpt-4o",
      nextRouteResolution: "resolved",
      nextModelOverrideSource: "user",
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
      nextThinking: {
        level: undefined,
        catalog: allowedModelCatalog,
        agentRuntime: "codex",
      },
    });
  });

  it("suppresses model side effects when a concurrent switch wins", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-directive-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
    const sessionStore = { [sessionKey]: sessionEntry };
    const persistenceState: NonNullable<HandleDirectiveParams["persistenceState"]> = {
      outcome: { kind: "pending", provider: "anthropic", model: "claude-opus-4-6" },
    };

    try {
      const result = await handleDirectiveOnly(
        createHandleParams({
          directives: parseInlineSessionDirectives("/model openai/gpt-4o"),
          sessionEntry,
          sessionStore,
          storePath,
          persistenceState,
        }),
      );

      expect(result?.text).toContain("Model change was not applied");
      expect(result?.isError).toBe(true);
      expect(persistenceState.outcome).toMatchObject({ kind: "rejected" });
      expect(queueMocks.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        expect.stringContaining("openai/gpt-4o"),
        expect.anything(),
      );
      expect(sessionStore[sessionKey]).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      });
      expect(sessionStore[sessionKey]?.liveModelSwitchPending).toBeUndefined();
      expect(sessionEntry).toEqual(sessionStore[sessionKey]);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(sessionStore[sessionKey]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports a rejected non-model directive after session rotation", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-elevated-directive-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({ elevatedLevel: "full" });
    const rotatedEntry: SessionEntry = {
      sessionId: "s2",
      updatedAt: sessionEntry.updatedAt + 1,
      delivery: { kind: "none" },
      elevatedLevel: "full",
    };
    await replaceSessionEntry({ sessionKey, storePath }, rotatedEntry);
    const sessionStore = { [sessionKey]: sessionEntry };

    try {
      const result = await handleDirectiveOnly(
        createHandleParams({
          directives: parseInlineSessionDirectives("/elevated off"),
          sessionEntry,
          sessionStore,
          storePath,
          elevatedEnabled: true,
          elevatedAllowed: true,
          currentElevatedLevel: "full",
        }),
      );

      expect(result?.text).toContain("Session settings were not applied");
      expect(result?.isError).toBe(true);
      expect(result?.text).not.toContain("Elevated mode disabled");
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        expect.stringContaining("Elevated"),
        expect.anything(),
      );
      expect(sessionStore[sessionKey]).toEqual(rotatedEntry);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicit same-value directive after a concurrent change", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-elevated-directive-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({ elevatedLevel: "off" });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      elevatedLevel: "full",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);

    try {
      const result = await handleDirectiveOnly(
        createHandleParams({
          directives: parseInlineSessionDirectives("/elevated off"),
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          storePath,
          elevatedEnabled: true,
          elevatedAllowed: true,
          currentElevatedLevel: "off",
        }),
      );

      expect(result?.text).toContain("Session settings were not applied");
      expect(result?.isError).toBe(true);
      expect(sessionEntry).toMatchObject({ sessionId: "s1", elevatedLevel: "full" });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a grouped directive when its implicit thinking remap conflicts", async () => {
    setDirectiveTestProviders([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        resolveThinkingProfile: () => ({
          levels: [{ id: "off" }, { id: "low" }, { id: "high" }],
        }),
      },
    ]);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thinking-remap-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({ thinkingLevel: "xhigh" });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      thinkingLevel: "low",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);

    try {
      const result = await handleDirectiveOnly(
        createHandleParams({
          directives: parseInlineSessionDirectives("/fast on"),
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          storePath,
        }),
      );

      expect(result?.text).toContain("Session settings were not applied");
      expect(result?.isError).toBe(true);
      expect(sessionEntry).toMatchObject({ thinkingLevel: "low" });
      expect(sessionEntry.fastMode).toBeUndefined();
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(concurrentEntry);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists auth profile overrides for alias model directives", async () => {
    setAuthProfiles({
      "anthropic:work": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-test",
      },
    });
    const sessionEntry = createSessionEntry();

    const result = await runHandleCommand("/model Opus@anthropic:work", {
      aliasIndex: createOpusAliasIndex(),
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
      sessionEntry,
      formatModelSwitchEvent: (label, alias) =>
        alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`,
    });

    expect(result?.text).toContain(
      "Model set to Opus (anthropic/claude-opus-4-6) for this session only; configured default unchanged.",
    );
    expect(result?.text).toContain("Auth profile set to anthropic:work.");
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-opus-4-6");
    expect(sessionEntry.authProfileOverride).toBe("anthropic:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(queueMocks.refreshQueuedFollowupSession).toHaveBeenCalledWith({
      key: sessionKey,
      nextProvider: "anthropic",
      nextModel: "claude-opus-4-6",
      nextRouteResolution: "resolved",
      nextModelOverrideSource: "user",
      nextAuthProfileId: "anthropic:work",
      nextAuthProfileIdSource: "user",
      nextThinking: {
        level: undefined,
        catalog: expect.arrayContaining([
          expect.objectContaining({ provider: "anthropic", id: "claude-opus-4-6" }),
        ]),
        agentRuntime: "openclaw",
      },
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Model switched to Opus (anthropic/claude-opus-4-6).",
      {
        sessionKey,
        contextKey: "model:anthropic/claude-opus-4-6",
      },
    );
  });

  it("shows no model message when no /model directive", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("hello world", { sessionEntry });

    expect(result?.text ?? "").not.toContain("Model set to");
    expect(result?.text ?? "").not.toContain("failed");
  });

  it("strips inline elevated directives while keeping user text", () => {
    const directives = parseInlineSessionDirectives("hello there /elevated off");

    expect(directives.hasElevatedDirective).toBe(true);
    expect(directives.elevatedLevel).toBe("off");
    expect(directives.cleaned).toBe("hello there");
  });

  it("persists thinkingLevel=off (does not clear)", async () => {
    const sessionEntry = createSessionEntry({ thinkingLevel: "low" });
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await runHandleCommand("/think off", { sessionEntry, sessionStore });

    expect(result?.text ?? "").not.toContain("failed");
    expect(sessionEntry.thinkingLevel).toBe("off");
    expect(sessionStore["agent:main:dm:1"]?.thinkingLevel).toBe("off");
  });

  it("clears thinking override for default directives", async () => {
    const sessionEntry = createSessionEntry({ thinkingLevel: "high" });
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await runHandleCommand("/think default", { sessionEntry, sessionStore });

    expect(result?.text).toContain("Thinking level reset to default.");
    expect(sessionEntry.thinkingLevel).toBeUndefined();
    expect(sessionStore["agent:main:dm:1"]?.thinkingLevel).toBeUndefined();
  });

  it("reports current thinking status", async () => {
    setDirectiveTestProviders([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        resolveThinkingProfile: () => ({
          levels: [
            { id: "off" },
            { id: "minimal" },
            { id: "low" },
            { id: "medium" },
            { id: "adaptive" },
            { id: "high" },
          ],
        }),
      },
    ]);

    const result = await runHandleCommand("/think", { currentThinkLevel: "low" });

    expect(result?.text).toContain("Current thinking level: low");
    expect(result?.text).toContain("Options: default, off, minimal, low, medium, adaptive, high.");
  });

  it("reports the effective thinking level for the pinned runtime", async () => {
    setDirectiveTestProviders([
      {
        id: "openai",
        label: "OpenAI",
        auth: [],
        resolveThinkingProfile: ({ agentRuntime }) => ({
          levels: [
            { id: "off" },
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            { id: "max" },
            ...(agentRuntime === "openclaw" ? ([{ id: "ultra" }] as const) : []),
          ],
        }),
      },
    ]);
    const sessionEntry = createSessionEntry({
      thinkingLevel: "ultra",
      agentRuntimeOverride: "codex",
    });

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineSessionDirectives("/think"),
        provider: "openai",
        model: "gpt-5.6-luna",
        currentThinkLevel: "ultra",
        sessionEntry,
      }),
    );

    expect(result?.text).toContain("Current thinking level: max.");
    expect(result?.text).toContain("Options: default, off, low, medium, high, max.");
    expect(result?.text).not.toContain("ultra");
  });

  it("uses catalog reasoning metadata for provider-owned thinking levels", async () => {
    setDirectiveTestProviders([
      {
        id: "ollama",
        label: "Ollama",
        auth: [],
        resolveThinkingProfile: ({ reasoning }) => ({
          levels:
            reasoning === true
              ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
              : [{ id: "off" }],
          defaultLevel: "off",
        }),
      },
    ]);
    const sessionEntry = createSessionEntry();

    const result = await runHandleCommand("/think medium", {
      provider: "ollama",
      model: "qwen3.6:35b-a3b-mxfp8",
      allowedModelCatalog: [
        {
          provider: "ollama",
          id: "qwen3.6:35b-a3b-mxfp8",
          name: "qwen3.6:35b-a3b-mxfp8",
          reasoning: true,
        },
      ],
      thinkingCatalog: [
        {
          provider: "ollama",
          id: "qwen3.6:35b-a3b-mxfp8",
          name: "qwen3.6:35b-a3b-mxfp8",
          reasoning: true,
        },
      ],
      sessionEntry,
    });

    expect(result?.text).toContain("Thinking level set to medium.");
    expect(sessionEntry.thinkingLevel).toBe("medium");
  });

  it("rejects thinking levels forbidden by the concrete runtime policy", async () => {
    setDirectiveTestProviders([
      {
        id: "anthropic",
        resolveThinkingProfile: () => ({
          levels: [{ id: "minimal" }, { id: "medium" }, { id: "adaptive" }],
          defaultLevel: "adaptive",
          preserveWhenCatalogReasoningFalse: true,
        }),
      },
      {
        id: "claude-cli",
        resolveThinkingProfile: () => ({
          levels: [{ id: "off" }],
          defaultLevel: "off",
        }),
      },
    ]);
    const sessionEntry = createSessionEntry();
    const catalogEntry = {
      provider: "anthropic",
      id: "claude-mythos-5",
      name: "Claude Mythos 5",
      reasoning: false,
      thinkingPolicyProvider: "claude-cli",
    };

    const result = await runHandleCommand("/think medium", {
      provider: "anthropic",
      model: "claude-mythos-5",
      allowedModelKeys: new Set(["anthropic/claude-mythos-5"]),
      allowedModelCatalog: [catalogEntry],
      thinkingCatalog: [catalogEntry],
      sessionEntry,
    });

    expect(result?.text).toContain('Thinking level "medium" is not supported');
    expect(sessionEntry.thinkingLevel).toBeUndefined();
  });

  it("accepts xhigh when the catalog marks reasoning support", async () => {
    const provider = "openai";
    const model = "gpt-5.5";
    setDirectiveTestProviders([
      {
        id: provider,
        label: provider,
        auth: [],
        resolveThinkingProfile: ({ modelId }) => ({
          levels:
            modelId === "gpt-5.5"
              ? [
                  { id: "off" },
                  { id: "minimal" },
                  { id: "low" },
                  { id: "medium" },
                  { id: "high" },
                  { id: "xhigh" },
                ]
              : [{ id: "off" }],
        }),
      },
    ]);
    const sessionEntry = createSessionEntry();
    const catalogEntry = {
      provider,
      id: model,
      name: model,
      reasoning: true,
    };

    const result = await runHandleCommand("/think xhigh", {
      provider,
      model,
      allowedModelCatalog: [catalogEntry],
      thinkingCatalog: [catalogEntry],
      sessionEntry,
    });

    expect(result?.text).toContain("Thinking level set to xhigh.");
    expect(sessionEntry.thinkingLevel).toBe("xhigh");
  });

  it("persists verbose on and off directives", async () => {
    const sessionEntry = createSessionEntry();

    const enabled = await runHandleCommand("/verbose on", { sessionEntry });
    expect(enabled?.text).toMatch(/^⚙️ Verbose logging enabled\./);
    expect(sessionEntry.verboseLevel).toBe("on");

    const disabled = await runHandleCommand("/verbose off", { sessionEntry });
    expect(disabled?.text).toMatch(/Verbose logging disabled\./);
    expect(sessionEntry.verboseLevel).toBe("off");
  });

  it("persists and reports fast-mode directives", async () => {
    const sessionEntry = createSessionEntry();

    const onReply = await runHandleCommand("/fast on", { sessionEntry });
    expect(onReply?.text).toContain("Fast mode enabled");
    expect(sessionEntry.fastMode).toBe(true);

    const statusReply = await runHandleCommand("/fast", {
      sessionEntry,
      currentFastMode: sessionEntry.fastMode,
    });
    expect(statusReply?.text).toContain("Current fast mode: on");

    const offReply = await runHandleCommand("/fast off", {
      sessionEntry,
      currentFastMode: sessionEntry.fastMode,
    });
    expect(offReply?.text).toContain("Fast mode disabled");
    expect(sessionEntry.fastMode).toBe(false);

    const defaultReply = await runHandleCommand("/fast default", {
      sessionEntry,
      currentFastMode: sessionEntry.fastMode,
    });
    expect(defaultReply?.text).toContain("Fast mode reset to default");
    expect(sessionEntry.fastMode).toBeUndefined();
  });

  it("persists and reports elevated-mode directives when allowed", async () => {
    const sessionEntry = createSessionEntry();
    const base = {
      elevatedAllowed: true,
      elevatedEnabled: true,
      sessionEntry,
    } satisfies Partial<HandleParams>;

    const onReply = await runHandleCommand("/elevated on", base);
    expect(onReply?.text).toContain("Elevated mode set to ask");
    expect(sessionEntry.elevatedLevel).toBe("on");

    const statusReply = await runHandleCommand("/elevated", {
      ...base,
      currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
    });
    expect(statusReply?.text).toContain("Current elevated level: on");

    const offReply = await runHandleCommand("/elevated off", {
      ...base,
      currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
    });
    expect(offReply?.text).toContain("Elevated mode disabled");
    expect(sessionEntry.elevatedLevel).toBe("off");
  });

  it("queues system events for elevated and reasoning mode directives", async () => {
    const sessionEntry = createSessionEntry();

    await runHandleCommand("/elevated on", {
      elevatedAllowed: true,
      elevatedEnabled: true,
      sessionEntry,
    });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Elevated ASK - exec runs on host; approvals may still apply.",
      {
        sessionKey,
        contextKey: "mode:elevated",
      },
    );

    vi.mocked(enqueueSystemEvent).mockClear();

    await runHandleCommand("/reasoning stream", { sessionEntry });

    expect(enqueueSystemEvent).toHaveBeenCalledWith("Reasoning STREAM - emit live <think>.", {
      sessionKey,
      contextKey: "mode:reasoning",
    });
  });

  it("blocks internal operator.write exec persistence in directive-only handling", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand(
      "/exec host=node security=allowlist ask=always node=worker-1",
      { sessionEntry, surface: "webchat", gatewayClientScopes: ["operator.write"] },
    );

    expect(result?.text).toContain("operator.admin");
    expect(result?.text).toContain(
      "Exec policy for this run only (security=allowlist, ask=always).",
    );
    expect(sessionEntry.execHost).toBeUndefined();
    expect(sessionEntry.execNode).toBeUndefined();
  });

  it("blocks internal operator.write verbose persistence in directive-only handling", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("/verbose full", {
      sessionEntry,
      surface: "webchat",
      gatewayClientScopes: ["operator.write"],
    });

    expect(result?.text).toContain("Verbose logging set for the current reply only.");
    expect(result?.text).toContain("operator.admin");
    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("allows internal operator.admin verbose persistence in directive-only handling", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("/verbose full", {
      sessionEntry,
      surface: "webchat",
      gatewayClientScopes: ["operator.admin"],
    });

    expect(result?.text).toContain("Verbose logging set to full.");
    expect(sessionEntry.verboseLevel).toBe("full");
  });

  it.each([
    { options: "security=deny", policy: "security=deny", scope: "operator.write" },
    { options: "ask=always", policy: "ask=always", scope: "operator.write" },
    {
      options: "host=node security=allowlist ask=always node=worker-1",
      policy: "security=allowlist, ask=always",
      placement: { execHost: "node", execNode: "worker-1" },
      scope: "operator.admin",
    },
  ])(
    "acknowledges /exec $options policy for this run only",
    async ({ options, policy, placement, scope }) => {
      const sessionEntry = createSessionEntry();
      const initialEntry = { ...sessionEntry };
      const result = await runHandleCommand(`/exec ${options}`, {
        sessionEntry,
        surface: "webchat",
        gatewayClientScopes: [scope],
      });

      expect(result?.text).toContain(`Exec policy for this run only (${policy}).`);
      if (placement) {
        expect(result?.text).toContain("Exec defaults set (host=node, node=worker-1).");
      } else {
        expect(result?.text).not.toContain("operator.admin");
      }
      expect(sessionEntry).toEqual({
        ...initialEntry,
        ...placement,
        updatedAt: expect.any(Number),
      });
    },
  );
});

describe("canonical session directive persistence policy", () => {
  it("checks an explicit same-value model selection against persisted state", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inline-model-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:same-model";
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
    });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      modelOverride: "gpt-5.5",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
    const directives = parseInlineSessionDirectives("hello /model openai/gpt-4o");

    try {
      const result = await handleDirectiveOnly(
        createDirectiveHandlingParams({
          directives,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath,
          allowedModelKeys: new Set(["openai/gpt-4o"]),
          allowedModelCatalog: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
          provider: "openai",
          model: "gpt-4o",
          initialModelLabel: "openai/gpt-4o",
        }),
      );

      expect(result?.text).toContain("Model change was not applied");
      expect(result?.isError).toBe(true);
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns the concurrent model winner without emitting switch side effects", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inline-model-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:race";
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
    const sessionStore = { [sessionKey]: sessionEntry };
    const directives = parseInlineSessionDirectives("hello /model openai/gpt-4o");
    const patchEvents: InternalHookEvent[] = [];
    registerInternalHook("session:patch", async (event) => {
      patchEvents.push(event);
    });

    try {
      const result = await handleDirectiveOnly(
        createDirectiveHandlingParams({
          directives,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          allowedModelCatalog: [
            { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
            { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
          ],
        }),
      );

      expect(result?.text).toContain("Model change was not applied");
      expect(result?.isError).toBe(true);
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        expect.stringContaining("openai/gpt-4o"),
        expect.anything(),
      );
      expect(patchEvents).toEqual([]);
      expect(sessionStore[sessionKey]).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      });
      expect(sessionEntry).toEqual(sessionStore[sessionKey]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips exec persistence for internal operator.write callers", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(EXEC_DEFAULTS_DIRECTIVE);

    expectExecDefaults(sessionEntry, false);
  });

  it("skips verbose persistence for internal operator.write callers", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(VERBOSE_DEFAULT_DIRECTIVE);

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("skips exec persistence for unauthorized external callers even when gateway scopes are empty", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      EXEC_DEFAULTS_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: [] }),
    );

    expectExecDefaults(sessionEntry, false);
  });

  it("skips verbose persistence for unauthorized external callers even when gateway scopes are empty", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      VERBOSE_DEFAULT_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: [] }),
    );

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("allows authorized external callers with empty gateway scopes to persist exec defaults", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      EXEC_DEFAULTS_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: [], commandAuthorized: true }),
    );

    expectExecDefaults(sessionEntry, true);
  });

  it("allows authorized external callers with empty gateway scopes to persist verbose defaults", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      VERBOSE_DEFAULT_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: [], commandAuthorized: true }),
    );

    expect(sessionEntry.verboseLevel).toBe("full");
  });

  it("skips exec persistence for non-webchat channel callers without gateway scopes", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      EXEC_DEFAULTS_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: undefined }),
    );

    expectExecDefaults(sessionEntry, false);
  });

  it("skips verbose persistence for non-webchat channel callers without gateway scopes", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      VERBOSE_DEFAULT_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: undefined }),
    );

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("allows exec persistence for authorized non-webchat channel callers without gateway scopes", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      EXEC_DEFAULTS_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: undefined, commandAuthorized: true }),
    );

    expectExecDefaults(sessionEntry, true);
  });

  it("allows verbose persistence for authorized non-webchat channel callers without gateway scopes", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      VERBOSE_DEFAULT_DIRECTIVE,
      externalChannelPolicy({ gatewayClientScopes: undefined, commandAuthorized: true }),
    );

    expect(sessionEntry.verboseLevel).toBe("full");
  });

  it("allows authorized external provider callers when surface carries webchat metadata", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      EXEC_DEFAULTS_DIRECTIVE,
      externalChannelPolicy({
        surface: "webchat",
        gatewayClientScopes: ["operator.write"],
        commandAuthorized: true,
      }),
    );

    expectExecDefaults(sessionEntry, true);
  });

  it("allows authorized external provider verbose callers when surface carries webchat metadata", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(VERBOSE_DEFAULT_DIRECTIVE, {
      ...externalChannelPolicy(),
      surface: "webchat",
      gatewayClientScopes: ["operator.write"],
      commandAuthorized: true,
    });

    expect(sessionEntry.verboseLevel).toBe("full");
  });

  it("allows exec persistence for local callers without channel context", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(EXEC_DEFAULTS_DIRECTIVE, {
      messageProvider: undefined,
      surface: undefined,
      gatewayClientScopes: undefined,
    });

    expectExecDefaults(sessionEntry, true);
  });

  it("treats internal provider context as authoritative over external surface metadata", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(VERBOSE_DEFAULT_DIRECTIVE, {
      messageProvider: "webchat",
      surface: "forum",
    });

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("keeps internal provider authoritative over authorized external surface metadata", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(VERBOSE_DEFAULT_DIRECTIVE, {
      messageProvider: "webchat",
      surface: "telegram",
      gatewayClientScopes: ["operator.write"],
      commandAuthorized: true,
    });

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
