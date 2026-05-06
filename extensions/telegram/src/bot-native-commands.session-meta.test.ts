import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import {
  createDeferred,
  createTelegramGroupCommandContext,
  createNativeCommandTestParams,
  createTelegramPrivateCommandContext,
  createTelegramTopicCommandContext,
  type NativeCommandTestParams,
} from "./bot-native-commands.fixture-test-support.js";
import { type RegisterTelegramHandlerParams } from "./bot-native-commands.js";

// All mocks scoped to this file only — does not affect bot-native-commands.test.ts

type ResolveConfiguredBindingRouteFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").resolveConfiguredBindingRoute;
type EnsureConfiguredBindingRouteReadyFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").ensureConfiguredBindingRouteReady;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherParams =
  Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DeliverRepliesFn = typeof import("./bot/delivery.js").deliverReplies;
type DeliverRepliesParams = Parameters<DeliverRepliesFn>[0];
type MatchPluginCommandFn = typeof import("./bot-native-commands.runtime.js").matchPluginCommand;

const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
  queuedFinal: false,
  counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
};

const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredBindingRoute: vi.fn<ResolveConfiguredBindingRouteFn>(({ route }) => ({
    bindingResolution: null,
    route,
  })),
  ensureConfiguredBindingRouteReady: vi.fn<EnsureConfiguredBindingRouteReadyFn>(async () => ({
    ok: true,
  })),
}));
const sessionMocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(),
  resolveAndPersistSessionFile: vi.fn(),
  resolveStorePath: vi.fn(),
}));
const commandAuthMocks = vi.hoisted(() => ({
  resolveCommandArgMenu: vi.fn(),
}));
const pluginRuntimeMocks = vi.hoisted(() => ({
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
  matchPluginCommand: vi.fn<MatchPluginCommandFn>(() => null),
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async () => dispatchReplyResult,
  ),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<DeliverRepliesFn>(async () => ({ delivered: true })),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn<
    (ref: unknown) => { bindingId: string; targetSessionKey: string } | null
  >(() => null),
  touch: vi.fn(),
}));
const conversationStoreMocks = vi.hoisted(() => ({
  readChannelAllowFromStore: vi.fn(async () => []),
  upsertChannelPairingRequest: vi.fn(async () => ({ code: "PAIRCODE", created: true })),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: persistentBindingMocks.resolveConfiguredBindingRoute,
    resolveRuntimeConversationBindingRoute: (
      params: Parameters<typeof actual.resolveRuntimeConversationBindingRoute>[0],
    ) => {
      const conversation =
        "conversation" in params
          ? params.conversation
          : {
              channel: params.channel,
              accountId: params.accountId,
              conversationId: params.conversationId,
              parentConversationId: params.parentConversationId,
            };
      const bindingRecord = sessionBindingMocks.resolveByConversation(conversation);
      const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
      if (!bindingRecord || !boundSessionKey) {
        return { bindingRecord: null, route: params.route };
      }
      sessionBindingMocks.touch(bindingRecord.bindingId, undefined);
      return {
        bindingRecord,
        boundSessionKey,
        boundAgentId: params.route.agentId,
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          lastRoutePolicy: boundSessionKey === params.route.mainSessionKey ? "main" : "session",
          matchedBy: "binding.channel",
        },
      };
    },
    ensureConfiguredBindingRouteReady: persistentBindingMocks.ensureConfiguredBindingRouteReady,
    recordInboundSessionMetaSafe: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        agentId: string;
        sessionKey: string;
        ctx: unknown;
        onError?: (error: unknown) => void;
      }) => {
        const storePath = sessionMocks.resolveStorePath(params.cfg.session?.store, {
          agentId: params.agentId,
        });
        try {
          await sessionMocks.recordSessionMetaFromInbound({
            storePath,
            sessionKey: params.sessionKey,
            ctx: params.ctx,
          });
        } catch (error) {
          params.onError?.(error);
        }
      },
    ),
    readChannelAllowFromStore: conversationStoreMocks.readChannelAllowFromStore,
    upsertChannelPairingRequest: conversationStoreMocks.upsertChannelPairingRequest,
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => sessionBindingMocks.resolveByConversation(ref),
      touch: (bindingId: string, at?: number) => sessionBindingMocks.touch(bindingId, at),
      unbind: vi.fn(),
    }),
  };
});
vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    loadSessionStore: sessionMocks.loadSessionStore,
    resolveAndPersistSessionFile: sessionMocks.resolveAndPersistSessionFile,
    resolveStorePath: sessionMocks.resolveStorePath,
  };
});
vi.mock("openclaw/plugin-sdk/command-auth-native", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/command-auth-native")>(
    "openclaw/plugin-sdk/command-auth-native",
  );
  commandAuthMocks.resolveCommandArgMenu.mockImplementation(actual.resolveCommandArgMenu);
  return {
    ...actual,
    resolveCommandArgMenu: commandAuthMocks.resolveCommandArgMenu,
  };
});
vi.mock("./bot-native-commands.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-native-commands.runtime.js")>(
    "./bot-native-commands.runtime.js",
  );
  return {
    ...actual,
    finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
    dispatchReplyWithBufferedBlockDispatcher: replyMocks.dispatchReplyWithBufferedBlockDispatcher,
  };
});
vi.mock("openclaw/plugin-sdk/plugin-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-runtime")>(
    "openclaw/plugin-sdk/plugin-runtime",
  );
  return {
    ...actual,
    getPluginCommandSpecs: vi.fn(() => []),
    matchPluginCommand: pluginRuntimeMocks.matchPluginCommand,
    executePluginCommand: pluginRuntimeMocks.executePluginCommand,
  };
});
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));
vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;

