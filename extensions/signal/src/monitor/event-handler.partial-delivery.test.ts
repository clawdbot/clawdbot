// Signal integration coverage for durable ingress after a partially visible final reply.
import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "../approval-reactions.js";
import { signalPlugin } from "../channel.js";
import { maybeResolveSignalQuestionReaction } from "../question-reactions.js";
import type { SignalIngressLifecycle } from "../signal-ingress.js";

const {
  getReplyFromConfigMock,
  registerQuestionDeliveryMock,
  resolveQuestionReactionMock,
  sendMessageSignalMock,
} = vi.hoisted(() => ({
  getReplyFromConfigMock: vi.fn(),
  registerQuestionDeliveryMock:
    vi.fn<
      typeof import("openclaw/plugin-sdk/question-gateway-runtime").questionGatewayRuntime.registerChannelDelivery
    >(),
  resolveQuestionReactionMock: vi.fn(),
  sendMessageSignalMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...actual,
    questionGatewayRuntime: {
      ...actual.questionGatewayRuntime,
      // The fixture supplies a pending host question alongside its answer endpoint.
      registerChannelDelivery: registerQuestionDeliveryMock,
      resolveReaction: resolveQuestionReactionMock,
    },
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const resolveTurn = params.adapter.resolveTurn;
      return await actual.runChannelInboundEvent({
        ...params,
        adapter: {
          ...params.adapter,
          resolveTurn: async (...args: Parameters<typeof resolveTurn>) => {
            const resolved = await resolveTurn(...args);
            return "runDispatch" in resolved
              ? resolved
              : ({ ...resolved, replyResolver: getReplyFromConfigMock } as typeof resolved);
          },
        },
      });
    },
  };
});

vi.mock("../send.js", () => ({
  sendMessageSignal: sendMessageSignalMock,
  sendTypingSignal: vi.fn(async () => true),
  sendReadReceiptSignal: vi.fn(async () => true),
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn(async () => ({ ok: true })),
  removeReactionSignal: vi.fn(async () => ({ ok: true })),
}));

const [{ deliverReplies }, { startSignalIngressMonitor }, eventHandlerModule, harnessModule] =
  await Promise.all([
    import("../monitor.js"),
    import("../signal-ingress.js"),
    import("./event-handler.js"),
    import("./event-handler.test-harness.js"),
  ]);
const { questionGatewayRuntime } = await import("openclaw/plugin-sdk/question-gateway-runtime");

type SignalIngressQueue = ReturnType<typeof createChannelIngressQueueForTests<unknown>>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];

