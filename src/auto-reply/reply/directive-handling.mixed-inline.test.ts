// Tests mixed directives through the real reply admission and transaction boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import { buildTestCtx } from "./test-ctx.js";

type PersistenceResult =
  | { status: "current"; entry: SessionEntry }
  | { status: "model-selection-locked"; entry: SessionEntry }
  | { status: "lifecycle-invalidated"; error: string; entry?: SessionEntry };

const persistenceMocks = vi.hoisted(() => ({
  persist: vi.fn<(params: { entry: SessionEntry }) => Promise<PersistenceResult>>(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: vi.fn(() => []),
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentIds: vi.fn(() => ({ requestedAgentId: "main", sessionAgentId: "main" })),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../agents/sticky-model-selection.js", () => ({
  persistStickyModelSelectionBestEffort: vi.fn(),
}));

vi.mock("../../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: (params: { entry: SessionEntry }) => persistenceMocks.persist(params),
}));

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1, ...overrides };
}

async function applyMixedDirectives(params: {
  body: string;
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  channel?: string;
  provider?: string;
  model?: string;
  defaultProvider?: string;
  defaultModel?: string;
  allowedModels?: ModelCatalogEntry[];
  modelAliases?: string[];
  aliasIndex?: ModelAliasIndex;
  senderIsOwner?: boolean;
  gatewayClientScopes?: string[];
  directives?: InlineDirectives;
}) {
  const cfg =
    params.cfg ?? ({ commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig);
  const provider = params.provider ?? "anthropic";
  const model = params.model ?? "claude-opus-4-6";
  const channel = params.channel ?? "telegram";
  const sessionKey = params.sessionKey ?? "agent:main:dm:1";
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const sessionStore = { [sessionKey]: sessionEntry };
  const directives =
    params.directives ??
    parseInlineSessionDirectives(params.body, {
      modelAliases: params.modelAliases,
    });
  const allowedModels = params.allowedModels ?? [];
  const aliasIndex = params.aliasIndex ?? { byAlias: new Map(), byKey: new Map() };
  const modelState: Parameters<typeof applyInlineDirectiveOverrides>[0]["modelState"] = {
    provider,
    model,
    requestedRouteResolution: "resolved",
    allowedModelKeys: new Set(allowedModels.map((entry) => `${entry.provider}/${entry.id}`)),
    allowedModelCatalog: allowedModels,
    policyAliasIndex: aliasIndex,
    resetModelOverride: false,
    resolveThinkingCatalog: async () => allowedModels,
    resolveDefaultThinkingLevel: async () => "off",
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
  };
  const typing = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };

  const result = await applyInlineDirectiveOverrides({
    ctx: {
      Body: params.body,
      Provider: channel,
      Surface: channel,
      ...(params.gatewayClientScopes ? { GatewayClientScopes: params.gatewayClientScopes } : {}),
    },
    cfg,
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: cfg.agents?.defaults ?? {},
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath: params.storePath,
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command: {
      surface: channel,
      channel,
      ownerList: [],
      senderIsOwner: params.senderIsOwner ?? false,
      isAuthorizedSender: true,
      rawBodyNormalized: params.body,
      commandBodyNormalized: params.body,
    },
    directives,
    messageProviderKey: channel,
    elevatedEnabled: true,
    elevatedAllowed: true,
    elevatedFailures: [],
    defaultProvider: params.defaultProvider ?? provider,
    defaultModel: params.defaultModel ?? model,
    aliasIndex,
    provider,
    model,
    modelState,
    initialModelLabel: `${provider}/${model}`,
    formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 8192,
    effectiveModelDirective: directives.rawModelDirective,
    typing,
  });

  return { result, sessionEntry, sessionStore, typing };
}

