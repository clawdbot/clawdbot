// Imported by a dispatch-from-config entrypoint to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { WorkerSessionPlacementRecord } from "../../gateway/worker-environments/placement-record.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { PluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  NO_VISIBLE_REPLY_FALLBACK_TEXT,
  QUEUE_CAP_REJECTION_TEXT,
} from "./dispatch-from-config.payloads.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  globalMocks,
  hookMocks,
  mocks,
  placementContextMocks,
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
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
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

  it("does not start the reply lifecycle when before_dispatch silently handles the turn", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    const dispatcher = createDispatcher();
    const onReplyStart = vi.fn(async () => {});
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      return { text: "model reply" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onReplyStart },
    });

    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(onReplyStart).not.toHaveBeenCalled();
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

  it("passes canonical requester lineage to the before_dispatch runner", async () => {
    sessionStoreMocks.currentEntry = {
      sessionId: "canonical-session-id",
      sessionKey: "agent:main:telegram:direct:canonical",
      updatedAt: 0,
    };
    hookMocks.runner.runBeforeDispatch.mockImplementation(async (event, context) => {
      (event as { sessionKey?: string }).sessionKey = "agent:plugin:forged";
      (context as { sessionKey?: string }).sessionKey = "agent:plugin:forged";
      return { handled: true };
    });

    await dispatchReplyFromConfig({
      ctx: createHookCtx({
        SessionKey: "agent:main:telegram:direct:fallback",
        OriginatingChannel: " Telegram ",
        OriginatingTo: " telegram:999 ",
        AccountId: " Work ",
        MessageThreadId: 42,
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
    });

    const requester = firstMockCall(
      hookMocks.runner.runBeforeDispatch,
      "before dispatch hook",
    )[2] as PluginSubagentRequesterContext | undefined;
    expect(requester).toEqual({
      sessionKey: "agent:main:telegram:direct:fallback",
      origin: {
        channel: "telegram",
        to: "telegram:999",
        accountId: "work",
        threadId: 42,
      },
    });
  });

  it("passes inbound reply metadata to before_dispatch event and context", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    const dispatcher = createDispatcher();
    const ctx = createHookCtx({
      MessageSid: "discord-message-456",
      MessageSidFull: "  ",
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
            messageId?: unknown;
            replyToId?: unknown;
            replyToIdFull?: unknown;
            replyToBody?: unknown;
            replyToSender?: unknown;
            replyToIsQuote?: unknown;
          },
          {
            messageId?: unknown;
            replyToId?: unknown;
            replyToIdFull?: unknown;
            replyToBody?: unknown;
            replyToSender?: unknown;
            replyToIsQuote?: unknown;
          },
        ]
      | undefined;
    expect(beforeDispatchCall?.[0]).toMatchObject({
      messageId: "discord-message-456",
      replyToId: "discord-reply-123",
      replyToIdFull: "discord:channel-1:discord-reply-123",
      replyToBody: "the quoted parent message",
      replyToSender: "Ada",
      replyToIsQuote: true,
    });
    expect(beforeDispatchCall?.[1]).toMatchObject({
      messageId: "discord-message-456",
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

  it.each([
    {
      name: "direct turns",
      ctx: buildTestCtx({
        ChatType: "direct",
        Surface: "feishu",
        Provider: "feishu",
        SessionKey: "agent:main:feishu:direct:ou_user",
      }),
      cfg: emptyConfig,
    },
    {
      name: "mentioned group turns",
      ctx: buildTestCtx({
        ChatType: "group",
        Surface: "feishu",
        Provider: "feishu",
        SessionKey: "agent:main:feishu:group:oc_group",
        WasMentioned: true,
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "disallow",
            },
          },
        },
      } as OpenClawConfig,
    },
  ])("records explicit NO_REPLY without a generic fallback in $name", async ({ ctx, cfg }) => {
    setNoAbort();
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      (opts as InternalGetReplyOptions | undefined)?.onDeliberateSilentTerminalReply?.();
      return undefined;
    });

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(replyResolver).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      deliberateSilentTerminalReply: true,
    });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("does not infer terminal silence from a sibling NO_REPLY payload", async () => {
    setNoAbort();
    const deliveredTexts: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(async (payload) => {
        deliveredTexts.push(payload.text ?? "");
      }),
      beforeDeliver: async (payload) =>
        payload.text === NO_VISIBLE_REPLY_FALLBACK_TEXT ? payload : null,
    });
    const replyResolver = vi.fn(
      async () => [{ text: "visible reply" }, { text: "NO_REPLY" }] satisfies ReplyPayload[],
    );

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredTexts).not.toContain("visible reply");
    expect(deliveredTexts).toContain(NO_VISIBLE_REPLY_FALLBACK_TEXT);
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it("reports queue-cap rejection instead of a temporary model failure", async () => {
    setNoAbort();
    diagnosticMocks.logMessageDispatchCompleted.mockClear();
    const deliveredTexts: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(async (payload) => {
        deliveredTexts.push(payload.text ?? "");
      }),
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const runState = resolveReplyOperationRunState(opts);
      if (!runState) {
        throw new Error("expected reply operation state");
      }
      runState.admission = { status: "skipped", reason: "queue-cap" };
      return undefined;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct", SessionKey: "test:queue-cap" }),
      cfg: { diagnostics: { enabled: true } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredTexts).toEqual([QUEUE_CAP_REJECTION_TEXT]);
    expect(deliveredTexts).not.toContain(NO_VISIBLE_REPLY_FALLBACK_TEXT);
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
    expect(diagnosticMocks.logMessageDispatchCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "queue-cap",
        sessionKey: "test:queue-cap",
      }),
    );
  });

  it("does not report a pending continuation as an empty terminal reply", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: InternalGetReplyOptions) => {
      opts?.onPendingContinuation?.();
      return undefined;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        Surface: "telegram",
        Provider: "telegram",
        SessionKey: "agent:main:telegram:direct:test",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });

  it("delivers core no-visible-reply fallback for disallowed empty mentioned group turns", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "feishu",
      Provider: "feishu",
      SessionKey: "agent:main:feishu:group:oc_group",
      WasMentioned: true,
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

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    });
    expect(result).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
      noVisibleReplyFallbackDelivered: true,
    });
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("keeps ambient group turns silent even when silence policy is disallow", async () => {
    setNoAbort();
    // The fallback exists for a user who asked and got nothing. An undirected
    // group turn never draws a visible failure notice, regardless of silence
    // policy (#114799: ambient HamVerBot group chatter drew fallback spam).
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
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

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("reports an active-run accepted turn as deferred instead of empty", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const runState = resolveReplyOperationRunState(opts);
      if (!runState) {
        throw new Error("expected reply operation run state");
      }
      runState.admission = { status: "accepted", mode: "followup" };
      return undefined;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Surface: "telegram",
        Provider: "telegram",
        SessionKey: "agent:main:telegram:direct:test",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      deferredToActiveRun: "followup",
    });
  });

  it("keeps room_event turns silent even when silence policy is disallow", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      InboundEventKind: "room_event",
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

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("keeps room_event turns silent even when they carry a mention", async () => {
    setNoAbort();
    // A room_event is ambient by construction; a stray WasMentioned/direct
    // classification must not promote it to a directed turn (only a command
    // turn does, matching the room_event source-reply suppression bypass).
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      InboundEventKind: "room_event",
      WasMentioned: true,
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

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("delivers fallback for mentioned group turns even when group silence is allowed", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
    });

    // No silentReply config: group default is "allow", but an explicit mention
    // is a directed turn and must never end silently.
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    });
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it("keeps ambient group turns silent under the default group policy", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("does not deliver no-visible fallback when silentReply allows empty finals", async () => {
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
              group: "allow",
            },
          },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("does not deliver no-visible fallback when sendPolicy is deny", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
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

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
    expect(result.sendPolicyDenied).toBe(true);
  });

  it("does not deliver no-visible fallback under message_tool_only source delivery", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "direct",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:direct:user1",
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

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    // Direct silent policy is disallow; eligibility remains for transport fallbacks.
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
  });

  it("does not deliver no-visible fallback after observed reply delivery", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const observedReplyDelivery = vi.fn();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onObservedReplyDelivery?.();
      return undefined;
    });
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
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
      replyOptions: {
        onObservedReplyDelivery: observedReplyDelivery,
      },
    });

    expect(observedReplyDelivery).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    expect(result.observedReplyDelivery).toBe(true);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("delivers routed fallback when routing drops an empty final without sending", async () => {
    setNoAbort();
    mocks.routeReply.mockResolvedValueOnce({ ok: true, delivered: false }).mockResolvedValueOnce({
      ok: true,
      delivered: true,
      messageId: "fallback-1",
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "" }));
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "slack",
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      SessionKey: "agent:main:slack:group:oc_group",
      WasMentioned: true,
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

    // The empty final routes as { ok: true } without sending; the fallback must
    // still fire instead of trusting route success as visibility.
    const fallbackCall = mocks.routeReply.mock.calls.find(
      (call) =>
        (call[0] as { payload?: { text?: string } }).payload?.text ===
        NO_VISIBLE_REPLY_FALLBACK_TEXT,
    );
    expect(fallbackCall).toBeDefined();
    expect(result.queuedFinal).toBe(true);
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it("keeps eligibility when an empty routed final precedes a suppressed fallback", async () => {
    setNoAbort();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: false, suppressed: true });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "" }));
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "slack",
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      SessionKey: "agent:main:slack:group:oc_group",
      WasMentioned: true,
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

    // Neither the phantom empty route nor the suppressed fallback was visible;
    // eligibility must survive for channel-level recovery.
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
  });

  it("does not report a hook-suppressed routed fallback as delivered", async () => {
    setNoAbort();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: false, suppressed: true });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "slack",
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      SessionKey: "agent:main:slack:group:oc_group",
      WasMentioned: true,
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

    expect(result.queuedFinal).toBe(false);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
  });

  it("does not deliver no-visible fallback after a routed media-only block", async () => {
    setNoAbort();
    mocks.routeReply.mockResolvedValue({
      ok: true,
      delivered: true,
      messageId: "media-block-1",
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({ mediaUrl: "https://example.com/seatmap.png" });
      return undefined;
    });
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "slack",
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      SessionKey: "agent:main:slack:group:oc_group",
      WasMentioned: true,
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

    // A routed media-only block increments neither blockCount (text-only counter)
    // nor dispatcher counts; the delivered-routed-block fact must suppress the
    // fallback so users never see failure text after valid media.
    const fallbackCall = mocks.routeReply.mock.calls.find(
      (call) =>
        (call[0] as { payload?: { text?: string } }).payload?.text ===
        NO_VISIBLE_REPLY_FALLBACK_TEXT,
    );
    expect(fallbackCall).toBeUndefined();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it("does not deliver no-visible fallback after streamed blocks invisible to dispatcher counts", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({ text: "Streamed answer content." });
      return undefined;
    });
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
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

    // The stub dispatcher exposes no settlement, so the ledger keeps the block's
    // admission as its visibility fact and no misleading fallback is sent.
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it("does not duplicate a final accepted by a legacy dispatcher", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    delete dispatcher.supportsSettledReceipt;
    dispatcher.waitForIdle = vi.fn(async () => {});
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: {
        agents: { defaults: { silentReply: { group: "disallow" } } },
      } as OpenClawConfig,
      dispatcher,
      replyResolver: vi.fn(async () => ({ text: "Legacy final answer." })),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith({
      text: "Legacy final answer.",
    });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it("does not infer receipt visibility from a custom dispatcher's queued block", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    dispatcher.getQueuedCounts = vi.fn(() => ({ tool: 0, block: 1, final: 0 }));
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
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

    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect(result.queuedFinal).toBe(true);
    expect(result.counts.block).toBe(1);
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it("keeps no-visible fallback eligible when core fallback delivery fails", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    dispatcher.sendFinalReply = vi.fn(() => false);
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
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

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    });
    expect(result.queuedFinal).toBe(false);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
  });

  it("delivers routed fallback when a suppressed contentful final settles invisible", async () => {
    setNoAbort();
    // A contentful routed final that reports ok+suppressed was never visible;
    // admission-based gating used to end this turn silently (#114768 corner 1).
    mocks.routeReply.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as { payload?: { text?: string } };
      return params.payload?.text === NO_VISIBLE_REPLY_FALLBACK_TEXT
        ? { ok: true, delivered: true, messageId: "fallback-1" }
        : { ok: true, delivered: false, suppressed: true };
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "real answer" }));
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "slack",
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      SessionKey: "agent:main:slack:group:oc_group",
      WasMentioned: true,
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

    const fallbackCall = mocks.routeReply.mock.calls.find(
      (call) =>
        (call[0] as { payload?: { text?: string } }).payload?.text ===
        NO_VISIBLE_REPLY_FALLBACK_TEXT,
    );
    expect(fallbackCall).toBeDefined();
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it("delivers fallback when a queued streamed block is cancelled before delivery", async () => {
    setNoAbort();
    // A generated block only proves visibility once its delivery settles; a
    // pre-transport cancellation used to suppress the fallback silently
    // (#114768 corner 2). Started-then-failed sends stay conservative: they may
    // have shown partial content, so they do not trigger the fallback.
    const deliver = vi.fn(async (_payload: ReplyPayload) => {});
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async (payload, info) => (info.kind === "block" ? null : payload),
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({ text: "Streamed answer content." });
      return undefined;
    });
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
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
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    const deliveredTexts = deliver.mock.calls.map((call) => call[0].text);
    expect(deliveredTexts).toContain(NO_VISIBLE_REPLY_FALLBACK_TEXT);
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it("keeps eligibility when a beforeDeliver hook cancels the queued fallback", async () => {
    setNoAbort();
    // The fallback's own admission can still be cancelled by a beforeDeliver
    // hook; the delivered flag must follow settlement so channel recovery stays
    // eligible (#114768 corner 3).
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async () => null,
    });
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
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
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliver).not.toHaveBeenCalled();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
  });

  it("delivers fallback when a beforeDeliver hook cancels the model final", async () => {
    setNoAbort();
    const deliver = vi.fn(async (_payload: ReplyPayload) => {});
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async (payload) =>
        payload.text === NO_VISIBLE_REPLY_FALLBACK_TEXT ? payload : null,
    });
    const replyResolver = vi.fn(async () => ({ text: "cancelled answer" }));
    const ctx = buildTestCtx({
      ChatType: "group",
      Surface: "telegram",
      Provider: "telegram",
      SessionKey: "agent:main:telegram:group:oc_group",
      WasMentioned: true,
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
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    const deliveredTexts = deliver.mock.calls.map((call) => call[0].text);
    expect(deliveredTexts).toEqual([NO_VISIBLE_REPLY_FALLBACK_TEXT]);
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
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
    const archivedAt = Date.now() - 1_000;
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      archivedAt,
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:archived-test",
      ChatType: "channel",
      From: "discord:user:12345",
      To: "discord:channel:archived-test",
      AccountId: "default",
      SessionKey: "agent:main:discord:channel:archived-test",
      Body: "start work",
      CommandBody: "start work",
      RawBody: "start work",
      CommandSource: undefined,
      InboundAccessAuthorized: true,
      InboundEventKind: "user_request",
      InputProvenance: { kind: "external_user", sourceChannel: "discord" },
    });

    await expect(
      dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver }),
    ).rejects.toThrow(/is archived/i);

    expect(sessionStoreMocks.currentEntry?.archivedAt).toBe(archivedAt);
    expect(sessionBindingMocks.touch).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no placement", blocked: false, suppliedOwner: false },
    { name: "active placement", blocked: true, suppliedOwner: false },
    {
      name: "owning Gateway proves failed environment is gone",
      blocked: false,
      suppliedOwner: true,
    },
  ])(
    "restores admitted archived channel work before reply-operation admission: $name",
    async ({ blocked, suppliedOwner }) => {
      setNoAbort();
      const sessionId = "archived-channel-session";
      const sessionKey = "agent:main:discord:channel:restored-test";
      const archivedAt = Date.now() - 1_000;
      sessionStoreMocks.currentEntry = {
        sessionId,
        updatedAt: Date.now(),
        archivedAt,
        archivedBy: { type: "human", id: "profile-operator" },
      };
      if (blocked || suppliedOwner) {
        placementContextMocks.getMany.mockReturnValue(
          new Map([[sessionId, { state: "active" } as WorkerSessionPlacementRecord]]),
        );
      }
      const ownerGetMany = vi.fn(
        () =>
          new Map([
            [
              sessionId,
              {
                state: "failed",
                environmentId: "environment-a",
              } as WorkerSessionPlacementRecord,
            ],
          ]),
      );
      const sessionWorkerPlacementContext = suppliedOwner
        ? {
            workerEnvironmentService: { get: vi.fn(() => undefined) },
            workerSessionPlacementService: { getMany: ownerGetMany },
          }
        : undefined;
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(async () => ({ text: "restored reply" }) satisfies ReplyPayload);
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:restored-test",
        ChatType: "channel",
        From: "discord:user:12345",
        To: "discord:channel:restored-test",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "start work",
        CommandBody: "start work",
        RawBody: "start work",
        CommandSource: undefined,
        InboundAccessAuthorized: true,
        InboundEventKind: "user_request",
        InputProvenance: { kind: "external_user", sourceChannel: "discord" },
      });

      const dispatch = dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        ...(sessionWorkerPlacementContext ? { sessionWorkerPlacementContext } : {}),
      });

      if (blocked) {
        await expect(dispatch).rejects.toThrow(/is archived/i);
        expect(sessionStoreMocks.currentEntry?.archivedAt).toBe(archivedAt);
        expect(sessionStoreMocks.currentEntry?.archivedBy).toEqual({
          type: "human",
          id: "profile-operator",
        });
        expect(replyResolver).not.toHaveBeenCalled();
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        return;
      }

      const result = await dispatch;
      expect(result.queuedFinal).toBe(true);
      expect(sessionStoreMocks.currentEntry?.sessionId).toBe(sessionId);
      expect(sessionStoreMocks.currentEntry?.archivedAt).toBeUndefined();
      expect(sessionStoreMocks.currentEntry?.archivedBy).toBeUndefined();
      if (suppliedOwner) {
        expect(ownerGetMany).toHaveBeenCalledWith([sessionId]);
        expect(placementContextMocks.resolveSessionWorkerPlacementContext).not.toHaveBeenCalled();
      }
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "restored reply" });
    },
  );

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
        ...(params.expectPluginReplyDelivered ? { observedReplyDelivery: true } : {}),
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

  it("lets the channel own forced tool progress at verbosity off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn(() => false);
    const payload = { text: "🧠 Memory Search: release notes" } satisfies ReplyPayload;
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
        forceToolResultProgress: true,
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onToolResult).toHaveBeenCalledOnce();
    expect(onToolResult).toHaveBeenCalledWith(payload);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "media",
      payload: { mediaUrl: "https://example.com/tool-result.png" },
    },
    {
      label: "captioned media",
      payload: {
        text: "Generated image",
        mediaUrl: "https://example.com/tool-result.png",
      },
    },
    {
      label: "exec approvals",
      payload: {
        text: "Approval required.",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      },
    },
    {
      label: "unavailable exec approvals",
      payload: {
        text: "Exec approval is unavailable.",
        channelData: {
          execApprovalUnavailable: { reason: "no-approval-route" },
        },
      },
    },
    {
      label: "ask-user prompts",
      payload: {
        text: "Question for you: Where should this deploy?",
        channelData: { askUser: { questionId: "question-owned-by-agent-runtime" } },
      },
    },
  ] satisfies Array<{ label: string; payload: ReplyPayload }>)(
    "keeps forced $label durable when channel progress is available",
    async ({ payload }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = {
        sessionId: "s1",
        updatedAt: 0,
        sendPolicy: "allow",
      };
      const dispatcher = createDispatcher();
      const onToolResult = vi.fn(() => false);
      const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        await opts?.onToolResult?.(payload);
        return { text: "NO_REPLY" } satisfies ReplyPayload;
      });

      await dispatchReplyFromConfig({
        ctx: buildTestCtx({ SessionKey: "test:session", ChatType: "channel" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          forceToolResultProgress: true,
          suppressDefaultToolProgressMessages: true,
          suppressToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onToolResult,
        },
      });

      expect(onToolResult).not.toHaveBeenCalled();
      expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

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
    const onToolResult = vi.fn(() => false);
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
        forceToolResultProgress: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolResult,
      },
    });

    expect(result.queuedFinal).toBe(false);
    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🛠️ Exec: echo post-restart" }),
    );
    expect(onToolResult).not.toHaveBeenCalled();
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
