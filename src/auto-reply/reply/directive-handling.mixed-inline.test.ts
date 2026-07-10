// Tests mixed inline directives in user text and command bodies.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applyInlineDirectivesFastLane } from "./directive-handling.fast-lane.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";
import { refreshQueuedFollowupSession } from "./queue.js";

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

vi.mock("../../config/sessions/store.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

describe("mixed inline directives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits directive ack while persisting inline reasoning in mixed messages", async () => {
    const directives = parseInlineDirectives("please reply\n/reasoning on");
    const cfg = createConfig();
    const sessionEntry = createSessionEntry();
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    const fastLane = await applyInlineDirectivesFastLane({
      directives,
      commandAuthorized: true,
      senderIsOwner: false,
      ctx: { Surface: "whatsapp" } as never,
      cfg,
      agentId: "main",
      isGroup: false,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      messageProviderKey: "whatsapp",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      modelState: {
        resolveDefaultThinkingLevel: async () => "off",
        resolveThinkingCatalog: async () => [],
        allowedModelKeys: new Set(),
        allowedModelCatalog: [],
        resetModelOverride: false,
      },
    });

    expect(fastLane.directiveAck).toEqual({
      text: "⚙️ Reasoning visibility enabled.",
    });

    const persisted = await persistInlineDirectives({
      directives,
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      messageProvider: "whatsapp",
      surface: "whatsapp",
      gatewayClientScopes: [],
    });

    expect(sessionEntry.reasoningLevel).toBe("on");
    expect(persisted.provider).toBe("anthropic");
    expect(persisted.model).toBe("claude-opus-4-6");
  });

  it("persists reasoning off and emits the disabled ack", async () => {
    const directives = parseInlineDirectives("please reply\n/reasoning off");
    const cfg = createConfig();
    const sessionEntry = createSessionEntry({ reasoningLevel: "on" });
    const sessionStore = { "agent:main:discord:user": sessionEntry };

    const fastLane = await applyInlineDirectivesFastLane({
      directives,
      commandAuthorized: true,
      senderIsOwner: false,
      ctx: { Surface: "discord" } as never,
      cfg,
      agentId: "main",
      isGroup: false,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:discord:user",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      messageProviderKey: "discord",
      defaultProvider: "openrouter",
      defaultModel: "x-ai/grok-4.1-fast",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      provider: "openrouter",
      model: "x-ai/grok-4.1-fast",
      initialModelLabel: "openrouter/x-ai/grok-4.1-fast",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      modelState: {
        resolveDefaultThinkingLevel: async () => "off",
        resolveThinkingCatalog: async () => [],
        allowedModelKeys: new Set(),
        allowedModelCatalog: [],
        resetModelOverride: false,
      },
    });

    expect(fastLane.directiveAck).toEqual({
      text: "⚙️ Reasoning visibility disabled.",
    });

    await persistInlineDirectives({
      directives,
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:discord:user",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "openrouter",
      defaultModel: "x-ai/grok-4.1-fast",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      provider: "openrouter",
      model: "x-ai/grok-4.1-fast",
      initialModelLabel: "openrouter/x-ai/grok-4.1-fast",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      messageProvider: "discord",
      surface: "discord",
      gatewayClientScopes: [],
    });

    expect(sessionEntry.reasoningLevel).toBe("off");
  });

  it("retargets queued thinking after a mixed-content model switch", async () => {
    const directives = parseInlineDirectives("please reply /model openai/gpt-5.6-luna");
    const sessionEntry = createSessionEntry({ thinkingLevel: "ultra" });
    const sessionKey = "agent:main:dm:1";
    const cfg = {
      commands: { text: true },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    await persistInlineDirectives({
      directives,
      effectiveModelDirective: directives.rawModelDirective,
      cfg,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-sol",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(["openai/gpt-5.6-luna"]),
      modelCatalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      provider: "openai",
      model: "gpt-5.6-sol",
      initialModelLabel: "openai/gpt-5.6-sol",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
    });

    expect(sessionEntry.thinkingLevel).toBe("max");
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        key: sessionKey,
        nextProvider: "openai",
        nextModel: "gpt-5.6-luna",
        nextThinking: expect.objectContaining({ level: "max", agentRuntime: "codex" }),
      }),
    );
  });

  it("emits a channel-neutral ack for reasoning stream", async () => {
    const directives = parseInlineDirectives("please reply\n/reasoning stream");
    const cfg = createConfig();
    const sessionEntry = createSessionEntry();
    const sessionStore = { "agent:main:discord:user": sessionEntry };

    const fastLane = await applyInlineDirectivesFastLane({
      directives,
      commandAuthorized: true,
      senderIsOwner: false,
      ctx: { Surface: "discord" } as never,
      cfg,
      agentId: "main",
      isGroup: false,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:discord:user",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      messageProviderKey: "discord",
      defaultProvider: "openrouter",
      defaultModel: "x-ai/grok-4.1-fast",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      provider: "openrouter",
      model: "x-ai/grok-4.1-fast",
      initialModelLabel: "openrouter/x-ai/grok-4.1-fast",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      modelState: {
        resolveDefaultThinkingLevel: async () => "off",
        resolveThinkingCatalog: async () => [],
        allowedModelKeys: new Set(),
        allowedModelCatalog: [],
        resetModelOverride: false,
      },
    });

    expect(fastLane.directiveAck).toEqual({
      text: "⚙️ Reasoning stream enabled.",
    });
  });

  it("persists mixed exec defaults for authorized external senders with empty gateway scopes", async () => {
    const directives = parseInlineDirectives(
      "please reply\n/exec host=node security=allowlist ask=always node=worker-1",
    );
    const cfg = createConfig();
    const sessionEntry = createSessionEntry();
    const sessionStore = { "agent:main:telegram:user": sessionEntry };

    const fastLane = await applyInlineDirectivesFastLane({
      directives,
      commandAuthorized: true,
      senderIsOwner: false,
      ctx: { Provider: "telegram", GatewayClientScopes: [] } as never,
      cfg,
      agentId: "main",
      isGroup: false,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:telegram:user",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      messageProviderKey: "telegram",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      modelState: {
        resolveDefaultThinkingLevel: async () => "off",
        resolveThinkingCatalog: async () => [],
        allowedModelKeys: new Set(),
        allowedModelCatalog: [],
        resetModelOverride: false,
      },
    });

    expect(fastLane.directiveAck?.text).toContain("Exec defaults set");
    expect(fastLane.directiveAck?.text).not.toContain("operator.admin");

    await persistInlineDirectives({
      directives,
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:telegram:user",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      messageProvider: "telegram",
      gatewayClientScopes: [],
      commandAuthorized: true,
    });

    expect(sessionEntry.execHost).toBe("node");
    expect(sessionEntry.execSecurity).toBe("allowlist");
    expect(sessionEntry.execAsk).toBe("always");
    expect(sessionEntry.execNode).toBe("worker-1");
  });

  it("does not persist trace directives for unauthorized mixed messages", async () => {
    const directives = parseInlineDirectives("please reply\n/trace raw");
    const cfg = createConfig();
    const sessionEntry = createSessionEntry({ traceLevel: "off" as const });
    const sessionStore = { "agent:main:telegram:user": sessionEntry };

    await persistInlineDirectives({
      directives,
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:telegram:user",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => label,
      agentCfg: cfg.agents?.defaults,
      messageProvider: "telegram",
      surface: "telegram",
      gatewayClientScopes: [],
      senderIsOwner: false,
    });

    expect(sessionEntry.traceLevel).toBe("off");
  });
});