describe("mixed inline directives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValue("requested");
    persistenceMocks.persist.mockImplementation(async ({ entry }) => ({
      status: "current",
      entry: { ...entry },
    }));
  });

  it("commits mixed reasoning exactly once and emits one transition", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/reasoning on",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      directiveAck: { text: "⚙️ Reasoning visibility enabled." },
    });
    expect(sessionEntry.reasoningLevel).toBe("on");
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "off", initial: "on", expectedAck: "Reasoning visibility disabled." },
    { mode: "stream", initial: undefined, expectedAck: "Reasoning stream enabled." },
  ])(
    "persists reasoning $mode with a channel-neutral acknowledgement",
    async ({ mode, initial, expectedAck }) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply\n/reasoning ${mode}`,
        sessionEntry: createSessionEntry({ reasoningLevel: initial }),
        channel: "discord",
      });

      expect(result).toMatchObject({
        kind: "continue",
        directiveAck: { text: `⚙️ ${expectedAck}` },
      });
      expect(sessionEntry.reasoningLevel).toBe(mode);
    },
  );

  it("commits a model switch and retargets queued followups once", async () => {
    const cfg = {
      commands: { text: true },
      agents: {
        defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } } },
      },
    } as OpenClawConfig;
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna",
      cfg,
      sessionEntry: createSessionEntry({ thinkingLevel: "ultra" }),
      storePath: "/tmp/sessions.json",
      provider: "openai",
      model: "gpt-5.6-sol",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      senderIsOwner: true,
    });

    expect(result).toMatchObject({ kind: "continue", provider: "openai", model: "gpt-5.6-luna" });
    expect(sessionEntry.thinkingLevel).toBe("max");
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(triggerSessionPatchHook).toHaveBeenCalledOnce();
    expect(refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    expect(persistStickyModelSelectionBestEffort).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Model switched to openai/gpt-5.6-luna.", {
      sessionKey: "agent:main:dm:1",
      contextKey: "model:openai/gpt-5.6-luna",
    });
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "agent:main:dm:1",
        nextProvider: "openai",
        nextModel: "gpt-5.6-luna",
        nextThinking: expect.objectContaining({ level: "max", agentRuntime: "codex" }),
      }),
    );
  });

  it.each([
    { label: "bare", body: "please reply /model" },
    { label: "list", body: "please reply /model list" },
    { label: "status", body: "please reply /model status" },
  ])("does not acknowledge or mutate a mixed $label model info directive", async ({ body }) => {
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const directives = resolveReplyDirectiveRouting({
      commandText: body,
      agentText: body,
      modelAliases: [],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: false,
      wasMentioned: false,
      ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
      cfg,
      agentId: "main",
      resetTriggered: false,
    }).directives;
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { cleaned: "please reply", hasModelDirective: false },
    });
    expect(result).not.toHaveProperty("directiveAck");
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    { name: "directive-only", body: "/model openai/gpt-5.6-luna -s" },
    { name: "mixed-content", body: "please reply /model openai/gpt-5.6-luna -s" },
  ])("keeps an owner $name selection session-only", async ({ body }) => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject(
      body.startsWith("/model")
        ? {
            kind: "reply",
            reply: {
              text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
            },
          }
        : {
            kind: "continue",
            provider: "openai",
            model: "gpt-5.6-luna",
            directiveAck: {
              text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
            },
          },
    );
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    { name: "legacy user", marker: undefined, expectedSource: "user" as const },
    { name: "marker-backed auto", marker: 0, expectedSource: "auto" as const },
  ])(
    "forwards a source-less $name auth profile canonically after /model",
    async ({ marker, expectedSource }) => {
      const sessionEntry = createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        authProfileOverride: "openai:work",
        ...(marker === undefined ? {} : { authProfileOverrideCompactionCount: marker }),
      });

      await applyMixedDirectives({
        body: "/model openai/gpt-5.6-luna -s",
        senderIsOwner: true,
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionEntry,
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      });

      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(marker);
      expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({
          nextAuthProfileId: "openai:work",
          nextAuthProfileIdSource: expectedSource,
        }),
      );
    },
  );

  it("applies an owner alias session scope without continuing to the model", async () => {
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "luna",
          {
            alias: "luna",
            ref: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
      ]),
      byKey: new Map([["openai/gpt-5.6-luna", ["luna"]]]),
    };
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/luna -s",
      modelAliases: ["luna"],
      aliasIndex,
      senderIsOwner: true,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "Model set to luna (openai/gpt-5.6-luna) for this session only; configured default unchanged.",
      },
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("preserves a mixed alias named list as a model selection", async () => {
    const body = "please reply /list -s";
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "list",
          {
            alias: "list",
            ref: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
      ]),
      byKey: new Map([["openai/gpt-5.6-luna", ["list"]]]),
    };
    const directives = resolveReplyDirectiveRouting({
      commandText: body,
      agentText: body,
      modelAliases: ["list"],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: false,
      wasMentioned: false,
      ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
      cfg,
      agentId: "main",
      resetTriggered: false,
    }).directives;
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
      modelAliases: ["list"],
      aliasIndex,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(directives).toMatchObject({
      cleaned: "please reply",
      hasModelDirective: true,
      modelDirectiveSource: "alias",
      rawModelDirective: "list",
    });
    expect(result).toMatchObject({
      kind: "continue",
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
  });

  it.each(["--runtime codex -s", "-s --runtime codex"])(
    "applies mixed-content /model runtime and session options from %s",
    async (options) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply /model openai/gpt-5.6-luna ${options}`,
        senderIsOwner: true,
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      });

      expect(result).toMatchObject({
        kind: "continue",
        provider: "openai",
        model: "gpt-5.6-luna",
        directiveAck: {
          text: expect.stringContaining(
            "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
          ),
        },
      });
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-luna",
        agentRuntimeOverride: "codex",
      });
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "directive-only", body: "/model openai/gpt-5.6-luna" },
    { name: "mixed-content", body: "please reply /model openai/gpt-5.6-luna" },
  ])("reports immutable config for an owner $name selection", async ({ body }) => {
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValueOnce("skipped-immutable");

    const { result } = await applyMixedDirectives({
      body,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    const expectedText =
      "Model set to openai/gpt-5.6-luna for this session. Configured default unchanged because configuration is immutable.";
    expect(result).toMatchObject(
      body.startsWith("/model")
        ? { kind: "reply", reply: { text: expectedText } }
        : { kind: "continue", directiveAck: { text: expectedText } },
    );
  });

  it("does not let a partial session option suppress the configured-default write", async () => {
    const { result } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna -slow",
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "continue",
      provider: "openai",
      model: "gpt-5.6-luna",
      directiveAck: {
        text: "Model set to openai/gpt-5.6-luna for this session. Configured default update requested.",
      },
    });
    expect(persistStickyModelSelectionBestEffort).toHaveBeenCalledOnce();
  });

  it("clears an incompatible auth pin with a cross-provider /model default -s", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    const { result } = await applyMixedDirectives({
      body: "/model default -s",
      senderIsOwner: true,
      sessionEntry,
      allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Session model reset to configured default (anthropic/claude-opus-4-6).",
      },
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({ nextModelOverrideSource: undefined }),
    );
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("preserves a compatible auth pin with a same-provider /model default -s", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    const { result } = await applyMixedDirectives({
      body: "/model default -s",
      senderIsOwner: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-luna",
      sessionEntry,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Session model reset to configured default (openai/gpt-5.6-luna).",
      },
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({ nextModelOverrideSource: undefined }),
    );
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("keeps an operator.admin selection session-only", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/model openai/gpt-5.6-luna --session",
      gatewayClientScopes: ["operator.admin"],
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
      },
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("routes a mixed default reset to the actual default after clearing override fields", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model default",
      provider: "openai",
      model: "gpt-5.6-sol",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      sessionEntry: createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelOverrideSource: "user",
      }),
      allowedModels: [
        {
          provider: "anthropic",
          id: "claude-opus-4-6",
          name: "Claude Opus",
          contextTokens: 90_000,
        },
      ],
    });

    expect(result).toMatchObject({
      kind: "continue",
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextTokens: 1_000_000,
      directiveAck: {
        text: "Session model reset to configured default (anthropic/claude-opus-4-6).",
      },
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
  });

  it("preserves persisted and per-message queue options in one mixed transaction", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/queue collect debounce:1500 cap:4 drop:old",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      perMessageQueueMode: "collect",
      perMessageQueueOptions: { debounceMs: 1500, cap: 4, dropPolicy: "old" },
    });
    expect(sessionEntry).toMatchObject({
      queueMode: "collect",
      queueDebounceMs: 1500,
      queueCap: 4,
    });
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
  });

  it("persists fast-mode and external exec defaults for authorized mixed messages", async () => {
    const fast = await applyMixedDirectives({ body: "please reply\n/fast on" });
    expect(fast.sessionEntry.fastMode).toBe(true);

    const exec = await applyMixedDirectives({
      body: "please reply\n/exec host=node security=allowlist ask=always node=worker-1",
      gatewayClientScopes: [],
    });
    expect(exec.result).toMatchObject({
      kind: "continue",
      directiveAck: { text: expect.stringContaining("Exec defaults set") },
    });
    expect(exec.sessionEntry).toMatchObject({
      execHost: "node",
      execSecurity: "allowlist",
      execAsk: "always",
      execNode: "worker-1",
    });
  });

  it("does not persist trace directives for unauthorized mixed messages", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/trace raw",
      sessionEntry: createSessionEntry({ traceLevel: "off" }),
      gatewayClientScopes: [],
    });

    expect(result).toMatchObject({ kind: "continue" });
    expect(sessionEntry.traceLevel).toBe("off");
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it.each([
    {
      ignored: "/trace raw",
      expectedAck: "/trace is restricted to owners",
    },
    {
      ignored: "/verbose nonsense",
      expectedAck: "Current verbose level:",
    },
    {
      ignored: "/fast status",
      expectedAck: "Current fast mode:",
    },
  ])(
    "applies valid sibling settings despite an ignored $ignored directive",
    async ({ ignored, expectedAck }) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply\n${ignored}\n/reasoning on`,
        storePath: "/tmp/sessions.json",
        gatewayClientScopes: [],
      });

      expect(result).toMatchObject({
        kind: "continue",
        directiveAck: { text: expect.stringContaining(expectedAck) },
      });
      expect(sessionEntry.reasoningLevel).toBe("on");
      expect(sessionEntry.traceLevel).toBeUndefined();
      expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    },
  );

  it("keeps authorized exec fields when a sibling exec option is invalid", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/exec host=node security=bogus\n/reasoning on",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      directiveAck: { text: expect.stringContaining('Unrecognized exec security "bogus"') },
    });
    expect(sessionEntry).toMatchObject({ execHost: "node", reasoningLevel: "on" });
    expect(sessionEntry.execSecurity).toBeUndefined();
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
  });

  it("normalizes nested informational and unauthorized siblings into one commit", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/verbose nonsense\n/reasoning on",
      storePath: "/tmp/sessions.json",
      gatewayClientScopes: [],
    });

    expect(result).toMatchObject({
      kind: "continue",
      directiveAck: { text: expect.stringContaining("/trace is restricted to owners") },
    });
    expect(sessionEntry.reasoningLevel).toBe("on");
    expect(sessionEntry.traceLevel).toBeUndefined();
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
  });

  it("does not announce unchanged elevated mode as a transition", async () => {
    const { result } = await applyMixedDirectives({
      body: "please reply\n/elevated full",
      sessionEntry: createSessionEntry({ elevatedLevel: "full" }),
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({ kind: "continue" });
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("adopts an authoritative model lock and emits no losing side effects", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persistenceMocks.persist.mockResolvedValueOnce({
      status: "model-selection-locked",
      entry: lockedEntry,
    });

    const { result, sessionStore } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      senderIsOwner: true,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
    });
    expect(persistenceMocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ requireModelSelectionUnlocked: true }),
    );
    expect(sessionEntry).toEqual(lockedEntry);
    expect(sessionStore["agent:main:dm:1"]).toEqual(lockedEntry);
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("reports a locked valid model instead of an ignored unauthorized sibling", async () => {
    const sessionEntry = createSessionEntry();
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persistenceMocks.persist.mockResolvedValueOnce({
      status: "model-selection-locked",
      entry: lockedEntry,
    });

    const { result } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/model openai/gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      gatewayClientScopes: [],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
    });
    expect(sessionEntry).toEqual(lockedEntry);
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
