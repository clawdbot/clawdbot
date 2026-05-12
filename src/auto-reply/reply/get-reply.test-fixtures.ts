import { expect, vi, type Mock } from "vitest";
import type { MsgContext } from "../templating.js";

export function buildGetReplyCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:123",
    From: "telegram:user:42",
    To: "telegram:123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

export function buildGetReplyGroupCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:-100123",
    ChatType: "group",
    Body: "hello world",
    BodyForAgent: "hello world",
    RawBody: "hello world",
    CommandBody: "hello world",
    BodyForCommands: "hello world",
    SessionKey: "agent:main:telegram:-100123",
    From: "telegram:user:42",
    To: "telegram:-100123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

export function buildNativeResetContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "/new",
    RawBody: "/new",
    CommandBody: "/new",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    To: "slash:123",
  };
}

export function createGetReplySessionState(overrides: Record<string, unknown> = {}) {
  return {
    sessionCtx: {},
    sessionEntry: {},
    previousSessionEntry: {},
    sessionStore: {},
    sessionKey: "agent:main:telegram:123",
    sessionId: "session-1",
    isNewSession: false,
    resetTriggered: false,
    systemSent: false,
    abortedLastRun: false,
    storePath: "/tmp/sessions.json",
    sessionScope: "per-chat",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: "",
    bodyStripped: "",
    ...overrides,
  };
}

export function createGetReplyContinueDirectivesResult(params: {
  body: string;
  abortKey: string;
  from: string;
  to: string;
  senderId: string;
  commandSource: string;
  senderIsOwner: boolean;
  resetHookTriggered: boolean;
}) {
  return {
    kind: "continue" as const,
    result: {
      commandSource: params.commandSource,
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        ownerList: [],
        senderIsOwner: params.senderIsOwner,
        isAuthorizedSender: true,
        senderId: params.senderId,
        abortKey: params.abortKey,
        rawBodyNormalized: params.body,
        commandBodyNormalized: params.body,
        from: params.from,
        to: params.to,
        resetHookTriggered: params.resetHookTriggered,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: params.body,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      execOverrides: undefined,
      blockStreamingEnabled: false,
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: undefined,
      provider: "openai",
      model: "gpt-4o-mini",
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
        resolveThinkingCatalog: async () => [],
      },
      contextTokens: 0,
      inlineStatusRequested: false,
      directiveAck: undefined,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
    },
  };
}

export function registerGetReplyRuntimeOverrides(handles: {
  resolveReplyDirectives: (...args: unknown[]) => unknown;
  initSessionState: (...args: unknown[]) => unknown;
  handleInlineActions?: (...args: unknown[]) => unknown;
}): void {
  vi.doMock("./get-reply-directives.js", () => ({
    resolveReplyDirectives: (...args: unknown[]) => handles.resolveReplyDirectives(...args),
  }));
  vi.doMock("./get-reply-inline-actions.js", () => ({
    handleInlineActions:
      handles.handleInlineActions ?? vi.fn(async () => ({ kind: "reply", reply: { text: "ok" } })),
  }));
  vi.doMock("./session.js", () => ({
    initSessionState: (...args: unknown[]) => handles.initSessionState(...args),
  }));
}

export function expectResolvedTelegramTimezone(
  resolveReplyDirectives: Mock,
  userTimezone = "America/New_York",
): void {
  expect(resolveReplyDirectives).toHaveBeenCalledTimes(1);
  const call = resolveReplyDirectives.mock.calls.at(0)?.[0] as
    | {
        cfg?: {
          channels?: { telegram?: { botToken?: unknown } };
          agents?: { defaults?: { userTimezone?: unknown } };
        };
      }
    | undefined;
  if (!call) {
    throw new Error("expected resolveReplyDirectives call");
  }
  expect(call.cfg?.channels?.telegram?.botToken).toBe("resolved-telegram-token");
  expect(call.cfg?.agents?.defaults?.userTimezone).toBe(userTimezone);
}
