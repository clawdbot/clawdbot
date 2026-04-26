import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const authProfilesStoreMock = vi.hoisted(() => ({
  profiles: {} as Record<string, { type: "api_key"; provider: string; key: string }>,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  clearRuntimeAuthProfileStoreSnapshots: () => {
    authProfilesStoreMock.profiles = {};
  },
  ensureAuthProfileStore: () => ({
    version: 1,
    profiles: authProfilesStoreMock.profiles,
  }),
  isProfileInCooldown: () => false,
  replaceRuntimeAuthProfileStoreSnapshots: (
    snapshots: Array<{
      store?: { profiles?: Record<string, { type: "api_key"; provider: string; key: string }> };
    }>,
  ) => {
    authProfilesStoreMock.profiles = snapshots[0]?.store?.profiles ?? {};
  },
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthProfileOrder: () => [],
  resolveAuthStorePathForDisplay: () => "/tmp/auth-profiles.json",
}));

vi.mock("../../agents/auth-profiles/store.js", () => {
  const store = () => ({
    version: 1,
    profiles: authProfilesStoreMock.profiles,
  });
  return {
    clearRuntimeAuthProfileStoreSnapshots: () => {
      authProfilesStoreMock.profiles = {};
    },
    ensureAuthProfileStore: store,
    ensureAuthProfileStoreForLocalUpdate: store,
    findPersistedAuthProfileCredential: ({ profileId }: { profileId: string }) =>
      authProfilesStoreMock.profiles[profileId],
    hasAnyAuthProfileStoreSource: () => Object.keys(authProfilesStoreMock.profiles).length > 0,
    loadAuthProfileStore: store,
    loadAuthProfileStoreForRuntime: store,
    loadAuthProfileStoreForSecretsRuntime: store,
    loadAuthProfileStoreWithoutExternalProfiles: store,
    replaceRuntimeAuthProfileStoreSnapshots: (
      snapshots: Array<{
        store?: { profiles?: Record<string, { type: "api_key"; provider: string; key: string }> };
      }>,
    ) => {
      authProfilesStoreMock.profiles = snapshots[0]?.store?.profiles ?? {};
    },
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async ({ update }) => update(store())),
  };
});

import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { ElevatedLevel } from "../thinking.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import {
  maybeHandleModelDirectiveInfo,
  resolveModelSelectionFromDirective,
} from "./directive-handling.model.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";

const liveModelSwitchMocks = vi.hoisted(() => ({
  requestLiveSessionModelSwitch: vi.fn(),
}));
const queueMocks = vi.hoisted(() => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

// Mock dependencies for directive handling persistence.
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentEffectiveModelPrimary: vi.fn(() => undefined),
  resolveAgentModelFallbacksOverride: vi.fn(() => undefined),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
    { provider: "localai", id: "ultra-chat", name: "Ultra Chat" },
  ]),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../agents/live-model-switch.js", () => ({
  requestLiveSessionModelSwitch: (...args: unknown[]) =>
    liveModelSwitchMocks.requestLiveSessionModelSwitch(...args),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) =>
    queueMocks.refreshQueuedFollowupSession(...args),
}));

const TEST_AGENT_DIR = "/tmp/agent";
const OPENAI_DATE_PROFILE_ID = "20251001";

type ApiKeyProfile = { type: "api_key"; provider: string; key: string };

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function setDirectiveTestProviders(providers: ProviderPlugin[]): void {
  const registry = createEmptyPluginRegistry();
  registry.providers = providers.map((provider) => ({
    pluginId: "test",
    provider,
    source: "test",
  }));
  setActivePluginRegistry(registry);
}

beforeEach(() => {
  setDirectiveTestProviders([]);
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
  liveModelSwitchMocks.requestLiveSessionModelSwitch.mockReset().mockReturnValue(false);
  queueMocks.refreshQueuedFollowupSession.mockReset();
});

afterEach(() => {
  setDirectiveTestProviders([]);
  clearRuntimeAuthProfileStoreSnapshots();
});

