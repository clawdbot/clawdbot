// Imported by a dispatch-from-config entrypoint to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import {
  buildAgentHarnessQuestionPromptPayload,
  deliverAgentHarnessUserInputPrompt,
} from "../../agents/harness/user-input-bridge.js";
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
  requireBlockReplyHandler,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("sendPolicy deny — suppress delivery, not processing (#53328)", () => {
  beforeEach(describe2BeforeEach0);

  it.each([
    {
      name: "suppresses marked runtime failure notices for room events",
      text: "⚠️ You've reached your Codex subscription usage limit.",
      command: {},
      queuedFinal: false,
    },
    {
      name: "delivers marked explicit command terminal replies in room events (#87107)",
      text: "⚙️ Compacted (76k → 934 tokens)",
      command: { CommandSource: "text", CommandAuthorized: true, CommandBody: "/compact" },
      queuedFinal: true,
    },
    {
      name: "delivers marked /compact reply in room event when CommandSource is undefined (#87107)",
      text: "⚙️ Compacted (76k → 934 tokens)",
      command: { CommandAuthorized: true, CommandBody: "/compact" },
      queuedFinal: true,
    },
  ] as const)("$name", async ({ text, command, queuedFinal }) => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { sessionId: "s1", updatedAt: 0, sendPolicy: "allow" };
    const dispatcher = createDispatcher();
    const payload = setReplyPayloadMetadata(
      { text },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async () => payload satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "group",
        InboundEventKind: "room_event",
        SessionKey: "test:session",
        ...command,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(queuedFinal);
    if (queuedFinal) {
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(payload);
    } else {
      expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: "delivers marked status blocks in direct message-tool-only turns",
      sendPolicy: "allow",
      ctx: { ChatType: "direct", SessionKey: "test:direct" },
      delivered: true,
    },
    {
      name: "suppresses marked status blocks for ambient room events",
      sendPolicy: "allow",
      ctx: {
        ChatType: "group",
        InboundEventKind: "room_event",
        SessionKey: "test:room",
      },
      delivered: false,
    },
    {
      name: "delivers marked status blocks for explicit room-event commands",
      sendPolicy: "allow",
      ctx: {
        ChatType: "group",
        InboundEventKind: "room_event",
        SessionKey: "test:room-command",
        CommandAuthorized: true,
        CommandSource: "text",
        CommandBody: "/compact",
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      },
      delivered: true,
    },
    {
      name: "suppresses marked status blocks when sendPolicy denies delivery",
      sendPolicy: "deny",
      ctx: { ChatType: "direct", SessionKey: "test:denied" },
      delivered: false,
    },
  ] as const)("$name", async ({ sendPolicy, ctx, delivered }) => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { sessionId: "s1", updatedAt: 0, sendPolicy };
    const dispatcher = createDispatcher();
    const onBlockReplyQueued = vi.fn(async () => {});
    const payload = setReplyPayloadMetadata(
      { text: "Model set for this session.", isStatusNotice: true },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireBlockReplyHandler(opts?.onBlockReply)(payload);
      return [];
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx(ctx),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        onBlockReplyQueued,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    if (delivered) {
      expect(dispatcher.sendBlockReply).toHaveBeenCalledExactlyOnceWith(payload);
    } else {
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    }
    expect(onBlockReplyQueued).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "gateway-backed choice",
      deliver: async (onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]>) => {
        await onBlockReply(
          buildAgentHarnessQuestionPromptPayload({
            questionId: "question-owned-by-harness",
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Choose a color",
                options: [{ label: "Red" }, { label: "Blue" }],
              },
            ],
          }),
        );
      },
    },
    {
      name: "plain secret",
      deliver: async (onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]>) => {
        await deliverAgentHarnessUserInputPrompt({ onBlockReply }, [
          { id: "token", header: "Token", question: "Enter your token", isSecret: true },
        ]);
      },
    },
  ])("delivers $name harness questions in direct message-tool-only turns", async ({ deliver }) => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { sessionId: "s1", updatedAt: 0, sendPolicy: "allow" };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await deliver(requireBlockReplyHandler(opts?.onBlockReply));
      return [];
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct", SessionKey: "test:harness-question" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendBlockReply).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "permits", sendPolicy: "allow", delivered: true, context: {} },
    { name: "rejects", sendPolicy: "deny", delivered: false, context: {} },
    {
      name: "rejects ambient room events for",
      sendPolicy: "allow",
      delivered: false,
      context: { ChatType: "group", InboundEventKind: "room_event" } as const,
    },
  ])(
    "$name authorized durable harness updates in message-tool-only turns",
    async ({ sendPolicy, delivered, context }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = { sessionId: "s1", updatedAt: 0, sendPolicy };
      const dispatcher = createDispatcher();
      const payload = setReplyPayloadMetadata(
        { text: "Background agent update." },
        { deliverDespiteSourceReplySuppression: true },
      );
      const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        await requireBlockReplyHandler(opts?.onBlockReply)(payload, {
          deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:async-update",
        });
        return [];
      });

      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          ChatType: "direct",
          SessionKey: "test:async-harness-update",
          ...context,
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
      });

      expect(dispatcher.sendBlockReply).toHaveBeenCalledTimes(delivered ? 1 : 0);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("keeps hook-cancelled marked blocks out of delivery and queued callbacks", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const deliver = vi.fn(async (_payload: ReplyPayload) => {});
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async () => null,
    });
    const onBlockReplyQueued = vi.fn(async () => {});
    const payload = setReplyPayloadMetadata(
      { text: "Model set for this session.", isStatusNotice: true },
      { deliverDespiteSourceReplySuppression: true },
    );
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireBlockReplyHandler(opts?.onBlockReply)(payload);
      return [];
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct", SessionKey: "test:cancelled-block" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        onBlockReplyQueued,
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result.queuedFinal).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(onBlockReplyQueued).not.toHaveBeenCalled();
  });

  it("mirrors internal source reply payloads into the active transcript", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });
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
    expect(deliver).toHaveBeenCalledWith(sourceReply, { kind: "final" });
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
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });
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
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ text: "redacted hook reply" }), {
      kind: "final",
    });
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
      return {
        ok: true,
        target: {
          agentId: "main",
          sessionId: "test-session",
          sessionKey: "agent:main",
          storePath: "/tmp/sessions.json",
        },
        messageId: "message-1",
      };
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
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver, beforeDeliver: async () => null });
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
    const receipt = await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(receipt?.counts.final.cancelled).toBe(1);
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

  it.each([
    {
      name: "keeps opted-in group/channel final replies private when message-tool-only events miss the message tool",
      ctx: {
        ChatType: "channel",
        CommandSource: undefined,
        SessionKey: "test:discord:channel:C1",
      },
      cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      text: "final reply",
      mode: "message_tool_only",
      queuedFinal: false,
      checkTyping: true,
    },
    {
      name: "keeps same-provider group/channel final replies private in message-tool-only mode",
      ctx: {
        ChatType: "channel",
        CommandSource: undefined,
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:C1",
        SessionKey: "test:discord:channel:C1",
      },
      cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      text: "final reply",
      mode: "message_tool_only",
      queuedFinal: false,
      checkTyping: false,
    },
    {
      name: "keeps ambient room-event group/channel finals private without a message tool send",
      ctx: {
        ChatType: "channel",
        InboundEventKind: "room_event",
        SessionKey: "test:discord:channel:C1",
      },
      cfg: emptyConfig,
      text: "ambient final reply",
      mode: "message_tool_only",
      queuedFinal: false,
      checkTyping: false,
    },
    {
      name: "delivers internal WebChat room-event final replies automatically",
      ctx: {
        ChatType: "direct",
        InboundEventKind: "room_event",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:forge:webchat:forge-main",
      },
      cfg: emptyConfig,
      text: "visible webchat reply",
      mode: "automatic",
      queuedFinal: true,
      checkTyping: false,
    },
    {
      name: "preserves configured message-tool delivery for internal WebChat direct replies",
      ctx: {
        ChatType: "direct",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:forge:webchat:forge-main",
      },
      cfg: { messages: { visibleReplies: "message_tool" } },
      text: "private webchat final",
      mode: "message_tool_only",
      queuedFinal: false,
      checkTyping: false,
    },
    {
      name: "keeps default direct source delivery automatic",
      ctx: { ChatType: "direct", SessionKey: "agent:main:telegram:direct:U1" },
      cfg: emptyConfig,
      text: "visible direct reply",
      mode: "automatic",
      queuedFinal: true,
      checkTyping: false,
    },
  ] as const)("$name", async ({ ctx, cfg, text, mode, queuedFinal, checkTyping }) => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe(mode);
      if (checkTyping) {
        expect(opts?.suppressTyping).toBe(false);
      }
      return { text } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx(ctx),
      cfg,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(queuedFinal);
    if (queuedFinal) {
      expect(firstFinalReplyPayload(dispatcher)?.text).toBe(text);
    } else {
      expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    }
    if ("OriginatingChannel" in ctx) {
      expect(mocks.routeReply).not.toHaveBeenCalled();
    }
  });

  type HarnessDeliveryCase = {
    name: string;
    harnessId?: string;
    supportsProvider?: string;
    currentEntry: typeof sessionStoreMocks.currentEntry;
    ctx: Partial<MsgContext>;
    cfg: OpenClawConfig;
    replyOptions?: GetReplyOptions;
    expectedMode: "automatic" | "message_tool_only";
    text: string;
  };

  async function runHarnessDeliveryCase(testCase: HarnessDeliveryCase) {
    setNoAbort();
    const harnessId = testCase.harnessId ?? "codex";
    registerAgentHarness({
      id: harnessId,
      label: harnessId === "codex" ? "Codex" : "Custom",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        !testCase.supportsProvider || ctx.provider === testCase.supportsProvider
          ? { supported: true, priority: harnessId === "codex" ? 100 : 200 }
          : { supported: false, reason: `${testCase.supportsProvider} provider only` },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = structuredClone(testCase.currentEntry);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe(testCase.expectedMode);
      return { text: testCase.text } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx(testCase.ctx),
      cfg: testCase.cfg,
      dispatcher,
      replyOptions: testCase.replyOptions,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(testCase.expectedMode === "automatic");
    if (testCase.expectedMode === "automatic") {
      expect(firstFinalReplyPayload(dispatcher)?.text).toBe(testCase.text);
    } else {
      expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    }
  }

  const directCtx = {
    ChatType: "direct",
    CommandSource: undefined,
    SessionKey: "agent:main:main",
  } satisfies Partial<MsgContext>;
  const telegramDirectCtx = {
    ...directCtx,
    Provider: "telegram",
    Surface: "telegram",
    SessionKey: "agent:main:telegram:direct:U1",
  } satisfies Partial<MsgContext>;
  const codexEntry = {
    sessionId: "s1",
    updatedAt: 0,
    agentHarnessId: "codex",
    sendPolicy: "allow",
  } as const;
  const cachedCodexEntry = {
    ...codexEntry,
    modelProvider: "codex",
    model: "gpt-5.5",
  } as const;
  const channelModelConfig = {
    channels: { modelByChannel: { telegram: { "*": "anthropic/claude-sonnet-4.6" } } },
  } as OpenClawConfig;

  it.each([
    {
      name: "keeps Codex direct source delivery message-tool-only when config is unset",
      currentEntry: codexEntry,
      ctx: directCtx,
      cfg: emptyConfig,
      expectedMode: "message_tool_only",
      text: "private final reply",
    },
    {
      name: "keeps locked supervised Codex delivery defaults across outer model overrides",
      supportsProvider: "codex",
      currentEntry: {
        ...codexEntry,
        sessionId: "catalog-adopted-session",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: { supervision: { sourceThreadId: "019f-codex-thread", modelLocked: true } },
        },
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4.6",
      },
      ctx: directCtx,
      cfg: emptyConfig,
      expectedMode: "message_tool_only",
      text: "private supervised reply",
    },
    {
      name: "uses Codex direct source delivery defaults before a session entry exists",
      currentEntry: undefined,
      ctx: telegramDirectCtx,
      cfg: emptyConfig,
      expectedMode: "message_tool_only",
      text: "private first reply",
    },
    {
      name: "uses channel model overrides before Codex first-turn direct source delivery defaults",
      supportsProvider: "codex",
      currentEntry: undefined,
      ctx: telegramDirectCtx,
      cfg: channelModelConfig,
      expectedMode: "automatic",
      text: "visible channel-model reply",
    },
    {
      name: "uses channel model overrides before cached Codex runtime defaults",
      supportsProvider: "codex",
      currentEntry: { ...cachedCodexEntry, channel: "telegram" },
      ctx: telegramDirectCtx,
      cfg: channelModelConfig,
      expectedMode: "automatic",
      text: "visible existing-channel-model reply",
    },
    {
      name: "uses configured defaults before cached Codex runtime metadata",
      supportsProvider: "codex",
      currentEntry: cachedCodexEntry,
      ctx: telegramDirectCtx,
      cfg: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4.6" } } },
      } as OpenClawConfig,
      expectedMode: "automatic",
      text: "visible configured-default reply",
    },
    {
      name: "lets config restore automatic Codex direct source delivery",
      currentEntry: codexEntry,
      ctx: directCtx,
      cfg: { messages: { visibleReplies: "automatic" } } as OpenClawConfig,
      expectedMode: "automatic",
      text: "visible final reply",
    },
    {
      name: "honors model overrides before cached Codex direct source delivery defaults",
      supportsProvider: "codex",
      currentEntry: {
        ...codexEntry,
        agentRuntimeOverride: "codex",
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4.6",
      },
      ctx: directCtx,
      cfg: emptyConfig,
      expectedMode: "automatic",
      text: "visible switched-model reply",
    },
    {
      name: "honors heartbeat model overrides before Codex direct source delivery defaults",
      supportsProvider: "codex",
      currentEntry: codexEntry,
      ctx: telegramDirectCtx,
      cfg: emptyConfig,
      replyOptions: { isHeartbeat: true, heartbeatModelOverride: "anthropic/claude-sonnet-4.6" },
      expectedMode: "automatic",
      text: "visible heartbeat-model reply",
    },
    {
      name: "preserves non-Codex harness direct source delivery defaults",
      harnessId: "custom",
      supportsProvider: "custom",
      currentEntry: { ...codexEntry, agentHarnessId: "custom" },
      ctx: { ...directCtx, Provider: "custom" },
      cfg: emptyConfig,
      expectedMode: "message_tool_only",
      text: "private final reply",
    },
  ] satisfies HarnessDeliveryCase[])("$name", runHarnessDeliveryCase);

  it("records a rejected source delivery after a runtime-derived fallback", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => ({}) as never),
    });
    sessionStoreMocks.currentEntry = { ...codexEntry };
    const deliveryError = new Error("source transport rejected final");
    const deliver = vi.fn(async () => {
      throw deliveryError;
    });
    const onError = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver, onError });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const internalOpts = opts as
        | (GetReplyOptions & {
            onSourceReplyDeliveryModeResolved?: (mode: "automatic") => void;
          })
        | undefined;
      internalOpts?.onSourceReplyDeliveryModeResolved?.("automatic");
      return { text: "Rejected fallback final" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(result).toMatchObject({ queuedFinal: true });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Rejected fallback final" }),
      expect.objectContaining({ kind: "final" }),
    );
    expect(onError).toHaveBeenCalledWith(deliveryError, expect.objectContaining({ kind: "final" }));
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect((await dispatcher.waitForIdle())?.counts.final.failedAfterSend).toBe(1);
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

  async function expectAutomaticDelivery(params: {
    ctx: Partial<MsgContext>;
    cfg: OpenClawConfig;
    text: string;
    replyOptions?: GetReplyOptions;
    checkTyping?: boolean;
  }) {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      if (params.checkTyping) {
        expect(opts?.suppressTyping).toBe(false);
      }
      return { text: params.text } satisfies ReplyPayload;
    });
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx(params.ctx),
      cfg: params.cfg,
      dispatcher,
      replyOptions: params.replyOptions,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe(params.text);
  }

  it("falls back to automatic group/channel delivery when the message tool is unavailable", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        tools: { allow: ["read"] },
      } as OpenClawConfig,
      text: "visible fallback",
    });
  });

  it("falls back to automatic group/channel delivery when group tools remove the message tool", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "channel",
        From: "discord:channel:C1",
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:main:discord:channel:C1",
      },
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
      text: "group policy fallback",
    });
  });

  it("falls back when a channel precomputed message-tool-only delivery but the message tool is unavailable", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "channel",
        SessionKey: "test:discord:channel:C1",
      },
      cfg: { tools: { allow: ["read"] } } as OpenClawConfig,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
      text: "requested fallback",
    });
  });

  it("keeps native command replies visible in group/channel events", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "group",
        CommandSource: "native",
        CommandAuthorized: true,
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      },
      cfg: emptyConfig,
      text: "status reply",
      checkTyping: true,
    });
  });

  it("keeps default group/channel source delivery automatic", async () => {
    await expectAutomaticDelivery({
      ctx: {
        ChatType: "group",
        WasMentioned: true,
        SessionKey: "test:telegram:group:G1",
      },
      cfg: emptyConfig,
      text: "final reply",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
