// Generic outbound delivery binds question finalization before asynchronous send work.
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Question } from "../../../packages/gateway-protocol/src/index.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../question-channel-runtime.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let runOutboundDeliveryInternal: typeof import("./deliver-queue.js").runOutboundDeliveryInternal;

const questionId = "ask_0123456789abcdef0123456789abcdef";
const questions: Question[] = [
  {
    questionId: "target",
    header: "Target",
    question: "Deploy where?",
    options: [{ label: "Staging" }, { label: "Production" }],
  },
];
const payload = { text: "Deploy where?", channelData: { askUser: { questionId } } };

function request(manager: QuestionManager, timeoutMs: number): void {
  handleQuestionChannelRequested(
    manager.request({
      id: questionId,
      questions,
      timeoutMs,
      onResolved: handleQuestionChannelResolved,
    }),
  );
}

async function expireAndReuse(manager: QuestionManager, reuseAfterMs = 15_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
  expect(manager.get(questionId)?.status).toBe("expired");
  await vi.advanceTimersByTimeAsync(reuseAfterMs);
  expect(manager.get(questionId)).toBeNull();
  request(manager, 10_000);
}

function installQuestionAdapter(manager: QuestionManager) {
  const finalized = vi.fn<(messageId: string, statusLine: string) => void>();
  const resolveReaction = vi.fn<typeof questionGatewayRuntime.resolveReaction>(async (params) => {
    if (params.optionValue === undefined) {
      throw new Error("Reaction did not carry its rendered option value");
    }
    manager.resolve(
      params.questionId,
      { answers: { target: [params.optionValue] } },
      params.senderId ?? undefined,
    );
    return { status: "answered", questionId: "target", optionValue: params.optionValue };
  });
  const reactions = createQuestionReactionTargetStore({
    channel: "matrix",
    channelDisplayName: "Matrix",
    buildKey: (messageId: string) => messageId,
    resolveReaction,
  });
  const afterDeliverPayload = vi.fn<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>(
    async ({ payload: deliveredPayload, results }) => {
      const id = questionGatewayRuntime.readAskUserQuestionId(deliveredPayload);
      const messageId = results[0]?.messageId;
      if (!id || !messageId) {
        throw new Error("Question delivery did not carry its payload and native message identity");
      }
      questionGatewayRuntime.registerChannelDelivery({
        questionId: id,
        deliveryId: `matrix:${messageId}`,
        finalize: (statusLine) => finalized(messageId, statusLine),
      });
      reactions.register({ questionId: id, optionValues: ["Staging", "Production"] }, messageId);
    },
  );
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "matrix",
          outbound: { ...matrixOutboundForQueueTest, afterDeliverPayload },
        }),
      },
    ]),
  );
  return {
    afterDeliverPayload,
    finalized,
    resolveReaction,
    react: (messageId: string, optionIndex: number) =>
      reactions.resolve({
        identities: [messageId],
        optionIndex,
        cfg: {},
        senderId: "operator",
      }),
  };
}

