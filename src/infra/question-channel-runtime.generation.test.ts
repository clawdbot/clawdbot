// Question delivery keeps its requested generation across a shared reply queue.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { describe, expect, it, vi } from "vitest";
import type { Question } from "../../packages/gateway-protocol/src/index.js";
import { deliverAgentHarnessQuestionPrompt } from "../agents/harness/user-input-bridge.js";
import { sendQuestionToolPrompt } from "../agents/tools/question-prompt-send.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
} from "../auto-reply/reply/reply-dispatcher.js";
import { QuestionManager } from "../gateway/question-manager.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "./question-channel-runtime.js";

const questions: Question[] = [
  {
    questionId: "target",
    header: "Target",
    question: "Deploy where?",
    options: [{ label: "Staging" }, { label: "Production" }],
  },
];

describe("question delivery generation", () => {
  it.each(["tool", "harness"] as const)(
    "keeps a queued %s prompt on its expired question after the id is reused",
    async (producer) => {
      vi.useFakeTimers();
      const manager = new QuestionManager();
      const precedingSendEntered = createDeferredCore();
      const releasePrecedingSend = createDeferredCore();
      const finalizers: ReturnType<typeof vi.fn>[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
          if (!questionId) {
            precedingSendEntered.resolve();
            await releasePrecedingSend.promise;
            return;
          }
          const finalize = vi.fn();
          finalizers.push(finalize);
          questionGatewayRuntime.registerChannelDelivery({
            questionId,
            deliveryId: `test:message-${finalizers.length}`,
            finalize,
          });
        },
      });
      const send = async (payload: ReplyPayload): Promise<void> => {
        const delivery = captureReplyDispatchDeliveryOutcome(payload);
        if (!dispatcher.sendBlockReply(payload) || !delivery.isTracked()) {
          throw new Error("Question prompt was not admitted to the reply dispatcher");
        }
        expect(await delivery.promise).toBe("delivered");
      };
      const questionId = "ask_reused_delivery";
      const request = (timeoutMs: number) => {
        const record = manager.request({
          id: questionId,
          questions,
          timeoutMs,
          onResolved: handleQuestionChannelResolved,
        });
        handleQuestionChannelRequested(record);
        return record;
      };
      const sendPrompt = () =>
        producer === "tool"
          ? sendQuestionToolPrompt({ toolName: "ask_user", questionId, questions, send })
          : deliverAgentHarnessQuestionPrompt(
              { onBlockReply: send },
              questionId,
              questions.map(({ questionId: id, ...question }) => Object.assign(question, { id })),
            );
      let firstPrompt: Promise<void> | undefined;
      let secondPrompt: Promise<void> | undefined;
      try {
        expect(dispatcher.sendBlockReply({ text: "Earlier reply" })).toBe(true);
        await precedingSendEntered.promise;
        request(50);
        firstPrompt = sendPrompt();
        expect(dispatcher.getQueuedCounts().block).toBe(2);

        await vi.advanceTimersByTimeAsync(50);
        expect(manager.get(questionId)?.status).toBe("expired");
        await vi.advanceTimersByTimeAsync(15_000);
        expect(manager.get(questionId)).toBeNull();

        request(10_000);
        secondPrompt = sendPrompt();
        expect(dispatcher.getQueuedCounts().block).toBe(3);
        expect(finalizers).toHaveLength(0);
        releasePrecedingSend.resolve();
        await Promise.all([firstPrompt, secondPrompt]);
        await dispatcher.waitForIdle();

        expect(finalizers).toHaveLength(2);
        expect(finalizers[0]).toHaveBeenCalledExactlyOnceWith("Expired");
        expect(finalizers[1]).not.toHaveBeenCalled();
        expect(manager.get(questionId)?.status).toBe("pending");

        manager.resolve(questionId, { answers: { target: ["Production"] } });
        expect(finalizers[0]).toHaveBeenCalledExactlyOnceWith("Expired");
        expect(finalizers[1]).toHaveBeenCalledExactlyOnceWith("Answered: Production");
      } finally {
        releasePrecedingSend.resolve();
        await Promise.allSettled([firstPrompt, secondPrompt]);
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        manager.close();
        await drainGlobalSingletonLifecycleState("restart");
        vi.useRealTimers();
      }
    },
  );
});