describe("Signal partial final delivery ingress boundary", () => {
  let state: OpenClawTestState;
  let queue: ReturnType<typeof createChannelIngressQueueForTests<SignalIngressPayload>>;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-signal-partial-delivery-",
    });
    queue = createChannelIngressQueueForTests({
      channelId: "signal",
      accountId: "default",
      stateDir: state.stateDir,
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", plugin: signalPlugin, source: "test" }]),
    );
    clearSignalApprovalReactionTargetsForTest();
    getReplyFromConfigMock.mockReset();
    registerQuestionDeliveryMock.mockReset();
    resolveQuestionReactionMock.mockReset().mockResolvedValue({
      status: "answered",
      questionId: "ask-partial",
      optionValue: "One",
    });
    sendMessageSignalMock.mockReset();
  });

  afterEach(async () => {
    resetPluginRuntimeStateForTest();
    clearSignalApprovalReactionTargetsForTest();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("tombstones an accepted approval prefix and retains its reaction binding", async () => {
    const afterDeliverPayload = vi.spyOn(signalPlugin.outbound!, "afterDeliverPayload");
    const timestamp = 1_700_000_005_001;
    const cfg = {
      session: { store: state.statePath("sessions") },
      channels: {
        signal: {
          account: "+15550009999",
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          textChunkLimit: 4_000,
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15550001111" }],
        },
      },
    } as OpenClawConfig;
    const payload = {
      ...buildExecApprovalPendingReplyPayload({
        approvalId: "exec-partial",
        approvalSlug: "exec-partial",
        allowedDecisions: ["allow-once", "deny"],
        command: "printf test",
        host: "gateway",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15550001111",
      }),
      mediaUrls: ["https://example.test/one.png", "https://example.test/two.png"],
    };
    getReplyFromConfigMock.mockResolvedValue(payload);
    sendMessageSignalMock
      .mockResolvedValueOnce({ messageId: "1700000005999" })
      .mockRejectedValueOnce(new Error("second Signal send failed"));

    const handler = eventHandlerModule.createSignalEventHandler(
      harnessModule.createBaseSignalEventHandlerDeps({
        cfg,
        baseUrl: "http://signal.test:8080",
        account: "+15550009999",
        accountId: "default",
        mediaMaxBytes: 8 * 1024 * 1024,
        deliverReplies: async (params) =>
          await deliverReplies({ ...params, cfg, chunkMode: "length" }),
      }),
    );
    const monitor = await startSignalIngressMonitor({
      accountId: "default",
      queue: queue as Parameters<typeof startSignalIngressMonitor>[0]["queue"],
      dispatch: async (event, lifecycle: SignalIngressLifecycle) => await handler(event, lifecycle),
      runtime: { error: vi.fn(), log: vi.fn() },
    });
    const event = harnessModule.createSignalReceiveEvent({
      timestamp,
      dataMessage: { timestamp, message: "please run it", attachments: [] },
    });

    try {
      await monitor.receive(event);
      await monitor.waitForIdle();

      expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
      expect(sendMessageSignalMock.mock.calls[0]?.[1]).toContain("React with:");
      expect(afterDeliverPayload).toHaveBeenCalledOnce();
      expect(afterDeliverPayload.mock.calls[0]?.[0]).toMatchObject({
        payload: { text: expect.stringContaining("React with:") },
        results: [{ messageId: "1700000005999" }],
      });
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      await expect(
        resolveSignalApprovalReactionTargetWithPersistence({
          accountId: "default",
          conversationKey: "+15550001111",
          messageId: "1700000005999",
          reactionKey: "👍",
          targetAuthor: "+15550009999",
        }),
      ).resolves.toMatchObject({
        approvalId: "exec-partial",
        decision: "allow-once",
      });

      await monitor.receive(event);
      await monitor.waitForIdle();
      expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
    } finally {
      await monitor.stop();
    }
  });

  it("drains an abort after an accepted question and resolves the retained binding", async () => {
    const abort = new AbortController();
    const timestamp = 1_700_000_005_002;
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const presentation = {
      blocks: [
        { type: "text" as const, text: "Pick one" },
        {
          type: "buttons" as const,
          buttons: ["One", "Two"].map((label) => ({
            label,
            action: { type: "question" as const, questionId, optionValue: label },
          })),
        },
      ],
    };
    const payload = questionGatewayRuntime.prepareReactionPayloadForDelivery({
      payload: {
        presentation,
        channelData: { askUser: { questionId } },
        mediaUrls: ["https://example.test/one.png", "https://example.test/two.png"],
      },
      presentation,
    });
    if (!payload) {
      throw new Error("expected Signal question reaction payload");
    }
    getReplyFromConfigMock.mockResolvedValue(payload);
    let firstSendAccepted!: () => void;
    const firstSendAcceptedPromise = new Promise<void>((resolve) => {
      firstSendAccepted = resolve;
    });
    sendMessageSignalMock.mockImplementationOnce(async () => {
      firstSendAccepted();
      abort.abort(new Error("Signal monitor stopping"));
      return { messageId: "1700000006000" };
    });
    const cfg = {
      session: { store: state.statePath("sessions") },
      channels: {
        signal: {
          account: "+15550009999",
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
        },
      },
    } as OpenClawConfig;
    const handler = eventHandlerModule.createSignalEventHandler(
      harnessModule.createBaseSignalEventHandlerDeps({
        cfg,
        abortSignal: abort.signal,
        baseUrl: "http://signal.test:8080",
        account: "+15550009999",
        deliverReplies: async (params) =>
          await deliverReplies({ ...params, cfg, chunkMode: "length" }),
      }),
    );
    const monitor = await startSignalIngressMonitor({
      accountId: "default",
      queue: queue as Parameters<typeof startSignalIngressMonitor>[0]["queue"],
      dispatch: async (event, lifecycle) => await handler(event, lifecycle),
      runtime: { error: vi.fn(), log: vi.fn() },
    });
    const event = harnessModule.createSignalReceiveEvent({
      timestamp,
      dataMessage: { timestamp, message: "ask me", attachments: [] },
    });

    await monitor.receive(event);
    await firstSendAcceptedPromise;
    await monitor.stop();

    expect(sendMessageSignalMock).toHaveBeenCalledOnce();
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(registerQuestionDeliveryMock).toHaveBeenCalledExactlyOnceWith({
      questionId,
      deliveryId: "signal-reaction:default:+15550001111:1700000006000",
      finalize: expect.any(Function),
    });
    await expect(
      maybeResolveSignalQuestionReaction({
        cfg,
        accountId: "default",
        conversationKey: "+15550001111",
        messageId: "1700000006000",
        reactionKey: "1️⃣",
        isRemove: false,
        actorId: "+15550001111",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBe(true);
    expect(resolveQuestionReactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, optionValue: "One" }),
    );

    const restarted = await startSignalIngressMonitor({
      accountId: "default",
      queue: queue as Parameters<typeof startSignalIngressMonitor>[0]["queue"],
      dispatch: async (incoming, lifecycle) => await handler(incoming, lifecycle),
      runtime: { error: vi.fn(), log: vi.fn() },
    });
    try {
      await restarted.receive(event);
      expect(sendMessageSignalMock).toHaveBeenCalledOnce();
    } finally {
      await restarted.stop();
    }
  });

  it("retries only a proven pre-dispatch failure after a fresh monitor restart", async () => {
    const timestamp = 1_700_000_005_003;
    const error = new PlatformMessageNotDispatchedError("Signal offline before dispatch", {
      cause: new Error("offline"),
    });
    getReplyFromConfigMock.mockResolvedValue({ text: "retry me" });
    sendMessageSignalMock.mockRejectedValueOnce(error);
    const cfg = {
      session: { store: state.statePath("sessions") },
      channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig;
    const createMonitor = async () => {
      const handler = eventHandlerModule.createSignalEventHandler(
        harnessModule.createBaseSignalEventHandlerDeps({ cfg }),
      );
      return await startSignalIngressMonitor({
        accountId: "default",
        queue: queue as Parameters<typeof startSignalIngressMonitor>[0]["queue"],
        dispatch: async (event, lifecycle) => await handler(event, lifecycle),
        runtime: { error: vi.fn(), log: vi.fn() },
      });
    };
    const event = harnessModule.createSignalReceiveEvent({
      timestamp,
      dataMessage: { timestamp, message: "please retry", attachments: [] },
    });

    const first = await createMonitor();
    await first.receive(event);
    await first.waitForIdle();
    await first.stop();
    expect(sendMessageSignalMock).toHaveBeenCalledOnce();
    const [pending] = await queue.listPending({ limit: "all" });
    expect(pending).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("Signal offline before dispatch"),
    });
    if (!pending) {
      throw new Error("expected retryable Signal ingress row");
    }

    // Advance the durable retry clock through its owner API, then rebuild the process-local
    // runtime graph while retaining the same SQLite queue to model a real monitor restart.
    await queue.release(pending.id, {
      ...(pending.lastError ? { lastError: pending.lastError } : {}),
      releasedAt: 1,
    });
    sendMessageSignalMock.mockResolvedValueOnce({ messageId: "1700000006001" });
    vi.resetModules();
    const [
      freshChannel,
      freshHandlerModule,
      freshHarness,
      freshIngress,
      freshPluginRuntime,
      freshReplyRuntime,
    ] = await Promise.all([
      import("../channel.js"),
      import("./event-handler.js"),
      import("./event-handler.test-harness.js"),
      import("../signal-ingress.js"),
      import("openclaw/plugin-sdk/plugin-test-runtime"),
      import("openclaw/plugin-sdk/reply-runtime"),
    ]);
    freshReplyRuntime.resetInboundDedupe();
    freshPluginRuntime.setActivePluginRegistry(
      freshPluginRuntime.createTestRegistry([
        { pluginId: "signal", plugin: freshChannel.signalPlugin, source: "test-restart" },
      ]),
    );
    const retryHandler = freshHandlerModule.createSignalEventHandler(
      freshHarness.createBaseSignalEventHandlerDeps({ cfg }),
    );
    const retryMonitor = await freshIngress.startSignalIngressMonitor({
      accountId: "default",
      queue: queue as Parameters<typeof freshIngress.startSignalIngressMonitor>[0]["queue"],
      dispatch: async (retryEvent, lifecycle) => await retryHandler(retryEvent, lifecycle),
      runtime: { error: vi.fn(), log: vi.fn() },
    });

    try {
      await retryMonitor.receive(event);
      await retryMonitor.waitForIdle();
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(
        await queue.enqueue(pending.id, pending.payload, {
          receivedAt: pending.receivedAt,
          laneKey: pending.laneKey,
        }),
      ).toMatchObject({ kind: "completed", duplicate: true });

      await retryMonitor.receive(event);
      await retryMonitor.waitForIdle();
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
    } finally {
      await retryMonitor.stop();
      freshPluginRuntime.resetPluginRuntimeStateForTest();
    }
  });
});
