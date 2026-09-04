// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  acpMocks,
  askUserMocks,
  createDispatcher,
  emptyConfig,
  hookMocks,
  mocks,
  replyMediaPathMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  automaticGroupReplyConfig,
  dispatchReplyFromConfig,
  setNoAbort,
  firstMockCall,
  firstToolResultPayload,
  firstRouteReplyCall,
  installThreadingTestPlugin,
  requireBlockReplyHandler,
  requireToolResultHandler,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { isReplyDispatchDeliveryError } from "./reply-dispatch-outcome.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

  it("honors sendPolicy deny for recovered exec-event delivery channel", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    sessionStoreMocks.currentEntry = {
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "telegram:999", accountId: "acc-1" },
      }),
    };
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { channel: "telegram" } }],
        },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = vi.fn(async () => ({ text: "hi" }) satisfies ReplyPayload);
    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingChannel?: unknown;
            originatingTo?: unknown;
            sendPolicy?: unknown;
            shouldRouteToOriginating?: unknown;
            suppressUserDelivery?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.sendPolicy).toBe("deny");
    expect(replyDispatchCall?.[0]?.suppressUserDelivery).toBe(true);
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("telegram");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("telegram:999");
    expect(typeof replyDispatchCall?.[1]).toBe("object");
  });

  it("falls back to thread-scoped session key when current ctx has no MessageThreadId", async () => {
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:discord:channel:CHAN1:thread:post-root",
      AccountId: "default",
      MessageThreadId: undefined,
      OriginatingChannel: "discord",
      OriginatingTo: "channel:CHAN1",
      ExplicitDeliverRoute: true,
    });

    expect(resolveRoutedDeliveryThreadId({ ctx, sessionKey: ctx.SessionKey })).toBe("post-root");
  });

  it("uses Slack DM TransportThreadId when ReplyToId is the current message", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:slack:direct:u123",
      AccountId: "default",
      ChatType: "direct",
      MessageSid: "101.000",
      ReplyToId: "101.000",
      TransportThreadId: "101.000",
      MessageThreadId: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "user:U123",
      ExplicitDeliverRoute: true,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const routeCall = firstRouteReplyCall() as { threadId?: string | number } | undefined;
    expect(routeCall?.threadId).toBe("101.000");
  });

  it("does not resurrect a cleared route thread from origin metadata", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "mattermost" });
    // Simulate the real store: lastThreadId and deliveryContext.threadId may be normalised from
    // origin.threadId on read, but a non-thread session key must still route to channel root.
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        channel: "mattermost",
        to: "channel:CHAN1",
        accountId: "default",
        threadId: "stale-root",
      },
      lastThreadId: "stale-root",
      origin: {
        threadId: "stale-root",
      },
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:mattermost:channel:CHAN1",
      AccountId: "default",
      MessageThreadId: undefined,
      OriginatingChannel: "mattermost",
      OriginatingTo: "channel:CHAN1",
      ExplicitDeliverRoute: true,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const routeCall = firstRouteReplyCall() as
      | { channel?: string; to?: string; threadId?: string | number }
      | undefined;
    expect(routeCall?.channel).toBe("mattermost");
    expect(routeCall?.to).toBe("channel:CHAN1");
    expect(routeCall?.threadId).toBeUndefined();
  });

  it("forces suppressTyping when routing to a different originating channel", async () => {
    setNoAbort();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      expect(opts?.typingPolicy).toBe("system_event");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
  });

  it("forces suppressTyping for internal webchat turns", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      OriginatingTo: "session:abc",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      expect(opts?.typingPolicy).toBe("internal_webchat");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
  });

  it("routes when provider is webchat but surface carries originating channel metadata", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as { channel?: unknown; to?: unknown } | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
  });

  it("routes Feishu replies when provider is webchat and origin metadata points to Feishu", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "feishu" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "ou_feishu_direct_123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as { channel?: unknown; to?: unknown } | undefined;
    expect(routeCall?.channel).toBe("feishu");
    expect(routeCall?.to).toBe("ou_feishu_direct_123");
  });

  it("does not route when provider already matches originating channel", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "webchat",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not route external origin replies when current surface is internal webchat without explicit delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "imessage" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15550001111",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("never lets a durable block intent route a private webchat turn to an inherited external recipient", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "imessage" });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15550001111",
    });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireBlockReplyHandler(opts?.onBlockReply)(
        { text: "Private dashboard update" },
        { deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:private" },
      );
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text: "Private dashboard update" });
  });

  it("never lets a durable block intent deliver directly from a parent-owned background session", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    sessionStoreMocks.currentEntry = {
      sessionId: "background-child",
      spawnedBy: "agent:main:parent",
    };
    acpMocks.readAcpSessionEntry.mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:background-child",
      entry: sessionStoreMocks.currentEntry,
      acp: {
        backend: "acpx",
        agent: "fixture",
        runtimeSessionName: "background-child",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });
    const dispatcher = createDispatcher();
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireBlockReplyHandler(opts?.onBlockReply)(
        { text: "Private delegated progress" },
        { deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:child" },
      );
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:background-child",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      }),
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("routes external origin replies for internal webchat turns when explicit delivery is set", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "imessage" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15550001111",
      ExplicitDeliverRoute: true,
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | { channel?: unknown; policyConversationType?: unknown; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("imessage");
    expect(routeCall?.policyConversationType).toBe("direct");
    expect(routeCall?.to).toBe("imessage:+15550001111");
  });

  it("passes a stable block delivery intent to routed durable delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const dispatcher = createDispatcher();
    const deliveryIntentId = "block-reply:v1:codex-app-server:thread-1:turn-1:item-1";
    const ctx = buildTestCtx({
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireBlockReplyHandler(opts?.onBlockReply)(
        { text: "durable background update" },
        { deliveryIntentId },
      );
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "durable background update" },
        replyKind: "block",
        deliveryIntentId,
      }),
    );
  });

  it("keeps same-channel stable block delivery on the resolved source account", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({
      id: "telegram",
      defaultAccountId: "default",
      resolveReplyToMode: ({ accountId }) => (accountId === "work" ? "off" : "all"),
    });
    sessionStoreMocks.currentEntry = { ttsAuto: "always" };
    const dispatcher = createDispatcher();
    const deliveryIntentId = "block-reply:v1:codex-app-server:thread-1:turn-1:item-same";
    let releaseCustody!: () => void;
    let markCustodyStarted!: () => void;
    const custodyStarted = new Promise<void>((resolve) => {
      markCustodyStarted = resolve;
    });
    const custodyGate = new Promise<void>((resolve) => {
      releaseCustody = resolve;
    });
    mocks.routeReply.mockImplementationOnce(async () => {
      markCustodyStarted();
      await custodyGate;
      return { ok: true, delivered: true, messageId: "durable" };
    });
    ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
      text: "durable background update",
      mediaUrl: "https://example.com/block-tts.opus",
      audioAsVoice: true,
    });
    const onBlockReplyQueued = vi.fn();
    let blockSettled = false;
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const block = Promise.resolve(
        requireBlockReplyHandler(opts?.onBlockReply)(
          { text: "durable background update" },
          { deliveryIntentId },
        ),
      ).then(() => {
        blockSettled = true;
      });
      await vi.waitFor(() => expect(mocks.routeReply).toHaveBeenCalledOnce());
      await custodyStarted;
      expect(blockSettled).toBe(false);
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      releaseCustody();
      await block;
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        AccountId: "work",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      }),
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyOptions: { onBlockReplyQueued },
      replyResolver,
    });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: "durable background update",
          mediaUrl: "https://example.com/block-tts.opus",
          audioAsVoice: true,
        }),
        accountId: "work",
        replyDelivery: { chatType: "direct", replyToMode: "off" },
        replyKind: "block",
        deliveryIntentId,
      }),
    );
    expect(onBlockReplyQueued).toHaveBeenCalledOnce();
  });

  it("keeps same-channel blocks without a stable intent on the dispatcher", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const dispatcher = createDispatcher();
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "ordinary block" });
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      }),
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text: "ordinary block" });
  });

  it("rejects failed same-channel stable admission and retries the same intent", async () => {
    setNoAbort();
    const deliveryIntentId = "block-reply:v1:codex-app-server:thread-1:turn-1:item-retry";
    mocks.routeReply
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        delivered: false,
        error: "durable queue unavailable",
      })
      .mockResolvedValueOnce({ ok: true, delivered: true, messageId: "retried" });
    installThreadingTestPlugin({ id: "telegram" });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });
    const dispatch = () =>
      dispatchReplyFromConfig({
        ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher,
        replyResolver: async (_ctx: MsgContext, opts?: GetReplyOptions) => {
          await requireBlockReplyHandler(opts?.onBlockReply)(
            { text: "retry this update" },
            { deliveryIntentId },
          );
          return undefined;
        },
      });

    await expect(dispatch()).rejects.toThrow("durable queue unavailable");
    await expect(dispatch()).resolves.toBeDefined();

    expect(mocks.routeReply).toHaveBeenCalledTimes(2);
    expect(mocks.routeReply.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ deliveryIntentId }),
      expect.objectContaining({ deliveryIntentId }),
    ]);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("returns durable routed block failures to the producing runtime", async () => {
    setNoAbort();
    mocks.routeReply.mockReset().mockResolvedValue({
      ok: false,
      delivered: false,
      error: "durable queue unavailable",
    });
    installThreadingTestPlugin({ id: "telegram" });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await requireBlockReplyHandler(opts?.onBlockReply)(
        { text: "retry this update" },
        { deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:item-2" },
      );
      return undefined;
    };

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher,
        replyResolver,
      }),
    ).rejects.toThrow("durable queue unavailable");
  });

  it("routes media-only tool results when summaries are suppressed", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      ChatType: "group",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-routed.opus"],
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { cfg?: unknown; messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.cfg).toBe(cfg);
    expect(normalizerOptions?.messageProvider).toBe("telegram");
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    const routed = firstRouteReplyCall() as { payload?: ReplyPayload } | undefined;
    expect(routed?.payload?.mediaUrls).toEqual(["https://example.com/tts-routed.opus"]);
    expect(routed?.payload?.text).toBeUndefined();
  });

  it("provides onToolResult in DM sessions", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "tool output" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "tool output" });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers ask_user prompts when verbose tool progress is disabled", async () => {
    setNoAbort();
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-owned-by-agent-runtime" } },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
    const toolDeliveryOrder =
      vi.mocked(dispatcher.sendToolResult).mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(
      vi
        .mocked(dispatcher.waitForIdle)
        .mock.invocationCallOrder.some((order) => order > toolDeliveryOrder),
    ).toBe(true);
  });

  it.each([
    ["cancelled", "cancelled", true, undefined],
    ["failed before transport", "failed-before-deliver", true, undefined],
    ["delivered", "delivered", false, undefined],
    ["failed during transport", "failed-deliver", true, "failed-deliver"],
  ] as const)(
    "settles ask_user delivery when the prompt is %s",
    async (_name, outcome, rejects, expectedOutcome) => {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      const deliver = vi.fn(async (_payload: ReplyPayload, info: { kind: string }) => {
        if (outcome === "failed-deliver" && info.kind === "tool") {
          throw new Error("transport failure");
        }
      });
      const dispatcher = createReplyDispatcher({
        deliver,
        beforeDeliver: async (candidate, info) => {
          if (info.kind !== "tool") {
            return candidate;
          }
          if (outcome === "cancelled") {
            return null;
          }
          if (outcome === "failed-before-deliver") {
            throw new Error("before-delivery failure");
          }
          return candidate;
        },
      });
      const payload = {
        text: "Question for you: Where should this deploy?",
        channelData: { askUser: { questionId: "question-not-delivered" } },
      } satisfies ReplyPayload;

      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "telegram", ChatType: "direct" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async (_ctx, opts) => {
          await requireToolResultHandler(opts?.onToolResult)(payload);
          return { text: "done" };
        },
      });

      if (expectedOutcome) {
        const error = await dispatch.catch((caught: unknown) => caught);
        expect(isReplyDispatchDeliveryError(error)).toBe(true);
        if (isReplyDispatchDeliveryError(error)) {
          expect(error.outcome).toBe(expectedOutcome);
        }
      } else if (rejects) {
        await expect(dispatch).rejects.toThrow();
      } else {
        await expect(dispatch).resolves.toMatchObject({ queuedFinal: true });
      }
    },
  );

  it("rejects ask_user prompts not delivered to the originating channel", async () => {
    setNoAbort();
    installThreadingTestPlugin({ id: "telegram" });
    mocks.routeReply.mockResolvedValue({ ok: false, delivered: false, error: "not delivered" });
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-not-routed" } },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await expect(
      dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver }),
    ).rejects.toThrow();
  });

  it("rejects ask_user prompts declined by the dispatcher", async () => {
    setNoAbort();
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-not-admitted" } },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.sendToolResult).mockReturnValue(false);
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await expect(
      dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver }),
    ).rejects.toThrow();
  });

  it("delivers approval-unavailable notices when verbose tool progress is disabled", async () => {
    setNoAbort();
    const payload = {
      text: "Exec approval is unavailable.",
      channelData: {
        execApprovalUnavailable: { reason: "no-approval-route" },
      },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("drops ask_user prompts that terminalize before dispatcher delivery", async () => {
    setNoAbort();
    askUserMocks.isAskUserPromptPending.mockResolvedValue(false);
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-terminal-before-delivery" } },
    } satisfies ReplyPayload;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(askUserMocks.isAskUserPromptPending).toHaveBeenCalledWith(
      "question-terminal-before-delivery",
    );
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("does not synthesize hidden text-only tool summaries into TTS media", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeToolAudio = true;
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "tool output" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool" }),
    );
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses late text-only tool results after final delivery starts", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "channel",
      IsForum: true,
      SessionKey: "agent:main:discord:channel:C1",
    });
    let lateToolResult: NonNullable<GetReplyOptions["onToolResult"]> | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      lateToolResult = requireToolResultHandler(opts?.onToolResult);
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    await lateToolResult?.({ text: "failed command output", isError: true });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("suppresses group tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      await onToolResult({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-group.opus"],
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: false },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrls).toEqual(["https://example.com/tts-group.opus"]);
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps group tool summaries suppressed when the channel omits the quiet-default flag", async () => {
    setNoAbort();
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("allows group tool summaries when session verbose is enabled without a channel quiet-default flag", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: ls");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("allows group tool summaries when the agent verbose default is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...automaticGroupReplyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } as const satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "matrix",
      Surface: "matrix",
      ChatType: "group",
      From: "matrix:group:!room:example.org",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: pwd" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: pwd");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps group tool summaries suppressed when session verbose is disabled", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = {
      ...automaticGroupReplyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } as const satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:456@g.us",
      SessionKey: "agent:main:whatsapp:group:456@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: date" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("allows group tool summaries when verbose is enabled during the run", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:789@g.us",
      SessionKey: "agent:main:whatsapp:group:789@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      sessionStoreMocks.currentEntry = {
        verboseLevel: "on",
      };
      await onToolResult({ text: "🔧 exec: whoami" });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: whoami");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("hides failed tool progress when verbose is disabled during the run", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:789@g.us",
      SessionKey: "agent:main:whatsapp:group:789@g.us",
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      sessionStoreMocks.currentEntry = {
        verboseLevel: "off",
      };
      await onToolResult({ text: "🔧 exec: failed", isError: true });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("forwards channel-owned group progress callbacks while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onPlanUpdate = vi.fn();
    const onApprovalEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onPatchSummary = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    const onToolResult = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onPlanUpdate?.({
        phase: "update",
        steps: ["Run command"] as never,
      });
      await opts?.onApprovalEvent?.({ phase: "requested", command: "pnpm test" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onPatchSummary?.({ phase: "end", summary: "1 modified" });
      await opts?.onCompactionStart?.();
      await opts?.onCompactionEnd?.();
      await opts?.onToolResult?.({ text: "exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        suppressDefaultToolProgressMessages: true,
        onToolStart,
        onItemEvent,
        onPlanUpdate,
        onApprovalEvent,
        onCommandOutput,
        onPatchSummary,
        onCompactionStart,
        onCompactionEnd,
        onToolResult,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onPlanUpdate).toHaveBeenCalledWith({
      phase: "update",
      steps: [{ step: "Run command", status: "pending" }],
    });
    expect(onApprovalEvent).toHaveBeenCalledWith({
      phase: "requested",
      command: "pnpm test",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(onPatchSummary).toHaveBeenCalledWith({ phase: "end", summary: "1 modified" });
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("forwards only opted-in tool lifecycle feedback while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onCompactionStart?.();
      await opts?.onCompactionEnd?.();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        allowToolLifecycleWhenProgressHidden: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
        onCompactionStart,
        onCompactionEnd,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not forward compaction lifecycle feedback while verbose is off by default", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    });
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onCompactionStart?.();
      await opts?.onCompactionEnd?.();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        onCompactionStart,
        onCompactionEnd,
      },
    });

    expect(onCompactionStart).not.toHaveBeenCalled();
    expect(onCompactionEnd).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers verbose inter-tool commentary as standalone progress messages before the tool summary", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    let commentaryEnabled: boolean | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "checking the config first",
      });
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(commentaryEnabled).toBe(true);
    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(2);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 checking the config first",
    );
    expect((sendToolResult.mock.calls[1]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "🔧 exec: ls",
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("starts a preamble item before a later partial callback", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const callbackOrder: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      void opts?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "checking first",
      });
      void opts?.onPartialReply?.({ text: "answer after preamble" });
      return { text: "done" };
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "whatsapp" }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        preserveProgressCallbackStartOrder: true,
        suppressDefaultToolProgressMessages: true,
        onItemEvent: () => {
          callbackOrder.push("item");
        },
        onPartialReply: () => {
          callbackOrder.push("partial");
        },
      },
    });

    expect(callbackOrder).toEqual(["item", "partial"]);
  });

  it("flushes trailing verbose commentary before the final reply", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "wrapping up",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    const sendFinalReply = dispatcher.sendFinalReply as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(1);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 wrapping up",
    );
    expect(sendFinalReply).toHaveBeenCalledTimes(1);
    expect(sendToolResult.mock.invocationCallOrder[0]).toBeLessThan(
      sendFinalReply.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("collapses snapshot updates for one commentary item into a single message", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "drafting" });
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "drafting a refined plan",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(1);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 drafting a refined plan",
    );
  });

  it("deduplicates identical commentary when producer item ids change", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "discord:user:123",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({
        itemId: "commentary-stream",
        kind: "preamble",
        progressText: "Checking the current state.",
      });
      await opts?.onItemEvent?.({
        itemId: "commentary-snapshot",
        kind: "preamble",
        progressText: "Checking the current state.",
      });
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(1);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 Checking the current state.",
    );
  });

  it("flushes the previous commentary block when a new item starts", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "first block" });
      await opts?.onItemEvent?.({ itemId: "c2", kind: "preamble", progressText: "second block" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const sendToolResult = dispatcher.sendToolResult as ReturnType<typeof vi.fn>;
    expect(sendToolResult).toHaveBeenCalledTimes(2);
    expect((sendToolResult.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 first block",
    );
    expect((sendToolResult.mock.calls[1]?.[0] as ReplyPayload | undefined)?.text).toBe(
      "💬 second block",
    );
  });

  it("drops retracted commentary that has not been delivered", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "scratch that" });
      await opts?.onItemEvent?.({ itemId: "c1", kind: "preamble", progressText: "" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps commentary out of standalone progress while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onItemEvent = vi.fn();

    let commentaryEnabled: boolean | undefined = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "quiet thought",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true, onItemEvent },
    });

    expect(commentaryEnabled).toBeUndefined();
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "c1",
      kind: "preamble",
      progressText: "quiet thought",
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
