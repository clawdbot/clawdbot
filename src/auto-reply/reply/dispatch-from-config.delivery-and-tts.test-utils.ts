import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
// Imported by a dispatch-from-config entrypoint to keep its mocked suite in one Vitest module graph.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/delivery-result.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { PluginTargetedInboundClaimOutcome } from "../../plugins/hooks.test-fixtures.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { needsTtsFallback } from "./dispatch-from-config.finalize.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  messageAuditMocks,
  mocks,
  replyMediaPathMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  dispatchReplyFromConfig,
  installCaptionedVoiceTestPlugin,
  setNoAbort,
  firstFinalReplyPayload,
  firstMockArg,
  dispatchTwiceWithFreshDispatchers,
  messageAuditEvents,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { withDispatchProcessedOutcomeSink } from "./dispatch-processed-outcome.js";
import { getPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { usesFullReplyRuntime } from "./reply-config-runtime-mode.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    describe0BeforeEach0();
  });
  afterEach(clearRuntimeConfigSnapshot);

  it("records channel transform suppression before TTS or visible fallback delivery", async () => {
    setNoAbort();
    const transport = vi.fn(async () => {});
    const transformReplyPayload = vi.fn(() => null);
    const dispatcher = createReplyDispatcher({ deliver: transport, transformReplyPayload });
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "agent:main:telegram:direct:123",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "private block" });
        return { text: "private reply" };
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(result).not.toHaveProperty("noVisibleReplyFallbackEligible");
    expect(result).not.toHaveProperty("noVisibleReplyFallbackDelivered");
    expect(transformReplyPayload).toHaveBeenCalledTimes(2);
    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", reason: "channel_transform" }),
    );
  });

  it.each([true, false])(
    "keeps a held native final with its delivery owner (primary=%s)",
    async (primary) => {
      setNoAbort();
      const error = Object.assign(
        new OutboundDeliveryError("still queued", {
          cause: new PlatformMessageNotDispatchedError("offline before dispatch", {
            cause: undefined,
          }),
        }),
        { queueCustody: "held" as const },
      );
      const deliver = vi.fn(async () => {
        throw error;
      });
      const dispatcher = createReplyDispatcher({ deliver, propagateRetryableNoSendFailure: true });
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => (primary ? { text: "Held answer." } : undefined),
      });
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(receipt).toMatchObject({ anyVisibleDelivered: false, hasPendingDelivery: true });
      expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    },
  );

  it("keeps a pending routed fallback ineligible for another fallback", async () => {
    setNoAbort();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: false, ambiguous: true });
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => undefined,
    });
    expect(mocks.routeReply).toHaveBeenCalledOnce();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.each([
    { name: "channel-owned final", outcomes: ["channel_transform"], fallback: false },
    { name: "ordinary invisible final", outcomes: ["no_visible_result"], fallback: true },
    {
      name: "later invisible final",
      outcomes: ["channel_transform", "no_visible_result"],
      fallback: true,
    },
    {
      name: "later cancelled final",
      outcomes: ["channel_transform", "cancelled"],
      fallback: true,
    },
    {
      name: "later pre-send failure",
      outcomes: ["channel_transform", "failed"],
      fallback: true,
    },
  ])("preserves post-hook suppression without masking $name", async ({ outcomes, fallback }) => {
    setNoAbort();
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      beforeDeliver: (payload) => {
        if (payload.text === "cancelled") {
          return null;
        }
        if (payload.text === "failed") {
          throw new Error("pre-send failure");
        }
        return { ...payload, text: `checked:${payload.text}` };
      },
      deliver: async (payload) => {
        delivered.push(payload);
        return {
          visibleReplySent: false,
          suppression: {
            reason:
              payload.text === "checked:channel_transform"
                ? "channel_transform"
                : "no_visible_result",
          },
        };
      },
    });
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:main:discord:direct:owner",
        CommandSource: "native",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(async () => outcomes.map((text) => ({ text }))),
    });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(
      delivered.filter((payload) => payload.text === "checked:channel_transform"),
    ).toHaveLength(outcomes.includes("channel_transform") ? 1 : 0);
    expect(delivered.some((payload) => payload.text?.includes("No reply was generated"))).toBe(
      fallback,
    );
    expect(result.noVisibleReplyFallbackEligible === true).toBe(fallback);
    expect(receipt?.anyVisibleDelivered).toBe(false);
  });

  it("does not dispatch a settled final reply after its session writer is replaced", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      lifecycleRevision: "revision-a",
      activeWriterRunId: "run-settled",
      updatedAt: 0,
    };
    const payload = setReplyPayloadMetadata(
      { text: "settled fallback" },
      {
        assistantTranscriptOwned: true,
        assistantTranscriptIdempotencyKey: "run-settled:settled-finalization-fallback",
        sessionWriterDeliveryAuthority: {
          expectedLifecycleRevision: "revision-a",
          expectedSessionId: "s1",
          expectedWriterRunId: "run-settled",
          sessionKey: "agent:main:telegram:direct:123",
          storePath: "/tmp/mock-sessions.json",
        },
      },
    );
    const dispatcher = createDispatcher();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "run-settled" },
      replyResolver: vi.fn(async () => {
        sessionStoreMocks.currentEntry = {
          ...sessionStoreMocks.currentEntry,
          activeWriterRunId: "replacement-run",
        };
        return payload;
      }),
    });

    expect(result).toMatchObject({ queuedFinal: false });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("keeps a block-only channel transform veto terminal", async () => {
    setNoAbort();
    const transport = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver: transport,
      transformReplyPayload: () => null,
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "private block" });
        return undefined;
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(result).not.toHaveProperty("noVisibleReplyFallbackEligible");
    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "channel_transform" }),
    );
  });

  it("lets a later accepted final override an earlier transform veto", async () => {
    setNoAbort();
    const transport = vi.fn(async () => {});
    const transformReplyPayload = vi.fn((payload: ReplyPayload) =>
      payload.text === "private reply" ? null : payload,
    );
    const dispatcher = createReplyDispatcher({ deliver: transport, transformReplyPayload });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(async () => [{ text: "private reply" }, { text: "public reply" }]),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(transformReplyPayload).toHaveBeenCalledTimes(2);
    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "public reply" }),
      { kind: "final" },
    );
    expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "channel_transform" }),
    );
  });

  it("keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "do not leak slash reply" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-command-escape-denied",
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
      ChatType: "channel",
      CommandSource: "text",
      CommandAuthorized: false,
      WasMentioned: false,
      CommandBody: "/codex detach",
      RawBody: "/codex detach",
      Body: "/codex detach",
      MessageSid: "msg-claim-plugin-command-denied",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith(
      "binding-command-escape-denied",
      undefined,
      expect.objectContaining({ channel: "discord", accountId: "default" }),
    );
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({ content: "/codex detach" }),
      expect.objectContaining({
        pluginBinding: expect.objectContaining({ bindingId: "binding-command-escape-denied" }),
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers plugin-owned binding replies returned by the owning inbound claim hook", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "codex", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "Codex native reply" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-reply-1",
      targetSessionKey: "plugin-binding:codex:reply123",
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
        pluginId: "codex",
        pluginRoot: "/plugins/codex",
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
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-reply",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      observedReplyDelivery: true,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Codex native reply" });
    expect(
      getReplyPayloadMetadata(
        firstMockArg(
          dispatcher.sendFinalReply as ReturnType<typeof vi.fn>,
          "plugin reply",
        ) as ReplyPayload,
      )?.sourceReplyTranscriptMirror,
    ).toBeUndefined();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("aborts plugin-bound completion while reply delivery is still settling", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "codex", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "Codex native reply" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-reply-abort-1",
      targetSessionKey: "plugin-binding:codex:reply-abort-123",
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
        pluginId: "codex",
        pluginRoot: "/plugins/codex",
      },
    } satisfies SessionBindingRecord);
    let markDeliveryStarted: (() => void) | undefined;
    let releaseDelivery: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryRelease = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        markDeliveryStarted?.();
        await deliveryRelease;
        throw new Error("delivery failed after abort");
      },
    });
    const abortController = new AbortController();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const dispatch = withDispatchProcessedOutcomeSink(() =>
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
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
          MessageSid: "msg-claim-plugin-reply-abort",
          SessionKey: "agent:main:discord:channel:1481858418548412579",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { abortSignal: abortController.signal },
        replyResolver,
      }),
    );

    await deliveryStarted;
    abortController.abort();
    try {
      const { result, processedOutcome } = await dispatch;

      expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } });
      expect(processedOutcome).toEqual({ outcome: "skipped", reason: "reply_operation_aborted" });
      expect(replyResolver).not.toHaveBeenCalled();
    } finally {
      releaseDelivery?.();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  });

  it("persists Gateway plugin-bound turns and routed replies in the binding session", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "codex", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "Codex bound reply" } },
    });
    const targetSessionKey = "plugin-binding:codex:history123";
    const targetSessionEntry = {
      sessionId: "bound-session-id",
      updatedAt: Date.now(),
    };
    sessionStoreMocks.currentEntry = {
      sessionId: "source-session-id",
      updatedAt: Date.now(),
    };
    sessionStoreMocks.entriesBySessionKey.set(targetSessionKey, targetSessionEntry);
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation((...args: unknown[]) => {
      const params = args[0] as { sessionKey: string };
      return (
        sessionStoreMocks.entriesBySessionKey.get(params.sessionKey) ??
        sessionStoreMocks.currentEntry
      );
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-history-1",
      targetSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "codex",
        pluginRoot: "/plugins/codex",
      },
    } satisfies SessionBindingRecord);
    const persistApproved = vi.fn(async () => ({
      appended: true,
      sessionFile: "sqlite:bound-session-id",
      sessionEntry: targetSessionEntry,
      messageId: "user-turn-1",
      message: { role: "user" as const, content: "continue", timestamp: Date.now() },
    }));
    const markBlocked = vi.fn();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        To: "user:U123",
        AccountId: "default",
        CommandAuthorized: true,
        BodyForAgent: "continue",
        RawBody: "continue",
        Body: "continue",
        MessageSid: "msg-plugin-history",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: {
        userTurnTranscriptRecorder: {
          hasPersisted: () => false,
          markBlocked,
          persistApproved,
        } as never,
      },
      replyResolver,
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      observedReplyDelivery: true,
    });
    expect(persistApproved).toHaveBeenCalledWith({
      target: expect.objectContaining({
        sessionId: "bound-session-id",
        sessionKey: targetSessionKey,
        sessionEntry: targetSessionEntry,
      }),
      expectedSessionId: "bound-session-id",
      retryIfUnpersisted: true,
    });
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Codex bound reply" },
        sessionKey: targetSessionKey,
        policySessionKey: targetSessionKey,
      }),
    );
    const routedCall = firstMockArg(mocks.routeReply, "plugin binding route") as {
      payload: ReplyPayload;
    };
    expect(getReplyPayloadMetadata(routedCall.payload)?.sourceReplyTranscriptMirror).toMatchObject({
      agentId: "main",
      expectedSessionId: "bound-session-id",
      sessionKey: targetSessionKey,
    });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();

    const rotatedTargetSessionEntry = {
      sessionId: "rotated-bound-session-id",
      updatedAt: Date.now(),
    };
    persistApproved.mockImplementationOnce(async () => {
      sessionStoreMocks.entriesBySessionKey.set(targetSessionKey, rotatedTargetSessionEntry);
      return undefined as never;
    });
    mocks.routeReply.mockClear();
    const rotatedDispatcher = createDispatcher();
    const rotatedResult = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        To: "user:U123",
        AccountId: "default",
        CommandAuthorized: true,
        BodyForAgent: "continue after reset",
        RawBody: "continue after reset",
        Body: "continue after reset",
        MessageSid: "msg-plugin-history-rotated",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher: rotatedDispatcher,
      replyOptions: {
        userTurnTranscriptRecorder: {
          hasPersisted: () => false,
          markBlocked,
          persistApproved,
        } as never,
      },
      replyResolver,
    });

    expect(rotatedResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      observedReplyDelivery: true,
    });
    const rotatedRoutedCall = firstMockArg(mocks.routeReply, "rotated plugin binding route") as {
      payload: ReplyPayload;
      sessionKey: string;
    };
    expect(rotatedRoutedCall.sessionKey).toBe(targetSessionKey);
    expect(rotatedRoutedCall.payload).toEqual({ text: "Codex bound reply" });
    expect(
      getReplyPayloadMetadata(rotatedRoutedCall.payload)?.sourceReplyTranscriptMirror,
    ).toMatchObject({
      expectedSessionId: "rotated-bound-session-id",
      sessionKey: targetSessionKey,
    });
    expect(markBlocked).not.toHaveBeenCalled();
    expect(rotatedDispatcher.sendFinalReply).not.toHaveBeenCalled();

    persistApproved.mockResolvedValueOnce(undefined as never);
    mocks.routeReply.mockClear();
    const blockedDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        To: "user:U123",
        AccountId: "default",
        CommandAuthorized: true,
        BodyForAgent: "continue during second reset",
        RawBody: "continue during second reset",
        Body: "continue during second reset",
        MessageSid: "msg-plugin-history-blocked",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher: blockedDispatcher,
      replyOptions: {
        userTurnTranscriptRecorder: {
          hasPersisted: () => false,
          markBlocked,
          persistApproved,
        } as never,
      },
      replyResolver,
    });

    const blockedRoutedCall = firstMockArg(mocks.routeReply, "blocked plugin binding route") as {
      payload: ReplyPayload;
      sessionKey: string;
    };
    expect(blockedRoutedCall.sessionKey).toBe(targetSessionKey);
    expect(
      getReplyPayloadMetadata(blockedRoutedCall.payload)?.sourceReplyTranscriptMirror,
    ).toMatchObject({
      expectedSessionId: "rotated-bound-session-id",
      sessionKey: targetSessionKey,
      transcriptWriteBlocked: true,
    });
    expect(markBlocked).toHaveBeenCalledTimes(1);
    expect(blockedDispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "handled reply route delivers",
      claimOutcome: {
        status: "handled",
        result: { handled: true, reply: { text: "Codex routed reply" } },
      },
      routeResult: { ok: true, delivered: true, messageId: "routed-binding-1" },
      processedReason: "plugin-bound-handled",
      expectObservedDelivery: true,
    },
    {
      name: "handled reply route delivers before abort",
      claimOutcome: {
        status: "handled",
        result: { handled: true, reply: { text: "Codex routed reply" } },
      },
      routeResult: { ok: true, delivered: true, messageId: "routed-binding-aborted-1" },
      processedReason: "reply_operation_aborted",
      expectObservedDelivery: true,
      abortAfterRoute: true,
    },
    {
      name: "handled reply route is hook-suppressed",
      claimOutcome: {
        status: "handled",
        result: { handled: true, reply: { text: "Codex routed reply" } },
      },
      routeResult: { ok: true, delivered: false, suppressed: true },
      processedReason: "plugin-bound-handled",
      expectObservedDelivery: false,
    },
    {
      name: "handled reply route fails",
      claimOutcome: {
        status: "handled",
        result: { handled: true, reply: { text: "Codex routed reply" } },
      },
      routeResult: { ok: false, delivered: false, error: "transport down" },
      processedReason: "plugin-bound-handled",
      expectObservedDelivery: false,
    },
    {
      name: "declined notice route delivers",
      claimOutcome: { status: "declined" },
      routeResult: { ok: true, delivered: true, messageId: "routed-declined-1" },
      processedReason: "plugin-bound-declined",
      expectObservedDelivery: true,
    },
    {
      name: "declined notice route is hook-suppressed",
      claimOutcome: { status: "declined" },
      routeResult: { ok: true, delivered: false, suppressed: true },
      processedReason: "plugin-bound-declined",
      expectObservedDelivery: false,
    },
    {
      name: "declined notice route fails",
      claimOutcome: { status: "declined" },
      routeResult: { ok: false, delivered: false, error: "transport down" },
      processedReason: "plugin-bound-declined",
      expectObservedDelivery: false,
    },
    {
      name: "error notice route delivers",
      claimOutcome: { status: "error", error: "boom" },
      routeResult: { ok: true, delivered: true, messageId: "routed-error-1" },
      processedReason: "plugin-bound-error",
      expectObservedDelivery: true,
    },
    {
      name: "error notice route is hook-suppressed",
      claimOutcome: { status: "error", error: "boom" },
      routeResult: { ok: true, delivered: false, suppressed: true },
      processedReason: "plugin-bound-error",
      expectObservedDelivery: false,
    },
    {
      name: "error notice route fails",
      claimOutcome: { status: "error", error: "boom" },
      routeResult: { ok: false, delivered: false, error: "transport down" },
      processedReason: "plugin-bound-error",
      expectObservedDelivery: false,
    },
  ] satisfies Array<{
    name: string;
    claimOutcome: PluginTargetedInboundClaimOutcome;
    routeResult: {
      ok: boolean;
      delivered: boolean;
      messageId?: string;
      suppressed?: boolean;
      error?: string;
    };
    processedReason: string;
    expectObservedDelivery: boolean;
    abortAfterRoute?: boolean;
  }>)(
    "attests observed delivery only when the routed binding turn delivered: $name",
    async (params) => {
      setNoAbort();
      hookMocks.runner.hasHooks.mockImplementation(
        ((hookName?: string) =>
          hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
      );
      hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
      hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue(params.claimOutcome);
      const abortController = new AbortController();
      mocks.routeReply.mockImplementation(async () => {
        if (params.abortAfterRoute) {
          abortController.abort();
        }
        return params.routeResult;
      });
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: "binding-routed-attest-1",
        targetSessionKey: "plugin-binding:codex:routed-attest",
        targetKind: "session",
        conversation: {
          channel: "slack",
          accountId: "default",
          conversationId: "user:U123",
        },
        status: "active",
        boundAt: 1710000000000,
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/plugins/codex",
        },
      } satisfies SessionBindingRecord);
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

      const { result, processedOutcome } = await withDispatchProcessedOutcomeSink(() =>
        dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Provider: "openclaw",
            Surface: "openclaw",
            OriginatingChannel: "slack",
            OriginatingTo: "user:U123",
            To: "user:U123",
            AccountId: "default",
            CommandAuthorized: true,
            Body: "continue",
            RawBody: "continue",
            MessageSid: `msg-routed-attest-${params.name.replace(/\s+/g, "-")}`,
            SessionKey: "agent:main:main",
          }),
          cfg: emptyConfig,
          dispatcher,
          replyOptions: { abortSignal: abortController.signal },
          replyResolver,
        }),
      );

      // A hook-suppressed or failed route reached no recipient, so the result
      // must stay warning-eligible instead of reading as a visible delivery.
      expect(result).toEqual({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        ...(params.expectObservedDelivery ? { observedReplyDelivery: true } : {}),
      });
      expect(processedOutcome).toEqual({
        outcome: params.abortAfterRoute ? "skipped" : "completed",
        reason: params.processedReason,
      });
      expect(mocks.routeReply).toHaveBeenCalledTimes(1);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(replyResolver).not.toHaveBeenCalled();
    },
  );

  it("routes plugin-owned Discord DM bindings to the owning plugin before generic inbound claim broadcast", async () => {
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
      bindingId: "binding-dm-1",
      targetSessionKey: "plugin-binding:codex:dm123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
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
      From: "discord:1177378744822943744",
      OriginatingTo: "channel:1480574946919846079",
      To: "channel:1480574946919846079",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-dm-1",
      SessionKey: "agent:main:discord:user:1177378744822943744",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith(
      "binding-dm-1",
      undefined,
      expect.objectContaining({ channel: "discord", accountId: "default" }),
    );
    const inboundClaimCall = hookMocks.runner.runInboundClaimForPluginOutcome.mock
      .calls[0] as unknown as
      | [
          unknown,
          { accountId?: unknown; channel?: unknown; content?: unknown; conversationId?: unknown },
          { accountId?: unknown; channelId?: unknown; conversationId?: unknown },
        ]
      | undefined;
    expect(inboundClaimCall?.[0]).toBe("openclaw-codex-app-server");
    expect(inboundClaimCall?.[1]?.channel).toBe("discord");
    expect(inboundClaimCall?.[1]?.accountId).toBe("default");
    expect(inboundClaimCall?.[1]?.conversationId).toBe("1480574946919846079");
    expect(inboundClaimCall?.[1]?.content).toBe("who are you");
    expect(inboundClaimCall?.[2]?.channelId).toBe("discord");
    expect(inboundClaimCall?.[2]?.accountId).toBe("default");
    expect(inboundClaimCall?.[2]?.conversationId).toBe("1480574946919846079");
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("notifies once per binding owner when a bound plugin is missing", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "missing_plugin",
    });
    const binding: SessionBindingRecord = {
      bindingId: "binding-missing-1",
      targetSessionKey: "plugin-binding:codex:missing123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:missing-plugin",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex_detach",
      },
    };

    const cases = [
      { channel: "discord", accountId: "default", notice: true },
      { channel: "discord", accountId: "default", notice: false },
      { channel: "telegram", accountId: "default", notice: true },
      { channel: "discord", accountId: "work", notice: true },
    ];
    for (const [index, { channel, accountId, notice }] of cases.entries()) {
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        ...binding,
        conversation: { ...binding.conversation, channel, accountId },
      });
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(
        async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload,
      );
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: channel,
          Surface: channel,
          OriginatingChannel: channel,
          OriginatingTo: `${channel}:channel:missing-plugin`,
          To: `${channel}:channel:missing-plugin`,
          AccountId: accountId,
          MessageSid: `msg-missing-plugin-${index}`,
          SessionKey: `agent:main:${channel}:${accountId}:channel:missing-plugin`,
          CommandBody: "hello",
          RawBody: "hello",
          Body: "hello",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      });

      if (notice) {
        const payload = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock
          .calls[0]?.[0] as ReplyPayload | undefined;
        expect(payload?.text).toContain("is not currently loaded.");
      } else {
        expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
      }
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    }
  });

  it("falls back to OpenClaw when the bound plugin is loaded but has no inbound_claim handler", async () => {
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
      bindingId: "binding-no-handler-1",
      targetSessionKey: "plugin-binding:codex:nohandler123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:no-handler",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:no-handler",
        To: "discord:channel:no-handler",
        AccountId: "default",
        MessageSid: "msg-no-handler-1",
        SessionKey: "agent:main:discord:channel:no-handler",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const notice = firstMockArg(
      dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
      "tool result",
    ) as ReplyPayload | undefined;
    expect(notice?.text).toContain("is not currently loaded.");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin declines the turn and keeps the binding attached", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "declined",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-declined-1",
      targetSessionKey: "plugin-binding:codex:declined123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:declined",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex_detach",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:declined",
        To: "discord:channel:declined",
        AccountId: "default",
        MessageSid: "msg-declined-1",
        SessionKey: "agent:main:discord:channel:declined",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request was declined.");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin errors and keeps raw details out of the reply", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "error",
      error: "boom",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-error-1",
      targetSessionKey: "plugin-binding:codex:error123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:error",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:error",
        To: "discord:channel:error",
        AccountId: "default",
        MessageSid: "msg-error-1",
        SessionKey: "agent:main:discord:channel:error",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: { diagnostics: { enabled: true } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request failed.");
    expect(finalNotice?.text).not.toContain("boom");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        outcome: "failed",
        errorCode: "message_processing_failed",
        reasonCode: "plugin_bound_error",
      }),
    );
    expect(messageAuditEvents()[0]).not.toHaveProperty("error");
    expect(JSON.stringify(messageAuditEvents()[0])).not.toContain("boom");
    const diagnosticEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { outcome?: unknown; reason?: unknown })
      .find((event) => event.reason === "plugin-bound-error");
    expect(diagnosticEvent?.outcome).toBe("completed");
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      AccountId: "default",
      MessageSid: "msg-dup",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const skippedEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { channel?: unknown; outcome?: unknown; reason?: unknown })
      .find((event) => event.outcome === "skipped");
    expect(skippedEvent?.channel).toBe("whatsapp");
    expect(skippedEvent?.reason).toBe("duplicate");
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(2);
    const skippedAuditEvent = messageAuditEvents().find((event) => event.outcome === "skipped");
    expect(skippedAuditEvent).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        status: "blocked",
        actorType: "system",
        actorId: "gateway",
        direction: "inbound",
        channel: "whatsapp",
        outcome: "skipped",
        reasonCode: "duplicate",
      }),
    );
    expect(skippedAuditEvent).not.toHaveProperty("reason");
  });

  it("keeps duplicate skip diagnostics inside the active inbound trace", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      AccountId: "default",
      MessageSid: "msg-dup-trace",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);
    const inboundTrace = createDiagnosticTraceContext();
    const processedTraces: Array<{
      outcome?: unknown;
      reason?: unknown;
      traceId?: string;
      spanId?: string;
    }> = [];

    diagnosticMocks.logMessageProcessed.mockImplementation((event) => {
      const activeTrace = getActiveDiagnosticTraceContext();
      processedTraces.push({
        outcome: event.outcome,
        reason: event.reason,
        traceId: activeTrace?.traceId,
        spanId: activeTrace?.spanId,
      });
    });

    try {
      await runWithDiagnosticTraceContext(inboundTrace, () =>
        dispatchTwiceWithFreshDispatchers({
          ctx,
          cfg,
          replyResolver,
        }),
      );
    } finally {
      diagnosticMocks.logMessageProcessed.mockReset();
    }

    const skippedEvent = processedTraces.find((event) => event.outcome === "skipped");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(skippedEvent?.reason).toBe("duplicate");
    expect(skippedEvent?.traceId).toBe(inboundTrace.traceId);
    expect(skippedEvent?.spanId).toBe(inboundTrace.spanId);
  });

  it("releases inbound dedupe when dispatch fails before completion", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550124",
      To: "whatsapp:+15555550124",
      AccountId: "default",
      MessageSid: "msg-dup-error",
      SessionKey: "agent:main:whatsapp:direct:+15555550124",
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
    });
    const replyResolver = vi
      .fn<
        (_ctx: MsgContext, _opts?: GetReplyOptions, _cfg?: OpenClawConfig) => Promise<ReplyPayload>
      >()
      .mockRejectedValueOnce(new Error("dispatch failed"))
      .mockResolvedValueOnce({ text: "retry succeeds" });

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher: createDispatcher(),
        replyResolver,
      }),
    ).rejects.toThrow("dispatch failed");

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(2);
    const errorEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { channel?: unknown; error?: unknown; outcome?: unknown })
      .find((event) => event.outcome === "error");
    expect(errorEvent?.channel).toBe("whatsapp");
    expect(errorEvent?.error).toBe("Error: dispatch failed");
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(2);
    const failedAuditEvent = messageAuditEvents().find((event) => event.outcome === "failed");
    expect(failedAuditEvent).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        status: "failed",
        direction: "inbound",
        channel: "whatsapp",
        outcome: "failed",
        errorCode: "message_processing_failed",
      }),
    );
    expect(failedAuditEvent).not.toHaveProperty("error");
    expect(JSON.stringify(failedAuditEvent)).not.toContain("dispatch failed");
  });

  it.each([
    {
      name: "poisons inbound dedupe when dispatch fails after a block reply",
      phone: "+15555550125",
      messageSid: "msg-dup-block-error",
      kind: "block",
      text: "partial answer",
      error: "provider failed after block",
    },
    {
      name: "poisons inbound dedupe when dispatch fails after a suppressed tool result",
      phone: "+15555550126",
      messageSid: "msg-dup-tool-error",
      kind: "tool",
      text: "tool touched external state",
      error: "provider failed after tool",
    },
  ] as const)("$name", async ({ phone, messageSid, kind, text, error }) => {
    setNoAbort();
    if (kind === "tool") {
      sessionStoreMocks.currentEntry = { sessionId: "s1", updatedAt: 0, sendPolicy: "deny" };
    }
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: `whatsapp:${phone}`,
      To: `whatsapp:${phone}`,
      AccountId: "default",
      MessageSid: messageSid,
      SessionKey: `agent:main:whatsapp:direct:${phone}`,
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
    });
    const firstDispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions): Promise<ReplyPayload | undefined> => {
        if (kind === "block") {
          await opts?.onBlockReply?.({ text });
        } else {
          await opts?.onToolResult?.({ text });
        }
        throw new Error(error);
      },
    );

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher: firstDispatcher,
        replyResolver,
      }),
    ).rejects.toThrow(error);
    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    if (kind === "block") {
      expect(firstDispatcher.sendBlockReply).toHaveBeenCalledWith({ text });
    } else {
      expect(firstDispatcher.sendToolResult).not.toHaveBeenCalled();
    }
    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("applies configOverride as a patch over the runtime config for replyResolver", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "msteams", Surface: "msteams" });
    const runtimeCfg = {
      agents: { defaults: { userTimezone: "UTC" } },
      messages: { responsePrefix: "[test]" },
    } satisfies OpenClawConfig;
    const preparedRuntimeModule = await import("../../agents/prepared-model-runtime.js");
    const preparedLookup = vi
      .spyOn(preparedRuntimeModule, "loadPublishedGatewayReplyDispatchRuntime")
      .mockResolvedValue(
        Object.freeze({
          agentId: "main",
          agentDir: "/tmp/prepared-agent",
          workspaceDir: "/tmp/prepared-workspace",
          config: runtimeCfg,
          modelCatalog: { entries: [], routeVariants: [] },
          inboundPluginRegistry: createTestRegistry([]),
          pluginGeneration: {} as never,
        }),
      );

    const overrideCfg = {
      agents: { defaults: { userTimezone: "America/New_York" } },
    } as OpenClawConfig;

    let receivedCfg: OpenClawConfig | undefined;
    let receivedPreparedRuntime: unknown;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
      preparedRuntime?: unknown,
    ) => {
      receivedCfg = cfgArg;
      receivedPreparedRuntime = preparedRuntime;
      return { text: "hi" } satisfies ReplyPayload;
    };

    try {
      await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyResolver,
        configOverride: overrideCfg,
        usePublishedModelRuntime: true,
      });
    } finally {
      preparedLookup.mockRestore();
    }

    expect(receivedCfg).not.toBe(cfg);
    expect(receivedCfg).not.toBe(overrideCfg);
    expect(receivedCfg).toMatchObject({
      agents: { defaults: { userTimezone: "America/New_York" } },
      messages: { responsePrefix: "[test]" },
    });
    expect(receivedPreparedRuntime).toBeUndefined();
  });

  it("keeps the caller config exact before a runtime snapshot is published", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
    } as OpenClawConfig;
    let receivedCfg: OpenClawConfig | undefined;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "discord", Surface: "discord" }),
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, _opts, cfgArg) => {
        receivedCfg = cfgArg;
        return { text: "hi" };
      },
    });

    expect(receivedCfg).toBe(cfg);
    expect(usesFullReplyRuntime(receivedCfg)).toBe(true);
  });

  it("does not independently reread the committed runtime config snapshot", async () => {
    setNoAbort();
    const runtimeCfg = {
      agents: { defaults: { userTimezone: "America/New_York" } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeCfg);
    let receivedCfg: OpenClawConfig | undefined;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "discord", Surface: "discord" }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, _opts, cfgArg) => {
        receivedCfg = cfgArg;
        return { text: "hi" };
      },
    });

    expect(receivedCfg).toBe(emptyConfig);
    expect(receivedCfg).not.toBe(runtimeCfg);
    expect(usesFullReplyRuntime(receivedCfg)).toBe(true);
  });

  it("keeps a channel-captured config full when no prepared runtime exists", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
    } as OpenClawConfig;
    let receivedCfg: OpenClawConfig | undefined;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
      cfg,
      dispatcher: createDispatcher(),
      usePublishedModelRuntime: true,
      replyResolver: async (_ctx, _opts, cfgArg) => {
        receivedCfg = cfgArg;
        return { text: "hi" };
      },
    });

    expect(receivedCfg).toBe(cfg);
    expect(usesFullReplyRuntime(receivedCfg)).toBe(true);
  });

  it("drops a removed Firecrawl SecretRef from Discord replies after config reload", async () => {
    setNoAbort();
    const cfg = {
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: {
                  source: "file",
                  provider: "default",
                  id: "/firecrawl/api-key",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeCfg = {
      agents: { defaults: { userTimezone: "America/Edmonton" } },
    } as OpenClawConfig;
    const preparedRuntimeModule = await import("../../agents/prepared-model-runtime.js");
    const preparedLookup = vi
      .spyOn(preparedRuntimeModule, "loadPublishedGatewayReplyDispatchRuntime")
      .mockResolvedValue(
        Object.freeze({
          agentId: "main",
          agentDir: "/tmp/prepared-agent",
          workspaceDir: "/tmp/prepared-workspace",
          config: runtimeCfg,
          modelCatalog: { entries: [], routeVariants: [] },
          inboundPluginRegistry: createTestRegistry([]),
          pluginGeneration: {} as never,
        }),
      );
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "discord", Surface: "discord" });

    let receivedCfg: OpenClawConfig | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
    ) => {
      receivedCfg = getPreparedReplyDispatchRuntime()?.config ?? cfgArg;
      if (receivedCfg?.plugins?.entries?.firecrawl) {
        throw new Error("stale Firecrawl SecretRef reached reply resolution");
      }
      return { text: "hi" } satisfies ReplyPayload;
    };

    try {
      await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyResolver,
        usePublishedModelRuntime: true,
      });
    } finally {
      preparedLookup.mockRestore();
    }

    expect(receivedCfg).toBe(runtimeCfg);
    expect(receivedCfg?.plugins?.entries?.firecrawl).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "hi" });
  });

  it.each([
    [
      "suppresses isReasoning payloads from final replies (WhatsApp channel)",
      "whatsapp",
      "reasoning",
      "final",
      false,
    ],
    [
      "delivers isReasoning final replies when the channel opts in",
      "telegram",
      "reasoning",
      "final",
      true,
    ],
    [
      "suppresses isCommentary payloads from final replies by default",
      "whatsapp",
      "commentary",
      "final",
      false,
    ],
    [
      "delivers isCommentary final replies when the channel opts in",
      "discord",
      "commentary",
      "final",
      true,
    ],
    [
      "does not synthesize opted-in final reasoning payloads into TTS media",
      "telegram",
      "reasoning",
      "final-tts",
      true,
    ],
    [
      "does not synthesize opted-in final commentary payloads into TTS media",
      "discord",
      "commentary",
      "final-tts",
      true,
    ],
    [
      "suppresses isReasoning payloads from block replies (generic dispatch path)",
      "whatsapp",
      "reasoning",
      "block",
      false,
    ],
    [
      "delivers opted-in block reasoning payloads without applying TTS",
      "telegram",
      "reasoning",
      "block",
      true,
    ],
    [
      "suppresses isCommentary payloads from block replies by default",
      "whatsapp",
      "commentary",
      "block",
      false,
    ],
    [
      "delivers opted-in block commentary payloads without applying TTS",
      "discord",
      "commentary",
      "block",
      true,
    ],
  ] as const)("%s", async (_name, provider, kind, delivery, enabled) => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = delivery === "final-tts";
    const dispatcher = createDispatcher();
    const progressPayload =
      kind === "reasoning"
        ? ({ text: "thinking...", isReasoning: true } satisfies ReplyPayload)
        : ({ text: "commentary...", isCommentary: true } satisfies ReplyPayload);
    const answer = { text: "The answer is 42" } satisfies ReplyPayload;
    const replyOptions =
      kind === "reasoning"
        ? { reasoningPayloadsEnabled: true }
        : { commentaryPayloadsEnabled: true };
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      if (delivery === "block") {
        await opts?.onBlockReply?.(progressPayload);
        await opts?.onBlockReply?.(answer);
        return enabled ? undefined : answer;
      }
      return delivery === "final-tts" ? progressPayload : [progressPayload, answer];
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: provider, Surface: provider }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: enabled ? replyOptions : undefined,
      replyResolver,
    });

    if (delivery === "block") {
      const blockCalls = vi.mocked(dispatcher.sendBlockReply).mock.calls;
      const delivered = blockCalls.map(([payload]) => payload.text);
      expect(delivered).toEqual(enabled ? [progressPayload.text, answer.text] : [answer.text]);
      if (enabled) {
        const blockTts = ttsMocks.maybeApplyTtsToPayload.mock.calls
          .map(([call]) => call as { kind?: unknown; payload?: ReplyPayload })
          .filter((call) => call.kind === "block");
        expect(blockTts.map((call) => call.payload?.text)).toEqual([answer.text]);
      }
    } else if (delivery === "final-tts") {
      expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(progressPayload);
    } else {
      const finalCalls = vi.mocked(dispatcher.sendFinalReply).mock.calls;
      const delivered = finalCalls.map(([payload]) => payload.text);
      expect(delivered).toEqual(enabled ? [progressPayload.text, answer.text] : [answer.text]);
    }
  });

  it("does not redeliver a final that already settled as an identical block", async () => {
    setNoAbort();
    const delivered: Array<{ kind: string; text?: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "rewritten command answer" });
      return { text: "rewritten command answer" };
    };

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ kind: "block", text: "rewritten command answer" }]);
    expect(result.counts).toEqual({ tool: 0, block: 1, final: 0 });
  });

  it("keeps the final fallback when an identical block is proven unsent", async () => {
    setNoAbort();
    const delivered: Array<{ kind: string; text?: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        if (info.kind === "block") {
          throw new PlatformMessageNotDispatchedError("block delivery failed before dispatch", {
            cause: undefined,
          });
        }
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "retry this final" });
      return { text: "retry this final" };
    };

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ kind: "final", text: "retry this final" }]);
    expect(result.counts).toEqual({ tool: 0, block: 1, final: 1 });
  });

  it("does not send the final fallback when aborted during block settlement", async () => {
    setNoAbort();
    let markBlockStarted: (() => void) | undefined;
    let releaseBlock: (() => void) | undefined;
    const blockStarted = new Promise<void>((resolve) => {
      markBlockStarted = resolve;
    });
    const blockRelease = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const delivered: Array<{ kind: string; text?: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        if (info.kind === "block") {
          markBlockStarted?.();
          await blockRelease;
          throw new Error("block delivery failed after abort");
        }
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });
    const abortController = new AbortController();
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "cancelled rewritten answer" });
      return { text: "cancelled rewritten answer" };
    };

    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver,
    });
    await blockStarted;
    abortController.abort();
    await dispatch;
    expect(delivered).toEqual([]);

    releaseBlock?.();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
  });

  it("keeps final-only TTS media after deduping identical block text", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, payload });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "spoken rewritten answer" });
      return { text: "spoken rewritten answer" };
    };

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([
      { kind: "block", payload: { text: "spoken rewritten answer" } },
      {
        kind: "final",
        payload: expect.objectContaining({
          text: undefined,
          mediaUrl: "https://example.com/tts-synth.opus",
          audioAsVoice: true,
        }),
      },
    ]);
    expect(result.counts).toEqual({ tool: 0, block: 1, final: 1 });
  });

  it("strips split TTS directives from streamed block text before delivery", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Intro [[tts:te" });
      await opts?.onBlockReply?.({ text: "xt]]hidden[[/tts:text]] visible" });
      return undefined;
    };
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(blockReplySentTexts).toEqual(["Intro ", " visible"]);
    expect(blockReplySentTexts.join("")).not.toContain("[[tts");
    expect(blockReplySentTexts.join("")).not.toContain("hidden");
    const ttsCall = ttsMocks.maybeApplyTtsToPayload.mock.calls
      .map(([call]) => call as { kind?: unknown; payload?: ReplyPayload })
      .find((call) => call.kind === "final");
    expect(ttsCall?.kind).toBe("final");
    expect(ttsCall?.payload).toEqual({ text: "Intro [[tts:text]]hidden[[/tts:text]] visible" });
    const finalPayload = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalPayload?.mediaUrl).toBe("https://example.com/tts-synth.opus");
  });

  it("forwards generated-media block replies in WhatsApp group sessions", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:120363111111111@g.us",
      To: "whatsapp:120363111111111@g.us",
      SessionKey: "agent:main:whatsapp:group:120363111111111@g.us",
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({
        text: "generated",
        mediaUrls: ["https://example.com/generated.png"],
      });
      return { text: "NO_REPLY" };
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendBlockReply).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({
      text: "generated",
      mediaUrls: ["https://example.com/generated.png"],
    });
  });

  it("signals block boundaries after async block delivery is admitted", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const callOrder: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return undefined;
    };

    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        callOrder.push(`dispatch:${payload.text}`);
        return true;
      },
    );

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        onBlockReplyQueued: (payload) => {
          callOrder.push(`queued:${payload.text}`);
        },
      },
    });

    expect(callOrder).toEqual(["dispatch:The answer is 42", "queued:The answer is 42"]);
  });

  it("does not wait for same-channel block dispatcher delivery before resolving block replies", async () => {
    setNoAbort();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    let blockReplySettled = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const blockReplyPromise = Promise.resolve(opts?.onBlockReply?.({ text: "before tool" })).then(
        () => {
          blockReplySettled = true;
        },
      );

      await deliveryStarted;

      expect(delivered).toEqual([{ text: "before tool" }]);
      await blockReplyPromise;
      expect(blockReplySettled).toBe(true);

      releaseDelivery?.();
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(blockReplySettled).toBe(true);
    await dispatcher.waitForIdle();
  });

  it("waits for pending same-channel block delivery before completing block-only dispatch", async () => {
    setNoAbort();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "only block" });
      return undefined;
    };

    let dispatchSettled = false;
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });

    await deliveryStarted;

    expect(delivered).toEqual([{ text: "only block" }]);
    expect(dispatchSettled).toBe(false);

    releaseDelivery?.();
    await dispatchPromise;

    expect(dispatchSettled).toBe(true);
  });

  it("waits for pending same-channel block delivery before forwarding tool progress", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { verboseDefault: "on" } },
    } as const satisfies OpenClawConfig;
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const progressOrder: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        if (payload.text === "final") {
          progressOrder.push("final");
        }
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const onToolStart = vi.fn();
    onToolStart.mockImplementation(() => {
      progressOrder.push("tool");
    });
    const onPartialReply = vi.fn(() => {
      progressOrder.push("partial");
    });
    let toolProgressSettled = false;
    let toolProgressPromise: Promise<void> | undefined;
    let partialProgressPromise: Promise<void> | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "before tool" });
      toolProgressPromise = Promise.resolve(opts?.onToolStart?.({ name: "lookup" })).then(() => {
        toolProgressSettled = true;
      });
      partialProgressPromise = Promise.resolve(opts?.onPartialReply?.({ text: "after tool" })).then(
        () => undefined,
      );
      return { text: "final" };
    };

    let dispatchSettled = false;
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        preserveProgressCallbackStartOrder: true,
        onPartialReply,
        onToolStart,
      },
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });

    await deliveryStarted;
    expect(delivered).toEqual([{ text: "before tool" }]);
    expect(onToolStart).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(toolProgressSettled).toBe(false);
    expect(dispatchSettled).toBe(false);

    releaseDelivery?.();
    await Promise.all([dispatchPromise, toolProgressPromise, partialProgressPromise]);

    expect(dispatchSettled).toBe(true);
    expect(toolProgressSettled).toBe(true);
    expect(onToolStart).toHaveBeenCalledWith({ name: "lookup" });
    expect(onPartialReply).toHaveBeenCalledWith({ text: "after tool" });
    expect(progressOrder).toEqual(["tool", "partial", "final"]);
    expect(delivered).toEqual([{ text: "before tool" }, { text: "final" }]);
  });

  it("does not synthesize tool-start capability while ordering item progress", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { verboseDefault: "on" } },
    } as const satisfies OpenClawConfig;
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const onItemEvent = vi.fn();
    let itemProgressSettled = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "before item" });
      expect(opts?.onToolStart).toBeUndefined();
      const itemProgressPromise = Promise.resolve(
        opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running" }),
      ).then(() => {
        itemProgressSettled = true;
      });

      await deliveryStarted;

      expect(delivered).toEqual([{ text: "before item" }]);
      expect(onItemEvent).not.toHaveBeenCalled();
      expect(itemProgressSettled).toBe(false);

      releaseDelivery?.();
      await itemProgressPromise;
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { onItemEvent },
    });

    expect(itemProgressSettled).toBe(true);
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running",
    });
  });

  it("forwards payload metadata into onBlockReplyQueued context", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const onBlockReplyQueued = vi.fn();
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const payload = setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 7 });
      await opts?.onBlockReply?.(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onBlockReplyQueued },
    });

    expect(onBlockReplyQueued).toHaveBeenCalledWith(
      { text: "Alpha" },
      { assistantMessageIndex: 7 },
    );
    const queuedPayload = onBlockReplyQueued.mock.calls[0]?.[0];
    expect(queuedPayload ? getReplyPayloadMetadata(queuedPayload) : undefined).toMatchObject({
      assistantMessageIndex: 7,
    });
    const deliveredPayload = vi.mocked(dispatcher.sendBlockReply).mock.calls[0]?.[0];
    expect(deliveredPayload ? getReplyPayloadMetadata(deliveredPayload) : undefined).toMatchObject({
      assistantMessageIndex: 7,
    });
  });

  it("delivers final-mode Telegram TTS as one captioned voice reply", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Hello from block streaming." });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(firstFinalReplyPayload(dispatcher)).toMatchObject({
      text: "Hello from block streaming.",
      mediaUrl: "https://example.com/tts-synth.opus",
      audioAsVoice: true,
    });
  });

  it.each([
    { ok: true, delivered: false, ambiguous: true },
    { ok: false, delivered: false, queueCustody: "held" as const },
  ])("keeps a pending routed caption with its delivery owner ($ok)", async (pending) => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    mocks.routeReply.mockResolvedValue(pending);
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "One captioned answer." }),
    });

    expect(mocks.routeReply.mock.calls.map(([call]) => call.payload)).toEqual([
      expect.objectContaining({
        text: "One captioned answer.",
        mediaUrl: "https://example.com/tts-synth.opus",
      }),
    ]);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.counts.final).toBe(0);
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.each([
    { final: "same", audio: false, native: false },
    { final: "different", audio: false, native: false },
    { final: "same", audio: true, native: false },
    { final: "same", audio: false, native: true },
    { final: "different", audio: false, native: true },
    { final: "same", audio: true, native: true },
    { final: "same", audio: false, native: "identityless" },
    { final: "different", audio: false, native: "identityless" },
    { final: "same", audio: true, native: "identityless" },
    { final: "same", audio: false, native: "deferred" },
    { final: "different", audio: false, native: "deferred" },
    { final: "same", audio: true, native: "deferred" },
    { final: "same", audio: false, native: "ambiguous" },
    { final: "different", audio: false, native: "ambiguous" },
    { final: "same", audio: true, native: "ambiguous" },
    { final: "same", audio: false, native: "partial" },
    { final: "different", audio: false, native: "partial" },
    { final: "same", audio: true, native: "partial" },
    { final: "same", audio: false, native: "partial-envelope" },
    { final: "different", audio: false, native: "partial-envelope" },
    { final: "same", audio: true, native: "partial-envelope" },
  ])(
    "preserves uncovered final content after a pending block ($final, audio=$audio, native=$native)",
    async ({ final, audio, native }) => {
      setNoAbort();
      ttsMocks.state.synthesizeFinalAudio = audio;
      mocks.routeReply
        .mockResolvedValueOnce({ ok: true, delivered: false, ambiguous: true })
        .mockResolvedValue({ ok: true, delivered: true });
      const nativePayloads: ReplyPayload[] = [];
      const dispatcher = native
        ? createReplyDispatcher({
            deliver: async (reply, info) => {
              nativePayloads.push(reply);
              if (info.kind === "block") {
                if (native === "ambiguous") {
                  throw new Error("provider response lost after dispatch");
                }
                if (native === "partial") {
                  const error = new OutboundDeliveryError("later media failed", {
                    cause: new Error("provider response lost"),
                    results: [{ channel: "telegram", messageId: "accepted-prefix" }],
                  });
                  error.queueCustody = "released";
                  throw createChannelPartialDeliveryError(error, {
                    visibleReplySent: true,
                    messageIds: ["accepted-prefix"],
                  });
                }
                if (native === "partial-envelope") {
                  throw createChannelPartialDeliveryError(
                    new PlatformMessageNotDispatchedError("later media rejected", {
                      cause: undefined,
                      retryable: false,
                    }),
                    { visibleReplySent: true, messageIds: ["accepted-prefix"] },
                  );
                }
                if (native === "identityless") {
                  return {
                    visibleReplySent: false,
                    suppression: { reason: "adapter_returned_no_identity" },
                  };
                }
                const error = Object.assign(
                  new OutboundDeliveryError("queued block", {
                    cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
                  }),
                  {
                    queueCustody: "held" as const,
                  },
                );
                if (native === "deferred") {
                  return { finalization: Promise.reject(error) };
                }
                throw error;
              }
              return { visibleReplySent: true };
            },
          })
        : createDispatcher();
      const onBlockReplyQueued = vi.fn();
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: native ? "telegram" : "slack",
          Surface: native ? "telegram" : "slack",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:999",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { onBlockReplyQueued },
        replyResolver: async (_ctx, opts) => {
          await opts?.onBlockReply?.({ text: "same" });
          return { text: final };
        },
      });

      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(
        native ? nativePayloads : mocks.routeReply.mock.calls.map(([call]) => call.payload),
      ).toEqual([
        { text: "same" },
        ...(audio
          ? [
              expect.objectContaining({
                text: undefined,
                mediaUrl: "https://example.com/tts-synth.opus",
              }),
            ]
          : final === "different"
            ? [{ text: "different" }]
            : []),
      ]);
      expect(onBlockReplyQueued).not.toHaveBeenCalled();
      expect(result.counts.final).toBe(audio || final === "different" ? 1 : 0);
      expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
      expect(result.observedReplyDelivery).toBeUndefined();
    },
  );

  it("shares a deferred native block settlement with its callback before admitting a final", async () => {
    setNoAbort();
    const blockStarted = createDeferred();
    const releaseBlock = createDeferred();
    const finalPrepared = createDeferred();
    const attempted: Array<{ kind: string; text?: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        attempted.push({ kind: info.kind, text: payload.text });
        if (info.kind === "block") {
          blockStarted.resolve();
          await releaseBlock.promise;
          throw Object.assign(
            new OutboundDeliveryError("queued block", {
              cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
            }),
            { queueCustody: "held" as const },
          );
        }
      },
    });
    const admitFinal = vi.spyOn(dispatcher, "sendFinalReply");
    const onBlockReplyQueued = vi.fn();
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (input: unknown) => {
      const params = input as { kind: string; payload: ReplyPayload };
      if (params.kind === "final") {
        finalPrepared.resolve();
      }
      return params.payload;
    });
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { onBlockReplyQueued },
      replyResolver: async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "same" });
        return { text: "same" };
      },
    });
    try {
      await Promise.all([blockStarted.promise, finalPrepared.promise]);
      // Drain runnable promise continuations while the transport remains explicitly held.
      await nextEventLoopTurn();
      expect(admitFinal).not.toHaveBeenCalled();
    } finally {
      releaseBlock.resolve();
      await dispatch;
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
    expect(attempted).toEqual([{ kind: "block", text: "same" }]);
    expect(onBlockReplyQueued).not.toHaveBeenCalled();
  });

  it("does not borrow an unrelated native block's pending custody to suppress a final", async () => {
    setNoAbort();
    const attempted: Array<{ kind: string; text?: string }> = [];
    const onBlockReplyQueued = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        attempted.push({ kind: info.kind, text: payload.text });
        if (info.kind === "block") {
          throw Object.assign(
            new OutboundDeliveryError("offline", {
              cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
            }),
            { queueCustody: payload.text === "A" ? ("held" as const) : ("released" as const) },
          );
        }
      },
    });
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { onBlockReplyQueued },
      replyResolver: async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "A" });
        await opts?.onBlockReply?.({ text: "B" });
        return { text: "B" };
      },
    });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(attempted).toEqual([
      { kind: "block", text: "A" },
      { kind: "block", text: "B" },
      { kind: "final", text: "B" },
    ]);
    expect(onBlockReplyQueued).not.toHaveBeenCalled();
    expect(result.counts.final).toBe(1);
    expect(receipt?.hasPendingDelivery).toBe(true);
  });

  it("delivers independent durable updates immediately without mixing them into the final Telegram voice reply", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.(
        { text: "Which environment should I use?" },
        { deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:question" },
      );
      expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({
        text: "Which environment should I use?",
      });
      await opts?.onBlockReply?.({ text: "The selected environment is ready." });
      return { text: "Deployment complete." };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(firstFinalReplyPayload(dispatcher)).toMatchObject({
      text: "The selected environment is ready.\nDeployment complete.",
      mediaUrl: "https://example.com/tts-synth.opus",
      audioAsVoice: true,
    });
  });

  it.each([
    { completionState: "prepared", audio: false, native: false },
    { completionState: "queued", audio: false, native: false },
    { completionState: "unknown", audio: false, native: false },
    { completionState: "prepared", audio: true, native: false },
    { completionState: "queued", audio: true, native: false },
    { completionState: "unknown", audio: true, native: false },
    { completionState: "prepared", audio: false, native: true },
    { completionState: "queued", audio: false, native: true },
    { completionState: "unknown", audio: false, native: true },
    { completionState: "prepared", audio: true, native: true },
    { completionState: "queued", audio: true, native: true },
    { completionState: "unknown", audio: true, native: true },
  ] as const)(
    "preserves completion ownership for a pending block ($completionState, audio=$audio, native=$native)",
    async ({ completionState, audio, native }) => {
      setNoAbort();
      ttsMocks.state.synthesizeFinalAudio = audio;
      const pending = {
        kind: "replayable",
        text: "same",
        createdAt: 1,
        intentId: "pending-block",
        deliveries: [{ id: "original", state: completionState }],
      };
      sessionStoreMocks.currentEntry = { sessionId: "session-1", pendingFinalDelivery: pending };
      const onFinalDeliverySuccess = vi.fn();
      const payload = setReplyPayloadMetadata(
        { text: "same" },
        {
          pendingFinalDeliveryCompletion: {
            deliveryId: "original",
            intentId: "pending-block",
            sessionId: "session-1",
            sessionKey: "agent:main:slack:direct:123",
            storePath: "/tmp/mock-sessions.json",
          },
          onFinalDeliverySuccess,
        },
      );
      mocks.routeReply
        .mockResolvedValueOnce({ ok: true, delivered: false, ambiguous: true })
        .mockResolvedValue({ ok: true, delivered: true });
      const nativePayloads: ReplyPayload[] = [];
      const dispatcher = native
        ? createReplyDispatcher({
            deliver: async (reply, info) => {
              nativePayloads.push(reply);
              if (info.kind === "block") {
                throw Object.assign(
                  new OutboundDeliveryError("queued block", {
                    cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
                  }),
                  { queueCustody: "held" as const },
                );
              }
            },
          })
        : createDispatcher();
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: native ? "telegram" : "slack",
          Surface: native ? "telegram" : "slack",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:999",
          SessionKey: "agent:main:slack:direct:123",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async (_ctx, opts) => {
          await opts?.onBlockReply?.({ text: "same" });
          return payload;
        },
      });

      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      const attempted = native
        ? nativePayloads
        : mocks.routeReply.mock.calls.map(([call]) => call.payload);
      expect(attempted).toHaveLength(audio ? 2 : 1);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toEqual(
        completionState === "prepared" ? undefined : pending,
      );
      expect(onFinalDeliverySuccess).not.toHaveBeenCalled();
      if (audio) {
        const supplement = expectDefined(attempted[1], "audio supplement");
        expect(supplement).toMatchObject({
          text: undefined,
          mediaUrl: "https://example.com/tts-synth.opus",
        });
        expect(getReplyPayloadMetadata(supplement)?.pendingFinalDeliveryCompletion).toBeUndefined();
      }
    },
  );

  it("delivers deferred Telegram text when synthesis produces no audio", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Fallback text content." });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(firstFinalReplyPayload(dispatcher)).toEqual({ text: "Fallback text content." });
  });

  it("delivers deferred Telegram text when final synthesis throws", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.maybeApplyTtsToPayload.mockRejectedValueOnce(new Error("provider unavailable"));
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "Streamed text." });
      return { text: "Final text." };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(firstFinalReplyPayload(dispatcher)).toEqual({ text: "Streamed text.\nFinal text." });
  });

  it("delivers deferred Telegram text when media normalization throws", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(async () => {
      throw new Error("normalizer unavailable");
    });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Streamed text." });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(firstFinalReplyPayload(dispatcher)).toEqual({ text: "Streamed text." });
  });

  it("delivers deferred Telegram text when generation fails after a block", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Partial useful answer." });
      throw new Error("provider unavailable");
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(firstFinalReplyPayload(dispatcher)).toEqual({ text: "Partial useful answer." });
    expect(
      vi.mocked(dispatcher.sendFinalReply).mock.calls.map(([payload]) => payload.text),
    ).toEqual(["Partial useful answer.", expect.stringContaining("Something went wrong")]);
  });

  it.each([
    { resolverOutcome: "throws", shouldThrow: true },
    { resolverOutcome: "returns", shouldThrow: false },
  ])(
    "delivers deferred Telegram text when the run aborts and the resolver $resolverOutcome",
    async ({ shouldThrow }) => {
      setNoAbort();
      installCaptionedVoiceTestPlugin("telegram");
      const abortController = new AbortController();
      const dispatcher = createDispatcher();
      const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
      const replyResolver = async (
        _ctx: MsgContext,
        opts?: GetReplyOptions,
      ): Promise<ReplyPayload | undefined> => {
        await opts?.onBlockReply?.({ text: "Partial answer before cancellation." });
        abortController.abort();
        if (shouldThrow) {
          throw new Error("run cancelled");
        }
        return undefined;
      };

      await dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { abortSignal: abortController.signal },
        replyResolver,
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(firstFinalReplyPayload(dispatcher)).toEqual({
        text: "Partial answer before cancellation.",
      });
    },
  );

  it("delivers deferred Telegram text after an unrelated final status notice", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "Actual answer." });
      return { text: "Runtime status.", isStatusNotice: true };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(vi.mocked(dispatcher.sendFinalReply).mock.calls).toEqual([
      [{ text: "Runtime status.", isStatusNotice: true }],
      [
        expect.objectContaining({
          text: "Actual answer.",
          mediaUrl: "https://example.com/tts-synth.opus",
        }),
      ],
    ]);
  });

  it("keeps Telegram TTS-only directive text out of the voice caption", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
      mediaUrl: "https://example.com/tts-synth.opus",
      audioAsVoice: true,
      spokenText: "Private speech text.",
      trustedLocalMedia: true,
    });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({
        text: "[[tts:text]]Private speech text.[[/tts:text]]",
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(firstFinalReplyPayload(dispatcher)?.text).toBeUndefined();
  });

  it("keeps streamed TTS-only text out of a later Telegram final caption", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({
        text: "Visible block. [[tts:text]]Private speech.[[/tts:text]]",
      });
      return { text: "Visible final." };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(firstFinalReplyPayload(dispatcher)).toMatchObject({
      text: "Visible block.\nVisible final.",
      mediaUrl: "https://example.com/tts-synth.opus",
    });
  });

  it("keeps a cross-boundary TTS-only region out of the Telegram caption", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "Visible. [[tts:text]]Private" });
      return { text: " speech.[[/tts:text]] Done." };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(firstFinalReplyPayload(dispatcher)).toMatchObject({
      text: "Visible.  Done.",
      mediaUrl: "https://example.com/tts-synth.opus",
    });
  });

  it("keeps distinct streamed and final text in the caption", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "First paragraph." });
      return { text: "Second paragraph." };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(firstFinalReplyPayload(dispatcher)).toMatchObject({
      text: "First paragraph.\nSecond paragraph.",
      mediaUrl: "https://example.com/tts-synth.opus",
    });
  });

  it("keeps tagged-mode Telegram block text visible", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.statusSnapshot = {
      autoMode: "tagged",
      provider: "auto",
      maxLength: 1500,
      summarize: true,
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Plain tagged text." });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text: "Plain tagged text." });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      expectedText: "Private speech.",
      ttsReply: { text: "Private speech." },
      finalReply: {},
      streamedText: "[[tts:text]]Private speech.[[/tts:text]]",
    },
    {
      expectedText: undefined,
      ttsReply: { text: "Private speech.", mediaUrl: "https://x/tts.opus", audioAsVoice: true },
      finalReply: { mediaUrl: "https://x/tts.opus", audioAsVoice: true },
      streamedText: "[[tts:text]]Private speech.[[/tts:text]]",
    },
    {
      expectedText: "Visible answer.",
      ttsReply: { text: "Visible answer." },
      finalReply: undefined,
      streamedText: "Visible answer. [[tts:text]]Private speech.[[/tts:text]]",
    },
  ])("keeps tagged TTS delivery single for $streamedText", async (testCase) => {
    setNoAbort();
    ttsMocks.state.statusSnapshot.autoMode = "tagged";
    ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce(testCase.ttsReply);
    const dispatcher = createDispatcher();
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({ text: testCase.streamedText });
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const blockReply = vi.mocked(dispatcher.sendBlockReply).mock.calls[0]?.[0];
    const deliveredPayload = testCase.finalReply ? firstFinalReplyPayload(dispatcher) : blockReply;
    expect(deliveredPayload?.text?.trim()).toBe(testCase.expectedText);
    if (testCase.finalReply) {
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
      expect(deliveredPayload).toMatchObject(testCase.finalReply);
    } else {
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    }
  });

  it("skips fallback when directives stay visible", () =>
    expect(needsTtsFallback(false, "[[tts:text]]x", "x")).toBe(false));
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