function setAuthProfiles(profiles: Record<string, ApiKeyProfile>) {
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
}) {
  return resolveModelSelectionFromDirective({
    directives: parseInlineDirectives(params.command),
    cfg: { commands: { text: true } } as unknown as OpenClawConfig,
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
  aliasIndex?: ModelAliasIndex;
  allowedModelKeys: string[];
  sessionEntry?: SessionEntry;
  provider?: string;
  model?: string;
  initialModelLabel?: string;
}) {
  if (params.profiles) {
    setAuthProfiles(params.profiles);
  }
  const directives = parseInlineDirectives(params.command);
  const cfg = baseConfig();
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const persisted = await persistInlineDirectives({
    directives,
    effectiveModelDirective: directives.rawModelDirective,
    cfg,
    agentDir: TEST_AGENT_DIR,
    sessionEntry,
    sessionStore: { "agent:main:dm:1": sessionEntry },
    sessionKey: "agent:main:dm:1",
    storePath: undefined,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: params.aliasIndex ?? baseAliasIndex(),
    allowedModelKeys: new Set(params.allowedModelKeys),
    provider: params.provider ?? "anthropic",
    model: params.model ?? "claude-opus-4-6",
    initialModelLabel:
      params.initialModelLabel ??
      `${params.provider ?? "anthropic"}/${params.model ?? "claude-opus-4-6"}`,
    formatModelSwitchEvent: (label) => label,
    agentCfg: cfg.agents?.defaults,
  });
  return { persisted, sessionEntry };
}

type PersistInlineDirectivesParams = Parameters<typeof persistInlineDirectives>[0];

async function persistInternalOperatorWriteDirective(
  command: string,
  overrides: Partial<PersistInlineDirectivesParams> = {},
) {
  const sessionEntry = overrides.sessionEntry ?? createSessionEntry();
  const sessionStore = overrides.sessionStore ?? { "agent:main:main": sessionEntry };
  await persistInlineDirectives({
    directives: parseInlineDirectives(command),
    cfg: baseConfig(),
    sessionEntry,
    sessionStore,
    sessionKey: "agent:main:main",
    storePath: "/tmp/sessions.json",
    elevatedEnabled: true,
    elevatedAllowed: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    agentCfg: undefined,
    surface: "webchat",
    gatewayClientScopes: ["operator.write"],
    ...overrides,
  });
  return sessionEntry;
}

async function resolveModelInfoReply(
  overrides: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]> = {},
) {
  return maybeHandleModelDirectiveInfo({
    directives: parseInlineDirectives("/model"),
    cfg: baseConfig(),
    agentDir: TEST_AGENT_DIR,
    activeAgentId: "main",
    provider: "anthropic",
    model: "claude-opus-4-6",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    ...overrides,
  });
}

