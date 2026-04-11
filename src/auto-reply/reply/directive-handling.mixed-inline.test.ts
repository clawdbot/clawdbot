import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applyInlineDirectivesFastLane } from "./directive-handling.fast-lane.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
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
});
