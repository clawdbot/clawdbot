// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  globalMocks,
  hookMocks,
  mocks,
  sessionBindingMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  setNoAbort,
  firstMockCall,
  firstRouteReplyCall,
  installThreadingTestPlugin,
  requireToolResultHandler,
  requireBlockReplyHandler,
  globalBeforeAll0,
  createHookCtx,
  describe1BeforeEach0,
  describe2BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "./provider-request-error-classifier.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("before_dispatch hook", () => {
  beforeEach(describe1BeforeEach0);

  it("skips model dispatch when hook returns handled", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Blocked" });
    expect(result.queuedFinal).toBe(true);
  });

  it("silently short-circuits when hook returns handled without text", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
    });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("uses canonical hook metadata and shared routed final delivery", async () => {
    ttsMocks.state.synthesizeFinalAudio = true;
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    installThreadingTestPlugin({ id: "telegram" });
    const dispatcher = createDispatcher();
    const ctx = createHookCtx({
      Body: "raw body",
      BodyForAgent: "agent body",
      BodyForCommands: "command body",
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      From: "signal:group:ops-room",
      SenderId: "signal:user:alice",
      GroupChannel: "ops-room",
      ChatType: "direct",
      Timestamp: 123,
    });

    const result = await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher });

    const beforeDispatchCall = firstMockCall(
      hookMocks.runner.runBeforeDispatch,
      "before dispatch hook",
    ) as
      | [
          {
            body?: unknown;
            channel?: unknown;
            content?: unknown;
            isGroup?: unknown;
            senderId?: unknown;
            timestamp?: unknown;
          },
          { channelId?: unknown; senderId?: unknown },
        ]
      | undefined;
    expect(beforeDispatchCall?.[0]?.content).toBe("command body");
    expect(beforeDispatchCall?.[0]?.body).toBe("agent body");
    expect(beforeDispatchCall?.[0]?.channel).toBe("telegram");
    expect(beforeDispatchCall?.[0]?.senderId).toBe("signal:user:alice");
    expect(beforeDispatchCall?.[0]?.isGroup).toBe(true);
    expect(beforeDispatchCall?.[0]?.timestamp).toBe(123);
    expect(beforeDispatchCall?.[1]?.channelId).toBe("telegram");
    expect(beforeDispatchCall?.[1]?.senderId).toBe("signal:user:alice");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | { channel?: unknown; payload?: ReplyPayload; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.payload?.text).toBe("Blocked");
    expect(routeCall?.payload?.mediaUrl).toBe("https://example.com/tts-synth.opus");
    expect(routeCall?.payload?.audioAsVoice).toBe(true);
    expect(result.queuedFinal).toBe(true);
  });

  it("passes inbound reply metadata to before_dispatch event and context", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    const dispatcher = createDispatcher();
    const ctx = createHookCtx({
      ReplyToId: "discord-reply-123",
      ReplyToIdFull: "discord:channel-1:discord-reply-123",
      ReplyToBody: "the quoted parent message",
      ReplyToSender: "Ada",
      ReplyToIsQuote: true,
    });

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher });

    const beforeDispatchCall = firstMockCall(
      hookMocks.runner.runBeforeDispatch,
      "before dispatch hook",
    ) as
      | [
          {
            replyToId?: unknown;
            replyToIdFull?: unknown;
            replyToBody?: unknown;
            replyToSender?: unknown;
            replyToIsQuote?: unknown;
          },
          {
            replyToId?: unknown;
            replyToIdFull?: unknown;
            replyToBody?: unknown;
            replyToSender?: unknown;
            replyToIsQuote?: unknown;
          },
        ]
      | undefined;
    expect(beforeDispatchCall?.[0]).toMatchObject({
      replyToId: "discord-reply-123",
      replyToIdFull: "discord:channel-1:discord-reply-123",
      replyToBody: "the quoted parent message",
      replyToSender: "Ada",
      replyToIsQuote: true,
    });
    expect(beforeDispatchCall?.[1]).toMatchObject({
      replyToId: "discord-reply-123",
      replyToIdFull: "discord:channel-1:discord-reply-123",
      replyToBody: "the quoted parent message",
      replyToSender: "Ada",
      replyToIsQuote: true,
    });
  });

  it("suppresses before_dispatch handled reply when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx({ SessionKey: "test:session" }),
      cfg: emptyConfig,
      dispatcher,
    });
    // Hook handled the message (no model dispatch)
    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalled();
    // But delivery must be suppressed
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("continues default dispatch when hook returns not handled", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: false });
    const dispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "model reply" }),
    });
    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "model reply" });
  });
});