describe("/model chat UX", () => {
  it("shows summary for /model with no args", async () => {
    const reply = await resolveModelInfoReply();

    expect(reply?.text).toContain("Current:");
    expect(reply?.text).toContain("Browse: /models");
    expect(reply?.text).toContain("Switch: /model <provider/model>");
  });

  it("treats /model list as a models browser alias, not a model id", async () => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineDirectives("/model list"),
    });

    expect(reply?.text).toContain("Providers:");
    expect(reply?.text).toContain("Use: /models <provider>");
    expect(reply?.text).toContain("Switch: /model <provider/model>");
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
      directives: parseInlineDirectives("/model status"),
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
      } as OpenClawConfig,
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

  it("auto-applies closest match for typos", () => {
    const directives = parseInlineDirectives("/model anthropic/claud-opus-4-5");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;

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
      directives: parseInlineDirectives(`/model gpt@${OPENAI_DATE_PROFILE_ID}`),
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

  it("persists provider-compatible runtime overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime codex hello",
      allowedModelKeys: ["openai/gpt-4o"],
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
  });

  it("canonicalizes legacy Codex app-server runtime overrides during persistence", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime codex-app-server hello",
      allowedModelKeys: ["openai/gpt-4o"],
    });

    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
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

  it("ignores runtime overrides that do not belong to the selected provider", async () => {
    vi.mocked(enqueueSystemEvent).mockClear();
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime claude-cli hello",
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry: createSessionEntry({ agentRuntimeOverride: "pi" }),
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
    });

    expect(sessionEntry.agentRuntimeOverride).toBe("pi");
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Ignored unsupported runtime claude-cli for openai.",
      {
        sessionKey: "agent:main:dm:1",
        contextKey: "model-runtime:openai:claude-cli",
      },
    );
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
      config: expect.any(Object),
    });
    expect(resolveAgentDir).toHaveBeenCalledWith(expect.any(Object), "target");
  });

  it("persists explicit auth profiles after @YYYYMMDD version suffixes in mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: `/model custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}@work hello`,
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
  const storePath = "/tmp/sessions.json";

  type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

  function createHandleParams(overrides: Partial<HandleParams>): HandleParams {
    const entryOverride = overrides.sessionEntry;
    const storeOverride = overrides.sessionStore;
    const entry = entryOverride ?? createSessionEntry();
    const store = storeOverride ?? ({ [sessionKey]: entry } as const);
    const { sessionEntry: _ignoredEntry, sessionStore: _ignoredStore, ...rest } = overrides;

    return {
      cfg: baseConfig(),
      directives: rest.directives ?? parseInlineDirectives(""),
      sessionKey,
      storePath,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys,
      allowedModelCatalog,
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      ...rest,
      sessionEntry: entry,
      sessionStore: store,
    };
  }

  it("shows success message when session state is available", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text).toContain("Model set to");
    expect(result?.text).toContain("openai/gpt-4o");
    expect(result?.text).not.toContain("failed");
    expect(sessionEntry.liveModelSwitchPending).toBe(true);
  });

  it("remaps unsupported stored thinking levels when persisting a model switch", async () => {
    const sessionEntry = createSessionEntry({ thinkingLevel: "adaptive" });
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
      sessionEntry,
    });

    expect(sessionEntry.thinkingLevel).toBe("medium");
    expect(persisted.thinkingRemap).toEqual({
      from: "adaptive",
      to: "medium",
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("does not request a live restart when /model mutates an active session", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();

    await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(liveModelSwitchMocks.requestLiveSessionModelSwitch).not.toHaveBeenCalled();
  });

  it("retargets queued followups when /model mutates session state", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
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
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
    });
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
    const sessionStore = { [sessionKey]: sessionEntry };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/model Opus@anthropic:work"),
        aliasIndex: createOpusAliasIndex(),
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        provider: "openai",
        model: "gpt-4o",
        initialModelLabel: "openai/gpt-4o",
        sessionEntry,
        sessionStore,
        formatModelSwitchEvent: (label, alias) =>
          alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`,
      }),
    );

    expect(result?.text).toContain("Model set to Opus (anthropic/claude-opus-4-6).");
    expect(result?.text).toContain("Auth profile set to anthropic:work.");
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-opus-4-6");
    expect(sessionEntry.authProfileOverride).toBe("anthropic:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(queueMocks.refreshQueuedFollowupSession).toHaveBeenCalledWith({
      key: sessionKey,
      nextProvider: "anthropic",
      nextModel: "claude-opus-4-6",
      nextAuthProfileId: "anthropic:work",
      nextAuthProfileIdSource: "user",
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
    const directives = parseInlineDirectives("hello world");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text ?? "").not.toContain("Model set to");
    expect(result?.text ?? "").not.toContain("failed");
  });

  it("strips inline elevated directives while keeping user text", () => {
    const directives = parseInlineDirectives("hello there /elevated off");

    expect(directives.hasElevatedDirective).toBe(true);
    expect(directives.elevatedLevel).toBe("off");
    expect(directives.cleaned).toBe("hello there");
  });

  it("persists thinkingLevel=off (does not clear)", async () => {
    const directives = parseInlineDirectives("/think off");
    const sessionEntry = createSessionEntry({ thinkingLevel: "low" });
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text ?? "").not.toContain("failed");
    expect(sessionEntry.thinkingLevel).toBe("off");
    expect(sessionStore["agent:main:dm:1"]?.thinkingLevel).toBe("off");
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

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/think"),
        currentThinkLevel: "low",
      }),
    );

    expect(result?.text).toContain("Current thinking level: low");
    expect(result?.text).toContain("Options: off, minimal, low, medium, adaptive, high.");
  });

  it("persists verbose on and off directives", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };

    const enabled = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/verbose on"),
        sessionEntry,
        sessionStore,
      }),
    );
    expect(enabled?.text).toMatch(/^⚙️ Verbose logging enabled\./);
    expect(sessionEntry.verboseLevel).toBe("on");

    const disabled = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/verbose off"),
        sessionEntry,
        sessionStore,
      }),
    );
    expect(disabled?.text).toMatch(/Verbose logging disabled\./);
    expect(sessionEntry.verboseLevel).toBe("off");
  });

  it("persists and reports fast-mode directives", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };

    const onReply = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/fast on"),
        sessionEntry,
        sessionStore,
      }),
    );
    expect(onReply?.text).toContain("Fast mode enabled");
    expect(sessionEntry.fastMode).toBe(true);

    const statusReply = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/fast"),
        sessionEntry,
        sessionStore,
        currentFastMode: sessionEntry.fastMode,
      }),
    );
    expect(statusReply?.text).toContain("Current fast mode: on");

    const offReply = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/fast off"),
        sessionEntry,
        sessionStore,
        currentFastMode: sessionEntry.fastMode,
      }),
    );
    expect(offReply?.text).toContain("Fast mode disabled");
    expect(sessionEntry.fastMode).toBe(false);
  });

  it("persists and reports elevated-mode directives when allowed", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const base = {
      elevatedAllowed: true,
      elevatedEnabled: true,
      sessionEntry,
      sessionStore,
    } satisfies Partial<HandleParams>;

    const onReply = await handleDirectiveOnly(
      createHandleParams({
        ...base,
        directives: parseInlineDirectives("/elevated on"),
      }),
    );
    expect(onReply?.text).toContain("Elevated mode set to ask");
    expect(sessionEntry.elevatedLevel).toBe("on");

    const statusReply = await handleDirectiveOnly(
      createHandleParams({
        ...base,
        directives: parseInlineDirectives("/elevated"),
        currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
      }),
    );
    expect(statusReply?.text).toContain("Current elevated level: on");

    const offReply = await handleDirectiveOnly(
      createHandleParams({
        ...base,
        directives: parseInlineDirectives("/elevated off"),
        currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
      }),
    );
    expect(offReply?.text).toContain("Elevated mode disabled");
    expect(sessionEntry.elevatedLevel).toBe("off");
  });

  it("queues system events for elevated and reasoning mode directives", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };

    await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/elevated on"),
        elevatedAllowed: true,
        elevatedEnabled: true,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Elevated ASK - exec runs on host; approvals may still apply.",
      {
        sessionKey,
        contextKey: "mode:elevated",
      },
    );

    vi.mocked(enqueueSystemEvent).mockClear();

    await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/reasoning stream"),
        sessionEntry,
        sessionStore,
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith("Reasoning STREAM - emit live <think>.", {
      sessionKey,
      contextKey: "mode:reasoning",
    });
  });

  it("blocks internal operator.write exec persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
        surface: "webchat",
        gatewayClientScopes: ["operator.write"],
      }),
    );

    expect(result?.text).toContain("operator.admin");
    expect(sessionEntry.execHost).toBeUndefined();
    expect(sessionEntry.execSecurity).toBeUndefined();
    expect(sessionEntry.execAsk).toBeUndefined();
    expect(sessionEntry.execNode).toBeUndefined();
  });

  it("blocks internal operator.write verbose persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives("/verbose full");
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
        surface: "webchat",
        gatewayClientScopes: ["operator.write"],
      }),
    );

    expect(result?.text).toContain("Verbose logging set for the current reply only.");
    expect(result?.text).toContain("operator.admin");
    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("allows internal operator.admin verbose persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives("/verbose full");
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
        surface: "webchat",
        gatewayClientScopes: ["operator.admin"],
      }),
    );

    expect(result?.text).toContain("Verbose logging set to full.");
    expect(sessionEntry.verboseLevel).toBe("full");
  });

  it("allows internal operator.admin exec persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
        surface: "webchat",
        gatewayClientScopes: ["operator.admin"],
      }),
    );

    expect(result?.text).toContain("Exec defaults set");
    expect(sessionEntry.execHost).toBe("node");
    expect(sessionEntry.execSecurity).toBe("allowlist");
    expect(sessionEntry.execAsk).toBe("always");
    expect(sessionEntry.execNode).toBe("worker-1");
  });
});

describe("persistInlineDirectives internal exec scope gate", () => {
  it("skips exec persistence for internal operator.write callers", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );

    expect(sessionEntry.execHost).toBeUndefined();
    expect(sessionEntry.execSecurity).toBeUndefined();
    expect(sessionEntry.execAsk).toBeUndefined();
    expect(sessionEntry.execNode).toBeUndefined();
  });

  it("skips verbose persistence for internal operator.write callers", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective("/verbose full");

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("treats internal provider context as authoritative over external surface metadata", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective("/verbose full", {
      messageProvider: "webchat",
      surface: "forum",
    });

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });
});