describe("generic outbound question generation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ runOutboundDeliveryInternal } = await import("./deliver-queue.js"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    {
      delivery: "queued",
      retention: "manager grace",
      reuseAfterMs: 15_000,
      skipQueue: false,
      statusLine: "Expired",
    },
    {
      delivery: "direct",
      retention: "channel retention",
      reuseAfterMs: 24 * 60 * 60 * 1_000,
      skipQueue: true,
      statusLine: "Unavailable: request a new question.",
    },
  ])(
    "keeps old reactions inert for a held $delivery send after $retention",
    async ({ reuseAfterMs, skipQueue, statusLine }) => {
      const manager = new QuestionManager();
      const { afterDeliverPayload, finalized, resolveReaction, react } =
        installQuestionAdapter(manager);
      const sendEntered = createDeferredCore();
      const releaseSend = createDeferredCore();
      const sendMatrix = vi
        .fn(async () => ({ messageId: "message-b" }))
        .mockImplementationOnce(async () => {
          sendEntered.resolve();
          await releaseSend.promise;
          return { messageId: "message-a" };
        });
      const send = () =>
        runOutboundDeliveryInternal({
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: [payload],
          deps: { matrix: sendMatrix },
          queuePolicy: "required",
          skipQueue,
        });
      let firstSend: ReturnType<typeof send> | undefined;
      try {
        request(manager, 50);
        firstSend = send();
        await sendEntered.promise;
        expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(skipQueue ? 0 : 1);
        await expireAndReuse(manager, reuseAfterMs);
        releaseSend.resolve();
        await expect(firstSend).resolves.toMatchObject([{ messageId: "message-a" }]);

        expect(afterDeliverPayload).toHaveBeenCalledOnce();
        expect(manager.get(questionId)?.status).toBe("pending");
        await expect(react("message-a", 1)).resolves.toBe(true);
        expect(resolveReaction).not.toHaveBeenCalled();
        expect(manager.get(questionId)?.status).toBe("pending");
        expect(finalized).toHaveBeenCalledExactlyOnceWith("message-a", statusLine);
        await expect(send()).resolves.toMatchObject([{ messageId: "message-b" }]);
        expect(afterDeliverPayload).toHaveBeenCalledTimes(2);
        expect(finalized).toHaveBeenCalledOnce();
        await expect(react("message-b", 1)).resolves.toBe(true);
        expect(resolveReaction).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ questionId, optionValue: "Production" }),
        );
        expect(manager.get(questionId)).toMatchObject({
          status: "answered",
          answers: { answers: { target: ["Production"] } },
        });
        expect(finalized.mock.calls).toEqual([
          ["message-a", statusLine],
          ["message-b", "Answered: Production"],
        ]);
        expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      } finally {
        releaseSend.resolve();
        await Promise.allSettled([firstSend]);
        manager.close();
        await drainGlobalSingletonLifecycleState("restart");
      }
    },
  );

  it("does not bind a recovered id-only payload to a newer question generation", async () => {
    const manager = new QuestionManager();
    const { afterDeliverPayload, finalized, resolveReaction, react } =
      installQuestionAdapter(manager);
    const deliveryId = "question-generation-recovery";
    const sendMatrix = vi
      .fn(async () => ({ messageId: "message-b" }))
      .mockResolvedValueOnce({ messageId: "recovered-message-a" });
    try {
      request(manager, 50);
      await expect(
        enqueueDeliveryOnce(
          {
            channel: "matrix",
            to: "!room:example",
            payloads: [payload],
            queuePolicy: "required",
          },
          deliveryId,
          fixtures.tmpDir(),
        ),
      ).resolves.toEqual({ id: deliveryId, created: true });
      await expireAndReuse(manager);
      const deliver = vi.fn<DeliverFn>(async (params) =>
        runOutboundDeliveryInternal({ ...params, deps: { matrix: sendMatrix } }),
      );
      await drainMatrixReconnect({ deliver, stateDir: fixtures.tmpDir() });

      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ deliveryQueueId: deliveryId, skipQueue: true }),
      );
      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(afterDeliverPayload).toHaveBeenCalledOnce();
      expect(finalized).toHaveBeenCalledExactlyOnceWith(
        "recovered-message-a",
        "Unavailable: request a new question.",
      );
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      expect(manager.get(questionId)?.status).toBe("pending");
      await expect(react("recovered-message-a", 1)).resolves.toBe(true);
      expect(resolveReaction).not.toHaveBeenCalled();
      expect(manager.get(questionId)?.status).toBe("pending");

      await expect(
        runOutboundDeliveryInternal({
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: [payload],
          deps: { matrix: sendMatrix },
          queuePolicy: "required",
        }),
      ).resolves.toMatchObject([{ messageId: "message-b" }]);
      expect(afterDeliverPayload).toHaveBeenCalledTimes(2);
      await expect(react("message-b", 1)).resolves.toBe(true);
      expect(resolveReaction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ questionId, optionValue: "Production" }),
      );
      expect(manager.get(questionId)).toMatchObject({
        status: "answered",
        answers: { answers: { target: ["Production"] } },
      });
      expect(finalized.mock.calls).toEqual([
        ["recovered-message-a", "Unavailable: request a new question."],
        ["message-b", "Answered: Production"],
      ]);
    } finally {
      manager.close();
      await drainGlobalSingletonLifecycleState("restart");
    }
  });

  it("does not bind restored stable-intent custody to a newer question, while a fresh reusable intent still binds", async () => {
    const manager = new QuestionManager();
    const { afterDeliverPayload, finalized, resolveReaction, react } =
      installQuestionAdapter(manager);
    const deliveryId = "question-generation-stable-retry";
    const oldPayload = { ...payload, text: "Original deployment question" };
    const newPayload = { ...payload, text: "Replacement deployment question" };
    const sendMatrix = vi
      .fn(async () => ({ messageId: "message-b" }))
      .mockResolvedValueOnce({ messageId: "retried-message-a" });
    const send = (deliveryIntentId: string) =>
      runOutboundDeliveryInternal({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [newPayload],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId,
        reusePendingDeliveryIntent: true,
      });
    try {
      request(manager, 50);
      await expect(
        enqueueDeliveryOnce(
          {
            channel: "matrix",
            to: "!room:example",
            payloads: [oldPayload],
            queuePolicy: "required",
          },
          deliveryId,
          fixtures.tmpDir(),
        ),
      ).resolves.toEqual({ id: deliveryId, created: true });
      await expireAndReuse(manager);

      await expect(send(deliveryId)).resolves.toMatchObject([{ messageId: "retried-message-a" }]);
      expect(sendMatrix).toHaveBeenCalledExactlyOnceWith(
        "!room:example",
        oldPayload.text,
        expect.any(Object),
      );
      expect(afterDeliverPayload).toHaveBeenCalledOnce();
      expect(finalized).toHaveBeenCalledExactlyOnceWith(
        "retried-message-a",
        "Unavailable: request a new question.",
      );
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      expect(manager.get(questionId)?.status).toBe("pending");
      await expect(react("retried-message-a", 1)).resolves.toBe(true);
      expect(resolveReaction).not.toHaveBeenCalled();
      expect(manager.get(questionId)?.status).toBe("pending");

      await expect(send("question-generation-fresh-intent")).resolves.toMatchObject([
        { messageId: "message-b" },
      ]);
      expect(sendMatrix).toHaveBeenNthCalledWith(
        2,
        "!room:example",
        newPayload.text,
        expect.any(Object),
      );
      expect(afterDeliverPayload).toHaveBeenCalledTimes(2);
      await expect(react("message-b", 1)).resolves.toBe(true);
      expect(resolveReaction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ questionId, optionValue: "Production" }),
      );
      expect(manager.get(questionId)).toMatchObject({
        status: "answered",
        answers: { answers: { target: ["Production"] } },
      });
      expect(finalized.mock.calls).toEqual([
        ["retried-message-a", "Unavailable: request a new question."],
        ["message-b", "Answered: Production"],
      ]);
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
    } finally {
      manager.close();
      await drainGlobalSingletonLifecycleState("restart");
    }
  });
});
