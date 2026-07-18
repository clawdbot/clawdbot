// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  mocks,
  sessionStoreMocks,
  transcriptMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  setNoAbort,
  firstFinalReplyPayload,
  globalBeforeAll0,
  describe2BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("sendPolicy deny — suppress delivery, not processing (#53328)", () => {
  beforeEach(describe2BeforeEach0);

  it("suppresses marked runtime failure notices for room events", async () => {
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
    const ctx = buildTestCtx({
      ChatType: "group",
      InboundEventKind: "room_event",
      SessionKey: "test:session",
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

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("delivers marked explicit command terminal replies in room events (#87107)", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const commandReply = setReplyPayloadMetadata(
      { text: "⚙️ Compacted (76k → 934 tokens)" },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => commandReply satisfies ReplyPayload);
    const ctx = buildTestCtx({
      ChatType: "group",
      InboundEventKind: "room_event",
      SessionKey: "test:session",
      CommandSource: "text",
      CommandAuthorized: true,
      CommandBody: "/compact",
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

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(commandReply);
  });

  it("delivers marked /compact reply in room event when CommandSource is undefined (#87107)", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const commandReply = setReplyPayloadMetadata(
      { text: "⚙️ Compacted (76k → 934 tokens)" },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => commandReply satisfies ReplyPayload);
    const ctx = buildTestCtx({
      ChatType: "group",
      InboundEventKind: "room_event",
      SessionKey: "test:session",
      CommandAuthorized: true,
      CommandBody: "/compact",
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

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(commandReply);
  });

  it("mirrors internal source reply payloads into the active transcript", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const sourceReply = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(sourceReply);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main",
      agentId: "main",
      text: "message tool reply",
      mediaUrls: undefined,
      idempotencyKey: "run-1:internal-source-reply:0",
      expectedSessionId: "s1",
      storePath: "/tmp/mock-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("mirrors post-hook internal source reply payloads into the active transcript", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    dispatcher.appendBeforeDeliver?.((payload, info) => {
      if (info.kind !== "final") {
        return payload;
      }
      return setReplyPayloadMetadata(
        {
          ...payload,
          text: "redacted hook reply",
          mediaUrl: undefined,
          mediaUrls: ["https://example.com/redacted.png"],
        },
        getReplyPayloadMetadata(payload) ?? {},
      );
    });
    const sourceReply = setReplyPayloadMetadata(
      { text: "secret message tool reply", mediaUrl: "https://example.com/secret.png" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "secret message tool reply",
          mediaUrls: ["https://example.com/secret.png"],
          idempotencyKey: "run-1:internal-source-reply:rewritten",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(sourceReply);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main",
      agentId: "main",
      text: "redacted hook reply",
      mediaUrls: ["https://example.com/redacted.png"],
      idempotencyKey: "run-1:internal-source-reply:rewritten",
      expectedSessionId: "s1",
      storePath: "/tmp/mock-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("lets a queued same-session turn finish before mirroring delivered source replies", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      sessionKey: "agent:main",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const order: string[] = [];
    let followupDispatch: Promise<unknown> | undefined;
    const firstDispatcher = createReplyDispatcher({
      deliver: async () => {
        if (!followupDispatch) {
          throw new Error("expected queued follow-up dispatch");
        }
        await followupDispatch;
        order.push("first-delivery");
      },
    });
    const firstReply = setReplyPayloadMetadata(
      { text: "first reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "first reply",
          idempotencyKey: "run-1:internal-source-reply:queued",
        },
      },
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(async () => {
      order.push("mirror");
      return { ok: true, sessionFile: "/tmp/session.jsonl", messageId: "message-1" };
    });

    const firstResult = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        MessageSid: "first-message",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:main",
      }),
      cfg: emptyConfig,
      dispatcher: firstDispatcher,
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
      replyResolver: async () => {
        followupDispatch = dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Body: "follow up",
            MessageSid: "followup-message",
            Provider: "webchat",
            Surface: "webchat",
            SessionKey: "agent:main",
          }),
          cfg: emptyConfig,
          dispatcher: createDispatcher(),
          replyResolver: async () => {
            order.push("followup");
            return { text: "second reply" };
          },
        });
        await Promise.resolve();
        return firstReply;
      },
    });

    expect(firstResult.queuedFinal).toBe(true);
    await settleReplyDispatcher({ dispatcher: firstDispatcher });
    await followupDispatch;

    expect(order).toEqual(["followup", "first-delivery", "mirror"]);
    const queuedMirrorCalls = transcriptMocks.appendAssistantMessageToSessionTranscript.mock.calls
      .map(([params]) => params as { idempotencyKey?: string })
      .filter((params) => params.idempotencyKey === "run-1:internal-source-reply:queued");
    expect(queuedMirrorCalls).toHaveLength(1);
  });

  it("does not mirror internal source replies cancelled by dispatcher hooks", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    dispatcher.getCancelledCounts = vi
      .fn()
      .mockReturnValueOnce({ tool: 0, block: 0, final: 0 })
      .mockReturnValue({ tool: 0, block: 0, final: 1 });
    dispatcher.waitForIdle = vi.fn(async () => {});
    const sourceReply = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(sourceReply);
    expect(dispatcher.waitForIdle).toHaveBeenCalled();
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("keeps internal source reply metadata on TTS-cloned final payloads", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const sourceReply = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-tts:internal-source-reply:0",
        },
      },
    );
    const replyResolver = vi.fn(async () => sourceReply satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "webchat", Surface: "webchat", SessionKey: "agent:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.queuedFinal).toBe(true);
    const queuedPayload = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(queuedPayload).toMatchObject({
      text: "message tool reply",
      mediaUrl: "https://example.com/tts-synth.opus",
      audioAsVoice: true,
    });
    expect(getReplyPayloadMetadata(queuedPayload)?.sourceReplyTranscriptMirror).toMatchObject({
      sessionKey: "agent:main",
      idempotencyKey: "run-tts:internal-source-reply:0",
    });
  });

  it("does not deliver marked runtime failure notices when sendPolicy denies delivery", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () =>
        setReplyPayloadMetadata(
          { text: "⚠️ You've reached your Codex subscription usage limit." },
          { deliverDespiteSourceReplySuppression: true },
        ) satisfies ReplyPayload,
    );
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
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps opted-in group/channel final replies private when message-tool-only events miss the message tool", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(opts?.suppressTyping).toBe(false);
      return { text: "final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        CommandSource: undefined,
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
      },
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps same-provider group/channel final replies private in message-tool-only mode", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        CommandSource: undefined,
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:C1",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
      },
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("keeps ambient room-event group/channel finals private without a message tool send", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "ambient final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        InboundEventKind: "room_event",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers internal WebChat room-event final replies automatically", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible webchat reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        InboundEventKind: "room_event",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:forge:webchat:forge-main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(result.sourceReplyDeliveryMode).toBeUndefined();
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible webchat reply");
  });

  it("preserves configured message-tool delivery for internal WebChat direct replies", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private webchat final" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:forge:webchat:forge-main",
      }),
      cfg: { messages: { visibleReplies: "message_tool" } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps default direct source delivery automatic", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible direct reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible direct reply");
  });

  it("keeps Codex direct source delivery message-tool-only when config is unset", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps locked supervised Codex delivery defaults across outer model overrides", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "catalog-adopted-session",
      updatedAt: 0,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private supervised reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("uses Codex direct source delivery defaults before a session entry exists", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = undefined;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private first reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("uses channel model overrides before Codex first-turn direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = undefined;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible channel-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "*": "anthropic/claude-sonnet-4.6",
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible channel-model reply");
  });

  it("uses channel model overrides before cached Codex runtime defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      modelProvider: "codex",
      model: "gpt-5.5",
      channel: "telegram",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible existing-channel-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "*": "anthropic/claude-sonnet-4.6",
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible existing-channel-model reply");
  });

  it("uses configured defaults before cached Codex runtime metadata", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      modelProvider: "codex",
      model: "gpt-5.5",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible configured-default reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4.6" },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible configured-default reply");
  });

  it("lets config restore automatic Codex direct source delivery", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: { messages: { visibleReplies: "automatic" } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible final reply");
  });

  it("honors model overrides before cached Codex direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible switched-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible switched-model reply");
  });

  it("honors parent model overrides before Codex direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    const parentSessionKey = "agent:main:telegram:direct:U1";
    const childSessionKey = `${parentSessionKey}:thread:topic-1`;
    sessionStoreMocks.currentEntry = {
      sessionId: "child",
      updatedAt: 0,
      agentHarnessId: "codex",
      parentSessionKey,
      sendPolicy: "allow",
    };
    const parentEntry = {
      sessionId: "parent",
      updatedAt: 0,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
    };
    // Scope the parent-key override to this test; the describe's beforeEach does
    // not reset loadSessionStoreEntry, so leaving it in place would resolve a
    // stale "parent" sessionId for a sibling reusing this session key.
    const defaultLoadSessionStoreEntry = () => sessionStoreMocks.currentEntry;
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(((params: unknown) =>
      (params as { sessionKey?: string }).sessionKey === parentSessionKey
        ? parentEntry
        : sessionStoreMocks.currentEntry) as () => Record<string, unknown> | undefined);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible parent-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        ModelParentSessionKey: parentSessionKey,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: childSessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(sessionStoreMocks.loadSessionStore).not.toHaveBeenCalled();
    expect(sessionStoreMocks.loadSessionStoreEntry).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/mock-sessions.json",
      sessionKey: parentSessionKey,
      readConsistency: "latest",
      clone: false,
    });
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible parent-model reply");
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(defaultLoadSessionStoreEntry);
  });

  it("honors heartbeat model overrides before Codex direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "codex",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible heartbeat-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: {
        isHeartbeat: true,
        heartbeatModelOverride: "anthropic/claude-sonnet-4.6",
      },
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible heartbeat-model reply");
  });

  it("preserves non-Codex harness direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "custom",
      label: "Custom",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "custom"
          ? { supported: true, priority: 200 }
          : { supported: false, reason: "custom provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      agentHarnessId: "custom",
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("message_tool_only");
      return { text: "private final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        Provider: "custom",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("falls back to automatic group/channel delivery when the message tool is unavailable", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible fallback" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        tools: { allow: ["read"] },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible fallback");
  });

  it("falls back to automatic group/channel delivery when group tools remove the message tool", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "group policy fallback" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        From: "discord:channel:C1",
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:main:discord:channel:C1",
      }),
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        channels: {
          discord: {
            groups: {
              C1: { tools: { allow: ["read"] } },
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("group policy fallback");
  });

  it("falls back when a channel precomputed message-tool-only delivery but the message tool is unavailable", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "requested fallback" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      }),
      cfg: { tools: { allow: ["read"] } } as OpenClawConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("requested fallback");
  });

  it("keeps native command replies visible in group/channel events", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      expect(opts?.suppressTyping).toBe(false);
      return { text: "status reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "group",
        CommandSource: "native",
        CommandAuthorized: true,
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("status reply");
  });

  it("keeps default group/channel source delivery automatic", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "final reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "group",
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("final reply");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
