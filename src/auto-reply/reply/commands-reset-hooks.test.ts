// Tests reset hook emission and cleanup around reset commands.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bootstrapCache from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext } from "./commands-context.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const triggerInternalHookMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const routeReplyMock = vi.hoisted(() =>
  vi.fn<
    (params: unknown) => Promise<{
      ok: boolean;
      delivered: boolean;
      messageId?: string;
      suppressed?: boolean;
    }>
  >(async () => ({ ok: true, delivered: true, messageId: "reset-hook-1" })),
);
const resetMocks = vi.hoisted(() => ({
  resetConfiguredBindingTargetInPlace: vi.fn().mockResolvedValue({ ok: true as const }),
  resolveBoundAcpThreadSessionKey: vi.fn(() => undefined as string | undefined),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (
    type: string,
    action: string,
    sessionKey: string,
    context: Record<string, unknown>,
  ) => ({
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(0),
    messages: [],
  }),
  triggerInternalHook: triggerInternalHookMock,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../commands-registry.js", () => ({
  normalizeCommandBody: (raw: string) => raw.trim(),
  shouldHandleTextCommands: () => true,
}));

vi.mock("../../channels/plugins/binding-targets.js", () => ({
  resetConfiguredBindingTargetInPlace: resetMocks.resetConfiguredBindingTargetInPlace,
}));

vi.mock("./commands-acp/targets.js", () => ({
  resolveBoundAcpThreadSessionKey: resetMocks.resolveBoundAcpThreadSessionKey,
}));

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => [],
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: (params: unknown) => routeReplyMock(params),
}));

function buildResetParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    SessionKey: "agent:main:main",
    ...ctxOverrides,
  } as MsgContext;

  return {
    ctx,
    cfg,
    command: {
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: commandBody.trim(),
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: ctx.SenderId ?? "123",
      channel: ctx.Surface ?? "whatsapp",
      channelId: ctx.Surface ?? "whatsapp",
      surface: ctx.Surface ?? "whatsapp",
      ownerList: [],
      from: ctx.From ?? "sender",
      to: ctx.To ?? "bot",
      resetHookTriggered: false,
    },
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/openclaw-commands",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

function mockCall(mock: unknown, index = 0): Array<unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index + 1}`);
  }
  return call;
}

const requireRecord = createRequireRecord("object", "expected-label");

function expectObjectFields(
  value: unknown,
  expected: Record<string, unknown>,
  label = "object",
): void {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
}

function firstHookEvent(): Record<string, unknown> {
  return requireRecord(mockCall(triggerInternalHookMock)[0], "hook event");
}

describe("handleCommands reset hooks", () => {
  let clearBootstrapSnapshotSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearBootstrapSnapshotSpy = vi.spyOn(bootstrapCache, "clearBootstrapSnapshot");
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValue({ ok: true });
    resetMocks.resolveBoundAcpThreadSessionKey.mockReturnValue(undefined);
    triggerInternalHookMock.mockResolvedValue(undefined);
    routeReplyMock.mockResolvedValue({
      ok: true,
      delivered: true,
      messageId: "reset-hook-1",
    });
  });

  afterEach(() => {
    clearBootstrapSnapshotSpy.mockRestore();
  });

  it("triggers hooks for /new commands", async () => {
    const cases = [
      {
        name: "text command with arguments",
        params: buildResetParams("/new take notes", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        expectedEvent: { type: "command", action: "new" },
      },
      {
        name: "native command routed to target session",
        params: (() => {
          const params = buildResetParams(
            "/new",
            {
              commands: { text: true },
              channels: { telegram: { allowFrom: ["*"] } },
            } as OpenClawConfig,
            {
              Provider: "telegram",
              Surface: "telegram",
              CommandSource: "native",
              CommandTargetSessionKey: "agent:main:telegram:direct:123",
              SessionKey: "telegram:slash:123",
              SenderId: "123",
              From: "telegram:123",
              To: "slash:123",
              CommandAuthorized: true,
            },
          );
          params.sessionKey = "agent:main:telegram:direct:123";
          return params;
        })(),
        expectedEvent: {
          type: "command",
          action: "new",
          sessionKey: "agent:main:telegram:direct:123",
        },
        expectedContext: {
          workspaceDir: "/tmp/openclaw-commands",
        },
      },
    ] as const;

    for (const testCase of cases) {
      await maybeHandleResetCommand(testCase.params);
      const event = firstHookEvent();
      expectObjectFields(event, testCase.expectedEvent, testCase.name);
      if ("expectedContext" in testCase) {
        expectObjectFields(event.context, testCase.expectedContext, `${testCase.name}.context`);
      }
      triggerInternalHookMock.mockClear();
    }
  });

  it("uses gateway session reset for bound ACP sessions", async () => {
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValue({
      ok: true,
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      sessionId: "session-after-acp-reset",
      storePath: "/tmp/claude-sessions.json",
    });
    resetMocks.resolveBoundAcpThreadSessionKey.mockReturnValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const onSessionPrepared = vi.fn();
    const params = buildResetParams(
      "/reset",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        Provider: "discord",
        Surface: "discord",
        CommandSource: "native",
      },
    );
    params.opts = { onSessionPrepared } as never;

    const result = await maybeHandleResetCommand(params);

    const resetArgs = requireRecord(
      mockCall(resetMocks.resetConfiguredBindingTargetInPlace)[0],
      "reset args",
    );
    if (!resetArgs.cfg || typeof resetArgs.cfg !== "object") {
      throw new Error("expected reset config");
    }
    expectObjectFields(resetArgs, {
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      reason: "reset",
      commandSource: "discord:native",
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ ACP session reset in place." },
    });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(params.command.resetHookTriggered).toBe(true);
    expect(onSessionPrepared).toHaveBeenCalledWith({
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      sessionId: "session-after-acp-reset",
      storePath: "/tmp/claude-sessions.json",
    });
  });

  it("keeps tail dispatch after a bound ACP reset", async () => {
    resetMocks.resolveBoundAcpThreadSessionKey.mockReturnValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const params = buildResetParams(
      "/new who are you",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        Provider: "discord",
        Surface: "discord",
        CommandSource: "native",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({ shouldContinue: false });
    expect(params.ctx.Body).toBe("who are you");
    expect(params.ctx.CommandBody).toBe("who are you");
    expect(params.ctx.AcpDispatchTailAfterReset).toBe(true);
  });

  it("forwards non-id sender fields when reset hooks emit routed replies", async () => {
    triggerInternalHookMock.mockImplementationOnce(async (event: { messages: string[] }) => {
      event.messages.push("Reset hook says hi");
    });
    const onObservedReplyDelivery = vi.fn();
    const params = buildResetParams(
      "/new",
      {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        SenderId: "id:whatsapp:123",
        SenderName: "Alice",
        SenderUsername: "alice_u",
        SenderE164: "+15551234567",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "group:ops",
        MessageThreadId: "thread-1",
      },
    );
    params.opts = { onObservedReplyDelivery };

    const result = await maybeHandleResetCommand(params);

    expectObjectFields(mockCall(routeReplyMock)[0], {
      requesterSenderId: "id:whatsapp:123",
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
      threadId: "thread-1",
    });
    expect(onObservedReplyDelivery).toHaveBeenCalledOnce();
    expect(result).toEqual({ shouldContinue: false });
  });

  it.each([
    ["failed", { ok: false, delivered: false }],
    ["dropped", { ok: true, delivered: false }],
  ] as const)(
    "falls back to the standard reset acknowledgement when the hook route is %s",
    async (_name, routeResult) => {
      triggerInternalHookMock.mockImplementationOnce(async (event: { messages: string[] }) => {
        event.messages.push("Reset hook says hi");
      });
      routeReplyMock.mockResolvedValueOnce(routeResult);
      const onObservedReplyDelivery = vi.fn();
      const params = buildResetParams("/new", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig);
      params.opts = { onObservedReplyDelivery };

      const result = await maybeHandleResetCommand(params);

      expect(onObservedReplyDelivery).not.toHaveBeenCalled();
      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: "✅ New session started." },
      });
    },
  );

  it("keeps an intentionally suppressed reset hook route silent", async () => {
    triggerInternalHookMock.mockImplementationOnce(async (event: { messages: string[] }) => {
      event.messages.push("Reset hook says hi");
    });
    routeReplyMock.mockResolvedValueOnce({
      ok: true,
      delivered: false,
      suppressed: true,
    });
    const onObservedReplyDelivery = vi.fn();
    const params = buildResetParams("/new", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.opts = { onObservedReplyDelivery };

    const result = await maybeHandleResetCommand(params);

    expect(onObservedReplyDelivery).not.toHaveBeenCalled();
    expect(result).toEqual({ shouldContinue: false });
  });

  it.each([
    ["without a provider message id", { ok: true, delivered: true }],
    ["before a later partial failure", { ok: false, delivered: true, messageId: "reset-hook-1" }],
  ] as const)(
    "marks a reset hook route as observed when delivered %s",
    async (_name, routeResult) => {
      triggerInternalHookMock.mockImplementationOnce(async (event: { messages: string[] }) => {
        event.messages.push("Reset hook says hi");
      });
      routeReplyMock.mockResolvedValueOnce(routeResult);
      const onObservedReplyDelivery = vi.fn();
      const params = buildResetParams("/new", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig);
      params.opts = { onObservedReplyDelivery };

      await maybeHandleResetCommand(params);

      expect(onObservedReplyDelivery).toHaveBeenCalledOnce();
    },
  );

  it("prefers the target session entry when emitting reset hooks", async () => {
    const params = buildResetParams("/reset", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "target-session",
        updatedAt: Date.now(),
      },
    };

    await maybeHandleResetCommand(params);

    const event = firstHookEvent();
    const context = requireRecord(event.context, "hook context");
    expectObjectFields(context.sessionEntry, { sessionId: "target-session" }, "session entry");
  });

  it("marks soft reset turns and emits reset hooks", async () => {
    const params = buildResetParams("/reset soft", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "cli-session-1" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-1",
          extraSystemPromptHash: "prompt-hash",
        },
      },
      claudeCliSessionId: "cli-session-1",
    } as HandleCommandsParams["sessionEntry"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    const event = firstHookEvent();
    expectObjectFields(event, { type: "command", action: "reset" }, "hook event");
    const context = requireRecord(event.context, "hook context");
    expectObjectFields(context.previousSessionEntry, { sessionId: "session-1" }, "session entry");
    expect(params.command.resetHookTriggered).toBe(true);
    expect(params.command.softResetTriggered).toBe(true);
    expect(params.command.softResetTail).toBe("");
    expect(params.sessionEntry?.cliSessionIds).toBeUndefined();
    expect(params.sessionEntry?.cliSessionBindings).toBeUndefined();
    expect(params.sessionEntry?.claudeCliSessionId).toBeUndefined();
    expect(clearBootstrapSnapshotSpy).toHaveBeenCalledWith("agent:main:main");
  });

  it.each([
    {
      name: "write scope",
      provider: "webchat",
      surface: "webchat",
      scopes: ["operator.write"],
      allowed: false,
    },
    {
      name: "admin scope",
      provider: "webchat",
      surface: "webchat",
      scopes: ["operator.admin"],
      allowed: true,
    },
    {
      name: "legacy missing scopes",
      provider: "webchat",
      surface: "webchat",
      scopes: undefined,
      allowed: true,
    },
    {
      name: "legacy empty scopes",
      provider: "webchat",
      surface: "webchat",
      scopes: [],
      allowed: true,
    },
    {
      name: "internal Provider remains authoritative",
      provider: "webchat",
      surface: "telegram",
      scopes: ["operator.write"],
      allowed: false,
    },
    {
      name: "external Provider remains authoritative",
      provider: "telegram",
      surface: "webchat",
      scopes: ["operator.write"],
      allowed: true,
    },
    {
      name: "missing Provider uses internal Surface",
      provider: undefined,
      surface: "webchat",
      scopes: ["operator.write"],
      allowed: false,
    },
  ])(
    "preserves internal soft-reset scope policy: $name",
    async ({ provider, surface, scopes, allowed }) => {
      const params = buildResetParams(
        "/reset soft",
        {
          commands: { text: true },
        } as OpenClawConfig,
        {
          Provider: provider,
          Surface: surface,
          CommandAuthorized: true,
          GatewayClientScopes: scopes,
        },
      );
      params.command = buildCommandContext({
        ctx: params.ctx,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        isGroup: false,
        triggerBodyNormalized: "/reset soft",
        commandAuthorized: true,
      });
      params.sessionEntry = {
        sessionId: "existing-soft-session",
        lifecycleRevision: "existing-soft-generation",
        updatedAt: 1,
        cliSessionIds: { "claude-cli": "existing-cli-binding" },
      };
      const before = structuredClone(params.sessionEntry);

      const result = await maybeHandleResetCommand(params);

      expect(result).toEqual(allowed ? null : { shouldContinue: false });
      expect(params.sessionEntry.sessionId).toBe(before.sessionId);
      expect(params.sessionEntry.lifecycleRevision).toBe(before.lifecycleRevision);
      expect(params.command.softResetTriggered === true).toBe(allowed);
      expect(triggerInternalHookMock).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(clearBootstrapSnapshotSpy).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(routeReplyMock).not.toHaveBeenCalled();
      if (allowed) {
        expect(params.sessionEntry.cliSessionIds).toBeUndefined();
      } else {
        expect(params.sessionEntry).toEqual(before);
      }
    },
  );

  it("clears both sessionStore and sessionEntry when they are distinct objects", async () => {
    const params = buildResetParams("/reset soft", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.sessionEntry = {
      sessionId: "session-direct",
      updatedAt: 1,
      cliSessionIds: { "claude-cli": "cli-session-direct" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-direct",
          extraSystemPromptHash: "prompt-hash-direct",
        },
      },
      claudeCliSessionId: "cli-session-direct",
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "session-store",
        updatedAt: 2,
        cliSessionIds: { "claude-cli": "cli-session-store" },
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "cli-session-store",
            extraSystemPromptHash: "prompt-hash-store",
          },
        },
        claudeCliSessionId: "cli-session-store",
      },
    } as Record<string, NonNullable<HandleCommandsParams["sessionEntry"]>>;

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    expect(params.sessionEntry?.cliSessionIds).toBeUndefined();
    expect(params.sessionEntry?.cliSessionBindings).toBeUndefined();
    expect(params.sessionEntry?.claudeCliSessionId).toBeUndefined();
    expect(params.sessionStore?.[params.sessionKey]?.cliSessionIds).toBeUndefined();
    expect(params.sessionStore?.[params.sessionKey]?.cliSessionBindings).toBeUndefined();
    expect(params.sessionStore?.[params.sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("rejects soft reset for bound ACP sessions", async () => {
    resetMocks.resolveBoundAcpThreadSessionKey.mockReturnValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const params = buildResetParams(
      "/reset soft",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        Provider: "discord",
        Surface: "discord",
        CommandSource: "native",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." },
    });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(resetMocks.resetConfiguredBindingTargetInPlace).not.toHaveBeenCalled();
  });

  it("acknowledges bare /reset without falling through to model execution", async () => {
    const params = buildResetParams("/RESET", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ Session reset." },
    });
    expectObjectFields(firstHookEvent(), { type: "command", action: "reset" }, "hook event");
  });

  it("acknowledges bare /new without falling through to model execution", async () => {
    const params = buildResetParams("/NEW", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started." },
    });
    expectObjectFields(firstHookEvent(), { type: "command", action: "new" }, "hook event");
  });

  it("keeps reset tails falling through so the model receives the user input", async () => {
    const params = buildResetParams("/Reset take notes", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    expectObjectFields(firstHookEvent(), { type: "command", action: "reset" }, "hook event");
  });
});
