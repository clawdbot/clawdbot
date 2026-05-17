import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
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

function parseInlineDirectivesForTest(body: string) {
  const normalized = body.trim();
  if (normalized === "/reasoning stream") {
    return {
      cleaned: "",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: false,
      traceLevel: undefined,
      rawTraceLevel: undefined,
      hasFastDirective: false,
      hasReasoningDirective: true,
      reasoningLevel: "stream",
      rawReasoningLevel: "stream",
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      hasStatusDirective: false,
      queueReset: false,
      thinkLevel: undefined,
      verboseLevel: undefined,
      fastMode: undefined,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      rawModelDirective: undefined,
      execSecurity: undefined,
    };
  }
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
}

function mockCallInput(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  const input = call[0];
  if (!input || typeof input !== "object") {
    throw new Error(`expected mock input ${index}`);
  }
  return input as Record<string, unknown>;
}

function expectContinueResult(
  value: Awaited<ReturnType<typeof resolveReplyDirectives>>,
  fields: Record<string, unknown>,
) {
  expect(value.kind).toBe("continue");
  if (value.kind !== "continue") {
    throw new Error(`expected continue result, got ${value.kind}`);
  }
  for (const [key, expected] of Object.entries(fields)) {
    expect(value.result[key as keyof typeof value.result]).toEqual(expected);
  }
}

async function resolveHelloWithModelDefaults(params: {
  defaultThinking: "off" | "low";
  defaultReasoning: "on";
  body?: string;
  sessionEntry?: SessionEntry;
  agentCfg?: { reasoningDefault?: "off" | "on" | "stream" };
  commandAuthorized?: boolean;
  hasOneTurnModelOverride?: boolean;
  provider?: string;
  model?: string;
  ctx?: Parameters<typeof buildTestCtx>[0];
}) {
  const resolveDefaultThinkingLevel = vi.fn(async () => params.defaultThinking);
  const resolveDefaultReasoningLevel = vi.fn(async () => params.defaultReasoning);
  mocks.createModelSelectionState.mockResolvedValueOnce({
    provider: "openai",
    model: "gpt-4o-mini",
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    resolveDefaultThinkingLevel,
    resolveDefaultReasoningLevel,
  });

  const result = await resolveReplyDirectives({
    ctx: buildTestCtx({
      Body: params.body ?? "hello",
      CommandBody: params.body ?? "hello",
      ...params.ctx,
    }),
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: params.agentCfg ?? {},
    sessionCtx: {
      Body: params.body ?? "hello",
      BodyStripped: params.body ?? "hello",
      BodyForAgent: params.body ?? "hello",
      CommandBody: params.body ?? "hello",
      Provider: "whatsapp",
    } as TemplateContext,
    sessionEntry: params.sessionEntry ?? makeSessionEntry(),
    sessionStore: {},
    sessionKey: "agent:main:whatsapp:+2000",
    storePath: "/tmp/sessions.json",
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: "hello",
    resetTriggered: false,
    commandAuthorized: params.commandAuthorized ?? false,
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: params.provider ?? "openai",
    model: params.model ?? "gpt-4o-mini",
    hasOneTurnModelOverride: params.hasOneTurnModelOverride,
    hasResolvedHeartbeatModelOverride: false,
    typing: makeTypingController(),
    opts: undefined,
    skillFilter: undefined,
  });

  return { result, resolveDefaultReasoningLevel };
}

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: vi.fn(() => []),
}));

vi.mock("../../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 8192,
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: (...args: unknown[]) => mocks.resolveFastModeState(...args),
}));

vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (value: string) => value,
}));

vi.mock("../commands-text-routing.js", () => ({
  shouldHandleTextCommands: vi.fn(() => false),
}));

vi.mock("./commands-context.js", () => ({
  buildCommandContext: vi.fn((params: { commandAuthorized?: boolean }) => ({
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: params.commandAuthorized === true,
    senderId: undefined,
    abortKey: "abort-key",
    rawBodyNormalized: "hello",
    commandBodyNormalized: "hello",
    from: "whatsapp:+1000",
    to: "whatsapp:+2000",
  })),
}));

vi.mock("./directive-handling.parse.js", () => ({
  parseInlineDirectives: vi.fn(parseInlineDirectivesForTest),
}));

vi.mock("./get-reply-directive-aliases.js", () => ({
  reserveSkillCommandNames: vi.fn(),
  resolveConfiguredDirectiveAliases: vi.fn(() => []),
}));

vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: (...args: unknown[]) =>
    mocks.applyInlineDirectiveOverrides(...args),
}));

vi.mock("./get-reply-exec-overrides.js", () => ({
  resolveReplyExecOverrides: (...args: unknown[]) => mocks.resolveReplyExecOverrides(...args),
}));

vi.mock("./get-reply-fast-path.js", () => ({
  shouldUseReplyFastTestRuntime: vi.fn(() => false),
}));

