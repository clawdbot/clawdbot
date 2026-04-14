import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = vi.hoisted(() => ({
  createModelSelectionState: vi.fn(),
  applyInlineDirectiveOverrides: vi.fn(),
  resolveFastModeState: vi.fn(),
  resolveReplyExecOverrides: vi.fn(),
}));

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

async function loadResolveReplyDirectivesForTest() {
  vi.resetModules();
  vi.doMock("../../agents/agent-scope.js", () => ({
    listAgentEntries: vi.fn(() => []),
  }));
  vi.doMock("../../agents/defaults.js", () => ({
    DEFAULT_CONTEXT_TOKENS: 8192,
  }));
  vi.doMock("../../agents/fast-mode.js", () => ({
    resolveFastModeState: (...args: unknown[]) => mocks.resolveFastModeState(...args),
  }));
  vi.doMock("../../agents/sandbox/runtime-status.js", () => ({
    resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
  }));
  vi.doMock("../../routing/session-key.js", () => ({
    normalizeAgentId: (value: string) => value,
  }));
  vi.doMock("../commands-text-routing.js", () => ({
    shouldHandleTextCommands: vi.fn(() => false),
  }));
  vi.doMock("./commands-context.js", () => ({
    buildCommandContext: vi.fn(() => ({
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: false,
      senderId: undefined,
      abortKey: "abort-key",
      rawBodyNormalized: "hello",
      commandBodyNormalized: "hello",
      from: "whatsapp:+1000",
      to: "whatsapp:+2000",
    })),
  }));
  vi.doMock("./directive-handling.parse.js", () => ({
    parseInlineDirectives: vi.fn((body: string) => {
      const normalized = body.trim();
      if (normalized === "/trace on") {
        return {
          cleaned: "",
          hasThinkDirective: false,
          hasVerboseDirective: false,
          hasTraceDirective: true,
          traceLevel: "on",
          rawTraceLevel: "on",
          hasFastDirective: false,
          hasReasoningDirective: false,
          hasElevatedDirective: false,
          hasExecDirective: false,
          hasModelDirective: false,
          hasQueueDirective: false,
          hasStatusDirective: false,
          queueReset: false,
          thinkLevel: undefined,
          verboseLevel: undefined,
          fastMode: undefined,
          reasoningLevel: undefined,
          elevatedLevel: undefined,
          rawElevatedLevel: undefined,
          rawModelDirective: undefined,
          execSecurity: undefined,
        };
      }
      return {
        cleaned: body,
        hasThinkDirective: false,
        hasVerboseDirective: false,
        hasTraceDirective: false,
        traceLevel: undefined,
        rawTraceLevel: undefined,
        hasFastDirective: false,
        hasReasoningDirective: false,
        hasElevatedDirective: false,
        hasExecDirective: false,
        hasModelDirective: false,
        hasQueueDirective: false,
        hasStatusDirective: false,
        queueReset: false,
        thinkLevel: undefined,
        verboseLevel: undefined,
        fastMode: undefined,
        reasoningLevel: undefined,
        elevatedLevel: undefined,
        rawElevatedLevel: undefined,
        rawModelDirective: undefined,
        execSecurity: undefined,
      };
    }),
  }));
  vi.doMock("./get-reply-directive-aliases.js", () => ({
    reserveSkillCommandNames: vi.fn(),
    resolveConfiguredDirectiveAliases: vi.fn(() => []),
  }));
  vi.doMock("./get-reply-directives-apply.js", () => ({
    applyInlineDirectiveOverrides: (...args: unknown[]) =>
      mocks.applyInlineDirectiveOverrides(...args),
  }));
  vi.doMock("./get-reply-exec-overrides.js", () => ({
    resolveReplyExecOverrides: (...args: unknown[]) => mocks.resolveReplyExecOverrides(...args),
  }));
  vi.doMock("./get-reply-fast-path.js", () => ({
    shouldUseReplyFastTestRuntime: vi.fn(() => false),
  }));
  vi.doMock("./groups.js", () => ({
    defaultGroupActivation: vi.fn(() => "always"),
    resolveGroupRequireMention: vi.fn(async () => false),
  }));
  vi.doMock("./model-selection.js", () => ({
    createFastTestModelSelectionState: vi.fn(),
    createModelSelectionState: (...args: unknown[]) => mocks.createModelSelectionState(...args),
    resolveContextTokens: vi.fn(() => 4096),
  }));
  vi.doMock("./reply-elevated.js", () => ({
    formatElevatedUnavailableMessage: vi.fn(() => "elevated unavailable"),
    resolveElevatedPermissions: vi.fn(() => ({
      enabled: true,
      allowed: true,
      failures: [],
    })),
  }));
  return await importFreshModule<typeof import("./get-reply-directives.js")>(
    import.meta.url,
    "./get-reply-directives.js",
  );
}

