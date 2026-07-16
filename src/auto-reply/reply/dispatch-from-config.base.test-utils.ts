// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { AsyncResource } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  messageAuditMocks,
  mocks,
  replyMediaPathMocks,
  runtimePluginMocks,
  sessionStoreMocks,
  transcriptMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  automaticDirectReplyConfig,
  dispatchReplyFromConfig,
  createReplyOperation,
  replyRunRegistry,
  setNoAbort,
  firstMockCall,
  firstMockArg,
  firstFinalReplyPayload,
  firstRouteReplyCall,
  installThreadingTestPlugin,
  requireBlockReplyHandler,
  messageAuditEvents,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

  it("loads runtime plugins before reading inbound hook state", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    const pluginLoadOptions = firstMockArg(
      runtimePluginMocks.ensureRuntimePluginsLoaded,
      "runtime plugin load",
    ) as { config?: unknown; workspaceDir?: unknown };
    expect(pluginLoadOptions.config).toBe(cfg);
    expect(typeof pluginLoadOptions.workspaceDir).toBe("string");
    expect(runtimePluginMocks.ensureRuntimePluginsLoaded.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        hookMocks.runner.hasHooks.mock.invocationCallOrder[0],
        "hookMocks.runner.hasHooks.mock.invocationCallOrder[0] test invariant",
      ),
    );
  });

  it("drops a durable source duplicate before before_dispatch hooks", async () => {
    setNoAbort();
    const sessionKey = "agent:main:discord:direct:123";
    const sourceTurnId = expectDefined(
      buildChannelSourceTurnId({
        provider: "discord",
        conversationId: "channel:123",
        messageId: "message-1",
      }),
      "source turn id",
    );
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      status: "running",
      updatedAt: Date.now(),
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
    };
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "before_dispatch") as () => boolean,
    );
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: sessionKey,
      OriginatingTo: "channel:123",
      MessageSid: "message-1",
      MessageSidFull: "   ",
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(result).toMatchObject({ queuedFinal: false });
    expect(hookMocks.runner.runBeforeDispatch).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("returns session metadata changes marked during reply resolution", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        SessionKey: sessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (ctx) => {
        markCommandSessionMetadataChanged({ ctx, sessionKey });
        return { text: "goal updated" };
      },
    });

    expect(result.sessionMetadataChanges).toEqual([{ sessionKey, reason: "command-metadata" }]);
  });

  it("notifies session metadata changes before later dispatch errors", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const dispatcher = createDispatcher();
    dispatcher.sendFinalReply = vi.fn(() => {
      throw new Error("delivery failed");
    });
    const onSessionMetadataChanges = vi.fn();

    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          SessionKey: sessionKey,
        }),
        cfg: emptyConfig,
        dispatcher,
        onSessionMetadataChanges,
        replyResolver: async (ctx) => {
          markCommandSessionMetadataChanged({ ctx, sessionKey });
          return { text: "goal updated" };
        },
      }),
    ).rejects.toThrow("delivery failed");

    expect(onSessionMetadataChanges).toHaveBeenCalledWith([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("skips pre-dispatch admission when the caller already aborted", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:3731";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    abortController.abort();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: sessionKey,
        ChatType: "group",
        IsForum: true,
        MessageSid: "27784",
        MessageThreadId: 3731,
        TransportThreadId: 3731,
        To: "telegram:-1003774691294:topic:3731",
        BodyForAgent: "superseded while waiting",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver,
    });

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_aborted",
      }),
    );
    activeOperation.complete();
  });

  it("skips a Telegram topic heartbeat turn while a reply operation is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:3731";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "user-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () => ({ text: "heartbeat should not run" }) satisfies ReplyPayload,
    );

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: sessionKey,
        ChatType: "group",
        IsForum: true,
        MessageSid: "heartbeat",
        MessageThreadId: 3731,
        TransportThreadId: 3731,
        To: "telegram:-1003774691294:topic:3731",
        BodyForAgent: "[OpenClaw heartbeat poll]",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: { isHeartbeat: true },
      replyResolver,
    });

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_active",
      }),
    );
    activeOperation.complete();
  });

  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack", defaultAccountId: "work" });
    const cfg = automaticDirectReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingAccountId?: unknown;
            shouldRouteToOriginating?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(false);
    expect(replyDispatchCall?.[0]?.originatingAccountId).toBe("work");
  });

  it("mirrors ownerless same-channel Slack finals after successful delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack" });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      ChatType: "group",
      SessionKey: "agent:main:slack:channel:C123",
      MessageSid: "slack-message-1",
    });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "slack-run-1" },
      replyResolver: async () => ({ text: "Slack command reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:slack:channel:C123",
      agentId: "main",
      text: "Slack command reply",
      mediaUrls: undefined,
      idempotencyKey: "channel-final:slack-message-1:0",
      deliveryMirror: {
        kind: "channel-final",
        sourceMessageId: "slack-message-1",
      },
      storePath: "/tmp/mock-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("mirrors reset acknowledgements into the canonically prepared Slack session", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const sessionKey = "Agent:Main:Slack:Channel:C123";
    const preparedSessionKey = "agent:main:slack:channel:c123";
    sessionStoreMocks.currentEntry = {
      sessionId: "previous-session",
      updatedAt: Date.now(),
    };
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "slack-reset-message",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        (
          opts as GetReplyOptions & {
            onSessionPrepared?: (binding: {
              sessionKey?: string;
              sessionId: string;
              storePath?: string;
            }) => void;
          }
        ).onSessionPrepared?.({
          sessionKey: preparedSessionKey,
          sessionId: "new-session",
          storePath: "/tmp/rotated-sessions.json",
        });
        return { text: "✅ New session started." };
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        expectedSessionId: "new-session",
        storePath: "/tmp/rotated-sessions.json",
        text: "✅ New session started.",
      }),
    );
  });

  it.each([
    ["embedded", { assistantMessageIndex: 7 }],
    ["runtime-owned", { assistantTranscriptOwned: true }],
  ])("does not mirror %s finals with a runtime transcript owner", async (_name, metadata) => {
    setNoAbort();
    const dispatcher = createDispatcher();
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () =>
        setReplyPayloadMetadata({ text: "Persisted runtime reply" }, metadata),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("records stale-foreground suppressed CLI-owned finals without duplicating answer text", async () => {
    setNoAbort();
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(async () => undefined),
      beforeDeliver: (payload, info) => {
        if (info.kind !== "final") {
          return payload;
        }
        setReplyPayloadMetadata(payload, {
          foregroundDeliverySuppression: { reason: "stale-foreground" },
        });
        return null;
      },
    });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
        MessageSid: "slack-message-cli",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        (
          opts as GetReplyOptions & {
            onSessionPrepared?: (binding: {
              sessionKey?: string;
              sessionId: string;
              storePath?: string;
            }) => void;
          }
        ).onSessionPrepared?.({
          sessionKey: "agent:main:slack:channel:c123",
          sessionId: "prepared-session",
          storePath: "/tmp/prepared-sessions.json",
        });
        return setReplyPayloadMetadata(
          { text: "The CLI answer already lives in the transcript." },
          { assistantTranscriptOwned: true },
        );
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:slack:channel:C123",
      agentId: "main",
      expectedSessionId: "prepared-session",
      text: "Channel final suppressed before delivery: stale foreground",
      mediaUrls: undefined,
      idempotencyKey: "channel-final-suppressed:slack-message-cli:0",
      deliveryMirror: {
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "slack-message-cli",
      },
      storePath: "/tmp/prepared-sessions.json",
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it("disables routed delivery mirrors for CLI-owned finals", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    mocks.routeReply.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    installThreadingTestPlugin({ id: "telegram", defaultAccountId: "default" });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
        AccountId: "default",
        SessionKey: "agent:main:telegram:group:999",
      }),
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver: async () =>
        setReplyPayloadMetadata(
          { text: "Persisted routed CLI reply" },
          { assistantTranscriptOwned: true },
        ),
    });

    expect(result.queuedFinal).toBe(true);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Persisted routed CLI reply" },
        mirror: false,
      }),
    );
  });

  it("uses accepted steered inbound audio for final TTS", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      SessionKey: "agent:main:whatsapp:direct:chat-1",
      BodyForAgent: "text turn",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const operation = (
        opts as
          | {
              replyOperation?: ReturnType<typeof createReplyOperation>;
            }
          | undefined
      )?.replyOperation;
      expect(operation?.acceptedSteeredInboundAudio).toBe(false);
      operation?.markAcceptedSteeredInboundAudio();
      return { text: "reply to steered audio" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver,
    });

    const finalTtsCall = ttsMocks.maybeApplyTtsToPayload.mock.calls.find(
      ([params]) => (params as { kind?: string }).kind === "final",
    )?.[0] as { inboundAudio?: boolean } | undefined;
    expect(finalTtsCall?.inboundAudio).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.mediaUrl).toBe("https://example.com/tts-synth.opus");
  });

  it("passes reply policy to routed block delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const slackPlugin = createChannelTestPluginBase({ id: "slack" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...slackPlugin,
            config: {
              ...slackPlugin.config,
              listAccountIds: () => ["work"],
              defaultAccountId: () => "work",
            },
            threading: {
              resolveReplyToMode: ({ accountId }: { accountId?: string | null }) =>
                accountId === "work" ? "off" : "all",
            },
          },
        },
      ]),
    );
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      ChatType: "channel",
      SessionKey: "agent:main:slack:channel:C123",
    });
    const cfg = {} as OpenClawConfig;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({
        text: "partial",
        replyToId: "999.000",
        replyToTag: true,
      });
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "slack",
        replyKind: "block",
        replyDelivery: {
          chatType: "channel",
          replyToMode: "off",
        },
      }),
    );
  });

  it("mirrors the delivered ownerless Slack text after dispatcher hook rewrites", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    dispatcher.appendBeforeDeliver?.((payload, info) =>
      info.kind === "final" ? { ...payload, text: "Redacted Slack reply" } : payload,
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
        MessageSid: "slack-message-2",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "Secret Slack reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Redacted Slack reply",
        idempotencyKey: "channel-final:slack-message-2:0",
      }),
    );
  });

  it("does not mirror ownerless Slack finals removed by dispatcher hooks", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    dispatcher.appendBeforeDeliver?.((payload, info) =>
      info.kind === "final"
        ? { ...payload, text: "", mediaUrl: undefined, mediaUrls: undefined }
        : payload,
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        SessionKey: "agent:main:slack:channel:C123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "Hidden Slack reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("records routed Slack thread id on dispatch-owned reply operations", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "user:U1",
      ChatType: "direct",
      SessionKey: "agent:main:slack:direct:U1",
      MessageThreadId: "501.000",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const operation = (
        opts as { replyOperation?: { routeThreadId?: string | number } } | undefined
      )?.replyOperation;
      expect(operation?.routeThreadId).toBe("501.000");
      return { text: "hi" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("lets a different Slack DM routed thread reach reply resolution while another thread is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U1";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    let inBandMutationRan = false;
    const rotatedSessionId = "rotated-session";
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        true,
      );
      await runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        run: async () => {
          inBandMutationRan = true;
          sessionStoreMocks.currentEntry = {
            sessionId: rotatedSessionId,
            updatedAt: Date.now(),
          };
          (
            opts as
              | (GetReplyOptions & {
                  onSessionPrepared?: (binding: {
                    sessionKey: string;
                    sessionId: string;
                    storePath: string;
                  }) => void;
                })
              | undefined
          )?.onSessionPrepared?.({
            sessionKey,
            sessionId: rotatedSessionId,
            storePath: "/tmp/mock-sessions.json",
          });
        },
      });
      return { text: "thread B reply" } satisfies ReplyPayload;
    });

    try {
      const resultPromise = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U1",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "second top-level DM",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      });

      const result = await Promise.race([
        resultPromise,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      if (result === "timed-out") {
        activeOperation.complete();
        await resultPromise;
        throw new Error("Slack routed thread was blocked by the active reply operation");
      }

      expect(result).toMatchObject({
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(inBandMutationRan).toBe(true);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    } finally {
      activeOperation.complete();
    }
  });

  it("releases a Slack bypass lease when the competing routed thread changes during admission", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U2";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const originalOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    originalOperation.setPhase("running");
    let replacementOperation: ReturnType<typeof createReplyOperation> | undefined;
    let releaseMutation: () => void = () => {};
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let signalMutationEntered: () => void = () => {};
    const mutationEntered = new Promise<void>((resolve) => {
      signalMutationEntered = resolve;
    });
    let lifecycleMutation: Promise<void> | undefined;
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "before_dispatch") as () => boolean,
    );
    hookMocks.runner.runBeforeDispatch.mockImplementationOnce(async () => {
      lifecycleMutation = runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        run: async () => {
          signalMutationEntered();
          await mutationGate;
        },
      });
      await mutationEntered;
      setTimeout(() => {
        originalOperation.complete();
        replacementOperation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
          routeThreadId: "501.000",
        });
        replacementOperation.setPhase("running");
        releaseMutation();
      }, 0);
      return undefined;
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U2",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "same routed thread after replacement",
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver,
      });
      await lifecycleMutation;

      expect(result).toMatchObject({ queuedFinal: false });
      expect(replyResolver).not.toHaveBeenCalled();
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        false,
      );
    } finally {
      releaseMutation();
      originalOperation.complete();
      replacementOperation?.complete();
      await lifecycleMutation;
    }
  });

  it("holds a Slack bypass lease until an abort-insensitive resolver settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U3";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    let releaseResolver: () => void = () => {};
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let signalResolverEntered: () => void = () => {};
    const resolverEntered = new Promise<void>((resolve) => {
      signalResolverEntered = resolve;
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      signalResolverEntered();
      await resolverGate;
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
      return { text: "late reply" } satisfies ReplyPayload;
    });
    const dispatcher = createDispatcher();
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U3",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "abort-insensitive routed thread",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await resolverEntered;
    activeOperation.complete();

    let mutationRan = false;
    const externalLifecycleRequest = new AsyncResource("slack-bypass-settle-race");
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
    const result = await dispatch;

    expect(result.queuedFinal).toBe(false);
    expect(mutationRan).toBe(false);
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      true,
    );

    releaseResolver();
    await mutation;

    expect(mutationRan).toBe(true);
    expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
      false,
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    externalLifecycleRequest.emitDestroy();
  });

  it("bounds Slack bypass lease cleanup when dispatcher idle never settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U4";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    dispatcher.waitForIdle = vi.fn(async () => await new Promise<void>(() => {}));
    dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy = () => ({
      maxTimeoutMs: 25,
      shouldExtend: () => false,
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U4",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "hung delivery barrier",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => undefined,
      });

      expect(result.queuedFinal).toBe(false);
      await vi.waitFor(
        () => {
          expect(
            isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId]),
          ).toBe(false);
        },
        { timeout: 500 },
      );
    } finally {
      activeOperation.complete();
    }
  });

  it("holds a Slack bypass lease until queued delivery settles before revalidation", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U5";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    let releaseDelivery: () => void = () => {};
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createDispatcher();
    let holdDelivery = false;
    dispatcher.waitForIdle = vi.fn(async () => {
      if (holdDelivery) {
        await deliveryGate;
      }
    });
    const externalLifecycleRequest = new AsyncResource("slack-bypass-delivery-race");
    let allowLifecycleInterrupt: () => void = () => {};
    const lifecycleInterruptGate = new Promise<void>((resolve) => {
      allowLifecycleInterrupt = resolve;
    });
    let signalMutationPrepared: () => void = () => {};
    const mutationPrepared = new Promise<void>((resolve) => {
      signalMutationPrepared = resolve;
    });
    let signalResolverReturning: () => void = () => {};
    const resolverReturning = new Promise<void>((resolve) => {
      signalResolverReturning = resolve;
    });
    let mutationRan = false;
    let mutation: Promise<void> | undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      holdDelivery = true;
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "queued block" });
      mutation = externalLifecycleRequest.runInAsyncScope(
        async () =>
          await runExclusiveSessionLifecycleMutation({
            scope: "/tmp/mock-sessions.json",
            identities: [sessionKey, sessionId],
            prepare: async () => {
              signalMutationPrepared();
              await lifecycleInterruptGate;
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
      signalResolverReturning();
      return undefined;
    });

    try {
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U5",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "hold queued delivery",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      });
      await Promise.all([mutationPrepared, resolverReturning]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      allowLifecycleInterrupt();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(dispatcher.sendBlockReply).toHaveBeenCalledOnce();
      expect(mutationRan).toBe(false);
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        true,
      );

      releaseDelivery();
      await dispatch;
      await mutation;

      expect(mutationRan).toBe(true);
    } finally {
      allowLifecycleInterrupt();
      releaseDelivery();
      activeOperation.complete();
      await mutation;
      externalLifecycleRequest.emitDestroy();
    }
  });

  it("runs ACP tail dispatch inside a borrowed Slack lifecycle admission", async () => {
    setNoAbort();
    const sessionKey = "agent:main:slack:direct:U6";
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    let initiatingAdmissionExcluded = false;
    let mutationRan = false;
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "reply_dispatch") as () => boolean,
    );
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown) => {
      if (!(event as { isTailDispatch?: boolean }).isTailDispatch) {
        return undefined;
      }
      await runExclusiveSessionLifecycleMutation({
        scope: "/tmp/mock-sessions.json",
        identities: [sessionKey, sessionId],
        prepare: async () => {
          initiatingAdmissionExcluded = await interruptSessionWorkAdmissions({
            scope: "/tmp/mock-sessions.json",
            identities: [sessionKey, sessionId],
            timeoutMs: 25,
          });
        },
        run: async () => {
          mutationRan = true;
        },
      });
      return {
        handled: true,
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U6",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          BodyForAgent: "run tail after reset",
          AcpDispatchTailAfterReset: true,
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver: async () => undefined,
      });

      expect(result.queuedFinal).toBe(false);
      expect(initiatingAdmissionExcluded).toBe(true);
      expect(mutationRan).toBe(true);
    } finally {
      activeOperation.complete();
    }
  });

  it("keeps non-Slack routed direct turns behind the active reply operation", async () => {
    setNoAbort();
    installThreadingTestPlugin({ id: "telegram" });
    const sessionKey = "agent:main:telegram:direct:1";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });

    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      expect(replyResolver).not.toHaveBeenCalled();
    } finally {
      activeOperation.complete();
      await resultPromise;
    }
  });

  it("lets Gateway-owned turns reach queue resolution while a reply operation is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "webchat",
          Surface: "webchat",
          SessionKey: sessionKey,
          BodyForAgent: "queue this turn",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: {
          queuedFollowupLifecycle: {
            onEnqueued: vi.fn(),
            onComplete: vi.fn(),
          },
        },
        replyResolver,
      });

      expect(result).toMatchObject({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);
    } finally {
      activeOperation.complete();
    }
  });

  it("clears stale active reply operations for terminal sessions and retries admission", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294";
    const sessionId = "failed-session";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "fresh reply" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "visible-after-failure",
        To: "telegram:-1003774691294",
        BodyForAgent: "@openclaw recover",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(activeOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("does not kill a sibling recovery turn when a second visible turn races the same terminal snapshot", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691295";
    const sessionId = "failed-session-race";
    // Leftover stuck run from the failed lifecycle; both racing turns read the
    // same terminal store snapshot below.
    const staleOperation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    staleOperation.setPhase("running");
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };

    let releaseFirstTurn: () => void = () => {};
    const firstResolverGate = new Promise<void>((release) => {
      releaseFirstTurn = release;
    });
    let signalFirstResolverEntered: () => void = () => {};
    const firstTurnEntered = new Promise<void>((resolve) => {
      signalFirstResolverEntered = resolve;
    });
    const firstReplyResolver = vi.fn(async () => {
      signalFirstResolverEntered();
      await firstResolverGate;
      return { text: "first recovery reply" } satisfies ReplyPayload;
    });
    const secondReplyResolver = vi.fn(
      async () => ({ text: "second reply" }) satisfies ReplyPayload,
    );
    const firstDispatcher = createDispatcher();
    const secondDispatcher = createDispatcher();

    const buildRaceCtx = (messageSid: string) =>
      buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: messageSid,
        To: "telegram:-1003774691295",
        BodyForAgent: "@openclaw recover",
      });

    const firstTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-race-first"),
      cfg: automaticGroupReplyConfig,
      dispatcher: firstDispatcher,
      replyResolver: firstReplyResolver,
    });

    // First turn cleared the leftover run and now owns the in-flight recovery
    // operation; capture it before the second turn races in.
    await firstTurnEntered;
    expect(staleOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    const recoveryOperation = replyRunRegistry.get(sessionKey);
    expect(recoveryOperation).toBeDefined();
    expect(recoveryOperation).not.toBe(staleOperation);

    const secondTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-race-second"),
      cfg: automaticGroupReplyConfig,
      dispatcher: secondDispatcher,
      replyResolver: secondReplyResolver,
    });

    // Give the second turn time to run its admission/recovery path. With the
    // bug it would force-fail the first turn's fresh recovery operation here.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(recoveryOperation?.result).toBeNull();
    expect(secondReplyResolver).not.toHaveBeenCalled();

    releaseFirstTurn();
    const firstResult = await firstTurn;
    const secondResult = await secondTurn;

    // The first recovery completed normally; the second turn was never allowed
    // to kill it and got its own admission once the first finished.
    expect(recoveryOperation?.result).toMatchObject({ kind: "completed" });
    expect(firstReplyResolver).toHaveBeenCalledTimes(1);
    expect(secondReplyResolver).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({ queuedFinal: true });
    expect(secondResult).toMatchObject({ queuedFinal: true });
    expect(firstDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("marks a clean no-stale terminal recovery so a racing visible turn cannot force-clear it", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691297";
    const sessionId = "failed-session-no-stale-race";
    // No leftover op is pre-registered: the first visible turn reaches the clean
    // admission path (nothing to force-clear). Both racing turns read the same
    // terminal store snapshot below.
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };

    let releaseFirstTurn: () => void = () => {};
    const firstResolverGate = new Promise<void>((release) => {
      releaseFirstTurn = release;
    });
    let signalFirstResolverEntered: () => void = () => {};
    const firstTurnEntered = new Promise<void>((resolve) => {
      signalFirstResolverEntered = resolve;
    });
    const firstReplyResolver = vi.fn(async () => {
      signalFirstResolverEntered();
      await firstResolverGate;
      return { text: "first recovery reply" } satisfies ReplyPayload;
    });
    const secondReplyResolver = vi.fn(
      async () => ({ text: "second reply" }) satisfies ReplyPayload,
    );
    const firstDispatcher = createDispatcher();
    const secondDispatcher = createDispatcher();

    const buildRaceCtx = (messageSid: string) =>
      buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: messageSid,
        To: "telegram:-1003774691295",
        BodyForAgent: "@openclaw recover",
      });

    const firstTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-no-stale-first"),
      cfg: automaticGroupReplyConfig,
      dispatcher: firstDispatcher,
      replyResolver: firstReplyResolver,
    });

    // First turn admitted cleanly and now owns the in-flight recovery operation;
    // capture it before the second turn races in.
    await firstTurnEntered;
    const recoveryOperation = replyRunRegistry.get(sessionKey);
    expect(recoveryOperation).toBeDefined();
    // The marker must be set on the clean no-stale admission path too; without it
    // the racing second visible turn would force-clear this op (#86827).
    expect(recoveryOperation?.terminalRecovery).toBe(true);

    const secondTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx("visible-no-stale-second"),
      cfg: automaticGroupReplyConfig,
      dispatcher: secondDispatcher,
      replyResolver: secondReplyResolver,
    });

    // Give the second turn time to run its admission/recovery path. With the
    // bug it would force-fail the first turn's fresh recovery operation here.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(recoveryOperation?.result).toBeNull();
    expect(secondReplyResolver).not.toHaveBeenCalled();

    releaseFirstTurn();
    const firstResult = await firstTurn;
    const secondResult = await secondTurn;

    // The first recovery completed normally; the second turn was never allowed
    // to kill it and got its own admission once the first finished.
    expect(recoveryOperation?.result).toMatchObject({ kind: "completed" });
    expect(firstReplyResolver).toHaveBeenCalledTimes(1);
    expect(secondReplyResolver).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({ queuedFinal: true });
    expect(secondResult).toMatchObject({ queuedFinal: true });
    expect(firstDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("does not force-clear an active recovery operation for a heartbeat turn on a terminal session", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691296";
    const sessionId = "failed-session-heartbeat";
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () => ({ text: "heartbeat should not run" }) satisfies ReplyPayload,
    );

    // A concurrent visible turn already cleared the failed leftover and admitted
    // a fresh recovery operation. Register it inside the fast-abort seam, which
    // runs after the early heartbeat short-circuit but before admission, so the
    // heartbeat reaches the terminal force-clear branch with this op active. The
    // op is intentionally NOT marked `terminalRecovery`, so only the visible-turn
    // guard can stop the heartbeat from force-failing it.
    let recoveryOperation: ReturnType<typeof createReplyOperation> | undefined;

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "heartbeat-after-failure",
        To: "telegram:-1003774691296",
        BodyForAgent: "[OpenClaw heartbeat poll]",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: { isHeartbeat: true },
      fastAbortResolver: async () => {
        recoveryOperation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
        });
        recoveryOperation.setPhase("running");
        return { handled: false, aborted: false };
      },
      formatAbortReplyTextResolver: () => "aborted",
      replyResolver,
    });

    // The heartbeat left the active visible recovery operation untouched and
    // skipped itself instead of force-clearing the in-flight visible turn.
    expect(recoveryOperation).toBeDefined();
    expect(recoveryOperation?.result).toBeNull();
    expect(replyRunRegistry.get(sessionKey)).toBe(recoveryOperation);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    recoveryOperation?.complete();
  });

  it("rejects a stale turn without clearing the operation for the rotated session", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691297";
    // Terminal store snapshot still reports the failed lifecycle's session id.
    sessionStoreMocks.currentEntry = {
      sessionId: "failed-session-rotated",
      updatedAt: Date.now(),
      status: "failed",
    };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () => ({ text: "visible recovery reply" }) satisfies ReplyPayload,
    );

    // A concurrent reset/rotation admitted a fresh op under the same session key
    // but with a NEW session id, after this turn already captured the stale
    // terminal snapshot. Register it inside the fast-abort seam, which runs after
    // the early short-circuit but before admission, so the visible turn reaches
    // the terminal force-clear branch with this op active. The op is NOT marked
    // `terminalRecovery`, so only the session-id guard can stop the force-clear.
    let freshOperation: ReturnType<typeof createReplyOperation> | undefined;
    let signalFreshRegistered: () => void = () => {};
    const freshRegistered = new Promise<void>((resolve) => {
      signalFreshRegistered = resolve;
    });

    const turn = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "visible-after-rotation",
        To: "telegram:-1003774691297",
        BodyForAgent: "@openclaw recover",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      fastAbortResolver: async () => {
        freshOperation = createReplyOperation({
          sessionKey,
          sessionId: "fresh-rotated-session",
          resetTriggered: false,
        });
        freshOperation.setPhase("running");
        signalFreshRegistered();
        return { handled: false, aborted: false };
      },
      formatAbortReplyTextResolver: () => "aborted",
      replyResolver,
    });

    // Let the visible turn run its admission/force-clear path. With the bug it
    // would force-fail the rotated op here, mistaking a valid in-flight reply for
    // the stale terminal leftover and recreating the message loss (#86827).
    await freshRegistered;
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    // The session-id guard keeps the rotated op untouched while the stale turn
    // is invalidated instead of later crossing the reset boundary.
    expect(freshOperation).toBeDefined();
    expect(freshOperation?.result).toBeNull();
    expect(replyRunRegistry.get(sessionKey)).toBe(freshOperation);
    expect(replyResolver).not.toHaveBeenCalled();

    freshOperation?.complete();
    await expect(turn).rejects.toThrow(/changed while starting work/i);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(replyRunRegistry.isActive(sessionKey)).toBe(false);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      GroupChannel: "ops-room",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | {
          accountId?: unknown;
          channel?: unknown;
          groupId?: unknown;
          isGroup?: unknown;
          threadId?: unknown;
          to?: unknown;
        }
      | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    expect(routeCall?.threadId).toBe(123);
    expect(routeCall?.isGroup).toBe(true);
    expect(routeCall?.groupId).toBe("telegram:999");
  });

  it("routes exec-event replies using persisted session delivery context when current turn has no originating route", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
      },
      lastChannel: "telegram",
      lastTo: "telegram:999",
      lastAccountId: "acc-1",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = async () =>
      ({ text: "hi", mediaUrl: "https://example.test/reply.png" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | { accountId?: unknown; channel?: unknown; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { accountId?: unknown; messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.messageProvider).toBe("telegram");
    expect(normalizerOptions?.accountId).toBe("acc-1");
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingAccountId?: unknown;
            originatingChannel?: unknown;
            originatingThreadId?: unknown;
            originatingTo?: unknown;
            shouldRouteToOriginating?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("telegram");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("telegram:999");
    expect(typeof replyDispatchCall?.[1]).toBe("object");
  });

  it("routes sessions_send internal webchat handoffs through persisted external delivery context", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "feishu" });
    sessionStoreMocks.currentEntry = {
      route: {
        channel: "feishu",
        accountId: "work",
        target: { to: "user:ou_123", chatType: "channel" },
        thread: { id: "thread:om_123", source: "explicit" },
      },
      chatType: "channel",
      deliveryContext: {
        channel: "feishu",
        to: "user:ou_123",
        accountId: "work",
        threadId: "thread:om_123",
      },
      lastChannel: "feishu",
      lastTo: "user:ou_123",
      lastAccountId: "work",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:feishu:direct:ou_123",
      AccountId: undefined,
      OriginatingChannel: "webchat",
      OriginatingTo: "session:dashboard",
      ChatType: "direct",
      InputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceChannel: "webchat",
      },
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | {
          accountId?: unknown;
          channel?: unknown;
          replyDelivery?: unknown;
          threadId?: unknown;
          to?: unknown;
        }
      | undefined;
    expect(routeCall?.channel).toBe("feishu");
    expect(routeCall?.to).toBe("user:ou_123");
    expect(routeCall?.accountId).toBe("work");
    expect(routeCall?.threadId).toBe("thread:om_123");
    expect(routeCall?.replyDelivery).toEqual({
      chatType: "channel",
      replyToMode: "all",
    });
    const replyDispatchCall = firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch") as
      | [
          {
            originatingAccountId?: unknown;
            originatingChannel?: unknown;
            originatingChatType?: unknown;
            originatingThreadId?: unknown;
            originatingTo?: unknown;
            shouldRouteToOriginating?: unknown;
          },
          unknown,
        ]
      | undefined;
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("feishu");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("user:ou_123");
    expect(replyDispatchCall?.[0]?.originatingAccountId).toBe("work");
    expect(replyDispatchCall?.[0]?.originatingThreadId).toBe("thread:om_123");
    expect(replyDispatchCall?.[0]?.originatingChatType).toBe("channel");
  });

  it("routes exec-event replies using last route fields when delivery context is missing", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    sessionStoreMocks.currentEntry = {
      lastChannel: "discord",
      lastTo: "channel:123",
      lastAccountId: "default",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall() as
      | { accountId?: unknown; channel?: unknown; to?: unknown }
      | undefined;
    expect(routeCall?.channel).toBe("discord");
    expect(routeCall?.to).toBe("channel:123");
    expect(routeCall?.accountId).toBe("default");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