vi.mock("./groups.js", () => ({
  defaultGroupActivation: vi.fn(() => "always"),
  resolveGroupRequireMention: vi.fn(async () => false),
}));

vi.mock("./model-selection.js", () => ({
  createFastTestModelSelectionState: vi.fn(),
  createModelSelectionState: (...args: unknown[]) => mocks.createModelSelectionState(...args),
  resolveContextTokens: vi.fn(() => 4096),
}));

vi.mock("./reply-elevated.js", () => ({
  formatElevatedUnavailableMessage: vi.fn(() => "elevated unavailable"),
  resolveElevatedPermissions: vi.fn(() => ({
    enabled: true,
    allowed: true,
    failures: [],
  })),
}));

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
      resolveThinkingCatalog: vi.fn(async () => []),
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

  it("passes one-turn model override state into model selection", async () => {
    await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      provider: "openai",
      model: "gpt-4o-mini",
      hasOneTurnModelOverride: true,
    });

    const modelSelectionInput = mockCallInput(mocks.createModelSelectionState);
    expect(modelSelectionInput.provider).toBe("openai");
    expect(modelSelectionInput.model).toBe("gpt-4o-mini");
    expect(modelSelectionInput.hasOneTurnModelOverride).toBe(true);
  });

  it("prefers the target session entry from sessionStore for directive state", async () => {
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
      resetTriggered: false,
      commandAuthorized: true,
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

    expect(mockCallInput(mocks.resolveFastModeState).sessionEntry).toBe(targetSessionEntry);
    const modelSelectionInput = mockCallInput(mocks.createModelSelectionState);
    expect(modelSelectionInput.sessionEntry).toBe(targetSessionEntry);
    expect(modelSelectionInput.parentSessionKey).toBe("target-parent");
    expect(mockCallInput(mocks.applyInlineDirectiveOverrides).sessionEntry).toBe(
      targetSessionEntry,
    );
    expect(mockCallInput(mocks.resolveReplyExecOverrides).sessionEntry).toBe(targetSessionEntry);
    expectContinueResult(result, {
      resolvedThinkLevel: "high",
      resolvedFastMode: true,
      resolvedVerboseLevel: "full",
      resolvedReasoningLevel: "high",
      resolvedElevatedLevel: "on",
    });
  });

  it("returns a directive-only ack for trace commands instead of continuing into the agent path", async () => {
    mocks.applyInlineDirectiveOverrides.mockResolvedValueOnce({
      kind: "reply",
      reply: {
        text: "⚙️ Trace enabled. Warning: trace output may contain sensitive information.",
      },
    });

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
      resetTriggered: false,
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
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "on",
    });
    expect(resolveDefaultReasoningLevel).toHaveBeenCalledOnce();
  });

  it("does not re-enable model reasoning when thinking was explicitly disabled", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry: makeSessionEntry({ thinkingLevel: "off" }),
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("skips the model reasoning default when thinking is active", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "low",
      defaultReasoning: "on",
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "low",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not re-enable model reasoning when agentCfg reasoningDefault is explicitly off", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "off" },
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not expose configured reasoning defaults to untrusted senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "stream" },
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("ignores inline reasoning directives from untrusted senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      body: "/reasoning stream",
      defaultThinking: "off",
      defaultReasoning: "on",
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not expose session reasoning state to untrusted senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry: makeSessionEntry({ reasoningLevel: "stream" }),
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("allows session reasoning state for authorized senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry: makeSessionEntry({ reasoningLevel: "stream" }),
      commandAuthorized: true,
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "stream",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("allows configured reasoning defaults for operator gateway clients", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "stream" },
      ctx: { GatewayClientScopes: ["operator.admin"] },
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "stream",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("allows configured reasoning defaults for authorized senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "stream" },
      commandAuthorized: true,
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "stream",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("keeps consumed text reset triggers empty after directive cleanup", async () => {
    const sessionCtx = {
      Body: "",
      BodyStripped: "",
      BodyForAgent: "",
      BodyForCommands: "new session",
      CommandBody: "new session",
      Provider: "slack",
      Surface: "slack",
    } as TemplateContext;

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "new session",
        BodyForAgent: "new session",
        BodyForCommands: "new session",
        CommandBody: "new session",
        CommandAuthorized: true,
        Provider: "slack",
        Surface: "slack",
      }),
      cfg: {
        session: {
          resetTriggers: ["/new", "/reset", "new session"],
        },
      },
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx,
      sessionEntry: makeSessionEntry(),
      sessionStore: {
        "agent:main:slack:C123": makeSessionEntry(),
      },
      sessionKey: "agent:main:slack:C123",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "new session",
      resetTriggered: true,
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

    expectContinueResult(result, {
      cleanedBody: "",
    });
    expect(sessionCtx.Body).toBe("");
    expect(sessionCtx.BodyForAgent).toBe("");
    expect(sessionCtx.BodyStripped).toBe("");
  });
});
