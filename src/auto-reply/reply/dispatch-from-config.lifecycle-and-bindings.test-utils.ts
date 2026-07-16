// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { AsyncResource } from "node:async_hooks";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import type { PluginTargetedInboundClaimOutcome } from "../../plugins/hooks.test-fixtures.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  internalHookMocks,
  messageAuditMocks,
  mocks,
  runtimePluginMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  stageSandboxMediaMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  type ResolveInboundConversationParams,
  dispatchReplyFromConfig,
  createReplyOperation,
  replyRunRegistry,
  admitReplyTurn,
  runWithReplyOperationLifecycleAdmission,
  setNoAbort,
  firstMockCall,
  firstMockArg,
  firstFinalReplyPayload,
  installThreadingTestPlugin,
  requireBlockReplyHandler,
  messageAuditEvents,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

  it("does not broadcast inbound claims without a core-owned plugin binding", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.runner.runInboundClaim.mockResolvedValue({ handled: true } as never);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-10099",
      To: "telegram:-10099",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      MessageThreadId: 77,
      CommandAuthorized: true,
      WasMentioned: true,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-1",
      SessionKey: "agent:main:hook-test",
    });
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: true, counts: { tool: 0, block: 0, final: 0 } });
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    const [event, hookContext] = firstMockCall(
      hookMocks.runner.runMessageReceived,
      "message received hook",
    ) as
      | [
          { content?: unknown; from?: unknown; metadata?: Record<string, unknown> },
          { accountId?: unknown; channelId?: unknown; conversationId?: unknown },
        ]
      | [];
    expect(event?.from).toBe(ctx.From);
    expect(event?.content).toBe("who are you");
    expect(event?.metadata?.messageId).toBe("msg-claim-1");
    expect(event?.metadata?.originatingChannel).toBe("telegram");
    expect(event?.metadata?.originatingTo).toBe("telegram:-10099");
    expect(event?.metadata?.senderId).toBe("user-9");
    expect(event?.metadata?.senderUsername).toBe("ada");
    expect(event?.metadata?.threadId).toBe(77);
    expect(hookContext?.channelId).toBe("telegram");
    expect(hookContext?.accountId).toBe("default");
    expect(hookContext?.conversationId).toBe("telegram:-10099");
    const internalHookEvent = (
      internalHookMocks.triggerInternalHook.mock.calls as unknown as Array<
        [{ action?: unknown; sessionKey?: unknown; type?: unknown }]
      >
    )[0]?.[0];
    expect(internalHookEvent?.type).toBe("message");
    expect(internalHookEvent?.action).toBe("received");
    expect(internalHookEvent?.sessionKey).toBe("agent:main:hook-test");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("core reply");
  });

  it("emits internal message:received hook when a session key is available", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "agent:main:main",
      CommandBody: "/help",
      MessageSid: "msg-42",
      GroupSpace: "guild-456",
      GroupChannel: "ops-room",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const createHookCall = firstMockCall(
      internalHookMocks.createInternalHookEvent,
      "internal hook event",
    ) as
      | [
          unknown,
          unknown,
          unknown,
          {
            channelId?: unknown;
            content?: unknown;
            from?: unknown;
            messageId?: unknown;
            metadata?: Record<string, unknown>;
          },
        ]
      | undefined;
    expect(createHookCall?.[0]).toBe("message");
    expect(createHookCall?.[1]).toBe("received");
    expect(createHookCall?.[2]).toBe("agent:main:main");
    expect(createHookCall?.[3]?.from).toBe(ctx.From);
    expect(createHookCall?.[3]?.content).toBe("/help");
    expect(createHookCall?.[3]?.channelId).toBe("telegram");
    expect(createHookCall?.[3]?.messageId).toBe("msg-42");
    expect(createHookCall?.[3]?.metadata?.guildId).toBe("guild-456");
    expect(createHookCall?.[3]?.metadata?.channelName).toBe("ops-room");
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("skips internal message:received hook when session key is unavailable", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandBody: "/help",
    });
    (ctx as MsgContext).SessionKey = undefined;

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("falls back to CommandTargetSessionKey for internal hook when SessionKey is empty", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "hello",
      MessageSid: "msg-99",
    });
    (ctx as MsgContext).SessionKey = undefined;
    (ctx as MsgContext).CommandTargetSessionKey = "agent:main:discord:guild:123";

    const replyResolver = async () => ({ text: "reply" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const createHookCall = firstMockCall(
      internalHookMocks.createInternalHookEvent,
      "internal hook event",
    ) as [unknown, unknown, unknown, { content?: unknown; messageId?: unknown }] | undefined;
    expect(createHookCall?.[0]).toBe("message");
    expect(createHookCall?.[1]).toBe("received");
    expect(createHookCall?.[2]).toBe("agent:main:discord:guild:123");
    expect(createHookCall?.[3]?.content).toBe("hello");
    expect(createHookCall?.[3]?.messageId).toBe("msg-99");
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("routes native-command-redirect replies using the redirect target sessionKey for outbound delivery", async () => {
    // Regression test for the native redirect session-key contract:
    // when a native command targets a different session via
    // `CommandTargetSessionKey`, the agent runtime resolves its
    // `params.sessionKey` as `CommandTargetSessionKey ?? SessionKey`
    // (see `get-reply.ts`). Routed reply delivery must mirror that so
    // `agent_end` (fired with the runtime sessionKey) and the outbound
    // `message_sending` hook (fired with `OutboundSessionContext.key`)
    // see the same canonical key. Without this alignment, plugins
    // correlating per-turn state across `agent_end` and `message_sending`
    // would receive divergent keys on every native redirect.
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      CommandSource: "native",
      SessionKey: "agent:main:slack:channel:CHAN1",
      CommandTargetSessionKey: "agent:main:telegram:direct:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        sessionKey: "agent:main:telegram:direct:999",
        policySessionKey: "agent:main:telegram:direct:999",
      }),
    );
  });

  it("routes non-native (text) command replies using the inbound sessionKey for outbound delivery", async () => {
    // Companion regression test: for non-native commands the routed
    // reply must keep the inbound `SessionKey` as both the canonical
    // session key and the policy key, even if `CommandTargetSessionKey`
    // happens to be set on the context. This guards against accidental
    // generalization of the native-redirect branch.
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      CommandSource: "text",
      SessionKey: "agent:main:slack:channel:CHAN1",
      CommandTargetSessionKey: "agent:main:telegram:direct:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        sessionKey: "agent:main:slack:channel:CHAN1",
        policySessionKey: "agent:main:slack:channel:CHAN1",
      }),
    );
  });

  it("audits completed inbound message processing", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.getQueuedCounts).mockReturnValue({ tool: 1, block: 0, final: 1 });
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "  ",
      AccountId: "acc-1",
      NativeChannelId: "  ",
      OriginatingTo: "C123",
      SenderId: "U123",
      SessionKey: "agent:main:slack:direct:C123",
      MessageSid: "msg-audit-1",
      MessageSidFull: "  ",
      ChatType: "dm",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "run-audit-1" },
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(1);
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        occurredAt: expect.any(Number),
        kind: "message",
        action: "message.inbound.processed",
        status: "succeeded",
        actorType: "channel_sender",
        actorId: "U123",
        agentId: "main",
        runId: "run-audit-1",
        direction: "inbound",
        channel: "slack",
        conversationKind: "direct",
        outcome: "completed",
        durationMs: expect.any(Number),
        resultCount: 2,
        accountId: "acc-1",
        conversationId: "C123",
        messageId: "msg-audit-1",
      }),
    );
  });

  it("uses finalized reply-dispatch counts for the inbound terminal", async () => {
    setNoAbort();
    hookMocks.runner.runReplyDispatch.mockImplementationOnce(async (_event, contextUnknown) => {
      const context = contextUnknown as {
        recordProcessed: (outcome: "completed", options: { reason: string }) => void;
      };
      context.recordProcessed("completed", { reason: "acp_dispatch" });
      return {
        handled: true,
        queuedFinal: true,
        counts: { tool: 2, block: 3, final: 4 },
      };
    });
    const dispatcher = createDispatcher();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        MessageSid: "msg-audit-routed-counts",
      }),
      cfg: emptyConfig,
      dispatcher,
    });

    expect(result.counts).toEqual({ tool: 2, block: 3, final: 4 });
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        reasonCode: "acp_dispatch_completed",
        resultCount: 9,
      }),
    );
  });

  it("correlates inbound processing with the generated agent run", async () => {
    setNoAbort();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, options) => {
        options?.onAgentRunStart?.("generated-run-audit-1");
        return { text: "hi" } satisfies ReplyPayload;
      },
    });

    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({ runId: "generated-run-audit-1" }),
    );
  });

  it("audits setup failures without replacing the dispatch error", async () => {
    setNoAbort();
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockImplementationOnce(() => {
      throw new Error("setup failed");
    });

    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          MessageSid: "msg-audit-setup-failure",
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
      }),
    ).rejects.toThrow("setup failed");

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        outcome: "failed",
        errorCode: "message_processing_failed",
        resultCount: 0,
      }),
    );
    expect(JSON.stringify(messageAuditEvents()[0])).not.toContain("setup failed");
  });

  it("skips inbound audit attribution work when no listener is registered", async () => {
    setNoAbort();
    messageAuditMocks.enabled = false;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).not.toHaveBeenCalled();
  });

  it("does not let an audit emission failure reject successful dispatch", async () => {
    setNoAbort();
    messageAuditMocks.emitTrustedMessageAuditEvent.mockImplementationOnce(() => {
      throw new Error("audit unavailable");
    });

    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
      }),
    ).resolves.toMatchObject({ counts: expect.any(Object) });
  });

  it("does not include message content or session identifiers in inbound audit events", async () => {
    setNoAbort();
    const privateBody = "private inbound body 7ca58b";
    const privateSessionKey = "agent:private:slack:direct:C999";
    const privateSenderName = "Private Sender Name 7ca58b";
    const privateSenderUsername = "private-sender-7ca58b";

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        AccountId: "acc-private",
        NativeChannelId: "C999",
        SessionKey: privateSessionKey,
        MessageSid: "msg-audit-private",
        Body: privateBody,
        BodyForAgent: privateBody,
        CommandBody: privateBody,
        RawBody: privateBody,
        SenderName: privateSenderName,
        SenderUsername: privateSenderUsername,
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(1);
    const event = messageAuditEvents()[0];
    const serializedEvent = JSON.stringify(event);
    expect(event).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        actorType: "system",
        actorId: "gateway",
      }),
    );
    expect(event).not.toHaveProperty("body");
    expect(event).not.toHaveProperty("sessionKey");
    expect(event).not.toHaveProperty("error");
    expect(serializedEvent).not.toContain(privateBody);
    expect(serializedEvent).not.toContain(privateSessionKey);
    expect(serializedEvent).not.toContain(privateSenderName);
    expect(serializedEvent).not.toContain(privateSenderUsername);
  });

  it("records the routing channel id ahead of surface and provider", async () => {
    setNoAbort();
    // SDK plugin channels may set only OriginatingChannel, and it is the id
    // outbound rows record; it must win over Surface/Provider variants.
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        OriginatingChannel: "clickclack",
        AccountId: "acc-plugin",
        MessageSid: "msg-audit-plugin-channel",
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
    });

    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(1);
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        channel: "clickclack",
      }),
    );
  });

  it("emits diagnostics when enabled", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageDispatchStarted).toHaveBeenCalledWith({
      channel: "slack",
      sessionKey: "agent:main:main",
      source: "replyResolver",
    });
    expect(diagnosticMocks.logMessageDispatchCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        outcome: "completed",
        sessionKey: "agent:main:main",
        source: "replyResolver",
      }),
    );
    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
    const processedEvent = firstMockArg(
      diagnosticMocks.logMessageProcessed,
      "message processed",
    ) as { channel?: unknown; outcome?: unknown; sessionKey?: unknown } | undefined;
    expect(processedEvent?.channel).toBe("slack");
    expect(processedEvent?.outcome).toBe("completed");
    expect(processedEvent?.sessionKey).toBe("agent:main:main");
  });

  it("carries the session store UUID on interactive diagnostic events", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "test-uuid-1234",
    };
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-uuid-1234",
        sessionKey: "agent:main:main",
      }),
    );
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionId: "test-uuid-1234",
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
  });

  it("does not stamp a command target's UUID under the source session key", async () => {
    // Native command turn: runs in the source conversation but targets a
    // different session. resolveSessionStoreLookup is command-target-aware, so
    // its entry is the *target's* — while the lifecycle reports the *source*
    // key. The UUID must NOT be attached here, to avoid mis-associating a
    // session id with the wrong session key (agentweave#187).
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "target-session-uuid-9999",
    };
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      CommandSource: "native",
      SessionKey: "agent:main:source-convo",
      CommandTargetSessionKey: "agent:main:target-session",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    const queued = diagnosticMocks.logMessageQueued.mock.calls[0]?.[0] as
      | { sessionId?: unknown; sessionKey?: unknown }
      | undefined;
    expect(queued?.sessionKey).toBe("agent:main:source-convo");
    expect(queued?.sessionId).toBeUndefined();
  });

  it("marks diagnostic progress for real reply events but not reply start callbacks", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      To: "slack:C123",
    });
    const onReplyStart = vi.fn(async () => {});
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onReplyStart?.();
      await opts?.onToolResult?.({ text: "tool progress" });
      return { text: "hi" };
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: { onReplyStart },
      replyResolver,
    });

    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
    });
  });

  it("forwards non-answer progress callbacks when source replies are suppressed", async () => {
    setNoAbort();
    const cfg = {
      diagnostics: { enabled: true },
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "channel",
      SessionKey: "agent:main:discord:channel:C1",
      To: "discord:channel:C1",
    });
    const callbacks = {
      toolStart: vi.fn(async () => {}),
      itemEvent: vi.fn(async () => {}),
      commandOutput: vi.fn(async () => {}),
    };
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onToolStart?.({ name: "lookup" });
      await opts?.onItemEvent?.({ progressText: "working" });
      await opts?.onCommandOutput?.({ output: "line", status: "running" });
      return { text: "hi" };
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart: callbacks.toolStart,
        onItemEvent: callbacks.itemEvent,
        onCommandOutput: callbacks.commandOutput,
      },
      replyResolver,
    });

    expect(callbacks.toolStart).toHaveBeenCalledTimes(1);
    expect(callbacks.itemEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.commandOutput).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledTimes(3);
    expect(diagnosticMocks.markDiagnosticSessionProgress).toHaveBeenCalledWith({
      sessionKey: "agent:main:discord:channel:C1",
    });
  });

  it("routes plugin-owned bindings to the owning plugin before generic inbound claim broadcast", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-1",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      To: "discord:channel:1481858418548412579",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      OwnerAllowFrom: ["user-9"],
      GatewayClientScopes: ["operator.write"],
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-1",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-1");
    const inboundClaimCall = hookMocks.runner.runInboundClaimForPluginOutcome.mock
      .calls[0] as unknown as
      | [
          unknown,
          {
            accountId?: unknown;
            channel?: unknown;
            content?: unknown;
            conversationId?: unknown;
            senderIsOwner?: unknown;
          },
          {
            accountId?: unknown;
            channelId?: unknown;
            conversationId?: unknown;
            pluginBinding?: { data?: Record<string, unknown> };
          },
        ]
      | undefined;
    expect(inboundClaimCall?.[0]).toBe("openclaw-codex-app-server");
    expect(inboundClaimCall?.[1]?.channel).toBe("discord");
    expect(inboundClaimCall?.[1]?.accountId).toBe("default");
    expect(inboundClaimCall?.[1]?.conversationId).toBe("channel:1481858418548412579");
    expect(inboundClaimCall?.[1]?.content).toBe("who are you");
    // Context OwnerAllowFrom authorizes commands but no longer grants owner status;
    // only commands.ownerAllowFrom or operator.admin does (operator.write here does not).
    expect(inboundClaimCall?.[1]?.senderIsOwner).toBe(false);
    expect(inboundClaimCall?.[1]).not.toHaveProperty("gatewayClientScopes");
    expect(inboundClaimCall?.[2]?.channelId).toBe("discord");
    expect(inboundClaimCall?.[2]?.accountId).toBe("default");
    expect(inboundClaimCall?.[2]?.conversationId).toBe("channel:1481858418548412579");
    expect(inboundClaimCall?.[2]?.pluginBinding?.data?.kind).toBe("codex-app-server-session");
    expect(inboundClaimCall?.[2]?.pluginBinding?.data?.sessionFile).toBe("/tmp/session.jsonl");
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("holds session lifecycle mutation until an interrupted plugin claim exits", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "test-plugin", status: "loaded" }];
    let resolveClaim: ((outcome: PluginTargetedInboundClaimOutcome) => void) | undefined;
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async () =>
        await new Promise<PluginTargetedInboundClaimOutcome>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-lifecycle-race",
      targetSessionKey: "plugin-binding:test:race",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:lifecycle-race",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "test-plugin",
        pluginRoot: "/tmp/test-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:lifecycle-race";
    const sessionId = "plugin-lifecycle-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const dispatcher = createDispatcher();
    const externalLifecycleRequest = new AsyncResource("external-lifecycle-request");
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      To: "discord:channel:lifecycle-race",
      AccountId: "default",
      SessionKey: sessionKey,
      Body: "hold this claim",
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    await vi.waitFor(() => {
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledOnce();
    });
    expect(replyRunRegistry.get(sessionKey)).toBeDefined();
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      true,
    );

    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    await vi.waitFor(() => {
      expect(replyRunRegistry.get(sessionKey)?.abortSignal.aborted).toBe(true);
    });
    expect(mutationRan).toBe(false);

    resolveClaim?.({
      status: "handled",
      result: { handled: true, reply: { text: "stale plugin reply" } },
    });
    const result = await dispatch;
    await mutation;

    expect(mutationRan).toBe(true);
    expect(result.queuedFinal).toBe(false);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    externalLifecycleRequest.emitDestroy();
  });

  it("holds an owned lifecycle lease until abort-insensitive resolver work settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:discord:channel:owned-resolver-race";
    const sessionId = "owned-resolver-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    let releaseResolver: () => void = () => {};
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let signalResolverEntered: () => void = () => {};
    const resolverEntered = new Promise<void>((resolve) => {
      signalResolverEntered = resolve;
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      signalResolverEntered();
      await resolverGate;
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
      return { text: "stale late final" } satisfies ReplyPayload;
    });
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        To: "discord:channel:owned-resolver-race",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "hold this resolver",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await resolverEntered;

    const externalLifecycleRequest = new AsyncResource("external-owned-resolver-lifecycle");
    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );

    try {
      const result = await dispatch;
      expect(result.queuedFinal).toBe(false);
      expect(mutationRan).toBe(false);
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        true,
      );

      releaseResolver();
      await mutation;

      expect(mutationRan).toBe(true);
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    } finally {
      releaseResolver();
      await mutation;
      externalLifecycleRequest.emitDestroy();
    }
  });

  it("holds a lifecycle lease for plugin claims behind an active reply operation", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "test-plugin", status: "loaded" }];
    let resolveClaim: ((outcome: PluginTargetedInboundClaimOutcome) => void) | undefined;
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async () =>
        await new Promise<PluginTargetedInboundClaimOutcome>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-active-lifecycle-race",
      targetSessionKey: "plugin-binding:test:active-race",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:active-lifecycle-race",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "test-plugin",
        pluginRoot: "/tmp/test-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:active-lifecycle-race";
    const sessionId = "plugin-active-lifecycle-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const existingOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    const dispatcher = createDispatcher();
    const externalLifecycleRequest = new AsyncResource("external-active-lifecycle-request");
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      To: "discord:channel:active-lifecycle-race",
      AccountId: "default",
      SessionKey: sessionKey,
      Body: "hold this overlapping claim",
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    await vi.waitFor(() => {
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledOnce();
    });
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      true,
    );

    existingOperation.complete();
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();

    let mutationPrepared = false;
    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            mutationPrepared = true;
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    await vi.waitFor(() => {
      expect(mutationPrepared).toBe(true);
    });
    expect(mutationRan).toBe(false);

    resolveClaim?.({
      status: "handled",
      result: { handled: true, reply: { text: "stale plugin reply" } },
    });
    const result = await dispatch;
    await mutation;

    expect(mutationRan).toBe(true);
    expect(result.queuedFinal).toBe(false);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    externalLifecycleRequest.emitDestroy();
  });

  it("does not abort the active owner when its in-band mutation interrupts borrowed work", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "test-plugin", status: "loaded" }];
    let resolveClaim: ((outcome: PluginTargetedInboundClaimOutcome) => void) | undefined;
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async () =>
        await new Promise<PluginTargetedInboundClaimOutcome>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-owner-mutation-race",
      targetSessionKey: "plugin-binding:test:owner-mutation-race",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:owner-mutation-race",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "test-plugin",
        pluginRoot: "/tmp/test-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:owner-mutation-race";
    const sessionId = "owner-mutation-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const ownerAdmission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath: "/tmp/mock-sessions.json",
      kind: "visible",
      resetTriggered: false,
    });
    expect(ownerAdmission.status).toBe("owned");
    if (ownerAdmission.status !== "owned") {
      throw new Error("expected active owner admission");
    }
    const ownerOperation = ownerAdmission.operation;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        To: "discord:channel:owner-mutation-race",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "borrow the active lane",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await vi.waitFor(() => {
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledOnce();
    });

    let mutationRan = false;
    const mutation = runWithReplyOperationLifecycleAdmission(ownerOperation, async () =>
      runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        prepare: async () => {
          await interruptSessionWorkAdmissions({
            scope: "/tmp/mock-sessions.json",
            identities: [sessionKey, sessionId],
          });
        },
        run: async () => {
          mutationRan = true;
        },
      }),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(ownerOperation.abortSignal.aborted).toBe(false);
    expect(mutationRan).toBe(false);

    resolveClaim?.({ status: "handled", result: { handled: true } });
    const result = await dispatch;
    await mutation;

    expect(result.queuedFinal).toBe(false);
    expect(ownerOperation.abortSignal.aborted).toBe(false);
    expect(ownerOperation.result).toBeNull();
    expect(replyRunRegistry.get(sessionKey)).toBe(ownerOperation);
    expect(mutationRan).toBe(true);
    expect(replyResolver).not.toHaveBeenCalled();
    ownerOperation.complete();
  });

  it("completes an owned reply operation interrupted during a plugin fallback notice", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "missing_plugin",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-interrupted-fallback",
      targetSessionKey: "plugin-binding:test:interrupted-fallback",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:interrupted-fallback",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "missing-plugin",
        pluginRoot: "/tmp/missing-plugin",
      },
    } satisfies SessionBindingRecord);
    const sessionKey = "agent:main:discord:channel:interrupted-fallback";
    const sessionId = "interrupted-fallback-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    let resolveNotice: ((result: { ok: true; messageId: string }) => void) | undefined;
    mocks.routeReply.mockImplementationOnce(
      async () =>
        await new Promise<{ ok: true; messageId: string }>((resolve) => {
          resolveNotice = resolve;
        }),
    );
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:interrupted-fallback",
        To: "discord:channel:interrupted-fallback",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "fall back",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await vi.waitFor(() => {
      expect(mocks.routeReply).toHaveBeenCalledOnce();
    });
    const operation = replyRunRegistry.get(sessionKey);
    expect(operation).toBeDefined();

    let mutationRan = false;
    const externalLifecycleRequest = new AsyncResource("interrupted-fallback-lifecycle");
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    await vi.waitFor(() => {
      expect(operation?.abortSignal.aborted).toBe(true);
    });
    expect(mutationRan).toBe(false);

    resolveNotice?.({ ok: true, messageId: "fallback-notice" });
    const result = await dispatch;
    await mutation;

    expect(result.queuedFinal).toBe(false);
    expect(operation?.result).toMatchObject({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
    expect(mutationRan).toBe(true);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_aborted",
      }),
    );
    expect(messageAuditEvents()[0]).not.toHaveProperty("errorCode");
    externalLifecycleRequest.emitDestroy();
  });

  it("stages remote iMessage media before plugin-bound inbound claim metadata reaches Codex", async () => {
    setNoAbort();
    const order: string[] = [];
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const stagedPath =
      "/tmp/openclaw-proof/.openclaw/media/remote-cache/agent-main-imessage/photo.jpg";
    stageSandboxMediaMocks.stageSandboxMedia.mockImplementationOnce(async (paramsUnknown) => {
      order.push("stage");
      const params = paramsUnknown as {
        ctx: MsgContext;
        sessionCtx: MsgContext;
        sessionKey?: string;
        workspaceDir?: string;
        remoteMediaMode?: string;
      };
      expect(params.sessionKey).toBe("agent:main:imessage:direct:user");
      expect(params.workspaceDir).toContain(".openclaw/workspace");
      expect(params.remoteMediaMode).toBe("cache");
      params.ctx.MediaPath = stagedPath;
      params.ctx.MediaPaths = [stagedPath];
      params.ctx.MediaUrl = stagedPath;
      params.ctx.MediaUrls = [stagedPath];
      params.sessionCtx.MediaPath = stagedPath;
      params.sessionCtx.MediaPaths = [stagedPath];
      params.sessionCtx.MediaUrl = stagedPath;
      params.sessionCtx.MediaUrls = [stagedPath];
      return { staged: new Map([[rawPath, stagedPath]]) };
    });
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockImplementationOnce(
      async (_plugin, event) => {
        order.push("claim");
        const claimEvent = event as { metadata?: Record<string, unknown> };
        expect(claimEvent.metadata?.mediaPath).toBe(stagedPath);
        expect(claimEvent.metadata?.mediaPaths).toEqual([stagedPath]);
        expect(claimEvent.metadata?.mediaUrl).toBe(stagedPath);
        expect(claimEvent.metadata?.mediaUrls).toEqual([stagedPath]);
        expect(claimEvent.metadata?.mediaPath).not.toBe(rawPath);
        expect(claimEvent.metadata?.mediaPaths).not.toContain(rawPath);
        return { status: "handled", result: { handled: true } };
      },
    );
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-imessage-codex-media",
      targetSessionKey: "plugin-binding:codex:imessage",
      targetKind: "session",
      conversation: {
        channel: "imessage",
        accountId: "default",
        conversationId: "chat:abc",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/openclaw-codex-app-server",
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:abc",
      To: "imessage:chat:abc",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "what is this?",
      RawBody: "what is this?",
      Body: "what is this?",
      MessageSid: "msg-claim-imessage-media",
      SessionKey: "agent:main:imessage:direct:user",
      MediaPath: rawPath,
      MediaPaths: [rawPath],
      MediaUrl: rawPath,
      MediaUrls: [rawPath],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
      MediaRemoteHost: "user@gateway-host",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(order).toEqual(["stage", "claim"]);
    expect(ctx.MediaStaged).not.toBe(true);
    expect(ctx.MediaPath).toBe(rawPath);
    expect(ctx.MediaPaths).toEqual([rawPath]);
    expect(stageSandboxMediaMocks.stageSandboxMedia).toHaveBeenCalledTimes(1);
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-imessage-codex-media");
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("leaves ordinary non-plugin remote iMessage media for get-reply staging", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "reply_dispatch") as () => boolean,
    );
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:ordinary",
      To: "imessage:chat:ordinary",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "what is this?",
      RawBody: "what is this?",
      Body: "what is this?",
      MessageSid: "msg-ordinary-imessage-media",
      SessionKey: "agent:main:imessage:direct:user",
      MediaPath: rawPath,
      MediaPaths: [rawPath],
      MediaUrl: rawPath,
      MediaUrls: [rawPath],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
      MediaRemoteHost: "user@gateway-host",
    });
    const replyResolver = vi.fn(async (receivedCtx: MsgContext) => {
      expect(receivedCtx.MediaStaged).not.toBe(true);
      expect(receivedCtx.MediaPath).toBe(rawPath);
      expect(receivedCtx.MediaPaths).toEqual([rawPath]);
      return { text: "agent reply" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(stageSandboxMediaMocks.stageSandboxMedia).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(ctx.MediaStaged).not.toBe(true);
    expect(ctx.MediaPath).toBe(rawPath);
    expect(ctx.MediaPaths).toEqual([rawPath]);
  });

  it("does not cache-stage remote iMessage media for message_received-only hooks", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "message_received") as () => boolean,
    );
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:ordinary-hook",
      To: "imessage:chat:ordinary-hook",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "what is this?",
      RawBody: "what is this?",
      Body: "what is this?",
      MessageSid: "msg-ordinary-imessage-hook-media",
      SessionKey: "agent:main:imessage:direct:user",
      MediaPath: rawPath,
      MediaPaths: [rawPath],
      MediaUrl: rawPath,
      MediaUrls: [rawPath],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
      MediaRemoteHost: "user@gateway-host",
    });
    const replyResolver = vi.fn(async (receivedCtx: MsgContext) => {
      expect(receivedCtx.MediaStaged).not.toBe(true);
      expect(receivedCtx.MediaPath).toBe(rawPath);
      expect(receivedCtx.MediaPaths).toEqual([rawPath]);
      return { text: "agent reply" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const [event] = firstMockCall(hookMocks.runner.runMessageReceived, "message received hook") as
      | [{ metadata?: Record<string, unknown> }]
      | [];
    expect(event?.metadata?.mediaPath).toBeUndefined();
    expect(event?.metadata?.mediaPaths).toBeUndefined();
    expect(event?.metadata?.mediaUrl).toBeUndefined();
    expect(event?.metadata?.mediaUrls).toBeUndefined();
    expect(event?.metadata?.mediaStagingPending).toBe(true);
    expect(event?.metadata?.mediaRemoteHost).toBe("user@gateway-host");
    expect(event?.metadata?.originalMediaPath).toBe(rawPath);
    expect(event?.metadata?.originalMediaPaths).toEqual([rawPath]);
    expect(event?.metadata?.originalMediaUrl).toBe(rawPath);
    expect(event?.metadata?.originalMediaUrls).toEqual([rawPath]);
    expect(event?.metadata?.originalMediaType).toBe("image/jpeg");
    expect(event?.metadata?.originalMediaTypes).toEqual(["image/jpeg"]);
    const internalHookCall = firstMockCall(
      internalHookMocks.createInternalHookEvent,
      "internal hook event",
    ) as
      | [
          unknown,
          unknown,
          unknown,
          {
            metadata?: Record<string, unknown>;
          },
        ]
      | undefined;
    expect(internalHookCall?.[3]?.metadata?.mediaStagingPending).toBe(true);
    expect(internalHookCall?.[3]?.metadata?.mediaRemoteHost).toBe("user@gateway-host");
    expect(internalHookCall?.[3]?.metadata?.originalMediaPath).toBe(rawPath);
    expect(internalHookCall?.[3]?.metadata?.originalMediaPaths).toEqual([rawPath]);
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(stageSandboxMediaMocks.stageSandboxMedia).not.toHaveBeenCalled();
    expect(ctx.MediaStaged).not.toBe(true);
    expect(ctx.MediaPath).toBe(rawPath);
    expect(ctx.MediaPaths).toEqual([rawPath]);
  });

  it("routes Discord thread plugin-owned bindings by raw thread id", async () => {
    setNoAbort();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "discord" }),
            messaging: {
              resolveInboundConversation: ({
                to,
                conversationId,
                threadId,
                threadParentId,
              }: ResolveInboundConversationParams) =>
                threadId
                  ? {
                      conversationId: String(threadId),
                      ...(threadParentId
                        ? { parentConversationId: `channel:${threadParentId}` }
                        : {}),
                    }
                  : { conversationId: to ?? conversationId },
            },
          },
        },
      ]),
    );
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockImplementation(
      (ref: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
      }) =>
        ref.channel === "discord" &&
        ref.accountId === "default" &&
        ref.conversationId === "1510164477642014740"
          ? ({
              bindingId: "binding-discord-thread",
              targetSessionKey: "plugin-binding:codex:thread",
              targetKind: "session",
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: "1510164477642014740",
                parentConversationId: "channel:1510164477642014999",
              },
              status: "active",
              boundAt: 1710000000000,
              metadata: {
                pluginBindingOwner: "plugin",
                pluginId: "openclaw-codex-app-server",
                pluginRoot: "/plugins/openclaw-codex-app-server",
              },
            } satisfies SessionBindingRecord)
          : null,
    );
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:1510164477642014740",
      To: "channel:1510164477642014740",
      AccountId: "default",
      SenderId: "user-9",
      CommandAuthorized: true,
      WasMentioned: false,
      RawBody: "continue",
      Body: "continue",
      MessageSid: "msg-claim-discord-thread",
      MessageThreadId: "1510164477642014740",
      ThreadParentId: "1510164477642014999",
      SessionKey: "agent:main:discord:channel:1510164477642014740",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        conversationId: "1510164477642014740",
        parentConversationId: "channel:1510164477642014999",
      }),
    );
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({
        channel: "discord",
        conversationId: "1510164477642014740",
        parentConversationId: "channel:1510164477642014999",
      }),
      expect.objectContaining({
        conversationId: "1510164477642014740",
        parentConversationId: "channel:1510164477642014999",
        pluginBinding: expect.objectContaining({ bindingId: "binding-discord-thread" }),
      }),
    );
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("does not run plugin-owned binding delivery when the caller already aborted", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "should not send" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-aborted-1",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/workspace/openclaw-app-server",
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
      },
    } satisfies SessionBindingRecord);
    const abortController = new AbortController();
    abortController.abort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      To: "discord:channel:1481858418548412579",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-aborted-1",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver,
    });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("lets authorized plugin-owned binding commands fall through to command processing", async () => {
    setNoAbort();
    expect(
      registerPluginCommand(
        "codex",
        {
          name: "codex",
          description: "Control Codex app-server bindings",
          acceptsArgs: true,
          requireAuth: true,
          handler: vi.fn(async () => ({ continueAgent: true })),
        },
        { allowReservedCommandNames: true },
      ),
    ).toEqual({ ok: true });
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-command-escape-1",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex detach",
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/workspace/openclaw",
        },
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      To: "discord:channel:1481858418548412579",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandSource: "text",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "/codex detach",
      RawBody: "/codex detach",
      Body: "/codex detach",
      MessageSid: "msg-claim-plugin-command-escape",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "detached" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: true, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-command-escape-1");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("detached");
  });

  it("keeps authorized unknown slash text in a plugin-owned binding routed to the bound plugin", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-command-unknown-slash",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      To: "discord:channel:1481858418548412579",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandSource: "text",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "/notes keep this with the bound plugin",
      RawBody: "/notes keep this with the bound plugin",
      Body: "/notes keep this with the bound plugin",
      MessageSid: "msg-claim-plugin-command-unknown-slash",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-command-unknown-slash");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({ content: "/notes keep this with the bound plugin" }),
      expect.objectContaining({
        pluginBinding: expect.objectContaining({ bindingId: "binding-command-unknown-slash" }),
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