type TelegramCommandHandler = (ctx: unknown) => Promise<void>;
type TelegramPluginCommandSpecs = ReturnType<
  NonNullable<TelegramNativeCommandDeps["getPluginCommandSpecs"]>
>;

function registerAndResolveStatusHandler(params: {
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  storeAllowFrom?: string[];
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    cfg,
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
    telegramCfg,
    resolveTelegramGroupConfig,
  } = params;
  return registerAndResolveCommandHandlerBase({
    commandName: "status",
    cfg,
    allowFrom: allowFrom ?? ["*"],
    groupAllowFrom: groupAllowFrom ?? [],
    storeAllowFrom,
    useAccessGroups: true,
    telegramCfg,
    resolveTelegramGroupConfig,
  });
}

function registerAndResolveCommandHandlerBase(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom: string[];
  groupAllowFrom: string[];
  storeAllowFrom?: string[];
  useAccessGroups: boolean;
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
  pluginCommandSpecs?: TelegramPluginCommandSpecs;
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
    useAccessGroups,
    telegramCfg,
    resolveTelegramGroupConfig,
    pluginCommandSpecs,
  } = params;
  const commandHandlers = new Map<string, TelegramCommandHandler>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const telegramDeps: TelegramNativeCommandDeps = {
    getRuntimeConfig: vi.fn(() => cfg),
    readChannelAllowFromStore: vi.fn(async () => storeAllowFrom ?? []),
    dispatchReplyWithBufferedBlockDispatcher: replyMocks.dispatchReplyWithBufferedBlockDispatcher,
    getPluginCommandSpecs: vi.fn(() => pluginCommandSpecs ?? []),
    listSkillCommandsForAgents: vi.fn(() => []),
    syncTelegramMenuCommands: vi.fn(),
  };
  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: TelegramCommandHandler) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as NativeCommandTestParams["bot"],
      cfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      telegramCfg,
      resolveTelegramGroupConfig,
      telegramDeps,
    }),
  });

  const handler = commandHandlers.get(commandName);
  expect(handler).toBeTruthy();
  return { handler: handler as TelegramCommandHandler, sendMessage };
}