describe("resolveReplyDirectives", () => {
  beforeEach(() => {
    mocks.createModelSelectionState.mockReset();
    mocks.applyInlineDirectiveOverrides.mockReset();
    mocks.resolveFastModeState.mockReset();
    mocks.resolveReplyExecOverrides.mockReset();

    mocks.createModelSelectionState.mockResolvedValue({
      provider: "openai",
      model: "gpt-4o-mini",
      allowedModelKeys: new Set<string>(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      resolveDefaultThinkingLevel: vi.fn(async () => "off"),
      resolveDefaultReasoningLevel: vi.fn(async () => "off"),
    });
    mocks.applyInlineDirectiveOverrides.mockImplementation(async (params) => ({
      kind: "continue",
      directives: params.directives,
      provider: params.provider,
      model: params.model,
      contextTokens: params.contextTokens,
    }));
    mocks.resolveFastModeState.mockImplementation(({ sessionEntry }) => ({
      enabled: sessionEntry?.sessionId === "target-session",
    }));
    mocks.resolveReplyExecOverrides.mockReturnValue(undefined);
  });

  it("prefers the target session entry from sessionStore for directive state", async () => {
    const { resolveReplyDirectives } = await loadResolveReplyDirectivesForTest();
    const wrapperSessionEntry = makeSessionEntry({
      sessionId: "wrapper-session",
      thinkingLevel: "low",
      verboseLevel: "off",
      reasoningLevel: "off",
      elevatedLevel: "off",
      parentSessionKey: "wrapper-parent",
    });
    const targetSessionEntry = makeSessionEntry({
      sessionId: "target-session",
      thinkingLevel: "high",
      verboseLevel: "full",
      reasoningLevel: "high",
      elevatedLevel: "on",
      parentSessionKey: "target-parent",
    });

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "hello",
        CommandBody: "hello",
        ParentSessionKey: "ctx-parent",
      }),
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx: {
        Body: "hello",
        BodyStripped: "hello",
        BodyForAgent: "hello",
        CommandBody: "hello",
        Provider: "whatsapp",
      } as TemplateContext,
      sessionEntry: wrapperSessionEntry,
      sessionStore: {
        "agent:main:whatsapp:+2000": targetSessionEntry,
      },
      sessionKey: "agent:main:whatsapp:+2000",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "hello",
      commandAuthorized: false,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-4o-mini",
      hasResolvedHeartbeatModelOverride: false,
      typing: {
        onReplyStart: async () => {},
        startTypingLoop: async () => {},
        startTypingOnText: async () => {},
        refreshTypingTtl: () => {},
        isActive: () => false,
        markRunComplete: () => {},
        markDispatchIdle: () => {},
        cleanup: vi.fn(),
      },
      opts: undefined,
      skillFilter: undefined,
    });

    expect(mocks.resolveFastModeState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: targetSessionEntry,
      }),
    );
    expect(mocks.createModelSelectionState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: targetSessionEntry,
        parentSessionKey: "target-parent",
      }),
    );
    expect(mocks.applyInlineDirectiveOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: targetSessionEntry,
      }),
    );
    expect(mocks.resolveReplyExecOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: targetSessionEntry,
      }),
    );
    expect(result).toEqual({
      kind: "continue",
      result: expect.objectContaining({
        resolvedThinkLevel: "high",
        resolvedFastMode: true,
        resolvedVerboseLevel: "full",
        resolvedReasoningLevel: "high",
        resolvedElevatedLevel: "on",
      }),
    });
  });

  it("returns a directive-only ack for trace commands instead of continuing into the agent path", async () => {
    mocks.applyInlineDirectiveOverrides.mockResolvedValueOnce({
      kind: "reply",
      reply: {
        text: "⚙️ Trace enabled. Warning: trace output may contain sensitive information.",
      },
    });
    const { resolveReplyDirectives } = await loadResolveReplyDirectivesForTest();

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "/trace on",
        CommandBody: "/trace on",
        CommandAuthorized: true,
      }),
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx: {
        Body: "/trace on",
        BodyStripped: "/trace on",
        BodyForAgent: "/trace on",
        CommandBody: "/trace on",
        Provider: "telegram",
        Surface: "telegram",
      } as TemplateContext,
      sessionEntry: makeSessionEntry(),
      sessionStore: {
        "agent:main:telegram:+2000": makeSessionEntry(),
      },
      sessionKey: "agent:main:telegram:+2000",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "/trace on",
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-4o-mini",
      hasResolvedHeartbeatModelOverride: false,
      typing: makeTypingController(),
      opts: undefined,
      skillFilter: undefined,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "⚙️ Trace enabled. Warning: trace output may contain sensitive information.",
      },
    });
  });

  it("uses the model reasoning default when thinking is off", async () => {
    const resolveDefaultThinkingLevel = vi.fn(async () => "off");
    const resolveDefaultReasoningLevel = vi.fn(async () => "on");
    mocks.createModelSelectionState.mockResolvedValueOnce({
      provider: "openai",
      model: "gpt-4o-mini",
      allowedModelKeys: new Set<string>(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      resolveDefaultThinkingLevel,
      resolveDefaultReasoningLevel,
    });
    const { resolveReplyDirectives } = await loadResolveReplyDirectivesForTest();

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "hello",
        CommandBody: "hello",
      }),
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx: {
        Body: "hello",
        BodyStripped: "hello",
        BodyForAgent: "hello",
        CommandBody: "hello",
        Provider: "whatsapp",
      } as TemplateContext,
      sessionEntry: makeSessionEntry(),
      sessionStore: {},
      sessionKey: "agent:main:whatsapp:+2000",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "hello",
      commandAuthorized: false,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-4o-mini",
      hasResolvedHeartbeatModelOverride: false,
      typing: makeTypingController(),
      opts: undefined,
      skillFilter: undefined,
    });

    expect(result).toEqual({
      kind: "continue",
      result: expect.objectContaining({
        resolvedThinkLevel: "off",
        resolvedReasoningLevel: "on",
      }),
    });
    expect(resolveDefaultReasoningLevel).toHaveBeenCalledOnce();
  });

  it("skips the model reasoning default when thinking is active", async () => {
    const resolveDefaultThinkingLevel = vi.fn(async () => "low");
    const resolveDefaultReasoningLevel = vi.fn(async () => "on");
    mocks.createModelSelectionState.mockResolvedValueOnce({
      provider: "openai",
      model: "gpt-4o-mini",
      allowedModelKeys: new Set<string>(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      resolveDefaultThinkingLevel,
      resolveDefaultReasoningLevel,
    });
    const { resolveReplyDirectives } = await loadResolveReplyDirectivesForTest();

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "hello",
        CommandBody: "hello",
      }),
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx: {
        Body: "hello",
        BodyStripped: "hello",
        BodyForAgent: "hello",
        CommandBody: "hello",
        Provider: "whatsapp",
      } as TemplateContext,
      sessionEntry: makeSessionEntry(),
      sessionStore: {},
      sessionKey: "agent:main:whatsapp:+2000",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "hello",
      commandAuthorized: false,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-4o-mini",
      hasResolvedHeartbeatModelOverride: false,
      typing: makeTypingController(),
      opts: undefined,
      skillFilter: undefined,
    });

    expect(result).toEqual({
      kind: "continue",
      result: expect.objectContaining({
        resolvedThinkLevel: "low",
        resolvedReasoningLevel: "off",
      }),
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });
});
