import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredAcpTopicBinding,
  createConfiguredBindingRoute,
} from "./bot-native-command-dispatch.test-support.js";
import {
  activePluginRegistry,
  dispatchChannelInboundTurnMock,
  executorTestMocks,
  expectRecordFields,
  expectSendMessageCall,
  expectUnauthorizedNewCommandBlocked,
  firstMockArg,
  registerAndResolveCommandHandler,
  registerAndResolveStatusHandler,
  requireRecord,
  resetSessionMetaMocks,
  runWithTelegramUpdateProcessingFrame,
} from "./bot-native-command-executors.test-support.js";
import {
  createTelegramGroupCommandContext,
  createTelegramPrivateCommandContext,
  createTelegramTopicCommandContext,
} from "./bot-native-commands.fixture-test-support.js";

const { persistentBindingMocks, replyMocks, sessionBindingMocks, sessionMocks } = executorTestMocks;

describe("Telegram native command dispatch routing", () => {
  beforeEach(resetSessionMetaMocks);

  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    const shadowHandler = vi.fn(async () => ({ text: "wrong plugin" }));
    activePluginRegistry.commands.push({
      pluginId: "shadow-plugin",
      source: "test",
      command: {
        name: "status",
        description: "Shadow status",
        channels: ["telegram"],
        requireAuth: false,
        handler: shadowHandler,
      },
    });
    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    await handler(createTelegramPrivateCommandContext());

    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    expect(shadowHandler).not.toHaveBeenCalled();
    const turnPlan = dispatchChannelInboundTurnMock.mock.calls[0]?.[0];
    expect(turnPlan?.replyOptions?.[Symbol.for("openclaw.pluginCommandDispatch") as never]).toEqual(
      { kind: "non-plugin" },
    );
    const call = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string; ctx?: { OriginatingChannel?: string; Provider?: string } }]
      >
    )[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.ctx?.Provider).toBe("telegram");
    expect(call?.sessionKey).toBe(turnPlan?.ctxPayload.CommandTargetSessionKey);
    expect(turnPlan?.record?.sessionKey).toBe(turnPlan?.ctxPayload.CommandTargetSessionKey);
  });

  it("leaves native-command outcomes to the update middleware owner", async () => {
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
      await handler(createTelegramPrivateCommandContext());
    });

    expect(result).toBeUndefined();
  });

  it("preserves every argument on native queue command turns", async () => {
    const { handler } = registerAndResolveCommandHandler({
      commandName: "queue",
      cfg: {},
      allowFrom: ["*"],
    });

    await handler(createTelegramPrivateCommandContext({ match: "Can you diagnose this?" }));

    expect(dispatchChannelInboundTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctxPayload: expect.objectContaining({
          Body: "/queue Can you diagnose this?",
          CommandBody: "/queue Can you diagnose this?",
          CommandTurn: expect.objectContaining({
            kind: "native",
            body: "/queue Can you diagnose this?",
          }),
        }),
      }),
    );
  });

  it("keeps one live config snapshot through native command execution", async () => {
    const startupCfg: OpenClawConfig = { session: { store: "/tmp/startup-sessions.json" } };
    const runtimeCfg: OpenClawConfig = { session: { store: "/tmp/runtime-sessions.json" } };
    const { handler } = registerAndResolveStatusHandler({ cfg: startupCfg, runtimeCfg });

    await handler(createTelegramPrivateCommandContext());

    const dispatchCall = requireRecord(
      firstMockArg(
        replyMocks.dispatchReplyWithBufferedBlockDispatcher,
        "dispatchReplyWithBufferedBlockDispatcher",
      ),
      "dispatch call",
    );
    expect(dispatchCall.cfg).toBe(runtimeCfg);
  });

  it.each([
    { blockStreamingEnabled: false, expectedDisableBlockStreaming: true },
    { blockStreamingEnabled: true, expectedDisableBlockStreaming: false },
  ])(
    "uses nested streaming.block.enabled=$blockStreamingEnabled for native command dispatch",
    async ({ blockStreamingEnabled, expectedDisableBlockStreaming }) => {
      const cfg = {
        channels: {
          telegram: {
            streaming: { block: { enabled: blockStreamingEnabled } },
          },
        },
      } satisfies OpenClawConfig;
      const { handler } = registerAndResolveStatusHandler({ cfg });

      await handler(createTelegramPrivateCommandContext());

      const dispatchCall = requireRecord(
        firstMockArg(
          replyMocks.dispatchReplyWithBufferedBlockDispatcher,
          "dispatchReplyWithBufferedBlockDispatcher",
        ),
        "dispatch call",
      );
      expect(dispatchCall.replyOptions).toMatchObject({
        disableBlockStreaming: expectedDisableBlockStreaming,
      });
    },
  );

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
      });
      await handler(createTelegramTopicCommandContext());

      const dispatchCall = (
        replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
          [
            {
              ctx?: {
                CommandTargetSessionKey?: string;
                ConversationRoutePeerId?: string;
                MessageThreadId?: number;
                OriginatingTo?: string;
                ThreadParentId?: string;
              };
            },
          ]
        >
      )[0]?.[0];
      expectRecordFields(
        dispatchCall?.ctx,
        {
          CommandTargetSessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
          ConversationRoutePeerId: "-1001234567890:topic:42",
          MessageThreadId: 42,
          OriginatingTo: "telegram:-1001234567890:topic:42",
          ThreadParentId: "-1001234567890",
        },
        "topic dispatch context",
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
    expectSendMessageCall({
      sendMessage,
      chatId: -1001234567890,
      text: "Configured ACP binding is unavailable right now. Please try again.",
      optionFields: { message_thread_id: 42 },
      label: "unavailable ACP binding",
    });
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
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });
});