describe("sendPolicy deny — suppress delivery, not processing (#53328)", () => {
  beforeEach(describe2BeforeEach0);

  it("still calls the replyResolver when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      return { text: "agent reply" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // The agent MUST process the message (replyResolver called)
    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("passes suppressUserDelivery to tail reply_dispatch when sendPolicy is deny", async () => {
    setNoAbort();
    diagnosticMocks.logMessageDispatchStarted.mockClear();
    diagnosticMocks.logMessageDispatchCompleted.mockClear();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown) => {
      const candidate = event as { isTailDispatch?: boolean };
      if (candidate.isTailDispatch) {
        return {
          handled: true,
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      }
      return undefined;
    });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      SessionKey: "test:session",
      AcpDispatchTailAfterReset: true,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: { diagnostics: { enabled: true } } as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "agent reply" }),
    });

    const tailDispatchCall = hookMocks.runner.runReplyDispatch.mock.calls.find(
      ([event]) => (event as { isTailDispatch?: boolean }).isTailDispatch === true,
    );
    const tailDispatchEvent = tailDispatchCall?.[0] as
      | {
          isTailDispatch?: unknown;
          sendPolicy?: unknown;
          suppressReplyLifecycle?: unknown;
          suppressUserDelivery?: unknown;
        }
      | undefined;
    expect(tailDispatchEvent?.isTailDispatch).toBe(true);
    expect(tailDispatchEvent?.sendPolicy).toBe("deny");
    expect(tailDispatchEvent?.suppressUserDelivery).toBe(true);
    expect(tailDispatchEvent?.suppressReplyLifecycle).toBe(true);
    if (tailDispatchCall?.[1] === undefined) {
      throw new Error("Expected tail dispatch metadata");
    }
    expect(diagnosticMocks.logMessageDispatchStarted).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logMessageDispatchCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        sessionKey: "test:session",
        source: "replyResolver",
      }),
    );
  });

  it("suppresses final reply delivery when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // Delivery MUST be suppressed
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    expect(result.sendPolicyDenied).toBe(true);
  });

  it("keeps the suppressed reply log preview UTF-16 safe", async () => {
    setNoAbort();
    globalMocks.logVerbose.mockClear();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const text = `${"y".repeat(159)}🚀`;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text }),
    });

    const suppressedLog = globalMocks.logVerbose.mock.calls.find(([message]) =>
      message.includes("final reply suppressed"),
    )?.[0];
    expect(suppressedLog).toContain("textChars=161");
    expect(suppressedLog).toContain(`textPreview=${JSON.stringify("y".repeat(159))}`);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("does not mark allowed group silence eligible for no-visible fallback", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "feishu",
      Provider: "feishu",
      SessionKey: "agent:main:feishu:group:oc_group",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  });

  it("marks disallowed group silence eligible for no-visible fallback", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "feishu",
      Provider: "feishu",
      SessionKey: "agent:main:feishu:group:oc_group",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "disallow",
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      noVisibleReplyFallbackEligible: true,
    });
  });

  it("suppresses tool result delivery when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    let capturedOnToolResult: ((payload: ReplyPayload) => Promise<void>) | undefined;
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions, _cfg?: OpenClawConfig) => {
        capturedOnToolResult = opts?.onToolResult as
          | ((payload: ReplyPayload) => Promise<void>)
          | undefined;
        return { text: "reply" } satisfies ReplyPayload;
      },
    );
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // Trigger a tool result — delivery should be suppressed
    await requireToolResultHandler(capturedOnToolResult)({ text: "tool output" });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("suppresses block reply delivery when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    let capturedOnBlockReply:
      | ((payload: ReplyPayload, context?: unknown) => Promise<void>)
      | undefined;
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions, _cfg?: OpenClawConfig) => {
        capturedOnBlockReply = opts?.onBlockReply as
          | ((payload: ReplyPayload, context?: unknown) => Promise<void>)
          | undefined;
        return [] as ReplyPayload[];
      },
    );
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    // Trigger a block reply — delivery should be suppressed
    await requireBlockReplyHandler(capturedOnBlockReply)({ text: "streaming chunk" });
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("delivers replies normally when sendPolicy is allow", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers provider conversation-state runner payloads as outbound channel replies", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const exactProviderError = "Custom tool call output is missing for call id: call_live_123.";
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (receivedCtx: MsgContext) => {
      expect(receivedCtx.Body).toBe(exactProviderError);
      return {
        text: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
      } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:provider-error",
      To: "discord:channel:provider-error",
      AccountId: "default",
      SessionKey: "agent:main:discord:channel:provider-error",
      Body: exactProviderError,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
    });
  });

  it("delivers replies normally when sendPolicy is unset (defaults to allow)", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses the fast-abort reply under sendPolicy deny", async () => {
    // Fast-abort runs before sendPolicy in the old code, so the abort reply
    // leaked. Under the guard, the abort is still recorded but no reply is
    // dispatched. See #53328.
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
      SessionKey: "test:session",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("delivers the fast-abort reply normally when sendPolicy is allow (regression guard)", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "hi" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
      SessionKey: "test:session",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("rejects archived plugin-bound work before the plugin handler runs", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "must not send" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-archived",
      targetSessionKey: "plugin-binding:codex:archived",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:archived-test",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      archivedAt: Date.now(),
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      To: "discord:channel:archived-test",
      AccountId: "default",
      SessionKey: "agent:main:discord:channel:archived-test",
      Body: "start work",
    });

    await expect(
      dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver }),
    ).rejects.toThrow(/is archived/i);

    expect(sessionBindingMocks.touch).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("skips plugin-bound claim hook under deny and falls through to suppressed agent dispatch", async () => {
    // Plugin-bound inbound handlers can emit outbound replies we cannot
    // rewind. Under deny, skip the plugin claim entirely and let the agent
    // process the message with delivery suppressed. See #53328.
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
      bindingId: "binding-deny",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:deny-test",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:deny-test",
      To: "discord:channel:deny-test",
      AccountId: "default",
      SessionKey: "agent:main:discord:channel:deny-test",
      Body: "observed message",
    });

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    // Binding is still tracked (touch runs before the gate)...
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-deny");
    // ...but the plugin claim hook MUST NOT be invoked under deny — the
    // plugin can't be trusted to honor suppressDelivery on its outbound path.
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    // Agent still processes the message (the whole point of the PR)...
    expect(replyResolver).toHaveBeenCalledTimes(1);
    // ...but no final reply is delivered.
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "handled without a plugin reply",
      bindingId: "binding-message-tool-only",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
      },
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1001234567890",
        To: "telegram:-1001234567890",
        AccountId: "default",
        MessageThreadId: 11,
        ChatType: "group",
        GroupSubject: "Dev",
        Body: "observed message",
      },
      cfg: emptyConfig,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only" as const,
      },
      expectedClaim: { channel: "telegram", threadId: 11 },
    },
    {
      name: "handled with a plugin reply",
      bindingId: "binding-message-tool-reply",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:reply-test",
      },
      ctx: {
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:reply-test",
        To: "discord:channel:reply-test",
        AccountId: "default",
        ChatType: "channel",
        Body: "observed message",
        SessionKey: "agent:main:discord:channel:reply-test",
      },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
      } as OpenClawConfig,
      expectedClaim: { channel: "discord" },
      pluginReply: { text: "Codex native reply" },
      expectPluginReplyDelivered: true,
    },
    {
      name: "suppresses ambient room_event plugin reply",
      bindingId: "binding-message-tool-room-event",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:room-event-test",
      },
      ctx: {
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:room-event-test",
        To: "discord:channel:room-event-test",
        AccountId: "default",
        ChatType: "group",
        InboundEventKind: "room_event",
        Body: "observed message",
        SessionKey: "agent:main:discord:channel:room-event-test",
      },
      cfg: emptyConfig,
      expectedClaim: { channel: "discord" },
      pluginReply: { text: "Codex ambient room event reply" },
      expectPluginReplyDelivered: false,
    },
  ] satisfies Array<{
    name: string;
    bindingId: string;
    conversation: SessionBindingRecord["conversation"];
    ctx: Partial<MsgContext>;
    cfg: OpenClawConfig;
    replyOptions?: { sourceReplyDeliveryMode: "message_tool_only" };
    expectedClaim: Record<string, unknown>;
    pluginReply?: ReplyPayload;
    expectPluginReplyDelivered?: boolean;
  }>)(
    "routes plugin-owned bindings under message-tool-only source delivery: $name",
    async (params) => {
      setNoAbort();
      hookMocks.runner.hasHooks.mockImplementation(
        ((hookName?: string) =>
          hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
      );
      hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
      hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
        status: "handled",
        result: params.pluginReply
          ? { handled: true, reply: params.pluginReply }
          : { handled: true },
      });
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: params.bindingId,
        targetSessionKey: "plugin-binding:codex:abc123",
        targetKind: "session",
        conversation: params.conversation,
        status: "active",
        boundAt: 1710000000000,
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/tmp/plugin",
        },
      } satisfies SessionBindingRecord);
      sessionStoreMocks.currentEntry = {
        sessionId: "s1",
        updatedAt: 0,
        sendPolicy: "allow",
      };
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);

      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx(params.ctx),
        cfg: params.cfg,
        dispatcher,
        replyResolver,
        replyOptions: params.replyOptions,
      });

      expect(result).toEqual({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(sessionBindingMocks.touch).toHaveBeenCalledWith(params.bindingId);
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
        "openclaw-codex-app-server",
        expect.objectContaining({
          content: "observed message",
          ...params.expectedClaim,
        }),
        expect.objectContaining({
          pluginBinding: expect.objectContaining({ bindingId: params.bindingId }),
        }),
      );
      expect(replyResolver).not.toHaveBeenCalled();
      if (params.expectPluginReplyDelivered) {
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(params.pluginReply);
      } else {
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps unmentioned plugin-bound fallback from ordinary group agent dispatch", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-message-tool-fallback",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "observed message",
      WasMentioned: false,
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "telegram",
      content: "observed message",
      threadId: 11,
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({
      bindingId: "binding-message-tool-fallback",
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "dispatches unmentioned plugin-bound fallback in always-on groups",
      groupRequireMention: false,
      expectedDispatches: 1,
    },
    {
      name: "suppresses unmentioned fallback when channel policy requires a mention",
      groupRequireMention: true,
      expectedDispatches: 0,
    },
  ])("$name", async ({ groupRequireMention, expectedDispatches }) => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    installThreadingTestPlugin({ id: "imessage" });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-imessage-always-on-fallback",
      targetSessionKey: "plugin-binding:codex:imessage",
      targetKind: "session",
      conversation: {
        channel: "imessage",
        accountId: "default",
        conversationId: "chat:primary",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "agent reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "imessage",
      Surface: "imessage",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:chat:primary",
      To: "imessage:chat:primary",
      AccountId: "default",
      SessionKey: "agent:main:imessage:group:chat:primary",
      ChatType: "group",
      GroupSubject: "Friends",
      GroupRequireMention: groupRequireMention,
      Body: "observed message",
      From: "imessage:group:chat:primary",
      WasMentioned: false,
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "imessage",
      content: "observed message",
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({
      bindingId: "binding-imessage-always-on-fallback",
    });
    expect(replyResolver).toHaveBeenCalledTimes(expectedDispatches);
    expect(result.queuedFinal).toBe(false);
    expect(result.counts.block).toBe(0);
    expect(result.counts.final).toBe(0);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("lets authorized control commands without CommandSource escape plugin-bound fallback", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-message-tool-command",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const cfg = { messages: { visibleReplies: "message_tool" } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "reset ack" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "/reset@openclaw",
      RawBody: "/reset@openclaw",
      CommandBody: "/reset@openclaw",
      BotUsername: "openclaw",
      CommandSource: undefined,
      CommandAuthorized: true,
      WasMentioned: false,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
    });

    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "reset ack" });
  });

  it("keeps unauthorized native commands on the plugin-bound claim path", async () => {
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
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-native-unauthorized",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "/status",
      RawBody: "/status",
      CommandBody: "/status",
      CommandSource: "native",
      CommandAuthorized: false,
      WasMentioned: false,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "telegram",
      content: "/status",
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({ bindingId: "binding-native-unauthorized" });
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("keeps structured normal command turns on the plugin-bound claim path", async () => {
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
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-structured-normal-turn",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:11",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/tmp/plugin",
      },
    } satisfies SessionBindingRecord);
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      To: "telegram:-1001234567890",
      AccountId: "default",
      MessageThreadId: 11,
      ChatType: "group",
      GroupSubject: "Dev",
      Body: "through this",
      RawBody: "through this",
      CommandBody: "/think high through this",
      CommandAuthorized: true,
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        body: "/think high through this",
      },
      WasMentioned: false,
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const claimCall = firstMockCall(
      hookMocks.runner.runInboundClaimForPluginOutcome,
      "plugin inbound claim",
    );
    expect(claimCall[0]).toBe("openclaw-codex-app-server");
    expect(claimCall[1]).toMatchObject({
      channel: "telegram",
      content: "/think high through this",
    });
    const claimContext = claimCall[2] as { pluginBinding?: { bindingId?: string } };
    expect(claimContext.pluginBinding).toMatchObject({
      bindingId: "binding-structured-normal-turn",
    });
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("keeps message-tool-only source delivery private while still processing the turn", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const callbacks = {
      partial: vi.fn(),
      reasoning: vi.fn(),
      assistantStart: vi.fn(),
      blockQueued: vi.fn(),
      toolStart: vi.fn(),
      itemEvent: vi.fn(),
      planUpdate: vi.fn(),
      toolResult: vi.fn(),
      typingStart: vi.fn(async () => {}),
    };
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(false);
      await opts?.onReplyStart?.();
      await opts?.onPartialReply?.({ text: "draft leak" });
      await opts?.onReasoningStream?.({ text: "reasoning leak" });
      await opts?.onAssistantMessageStart?.();
      await opts?.onToolStart?.({ name: "lookup" });
      await opts?.onItemEvent?.({ progressText: "working" });
      await opts?.onPlanUpdate?.({ phase: "update", explanation: "planning" });
      await opts?.onToolResult?.({ text: "tool output" });
      await opts?.onBlockReply?.({ text: "streaming block" });
      return { text: "final reply" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        onPartialReply: callbacks.partial,
        onReasoningStream: callbacks.reasoning,
        onAssistantMessageStart: callbacks.assistantStart,
        onReplyStart: callbacks.typingStart,
        onBlockReplyQueued: callbacks.blockQueued,
        onToolStart: callbacks.toolStart,
        onItemEvent: callbacks.itemEvent,
        onPlanUpdate: callbacks.planUpdate,
        onToolResult: callbacks.toolResult,
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(callbacks.typingStart).toHaveBeenCalledTimes(1);
    for (const [name, callback] of Object.entries(callbacks)) {
      if (name === "typingStart") {
        continue;
      }
      expect(callback).not.toHaveBeenCalled();
    }
    const replyDispatchCall = hookMocks.runner.runReplyDispatch.mock.calls.find(
      ([event]) =>
        (event as { sourceReplyDeliveryMode?: unknown }).sourceReplyDeliveryMode ===
        "message_tool_only",
    );
    const replyDispatchEvent = replyDispatchCall?.[0] as
      | {
          sendPolicy?: unknown;
          sourceReplyDeliveryMode?: unknown;
          suppressReplyLifecycle?: unknown;
          suppressUserDelivery?: unknown;
        }
      | undefined;
    expect(replyDispatchEvent?.suppressUserDelivery).toBe(true);
    expect(replyDispatchEvent?.suppressReplyLifecycle).toBe(false);
    expect(replyDispatchEvent?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(replyDispatchEvent?.sendPolicy).toBe("allow");
    if (replyDispatchCall?.[1] === undefined) {
      throw new Error("Expected reply dispatch metadata");
    }
  });

  it("treats message-tool-only observed delivery as visible for fallback eligibility", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const observedReplyDelivery = vi.fn();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      await opts?.onObservedReplyDelivery?.();
      return { text: "private final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:session",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        onObservedReplyDelivery: observedReplyDelivery,
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(observedReplyDelivery).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.observedReplyDelivery).toBe(true);
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("preserves hook-blocked metadata when source delivery is message-tool-only", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const blockedReply = setReplyPayloadMetadata(
      { text: "Your message could not be sent: blocked by policy-plugin", isError: true },
      { beforeAgentRunBlocked: true },
    );
    const replyResolver = vi.fn(async () => blockedReply satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:session",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.beforeAgentRunBlocked).toBe(true);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("delivers fast auto progress in message-tool-only mode without verbose progress", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses fast auto progress for room-event message-tool-only turns", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({
      SessionKey: "test:session",
      ChatType: "channel",
      InboundEventKind: "room_event",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("suppresses fast auto progress when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("forwards fast auto progress callbacks without separate message delivery", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn();
    const payload = {
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.(payload);
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onToolResult).toHaveBeenCalledWith(payload);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("forwards suppressed tool progress callbacks in message-tool-only mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ Exec: ruby sleep proof" });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onToolResult).toHaveBeenCalledWith({ text: "🛠️ Exec: ruby sleep proof" });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers forced tool progress in message-tool-only mode without verbose progress", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ Exec: ruby sleep proof" });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        forceToolResultProgress: true,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🛠️ Exec: ruby sleep proof" }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers verbose tool progress in message-tool-only mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "🛠️ Exec: echo post-restart" });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    });
    const ctx = buildTestCtx({ SessionKey: "test:session", ChatType: "channel" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🛠️ Exec: echo post-restart" }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers marked runtime failure notices in message-tool-only mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const failureNotice = setReplyPayloadMetadata(
      { text: "⚠️ You've reached your Codex subscription usage limit." },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => failureNotice satisfies ReplyPayload);
    const ctx = buildTestCtx({ SessionKey: "test:session" });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(failureNotice);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