function registerAndResolveCommandHandler(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  storeAllowFrom?: string[];
  useAccessGroups?: boolean;
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
  pluginCommandSpecs?: TelegramPluginCommandSpecs;
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
    useAccessGroups,
    telegramCfg,
    resolveTelegramGroupConfig,
    pluginCommandSpecs,
  } = params;
  return registerAndResolveCommandHandlerBase({
    commandName,
    cfg,
    allowFrom: allowFrom ?? [],
    groupAllowFrom: groupAllowFrom ?? [],
    storeAllowFrom,
    useAccessGroups: useAccessGroups ?? true,
    telegramCfg,
    resolveTelegramGroupConfig,
    pluginCommandSpecs,
  });
}

function createConfiguredAcpTopicBinding(boundSessionKey: string) {
  return {
    spec: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 0,
    },
  } as const;
}

function createConfiguredBindingRoute(
  route: ResolvedAgentRoute,
  binding: ReturnType<typeof createConfiguredAcpTopicBinding> | null,
) {
  return {
    bindingResolution: binding
      ? {
          conversation: binding.record.conversation,
          compiledBinding: {
            channel: "telegram" as const,
            binding: {
              type: "acp" as const,
              agentId: binding.spec.agentId,
              match: {
                channel: "telegram",
                accountId: binding.spec.accountId,
                peer: {
                  kind: "group" as const,
                  id: binding.spec.conversationId,
                },
              },
              acp: {
                mode: binding.spec.mode,
              },
            },
            bindingConversationId: binding.spec.conversationId,
            target: {
              conversationId: binding.spec.conversationId,
              ...(binding.spec.parentConversationId
                ? { parentConversationId: binding.spec.parentConversationId }
                : {}),
            },
            agentId: binding.spec.agentId,
            provider: {
              compileConfiguredBinding: () => ({
                conversationId: binding.spec.conversationId,
                ...(binding.spec.parentConversationId
                  ? { parentConversationId: binding.spec.parentConversationId }
                  : {}),
              }),
              matchInboundConversation: () => ({
                conversationId: binding.spec.conversationId,
                ...(binding.spec.parentConversationId
                  ? { parentConversationId: binding.spec.parentConversationId }
                  : {}),
              }),
            },
            targetFactory: {
              driverId: "acp" as const,
              materialize: () => ({
                record: binding.record,
                statefulTarget: {
                  kind: "stateful" as const,
                  driverId: "acp" as const,
                  sessionKey: binding.record.targetSessionKey,
                  agentId: binding.spec.agentId,
                },
              }),
            },
          },
          match: {
            conversationId: binding.spec.conversationId,
            ...(binding.spec.parentConversationId
              ? { parentConversationId: binding.spec.parentConversationId }
              : {}),
          },
          record: binding.record,
          statefulTarget: {
            kind: "stateful" as const,
            driverId: "acp" as const,
            sessionKey: binding.record.targetSessionKey,
            agentId: binding.spec.agentId,
          },
        }
      : null,
    ...(binding ? { boundSessionKey: binding.record.targetSessionKey } : {}),
    route,
  };
}

function expectUnauthorizedNewCommandBlocked(sendMessage: ReturnType<typeof vi.fn>) {
  expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  expect(persistentBindingMocks.resolveConfiguredBindingRoute).not.toHaveBeenCalled();
  expect(persistentBindingMocks.ensureConfiguredBindingRouteReady).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    -1001234567890,
    "You are not authorized to use this command.",
    expect.objectContaining({ message_thread_id: 42 }),
  );
}

