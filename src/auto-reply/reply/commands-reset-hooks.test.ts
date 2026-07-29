// Tests reset hook emission and cleanup around reset commands.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bootstrapCache from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import type { MsgContext } from "../templating.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

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
const preparedCatalogMock = vi.hoisted(() => ({
  getPreparedModelCatalogSnapshot: vi.fn((): unknown => undefined),
  loadPreparedModelCatalogSnapshot: vi.fn(
    async (): Promise<unknown> => ({
      entries: [],
      routeVariants: [],
    }),
  ),
}));

let tempRoots: string[] = [];

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

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

vi.mock("../../agents/prepared-model-catalog.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/prepared-model-catalog.js")>(
    "../../agents/prepared-model-catalog.js",
  )),
  getPreparedModelCatalogSnapshot: preparedCatalogMock.getPreparedModelCatalogSnapshot,
  loadPreparedModelCatalogSnapshot: preparedCatalogMock.loadPreparedModelCatalogSnapshot,
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
    directives: parseInlineDirectives(""),
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

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
    preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
    preparedCatalogMock.loadPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [],
      routeVariants: [],
    });
    triggerInternalHookMock.mockResolvedValue(undefined);
    routeReplyMock.mockResolvedValue({
      ok: true,
      delivered: true,
      messageId: "reset-hook-1",
    });
  });

  afterEach(async () => {
    clearBootstrapSnapshotSpy.mockRestore();
    clearSessionStoreCacheForTest();
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots = [];
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

  it("requires operator.admin for internal /reset soft commands", async () => {
    const params = buildResetParams(
      "/reset soft",
      {
        commands: { text: true },
        channels: { webchat: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        Provider: "webchat",
        Surface: "webchat",
        CommandAuthorized: true,
        GatewayClientScopes: ["operator.write"],
      },
    );
    params.command.isAuthorizedSender = true;
    params.command.channel = "webchat";
    params.command.channelId = "webchat";
    params.command.surface = "webchat";

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({ shouldContinue: false });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(params.command.softResetTriggered).not.toBe(true);
    expect(clearBootstrapSnapshotSpy).not.toHaveBeenCalled();
  });

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

  it("keeps free-text /new tails available for the existing fallthrough path", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams("/new Beispielsessionname", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBeUndefined();
  });

  it("names a fresh session for explicit /new --name tails", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams("/new --name Beispielsessionname", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Beispielsessionname”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Beispielsessionname",
    );
  });

  it("names a fresh session for explicit /new name: tails", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams("/new name:Planning notes", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Planning notes”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Planning notes",
    );
  });

  it("keeps model-like /new tails available for the existing fallthrough path", async () => {
    const params = buildResetParams("/new gpt-5.5", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.invalid",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT 5.5",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_000,
              },
            ],
          },
        },
      },
    } as OpenClawConfig);

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("keeps model alias /new tails available for the existing fallthrough path", async () => {
    const params = buildResetParams("/new opus", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-20250514": { alias: "opus" },
          },
        },
      },
    } as OpenClawConfig);

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("uses native structured /new title args for multi-word session names", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new Planning notes",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "Planning notes" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Planning notes”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Planning notes",
    );
  });

  it("keeps native model-like /new title args available for model fallthrough", async () => {
    const params = buildResetParams(
      "/new gpt-5.5",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.invalid",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT 5.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 16_000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "gpt-5.5" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("keeps native provider/model /new title args available for model fallthrough", async () => {
    const params = buildResetParams(
      "/new openai gpt-5.5",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.invalid",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT 5.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 16_000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "openai gpt-5.5" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("keeps native provider/model plus prompt title args available for model fallthrough", async () => {
    const params = buildResetParams(
      "/new openai gpt-5.5 summarize this",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.invalid",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT 5.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 16_000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "openai gpt-5.5 summarize this" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("keeps native /new tails using a per-agent model override available for model fallthrough", async () => {
    const params = buildResetParams(
      "/new custom/private-model summarize this",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        // The override lives only under a per-agent model, not models.providers or
        // agents.defaults.model, so classification must still treat it as a model directive.
        agents: {
          list: [{ id: "main", default: true, model: { primary: "custom/private-model" } }],
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "custom/private-model summarize this" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("keeps native /new tails using a string-form default model available for model fallthrough", async () => {
    const params = buildResetParams(
      "/new custom/private-model summarize this",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        // agents.defaults.model supports a bare string shorthand; classification must
        // resolve it too, not just the { primary, fallbacks } object form.
        agents: { defaults: { model: "custom/private-model" } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "custom/private-model summarize this" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("keeps native alias /new tails with a trailing prompt available for model fallthrough", async () => {
    // Regression: the whole tail was matched against the alias index, so a leading
    // alias plus a prompt (`/new opus summarize this`) was captured verbatim as a
    // session name. Classification must key off the FIRST token so it falls through
    // to the reset-model resolver (opus directive + "summarize this" prompt).
    const params = buildResetParams(
      "/new opus summarize this",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-20250514": { alias: "opus" },
            },
          },
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "opus summarize this" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("recognizes an alias defined only under the active agent's model list", async () => {
    // Regression: the alias index was built without an agentId, so an alias declared
    // solely under the active agent's `agents.list[].models` was not recognized and
    // `/new fast summarize this` saved the whole tail as the session title, dropping
    // the prompt. Scoping the index to the active agent must classify it as a model
    // directive so it falls through to the reset-model resolver.
    const params = buildResetParams(
      "/new fast summarize this",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        agents: {
          list: [
            {
              id: "main",
              default: true,
              models: { "openai/gpt-5.5-fast": { alias: "fast" } },
            },
          ],
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "fast summarize this" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("names a fresh session from a non-active agent's model alias tail", async () => {
    // The alias index is scoped to the ACTIVE agent, so an alias living only on
    // another agent must not be treated as a model directive; the tail stays a
    // legitimate multi-word session name.
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new fast summarize this",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        agents: {
          list: [
            { id: "main", default: true },
            { id: "other", models: { "openai/gpt-5.5-fast": { alias: "fast" } } },
          ],
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "fast summarize this" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “fast summarize this”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "fast summarize this",
    );
  });

  it("names a fresh session from a non-active agent's model override tail", async () => {
    // Only the active agent's model keys gate classification. A model override that
    // lives solely on ANOTHER agent must not be treated as a model directive, so the
    // tail is a legitimate multi-word session name instead of being dropped.
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new custom/private-model notes",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        agents: {
          list: [
            { id: "main", default: true },
            { id: "other", model: { primary: "custom/private-model" } },
          ],
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "custom/private-model notes" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “custom/private-model notes”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "custom/private-model notes",
    );
  });

  it("recognizes a model published only in the prepared catalog as a directive", async () => {
    // A plugin-supplied provider publishes its models into the prepared model catalog,
    // not into cfg.models.providers, so "acme/widget" is invisible to the config-only
    // refs. The warm catalog snapshot must let classification treat it as a model
    // directive (falling through to the reset-model resolver) instead of capturing it
    // as a multi-word session name.
    preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue({
      entries: [{ id: "widget", name: "Widget", provider: "acme" }],
      routeVariants: [],
    });
    const params = buildResetParams(
      "/new acme/widget summarize this",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "acme/widget summarize this" } },
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
  });

  it("treats a single-word catalog display name as a session name, not a directive", async () => {
    // The reset-model resolver keys allowed models on the ID (widget-1), never on the display
    // name ("Roadmap"), so classification must not treat the display name as a directive. A
    // `/new Roadmap planning` is a session title; capturing "roadmap" as a model ref would
    // divergently dispatch the tail as an unresolvable prompt instead of naming the session.
    preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue({
      entries: [{ id: "widget-1", name: "Roadmap", provider: "acme" }],
      routeVariants: [],
    });
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new Roadmap planning",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "Roadmap planning" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Roadmap planning”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Roadmap planning",
    );
  });

  it("treats a configured provider model display name as a session name, not a directive", async () => {
    // Same rule for cfg.models.providers: only the model ID is a reset directive, so a
    // display name that differs from the ID must remain available as a plain session title.
    preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new Roadmap planning",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        models: {
          providers: {
            acme: { models: [{ id: "widget-1", name: "Roadmap" }] },
          },
        },
      } as unknown as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "Roadmap planning" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Roadmap planning”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Roadmap planning",
    );
  });

  it("resolves a cold plugin model tail on demand instead of naming the session", async () => {
    // getPreparedModelCatalogSnapshot returns undefined until the catalog is published.
    // A provider/model-shaped tail that config refs and the warm snapshot cannot resolve
    // is only ambiguous during this cold window, so classification escalates once to an
    // on-demand catalog load. When the plugin model exists, the tail is a model directive
    // (result is null so the reset-model resolver runs) and is NOT frozen as a session name.
    preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
    preparedCatalogMock.loadPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [{ id: "widget", name: "Widget", provider: "acme" }],
      routeVariants: [],
    });
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new acme/widget notes",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "acme/widget notes" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    expect(preparedCatalogMock.loadPreparedModelCatalogSnapshot).toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBeUndefined();
  });

  it("resolves a cold plugin model tail that uses a manifest alias", async () => {
    // The loaded catalog stores canonical ids (gemini-3.1-pro-preview) while plugin
    // manifests declare user-facing aliases (gemini-3-pro). Classification must apply
    // the same manifest normalization as the reset-model resolver before comparing;
    // otherwise the aliased directive is frozen into the session name even though the
    // resolver downstream would have honored it as a model switch.
    setCurrentPluginMetadataSnapshot(
      {
        policyHash: "reset-alias-test",
        index: {
          version: 1,
          hostContractVersion: "test",
          compatRegistryVersion: "test",
          migrationVersion: 1,
          policyHash: "reset-alias-test",
          generatedAtMs: 0,
          installRecords: {},
          plugins: [],
          diagnostics: [],
        },
        plugins: [
          {
            modelIdNormalization: {
              providers: {
                google: {
                  aliases: { "gemini-3-pro": "gemini-3.1-pro-preview" },
                },
              },
            },
          },
        ],
      } as never,
      { config: {} },
    );
    try {
      preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
      preparedCatalogMock.loadPreparedModelCatalogSnapshot.mockResolvedValue({
        entries: [{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", provider: "google" }],
        routeVariants: [],
      });
      const storePath = await createStorePath();
      await upsertSessionEntry(
        { storePath, sessionKey: "agent:main:main" },
        { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
      );
      const params = buildResetParams(
        "/new google/gemini-3-pro notes",
        {
          commands: { text: true },
          channels: { discord: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        {
          CommandSource: "native",
          CommandArgs: { values: { title: "google/gemini-3-pro notes" } },
          Provider: "discord",
          Surface: "discord",
        },
      );
      params.storePath = storePath;
      params.sessionStore = {
        "agent:main:main": {
          sessionId: "fresh-session",
          updatedAt: 1,
          totalTokens: 0,
          totalTokensFresh: true,
        },
      };
      params.sessionEntry = params.sessionStore["agent:main:main"];

      const result = await maybeHandleResetCommand(params);

      expect(result).toBeNull();
      expect(preparedCatalogMock.loadPreparedModelCatalogSnapshot).toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBeUndefined();
    } finally {
      clearCurrentPluginMetadataSnapshot();
    }
  });

  it("classifies a bare cold plugin model id from manifest facts without a catalog load", async () => {
    // Plugin manifests declare their model catalog statically, so a manifest-declared id
    // (acme/widget) is a prepared fact even while the runtime catalog snapshot is still
    // cold. A bare `/new widget …` tail has no provider/model shape, so the slash-gated
    // on-demand escalation never fires for it; classification must instead resolve it
    // from the manifest facts alone — without any catalog load — or the tail would be
    // frozen as a session name cold and switch to a model directive once warm.
    const cfg = {
      commands: { text: true },
      channels: { discord: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
    setCurrentPluginMetadataSnapshot(
      {
        policyHash,
        index: {
          version: 1,
          hostContractVersion: "test",
          compatRegistryVersion: "test",
          migrationVersion: 1,
          policyHash,
          generatedAtMs: 0,
          installRecords: {},
          plugins: [],
          diagnostics: [],
        },
        plugins: [
          {
            id: "acme-models",
            origin: "bundled",
            modelCatalog: {
              providers: { acme: { models: [{ id: "widget", name: "Widget" }] } },
            },
          },
        ],
      } as never,
      { config: cfg },
    );
    try {
      preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
      const storePath = await createStorePath();
      await upsertSessionEntry(
        { storePath, sessionKey: "agent:main:main" },
        { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
      );
      const params = buildResetParams("/new widget summarize this", cfg, {
        CommandSource: "native",
        CommandArgs: { values: { title: "widget summarize this" } },
        Provider: "discord",
        Surface: "discord",
      });
      params.storePath = storePath;
      params.sessionStore = {
        "agent:main:main": {
          sessionId: "fresh-session",
          updatedAt: 1,
          totalTokens: 0,
          totalTokensFresh: true,
        },
      };
      params.sessionEntry = params.sessionStore["agent:main:main"];

      const result = await maybeHandleResetCommand(params);

      expect(result).toBeNull();
      expect(preparedCatalogMock.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBeUndefined();
    } finally {
      clearCurrentPluginMetadataSnapshot();
    }
  });

  it("keeps naming the session when the first word is not a manifest model id while cold", async () => {
    // Guard the other direction of the manifest-facts fallback: a published manifest
    // catalog must only reclassify declared model ids. An unrelated multi-word title
    // still names the session while cold, and no on-demand catalog load happens for it.
    const cfg = {
      commands: { text: true },
      channels: { discord: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
    setCurrentPluginMetadataSnapshot(
      {
        policyHash,
        index: {
          version: 1,
          hostContractVersion: "test",
          compatRegistryVersion: "test",
          migrationVersion: 1,
          policyHash,
          generatedAtMs: 0,
          installRecords: {},
          plugins: [],
          diagnostics: [],
        },
        plugins: [
          {
            id: "acme-models",
            origin: "bundled",
            modelCatalog: {
              providers: { acme: { models: [{ id: "widget", name: "Widget" }] } },
            },
          },
        ],
      } as never,
      { config: cfg },
    );
    try {
      preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
      const storePath = await createStorePath();
      await upsertSessionEntry(
        { storePath, sessionKey: "agent:main:main" },
        { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
      );
      const params = buildResetParams("/new Roadmap planning", cfg, {
        CommandSource: "native",
        CommandArgs: { values: { title: "Roadmap planning" } },
        Provider: "discord",
        Surface: "discord",
      });
      params.storePath = storePath;
      params.sessionStore = {
        "agent:main:main": {
          sessionId: "fresh-session",
          updatedAt: 1,
          totalTokens: 0,
          totalTokensFresh: true,
        },
      };
      params.sessionEntry = params.sessionStore["agent:main:main"];

      const result = await maybeHandleResetCommand(params);

      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: "✅ New session started as “Roadmap planning”." },
      });
      expect(preparedCatalogMock.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
        "Roadmap planning",
      );
    } finally {
      clearCurrentPluginMetadataSnapshot();
    }
  });

  it("names a fresh session when a cold plugin model tail is not a known model", async () => {
    // Cold snapshot plus an on-demand load that does NOT contain the leading provider/model
    // ref: classification degrades gracefully to treating the tail as a session name instead
    // of dropping the trailing prompt, matching the pre-warm fallback behavior.
    preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
    preparedCatalogMock.loadPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [{ id: "other", name: "Other", provider: "someplugin" }],
      routeVariants: [],
    });
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new acme/widget notes",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "acme/widget notes" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “acme/widget notes”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "acme/widget notes",
    );
  });

  it("does not cold-load the catalog for a plain multi-word session name", async () => {
    // A no-slash leading token can never be a provider/model ref, so classification must not
    // escalate to an on-demand catalog load on the /new hot path even while the catalog is cold.
    preparedCatalogMock.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new weekly planning notes",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "weekly planning notes" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “weekly planning notes”." },
    });
    expect(preparedCatalogMock.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("names a fresh session from a model-brand word that no configured provider serves", async () => {
    // Regression: the old prefix heuristic classified any tail starting with a known
    // model-brand word (gemini, claude, …) as a model directive even when no configured
    // provider could resolve it, so `/new Gemini planning` silently dropped the name.
    // The classifier must mirror the reset-model resolver: with only openai/gpt-5.5
    // configured, "Gemini planning" cannot resolve and stays a session name.
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new Gemini planning",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.invalid",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT 5.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 16_000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "Gemini planning" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Gemini planning”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Gemini planning",
    );
  });

  it("names a fresh session from a tail matching only a fallback model's bare id", async () => {
    // Regression: configured fallback refs were folded into the classification set, so
    // `/new foo planning` was swallowed as a model directive whenever some fallback ended
    // in "foo". The reset-model resolver keeps fallbacks out of its allowed keys, so the
    // classifier must too — the tail stays a session name.
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new foo planning",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["other/foo"] } },
        },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "foo planning" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “foo planning”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "foo planning",
    );
  });

  it("keeps native --model title args for the reset-model resolver instead of naming", async () => {
    // A native title of `--model openai/gpt-5.5` is an explicit model flag, not a bare
    // model ref, so ref classification alone would miss it and freeze the flag text as
    // the session name. The native path must mirror the text path's explicit-flag reject.
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    for (const title of ["--model openai/gpt-5.5", "model:openai/gpt-5.5"]) {
      const params = buildResetParams(
        `/new ${title}`,
        {
          commands: { text: true },
          channels: { discord: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        {
          CommandSource: "native",
          CommandArgs: { values: { title } },
          Provider: "discord",
          Surface: "discord",
        },
      );
      params.storePath = storePath;
      params.sessionStore = {
        "agent:main:main": {
          sessionId: "fresh-session",
          updatedAt: 1,
          totalTokens: 0,
          totalTokensFresh: true,
        },
      };
      params.sessionEntry = params.sessionStore["agent:main:main"];

      const result = await maybeHandleResetCommand(params);

      expect(result, title).toBeNull();
      expect(
        loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label,
        title,
      ).toBeUndefined();
    }
  });

  it("refuses to relabel a session that rotated while /new hooks were running", async () => {
    // The label write is bound to the session incarnation the /new targeted. When a
    // concurrent reset rotates the persisted session while hooks are awaited, naming
    // must fail instead of silently relabeling the replacement session.
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    triggerInternalHookMock.mockImplementation(async () => {
      await upsertSessionEntry(
        { storePath, sessionKey: "agent:main:main" },
        { sessionId: "rotated-session", updatedAt: 2, totalTokens: 0, totalTokensFresh: true },
      );
    });
    const params = buildResetParams(
      "/new Rotated notes",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "Rotated notes" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "✅ New session started, but couldn't name it: the session changed before it could be named",
      },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBeUndefined();
  });

  it("allows slashes in native structured /new title args", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new Q3/Q4 planning",
      {
        commands: { text: true },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "Q3/Q4 planning" } },
        Provider: "discord",
        Surface: "discord",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Q3/Q4 planning”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Q3/Q4 planning",
    );
  });

  it("parses native /new name syntax before writing session labels", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "fresh-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildResetParams(
      "/new --name Planning notes",
      {
        commands: { text: true },
        channels: { slack: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        CommandArgs: { values: { title: "/new --name Planning notes" } },
        Provider: "slack",
        Surface: "slack",
      },
    );
    params.storePath = storePath;
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "fresh-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    };
    params.sessionEntry = params.sessionStore["agent:main:main"];

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started as “Planning notes”." },
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.label).toBe(
      "Planning notes",
    );
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