describe("registerTelegramNativeCommands — session metadata", () => {
  beforeAll(async () => {
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
  });

  beforeEach(() => {
    persistentBindingMocks.resolveConfiguredBindingRoute.mockClear();
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(route, null),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockClear();
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });
    commandAuthMocks.resolveCommandArgMenu.mockClear();
    sessionMocks.loadSessionStore.mockClear().mockReturnValue({});
    sessionMocks.recordSessionMetaFromInbound.mockClear().mockResolvedValue(undefined);
    sessionMocks.resolveAndPersistSessionFile.mockClear().mockImplementation(async (params) => {
      const sessionFile =
        params.fallbackSessionFile ?? `/tmp/openclaw-sessions/${params.sessionId}.jsonl`;
      return {
        sessionFile,
        sessionEntry: {
          ...params.sessionEntry,
          sessionId: params.sessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      };
    });
    sessionMocks.resolveStorePath.mockClear().mockReturnValue("/tmp/openclaw-sessions.json");
    pluginRuntimeMocks.executePluginCommand.mockClear().mockResolvedValue({ text: "ok" });
    pluginRuntimeMocks.matchPluginCommand.mockClear().mockReturnValue(null);
    replyMocks.dispatchReplyWithBufferedBlockDispatcher
      .mockClear()
      .mockResolvedValue(dispatchReplyResult);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    deliveryMocks.deliverReplies.mockClear().mockResolvedValue({ delivered: true });
  });

  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    await handler(createTelegramPrivateCommandContext());

    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    const call = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string; ctx?: { OriginatingChannel?: string; Provider?: string } }]
      >
    )[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.ctx?.Provider).toBe("telegram");
    expect(call?.sessionKey).toBe(dispatchCall?.ctx?.CommandTargetSessionKey);
  });

  it("uses the target session model when building native argument menus", async () => {
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "anthropic/claude-opus-4-7": {
              params: { thinking: "xhigh" },
            },
          },
        },
      },
    } as OpenClawConfig;
    sessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
        thinkingLevel: "high",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think" && params.provider === "anthropic",
    )?.[0];
    expect(menuCall).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-7",
      }),
    );
    expect(sessionMocks.loadSessionStore).toHaveBeenCalledWith("/tmp/openclaw-sessions.json");
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Current thinking level: high.\nChoose level for /think."),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("inherits the parent session model when building DM thread native argument menus", async () => {
    const cfg: OpenClawConfig = {};
    sessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext({ threadId: 77 }));

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think" && params.provider === "anthropic",
    )?.[0];
    expect(menuCall).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-7",
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Choose level for /think."),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses the configured default model instead of temporary auto fallback overrides", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          thinkingDefault: "medium",
        },
      },
    } as OpenClawConfig;
    sessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "auto",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think" && params.provider === "openai",
    )?.[0];
    expect(menuCall).toEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Current thinking level: medium.\nChoose level for /think."),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses target model thinking defaults before global thinking defaults", async () => {
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "anthropic/claude-opus-4-7": {
              params: { thinking: "xhigh" },
            },
          },
        },
      },
    } as OpenClawConfig;
    sessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Current thinking level: xhigh.\nChoose level for /think."),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses per-agent thinking defaults before target model and global thinking defaults", async () => {
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "anthropic/claude-opus-4-7": {
              params: { thinking: "xhigh" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            model: { primary: "anthropic/claude-opus-4-7" },
            thinkingDefault: "minimal",
          },
        ],
      },
    } as OpenClawConfig;
    sessionMocks.loadSessionStore.mockReturnValue({});

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Current thinking level: minimal.\nChoose level for /think."),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not load the session store when a native argument menu is skipped", async () => {
    const { handler } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg: {},
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext({ match: "high" }));

    expect(sessionMocks.loadSessionStore).not.toHaveBeenCalled();
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred<void>();
    sessionMocks.recordSessionMetaFromInbound.mockReturnValue(deferred.promise);

    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    const runPromise = handler(createTelegramPrivateCommandContext());

    await vi.waitFor(() => {
      expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].dispatcherOptions,
    ).toEqual(expect.objectContaining({ beforeDeliver: expect.any(Function) }));
  });

  it("does not inject approval buttons for native command replies once the monitor owns approvals", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            text: "Mode: foreground\nRun: /approve 7f423fdc allow-once (or allow-always / deny).",
          },
          { kind: "final" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = deliveryMocks.deliverReplies.mock.calls[0]?.[0] as
      | DeliverRepliesParams
      | undefined;
    const deliveredPayload = deliveredCall?.replies?.[0];
    expect(deliveredPayload).toBeTruthy();
    expect(deliveredPayload?.["text"]).toContain("/approve 7f423fdc allow-once");
    expect(deliveredPayload?.["channelData"]).toBeUndefined();
  });

  it("suppresses local structured exec approval replies for native commands", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            text: "Approval required.\n\n```txt\n/approve 7f423fdc allow-once\n```",
            channelData: {
              execApproval: {
                approvalId: "7f423fdc-1111-2222-3333-444444444444",
                approvalSlug: "7f423fdc",
                allowedDecisions: ["allow-once", "allow-always", "deny"],
              },
            },
          },
          { kind: "tool" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("sends native command error replies silently when silentErrorReplies is enabled", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver({ text: "oops", isError: true }, { kind: "final" });
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            silentErrorReplies: true,
          },
        },
      },
      telegramCfg: { silentErrorReplies: true },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = deliveryMocks.deliverReplies.mock.calls[0]?.[0] as
      | DeliverRepliesParams
      | undefined;
    expect(deliveredCall).toEqual(
      expect.objectContaining({
        silent: true,
        replies: [expect.objectContaining({ isError: true })],
      }),
    );
  });

  it("routes Telegram native commands through configured ACP topic bindings", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(
        {
          ...route,
          sessionKey: boundSessionKey,
          agentId: "codex",
          matchedBy: "binding.channel",
        },
        createConfiguredAcpTopicBinding(boundSessionKey),
      ),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(persistentBindingMocks.resolveConfiguredBindingRoute).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredBindingRouteReady).toHaveBeenCalledTimes(1);
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
    const sessionMetaCall = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string }]
      >
    )[0]?.[0];
    expect(sessionMetaCall?.sessionKey).toBe(boundSessionKey);
  });

  it("routes Telegram native commands through topic-specific agent sessions", async () => {
    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "zu" },
      }),
    });
    await handler(createTelegramTopicCommandContext());

    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(
      "agent:zu:telegram:group:-1001234567890:topic:42",
    );
    const sessionMetaCall = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string; ctx?: { From?: string; ChatType?: string } }]
      >
    )[0]?.[0];
    expect(sessionMetaCall?.sessionKey).toBe("agent:zu:telegram:group:-1001234567890:topic:42");
    expect(sessionMetaCall?.ctx?.From).toBe("telegram:group:-1001234567890:topic:42");
    expect(sessionMetaCall?.ctx?.ChatType).toBe("group");
  });

  it("does not mark paired Telegram DM allowlist entries as native group command owners", async () => {
    const { handler, sendMessage } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      storeAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });

  it("authorizes paired Telegram DMs without marking them as owners", async () => {
    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      storeAllowFrom: ["200"],
    });
    await handler(createTelegramPrivateCommandContext());

    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [
          {
            ctx?: {
              CommandAuthorized?: boolean;
            };
          },
        ]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandAuthorized).toBe(true);
    expect(dispatchCall?.ctx).not.toHaveProperty("OwnerAllowFrom");
  });

  it("routes Telegram native commands through bound topic sessions", async () => {
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "default:-1001234567890:topic:42",
      targetSessionKey: "agent:codex-acp:session-1",
    });

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
    });
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe("agent:codex-acp:session-1");
    const sessionMetaCall = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string }]
      >
    )[0]?.[0];
    expect(sessionMetaCall?.sessionKey).toBe("agent:codex-acp:session-1");
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith(
      "default:-1001234567890:topic:42",
      undefined,
    );
  });

  it("routes Telegram native commands through bound top-level group sessions", async () => {
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "default:-1001234567890",
      targetSessionKey: "agent:codex-acp:session-group",
    });

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramGroupCommandContext());

    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    });
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string; OriginatingTo?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe("agent:codex-acp:session-group");
    expect(dispatchCall?.ctx?.OriginatingTo).toBe("telegram:-1001234567890");
    const sessionMetaCall = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string }]
      >
    )[0]?.[0];
    expect(sessionMetaCall?.sessionKey).toBe("agent:codex-acp:session-group");
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("default:-1001234567890", undefined);
  });

  it.each(["new", "reset"] as const)(
    "preserves the topic-qualified origin target for native /%s in forum topics",
    async (commandName) => {
      const { handler } = registerAndResolveCommandHandler({
        commandName,
        cfg: {},
        allowFrom: ["200"],
        groupAllowFrom: ["200"],
        useAccessGroups: true,
      });
      await handler(createTelegramTopicCommandContext());

      const dispatchCall = (
        replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
          [
            {
              ctx?: {
                CommandTargetSessionKey?: string;
                MessageThreadId?: number;
                OriginatingTo?: string;
              };
            },
          ]
        >
      )[0]?.[0];
      expect(dispatchCall?.ctx).toEqual(
        expect.objectContaining({
          CommandTargetSessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
          MessageThreadId: 42,
          OriginatingTo: "telegram:-1001234567890:topic:42",
        }),
      );
    },
  );

  it("aborts native command dispatch when configured ACP topic binding cannot initialize", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(
        {
          ...route,
          sessionKey: boundSessionKey,
          agentId: "codex",
          matchedBy: "binding.channel",
        },
        createConfiguredAcpTopicBinding(boundSessionKey),
      ),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({
      ok: false,
      error: "gateway unavailable",
    });

    const { handler, sendMessage } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "Configured ACP binding is unavailable right now. Please try again.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps /new blocked in ACP-bound Telegram topics when sender is unauthorized", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(
        {
          ...route,
          sessionKey: boundSessionKey,
          agentId: "codex",
          matchedBy: "binding.channel",
        },
        createConfiguredAcpTopicBinding(boundSessionKey),
      ),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });

  it("keeps /new blocked for unbound Telegram topics when sender is unauthorized", async () => {
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(route, null),
    );

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });

  it("passes a persisted topic session file to plugin commands", async () => {
    sessionMocks.resolveStorePath.mockReturnValue("/tmp/openclaw-sessions/sessions.json");
    sessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:telegram:group:-1001234567890:topic:42": {
        sessionId: "sess-topic",
        updatedAt: 1,
      },
    });

    const { handler } = registerAndResolveCommandHandler({
      commandName: "codex",
      cfg: { commands: { allowFrom: { telegram: ["200"] } } } as OpenClawConfig,
      groupAllowFrom: ["-1001234567890"],
      useAccessGroups: false,
      pluginCommandSpecs: [
        {
          name: "codex",
          description: "Codex",
          acceptsArgs: true,
        },
      ] as TelegramPluginCommandSpecs,
    });
    pluginRuntimeMocks.matchPluginCommand.mockReturnValue({
      command: {
        name: "codex",
        description: "Codex",
        handler: vi.fn(),
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex",
        requireAuth: true,
      },
      args: "bind --cwd /tmp/work",
    });

    await handler(
      createTelegramTopicCommandContext({ match: "bind --cwd /tmp/work", threadId: 42 }),
    );

    expect(sessionMocks.resolveAndPersistSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-topic",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
        storePath: "/tmp/openclaw-sessions/sessions.json",
        sessionsDir: "/tmp/openclaw-sessions",
        fallbackSessionFile: path.resolve("/tmp/openclaw-sessions", "sess-topic-topic-42.jsonl"),
      }),
    );
    expect(pluginRuntimeMocks.executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
        sessionId: "sess-topic",
        sessionFile: path.resolve("/tmp/openclaw-sessions", "sess-topic-topic-42.jsonl"),
        messageThreadId: 42,
      }),
    );
  });

  it("sends an empty-response fallback when a plugin command returns undefined", async () => {
    pluginRuntimeMocks.executePluginCommand.mockResolvedValue(undefined as never);

    const { handler } = registerAndResolveCommandHandler({
      commandName: "codex",
      cfg: { commands: { allowFrom: { telegram: ["200"] } } } as OpenClawConfig,
      useAccessGroups: false,
      pluginCommandSpecs: [
        {
          name: "codex",
          description: "Codex",
          acceptsArgs: true,
        },
      ] as TelegramPluginCommandSpecs,
    });
    pluginRuntimeMocks.matchPluginCommand.mockReturnValue({
      command: {
        name: "codex",
        description: "Codex",
        handler: vi.fn(),
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex",
        requireAuth: true,
      },
      args: "status",
    });

    await handler(createTelegramPrivateCommandContext({ match: "status" }));

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });
});
